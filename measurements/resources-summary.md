# PAX resource measurements

Three runs per asset and format, fresh page per run. Chromium headless with
SwiftShader, 480×360, server-paced 8 MiB/s, no artificial request latency.
Before: loader at `981590f`. After: the loader changes accompanying this report,
2 ms cooperative CPU budget, 8 MiB upload budget, 4 MiB network queue.

## PAX before → after

Values are medians across three runs. Heap is a sampled main-thread JS peak,
excluding worker/GPU/native-image storage; it is not a total-memory measurement.
Counts cover loading and two post-completion frames, excluding scene teardown.

| Asset | Complete (ms) | 2D subimage calls | Buffer deletes | Texture deletes | JS heap peak (MiB) |
| --- | ---: | ---: | ---: | ---: | ---: |
| BoomBox | 6050 → 4873 | 131593 → 1926 | 0 → 0 | 4 → 1 | 126.5 → 90.1 |
| BrainStem | 317 → 690 | 16 → 35 | 0 → 0 | 0 → 0 | 54.5 → 50.5 |
| FlightHelmet | 7495 → 6217 | 93727 → 1498 | 0 → 0 | 15 → 10 | 166.9 → 102.0 |
| TestMorph | 43 → 78 | 1 → 1 | 4 → 0 | 1 → 0 | 30.1 → 29.9 |
| TestInteractivity | 110 → 94 | 771 → 34 | 0 → 0 | 1 → 0 | 34.3 → 31.6 |

## Frame gaps

P95 is the median of the three run percentiles; maximum is the worst gap across all three
runs. Gaps begin at the scene callback and include shader startup and rendering.
These results do **not** establish a 16.7 ms frame ceiling.

| Asset | P95 (ms), before → after | Worst gap (ms), before → after |
| --- | ---: | ---: |
| BoomBox | 16.8 → 16.8 | 150.0 → 133.3 |
| BrainStem | 33.3 → 16.8 | 33.4 → 50.1 |
| FlightHelmet | 83.4 → 83.4 | 200.0 → 166.7 |
| TestMorph | 16.7 → 16.7 | 16.7 → 16.7 |
| TestInteractivity | 16.7 → 16.7 | 16.8 → 16.8 |

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
