// Display-only contrast mapping. The 8-bit RGBA produced here is NEVER a
// quantitative result: it exists purely so humans can see the float field.
// Every quantitative consumer must read the float arrays instead.

/**
 * Compute robust display limits over usable samples only.
 * @param {ArrayLike<number>} values
 * @param {ArrayLike<number>|null} mask
 * @param {{ lowPercentile?: number, highPercentile?: number }} opts
 * @returns {{ min:number, max:number, method:string, sampleCount:number,
 *            lowPercentile:number, highPercentile:number, finiteMissing:number }}
 */
export function computeDisplayLimits(values, mask = null, opts = {}) {
  const { lowPercentile = 0, highPercentile = 100 } = opts;
  if (!(lowPercentile >= 0 && lowPercentile <= 100)) throw new Error('lowPercentile must be 0..100');
  if (!(highPercentile >= 0 && highPercentile <= 100)) throw new Error('highPercentile must be 0..100');
  if (highPercentile < lowPercentile) throw new Error('highPercentile must be >= lowPercentile');

  const samples = [];
  for (let i = 0; i < values.length; i++) {
    if (mask && mask[i] === 0) continue;
    const v = values[i];
    if (Number.isFinite(v)) samples.push(v);
  }
  if (samples.length === 0) {
    return {
      min: 0, max: 1, method: 'empty-fallback', sampleCount: 0,
      lowPercentile, highPercentile, finiteMissing: values.length,
    };
  }
  samples.sort((a, b) => a - b);
  const lo = percentileSorted(samples, lowPercentile);
  const hi = percentileSorted(samples, highPercentile);
  let min = lo;
  let max = hi;
  if (!(max > min)) {
    // Degenerate range (constant field): widen symmetrically so the display is
    // mid-grey rather than a divide-by-zero. Data is untouched.
    const center = min;
    const pad = Math.abs(center) > 0 ? Math.abs(center) * 1e-6 : 0.5;
    min = center - pad;
    max = center + pad;
  }
  return {
    min,
    max,
    method: lowPercentile === 0 && highPercentile === 100 ? 'min-max-valid' : 'percentile-valid',
    sampleCount: samples.length,
    lowPercentile,
    highPercentile,
    finiteMissing: values.length - samples.length,
  };
}

function percentileSorted(sorted, p) {
  if (sorted.length === 1) return sorted[0];
  const pos = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  const t = pos - lo;
  return sorted[lo] * (1 - t) + sorted[hi] * t;
}

/**
 * Map a float field to RGBA for display only.
 * Missing (NaN) cells are transparent; the coverage/validity layer decides
 * what colour is drawn underneath them.
 * @returns {{ rgba: Uint8ClampedArray, limits: object }}
 */
export function mapFloatFieldToRgba(values, mask, limits, opts = {}) {
  const {
    palette = 'gray',
    scale = 'linear',
    gamma = 0.45,
    clamp = true,
  } = opts;
  const n = values.length;
  const rgba = new Uint8ClampedArray(n * 4);
  const { min, max } = limits;
  const span = max - min;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    const maskedOut = mask && mask[i] === 0;
    if (!Number.isFinite(v) || maskedOut) {
      rgba[i * 4 + 3] = 0;
      continue;
    }
    let t = span > 0 ? (v - min) / span : 0.5;
    if (clamp) t = t < 0 ? 0 : t > 1 ? 1 : t;
    if (scale === 'log') {
      const lo = min > 0 ? Math.log10(min) : 0;
      const hi = max > 0 ? Math.log10(max) : 1;
      const cur = v > 0 ? Math.log10(v) : lo;
      t = hi > lo ? (cur - lo) / (hi - lo) : 0.5;
      if (clamp) t = t < 0 ? 0 : t > 1 ? 1 : t;
    } else if (scale === 'gamma') {
      t = Math.pow(t, gamma);
    }
    const [r, g, b] = paletteColor(palette, t);
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = 255;
  }
  return { rgba, limits };
}

function paletteColor(palette, t) {
  if (palette === 'inferno') {
    // Compact approximation of the inferno colormap.
    const stops = [
      [0, 0, 4], [22, 11, 57], [66, 10, 104], [106, 23, 110],
      [147, 38, 103], [188, 55, 84], [221, 81, 58], [243, 120, 25],
      [252, 165, 10], [246, 215, 70], [252, 255, 164],
    ];
    return sampleStops(stops, t);
  }
  if (palette === 'viridis') {
    const stops = [
      [68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142],
      [38, 130, 142], [31, 158, 137], [53, 183, 121], [109, 205, 89],
      [180, 222, 44], [253, 231, 37],
    ];
    return sampleStops(stops, t);
  }
  const g = Math.round(t * 255);
  return [g, g, g];
}

function sampleStops(stops, t) {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const pos = clamped * (stops.length - 1);
  const i = Math.floor(pos);
  const j = Math.min(stops.length - 1, i + 1);
  const f = pos - i;
  const a = stops[i];
  const b = stops[j];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

/**
 * Coverage layer: 0 -> transparent, low -> red, 1 -> green. Display only.
 */
export function mapCoverageToRgba(coverage, defined, opts = {}) {
  const { lowCoverageThreshold = 0.5 } = opts;
  const n = coverage.length;
  const rgba = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    if (defined && defined[i] === 0) {
      // Undefined (no usable overlap) is visually distinct from zero coverage.
      rgba[i * 4] = 120;
      rgba[i * 4 + 1] = 96;
      rgba[i * 4 + 2] = 160;
      rgba[i * 4 + 3] = 235;
      continue;
    }
    const c = coverage[i];
    // red (low) -> yellow -> green (full)
    let r;
    let g;
    if (c < lowCoverageThreshold) {
      const t = lowCoverageThreshold > 0 ? c / lowCoverageThreshold : 0;
      r = 220;
      g = Math.round(60 + t * 120);
    } else {
      const t = (c - lowCoverageThreshold) / Math.max(1e-9, 1 - lowCoverageThreshold);
      r = Math.round(220 - t * 180);
      g = Math.round(180 + t * 55);
    }
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = 40;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}
