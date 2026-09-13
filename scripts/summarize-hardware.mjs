import fs from 'node:fs/promises';
const names = ['before', 'after', 'control', 'warmup'];
const reports = {};
for (const name of names) {
  reports[name] = JSON.parse(await fs.readFile(`artifacts/hardware-${name}.json`));
  await fs.mkdir('measurements', { recursive: true });
  await fs.copyFile(`artifacts/hardware-${name}.json`, `measurements/hardware-${name}.json`);
}
const median = values => [...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
const records = (name,asset,format='pax') => reports[name].records.filter(r=>r.asset===asset && r.format===format);
const med = (name,asset,key,format) => median(records(name,asset,format).map(r=>r[key]));
const assets = [...new Set(reports.before.records.map(r=>r.asset))];
let text = `# Hardware loading measurements

NVIDIA GeForce RTX 4090, driver 580.95.05, Chromium ANGLE/Vulkan, WebGL2.
480×360, antialiasing off, 8 MiB/s per stream, three sequential runs per
asset/format, a fresh page each run. This is a high-end desktop test, not a mobile
or high-resolution guarantee. Browser/driver caches were not explicitly flushed;
the desktop and GPU clock management remained active. Runs are descriptive samples,
not statistically isolated proof of every timing difference.

## Frame-budget renewal

Baseline runtime: 8550ee6. The changed loader renews its CPU/upload allowance when
an animation frame passes during network/worker waits, instead of charging work
from previous frames. Reservations, format bytes and per-frame allowances are unchanged.
These two batches use identical instrumentation and no shader precompilation.

| PAX asset | Median ready, before → after (ms) | Median complete, before → after (ms) | Worst frame gap, before → after (ms) | Median budget yields, before → after |
| --- | ---: | ---: | ---: | ---: |
`;
for (const asset of assets) {
  const pair = fn => ['before','after'].map(name=>fn(name).toFixed(1)).join(' → ');
  text += `| ${asset} | ${pair(n=>med(n,asset,'firstMs'))} | ${pair(n=>med(n,asset,'completeMs'))} | ${pair(n=>Math.max(...records(n,asset).map(r=>r.frameGaps.max)))} | ${pair(n=>median(records(n,asset).map(r=>r.loader.budgetYields)))} |\n`;
}
text += '\n| Asset | GLB bytes | PAX bytes | File overhead |\n| --- | ---: | ---: | ---: |\n';
for (const asset of assets) {
  const glb = (await fs.stat(`public/assets/${asset}.glb`)).size;
  const pax = (await fs.stat(`public/assets/${asset}.pax`)).size;
  text += `| ${asset} | ${glb} | ${pax} | ${((pax/glb-1)*100).toFixed(2)}% |\n`;
}
text += `
Ready means the scene callback; complete means the loader resolved, before a final
render submission. The before/after frame-gap window includes the first two frames
after completion. No geometry/attribute arrays were replaced in these PAX runs.
Source-image replacements still delete textures; those are not eliminated.

The original before/after query series also includes empty waiting frames and can
miss the final outstanding queries. Do not use its GPU percentile to compare GLB
with PAX. The control/warmup batches below correct this: only model frames enter
GPU queries, and a further 500 ms captures final-render work separately. Zero query
samples during GLB loading means it was not rendering yet, not that GPU work was free.

## Shader preparation experiment

Both batches use the updated loader and corrected query harness. Warmup awaits
Three.js compileAsync before adding either format's scene. Times include that wait.
The first-render number is CPU render submission completion, not display scanout.

| Asset / format | Median first render, control → warmup (ms) | Worst frame gap across loading/final window, control → warmup (ms) | Median loading GPU render p95, control → warmup (ms) |
| --- | ---: | ---: | ---: |
`;
for (const asset of assets) for (const format of ['pax','glb']) {
  const pair = fn => ['control','warmup'].map(n=>fn(n)).join(' → ');
  text += `| ${asset} / ${format} | ${pair(n=>med(n,asset,'firstRenderedMs',format).toFixed(1))} | ${pair(n=>Math.max(...records(n,asset,format).map(r=>Math.max(r.frameGaps.max,r.settledFrameGaps.max))).toFixed(1))} | ${pair(n=>records(n,asset,format).some(r=>r.renderGpuMs.samples) ? median(records(n,asset,format).map(r=>r.renderGpuMs.p95)).toFixed(2) : 'no samples')} |\n`;
}
text += `
Shader preparation remains opt-in in the profiling sample and available through the
loader's async onScene callback. It does not pre-upload geometry/source textures or
remove every startup stall. Flight Helmet's transmission pass also generates mipmaps
during normal rendering; total mipmap calls are not exclusively streaming overhead.
GPU queries bracket renderer.render only; CPU call timing and loader metrics cover
other scheduled work but cannot measure GPU upload completion or total VRAM usage.
The 16.7 ms target is not a hard ceiling: individual driver calls, bootstrap parsing,
shader setup and application work remain outside cooperative preemption.

## Reproduce

Start the sample server, cache the heavy assets, then:

\`\`\`sh
BACKEND=vulkan ASSETS=BoomBox,BrainStem,FlightHelmet \\
  OUTPUT=artifacts/hardware-control.json npm run profile:resources
BACKEND=vulkan WARMUP=1 ASSETS=BoomBox,BrainStem,FlightHelmet \\
  OUTPUT=artifacts/hardware-warmup.json npm run profile:resources
\`\`\`

Use BASE_URL if the server is not on port 4190. Hardware selection is verified using
the actual WebGL renderer; a software fallback rejects the run. Each current report
includes asset and runtime SHA-256 hashes. The older before/after files preserve
the original instrumented batches. Raw reports: [before](hardware-before.json),
[after](hardware-after.json), [control](hardware-control.json), [warmup](hardware-warmup.json).
`;
await fs.writeFile('measurements/hardware-summary.md',text);
