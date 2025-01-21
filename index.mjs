import fs from 'fs/promises';
import path from 'path';
import { availableParallelism } from 'os';
import readline from 'readline';

import sharp from 'sharp';
import ora from 'ora';
import dotenv from 'dotenv';
import { DateTime } from 'luxon';

import WorkerPromise, { activeWorkerCount, workerEvents } from './worker-promise.mjs';

dotenv.config();
const prompt = (textPrompt, defaultValue) => {
    return new Promise((resolve) => {
        const input = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        input.question(textPrompt, response => {
            input.close();
            if (response === '') {
                response = undefined;
            }
            resolve(response ?? String(defaultValue));
        });
    });
};

let imagePath = process.env.IMAGE_PATH || process.argv[2];
if (!imagePath) {
    imagePath = '../tarkov-dev-src-maps/interactive';
    console.log(`IMAGE_PATH not set, defaulting to ${imagePath}`);
}
const minTileSize = process.env.MIN_TILE_SIZE || 100;
const maxTileSize = process.env.MAX_TILE_SIZE || 400;
const threadLimit = isNaN(process.env.THREAD_LIMIT) ? availableParallelism() : parseInt(process.env.THREAD_LIMIT);
const testOutput = Boolean(process.env.TEST_OUTPUT || false);

async function getTileSettings() {
    const tileSettings = {
        imagePath,
    };

    if ((await fs.lstat(imagePath)).isDirectory()) {
        const imageExtensions = ['jpg', 'jpeg', 'png', 'webp'];
        const files = await fs
            .readdir(imagePath)
            .then(files =>
                files.filter(filename =>
                    imageExtensions.some(ext =>
                        filename.toLocaleLowerCase().endsWith(`.${ext}`)
                    )
                )
            );
        if (files.length < 1) {
            return Promise.reject(new Error(`The folder ${imagePath} does not contain any images`));
        }
        console.log('Select input image:');
        for (let i = 0; i < files.length; i++) {
            console.log(`${i + 1}. ${files[i]}`);
        }
        const index = await prompt(`[1-${files.length}]: `);
        if (isNaN(index) || index < 1 || index > files.length) {
            return Promise.reject(new Error(`${index} is an invalid input image selection`));
        }
        tileSettings.imagePath = path.join(imagePath, files[parseInt(index - 1)]);
    }

    tileSettings.mapName =
        process.env.MAP_NAME ||
        tileSettings.imagePath.substring(
            tileSettings.imagePath.lastIndexOf(path.sep) + 1,
            tileSettings.imagePath.lastIndexOf('.')
        );
    const newMapName = await prompt(`Output folder (${tileSettings.mapName}): `, tileSettings.mapName);
    tileSettings.mapName = newMapName.replace(' ', '_');

    let inputImage = sharp(tileSettings.imagePath, {
        unlimited: true,
        limitInputPixels: false
    }).png();
    
    let metadata = await inputImage.metadata();
    console.log(`Image size: ${metadata.width}x${metadata.height}`);

    tileSettings.rotation = await prompt('Rotate image 90, 180, or 270 degrees (0): ', 0);
    if (tileSettings.rotation) {
        tileSettings.rotation = tileSettings.rotation.trim();
        if (!['0', '90', '180', '270'].includes(tileSettings.rotation)) {
            return Promise.reject(new Error(`${tileSettings.rotation} is not a valid rotation`));
        }
        tileSettings.rotation = parseInt(tileSettings.rotation);
    }

    let fullSize = Math.max(metadata.width, metadata.height);

    let tileSize = 0;
    let tileConfig = {difference: Number.MAX_SAFE_INTEGER};
    let tileResize = false;
    tileLoop: for (let i = minTileSize; i <= maxTileSize; i++) {
        for (let pow = 0; pow < 100; pow++) {
            if (i * Math.pow(2, pow) === fullSize) {
                tileConfig.size = i;
                tileConfig.pow = pow;
                tileConfig.difference = 0;
                tileSize = i;
                if (i > 200) {
                    break tileLoop;
                }
            }
        }
    }
    if (!tileSize) {
        tileResize = {
            grow: {difference: Number.MAX_SAFE_INTEGER},
            shrink: {difference: Number.MAX_SAFE_INTEGER}
        };
        for (let i = minTileSize; i <= maxTileSize; i++) {
            for (let pow = 0; pow < 100; pow++) {
                const resized = i * Math.pow(2, pow);
                let resizeType = tileResize.grow;
                if (resized < fullSize) {
                    resizeType = tileResize.shrink;
                }
                const diff = Math.abs(resized - fullSize);
                if (diff < resizeType.difference) {
                    resizeType.size = i;
                    resizeType.pow = pow;
                    resizeType.difference = diff;
                }
            }
        }
        if (tileResize.grow.difference <= tileResize.grow.size) {
            tileConfig = tileResize.grow;
        } else {
            tileConfig =
                tileResize.grow.difference <= tileResize.shrink.difference
                    ? tileResize.grow
                    : tileResize.shrink;
        }
        if (tileConfig.difference < Number.MAX_SAFE_INTEGER) {
            tileSize = tileConfig.size;
        } else {
            tileSize = isNaN(process.env.TILE_SIZE)
                ? 256
                : parseInt(process.env.TILE_SIZE);
        }
    }
    if (tileResize) {
        console.log(
            `Image must be resized. Closest grow and shrink sizes for tiles ${minTileSize}-${maxTileSize}px:`
        );
        console.log(
            `Grow: ${tileResize.grow.size}px tiles with ${
                tileResize.grow.size * Math.pow(2, tileResize.grow.pow)
            }px total size (+${
                tileResize.grow.size * Math.pow(2, tileResize.grow.pow) -
                fullSize
            }px padding)`
        );
        console.log(
            `Shrink: ${tileResize.shrink.size}px tiles with ${
                tileResize.shrink.size * Math.pow(2, tileResize.shrink.pow)
            }px total size (${
                tileResize.shrink.size * Math.pow(2, tileResize.shrink.pow) -
                fullSize
            }px)`
        );
    }
    const newTileSize = await prompt(`Tile size (${tileSize}): `, tileSize);
    if (isNaN(newTileSize)) {
        return Promise.reject(new Error(`${newTileSize} is not a valid tile size`));
    }
    if (parseInt(newTileSize) !== tileConfig.size) {
        tileConfig.size = parseInt(newTileSize);
        tileConfig.difference = Number.MAX_SAFE_INTEGER;
        tileConfig.pow = 0;
        for (let pow = 0; pow < 100; pow++) {
            const diff = Math.abs(
                tileConfig.size * Math.pow(2, pow) - fullSize
            );
            if (diff < tileConfig.difference) {
                tileConfig.pow = pow;
                tileConfig.difference = diff;
            }
        }
    }

    tileSettings.tileSize = tileConfig.size;

    if (tileConfig.difference) {
        tileSettings.resize = tileSize * Math.pow(2, tileConfig.pow);
    }

    let zoomLevels = 0;
    for (let imageWidth = fullSize; imageWidth >= tileSize; imageWidth /= 2) {
        zoomLevels++;
    }

    tileSettings.maxZoom = Math.min(
        isNaN(process.env.MAX_ZOOM)
            ? zoomLevels
            : parseInt(process.env.MAX_ZOOM),
        zoomLevels - 1
    );
    tileSettings.minZoom = process.env.MIN_ZOOM || 0;

    return tileSettings;
}

async function createTiles(options) {
    const {
        imagePath,
        rotation,
        resize,
        tileSize,
        minZoom,
        maxZoom,
        mapName,
    } = options;
    let inputImage = sharp(imagePath, {
        unlimited: true,
        limitInputPixels: false
    }).png();

    let metadata = await inputImage.metadata();

    if (rotation) {
        const rotateSpinner = ora(`Rotating image ${rotation} degrees`);
        rotateSpinner.start();
        inputImage = sharp(await inputImage.rotate(rotation).toBuffer(), {
            unlimited: true,
            limitInputPixels: false
        });
        if (testOutput) {
            rotateSpinner.suffixText = 'saving test output...';
            await inputImage.toFile('./output/test_rotated.jpg');
            rotateSpinner.suffixText = '';
        }
        rotateSpinner.succeed();
        if (rotation === 90 || rotation === 270) {
            const h = metadata.height;
            metadata.height = metadata.width;
            metadata.width = h;
        }
    }

    let fullSize = Math.max(metadata.width, metadata.height);

    if (resize) {
        const resizeSpinner = ora();
        if (resize < fullSize) {
            resizeSpinner.start(
                `Shrinking source image to fit ${resize}x${resize}`
            );
            inputImage = sharp(
                await inputImage
                    .resize({
                        width: resize,
                        height: resize,
                        fit: sharp.fit.contain,
                        position: sharp.gravity.northwest,
                        background: {r: 1, g: 0, b: 0, alpha: 0}
                    })
                    .toBuffer()
            );
        } else {
            resizeSpinner.start(
                `Padding source image to fit ${resize}x${resize}`
            );
            const xPadding = resize - metadata.width;
            const yPadding = resize - metadata.height;
            const top = Math.ceil(yPadding / 2);
            const bottom = Math.floor(yPadding / 2);
            const left = Math.ceil(xPadding / 2);
            const right = Math.floor(xPadding / 2);
            inputImage = sharp(
                await inputImage
                    .extend({
                        top,
                        right,
                        bottom,
                        left,
                        background: {r: 1, g: 0, b: 0, alpha: 0}
                    })
                    .toBuffer(),
                {
                    unlimited: true,
                    limitInputPixels: false
                }
            );
        }
        if (testOutput) {
            resizeSpinner.suffixText = 'saving test output...';
            await inputImage.toFile('./output/test_resized.jpg');
            resizeSpinner.suffixText = '';
        }
        resizeSpinner.succeed();
        fullSize = resize;
    }

    await fs.mkdir(`output/${mapName}`).catch(error => {
        if (error.code !== 'EEXIST') {
            console.log(error);
        }
    });

    await fs.writeFile(
        `output/${mapName}/config.json`,
        JSON.stringify(
            {
                tileSize: tileSize,
                minZoom: minZoom,
                maxZoom: maxZoom
            },
            null,
            4
        )
    );

    let totalTiles = 0;
    for (let z = minZoom; z <= maxZoom; z++) {
        totalTiles += Math.pow((tileSize * Math.pow(2, z)) / tileSize, 2);
    }

    const tileCheck = async () => {
        if (activeWorkerCount() >= threadLimit) {
            return new Promise(resolve => {
                workerEvents.once('workerEnded', resolve);
            });
        }
        return Promise.resolve();
    };
    let completedTiles = 0;
    const zoomSpinner = ora({text: mapName, prefixText: '0.00%'});
    zoomSpinner.start();
    const startTime = DateTime.now();
    const inputImageBuffer = (await inputImage.toBuffer()).buffer;
    for (let z = minZoom; z <= maxZoom; z++) {
        const scaledSize = tileSize * Math.pow(2, z);
        zoomSpinner.suffixText = `| z ${z}/${maxZoom} Resizing to ${scaledSize}`;
        const workerResult = await new WorkerPromise('resize-worker.mjs').start({tileSize, z, image: inputImageBuffer});
        await fs.mkdir(`output/${mapName}/${z}`).catch(error => {
            if (error.code !== 'EEXIST') {
                console.log(error);
            }
        });
        for (let x = 0; x < scaledSize / tileSize; x++) {
            await fs.mkdir(`output/${mapName}/${z}/${x}`).catch(error => {
                if (error.code !== 'EEXIST') {
                    console.log(error);
                }
            });
            for (let y = 0; y < scaledSize / tileSize; y++) {
                new WorkerPromise('tile-worker.mjs').start({
                    mapName,
                    tileSize,
                    x,
                    y,
                    z,
                    image: workerResult.image,
                }).then(() => {
                    zoomSpinner.suffixText = `| z ${z}/${maxZoom} | x ${x}/${
                        scaledSize / tileSize - 1
                    } | y ${y}/${scaledSize / tileSize - 1}`;
                    completedTiles++;
                    zoomSpinner.prefixText = `${(
                        Math.round(
                            (completedTiles / totalTiles) * 10000
                        ) / 100
                    ).toFixed(2)}%`;
                });
                await tileCheck();
            }
        }
        zoomSpinner.suffixText = '';
        zoomSpinner.prefixText = '';
    }
    zoomSpinner.suffixText = `completed ${DateTime.now().toRelative({ base: startTime})}`;
    zoomSpinner.succeed();
}

(async () => {
    await fs.mkdir('output').catch(error => {
        if (error.code !== 'EEXIST') {
            console.log(error);
        }
    });

    const tileSettings = [];
    while (true) {
        try {
            tileSettings.push(await getTileSettings());
        } catch (error) {
            console.log(error.message);
        }
        if (tileSettings.length > 0) {
            console.log(`Queued tiles: ${tileSettings.map(setting => setting.mapName).join(', ')}`);
        }
        const again = (await prompt(`Do you want to queue another tileset? (n): `, 'n'))?.trim().toLocaleLowerCase();
        if (!again?.startsWith('y')) {
            break;
        }
    }
    
    for (const settings of tileSettings) {
        try {
            await createTiles(settings);
        } catch (error) {
            console.log(`Error creating ${settings.mapName} tiles`);
            console.log(error);
        }
    }
})();
