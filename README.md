# three-pax

Three.js loader for **PAX v0**. Render the bootstrap scene, then refine its geometry
and textures through a full stream or resumable HTTP-range requests.

## Samples

Requires **Node.js 24+**.

```sh
npm ci
npm run dev
```

- [Comparison](http://localhost:4186): glTF/PAX views with matched server-paced
  bandwidth, first-render/completion timers, download counters and orbit controls.
- [Range loading](http://localhost:4186/examples/range.html): coarse loading,
  selective texture refinement and resume.

Bundled assets include BoomBox, diffuse transmission, interactivity, Gaussian
splats and KTX2 mips. They run without conversion.

```sh
npm run assets           # optional helmet and animated BrainStem
npm run assets:optimized # optional meshopt + KTX2 helmet
npm run fixtures -- --catalog
npm run benchmark        # three runs per heavy asset; run both asset commands first
```

Asset generation installs a pinned converter over GitHub SSH and requires working
GitHub SSH access. `npm run setup:converter` installs it explicitly. The bundled
viewer and normal install/build do not need the converter.

## Loader

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
```

Update animations and interactivity in your render loop; see the samples.
Tested with **Three.js r186 and WebGL2**. Default workers require a bundler that
supports `new Worker(new URL(..., import.meta.url))`, such as Vite.

`configureDecoders` uses Basis/Draco files at `/decoders/`; sample installation
copies them there. Applications can configure `setKTX2Loader`, `setDRACOLoader`
and `setMeshoptDecoder` themselves.

## Range loading

```js
let session = await loader.load('/model.pax', {
  transport: 'range', maxLevel: 0, onScene,
});
session = await session.refine({primitives: [0], images: [0], tiles: [0]});
session = await session.refine(); // fetch remaining packets
console.log(session.complete, session.bytes);
session.dispose();              // release worker and interactivity
```

The host must support HTTP 206 with valid `Content-Range`. Cross-origin hosts must
expose `Content-Range` and `ETag` through CORS. `maxLevel` limits scheduled levels;
resource lists select refinements. The bootstrap includes the whole coarse scene,
and extension dependencies may require extra geometry. Resume state is in memory.
Use the default `stream` transport when loading the whole asset in one request.

## Verification

```sh
npm test
npm run build
npm run test:package
npx playwright install chromium
npm run fixtures -- --catalog
npm run assets
npm run assets:optimized
npm run test:browser      # keep npm run dev running in another terminal
```

## Limits

- Download counters exclude app/decoder bytes. Timings include decoder startup
  and shared CPU/GPU work; frame gaps do not isolate each loader's CPU cost.
  CI tests first-frame streaming at 512 KiB/s, not a timing guarantee.
- Throttled comparisons require the Node server's `/stream/` endpoint; `dist/`
  alone is insufficient. Applications can host PAX files as static assets.
- Previews are approximate; final data is lossless within the format's defined
  profile. The converter enforces the 5% file-overhead cap.
- Morph refinements rebuild GPU morph caches. KTX2 upgrades retain CPU transcodes
  but resize GPU storage. Splat sorting is per primitive, not scene-wide.

See [compatibility and adapters](docs/COMPATIBILITY.md),
[spec-pax](https://github.com/AndreBaltazar8/spec-pax),
[convert-pax](https://github.com/AndreBaltazar8/convert-pax) and
[blender-pax](https://github.com/AndreBaltazar8/blender-pax).

[MIT](LICENSE). Sample assets and dependencies have separate
[licenses](THIRD_PARTY.md).
