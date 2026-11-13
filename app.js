import { fixture, energy, makeSession, readSession } from './core.js';
const $ = (id) => document.getElementById(id),
  el = (tag, text) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    return n;
  };
let image = fixture(),
  gradient = energy(image),
  result = null,
  worker = null,
  busy = false,
  revision = 0,
  selected = 0,
  history = [],
  drawing = false,
  lastPoint = null,
  cursor = null;
function status(s) {
  $('status').textContent = s;
}
function protectedCount() {
  return image.mask.reduce((n, v) => n + v, 0);
}
function controls() {
  for (const n of document.querySelectorAll('button,input,select')) n.disabled = busy;
  $('cancel').disabled = !worker;
  $('undo').disabled = busy || !history.length;
  $('clear').disabled = busy || !protectedCount();
  $('png').disabled = busy || !result;
  $('source-canvas').setAttribute('aria-disabled', String(busy));
}
function settings() {
  const max = Math.floor(image[$('axis').value] / 2);
  $('count').max = max;
  if (Number($('count').value) > max) $('count').value = max;
  $('dimensions').textContent = `WORKING IMAGE / ${image.width} × ${image.height}`;
}
function invalidate() {
  revision++;
  worker?.terminate();
  worker = null;
  busy = false;
  result = null;
  $('evidence').hidden = true;
  $('empty-result').hidden = false;
  $('result-size').textContent = '';
  controls();
}
function draw() {
  const source = $('source-canvas');
  source.width = image.width;
  source.height = image.height;
  const ctx = source.getContext('2d'),
    pixels = new Uint8ClampedArray(image.pixels);
  if ($('view').value === 'energy') {
    const max = Math.max(1, ...gradient);
    for (let i = 0; i < gradient.length; i++)
      for (let c = 0; c < 3; c++) pixels[i * 4 + c] = Math.round((255 * gradient[i]) / max);
  }
  for (let i = 0; i < image.mask.length; i++)
    if (image.mask[i])
      for (let c = 0; c < 3; c++)
        pixels[i * 4 + c] = pixels[i * 4 + c] * 0.55 + [50, 200, 205][c] * 0.45;
  if (result)
    for (const id of result.steps[selected].original) pixels.set([255, 154, 110, 255], id * 4);
  ctx.putImageData(new ImageData(pixels, image.width, image.height), 0, 0);
  if (cursor) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.strokeRect(cursor.x - 2.5, cursor.y - 2.5, 5, 5);
  }
  $('mask-note').textContent =
    `${protectedCount().toLocaleString()} protected pixels · cyan mask · ${history.length}/20 undo steps`;
  const output = $('result-canvas');
  output.width = image.width;
  output.height = image.height;
  const out = output.getContext('2d');
  out.clearRect(0, 0, output.width, output.height);
  if (result) {
    const x = (image.width - result.width) / 2,
      y = (image.height - result.height) / 2;
    if ($('result-view').value === 'carved') {
      const temp = document.createElement('canvas');
      temp.width = result.width;
      temp.height = result.height;
      temp
        .getContext('2d')
        .putImageData(new ImageData(result.pixels, result.width, result.height), 0, 0);
      out.drawImage(temp, x, y);
    } else {
      const temp = document.createElement('canvas');
      temp.width = image.width;
      temp.height = image.height;
      temp
        .getContext('2d')
        .putImageData(new ImageData(image.pixels, image.width, image.height), 0, 0);
      out.drawImage(temp, 0, 0, image.width, image.height, x, y, result.width, result.height);
    }
  }
  controls();
}
function renderEvidence() {
  $('evidence').hidden = false;
  $('empty-result').hidden = true;
  $('result-size').textContent =
    `${result.width} × ${result.height} / ${result.count} seams removed`;
  $('seam').max = result.steps.length - 1;
  $('seam').value = selected;
  const s = result.steps[selected];
  $('seam-label').textContent = `${selected + 1} / ${result.steps.length}`;
  $('seam-info').textContent =
    `gradient ${s.gradientCost.toFixed(2)} · protected ${s.protectedHits}`;
  $('protection-summary').textContent = result.protectedRemoved
    ? `${result.protectedRemoved} protected pixels were removed where crossing protection became unavoidable. ${result.protectedRemaining} remain.`
    : `All ${result.protectedRemaining} protected pixels survived.`;
  $('ledger').replaceChildren();
  for (const s of result.steps) {
    const row = el('tr');
    for (const v of [
      s.step,
      s.currentWidth,
      s.gradientCost.toFixed(3),
      s.protectedHits,
      s.cost.toFixed(3),
    ])
      row.append(el('td', v));
    $('ledger').append(row);
  }
  draw();
}
function run() {
  invalidate();
  const ticket = revision,
    w = new Worker('worker.js', { type: 'module' });
  worker = w;
  busy = true;
  controls();
  status('Finding and removing minimum-cost seams…');
  w.onmessage = ({ data }) => {
    if (ticket !== revision) return;
    if (data.progress) {
      status(`Carving seam ${data.progress.completed} of ${data.progress.total}…`);
      return;
    }
    w.terminate();
    worker = null;
    busy = false;
    if (data.error) {
      status(data.error);
      draw();
      return;
    }
    result = data.result;
    selected = 0;
    renderEvidence();
    status(
      `Removed ${result.count} ${result.axis === 'width' ? 'vertical' : 'horizontal'} seams. Inspect a path or export the resized image.`,
    );
  };
  w.onerror = () => {
    if (ticket !== revision) return;
    w.terminate();
    worker = null;
    busy = false;
    status('The image worker failed. Try a smaller image.');
    draw();
  };
  w.postMessage({ image, axis: $('axis').value, count: Number($('count').value) });
}
function remember() {
  history.push(new Uint8Array(image.mask));
  if (history.length > 20) history.shift();
}
function point(event) {
  const rect = $('source-canvas').getBoundingClientRect();
  return {
    x: Math.max(
      0,
      Math.min(
        image.width - 1,
        Math.floor(((event.clientX - rect.left) * image.width) / rect.width),
      ),
    ),
    y: Math.max(
      0,
      Math.min(
        image.height - 1,
        Math.floor(((event.clientY - rect.top) * image.height) / rect.height),
      ),
    ),
  };
}
function paint(p) {
  const radius = Number($('radius').value),
    value = $('brush').value === 'protect' ? 1 : 0;
  for (let y = Math.max(0, p.y - radius); y <= Math.min(image.height - 1, p.y + radius); y++)
    for (let x = Math.max(0, p.x - radius); x <= Math.min(image.width - 1, p.x + radius); x++)
      if ((x - p.x) ** 2 + (y - p.y) ** 2 <= radius ** 2) image.mask[y * image.width + x] = value;
}
function paintLine(a, b) {
  const steps = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), 1);
  for (let i = 0; i <= steps; i++)
    paint({
      x: Math.round(a.x + ((b.x - a.x) * i) / steps),
      y: Math.round(a.y + ((b.y - a.y) * i) / steps),
    });
  invalidate();
  draw();
  status('Protection mask changed. Carve again to refresh the result.');
}
$('source-canvas').addEventListener('pointerdown', (e) => {
  if (busy) return;
  cursor = point(e);
  if ($('brush').value === 'inspect') {
    draw();
    return;
  }
  remember();
  drawing = true;
  lastPoint = cursor;
  $('source-canvas').setPointerCapture(e.pointerId);
  paintLine(cursor, cursor);
});
$('source-canvas').addEventListener('pointermove', (e) => {
  if (!drawing || busy) return;
  cursor = point(e);
  paintLine(lastPoint, cursor);
  lastPoint = cursor;
});
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture'])
  $('source-canvas').addEventListener(event, () => {
    drawing = false;
    lastPoint = null;
  });
$('source-canvas').addEventListener('keydown', (e) => {
  if (busy) return;
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' '].includes(e.key)) return;
  e.preventDefault();
  cursor ??= { x: Math.floor(image.width / 2), y: Math.floor(image.height / 2) };
  if (e.key === ' ') {
    if ($('brush').value !== 'inspect') {
      remember();
      paintLine(cursor, cursor);
    }
  } else {
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[
      e.key
    ];
    cursor = {
      x: Math.max(0, Math.min(image.width - 1, cursor.x + d[0])),
      y: Math.max(0, Math.min(image.height - 1, cursor.y + d[1])),
    };
    draw();
  }
});
$('undo').addEventListener('click', () => {
  if (!history.length) return;
  image.mask = history.pop();
  invalidate();
  draw();
  status('Previous protection mask restored.');
});
$('clear').addEventListener('click', () => {
  remember();
  image.mask.fill(0);
  invalidate();
  draw();
  status('Protection cleared. Undo can restore it.');
});
$('axis').addEventListener('change', () => {
  settings();
  invalidate();
  draw();
  status('Resize direction changed. Carve again.');
});
$('count').addEventListener('input', () => {
  invalidate();
  draw();
  status('Removal count changed. Carve again.');
});
for (const id of ['view', 'result-view']) $(id).addEventListener('change', draw);
$('seam').addEventListener('input', () => {
  selected = Number($('seam').value);
  renderEvidence();
});
$('carve').addEventListener('click', run);
$('cancel').addEventListener('click', () => {
  invalidate();
  draw();
  status('Carving cancelled.');
});
function replace(next, axis = 'width', count = 40) {
  invalidate();
  image = next;
  gradient = energy(image);
  history = [];
  cursor = null;
  $('axis').value = axis;
  $('count').value = count;
  settings();
  draw();
}
$('sample').addEventListener('click', () => {
  replace(fixture());
  status('Geometric study loaded. Paint protection or carve directly.');
});
async function loadFile(kind) {
  const input = $(kind === 'image' ? 'image-file' : 'session-file'),
    file = input.files[0];
  if (!file) return;
  busy = true;
  controls();
  let bitmap = null;
  try {
    if (kind === 'session') {
      if (file.size > 2000000) throw Error('Sessions are limited to 2 MB.');
      const value = readSession(JSON.parse(await file.text()));
      replace(value.image, value.axis, value.count);
      status('Session restored. Carve to reproduce its result.');
    } else {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type))
        throw Error('Use a PNG, JPEG, or WebP image.');
      if (file.size > 8000000) throw Error('Image files are limited to 8 MB.');
      bitmap = await createImageBitmap(file);
      if (bitmap.width * bitmap.height > 16000000)
        throw Error('Decoded images are limited to 16 megapixels.');
      const scale = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height)),
        width = Math.max(1, Math.round(bitmap.width * scale)),
        height = Math.max(1, Math.round(bitmap.height * scale)),
        canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(bitmap, 0, 0, width, height);
      replace({
        width,
        height,
        pixels: ctx.getImageData(0, 0, width, height).data,
        mask: new Uint8Array(width * height),
      });
      status(
        `Loaded ${bitmap.width} × ${bitmap.height}; working image ${width} × ${height}, flattened onto white.`,
      );
    }
  } catch (e) {
    status(`Import rejected: ${e.message}`);
  } finally {
    bitmap?.close();
    input.value = '';
    busy = false;
    controls();
  }
}
$('image-file').addEventListener('change', () => loadFile('image'));
$('session-file').addEventListener('change', () => loadFile('session'));
function download(name, blob) {
  const url = URL.createObjectURL(blob),
    a = el('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('png').addEventListener('click', () => {
  if (!result) return;
  const canvas = document.createElement('canvas');
  canvas.width = result.width;
  canvas.height = result.height;
  canvas
    .getContext('2d')
    .putImageData(new ImageData(result.pixels, result.width, result.height), 0, 0);
  canvas.toBlob((blob) => {
    if (blob) download('seam-atelier.png', blob);
    else status('PNG encoding failed.');
  }, 'image/png');
});
$('save').addEventListener('click', () => {
  if (result)
    download(
      'seam-session.json',
      new Blob([JSON.stringify(makeSession(image, result.axis, result.count))], {
        type: 'application/json',
      }),
    );
});
async function hash(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
$('report').addEventListener('click', async () => {
  if (!result) return;
  busy = true;
  controls();
  try {
    const report = {
      algorithm: 'RGB gradient backward-energy seam carving',
      penalty: 1000000,
      input: {
        width: image.width,
        height: image.height,
        rgbaSha256: await hash(image.pixels),
        protectedPixels: protectedCount(),
      },
      output: { width: result.width, height: result.height, rgbaSha256: await hash(result.pixels) },
      axis: result.axis,
      count: result.count,
      protectedRemoved: result.protectedRemoved,
      protectedRemaining: result.protectedRemaining,
      steps: result.steps,
      survivingOriginalIndices: Array.from(result.origin),
    };
    download(
      'seam-evidence.json',
      new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }),
    );
    status('Evidence exported with exact paths, pixel provenance, and RGBA digests.');
  } catch (e) {
    status(e.message);
  } finally {
    busy = false;
    controls();
  }
});
settings();
draw();
run();
