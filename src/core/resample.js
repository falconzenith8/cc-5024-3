// Area-weighted, mask-aware resampling for quantitative microscopy.
//
// Every input pixel is treated as a unit square [i, i+1) x [j, j+1) in
// "source pixel" coordinates. Each output cell has an axis-aligned footprint
// whose area is measured in the same unit. A source sample contributes with
// weight = overlap area between its unit square and the footprint.
//
// Missing data is never replaced by zero:
//   * a sample is usable only when mask[i] !== 0 AND Number.isFinite(value[i])
//   * coverage = (overlap area of usable samples) / (requested footprint area)
//   * an output cell with coverage === 0 gets value NaN, not 0
//   * a usable sample whose value is exactly 0 is a real measurement and
//     contributes weight to coverage with a zero value
//
// Two dimensional semantics are supported and kept distinct:
//   * "mean" -> area-weighted mean of usable samples (intensity units)
//   * "sum"  -> sum of usable sample * overlap area (intensity * source-pixel-area)
// The raw overlap sum is always retained so totals can be audited.

export const ALGORITHM = {
  name: 'area-weighted-mask-aware',
  version: '1.0.0',
};

const EPS = 1e-12;

function assertInteger(name, v, min) {
  if (!Number.isInteger(v) || v < min) {
    throw new RangeError(`${name} must be an integer >= ${min}, got ${v}`);
  }
}

/**
 * @param {object} opts
 * @param {ArrayLike<number>} opts.values row-major source values
 * @param {number} opts.width
 * @param {number} opts.height
 * @param {ArrayLike<number>|null} [opts.mask] row-major 0/1 validity, same shape
 * @param {{width:number,height:number,extent?:[number,number,number,number]}} opts.grid
 * @param {'mean'|'sum'} [opts.mode='mean']
 * @param {boolean} [opts.compensate=false] sum mode only: divide by coverage
 * @param {number} [opts.sourcePixelArea=1] scalar physical area of one source pixel
 * @param {number} [opts.lowCoverageThreshold=0.5]
 */
export function resample(opts) {
  const {
    values,
    width,
    height,
    mask = null,
    grid,
    mode = 'mean',
    compensate = false,
    sourcePixelArea = 1,
    lowCoverageThreshold = 0.5,
  } = opts || {};

  if (!values) throw new Error('values is required');
  assertInteger('width', width, 1);
  assertInteger('height', height, 1);
  if (values.length !== width * height) {
    throw new Error(`values length ${values.length} != ${width}*${height}`);
  }
  if (mask && mask.length !== values.length) {
    throw new Error(`mask length ${mask.length} != values length ${values.length}`);
  }
  if (mode !== 'mean' && mode !== 'sum') {
    throw new Error(`mode must be "mean" or "sum", got ${mode}`);
  }
  if (compensate && mode !== 'sum') {
    throw new Error('compensate is only meaningful for mode="sum"');
  }
  assertInteger('grid.width', grid && grid.width, 1);
  assertInteger('grid.height', grid && grid.height, 1);
  if (!(sourcePixelArea > 0) || !Number.isFinite(sourcePixelArea)) {
    throw new Error('sourcePixelArea must be a finite positive number');
  }

  const extent = grid.extent
    ? grid.extent.slice()
    : [0, 0, width, height];
  for (const e of extent) {
    if (!Number.isFinite(e)) throw new Error('grid.extent values must be finite');
  }
  if (!(extent[2] > extent[0]) || !(extent[3] > extent[1])) {
    throw new Error('grid.extent must satisfy x1>x0 and y1>y0');
  }

  const outW = grid.width;
  const outH = grid.height;
  const nOut = outW * outH;
  const scaleX = (extent[2] - extent[0]) / outW;
  const scaleY = (extent[3] - extent[1]) / outH;
  const footprintArea = scaleX * scaleY;

  const intensity = new Float64Array(nOut); // final requested quantity
  const coverage = new Float64Array(nOut);
  const validWeight = new Float64Array(nOut); // in source-pixel-area units
  const overlapSum = new Float64Array(nOut); // sum(weight * value), usable only
  const minX = new Int32Array(nOut);
  const minY = new Int32Array(nOut);
  const maxX = new Int32Array(nOut);
  const maxY = new Int32Array(nOut);
  const defined = new Uint8Array(nOut);
  minX.fill(-1);
  minY.fill(-1);
  maxX.fill(-1);
  maxY.fill(-1);

  const valueAt = (x, y) => values[y * width + x];
  const usableAt = (x, y) => {
    if (mask && mask[y * width + x] === 0) return false;
    return Number.isFinite(values[y * width + x]);
  };
  let overflowCells = 0;

  for (let oy = 0; oy < outH; oy++) {
    const sy0 = extent[1] + oy * scaleY;
    const sy1 = sy0 + scaleY;
    const iy0 = Math.max(0, Math.floor(sy0 + EPS));
    const iy1 = Math.min(height - 1, Math.ceil(sy1 - EPS) - 1);
    for (let ox = 0; ox < outW; ox++) {
      const sx0 = extent[0] + ox * scaleX;
      const sx1 = sx0 + scaleX;
      const ix0 = Math.max(0, Math.floor(sx0 + EPS));
      const ix1 = Math.min(width - 1, Math.ceil(sx1 - EPS) - 1);
      const idx = oy * outW + ox;
      let wSum = 0;
      let wComp = 0;
      let vw = 0;
      let vwComp = 0;
      // Running weighted mean (West's algorithm). It is algebraically equal to
      // vw/wSum but preserves a constant field exactly and cannot overflow on
      // a large first sample, unlike a naive sum of weighted values.
      let mean = 0;
      let meanWeight = 0;
      let firstSeen = true;
      for (let iy = iy0; iy <= iy1; iy++) {
        const oyOverlap = Math.min(sy1, iy + 1) - Math.max(sy0, iy);
        if (!(oyOverlap > 0)) continue;
        for (let ix = ix0; ix <= ix1; ix++) {
          const oxOverlap = Math.min(sx1, ix + 1) - Math.max(sx0, ix);
          if (!(oxOverlap > 0)) continue;
          const w = oxOverlap * oyOverlap;
          if (usableAt(ix, iy)) {
            const v = valueAt(ix, iy);
            // Neumaier compensated summation for the audit totals.
            const s = wSum + w;
            wComp += Math.abs(wSum) >= Math.abs(w) ? (wSum - s) + w : (w - s) + wSum;
            wSum = s;
            const p = w * v;
            const sv = vw + p;
            vwComp += Math.abs(vw) >= Math.abs(p) ? (vw - sv) + p : (p - sv) + vw;
            vw = sv;
            if (meanWeight === 0) {
              mean = v;
              meanWeight = w;
            } else {
              const nextWeight = meanWeight + w;
              mean += (v - mean) * (w / nextWeight);
              meanWeight = nextWeight;
            }
            if (firstSeen) {
              minX[idx] = ix;
              maxX[idx] = ix;
              minY[idx] = iy;
              maxY[idx] = iy;
              firstSeen = false;
            } else {
              if (ix < minX[idx]) minX[idx] = ix;
              if (ix > maxX[idx]) maxX[idx] = ix;
              if (iy < minY[idx]) minY[idx] = iy;
              if (iy > maxY[idx]) maxY[idx] = iy;
            }
          }
        }
      }
      wSum += wComp;
      vw += vwComp;
      validWeight[idx] = wSum;
      overlapSum[idx] = vw;
      coverage[idx] = Math.min(1, wSum / footprintArea);
      if (wSum > 0) {
        defined[idx] = 1;
        let v;
        if (mode === 'mean') {
          v = mean;
        } else {
          v = vw * sourcePixelArea;
          if (compensate) v = v / coverage[idx];
        }
        intensity[idx] = v;
        if (!Number.isFinite(v)) overflowCells++;
      } else {
        intensity[idx] = NaN;
      }
    }
  }

  // ---- source audit -------------------------------------------------------
  let validPixels = 0;
  let maskedNonFinite = 0;
  let excludedNonZero = 0;
  let excludedNonFinite = 0;
  let validTrueZeros = 0;
  let validSum = 0;
  let finitePixels = 0;
  let minValid = Infinity;
  let maxValid = -Infinity;
  let minFinite = Infinity;
  let maxFinite = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const finite = Number.isFinite(v);
    if (finite) {
      finitePixels++;
      if (v < minFinite) minFinite = v;
      if (v > maxFinite) maxFinite = v;
    }
    const m = !mask || mask[i] !== 0;
    if (m && finite) {
      validPixels++;
      validSum += v;
      if (v === 0) validTrueZeros++;
      if (v < minValid) minValid = v;
      if (v > maxValid) maxValid = v;
    } else if (m && !finite) {
      maskedNonFinite++;
    } else if (!m && finite) {
      if (v !== 0) excludedNonZero++;
    } else {
      excludedNonFinite++;
    }
  }
  const sourcePixels = width * height;
  const sourceValidArea = validPixels; // unit-square pixels
  const missingPixels = sourcePixels - validPixels;

  // Total overlap weight collected over usable source samples, divided by the
  // usable source area, tells whether the output footprints partition the
  // usable sample set. Only then is an integral additive/conserved.
  let totalOverlap = 0;
  for (let i = 0; i < nOut; i++) totalOverlap += validWeight[i];
  const sourceCoverage = sourceValidArea > 0 ? Math.min(1, totalOverlap / sourceValidArea) : 0;

  let outSum = 0;
  let outMeanNumer = 0;
  let outMeanDenom = 0;
  let undefinedCells = 0;
  let lowCoverageCells = 0;
  let fullyCoveredCells = 0;
  for (let i = 0; i < nOut; i++) {
    outSum += overlapSum[i];
    outMeanNumer += overlapSum[i];
    outMeanDenom += validWeight[i];
    if (defined[i] === 0) undefinedCells++;
    else if (coverage[i] >= 1 - 1e-9) fullyCoveredCells++;
    if (coverage[i] < lowCoverageThreshold) lowCoverageCells++;
  }

  const sourceMean = validPixels > 0 ? validSum / validPixels : NaN;
  const outputMean = outMeanDenom > 0 ? outMeanNumer / outMeanDenom : NaN;
  const extentCoversSource =
    Math.abs(extent[0]) <= 1e-9 && Math.abs(extent[1]) <= 1e-9 &&
    Math.abs(extent[2] - width) <= 1e-9 && Math.abs(extent[3] - height) <= 1e-9;
  const partition = extentCoversSource && Math.abs(sourceCoverage - 1) <= 1e-9;

  const anomalies = [];
  if (validPixels === 0) {
    anomalies.push({
      code: 'NO_VALID_SAMPLES',
      severity: 'error',
      message: 'No usable samples: every source pixel is masked out or non-finite.',
    });
  }
  if (maskedNonFinite > 0) {
    anomalies.push({
      code: 'NONFINITE_MARKED_VALID',
      severity: 'warning',
      message: `${maskedNonFinite} masked-in source pixel(s) hold NaN/Infinity and were treated as missing.`,
    });
  }
  if (excludedNonZero > 0) {
    anomalies.push({
      code: 'NONZERO_MASKED_OUT',
      severity: 'info',
      message: `${excludedNonZero} non-zero source pixel(s) are masked out and excluded from all statistics.`,
    });
  }
  if (undefinedCells > 0) {
    anomalies.push({
      code: 'UNDEFINED_OUTPUT_CELLS',
      severity: 'warning',
      message: `${undefinedCells} output cell(s) have no usable overlap and are NaN (not zero).`,
    });
  }
  if (lowCoverageCells > 0) {
    anomalies.push({
      code: 'LOW_COVERAGE',
      severity: 'warning',
      message: `${lowCoverageCells} output cell(s) have coverage below ${lowCoverageThreshold}.`,
    });
  }
  if (!partition && mode === 'sum' && sourceValidArea > 0) {
    anomalies.push({
      code: 'NON_PARTITIONING_GRID',
      severity: 'warning',
      message:
        `Output footprints collect ${(sourceCoverage * 100).toFixed(3)}% of the usable source area; ` +
        'the reported integral is partial and must not be described as conserved.',
    });
  }
  if (compensate) {
    anomalies.push({
      code: 'COVERAGE_COMPENSATED_ESTIMATE',
      severity: 'info',
      message:
        'Integral values were divided by coverage: this is an extrapolated estimate, not a conserved total.',
    });
  }
  if (overflowCells > 0) {
    anomalies.push({
      code: 'OUTPUT_OVERFLOW',
      severity: 'error',
      message: `${overflowCells} output cell(s) overflowed to Infinity while applying the selected area semantics.`,
    });
  }

  return {
    width: outW,
    height: outH,
    mode,
    compensate,
    quantity: mode === 'mean' ? 'intensity' : 'integral',
    quantityUnits:
      mode === 'mean'
        ? 'source intensity units (area-weighted mean of usable samples)'
        : `source intensity x source-pixel-area (x ${sourcePixelArea} physical area units)`,
    intensity,
    coverage,
    validWeight,
    overlapSum,
    defined,
    footprintArea,
    extent,
    scaleX,
    scaleY,
    sourcePixelArea,
    provenance: {
      minX,
      minY,
      maxX,
      maxY,
    },
    stats: {
      sourceWidth: width,
      sourceHeight: height,
      sourcePixels,
      validPixels,
      missingPixels,
      validTrueZeros,
      maskedNonFinite,
      excludedNonZero,
      excludedNonFinite,
      finitePixels,
      validMin: validPixels > 0 ? minValid : null,
      validMax: validPixels > 0 ? maxValid : null,
      finiteMin: finitePixels > 0 ? minFinite : null,
      finiteMax: finitePixels > 0 ? maxFinite : null,
      sourceMean,
      sourceValidSum: validSum,
      outputMean,
      outputOverlapSum: outSum,
      outputIntegral: mode === 'sum' ? outSum * sourcePixelArea : null,
      totalOverlapArea: totalOverlap,
      sourceValidArea,
      sourceCoverage,
      partitionsUsableSource: partition,
      outputCells: nOut,
      undefinedCells,
      lowCoverageCells,
      fullyCoveredCells,
      lowCoverageThreshold,
      footprintArea,
      integralConserved:
        mode === 'sum' && !compensate && partition && sourceValidArea > 0,
    },
    anomalies,
    algorithm: ALGORITHM,
  };
}
