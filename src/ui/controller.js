// Shared UI state + controller logic, kept free of DOM specifics so it can be
// exercised from Node tests. index.html wires this to real elements.

import { resample } from '../core/resample.js';
import { computeDisplayLimits, mapFloatFieldToRgba, mapCoverageToRgba } from '../core/display.js';
import { projectCoverage, maskStats, createMask } from '../core/mask.js';

export function createState() {
  return {
    image: null, // {values, width, height, sourceName, dtype, dtypeKind}
    mask: null, // Uint8Array of 0/1, same shape as image
    maskLabel: 'all valid',
    grid: { width: 0, height: 0, extent: null },
    mode: 'mean',
    compensate: false,
    pixelArea: 1,
    lowCoverage: 0.5,
    display: { palette: 'gray', scale: 'linear', lowPercentile: 0, highPercentile: 100 },
    result: null,
    error: null,
  };
}

/** Load a parsed image into state, resetting mask/grid to fit. */
export function setImage(state, parsed) {
  state.image = {
    values: Float64Array.from(parsed.data),
    width: parsed.width,
    height: parsed.height,
    sourceName: parsed.sourceName || 'image',
    dtype: parsed.dtype || 'unknown',
    dtypeKind: parsed.dtypeKind || 'unknown',
  };
  state.mask = createMask(parsed.width, parsed.height, 1);
  state.maskLabel = 'all valid';
  state.grid = { width: parsed.width, height: parsed.height, extent: null };
  state.result = null;
  state.error = null;
  return state;
}

export function setMask(state, mask, label) {
  if (!state.image) throw new Error('Load an image before setting a mask');
  if (mask.length !== state.image.width * state.image.height) {
    throw new Error('Mask shape does not match the image');
  }
  state.mask = mask;
  state.maskLabel = label || 'custom';
  state.result = null;
}

export function validateSettings(state) {
  const errs = [];
  if (!state.image) errs.push('No image loaded');
  if (!Number.isInteger(state.grid.width) || state.grid.width < 1) errs.push('grid width must be an integer >= 1');
  if (!Number.isInteger(state.grid.height) || state.grid.height < 1) errs.push('grid height must be an integer >= 1');
  if (state.grid.extent) {
    const [x0, y0, x1, y1] = state.grid.extent;
    if (![x0, y0, x1, y1].every(Number.isFinite)) errs.push('extent values must be finite');
    else if (!(x1 > x0) || !(y1 > y0)) errs.push('extent must satisfy x1>x0 and y1>y0');
  }
  if (!(state.pixelArea > 0) || !Number.isFinite(state.pixelArea)) errs.push('pixel area must be positive');
  if (!(state.lowCoverage >= 0 && state.lowCoverage <= 1)) errs.push('low-coverage threshold must be 0..1');
  if (state.compensate && state.mode !== 'sum') errs.push('compensate requires sum mode');
  return errs;
}

/** Run resampling. Throws no exceptions for expected anomalies: they are data. */
export function runResample(state) {
  const errs = validateSettings(state);
  if (errs.length > 0) {
    state.result = null;
    state.error = errs.join('; ');
    return { ok: false, errors: errs };
  }
  state.error = null;
  const { image } = state;
  const result = resample({
    values: image.values,
    mask: state.mask,
    width: image.width,
    height: image.height,
    grid: {
      width: state.grid.width,
      height: state.grid.height,
      extent: state.grid.extent || undefined,
    },
    mode: state.mode,
    compensate: state.compensate,
    sourcePixelArea: state.pixelArea,
    lowCoverageThreshold: state.lowCoverage,
  });
  state.result = result;
  return { ok: true, result };
}

/** Build display RGBA buffers for the float field and coverage layer. */
export function buildDisplay(state, canvasWidth, canvasHeight) {
  if (!state.result) return null;
  const r = state.result;
  const limits = computeDisplayLimits(r.intensity, r.defined, {
    lowPercentile: state.display.lowPercentile,
    highPercentile: state.display.highPercentile,
  });
  const field = mapFloatFieldToRgba(r.intensity, r.defined, limits, {
    palette: state.display.palette,
    scale: state.display.scale,
  });
  const cov = mapCoverageToRgba(r.coverage, r.defined, {
    lowCoverageThreshold: state.lowCoverage,
  });
  return { field: field.rgba, coverage: cov, limits, width: r.width, height: r.height };
}

/** Source-mask coverage projected onto the output grid (for the overlay). */
export function projectedCoverage(state) {
  if (!state.result) return null;
  return projectCoverage({
    mask: state.mask,
    values: state.image.values,
    width: state.image.width,
    height: state.image.height,
    result: state.result,
  });
}

/** Per-cell inspector values. */
export function inspectCell(state, x, y) {
  const r = state.result;
  if (!r || x < 0 || y < 0 || x >= r.width || y >= r.height) return null;
  const i = y * r.width + x;
  return {
    x,
    y,
    intensity: r.intensity[i],
    coverage: r.coverage[i],
    validWeight: r.validWeight[i],
    overlapSum: r.overlapSum[i],
    defined: r.defined[i] === 1,
    sourceBounds: {
      xMin: r.provenance.minX[i],
      xMax: r.provenance.maxX[i],
      yMin: r.provenance.minY[i],
      yMax: r.provenance.maxY[i],
    },
    weightSemantics: r.mode === 'mean' ? 'intensity' : 'integral',
  };
}

export { maskStats, projectCoverage };
