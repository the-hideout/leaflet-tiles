#!/usr/bin/env node
/**
 * Assemble a folder of PNG tiles into a single image.
 *
 * Expects filenames of the form:
 *   {prefix}_tile_{row}_{column}.png
 * e.g. map_tile_0_0.png, map_tile_0_1.png, map_tile_1_0.png, ...
 *
 * Usage:
 *   node assemble-tiles.js <inputDir> <outputFile> [prefix]
 *
 * Examples:
 *   node assemble-tiles.js ./tiles ./combined.png
 *   node assemble-tiles.js ./tiles ./combined.png map
 *
 * Requires the "sharp" package:
 *   npm install sharp
 */

import fs from 'node:fs';
import path from 'node:path';

import sharp from 'sharp';

import dotenv from 'dotenv';

dotenv.config();

async function main() {
  const inputDir = process.env.ASSEMBLE_FROM;
  const forcePrefix = process.env.ASSEMBLE_PREFIX;

  if (!inputDir) {
    console.error('You must define ASSEMBLE_FROM in .env');
    process.exit(1);
  }

  if (!fs.existsSync(inputDir) || !fs.statSync(inputDir).isDirectory()) {
    console.error(`Input directory not found: ${inputDir}`);
    process.exit(1);
  }

  const files = fs.readdirSync(inputDir).filter(f => f.toLowerCase().endsWith('.png'));

  if (files.length === 0) {
    console.error(`No .png files found in ${inputDir}`);
    process.exit(1);
  }

  // Matches: {prefix}_tile_{row}_{column}.png
  const tileRegex = /^(.+)_tile_(\d+)_(\d+)\.png$/i;

  let destinationName;
  const tiles = [];
  for (const file of files) {
    const match = file.match(tileRegex);
    if (!match) {
      console.warn(`Skipping file that doesn't match pattern: ${file}`);
      continue;
    }
    const [, prefix, colStr, rowStr] = match;
    if (forcePrefix && prefix !== forcePrefix) continue;
    if (!destinationName) {
        destinationName = prefix;
    }

    tiles.push({
      file,
      prefix,
      row: parseInt(rowStr, 10),
      column: parseInt(colStr, 10),
      fullPath: path.join(inputDir, file),
    });
  }

  if (tiles.length === 0) {
    console.error('No matching tile files found (check the prefix/filename pattern).');
    process.exit(1);
  }

  // Determine grid bounds
  const rows = tiles.map(t => t.row);
  const cols = tiles.map(t => t.column);
  const minRow = Math.min(...rows);
  const maxRow = Math.max(...rows);
  const minCol = Math.min(...cols);
  const maxCol = Math.max(...cols);
  const numRows = maxRow - minRow + 1;
  const numCols = maxCol - minCol + 1;

  console.log(
    `Found ${tiles.length} tiles forming a ${numRows}x${numCols} grid ` +
      `(rows ${minRow}-${maxRow}, columns ${minCol}-${maxCol}).`
  );

  // Use the first tile's dimensions as the standard tile size
  const firstMeta = await sharp(tiles[0].fullPath).metadata();
  const tileWidth = firstMeta.width;
  const tileHeight = firstMeta.height;
  console.log(`Tile size: ${tileWidth}x${tileHeight} (based on ${tiles[0].file})`);

  // Warn about any missing tiles in the grid (gaps left transparent)
  const tileMap = new Map(tiles.map(t => [`${t.row},${t.column}`, t]));
  const missing = [];
  for (let r = minRow; r <= maxRow; r++) {
    for (let c = minCol; c <= maxCol; c++) {
      if (!tileMap.has(`${r},${c}`)) missing.push(`(${r},${c})`);
    }
  }
  if (missing.length > 0) {
    console.warn(`Warning: missing tiles at: ${missing.join(', ')}. These spots will be left transparent.`);
  }

  // Warn about tiles whose size doesn't match the reference tile
  for (const t of tiles) {
    const meta = await sharp(t.fullPath).metadata();
    if (meta.width !== tileWidth || meta.height !== tileHeight) {
      console.warn(
        `Warning: ${t.file} is ${meta.width}x${meta.height}, expected ${tileWidth}x${tileHeight}. ` +
          `It will be placed at its top-left corner but may not align perfectly.`
      );
    }
  }

  const compositeOps = tiles.map(t => ({
    input: t.fullPath,
    left: (t.column - minCol) * tileWidth,
    top: (t.row - minRow) * tileHeight,
  }));

  const canvasWidth = numCols * tileWidth;
  const canvasHeight = numRows * tileHeight;

  console.log(`Assembling final image: ${canvasWidth}x${canvasHeight}`);
  const outputFile = `${destinationName}.png`;
  await sharp({
    limitInputPixels: false,
    create: {
      width: canvasWidth,
      height: canvasHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(compositeOps)
    .png()
    .toFile(outputFile);

  console.log(`Saved assembled image to ${outputFile}`);
}

main().catch(err => {
  console.error('Error assembling tiles:', err);
  process.exit(1);
});