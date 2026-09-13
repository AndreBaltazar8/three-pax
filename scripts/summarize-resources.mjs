import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
const before=JSON.parse(await fs.readFile('artifacts/resources-before.json')),after=JSON.parse(await fs.readFile('artifacts/resources-after.json'));
const median=values=>values.sort((a,b)=>a-b)[Math.floor(values.length/2)];
const assets=[...new Set(after.records.map(r=>r.asset))];
const hashes={};for(const asset of assets){hashes[asset]={};for(const extension of ['glb','pax'])hashes[asset][extension]=createHash('sha256').update(await fs.readFile(`public/assets/${asset}.${extension}`)).digest('hex');}
await fs.mkdir('measurements',{recursive:true});await fs.writeFile('measurements/resources-before.json',JSON.stringify({...before,runtimeCommit:'981590f',assetSHA256:hashes},null,2));await fs.writeFile('measurements/resources-after.json',JSON.stringify({...after,recordedAt:new Date().toISOString(),assetSHA256:hashes},null,2));
const value=(report,asset,field)=>median(report.records.filter(r=>r.asset===asset&&r.format==='pax').map(field));
const rows=assets.map(asset=>{const b=f=>value(before,asset,f),a=f=>value(after,asset,f);return `| ${asset} | ${Math.round(b(r=>r.completeMs))} → ${Math.round(a(r=>r.completeMs))} | ${b(r=>r.counts.texSubImage2D||0)} → ${a(r=>r.counts.texSubImage2D||0)} | ${b(r=>r.counts.deleteBuffer||0)} → ${a(r=>r.counts.deleteBuffer||0)} | ${b(r=>r.counts.deleteTexture||0)} → ${a(r=>r.counts.deleteTexture||0)} | ${(b(r=>r.peakHeapBytes)/1024**2).toFixed(1)} → ${(a(r=>r.peakHeapBytes)/1024**2).toFixed(1)} |`;});
const gaps=assets.map(asset=>`| ${asset} | ${value(before,asset,r=>r.frameGaps.p95).toFixed(1)} → ${value(after,asset,r=>r.frameGaps.p95).toFixed(1)} | ${Math.max(...before.records.filter(r=>r.asset===asset&&r.format==='pax').map(r=>r.frameGaps.max)).toFixed(1)} → ${Math.max(...after.records.filter(r=>r.asset===asset&&r.format==='pax').map(r=>r.frameGaps.max)).toFixed(1)} |`);
await fs.writeFile('measurements/resources-summary.md',`# PAX resource measurements

Three runs per asset and format, fresh page per run. Chromium headless with
SwiftShader, 480×360, server-paced 8 MiB/s, no artificial request latency.
Before: loader at \`981590f\`. After: the loader changes accompanying this report,
2 ms cooperative CPU budget, 8 MiB upload budget, 4 MiB network queue.

## PAX before → after

Values are medians across three runs. Heap is a sampled main-thread JS peak,
excluding worker/GPU/native-image storage; it is not a total-memory measurement.
Counts cover loading and two post-completion frames, excluding scene teardown.

| Asset | Complete (ms) | 2D subimage calls | Buffer deletes | Texture deletes | JS heap peak (MiB) |
| --- | ---: | ---: | ---: | ---: | ---: |
${rows.join('\n')}

## Frame gaps

P95 is the median of the three run percentiles; maximum is the worst gap across all three
runs. Gaps begin at the scene callback and include shader startup and rendering.
These results do **not** establish a 16.7 ms frame ceiling.

| Asset | P95 (ms), before → after | Worst gap (ms), before → after |
| --- | ---: | ---: |
${gaps.join('\n')}

Rectangular uploads remove most tile upload calls. The morph fixture no longer
deletes geometry buffers or its morph GPU texture during refinement. Final asset
buffers keep their identity in both versions; the difference is GPU disposal and
patch bookkeeping. Backpressure bounds queued network data; it does not bound the
asset's resident geometry/textures or a single decoded packet.

Budgets trade completion speed for smaller batches. Geometry-only/small assets may
finish later despite lower allocation churn. Large texture allocations, source
replacements, KTX2 upgrades, native morph-cache initialization and shader compilation
remain indivisible or outside the cooperative scheduler. Benchmark on the target
GPU and application scene before choosing budgets.

Raw reports include GLB control runs, per-run counters, CPU submission timings,
scene-ready times, and asset hashes:
[before](resources-before.json), [after](resources-after.json).
GPU submission time is not GPU execution time; heap sampling and a three-run sample
are insufficient to claim elimination of GC pauses or hardware-independent speedups.
`);
console.log((await fs.readFile('measurements/resources-summary.md','utf8')));
