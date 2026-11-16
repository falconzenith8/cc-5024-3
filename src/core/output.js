// Output serialization shared by CLI and browser (downloads). All numeric
// fields are written at full float precision; no 8-bit values are emitted.

import { writeNpy } from './npy.js';

export function formatNumber(v, precision = 17) {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'number') return String(v);
  if (Number.isNaN(v)) return 'nan';
  if (v === Infinity) return 'inf';
  if (v === -Infinity) return '-inf';
  if (v === 0) return '0';
  return Number(v.toPrecision(precision)).toString();
}

/** Per-cell CSV (long format), full precision. */
export function resultToCsv(result, opts = {}) {
  const { includeOverlapSum = true } = opts;
  const { width, height } = result;
  const lines = [];
  const head = ['x', 'y', 'intensity', 'coverage', 'valid_weight', 'defined'];
  if (includeOverlapSum) head.push('overlap_sum');
  head.push('src_x_min', 'src_x_max', 'src_y_min', 'src_y_max');
  lines.push(head.join(','));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const row = [
        x,
        y,
        formatNumber(result.intensity[i]),
        formatNumber(result.coverage[i]),
        formatNumber(result.validWeight[i]),
        result.defined[i] ? 1 : 0,
      ];
      if (includeOverlapSum) row.push(formatNumber(result.overlapSum[i]));
      row.push(
        result.provenance.minX[i],
        result.provenance.maxX[i],
        result.provenance.minY[i],
        result.provenance.maxY[i],
      );
      lines.push(row.join(','));
    }
  }
  return lines.join('\n') + '\n';
}

export function resultToJson(result, extra = {}) {
  return JSON.stringify(describeForJson(result, extra), null, 2);
}

function describeForJson(result, extra) {
  return {
    format: 'quantitative-float-resample/v1',
    algorithm: result.algorithm,
    grid: {
      width: result.width,
      height: result.height,
      extent: result.extent,
      scaleX: result.scaleX,
      scaleY: result.scaleY,
      footprintArea: result.footprintArea,
    },
    semantics: {
      mode: result.mode,
      compensate: result.compensate,
      quantity: result.quantity,
      quantityUnits: result.quantityUnits,
      sourcePixelArea: result.sourcePixelArea,
      note:
        result.mode === 'mean'
          ? 'Values are area-weighted means of usable samples. They are intensities, not totals.'
          : 'Values are overlaps summed with usable sample values and scaled by source pixel area. Totals are only additive when partitionsUsableSource is true and compensate is false.',
    },
    stats: result.stats,
    anomalies: result.anomalies,
    ...extra,
  };
}

export function intensityNpy(result, dtype = 'float64') {
  return writeNpy(result.intensity, result.width, result.height, dtype);
}

export function coverageNpy(result, dtype = 'float64') {
  return writeNpy(result.coverage, result.width, result.height, dtype);
}

export function validWeightNpy(result, dtype = 'float64') {
  return writeNpy(result.validWeight, result.width, result.height, dtype);
}
