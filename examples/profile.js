import * as THREE from "three";
import {
  PAXLoader,
  createGLTFLoader,
  configureDecoders,
} from "../src/index.js";
import { fetchAsset } from "../src/network.js";
const params = new URLSearchParams(location.search),
  asset = params.get("asset") || "BoomBox",
  format = params.get("format") || "pax";
const renderer = new THREE.WebGLRenderer({
  canvas: document.querySelector("canvas"),
  antialias: false,
});
renderer.setSize(480, 360);
const gl = renderer.getContext();
const counts = {},
  times = {},
  sizes = {};
for (const key of [
  "createBuffer",
  "deleteBuffer",
  "bufferData",
  "bufferSubData",
  "createTexture",
  "deleteTexture",
  "texStorage2D",
  "texStorage3D",
  "texImage2D",
  "texSubImage2D",
  "texSubImage3D",
  "compressedTexSubImage2D",
  "generateMipmap",
]) {
  const original = gl[key];
  gl[key] = function (...args) {
    counts[key] = (counts[key] || 0) + 1;
    const start = performance.now();
    try {
      return original.apply(this, args);
    } finally {
      times[key] = (times[key] || 0) + performance.now() - start;
      if (key === "bufferData")
        sizes[key] =
          (sizes[key] || 0) +
          (typeof args[1] === "number" ? args[1] : args[1]?.byteLength || 0);
      if (key === "bufferSubData")
        sizes[key] =
          (sizes[key] || 0) +
          (args[4] !== undefined
            ? args[4] * args[2].BYTES_PER_ELEMENT
            : args[2]?.byteLength || 0);
    }
  };
}
const scene = new THREE.Scene(),
  camera = new THREE.PerspectiveCamera(40, 4 / 3, 0.001, 10000);
scene.add(new THREE.HemisphereLight(0xffffff, 0x777777, 3));
let stopped = false,
  first = null,
  last = null,
  mixer,
  frameCount = 0,
  peakHeap = 0;
const gaps = [],
  renderTimes = [],
  start = performance.now();
function frame(now) {
  if (stopped) return;
  if (first !== null && last !== null) gaps.push(now - last);
  last = now;
  mixer?.update(1 / 60);
  const t = performance.now();
  renderer.render(scene, camera);
  renderTimes.push(performance.now() - t);
  frameCount++;
  peakHeap = Math.max(peakHeap, performance.memory?.usedJSHeapSize || 0);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
let atBase,
  identities,
  geometryReplacements = 0;
const onScene = (gltf) => {
  scene.add(gltf.scene);
  const box = new THREE.Box3().setFromObject(gltf.scene),
    size = box.getSize(new THREE.Vector3()).length() || 1,
    center = box.getCenter(new THREE.Vector3());
  camera.position.copy(center).add(new THREE.Vector3(size, size * 0.5, size));
  camera.lookAt(center);
  camera.near = size / 1000;
  camera.far = size * 100;
  camera.updateProjectionMatrix();
  if (gltf.animations.length) {
    mixer = new THREE.AnimationMixer(gltf.scene);
    for (const a of gltf.animations) mixer.clipAction(a).play();
  }
  first = performance.now() - start;
  identities = new Map();
  gltf.scene.traverse((o) => {
    if (o.geometry)
      identities.set(o, {
        geometry: o.geometry,
        index: o.geometry.index?.array,
        attrs: Object.fromEntries(
          Object.entries(o.geometry.attributes).map(([k, v]) => [k, v.array]),
        ),
      });
  });
  atBase = structuredClone(counts);
};
window.profileDone = (async () => {
  const url = `/stream/${asset}.${format}?kbps=${params.get("rate") || "8192"}`;
  let result;
  if (format === "pax") {
    const loader = new PAXLoader();
    loader.gltfLoader = configureDecoders(createGLTFLoader(), renderer);
    result = await loader.load(url, {
      frameBudgetMs: Number(params.get("budget") || 2),
      onScene,
    });
  } else {
    const response = await fetchAsset(url),
      buffer = await new Response(response.body).arrayBuffer();
    const gltf = await configureDecoders(
      createGLTFLoader(),
      renderer,
    ).parseAsync(buffer, "");
    onScene(gltf);
    result = { gltf };
  }
  const complete = performance.now() - start;
  await new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(r)),
  );
  stopped = true;
  for (const [mesh, ref] of identities)
    if (
      mesh.geometry !== ref.geometry ||
      mesh.geometry.index?.array !== ref.index ||
      Object.keys(ref.attrs).some(
        (k) => mesh.geometry.attributes[k]?.array !== ref.attrs[k],
      )
    )
      geometryReplacements++;
  const percentile = (a, p) =>
    [...a].sort((x, y) => x - y)[
      Math.min(a.length - 1, Math.floor(a.length * p))
    ] || 0;
  const report = {
    asset,
    format,
    firstMs: first,
    completeMs: complete,
    frameCount,
    frameGaps: {
      p95: percentile(gaps, 0.95),
      max: Math.max(0, ...gaps),
      over16_7: gaps.filter((v) => v > 16.7).length,
      over50: gaps.filter((v) => v > 50).length,
    },
    renderCpuMs: {
      p95: percentile(renderTimes, 0.95),
      max: Math.max(0, ...renderTimes),
    },
    counts,
    atBase,
    times,
    sizes,
    peakHeapBytes: peakHeap,
    geometryReplacements,
    loader: result.metrics,
  };
  document.querySelector("#status").textContent = JSON.stringify(
    report,
    null,
    2,
  );
  result.dispose?.();
  return report;
})().catch((error) => {
  document.querySelector("#status").textContent = error.stack;
  throw error;
});
