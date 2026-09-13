# Loading resources

PAX v0 does not require a new buffer at every detail level. The manifest includes
final geometry sizes; the loader reserves attribute and index storage once and
updates it as packets arrive. These changes affect the loader, not the file format
or the converter's 5% size cap.

## Controls

```js
const loader = new PAXLoader();
loader.gltfLoader = configureDecoders(createGLTFLoader(), renderer);
const result = await loader.load('/model.pax', {
  renderer,                         // enables rectangular and morph texture uploads
  frameBudgetMs: 2,                  // cooperative CPU work per scheduling slice
  uploadBudgetBytes: 8 * 1024 ** 2,   // estimated uploads per slice
  maxBufferedBytes: 4 * 1024 ** 2,    // network read-ahead queue
  onScene(gltf) { scene.add(gltf.scene); },
});
console.log(result.metrics);
```

`configureDecoders` remembers the renderer, so explicitly passing it is optional
when using that helper. Without a renderer, the loader uses Three.js update flags
and its original morph/texture fallback paths. `frameBudgetMs: 0` disables the
cooperative CPU and upload scheduling limits. Lower budgets can extend completion
time. Decoder workers remain enabled by default. Budgets renew on animation frames,
including frames that pass while awaiting a network packet or worker response.
Only active work schedules a renewal callback; completed streams cancel it.

**The budget is not a frame-rate guarantee.** Tasks yield between chunks; a single
allocation, upload, shader compilation or application callback cannot be preempted.
The renderer, animation, interactivity and other application work also consume the
frame. A 60 Hz frame allows about 16.7 ms for all of it.

## Allocation paths

| Resource | Behavior |
| --- | --- |
| Vertex attributes | Final-size typed arrays and `BufferAttribute` objects; append ranges update existing GPU buffers. |
| Indices | Fixed typed arrays, dense active slots and an ID-to-slot map. Removes swap the last slot; final ordering swaps in place. No array per triangle. |
| Tile textures | One final-size CPU image and GPU texture per sampling variant. Rectangular subimage uploads replace row-by-row calls. Mips are generated at initialization and completion. |
| Tile decoding | Worker reserves active tile storage and scratch space, returns patch buffers for reuse, and releases completed tiles. |
| Ordinary lattice textures | Dimensions still grow; old pixel storage transfers to the worker without cloning, but each larger image needs new storage. |
| Source images / KTX2 | Final source replacement and KTX2 dimension upgrades still replace GPU storage. Compressed mip data is retained. |
| Morph targets | With a renderer, a persistent float texture receives appended rows. Geometry GPU buffers stay alive. Native influence uniforms, skinning and CPU morph attributes remain available. |
| Network | Consumer credits bound the application read-ahead queue. A paused consumer pauses further worker reads. |

The morph path currently falls back to native cache rebuilding for instanced morphs
and scenes with material variants, animation pointers, interactivity or registered
custom extensions, preserving their material bindings. Set `reuseMorphTextures: false` for scene override
materials or applications that replace morph materials after load; those materials
do not inherit the custom shader. Tangent morphs keep their existing texture but
still repack/upload the whole tangent cache when attributes change. Three.js also
creates its native CPU morph cache once; the custom shader does not upload that
unused native texture in the normal material path.

Full-size reservation reduces churn but increases memory used before full detail
arrives. Tile workers also retain data for unfinished tiles. The network limit does
not cap browser socket buffers, the packet being assembled/decoded, geometry,
textures, or renderer caches. Large individual packets and bootstrap GLTF parsing
remain separate memory and latency costs.

`result.dispose()` stops the session worker/network and interactivity. Scene
geometries, materials and textures remain application-owned; dispose them when
removing the model. Disposing a geometry also releases its PAX morph texture and
custom shadow materials. A failed or cancelled bootstrap releases resources that
have not reached `onScene`. When retiring a configured loader, also dispose its
KTX2/Draco decoder loaders; these are separate from the PAX packet worker.

## Measurements

Run the Node sample server, then:

```sh
BASE_URL=http://localhost:4186 npm run profile:resources
# Optional cached heavy assets; run npm run assets first:
ASSETS=BoomBox,BrainStem,FlightHelmet,TestMorph,TestInteractivity \
  BASE_URL=http://localhost:4186 npm run profile:resources
```

The harness opens a fresh page per run and records three runs each of PAX and GLB.
`ASSETS`, `FORMATS`, `REPEATS`, `RATE` (KiB/s), `BUDGET` (ms), `BACKEND`,
`WARMUP` (0/1) and `OUTPUT` override
the defaults. `TestMorph` is generated by the morph browser test; use
`ASSETS=BoomBox,TestInteractivity` before running that test.

`examples/profile.html` shows an individual run. The report records WebGL buffer
and texture creation/deletion, upload calls, buffer bytes, submission CPU time,
frame gaps, scene-ready/completion times and sampled main-thread JS heap.
`firstMs` means scene readiness; `firstRenderedMs` marks completion of the first
render submission containing the model, not display presentation. Heap measurements
exclude worker and GPU memory; WebGL call times measure CPU submission. Optional
GPU timer queries measure model rendering separately during loading and for 500 ms
after completion; they exclude loader uploads outside `renderer.render`. Unsupported
queries report `supported: false`; samples can be absent for a short loading phase.
The post-completion phase includes the final upload/first render, not just idle work.

Renderer dimensions are 480×360. The default backend is SwiftShader. For hardware:

```sh
BACKEND=vulkan ASSETS=BoomBox,BrainStem,FlightHelmet npm run profile:resources
```

Depending on the system, Chromium may require `DISPLAY`/`XDG_RUNTIME_DIR` from the
local desktop session. The runner records the actual WebGL renderer, browser/driver
information and asset/runtime hashes. Hardware runs fail if the renderer identifies
SwiftShader or llvmpipe. A successful browser launch alone is not hardware evidence.

Use `WARMUP=1` to measure awaiting
[Three.js compileAsync](https://threejs.org/docs/pages/WebGLRenderer.html#compileAsync)
before adding either format's scene. The existing async `onScene` callback supports
this in applications:

```js
async onScene(gltf) {
  await renderer.compileAsync(gltf.scene, camera, scene);
  scene.add(gltf.scene);
}
```

Configure lighting/environment first. This can move shader preparation before scene
publication, but does not pre-upload geometry or eliminate first-render driver work.
Include the wait in first-visible timing when comparing formats.

Loader metrics include:

- `geometryReservedBytes`, `textureReservedBytes`, `morphReservedBytes`: tracked
  typed storage reservations, not total process/GPU memory. Geometry includes
  index bookkeeping; texture reservations count the full tiled CPU images.
- `tileBufferAllocations`, `tileAllocatedBytes`, `patchReuses`: cumulative worker
  tile allocations and returned-buffer reuse, not a live-memory estimate.
- `cpuWorkMs`, `maxTaskMs`, `maxSliceMs`, `budgetYields`: explicitly scheduled work.
  GLTF parsing, callbacks and renderer frame work are excluded.
- `uploadBytes`: estimated scheduled bytes; dirty-page merging and renderer caches
  can change actual GPU traffic.
- `textureRectUploads`, `textureReplacements`, `geometryDisposals`: loader operations.
  Use instrumented WebGL counters for actual driver object creation/deletion.
- `networkQueuePeakBytes`: peak application stream queue occupancy.

See [resource measurements](https://github.com/AndreBaltazar8/three-pax/blob/main/measurements/resources-summary.md) for the recorded
before/after results and remaining stalls.

See [hardware measurements](../measurements/hardware-summary.md) for the RTX 4090
runs and the scheduling change measured separately from shader preparation.
