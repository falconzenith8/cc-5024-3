# Architecture

## Module map

```
src/core/
  resample.js     production engine: gathers per output cell, area weights
  reference.js    independent scatter-based reference (tests + self-check)
  npy.js          NumPy .npy reader/writer, 2-D collapse, both byte orders
  tiff.js         uncompressed single-channel TIFF reader/writer
  display.js      display-only contrast mapping and colormaps
  mask.js         mask creation, shape drawing, coverage projection
  output.js       full-precision CSV / JSON / NPY serialization

src/ui/
  index.html      page structure
  style.css       layout and dark theme
  controller.js   state, validation, engine invocation, inspection
  main.js         DOM wiring, canvas rendering, downloads, drawing tools

src/cli/resample.js   auxiliary command-line entry
tools/
  serve.js            static server (GUI)
  generate-examples.js regenerate cases/
  verify-cases.js     reference-error report
test/
  core.test.js        engine invariants
  io.test.js          NPY/TIFF round-trips
  controller.test.js  UI state and display separation
  cli.test.js         CLI behaviour
  server.test.js      HTTP serving
  ui/run-ui-test.js   Playwright end-to-end suite
```

`src/core/*` is plain ES modules with no DOM or Node dependencies, so the
browser and the CLI run the identical numeric code. The UI never reimplements
resampling; it calls `resample()` directly.

## Data flow

```
.npy / .tiff bytes
      │ parse (npy.js / tiff.js)
      ▼
Float64Array + width/height (+ separate Uint8 mask)
      │ resample(): per output cell, overlap-weight usable samples
      ▼
{ intensity, coverage, validWeight, overlapSum, defined,
  provenance, stats, anomalies }
      ├─► display.js  ──► 8-bit canvas preview (throwaway)
      └─► output.js   ──► float32/float64 .npy, full-precision .csv, .json, .tiff
```

The branch is deliberate: nothing that reaches a canvas is ever read back as
a quantitative value.

## Weighting model

Each source pixel is a unit square `[x, x+1) × [y, y+1)`. An output cell's
footprint `[sx0, sx1) × [sy0, sy1)` overlaps each pixel by
`w = (min(sx1, x+1) − max(sx0, x)) × (min(sy1, y+1) − max(sy0, y))`.
All sums use usable samples only (`mask ≠ 0 && isFinite(value)`).

Coverage = `Σ w_usable / footprintArea`, clamped to 1.
Mean = incremental weighted mean of usable samples.
Sum = `Σ w_usable·v × pixelArea`, optionally divided by coverage.

Conservation is asserted only under verifiable conditions (see README §2).

## Numerics

* Weighted totals: Neumaier compensated summation.
* Weighted mean: West's incremental update, exact for constant fields.
* Undefined cells are `NaN`; the `defined` flag marks them.
* `OUTPUT_OVERFLOW` is raised if a finite computation still overflows.
