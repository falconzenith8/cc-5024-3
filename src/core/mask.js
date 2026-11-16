// Mask helpers: creation, import validation and source→output coverage
// projection for the "effective area" selection layer.

export const MASK_STATE = {
  VALID: 255,
  INVALID: 0,
};

/** Create a mask filled with 1 (everything usable). */
export function createMask(width, height, value = 1) {
  const m = new Uint8Array(width * height);
  if (value) m.fill(value ? 1 : 0);
  return m;
}

/** Derive a mask from finite values: 1 where finite, 0 where NaN/Inf. */
export function maskFromFinite(values) {
  const m = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) m[i] = Number.isFinite(values[i]) ? 1 : 0;
  return m;
}

/**
 * Build a mask from a geometric predicate on pixel centres.
 * shapes: [{type:'rect',x0,y0,x1,y1}, {type:'ellipse',cx,cy,rx,ry}, {type:'invert'}]
 */
export function maskFromShapes(width, height, shapes) {
  const mask = new Uint8Array(width * height);
  mask.fill(1);
  for (const shape of shapes) {
    if (shape.type === 'rect') {
      const x0 = Math.max(0, Math.floor(Math.min(shape.x0, shape.x1)));
      const x1 = Math.min(width, Math.ceil(Math.max(shape.x0, shape.x1)));
      const y0 = Math.max(0, Math.floor(Math.min(shape.y0, shape.y1)));
      const y1 = Math.min(height, Math.ceil(Math.max(shape.y0, shape.y1)));
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) mask[y * width + x] = 0;
      }
    } else if (shape.type === 'ellipse') {
      const { cx, cy, rx, ry } = shape;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (x + 0.5 >= cx - rx && x + 0.5 <= cx + rx &&
              y + 0.5 >= cy - ry && y + 0.5 <= cy + ry) {
            const nx = (x + 0.5 - cx) / rx;
            const ny = (y + 0.5 - cy) / ry;
            if (nx * nx + ny * ny <= 1) mask[y * width + x] = 0;
          }
        }
      }
    } else if (shape.type === 'invert') {
      for (let i = 0; i < mask.length; i++) mask[i] = mask[i] ? 0 : 1;
    } else {
      throw new Error(`Unknown mask shape: ${shape.type}`);
    }
  }
  return mask;
}

/**
 * Project a source mask onto the output grid: per output cell, the area
 * fraction of usable (mask!==0 AND finite value) source samples.
 * Uses the same area-weighting as resample().
 */
export function projectCoverage({ mask, values, width, height, result }) {
  const { width: outW, height: outH, extent, scaleX, scaleY, footprintArea } = result;
  const out = new Float64Array(outW * outH);
  const EPS = 1e-12;
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
      let area = 0;
      for (let iy = iy0; iy <= iy1; iy++) {
        const oyO = Math.min(sy1, iy + 1) - Math.max(sy0, iy);
        if (!(oyO > 0)) continue;
        for (let ix = ix0; ix <= ix1; ix++) {
          const oxO = Math.min(sx1, ix + 1) - Math.max(sx0, ix);
          if (!(oxO > 0)) continue;
          const s = iy * width + ix;
          if (mask[s] !== 0 && Number.isFinite(values[s])) area += oxO * oyO;
        }
      }
      out[oy * outW + ox] = Math.min(1, area / footprintArea);
    }
  }
  return out;
}

/** Count mask statistics. */
export function maskStats(mask) {
  let valid = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] !== 0) valid++;
  return { valid, invalid: mask.length - valid, total: mask.length };
}
