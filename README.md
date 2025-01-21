# leaflet-tiles 🍂

[![test](https://github.com/the-hideout/leaflet-tiles/actions/workflows/test.yml/badge.svg)](https://github.com/the-hideout/leaflet-tiles/actions/workflows/test.yml) [![lint](https://github.com/the-hideout/leaflet-tiles/actions/workflows/lint.yml/badge.svg)](https://github.com/the-hideout/leaflet-tiles/actions/workflows/lint.yml) [![codeql](https://github.com/the-hideout/leaflet-tiles/actions/workflows/codeql-analysis.yml/badge.svg)](https://github.com/the-hideout/leaflet-tiles/actions/workflows/codeql-analysis.yml)

Generate leaflet tiles from an input image

## Usage 💻

```bash
npm start "path/to/image.png"
```

You can also create a `.env` file which specifies any of the following variables:

- `IMAGE_PATH`: The path to the large image that will be used to generate tiles. If `IMAGE_PATH` is provided, it is not necessary to supply a path via command line argument. If the path is to a folder, the user is presented with a list of images in that folder to use
- `MAP_NAME`: The folder name in which to store generated tiles; can be chosen at runtime
- `MAX_ZOOM`: The maximum zoom level for which to generate tiles (zero-indexed)
- `MIN_ZOOM`: The minimum zoom level for which to generate tiles (zero-indexed)
- `TILE_SIZE`: The size of tiles, defaults to an optimal value at runtime, can be chosen at runtime, and falls back to 256
- `THREAD_LIMIT`: The number of worker threads to use. If not supplied, defaults to `os.availableParallelism()`
