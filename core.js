export const PENALTY = 1000000;
export function validateImage(image) {
  if (
    !image ||
    !Number.isInteger(image.width) ||
    !Number.isInteger(image.height) ||
    image.width < 1 ||
    image.height < 1 ||
    image.width > 256 ||
    image.height > 256
  )
    throw Error('Image dimensions must be integers from 1 to 256.');
  const size = image.width * image.height;
  if (
    !(Array.isArray(image.pixels) || image.pixels instanceof Uint8ClampedArray) ||
    image.pixels.length !== size * 4
  )
    throw Error('Provide exactly four RGBA bytes per pixel.');
  if (
    !(Array.isArray(image.mask) || image.mask instanceof Uint8Array) ||
    image.mask.length !== size
  )
    throw Error('Provide one protection-mask value per pixel.');
  for (let i = 0; i < image.pixels.length; i++)
    if (
      !Number.isInteger(image.pixels[i]) ||
      image.pixels[i] < 0 ||
      image.pixels[i] > 255 ||
      (i % 4 === 3 && image.pixels[i] !== 255)
    )
      throw Error('Pixels must be opaque RGBA bytes; flatten transparency first.');
  for (const value of image.mask)
    if (value !== 0 && value !== 1) throw Error('Mask values must be zero or one.');
  return {
    width: image.width,
    height: image.height,
    pixels: new Uint8ClampedArray(image.pixels),
    mask: new Uint8Array(image.mask),
  };
}
export function energy(image) {
  const { width: w, height: h, pixels: p } = image,
    out = new Float64Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let sum = 0;
      const l = (y * w + Math.max(0, x - 1)) * 4,
        r = (y * w + Math.min(w - 1, x + 1)) * 4,
        u = (Math.max(0, y - 1) * w + x) * 4,
        d = (Math.min(h - 1, y + 1) * w + x) * 4;
      for (let c = 0; c < 3; c++) sum += (p[r + c] - p[l + c]) ** 2 + (p[d + c] - p[u + c]) ** 2;
      out[y * w + x] = Math.sqrt(sum);
    }
  return out;
}
export function minimumSeam(cost, width, height) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 256 ||
    height > 256 ||
    cost.length !== width * height ||
    [...cost].some((x) => !Number.isFinite(x))
  )
    throw Error('Invalid seam cost grid.');
  let previous = Float64Array.from(cost.slice(0, width));
  const parents = new Int16Array(width * height);
  for (let y = 1; y < height; y++) {
    const next = new Float64Array(width);
    for (let x = 0; x < width; x++) {
      let best = Math.max(0, x - 1);
      for (let px = best + 1; px <= Math.min(width - 1, x + 1); px++)
        if (previous[px] < previous[best]) best = px;
      parents[y * width + x] = best;
      next[x] = cost[y * width + x] + previous[best];
    }
    previous = next;
  }
  let x = 0;
  for (let i = 1; i < width; i++) if (previous[i] < previous[x]) x = i;
  const total = previous[x],
    path = new Int16Array(height);
  for (let y = height - 1; y >= 0; y--) {
    path[y] = x;
    if (y) x = parents[y * width + x];
  }
  return { path, cost: total };
}
export function removeSeam(image, path) {
  const { width: w, height: h } = image;
  if (w < 2 || path.length !== h) throw Error('Invalid removal dimensions.');
  for (let y = 0; y < h; y++)
    if (
      !Number.isInteger(path[y]) ||
      path[y] < 0 ||
      path[y] >= w ||
      (y && Math.abs(path[y] - path[y - 1]) > 1)
    )
      throw Error('Seams need one adjacent in-bounds pixel per row.');
  const out = {
    width: w - 1,
    height: h,
    pixels: new Uint8ClampedArray((w - 1) * h * 4),
    mask: new Uint8Array((w - 1) * h),
    origin: new Int32Array((w - 1) * h),
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w - 1; x++) {
      const from = y * w + x + (x >= path[y] ? 1 : 0),
        to = y * (w - 1) + x;
      out.pixels.set(image.pixels.subarray(from * 4, from * 4 + 4), to * 4);
      out.mask[to] = image.mask[from];
      out.origin[to] = image.origin?.[from] ?? from;
    }
  return out;
}
export function transpose(image) {
  const out = {
    width: image.height,
    height: image.width,
    pixels: new Uint8ClampedArray(image.pixels.length),
    mask: new Uint8Array(image.mask.length),
    origin: new Int32Array(image.mask.length),
  };
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) {
      const from = y * image.width + x,
        to = x * image.height + y;
      out.pixels.set(image.pixels.subarray(from * 4, from * 4 + 4), to * 4);
      out.mask[to] = image.mask[from];
      out.origin[to] = image.origin?.[from] ?? from;
    }
  return out;
}
export function carve(input, axis, count, progress = () => {}) {
  let image = validateImage(input);
  if (!['width', 'height'].includes(axis)) throw Error('Choose width or height.');
  const dimension = image[axis];
  if (!Number.isInteger(count) || count < 1 || count > Math.floor(dimension / 2))
    throw Error('Remove 1 pixel through half of the selected dimension.');
  image.origin = Int32Array.from({ length: image.width * image.height }, (_, i) => i);
  if (axis === 'height') image = transpose(image);
  const steps = [];
  for (let i = 0; i < count; i++) {
    const base = energy(image),
      cost = Float64Array.from(base, (e, j) => e + image.mask[j] * PENALTY),
      seam = minimumSeam(cost, image.width, image.height),
      original = [],
      path = Array.from(seam.path);
    let protectedHits = 0,
      gradientCost = 0;
    for (let y = 0; y < image.height; y++) {
      const at = y * image.width + path[y];
      original.push(image.origin[at]);
      protectedHits += image.mask[at];
      gradientCost += base[at];
    }
    steps.push({
      step: i + 1,
      currentWidth: image.width,
      currentHeight: image.height,
      path,
      original,
      cost: seam.cost,
      gradientCost,
      protectedHits,
    });
    image = removeSeam(image, seam.path);
    progress({ completed: i + 1, total: count });
  }
  if (axis === 'height') image = transpose(image);
  return {
    axis,
    count,
    width: image.width,
    height: image.height,
    pixels: image.pixels,
    mask: image.mask,
    origin: image.origin,
    steps,
    protectedRemoved: steps.reduce((n, s) => n + s.protectedHits, 0),
    protectedRemaining: image.mask.reduce((n, v) => n + v, 0),
  };
}
export function fixture(width = 200, height = 140) {
  const pixels = new Uint8ClampedArray(width * height * 4),
    mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const u = x / width,
        v = y / height;
      let c = [230 + 12 * v, 216 + 18 * v, 193 + 30 * v];
      if (v > 0.69) c = [145 + 20 * u, 161 + 12 * u, 141 + 15 * u];
      if ((u - 0.69) ** 2 + (v - 0.3) ** 2 < 0.018) c = [202, 122, 82];
      if (u > 0.18 && u < 0.35 && v > 0.24 && v < 0.82) c = [66, 101, 101];
      if (u > 0.2 && u < 0.33 && v > 0.27 && v < 0.79) {
        const stripe = Math.floor((v * height) / 10) % 2;
        c = stripe ? [87, 128, 125] : [78, 116, 114];
      }
      const at = (y * width + x) * 4;
      pixels.set([...c, 255], at);
    }
  return { width, height, pixels, mask };
}
export function makeSession(image, axis, count) {
  const value = validateImage(image);
  return {
    version: 1,
    width: value.width,
    height: value.height,
    pixels: Array.from(value.pixels),
    mask: Array.from(value.mask),
    axis,
    count,
  };
}
export function readSession(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'axis,count,height,mask,pixels,version,width' ||
    value.version !== 1
  )
    throw Error('Expected a version 1 seam session.');
  const image = validateImage(value);
  if (
    !['width', 'height'].includes(value.axis) ||
    !Number.isInteger(value.count) ||
    value.count < 1 ||
    value.count > Math.floor(image[value.axis] / 2)
  )
    throw Error('Session removal count is outside the supported range.');
  return { image, axis: value.axis, count: value.count };
}
