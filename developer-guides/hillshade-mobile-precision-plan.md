# Hillshade banding on mobile GPUs: fix plan and CI options

Status: plan, not yet implemented

This document records the plan for fixing vertical bands and stepped shading
edges in the `hillshade` layer on mobile GPUs, and the options for covering the
fix in CI. It builds on the investigation in the updraft repository
(`docs/research/investigations/2026-09-13-hillshade-mobile-precision.md` on the
`claude/maplibre-hillshade-artifacts-f67rfl` branch), which reproduced the
artifacts seen on a Samsung Galaxy S23 with zoom-10 terrain overzoomed to
zoom 15.

## Diagnosis

The fragment shader prelude (`src/shaders/glsl/_prelude.fragment.glsl`)
declares `precision mediump float` under `GL_ES`. The `hillshade` fragment
shader (`src/shaders/glsl/hillshade.fragment.glsl`) does not override it, so on
OpenGL ES the interpolated tile coordinate `v_pos` and the derived texture
coordinate

```glsl
vec2 texturePos = (v_pos * (size - 2.0) + 1.0) / size;
```

are evaluated as 16-bit floats on mobile GPUs. A half float in the range 0.5
to 1 has a spacing of 1/2048. Scaled to a 258-pixel derivative texture that is
about 1/8 of a DEM sample, so the south-east three quarters of every tile
sample the derivative texture on a coarse grid. When a zoom-10 DEM tile is
overzoomed to zoom 15 one DEM sample covers 32 CSS pixels and the grid becomes
visible as bands and stair steps.

The vertex prelude is already `highp`, so the coordinate leaves the vertex
stage intact and is degraded only in the fragment stage. Desktop GPUs and
SwiftShader run `mediump` as 32-bit floats, which is why the defect never
shows up in the render tests.

The sibling terrain shaders already override the default: `hillshade_prepare`
and `color_relief` declare `precision highp float`, `atmosphere`,
`fill_pattern` and `line_pattern` do the same, and `line_gradient` uses the
narrow form `in highp vec2 v_uv`. The `hillshade` draw shader is the one that
was never revisited. The tile-seam fix from pull request 8302 is not the cause.
The quantisation existed before it.

## Reproduction

### On a device

This is the original report from the updraft investigation.

1. Device: Samsung Galaxy S23. Any phone with a Mali or Adreno GPU should
   behave the same, since both run `mediump` as 16-bit floats.
2. Build: the updraft nightly APK from commit `65ec44b`, which bundles
   MapLibre GL JS 6.9.0.
3. Data: the Enroute France terrain file dated `13-Nov-2025`. Its tiles stop at
   zoom 10.
4. View: the waypoint `Coupe` at 44.0545°N 6.3296°E at about zoom 15, no
   rotation or pitch.
5. Expected artifact: vertical bands and a stepped diagonal light-to-dark edge
   south-west of `Coupe`. `Coupe` lies 130 m east of the boundary between
   zoom-10 tile columns 529 and 530, in the eastern part of column 529 where
   the tile-local x coordinate exceeds 0.75 and the half-float spacing is at
   its coarsest.

Any MapLibre GL JS build with a `raster-dem` source whose `maxzoom` is five
levels below the map zoom shows the same thing on such a device. The
emulation below is a stand-in for the phone, not a replacement for checking
the fix on one.

### In headless Chromium by emulating 16-bit `mediump`

SwiftShader runs `mediump` at 32 bits, so the bug has to be emulated by
rounding the coordinate the way a 16-bit GPU would. The steps below were run
on `main` at `80a6f38` with Chromium 141 and produce the artifact.

1. Apply this patch to `src/shaders/glsl/hillshade.fragment.glsl`. It rounds
   the varying and each intermediate of the texture coordinate to an IEEE half
   float with `packHalf2x16`.

   ```diff
   @@ -140,9 +140,15 @@
        fragColor = u_shadows[0]*shade + u_highlights[0]*highlight;
    }

   +// Emulate a 16-bit mediump float on hardware that runs mediump as 32-bit.
   +vec2 round_to_half(vec2 v) {
   +    return unpackHalf2x16(packHalf2x16(v));
   +}
   +
    void main() {
        vec2 size = vec2(textureSize(u_image, 0));
   -    vec2 texturePos = (v_pos * (size - 2.0) + 1.0) / size;
   +    vec2 pos = round_to_half(v_pos);
   +    vec2 texturePos = round_to_half((round_to_half(pos * (size - 2.0)) + 1.0) / size);
        vec4 pixel = texture(u_image, texturePos);
   ```

2. Build a dev bundle with the patch, keep a copy, then build an unpatched one
   for comparison. Use the Node version from `.nvmrc`.

   ```sh
   npm ci
   npm run generate-shaders && npm run build-dev && cp -r dist /tmp/dist-emulated
   git checkout src/shaders/glsl/hillshade.fragment.glsl
   npm run generate-shaders && npm run build-dev && cp -r dist /tmp/dist-plain
   npm run build-css && cp dist/maplibre-gl.css /tmp/
   ln -s "$PWD/test/integration/assets/tiles" /tmp/tiles
   ```

3. Save this page as `/tmp/repro.html`. It overzooms the zoom-10 terrain
   tiles that ship with the render tests to zoom 15, the same ratio as the
   Enroute data on the phone.

   ```html
   <!doctype html>
   <html><head><meta charset="utf-8"><link rel="stylesheet" href="maplibre-gl.css">
   <style>body{margin:0}#map{width:512px;height:512px}</style></head>
   <body><div id="map"></div>
   <script type="module">
   const q = new URLSearchParams(location.search);
   const dist = q.get('dist') || 'dist-plain';
   const {Map} = await import(`./${dist}/maplibre-gl-dev.mjs`);
   const map = new Map({
       container: 'map',
       interactive: false,
       fadeDuration: 0,
       center: [parseFloat(q.get('lng') || '-113.26903'), parseFloat(q.get('lat') || '35.9654')],
       zoom: parseFloat(q.get('zoom') || '15'),
       style: {
           version: 8,
           sources: {
               dem: {
                   type: 'raster-dem',
                   tiles: [`${location.origin}/tiles/terrain/{z}-{x}-{y}.terrain.png`],
                   maxzoom: 10,
                   tileSize: 256
               }
           },
           layers: [
               {id: 'background', type: 'background', paint: {'background-color': 'white'}},
               {id: 'hillshade', type: 'hillshade', source: 'dem'}
           ]
       }
   });
   map.once('idle', () => { window.done = true; });
   </script></body></html>
   ```

4. Serve `/tmp` and open the page in a browser, or screenshot it with the
   puppeteer that `npm ci` installs. The `--disable-gpu` and SwiftShader flags
   are the ones the render tests use.

   ```sh
   (cd /tmp && python3 -m http.server 8765 --bind 127.0.0.1 &)
   ```

   ```js
   // /tmp/screenshot.mjs, run from the repository root with: node /tmp/screenshot.mjs
   import puppeteer from 'puppeteer';
   const centers = {
       'existing-test-center': [-113.26903, 35.9654],
       'tile-se-quadrant': [-112.95, 35.80],
       'tile-nw-quadrant': [-113.15, 35.95]
   };
   const browser = await puppeteer.launch({
       headless: true,
       args: ['--disable-gpu', '--enable-features=AllowSwiftShaderFallback,AllowSoftwareGLFallbackDueToCrashes', '--enable-unsafe-swiftshader']
   });
   const page = await browser.newPage();
   await page.setViewport({width: 512, height: 512});
   for (const dist of ['dist-plain', 'dist-emulated']) {
       for (const [name, [lng, lat]] of Object.entries(centers)) {
           await page.goto(`http://127.0.0.1:8765/repro.html?dist=${dist}&lng=${lng}&lat=${lat}&zoom=15`);
           await page.waitForFunction('window.done === true', {timeout: 60000});
           await page.screenshot({path: `/tmp/${dist}-${name}.png`});
       }
   }
   await browser.close();
   ```

5. Compare the pairs. `dist-plain` is smooth. `dist-emulated` shows a visible
   grid of about 8 by 8 CSS pixels, vertical bands along the bright ridge at
   the `existing-test-center` view, and stair steps on every diagonal edge.
   The `existing-test-center` view lies at tile-local x of about 0.81 in
   zoom-10 tile 189/402, which is the coarse region. The north-west view is
   visibly finer but still blocky, because the DEM sample itself is 32 pixels
   wide and the y coordinate of that view is still above 0.5.

   Measured per-channel differences between the pairs, 512 by 512 pixels:

   | View | Max grey difference | Pixels differing by more than 8 levels |
   | --- | --- | --- |
   | `existing-test-center` | 49 | 4011 |
   | `tile-se-quadrant` | 19 | 3324 |
   | `tile-nw-quadrant` | 64 | 2905 |

   With `pixelmatch` at the render tests' default `threshold` of 0.1285 the
   same pairs differ by 521, 0 and 122 pixels. The `allowed` fraction is
   0.00025, so about 66 pixels. The bug therefore fails the default render
   test comparison at two of the three views and passes at the third, even
   though it is obvious by eye. An emulation-based render test would need a
   much lower `threshold` in its `metadata.test` block.

### Checking what a browser really does with `mediump`

The probe below tells whether a given browser and GPU run `mediump` at 16 or
32 bits. It is how the SwiftShader result above was established and is the
first thing to run when evaluating a CI runner for this bug.

```html
<pre id="out"></pre><script>
const gl = document.createElement('canvas').getContext('webgl2');
const mk = (t, s) => { const sh = gl.createShader(t); gl.shaderSource(sh, s); gl.compileShader(sh); return sh; };
const p = gl.createProgram();
gl.attachShader(p, mk(gl.VERTEX_SHADER, `#version 300 es
precision highp float; uniform float u_in; out mediump float v_med;
void main() { gl_Position = vec4(0.0, 0.0, 0.0, 1.0); gl_PointSize = 1.0; v_med = u_in; }`));
gl.attachShader(p, mk(gl.FRAGMENT_SHADER, `#version 300 es
precision mediump float; uniform highp float u_in; in mediump float v_med; out vec4 fragColor;
void main() {
    mediump float a = u_in;
    fragColor = vec4((a - 0.5) * 4096.0, (v_med - 0.5) * 4096.0, 0.0, 1.0);
}`));
gl.linkProgram(p); gl.useProgram(p);
gl.uniform1f(gl.getUniformLocation(p, 'u_in'), 0.5 + 1 / 4096);
gl.viewport(0, 0, 1, 1); gl.drawArrays(gl.POINTS, 0, 1);
const px = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
const f = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.MEDIUM_FLOAT);
document.getElementById('out').textContent =
    `reported mediump mantissa bits: ${f.precision}\n` +
    `mediump uniform copy: ${px[0]} (255 = 32-bit, 0 = 16-bit)\n` +
    `mediump varying:      ${px[1]} (255 = 32-bit, 0 = 16-bit)`;
</script>
```

`0.5 + 1/4096` sits exactly between two half floats and rounds back to `0.5`
at 16 bits, so a 16-bit `mediump` prints `0` and a 32-bit one prints `255`.
Headless Chromium 141 with the render-test flags prints `10` reported bits and
`255` for both values: SwiftShader claims 16-bit `mediump` but computes at
32 bits. A GPU with a real 16-bit `mediump`, such as Mali, Adreno or Apple
silicon, is expected to print `0` for both. Confirm that on the device before
trusting it as a CI runner.

## Fix plan

1. Shader change. Add the block used by `color_relief` to the top of
   `hillshade.fragment.glsl`:

   ```glsl
   #ifdef GL_ES
   precision highp float;
   #endif
   ```

   This is the simplest fix and matches the two other terrain shaders. It also
   promotes `u_latrange` to `highp`. At zoom 15 the latitude span of a tile is
   around 0.005 degrees, which a 16-bit float cannot represent next to a value
   like 44.05, so the `scaleFactor` computation benefits as well.

   The narrower alternative is `in highp vec2 v_pos;` plus a `highp` qualifier
   on `texturePos`, leaving the shading arithmetic at `mediump`. The shader is
   dominated by the texture fetch and by transcendental functions, which do not
   run faster at 16 bits, so the whole-shader form is expected to cost well
   under 1% of a moving frame. Mention both forms in the pull request in case
   reviewers prefer the narrow one.

2. Render test. Add a test next to `hillshade-maxzoom/overzoom` that uses the
   existing `test/integration/assets/tiles/terrain/10-*.terrain.png` tiles with
   source `maxzoom: 10` and a map zoom of 15, mirroring the reported case. The
   existing `overzoom` test only overzooms by one level. State in the test
   description that it documents the scenario and guards the shading output.
   SwiftShader renders it identically before and after the fix.

3. Unit test. Assert that `shaders.hillshade.fragmentSource` from
   `src/shaders/shaders.ts` contains `precision highp float`. This guards the
   fix against a future prelude or shader refactor. It does not exercise the
   bug.

4. Changelog entry under `## main`, `Bug fixes`.

5. Follow-up outside this repository. MapLibre Native carries the same
   unqualified `hillshade` fragment shader, so the same one-line change likely
   applies there.

## CI options

The core constraint was measured directly in headless Chromium 141 with the
same flags the render tests use (`--disable-gpu`, `--enable-unsafe-swiftshader`).
A WebGL2 probe shader compared a `mediump` value of `0.5 + 1/4096` against
`0.5`. SwiftShader reports `mediump` as 10 mantissa bits through
`getShaderPrecisionFormat`, but every `mediump` computation, including
`mediump` varyings, produced the 32-bit result. The current render-test setup
therefore cannot fail on this bug.

The emulation switches that would change that were checked as well:

| Approach | Result |
| --- | --- |
| `--emulate-shader-precision` (old Chromium switch) | Removed. The string is absent from Chromium 141 and from its ANGLE build, as is ANGLE's `EmulatePrecision` pass. |
| ANGLE feature `forceFragmentShaderPrecisionHighpToMediump` | Present in `libGLESv2`, but SwiftShader ignores the relaxed-precision decoration, so it has no effect. It also goes the wrong direction and would undo the fix. |
| Mesa `lavapipe` through ANGLE's Vulkan backend | WebGL does not initialise in headless mode with the GPU process, and Mesa's software drivers keep `mediump` at 32 bits anyway. |

The remaining options, in rough order of effort:

- Regression guards only. The unit test and the deep-overzoom render test from
  the plan. They cannot reproduce the bug but prove the qualifier is present and
  that the output stays stable. This is what pull request 416 did for the
  pattern precision fix, whose `fill-pattern/precision` render test cannot
  fail on desktop either. This is the recommended scope for the fix pull
  request.

- Emulated half precision in a test-only shader build. The updraft
  investigation reproduced the phone screenshot by rounding the varying and
  each intermediate coordinate with `packHalf2x16` and `unpackHalf2x16`.
  Turning that into a test needs a hook that injects a rounding preamble into
  the fragment shader for a test run. It would prove the mechanism and show
  the fix removing it, at the cost of test-only plumbing in the shader
  pipeline. Such a test also needs a `threshold` well below the render tests'
  default of 0.1285, since the measurements in the reproduction section show
  the bug slipping under the default comparison at some views. Only worth
  doing if maintainers ask for a failing test.

- Real 16-bit hardware in CI. Apple GPUs run `mediump` as true half precision,
  so an arm64 macOS GitHub runner with Chrome on its Metal backend could
  reproduce the bug. This is unverified. The render job passes `--disable-gpu`,
  which forces SwiftShader, so a dedicated job would need to drop that flag and
  run only the hillshade tests with their own expected images, because a real
  GPU does not match SwiftShader pixels elsewhere. BrowserStack or Sauce Labs
  Android devices would be higher fidelity but the render tests serve tiles
  through `local://` request interception and would need a real HTTP server.
  Both are separate follow-ups.

Only a phone check is conclusive for the fix itself. The updraft branch has the
emulation patch and the exact view near the `Coupe` waypoint, so a nightly APK
built against a patched MapLibre is the fastest verification.
