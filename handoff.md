# Hillshade seam handoff

This file is temporary review material. Remove its commit before merging the fix.

## Branch state

The branch is `hillshade-seams` in `Turbo87/maplibre-gl-js`.

- Before: `38255cb71`, the upstream base before the fix.
- Fix: `6c9c65d87`, which adds a border to the hillshade slope texture.
- Follow-up: `030ea635c`, which allocates the full DEM border during image decoding.

The hillshade texture needs one pixel of neighboring slopes for linear interpolation. Calculating those slopes needs two pixels of neighboring elevations. The fix provides both borders and keeps the visible tile inside them. Both image-loading paths allocate the full elevation border. `DEMData` reuses the decoded buffer.

Keep `resampling: 'linear'`. The issue also occurs below the source maximum zoom. Changing to `nearest` or lowering `maxzoom` is not the intended fix.

## Build both versions

Use a fresh directory for this comparison. The commands below use Node.js 26.7.0, npm, Python 3, and Git. Internet access is required for dependencies and public Mapterhorn tiles. Puppeteer installs its browser through the repository dependencies.

```sh
git clone --branch hillshade-seams https://github.com/Turbo87/maplibre-gl-js.git hillshade-after
cd hillshade-after
npm ci
npm run build-css
npm run build-dev
git worktree add --no-track -b hillshade-before ../hillshade-before 38255cb71
```

In a second terminal, enter `hillshade-before` and build it:

```sh
npm ci
npm run build-css
npm run build-dev
```

Use the pinned base above. Comparing against a released CDN build would also include unrelated changes between versions.

## Minimal reproduction

Save the following as `hillshade-repro.html` in `hillshade-after`. Copy the same file into `hillshade-before`.

```html
<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>Hillshade tile seams</title>
<link rel="stylesheet" href="./dist/maplibre-gl.css">
<style>body { margin: 0; } #map { position: absolute; inset: 0; }</style>
<div id="map"></div>
<script type="module">
  import * as maplibregl from './dist/maplibre-gl-dev.mjs';
  maplibregl.setWorkerUrl('./dist/maplibre-gl-worker-dev.mjs');
  window.reproReady = false;
  window.reproError = null;
  const params = new URLSearchParams(location.search);
  const map = window.map = new maplibregl.Map({
    container: 'map',
    center: [7.03125, 46.55886030311718],
    zoom: Number(params.get('zoom') ?? 10),
    bearing: 0,
    pitch: 0,
    fadeDuration: 0,
    canvasContextAttributes: { preserveDrawingBuffer: true },
    style: {
      version: 8,
      sources: {
        terrain: {
          type: 'raster-dem',
          tiles: ['https://tiles.mapterhorn.com/{z}/{x}/{y}.webp'],
          encoding: 'terrarium',
          tileSize: 512,
          maxzoom: 12,
          attribution: '<a href="https://mapterhorn.com/attribution">© Mapterhorn</a>',
        },
      },
      layers: [
        { id: 'background', type: 'background', paint: { 'background-color': '#fff' } },
        { id: 'hillshade', type: 'hillshade', source: 'terrain',
          paint: { 'hillshade-method': 'igor', resampling: 'linear' } },
      ],
    },
  });
  map.showTileBoundaries = params.has('boundaries');
  map.on('error', event => {
    window.reproError = event.error.message;
    console.error(event.error);
  });
  map.on('idle', () => { window.reproReady = true; });
</script>
</html>
```

In the `hillshade-before` terminal, start the first server:

```sh
python3 -m http.server 8770 --bind 127.0.0.1
```

In another terminal in `hillshade-after`, start the second server:

```sh
python3 -m http.server 8771 --bind 127.0.0.1
```

Open these pages in the same browser with the same window size:

- Before: <http://127.0.0.1:8770/hillshade-repro.html?zoom=10>
- After: <http://127.0.0.1:8771/hillshade-repro.html?zoom=10>

The center lies at a junction of zoom-10 DEM tiles. The horizontal boundary separates rows 361 and 362. The vertical boundary separates columns 531 and 532. The horizontal seam is easiest to see. Wait until all tiles load, then inspect the terrain along the horizontal center line.

Append `&boundaries` to confirm where the tile edges are. Remove it when comparing the shading because the debug lines cover the seam. Repeat with `?zoom=9.75`. Both zooms are below the source maximum of 12. Zoom 14 makes the artifact more prominent but is not needed to reproduce it.

## Capture a visual comparison

Save the following as `capture-hillshade.mjs` in `hillshade-after`. Keep both servers running. The script uses the installed Puppeteer and Sharp dependencies. It saves the map canvas at its native resolution and creates a magnified center crop. Crop enlargement preserves the rendered pixels and does not change hillshade interpolation.

```js
import puppeteer from 'puppeteer';
import sharp from 'sharp';
import {mkdir, writeFile} from 'node:fs/promises';

await mkdir('hillshade-comparison', {recursive: true});
const browser = await puppeteer.launch({
  headless: true,
  args: ['--disable-gpu', '--enable-unsafe-swiftshader',
    '--enable-features=AllowSwiftShaderFallback,AllowSoftwareGLFallbackDueToCrashes'],
});
try {
  for (const zoom of [10, 9.75]) {
    const crops = [];
    for (const [name, port] of [['before', 8770], ['after', 8771]]) {
      const page = await browser.newPage();
      try {
        await page.setViewport({width: 1280, height: 720, deviceScaleFactor: 2});
        page.on('pageerror', error => { console.error(error); });
        await page.goto(`http://127.0.0.1:${port}/hillshade-repro.html?zoom=${zoom}`);
        await page.waitForFunction(() => window.reproReady || window.reproError, {timeout: 60000});
        const dataUrl = await page.evaluate(() => {
          if (window.reproError) throw new Error(window.reproError);
          return window.map.getCanvas().toDataURL('image/png');
        });
        const png = Buffer.from(dataUrl.split(',')[1], 'base64');
        const stem = `hillshade-comparison/${name}-zoom-${zoom}`;
        await writeFile(`${stem}.png`, png);
        const {width, height} = await sharp(png).metadata();
        const crop = await sharp(png)
          .extract({left: width / 2 - 128, top: height / 2 - 64, width: 256, height: 128})
          .resize(1024, 512, {kernel: 'nearest'}).png().toBuffer();
        await writeFile(`${stem}-detail.png`, crop);
        crops.push(crop);
      } finally {
        await page.close();
      }
    }
    await sharp({create: {width: 2048, height: 512, channels: 4, background: '#fff'}})
      .composite([{input: crops[0], left: 0, top: 0}, {input: crops[1], left: 1024, top: 0}])
      .png().toFile(`hillshade-comparison/comparison-zoom-${zoom}.png`);
  }
} finally {
  await browser.close();
}
```

Run it from `hillshade-after`:

```sh
node capture-hillshade.mjs
```

Open `hillshade-comparison/comparison-zoom-10.png` and `comparison-zoom-9.75.png`. The left half is before the fix. The right half is after it. Look along the horizontal center line within each half. The vertical join between the halves is only the comparison layout. Inspect the original screenshots at 100% scale or larger. Downscaling can hide the narrow seam.

Use the same browser and renderer for both versions. The script uses software rendering for consistency. For a hardware-specific report, also compare both pages in the affected browser. A tile request failure or a timeout is not a valid comparison. Public terrain tiles can change, so capture both versions in the same session.

## Automated regression and validation

The browser regression uses synthetic elevation data. It compares one 128-pixel tile at source zoom 15 with four 64-pixel tiles at source zoom 16. The terrain and ground resolution are identical. All five hillshade methods must match within one color-channel level.

Run from the fixed checkout after building it:

```sh
npm run test-integration -- test/integration/browser/browser.test.ts -t 'Hillshade interpolation'
npm run test-unit -- src/data/dem_data.test.ts src/source/raster_dem_tile_source.test.ts src/source/raster_dem_tile_worker_source.test.ts src/tile/tile_manager_raster_dem.test.ts src/render/terrain.test.ts src/geo/projection/mercator_transform.test.ts src/geo/projection/vertical_perspective_transform.test.ts
npm run typecheck
```

To verify the regression against the base, copy `test/integration/browser/browser.test.ts` from the fixed checkout into the same location in `hillshade-before`. Run only the filtered browser command above from `hillshade-before`. Leave its library build unchanged. All five cases should fail. This does not require changing the fixed checkout.

At `030ea635c`, all 126 focused unit tests and all five browser regression cases pass. Type checking and ESLint for the changed TypeScript files also pass. The earlier fix passed 136 existing render tests selected by `hillshade|color-relief|terrain`, without changes to expected images. Those render tests were not repeated after the buffer-allocation follow-up. The screenshot workflow above was checked against the base and the fixed build at zoom 10 and 9.75. It reproduces the seam before the fix and shows continuous shading after it.

Keep the example files, screenshots, and temporary baseline test copy out of the fix commits. This handoff commit is separate so it can be removed when the review is complete.
