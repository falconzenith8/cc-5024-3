# Quantitative Float Resampler

Area-weighted floating-point resampling for quantitative microscopy images with
an independent valid-pixel mask.

The **graphical page is the primary entry point**. The CLI is an auxiliary tool
for scripting and reproducibility checks.

```
npm start          # serves the GUI at http://127.0.0.1:4173/
```

Open <http://127.0.0.1:4173/> in a browser. The page lets you load a float
`.npy` or uncompressed float `.tiff`, select a valid region, choose a target
grid and quantity semantics, resample, inspect individual cells, and download
the float results.

---

## 1. Graphical entry point (primary)

### Layout

| Panel | Purpose |
|---|---|
| **Left — controls** | Data loading, valid-region selection, output grid, quantity semantics, display options |
| **Centre — three canvases** | Source with grid overlay · **float field** · **coverage weights**. All numeric values come from float arrays; canvases are 8-bit previews only. |
| **Right — inspector** | Exact per-cell float values, coverage, provenance bounds, summary statistics, anomalies, float downloads |

### Workflow

1. **Load data.** Either a `.npy` float array, an uncompressed single-channel
   float `.tiff`, or one of the bundled synthetic cases. Supported NPY dtypes:
   bool, int/uint 8/16/32/64, float16/32/64. Compressed TIFFs are rejected
   explicitly rather than silently mis-decoded.
2. **Select the effective region.** Use the mask tools:
   `Select all`, `Clear all`, `Finite only` (mask out NaN/Inf), `Invert`, or draw
   rectangles/ellipses that include or exclude regions. A separate 0/1 mask
   `.npy` can be loaded. Mask value `0` means invalid.
3. **Set the output grid.** Width/height plus an optional crop extent in source
   pixel coordinates. Presets ½×, 1×, 2×, 4× set the grid from the source size.
4. **Choose quantity semantics** (§2) and press **Resample**.
5. **Inspect.** Click any result cell in either result canvas. The inspector
   shows the exact intensity, coverage, valid weight, overlap sum and the source
   pixel bounds that contributed to that cell.
6. **Download the floats.** Downloads are the quantitative deliverable
   (§5). The on-screen image is not.

### Display versus data

Contrast mapping is strictly separated from the saved data:

* `computeDisplayLimits()` collects **finite, mask-valid** samples only and
  supports percentile clamping. It never writes to the data.
* `mapFloatFieldToRgba()` and `mapCoverageToRgba()` produce an 8-bit RGBA
  preview. NaN cells are transparent, never black.
* The float field and the coverage layer are independent renders of the same
  result: intensity from `result.intensity`, coverage from `result.coverage`.
* Changing palette, scale, percentiles or the coverage threshold re-renders
  only the preview. The float arrays are untouched, and the UI test asserts
  this.
* Downloads always serialize `Float64Array`/`Float32Array` values with full
  precision. `cells.csv` uses 17 significant digits.

### Multiple-case UI tests

```bash
npm run test:ui     # requires Playwright + Chromium
```

The UI suite drives a real Chromium instance and asserts, among other things:
constant-field fidelity, that both canvases contain real rendered pixels,
that display changes do not alter floats, that downloads round-trip bit-exactly,
that partial masks produce NaN cells and coverage < 1, that the inspector shows
full-precision values, that sum mode reports conservation only when valid, and
that zero-valued samples stay distinct from masked-out pixels.

> On a machine without the Chromium system libraries, the suite prints the
> missing package list. Install them (e.g. `npx playwright install-deps`) or
> provide them on `LD_LIBRARY_PATH`.

---

## 2. Quantity semantics: mean vs. integral

These are **different quantities** and the program never conflates them.

| Mode | Per-cell value | Units | Conservation |
|---|---|---|---|
| `mean` (default) | `Σ wᵢ·vᵢ / Σ wᵢ` over usable samples | source intensity units | **never claimed**; a resampled mean is not a total |
| `sum` | `Σ wᵢ·vᵢ × pixelArea` over usable samples | intensity × source-pixel-area | only when the footprints partition the usable source and `compensate` is off |

`wᵢ` is the overlap area between source pixel *i*'s unit square and the output
cell's footprint. Coverage is `Σ wᵢ / footprintArea`, clamped to 1.

`sum` mode adds an optional `compensate` flag that divides each cell by its
coverage. This is an **extrapolated estimate**, not a conserved total; the
result is flagged accordingly and the reference self-check skips it by design.

The `stats.integralConserved` flag is true only when *all* of the following hold:
mode is `sum`, `compensate` is false, the requested extent covers the whole
source, and the output footprints collect the entire usable source area.

---

## 3. Missing data, NaN and true zeros

The engine keeps three states strictly apart:

| Input state | Treatment |
|---|---|
| mask=0 (invalid) | excluded from every statistic; contributes **zero weight** to coverage |
| mask≠0 but value NaN/±Inf | treated as missing, contributes zero weight, and raises `NONFINITE_MARKED_VALID` |
| mask≠0 and finite (including exact `0.0`) | a real measurement; contributes its full weight |

Consequences:

* A masked-out pixel's numeric value is never used, so it cannot dilute an
  edge. Turning it into `0` and averaging it is never done.
* An output cell with zero usable overlap gets **`NaN`, not `0`**, and is counted
  in `stats.undefinedCells`. Coverage for that cell is `0`.
* A cell containing only real zeros returns `0` with full coverage. The
  `stats.validTrueZeros` counter distinguishes this from missing data.
* An output cell with partial coverage returns the area-weighted mean of the
  *usable* samples and reports its coverage separately. It does **not**
  extrapolate unless `compensate` is explicitly requested.

### Anomaly codes reported by the GUI and CLI

| Code | Severity | Meaning |
|---|---|---|
| `NO_VALID_SAMPLES` | error | every pixel is masked out or non-finite |
| `NONFINITE_MARKED_VALID` | warning | NaN/Inf found inside the mask; treated as missing |
| `NONZERO_MASKED_OUT` | info | non-zero values are masked out; they are excluded |
| `UNDEFINED_OUTPUT_CELLS` | warning | some cells have zero usable overlap → NaN |
| `LOW_COVERAGE` | warning | some cells fall below the coverage threshold |
| `NON_PARTITIONING_GRID` | warning | sum-mode totals are partial, not conserved |
| `COVERAGE_COMPENSATED_ESTIMATE` | info | totals were divided by coverage (estimate) |
| `OUTPUT_OVERFLOW` | error | a cell overflowed to Infinity under the chosen area semantics |

---

## 4. Numerical behaviour

* All arithmetic is IEEE-754 double precision. Input arrays are promoted to
  `Float64Array` before resampling; no 8-bit or float32 step exists in the
  numeric path.
* Weighted means use West's incremental algorithm, so a constant field stays
  exactly constant regardless of grid alignment. Weighted sums use Neumaier
  compensated summation.
* Extreme dynamic ranges are preserved. A single `1e308` sample does not
  overflow a mean; `stats.finiteMin/finiteMax` and `validMin/validMax` expose
  the actual spans.
* `sum` mode detects genuine overflow and raises `OUTPUT_OVERFLOW` instead of
  quietly writing `Infinity`.

---

## 5. Outputs and how to recompute

For every run the GUI offers:

| Download | Content |
|---|---|
| `intensity.npy` (float64) | requested quantity per cell; NaN where undefined |
| `intensity.npy` (float32) | same, for tools that need float32 — lower precision, clearly labelled |
| `coverage.npy` (float64) | usable-overlap fraction in `[0,1]` |
| `valid_weight.npy` (float64) | usable overlap area in source-pixel-area units |
| `cells.csv` | long-format table with 17-significant-digit values, coverage, weights, overlap sums and source bounds |
| `meta.json` | semantics, grid, statistics, anomalies, provenance |
| `intensity.tiff` (float32) | uncompressed single-channel TIFF for image tools |

Companion arrays are written as separate files rather than packed into RGB,
so no quantitative channel ever shares bits with colour or alpha.

### Reproducible bundled cases

`cases/` holds six synthetic fixtures. Each contains `values.npy`, optional
`mask.npy`, and `case.json` with the expected result. They are regenerated with:

```bash
npm run examples
```

Recompute all cases and compare against the independent reference:

```bash
npm run verify
```

This prints a table of maximum relative intensity error and absolute coverage
error per case. The reference implementation in `src/core/reference.js`
scatters source pixels into output cells — the opposite loop orientation from
the production gather — so shared edge/weight bugs do not cancel out.

| Case | Exercises | Expected |
|---|---|---|
| `constant-field` | any grid keeps a constant | 12.5 exactly, coverage 1 |
| `known-integral-spot` | sum-mode conservation | discrete total 76968.327374074 |
| `partial-mask` | hole + corner mask | partial coverage, NaN empty cells |
| `extreme-dynamic-range` | 1e-12 … 1e6 with zeros and NaN | no float32 demotion |
| `zero-vs-missing` | real zeros vs masked non-zero | 0 at coverage 0.5 |
| `float32-tiff` | TIFF ingestion | loads, float32 precision noted |

---

## 6. Auxiliary CLI

```bash
node src/cli/resample.js \
  --input cases/partial-mask/values.npy \
  --mask  cases/partial-mask/mask.npy \
  --out   out/partial-mask \
  --width 8 --height 8 --mode mean
```

Options: `--extent x0,y0,x1,y1`, `--mode mean|sum`, `--compensate`,
`--pixel-area N`, `--low-coverage T`, `--dtype float32|float64`. Run
`node src/cli/resample.js --help` for the full list.

The CLI writes the same five files as the GUI (`intensity.npy`,
`coverage.npy`, `valid_weight.npy`, `cells.csv`, `meta.json`) and prints the
same anomaly list. It never renders a display image.

---

## 7. Tests

```bash
npm test          # core, I/O, controller, CLI, server  (51 tests)
npm run verify    # reference error report over all cases
npm run test:ui   # real-browser end-to-end suite     (22 checks)
```

The core suite covers constant fields, known integrals, partial masks,
true-zero-versus-missing, fractional pixel offsets, extreme dynamic range,
reference agreement across grids/masks/modes, and invalid inputs. The I/O suite
covers NPY (little/big endian, Fortran order, 2-D and singleton-dim shapes) and
TIFF (float32/64, uint8/16, int32, multi-strip, compressed rejection).

---

## 8. Scope and limits

* This tool measures and reports resampled intensities, integrals and coverage.
  The bundled cases are synthetic. **Nothing here is a biological finding**, and
  the tool makes no diagnostic or biological interpretation.
* Valid results still depend on the input calibration and on the mask
  representing the true acquisition support. The program reports coverage
  precisely so that partial support is never silently averaged away.
* TIFF support is deliberately narrow: uncompressed, single channel. Multi-
  channel, compressed, tiled or pyramidal files are rejected rather than
  guessed at.
