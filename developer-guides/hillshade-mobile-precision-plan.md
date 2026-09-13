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
  pipeline. Only worth doing if maintainers ask for a failing test.

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
