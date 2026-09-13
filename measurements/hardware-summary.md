# Hardware loading measurements

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
| BoomBox | 147.4 → 142.0 | 1785.0 → 1546.0 | 16.8 → 16.8 | 71.0 → 47.0 |
| BrainStem | 95.8 → 98.3 | 264.9 → 255.8 | 33.4 → 33.4 | 6.0 → 2.0 |
| FlightHelmet | 227.1 → 226.0 | 6088.9 → 6078.0 | 83.3 → 33.3 | 72.0 → 47.0 |

| Asset | GLB bytes | PAX bytes | File overhead |
| --- | ---: | ---: | ---: |
| BoomBox | 10614184 | 11102572 | 4.60% |
| BrainStem | 3194848 | 1658933 | -48.07% |
| FlightHelmet | 48383388 | 50440003 | 4.25% |

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
| BoomBox / pax | 167.1 → 173.3 | 16.8 → 16.8 | 1.44 → 1.43 |
| BoomBox / glb | 1433.9 → 1453.7 | 50.0 → 50.1 | no samples → no samples |
| BrainStem / pax | 125.7 → 136.9 | 49.9 → 16.8 | 11.88 → 4.29 |
| BrainStem / glb | 432.4 → 456.5 | 33.4 → 16.8 | no samples → no samples |
| FlightHelmet / pax | 265.6 → 276.3 | 33.3 → 33.3 | 4.22 → 4.12 |
| FlightHelmet / glb | 6258.3 → 6278.4 | 266.7 → 216.7 | no samples → no samples |

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

```sh
BACKEND=vulkan ASSETS=BoomBox,BrainStem,FlightHelmet \
  OUTPUT=artifacts/hardware-control.json npm run profile:resources
BACKEND=vulkan WARMUP=1 ASSETS=BoomBox,BrainStem,FlightHelmet \
  OUTPUT=artifacts/hardware-warmup.json npm run profile:resources
```

Use BASE_URL if the server is not on port 4190. Hardware selection is verified using
the actual WebGL renderer; a software fallback rejects the run. Each current report
includes asset and runtime SHA-256 hashes. The older before/after files preserve
the original instrumented batches. Raw reports: [before](hardware-before.json),
[after](hardware-after.json), [control](hardware-control.json), [warmup](hardware-warmup.json).
