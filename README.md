# three-pax

A Three.js loader for **PAX numeric file format version 0**. Display a coarse scene
as its bootstrap arrives, then refine the same objects, geometry, materials and
textures. Supports full streaming and selective HTTP-range sessions with resume.

## Run the included samples

```sh
npm ci
npm run dev
```

Open **http://localhost:4186** for a side-by-side glTF/PAX comparison with identical
server-paced bandwidth, first-render/completion timers, download counters, orbit
controls and animation. Included samples: BoomBox, diffuse transmission,
interactive scene, Gaussian splats and KTX2 GPU texture mips. Their `.pax` files
are ready to load; no converter run is needed to start the viewer.

Open **http://localhost:4186/examples/range.html** to try coarse-only loading,
selective texture refinement and resume directly.

```sh
npm run assets           # optional large original helmet and animated BrainStem
npm run assets:optimized # optional meshopt + KTX2 helmet baseline
npm run fixtures -- --catalog
npm run benchmark        # 3 runs per heavy asset; run both asset commands first
```

Asset counters measure model bytes, excluding application/decoder downloads.
Decoder startup and the shared tab's CPU/GPU affect wall-clock results. Frame-gap
measurements are shared main-thread stalls, not isolated per-loader CPU attribution.
Historical recordings from the original experiment are not bundled.

## Use the loader

```js
import {PAXLoader, createGLTFLoader, configureDecoders} from 'three-pax';
const loader = new PAXLoader();
loader.gltfLoader = configureDecoders(createGLTFLoader(), renderer);
const result = await loader.load('/model.pax', {
  signal: abortController.signal,
  onScene(gltf, manifest) { scene.add(gltf.scene); },
  onProgress({bytes, total}) { console.log(bytes, total); },
  onRefine(event) { console.log(event.kind, event.level); },
});
// Tick animations/interactivity from your render loop as in the included sample.
```

**Repository access:** the converter is an optional development tool pinned to its
GitHub commit. Asset/fixture generation automatically installs it and needs SSH
access to `AndreBaltazar8/convert-pax`. The normal `npm ci`, bundled viewer, build
and runtime do not need access to that repository. You can install it explicitly
with `npm run setup:converter`.

`configureDecoders` expects Three.js Basis/Draco files at `/decoders/`. The sample
copies them during `npm ci`. Applications can instead configure their own
`setKTX2Loader`, `setDRACOLoader` and `setMeshoptDecoder`. A bundler supporting
`new Worker(new URL(..., import.meta.url))`, such as Vite, is required for default
workers. Three.js r186 and WebGL2 are the tested target.

```js
let session = await loader.load('/model.pax', {
  transport: 'range', maxLevel: 0, onScene,
});
session = await session.refine({primitives: [0], images: [0], tiles: [0]});
session = await session.refine(); // only missing packets; complete final asset
console.log(session.complete, session.bytes);
session.dispose();              // release the session worker and interactivity
```

Range hosts must return valid HTTP 206/Content-Range. For cross-origin hosting,
expose Content-Range and ETag through CORS. `maxLevel` controls scheduled levels;
primitive/image/tile lists select refinements. Bootstrap always includes the whole
coarse scene. Scene-wide extension barriers can require additional geometry.
Resume retains state in memory; it is not a disk cache. Default `stream` transport
makes one request and is preferable when the full asset is wanted.

## Verify and build

```sh
npm test
npm run build
npm run test:package       # install and check the actual packed library
npx playwright install chromium
npm run fixtures -- --catalog
npm run assets
npm run assets:optimized
npm run test:browser      # keep npm run dev running in another terminal
```

`dist/` alone does not provide the benchmark's `/stream/` endpoint. Use the included
Node server for throttled comparisons. A production app can serve static PAX files
from a normal asset host.

[Complete specification](https://github.com/AndreBaltazar8/spec-pax) ·
[Converter](https://github.com/AndreBaltazar8/convert-pax) ·
[Supported glTF semantics and extension adapters](docs/COMPATIBILITY.md) ·
[Notices and asset licenses](THIRD_PARTY.md)

The converter enforces the 5% whole-file overhead cap. Intermediate quality is
approximate; final decoded data is lossless within the defined profile. GPU morph
caches still rebuild for morph-bearing refinements; KTX2 mip upgrades retain CPU
transcodes but resize GPU storage. Splat ordering is asynchronous per primitive,
not a global ordering across multiple fields. These are documented research limits.
