# Validity contract: missing values, coverage weights and numeric conventions

This is the single written reference for how the resampler treats invalid
data, how coverage weights are defined, and how numbers are normalized. The
production engine (`src/core/resample.js`), the checks in
`tools/contract/`, and the GUI all implement exactly this document. If prose
and code ever disagree, the contract checks fail and the discrepancy must be
fixed rather than documented around.

## 1. Three input states, kept strictly apart

| Input state | Usable? | Weight contribution | Counter |
|---|---|---|---|
| mask = 0 (invalid) | no | zero; value is never read into any statistic | `excludedNonZero` / `excludedNonFinite` |
| mask ≠ 0 but value is `NaN`/`±Infinity` | no | zero; reported as missing, never as zero | `maskedNonFinite` |
| mask ≠ 0 and finite, **including exact `0.0`** | yes | full overlap weight | `validPixels`, `validTrueZeros` when the value is 0 |

The central rule: **no data is never interpreted as a numeric zero.**

* An output cell with no usable overlap receives `NaN`, coverage `0` and
  valid weight `0`. It is counted in `stats.undefinedCells` and rendered
  transparent/purple, never black or as `0`.
* A cell whose usable samples are all exactly `0.0` receives the finite
  value `0` with the coverage actually observed. `stats.validTrueZeros`
  keeps this case distinguishable from missing data.
* The display layer's empty-fallback limits (`method: 'empty-fallback'`)
  only choose preview colours; no numeric array is ever filled, and a
  no-data cell stays transparent. Preview fallbacks cannot reach the
  floats.

## 2. Coverage weights

Every source pixel is the unit square `[x, x+1) × [y, y+1)`. The overlap
weight of pixel *i* with output cell *c* is the intersection area

```
wᵢ = (min(sx1, x+1) − max(sx0, x)) · (min(sy1, y+1) − max(sy0, y))
```

* Only **usable** samples accumulate weight. Masked and non-finite pixels
  contribute `0` to the weight even though they occupy footprint area.
* `validWeight[c] = Σ wᵢ` over usable samples, in source-pixel-area units.
* `coverage[c] = min(1, validWeight[c] / footprintArea)`, always in `[0,1]`.
* `overlapSum[c] = Σ wᵢ·vᵢ` over usable samples; it is retained so the
  reported mean can be audited as `overlapSum / validWeight`.
* The aggregate coverage amount is `stats.totalOverlapArea = Σ validWeight`;
  `stats.sourceCoverage` is that amount divided by the usable source area.
  The contract checker asserts the per-cell weights sum to this amount.

## 3. Numeric normalization and semantics

| Quantity | Formula | Units | Undefined cell |
|---|---|---|---|
| mean (default) | `Σ wᵢ·vᵢ / Σ wᵢ` over usable samples (West incremental update) | source intensity | `NaN` |
| sum | `Σ wᵢ·vᵢ × sourcePixelArea` (Neumaier compensated totals) | intensity × source-pixel-area | `NaN` |
| sum + `compensate` | sum result divided by `coverage` | extrapolated estimate, flagged | `NaN` (no coverage to divide by) |

* All arithmetic is IEEE-754 double precision; inputs are promoted to
  `Float64Array`. No 8-bit or float32 step exists in the numeric path.
* A constant field resamples to the same constant exactly, independent of
  grid alignment.
* Partial coverage is reported, not silently averaged away: the mean uses
  only usable samples and the missing fraction is visible in `coverage`.
* Conservation is claimed only when mode is `sum`, compensation is off, the
  extent covers the whole source, and the footprints partition the usable
  source area (`stats.integralConserved`).
* When no usable samples exist at all, summary scalars are reported as
  `NaN` (`sourceMean`, `outputMean`) or `null` (`validMin`, `validMax`) —
  never as `0` defaults.

## 4. Maintaining the contract

The same scenario definitions drive both the runnable examples and the
checks, so documentation artifacts and test evidence cannot drift apart.

```bash
npm run contract:example   # regenerate docs/contract/* (SVG + CSV + JSON + manifest)
npm run contract:check     # recompute via the production kernel and assert the contract
npm test                   # includes test/contract.test.js (scenarios + validator)
```

`tools/contract/scenarios.js` defines three scenarios with hand-computable
expectations and an independent overlap recomputation (a second
implementation that never calls the production engine):

1. **partial-missing** — a true zero, a masked non-zero, a NaN inside the
   mask and a normal finite pixel in one row; both output cells are at
   coverage 0.5.
2. **sparse-valid-region** — one usable pixel next to an entirely empty
   cell, exercising the sparse valid region: one finite half-covered cell
   and one `NaN` cell.
3. **all-missing** — every pixel unavailable through two different routes
   (masked and non-finite); every cell is `NaN` with zero coverage.

Each check prints the coverage amount (`totalOverlapArea`,
`sourceCoverage`) and the valid means (`sourceMean`, `outputMean`) as
execution evidence alongside per-cell intensity/coverage/weight.

## 5. Float sample validator

`tools/validate-float-samples.lib.js` (CLI: `npm run validate:samples -- DIR`)
validates a run's float artifacts against this contract. It fails hard
rather than substituting defaults:

* a missing file is an error — nothing is invented;
* an undefined cell must be `NaN` in `intensity.npy` with exactly zero
  coverage and zero weight (a written zero is rejected as zero-fill);
* `cells.csv` and the NPY arrays must agree at full precision, and
  `meta.json` counters must match the arrays;
* coverage stays in `[0,1]` and no defined cell has zero weight.

## 6. Runnable examples: one script, one provenance

`npm run contract:example` writes, per scenario, an SVG showing source
state / float field / coverage side by side, a full-precision CSV table,
and a JSON record of the exact same run. `manifest.json` stores a SHA-256
hash of every artifact, proving the image and the numeric table originated
from one script invocation. Generation is deterministic (no timestamps or
randomness), so a clean checkout reproduces byte-identical files.
