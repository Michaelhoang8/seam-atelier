import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PENALTY,
  validateImage,
  energy,
  minimumSeam,
  removeSeam,
  transpose,
  carve,
  fixture,
  makeSession,
  readSession,
} from '../core.js';
test('constant images have zero energy and deterministic leftmost ties', () => {
  const image = validateImage({
    width: 4,
    height: 3,
    pixels: Array(12).fill([20, 30, 40, 255]).flat(),
    mask: Array(12).fill(0),
  });
  assert.ok([...energy(image)].every((v) => v === 0));
  assert.deepEqual([...minimumSeam(energy(image), 4, 3).path], [0, 0, 0]);
});
test('gradient energy uses clamped RGB differences at boundaries', () => {
  const image = validateImage({
    width: 3,
    height: 2,
    pixels: [
      0, 0, 0, 255, 10, 0, 0, 255, 30, 0, 0, 255, 0, 20, 0, 255, 10, 20, 0, 255, 30, 20, 0, 255,
    ],
    mask: Array(6).fill(0),
  });
  const e = energy(image);
  assert.equal(e[0], Math.sqrt(100 + 400));
  assert.equal(e[1], Math.sqrt(900 + 400));
  assert.equal(e[2], Math.sqrt(400 + 400));
});
test('dynamic programming agrees with exhaustive path enumeration on 300 small grids', () => {
  let seed = 19;
  const rand = (n) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  for (let trial = 0; trial < 300; trial++) {
    const w = 1 + rand(5),
      h = 1 + rand(5),
      cost = Array.from({ length: w * h }, () => rand(20) - 5);
    let best = Infinity;
    function visit(y, x, sum) {
      sum += cost[y * w + x];
      if (y === h - 1) {
        best = Math.min(best, sum);
        return;
      }
      for (let next = Math.max(0, x - 1); next <= Math.min(w - 1, x + 1); next++)
        visit(y + 1, next, sum);
    }
    for (let x = 0; x < w; x++) visit(0, x, 0);
    const result = minimumSeam(cost, w, h);
    assert.equal(result.cost, best);
    assert.equal(result.path.length, h);
    assert.equal(
      [...result.path].reduce((n, x, y) => n + cost[y * w + x], 0),
      best,
    );
    for (let y = 1; y < h; y++) assert.ok(Math.abs(result.path[y] - result.path[y - 1]) <= 1);
  }
});
test('seam deletion preserves exact surviving bytes, masks, and coordinates', () => {
  const image = fixture(5, 4);
  image.mask[7] = 1;
  image.origin = Int32Array.from({ length: 20 }, (_, i) => i);
  const path = [1, 2, 2, 1],
    r = removeSeam(image, path);
  assert.equal(r.width, 4);
  for (let y = 0; y < 4; y++) {
    const expected = Array.from({ length: 5 }, (_, x) => y * 5 + x).filter((_, x) => x !== path[y]);
    assert.deepEqual([...r.origin.slice(y * 4, y * 4 + 4)], expected);
  }
  for (let i = 0; i < r.origin.length; i++) {
    assert.deepEqual(
      [...r.pixels.slice(i * 4, i * 4 + 4)],
      [...image.pixels.slice(r.origin[i] * 4, r.origin[i] * 4 + 4)],
    );
    assert.equal(r.mask[i], image.mask[r.origin[i]]);
  }
});
test('double transpose is exact including protection and provenance', () => {
  const image = fixture(7, 5);
  image.mask[3] = 1;
  image.origin = Int32Array.from({ length: 35 }, (_, i) => i);
  const back = transpose(transpose(image));
  assert.deepEqual(back, image);
});
test('horizontal carving equals transposed vertical carving byte for byte', () => {
  const image = fixture(12, 9);
  image.mask[30] = 1;
  const a = carve(image, 'height', 3),
    b = transpose(carve(transpose(image), 'width', 3));
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  assert.deepEqual(a.pixels, b.pixels);
  assert.deepEqual(a.mask, b.mask);
});
test('protected columns survive while unprotected seams exist', () => {
  const image = fixture(10, 8);
  for (let y = 0; y < 8; y++) for (let x = 3; x <= 5; x++) image.mask[y * 10 + x] = 1;
  const r = carve(image, 'width', 5);
  assert.equal(r.protectedRemoved, 0);
  assert.equal(r.protectedRemaining, 24);
  assert.ok(r.steps.every((s) => s.cost < PENALTY));
});
test('unavoidable protection crossings are explicit and accounted for', () => {
  const image = fixture(8, 6);
  for (let x = 0; x < 8; x++) image.mask[2 * 8 + x] = 1;
  const r = carve(image, 'width', 3);
  assert.equal(r.protectedRemoved, 3);
  assert.equal(r.protectedRemaining, 5);
  for (const s of r.steps) {
    assert.equal(s.protectedHits, 1);
    assert.ok(Math.abs(s.cost - (PENALTY + s.gradientCost)) < 1e-7);
  }
});
test('multi-seam provenance partitions original pixels and reconstructs output exactly', () => {
  for (const axis of ['width', 'height']) {
    const image = fixture(20, 16),
      r = carve(image, axis, 7),
      removed = r.steps.flatMap((s) => s.original),
      remaining = [...r.origin];
    assert.equal(new Set([...removed, ...remaining]).size, 320);
    assert.equal(removed.length + remaining.length, 320);
    for (let i = 0; i < remaining.length; i++)
      assert.deepEqual(
        [...r.pixels.slice(i * 4, i * 4 + 4)],
        [...image.pixels.slice(remaining[i] * 4, remaining[i] * 4 + 4)],
      );
  }
});
test('every recorded seam is optimal on its actual intermediate image', () => {
  const original = fixture(14, 11),
    result = carve(original, 'width', 6);
  let image = validateImage(original);
  for (const step of result.steps) {
    const cost = energy(image),
      optimal = minimumSeam(cost, image.width, image.height);
    assert.equal(step.cost, optimal.cost);
    assert.deepEqual(step.path, [...optimal.path]);
    image = removeSeam(image, step.path);
  }
  assert.deepEqual(image.pixels, result.pixels);
});
test('progress, session roundtrip, and source immutability', () => {
  const image = fixture(8, 8),
    before = structuredClone(image),
    progress = [];
  carve(image, 'width', 3, (p) => progress.push(p.completed));
  assert.deepEqual(progress, [1, 2, 3]);
  assert.deepEqual(image, before);
  const session = makeSession(image, 'height', 2),
    loaded = readSession(JSON.parse(JSON.stringify(session)));
  assert.deepEqual(loaded.image, image);
  assert.equal(loaded.axis, 'height');
  assert.equal(loaded.count, 2);
});
test('invalid dimensions, bytes, masks, paths, and sessions are rejected', () => {
  const image = fixture(8, 8);
  for (const [axis, n] of [
    ['other', 2],
    ['width', 0],
    ['height', 5],
    ['width', 1.5],
  ])
    assert.throws(() => carve(image, axis, n));
  assert.throws(() => validateImage({ ...image, width: 257 }));
  assert.throws(() => validateImage({ ...image, mask: Array(64).fill(-1) }));
  const pixels = Array.from(image.pixels);
  pixels[3] = 0;
  assert.throws(() => validateImage({ ...image, pixels }));
  assert.throws(() => minimumSeam([NaN], 1, 1));
  assert.throws(() => removeSeam(image, [0, 7, 0, 0, 0, 0, 0, 0]));
  assert.throws(() => readSession({ ...makeSession(image, 'width', 1), version: 2 }));
  assert.throws(() => readSession({ ...makeSession(image, 'width', 1), extra: 0 }));
});
