// must be first: loads .env and sizes the libuv threadpool before sharp loads
import {threadLimit} from './setup-env.mjs';

import fs from 'fs/promises';
import path from 'path';
import readline from 'readline';

import sharp from 'sharp';
import ora from 'ora';
import {DateTime} from 'luxon';

const prompt = (textPrompt, defaultValue) => {
    return new Promise(resolve => {
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
const testOutput = Boolean(process.env.TEST_OUTPUT || false);

async function getTileSettings() {
    const tileSettings = {
        imagePath
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
            return Promise.reject(
                new Error(`The folder ${imagePath} does not contain any images`)
            );
        }
        console.log('Select input image:');
        for (let i = 0; i < files.length; i++) {
            console.log(`${i + 1}. ${files[i]}`);
        }
        const index = await prompt(`[1-${files.length}]: `);
        if (isNaN(index) || index < 1 || index > files.length) {
            return Promise.reject(
                new Error(`${index} is an invalid input image selection`)
            );
        }
        tileSettings.imagePath = path.join(
            imagePath,
            files[parseInt(index - 1)]
        );
    }

    tileSettings.mapName =
        process.env.MAP_NAME ||
        tileSettings.imagePath.substring(
            tileSettings.imagePath.lastIndexOf(path.sep) + 1,
            tileSettings.imagePath.lastIndexOf('.')
        );
    const newMapName = await prompt(
        `Output folder (${tileSettings.mapName}): `,
        tileSettings.mapName
    );
    tileSettings.mapName = newMapName.replace(' ', '_');

    let inputImage = sharp(tileSettings.imagePath, {
        unlimited: true,
        limitInputPixels: false
    }).png();

    let metadata = await inputImage.metadata();
    console.log(`Image size: ${metadata.width}x${metadata.height}`);

    tileSettings.rotation = await prompt(
        'Rotate image 90, 180, or 270 degrees (0): ',
        0
    );
    if (tileSettings.rotation) {
        tileSettings.rotation = tileSettings.rotation.trim();
        if (!['0', '90', '180', '270'].includes(tileSettings.rotation)) {
            return Promise.reject(
                new Error(`${tileSettings.rotation} is not a valid rotation`)
            );
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
        return Promise.reject(
            new Error(`${newTileSize} is not a valid tile size`)
        );
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

const sharpOptions = {unlimited: true, limitInputPixels: false};

// Decode a pipeline to raw pixels so later steps don't pay for PNG
// encode/decode round-trips.
const toRaw = pipeline => pipeline.raw().toBuffer({resolveWithObject: true});

const fromRaw = ({data, info}) =>
    sharp(data, {
        ...sharpOptions,
        raw: {width: info.width, height: info.height, channels: info.channels}
    });

const mkdir = dir => fs.mkdir(dir, {recursive: true});

// Run async tasks with at most `limit` in flight.
async function runLimited(count, limit, task) {
    let next = 0;
    const runners = Array.from({length: Math.min(limit, count)}, async () => {
        while (next < count) {
            await task(next++);
        }
    });
    await Promise.all(runners);
}

async function createTiles(options) {
    const {imagePath, rotation, resize, tileSize, mapName} = options;
    const minZoom = parseInt(options.minZoom);
    const maxZoom = parseInt(options.maxZoom);
    const defaultConcurrency = sharp.concurrency();

    const loadSpinner = ora('Decoding source image').start();
    let source = await toRaw(sharp(imagePath, sharpOptions));
    loadSpinner.succeed();

    if (rotation) {
        const rotateSpinner = ora(`Rotating image ${rotation} degrees`);
        rotateSpinner.start();
        source = await toRaw(fromRaw(source).rotate(rotation));
        if (testOutput) {
            rotateSpinner.suffixText = 'saving test output...';
            await fromRaw(source).toFile('./output/test_rotated.jpg');
            rotateSpinner.suffixText = '';
        }
        rotateSpinner.succeed();
    }

    const fullSize = Math.max(source.info.width, source.info.height);

    if (resize) {
        const resizeSpinner = ora();
        if (resize < fullSize) {
            resizeSpinner.start(
                `Shrinking source image to fit ${resize}x${resize}`
            );
            source = await toRaw(
                fromRaw(source).resize({
                    width: resize,
                    height: resize,
                    fit: sharp.fit.contain,
                    position: sharp.gravity.northwest,
                    background: {r: 1, g: 0, b: 0, alpha: 0}
                })
            );
        } else {
            resizeSpinner.start(
                `Padding source image to fit ${resize}x${resize}`
            );
            const xPadding = resize - source.info.width;
            const yPadding = resize - source.info.height;
            source = await toRaw(
                fromRaw(source).extend({
                    top: Math.ceil(yPadding / 2),
                    right: Math.floor(xPadding / 2),
                    bottom: Math.floor(yPadding / 2),
                    left: Math.ceil(xPadding / 2),
                    background: {r: 1, g: 0, b: 0, alpha: 0}
                })
            );
        }
        if (testOutput) {
            resizeSpinner.suffixText = 'saving test output...';
            await fromRaw(source).toFile('./output/test_resized.jpg');
            resizeSpinner.suffixText = '';
        }
        resizeSpinner.succeed();
    }

    await mkdir(`output/${mapName}`);

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
        totalTiles += Math.pow(4, z);
    }

    let completedTiles = 0;
    const zoomSpinner = ora({text: mapName, prefixText: '0.00%'});
    zoomSpinner.start();
    const startTime = DateTime.now();
    try {
        for (let z = minZoom; z <= maxZoom; z++) {
            const scaledSize = tileSize * Math.pow(2, z);
            const tilesPerSide = scaledSize / tileSize;
            zoomSpinner.suffixText = `| z ${z}/${maxZoom} Resizing to ${scaledSize}`;

            // One large resize per zoom level, using every libvips thread.
            sharp.concurrency(defaultConcurrency);
            let level = source;
            if (
                scaledSize !== source.info.width ||
                scaledSize !== source.info.height
            ) {
                level = await toRaw(
                    fromRaw(source).resize({
                        width: scaledSize,
                        height: scaledSize,
                        fit: sharp.fit.contain,
                        background: {r: 1, g: 0, b: 0, alpha: 0}
                    })
                );
            }

            for (let x = 0; x < tilesPerSide; x++) {
                await mkdir(`output/${mapName}/${z}/${x}`);
            }

            // Many small tile encodes in parallel: parallelism comes from the
            // libuv threadpool, so one libvips thread per tile avoids
            // oversubscribing the CPU.
            sharp.concurrency(1);
            await runLimited(
                tilesPerSide * tilesPerSide,
                threadLimit,
                async index => {
                    const x = Math.floor(index / tilesPerSide);
                    const y = index % tilesPerSide;
                    let tile = fromRaw(level);
                    if (tilesPerSide > 1) {
                        tile = tile.extract({
                            left: x * tileSize,
                            top: y * tileSize,
                            width: tileSize,
                            height: tileSize
                        });
                    }
                    await tile
                        .png()
                        .toFile(`output/${mapName}/${z}/${x}/${y}.png`);
                    completedTiles++;
                    zoomSpinner.suffixText = `| z ${z}/${maxZoom} | x ${x}/${
                        tilesPerSide - 1
                    } | y ${y}/${tilesPerSide - 1}`;
                    zoomSpinner.prefixText = `${(
                        (completedTiles / totalTiles) *
                        100
                    ).toFixed(2)}%`;
                }
            );
        }
    } catch (error) {
        zoomSpinner.fail();
        throw error;
    } finally {
        sharp.concurrency(defaultConcurrency);
    }
    zoomSpinner.prefixText = '';
    zoomSpinner.suffixText = `completed ${DateTime.now().toRelative({base: startTime})}`;
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
            console.log(
                `Queued tiles: ${tileSettings.map(setting => setting.mapName).join(', ')}`
            );
        }
        const again = (
            await prompt(`Do you want to queue another tileset? (n): `, 'n')
        )
            ?.trim()
            .toLocaleLowerCase();
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
