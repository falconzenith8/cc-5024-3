// Independent reference implementations used only by tests.
//
// referenceResampleExact(): scatters each source pixel's unit square into every
// output cell it overlaps. This is a different loop orientation from the
// production code (which gathers per output cell), so a shared edge/weight bug
// is unlikely to cancel out. It is exact in the same unit-square model.
//
// referenceResample(): dense quadrature used for an extra smooth-field sanity
// check. Its accuracy is O(1/N) at mask boundaries, so tests allow a looser
// tolerance for it.

export function referenceResampleExact({
  values, width, height, mask = null, outWidth, outHeight,
  extent = [0, 0, width, height], mode = 'mean', sourcePixelArea = 1,
}) {
  const [ex0, ey0, ex1, ey1] = extent;
  const sx = (ex1 - ex0) / outWidth;
  const sy = (ey1 - ey0) / outHeight;
  const footprint = sx * sy;
  const intensity = new Float64Array(outWidth * outHeight).fill(NaN);
  const coverage = new Float64Array(outWidth * outHeight);
  const wsum = new Float64Array(outWidth * outHeight);
  const vwsum = new Float64Array(outWidth * outHeight);
  const EPS = 1e-12;

  for (let iy = height - 1; iy >= 0; iy--) {
    // Which output rows can this pixel touch?
    const rawOy0 = Math.floor((iy - ey0) / sy);
    const rawOy1 = Math.ceil((iy + 1 - ey0) / sy) - 1;
    const oy0 = Math.max(0, Math.min(outHeight - 1, rawOy0));
    const oy1 = Math.max(0, Math.min(outHeight - 1, rawOy1));
    for (let ix = width - 1; ix >= 0; ix--) {
      const p = iy * width + ix;
      const usable = (!mask || mask[p] !== 0) && Number.isFinite(values[p]);
      if (!usable) continue;
      const rawOx0 = Math.floor((ix - ex0) / sx);
      const rawOx1 = Math.ceil((ix + 1 - ex0) / sx) - 1;
      const ox0 = Math.max(0, Math.min(outWidth - 1, rawOx0));
      const ox1 = Math.max(0, Math.min(outWidth - 1, rawOx1));
      for (let oy = oy0; oy <= oy1; oy++) {
        const cy0 = ey0 + oy * sy;
        const cy1 = cy0 + sy;
        const oyOverlap = Math.min(cy1, iy + 1) - Math.max(cy0, iy);
        if (!(oyOverlap > EPS)) continue;
        for (let ox = ox0; ox <= ox1; ox++) {
          const cx0 = ex0 + ox * sx;
          const cx1 = cx0 + sx;
          const oxOverlap = Math.min(cx1, ix + 1) - Math.max(cx0, ix);
          if (!(oxOverlap > EPS)) continue;
          const w = oxOverlap * oyOverlap;
          const o = oy * outWidth + ox;
          wsum[o] += w;
          vwsum[o] += w * values[p];
        }
      }
    }
  }

  for (let i = 0; i < intensity.length; i++) {
    coverage[i] = Math.min(1, wsum[i] / footprint);
    if (wsum[i] > 0) {
      intensity[i] = mode === 'mean'
        ? vwsum[i] / wsum[i]
        : vwsum[i] * sourcePixelArea;
    }
  }
  return { intensity, coverage };
}

export function referenceResample({
  values, width, height, mask = null, outWidth, outHeight,
  extent = [0, 0, width, height], mode = 'mean', subSamples = 64,
}) {
  const [x0, y0, x1, y1] = extent;
  const stepX = (x1 - x0) / outWidth;
  const stepY = (y1 - y0) / outHeight;
  const intensity = new Float64Array(outWidth * outHeight);
  const coverage = new Float64Array(outWidth * outHeight);
  const cellW = stepX / subSamples;
  const cellH = stepY / subSamples;
  for (let oy = 0; oy < outHeight; oy++) {
    for (let ox = 0; ox < outWidth; ox++) {
      let wSum = 0;
      let vw = 0;
      for (let syi = 0; syi < subSamples; syi++) {
        const py = y0 + oy * stepY + (syi + 0.5) * cellH;
        const iy = Math.floor(py);
        if (iy < 0 || iy >= height) continue;
        for (let sxi = 0; sxi < subSamples; sxi++) {
          const px = x0 + ox * stepX + (sxi + 0.5) * cellW;
          const ix = Math.floor(px);
          if (ix < 0 || ix >= width) continue;
          const idx = iy * width + ix;
          const usable = (!mask || mask[idx] !== 0) && Number.isFinite(values[idx]);
          if (usable) {
            wSum += cellW * cellH;
            vw += cellW * cellH * values[idx];
          }
        }
      }
      const footprint = stepX * stepY;
      const i = oy * outWidth + ox;
      coverage[i] = Math.min(1, wSum / footprint);
      intensity[i] = wSum > 0 ? (mode === 'mean' ? vw / wSum : vw) : NaN;
    }
  }
  return { intensity, coverage };
}

export function maxAbsDiff(a, b) {
  if (a.length !== b.length) throw new Error('length mismatch');
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const an = Number.isNaN(a[i]);
    const bn = Number.isNaN(b[i]);
    if (an && bn) continue;
    if (an !== bn) return Infinity;
    const d = Math.abs(a[i] - b[i]);
    if (d > m) m = d;
  }
  return m;
}

export function maxRelDiff(a, b, floor = 1e-12) {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    if (Number.isNaN(a[i]) && Number.isNaN(b[i])) continue;
    const scale = Math.max(Math.abs(a[i]), Math.abs(b[i]), floor);
    const d = Math.abs(a[i] - b[i]) / scale;
    if (d > m) m = d;
  }
  return m;
}
