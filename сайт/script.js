// ===== Настройки =====

// Адрес бэкенда. Пока пусто — после считывания QR-кода показываются демонстрационные контуры.
// Метка из QR-кода добавляется к адресу как параметр: /api/issues?tag=...
const API_URL = '';

// Как часто повторять запрос для текущей метки, в миллисекундах.
// Нужен постоянный опрос: так новые проблемы появляются в плашке, пока камера смотрит на объект.
const POLL_MS = 2000;

// Необязательный адрес, по которому можно получить название и решение проблемы по её id.
// Нужен, только если основной ответ присылает одни id без текста. {id} заменяется на id проблемы.
// Например: const PROBLEM_DETAILS_URL = '/api/problems/{id}';
const PROBLEM_DETAILS_URL = '';

// true — если задней камеры нет (например, на ПК), использовать любую доступную.
// Для тестов на компьютере. На смартфонах в рабочей версии поставьте false.
const ALLOW_ANY_CAMERA = true;

// Как часто проверять кадр на наличие QR-кода, в миллисекундах
const SCAN_INTERVAL_MS = 300;

// Запасной распознаватель QR для браузеров без BarcodeDetector (например, Safari на iPhone)
const JSQR_URL = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';

const DEFAULT_LINE_COLOR = '#FFD400';

// Как вписывать кадр камеры в экран:
// 'contain' — кадр виден целиком, все линии на экране, но могут быть чёрные полосы;
// 'cover'   — кадр заполняет экран без полос, но края кадра (и линии на них) обрезаются;
// 'auto'    — 'cover', если при этом видно не меньше AUTO_COVER_MIN кадра, иначе 'contain'.
//             На телефоне это даёт экран без полос, а на ПК с широкой веб-камерой — кадр целиком.
const VIDEO_FIT = 'auto';
const AUTO_COVER_MIN = 0.85;

// true — показывать вверху размеры кадра и экрана и какая часть кадра видна. Для отладки.
const DEBUG = true;

// Цвет ломаных проблем из плашки и стрелок у выбранной проблемы
const PROBLEM_COLOR = '#FF4D4D';

// Формат данных с бэкенда. Каждый контур — 4 точки, последняя соединяется с первой.
// Координаты — доли кадра камеры от 0 до 1: [0, 0] — левый верхний угол, [1, 1] — правый нижний.
// Пока API_URL пустой, данные выдаёт симулятор движения камеры (раздел «Симулятор» ниже).


// ===== Текущая метка из QR-кода =====

let tag = null;


// ===== Камера (задняя) =====

const video = document.getElementById('video');
const message = document.getElementById('message');
const messageText = document.getElementById('messageText');
const retryBtn = document.getElementById('retry');

let stream = null;
let wakeLock = null;

function showMessage(text, withRetry) {
  messageText.textContent = text;
  retryBtn.hidden = !withRetry;
  message.hidden = false;
}

function describeError(err) {
  switch (err.name) {
    case 'NotAllowedError':
      return 'Доступ к камере запрещён. Разрешите его в настройках сайта в браузере и нажмите кнопку.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'Задняя камера не найдена. Откройте страницу на смартфоне.';
    case 'NotReadableError':
      return 'Камера занята другим приложением. Закройте его и нажмите кнопку.';
    default:
      return 'Не удалось включить камеру: ' + err.message;
  }
}

function stopCamera() {
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null;
}

// Просим у камеры кадр с теми же пропорциями, что у экрана в текущей ориентации,
// чтобы при заполнении экрана обрезалось как можно меньше.
// Браузер сам поворачивает кадр под ориентацию телефона, поэтому размеры указываем как есть.
function videoConstraints(rearOnly) {
  return {
    // exact — строго задняя камера; ideal — задняя, если есть, иначе любая
    facingMode: rearOnly ? { exact: 'environment' } : { ideal: 'environment' },
    width: { ideal: 1920 },
    height: { ideal: 1080 }
  };
}

async function startCamera() {
  stopCamera();
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(true), audio: false });
  } catch (err) {
    const noRearCamera = err.name === 'OverconstrainedError' || err.name === 'NotFoundError';
    if (!(noRearCamera && ALLOW_ANY_CAMERA)) {
      showMessage(describeError(err), true);
      return;
    }
    // Задней камеры нет — берём любую доступную (режим для тестов)
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(false), audio: false });
      showToast('Задняя камера не найдена, используется доступная');
    } catch (err2) {
      showMessage(describeError(err2), true);
      return;
    }
  }
  video.srcObject = stream;
  message.hidden = true;
  keepScreenOn();
}

// Не даём экрану гаснуть, пока страница открыта (где это поддерживается)
async function keepScreenOn() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) { /* не критично */ }
}

retryBtn.addEventListener('click', startCamera);

// При повороте телефона перезапрашиваем камеру под новые пропорции экрана
let orientationTimer = null;
window.matchMedia('(orientation: portrait)').addEventListener('change', () => {
  clearTimeout(orientationTimer);
  orientationTimer = setTimeout(() => { if (stream) startCamera(); }, 300);
});

// После возврата на вкладку камера могла отключиться — включаем снова
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const track = stream && stream.getVideoTracks()[0];
  if (!track || track.readyState === 'ended') startCamera();
  else keepScreenOn();
});


// ===== Сканирование QR-кодов =====

const tagLabel = document.getElementById('tagLabel');
let detector = null;          // встроенный BarcodeDetector, если есть
const scanCanvas = document.createElement('canvas');
const scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true });

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Не удалось загрузить ' + src));
    document.head.appendChild(s);
  });
}

async function initScanner() {
  if ('BarcodeDetector' in window) {
    try {
      const formats = await BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) {
        detector = new BarcodeDetector({ formats: ['qr_code'] });
        return;
      }
    } catch (e) { /* переходим на jsQR */ }
  }
  await loadScript(JSQR_URL);
}

async function scanFrame() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!stream || video.readyState < 2 || !vw) return null;

  if (detector) {
    const codes = await detector.detect(video);
    return codes.length ? codes[0].rawValue : null;
  }

  if (window.jsQR) {
    // Уменьшаем кадр: так распознавание идёт быстрее и не тормозит телефон
    const scale = Math.min(1, 720 / Math.max(vw, vh));
    const w = Math.round(vw * scale);
    const h = Math.round(vh * scale);
    scanCanvas.width = w;
    scanCanvas.height = h;
    scanCtx.drawImage(video, 0, 0, w, h);
    const code = jsQR(scanCtx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
    return code ? code.data : null;
  }
  return null;
}

async function scanLoop() {
  if (document.visibilityState === 'visible') {
    try {
      const value = await scanFrame();
      if (value && value !== tag) onTagChange(value);
    } catch (err) {
      console.warn('Ошибка сканирования QR:', err);
    }
  }
  setTimeout(scanLoop, SCAN_INTERVAL_MS);
}

// Вызывается, когда в кадре появился новый QR-код
function onTagChange(newTag) {
  tag = newTag;
  tagLabel.textContent = 'Метка: ' + tag;
  tagLabel.hidden = false;
  if (navigator.vibrate) navigator.vibrate(50);
  setIssues([]);     // старые контуры и проблемы относятся к прошлой метке
  clearProblems();
  loadIssues();
}


// ===== Контуры и подсказки поверх видео =====

const canvas = document.getElementById('overlay');
const ctx = canvas.getContext('2d');
const hintsLayer = document.getElementById('hints');
const toast = document.getElementById('toast');

let issues = [];
const hintEls = new Map();    // id контура → элемент подсказки

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  render();
}

// Переводит точку кадра (доли 0..1) в пиксели экрана с учётом того,
// как видео вписано в экран (cover обрезает края кадра).
function toScreen(point) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;

  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  const fit = getComputedStyle(video).objectFit;
  const scale = fit === 'contain' ? Math.min(W / vw, H / vh) : Math.max(W / vw, H / vh);
  const dw = vw * scale;
  const dh = vh * scale;

  return [(W - dw) / 2 + point[0] * dw, (H - dh) / 2 + point[1] * dh];
}

function screenPoints(issue) {
  const pts = issue.points.map(toScreen);
  return pts.includes(null) ? null : pts;
}

function tracePolygon(pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();   // соединяем последнюю точку с первой
}

function drawPolygons() {
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  for (const issue of issues) {
    const pts = screenPoints(issue);
    if (!pts) continue;
    const color = issue.color || DEFAULT_LINE_COLOR;
    tracePolygon(pts);

    // Лёгкая заливка, чтобы область было видно
    ctx.globalAlpha = 0.15;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 1;

    // Тёмная обводка, чтобы жёлтую линию было видно на светлом фоне
    ctx.lineWidth = 7;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.stroke();
    ctx.lineWidth = 4;
    ctx.strokeStyle = color;
    ctx.stroke();
  }
}

// Создаёт элементы подсказок под текущий список контуров
function buildHints() {
  hintsLayer.textContent = '';
  hintEls.clear();
  for (const issue of issues) {
    const el = document.createElement('div');
    el.className = 'hint';
    el.style.color = issue.color || DEFAULT_LINE_COLOR;
    // textContent, а не innerHTML: данные с бэкенда не превращаются в разметку
    el.textContent = issue.problem || '—';
    hintsLayer.appendChild(el);
    hintEls.set(issue.id, el);
  }
}

function overlapArea(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

// Ставит каждую подсказку рядом со своим контуром: над ним, под ним, справа или слева —
// туда, где она помещается на экране и меньше всего перекрывает другие подсказки.
function layoutHints() {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const margin = 8;
  const gap = 10;
  const placed = [];
  const topLimit = topStack.getBoundingClientRect().bottom + margin;
  const bottomLimit = bottomStack.getBoundingClientRect().top - margin;

  for (const issue of issues) {
    const el = hintEls.get(issue.id);
    if (!el) continue;
    const pts = screenPoints(issue);
    if (!pts) { el.hidden = true; continue; }
    el.hidden = false;

    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const xs = pts.map(p => p[0]);
    const ys = pts.map(p => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    const candidates = [
      { x: cx - w / 2, y: minY - gap - h },   // над контуром
      { x: cx - w / 2, y: maxY + gap },       // под контуром
      { x: maxX + gap, y: cy - h / 2 },       // справа
      { x: minX - gap - w, y: cy - h / 2 }    // слева
    ];

    let best = null;
    let bestScore = Infinity;
    for (const c of candidates) {
      const x = Math.min(Math.max(c.x, margin), W - w - margin);
      const y = Math.max(Math.min(Math.max(c.y, topLimit), bottomLimit - h), topLimit);
      const rect = { x, y, w, h };
      const shift = Math.abs(x - c.x) + Math.abs(y - c.y);   // насколько пришлось сдвинуть внутрь экрана
      const overlap = placed.reduce((sum, r) => sum + overlapArea(rect, r), 0);
      const score = overlap * 10 + shift;
      if (score < bestScore) {
        bestScore = score;
        best = rect;
      }
    }

    placed.push(best);
    el.style.transform = `translate(${Math.round(best.x)}px, ${Math.round(best.y)}px)`;
  }
}

// Рисует наконечник стрелки в точке tip, направленный от точки from
function drawArrowHead(tip, from, color) {
  const angle = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
  const size = 18;
  const spread = 0.5;
  ctx.beginPath();
  ctx.moveTo(tip[0], tip[1]);
  ctx.lineTo(tip[0] - size * Math.cos(angle - spread), tip[1] - size * Math.sin(angle - spread));
  ctx.lineTo(tip[0] - size * Math.cos(angle + spread), tip[1] - size * Math.sin(angle + spread));
  ctx.closePath();
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.fill();
}

// Ломаные проблем из плашки — замкнутые четырёхугольники. Рисуются только проблемы,
// которые бэкенд прислал в последнем ответе (то есть сейчас в кадре).
// На углы выбранной в плашке проблемы указывают стрелки снаружи.
function drawProblemLines() {
  const selected = problems[problemIndex];

  for (const item of problems) {
    if (!visibleProblemIds.has(item.id) || !item.points) continue;
    const pts = item.points.map(toScreen);
    if (pts.includes(null)) continue;
    const isSelected = item === selected;

    tracePolygon(pts);
    ctx.globalAlpha = 0.15;
    ctx.fillStyle = PROBLEM_COLOR;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = isSelected ? 9 : 7;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.stroke();
    ctx.lineWidth = isSelected ? 5 : 3;
    ctx.strokeStyle = PROBLEM_COLOR;
    ctx.stroke();

    if (isSelected) drawCornerArrows(pts);
  }
}

// Стрелки к каждому углу: идут от центра фигуры наружу и смотрят остриём в угол
function drawCornerArrows(pts) {
  const cx = pts.reduce((sum, p) => sum + p[0], 0) / pts.length;
  const cy = pts.reduce((sum, p) => sum + p[1], 0) / pts.length;
  const gap = 6;       // зазор между остриём и углом
  const length = 34;   // длина стрелки

  for (const p of pts) {
    let dx = p[0] - cx;
    let dy = p[1] - cy;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;

    const tip = [p[0] + dx * gap, p[1] + dy * gap];
    const tail = [tip[0] + dx * length, tip[1] + dy * length];

    ctx.beginPath();
    ctx.moveTo(tail[0], tail[1]);
    ctx.lineTo(tip[0] + dx * 10, tip[1] + dy * 10);   // древко заканчивается у основания наконечника
    ctx.lineWidth = 7;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.stroke();
    ctx.lineWidth = 4;
    ctx.strokeStyle = PROBLEM_COLOR;
    ctx.stroke();

    drawArrowHead(tip, tail, PROBLEM_COLOR);
  }
}

// Отладочная строка: размеры кадра и экрана, какая доля кадра видна,
// и предупреждение, если координаты с бэкенда похожи на пиксели, а не на доли 0..1
const debugEl = document.getElementById('debug');
function updateDebug() {
  if (!DEBUG) return;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  if (!vw || !vh) {
    debugEl.textContent = 'Экран ' + W + '×' + H + ', кадра ещё нет';
  } else {
    const fit = getComputedStyle(video).objectFit;
    const scale = fit === 'contain' ? Math.min(W / vw, H / vh) : Math.max(W / vw, H / vh);
    const seenW = Math.round(Math.min(1, W / (vw * scale)) * 100);
    const seenH = Math.round(Math.min(1, H / (vh * scale)) * 100);
    debugEl.textContent = 'Кадр ' + vw + '×' + vh + ', экран ' + W + '×' + H +
      ', видно ' + seenW + '% ширины и ' + seenH + '% высоты кадра';
  }
  const allPoints = [...issues, ...problems].flatMap(i => i.points || []);
  if (allPoints.some(p => Math.abs(p[0]) > 1.5 || Math.abs(p[1]) > 1.5)) {
    debugEl.textContent += '. Координаты больше 1: похоже, бэкенд присылает пиксели, а нужны доли кадра';
  }
  debugEl.hidden = false;
}

// Выбирает, как вписать кадр в экран (см. VIDEO_FIT)
function applyFit() {
  if (VIDEO_FIT !== 'auto') {
    video.style.objectFit = VIDEO_FIT;
    return;
  }
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  if (!vw || !vh || !W || !H) {
    video.style.objectFit = 'contain';
    return;
  }
  // Какая доля кадра останется видна, если заполнить экран
  const scale = Math.max(W / vw, H / vh);
  const seen = Math.min(W / (vw * scale), H / (vh * scale));
  video.style.objectFit = seen >= AUTO_COVER_MIN ? 'cover' : 'contain';
}

function render() {
  applyFit();
  drawPolygons();
  drawProblemLines();
  updateDebug();
  layoutHints();
}

let toastTimer = null;
function showToast(text) {
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4000);
}

function isValidPoint(p) {
  return Array.isArray(p) && p.length >= 2 && isFinite(p[0]) && isFinite(p[1]);
}

let hintsKey = '';

function setIssues(list) {
  issues = list
    .filter(i => i && Array.isArray(i.points) && i.points.length >= 3 && i.points.every(isValidPoint))
    .map((i, index) => ({ ...i, id: i.id ?? 'issue-' + index }));

  // Пересобираем подсказки, только если поменялся набор контуров или их текст,
  // иначе при частых обновлениях (симулятор, быстрый опрос) они бы мигали
  const key = issues.map(i => i.id + '\u0000' + (i.problem || '')).join('\u0001');
  if (key !== hintsKey) {
    hintsKey = key;
    buildHints();
  }
  render();
}

// Отправляет метку на бэкенд и получает контуры для неё
async function loadIssues() {
  if (!tag) return;   // пока QR-код не считан, запрашивать нечего

  if (!API_URL) {
    startSimulation(tag);
    return;
  }

  const requestedTag = tag;
  const url = API_URL + (API_URL.includes('?') ? '&' : '?') + 'tag=' + encodeURIComponent(requestedTag);
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (requestedTag !== tag) return;   // пока ждали ответ, считали другой QR-код
    // Ожидаем { issues: [...контуры], problems: [...проблемы для плашки] }
    setIssues(Array.isArray(data) ? data : (data.issues || []));
    mergeProblems(Array.isArray(data) ? [] : (data.problems || []));
  } catch (err) {
    console.error('Ошибка загрузки контуров:', err);
    showToast('Не удалось загрузить данные о проблемах');
  }
}

// Перерисовываем, когда меняется размер экрана или кадра камеры
window.addEventListener('resize', resizeCanvas);
video.addEventListener('loadedmetadata', render);
video.addEventListener('resize', render);


// ===== Плашка с проблемами сверху =====

const topStack = document.getElementById('topStack');
const bottomStack = document.getElementById('bottomStack');
const panel = document.getElementById('panel');
const panelProblem = document.getElementById('panelProblem');
const panelSolution = document.getElementById('panelSolution');
const prevSide = document.getElementById('prevSide');
const nextSide = document.getElementById('nextSide');
const prevBtn = document.getElementById('prevProblem');
const nextBtn = document.getElementById('nextProblem');
const prevCount = document.getElementById('prevCount');
const nextCount = document.getElementById('nextCount');

// Сохранённые проблемы в порядке появления. Проблема остаётся в плашке,
// даже когда бэкенд перестал её присылать (например, камеру отвернули).
let problems = [];
const problemById = new Map();
let problemIndex = 0;
let visibleProblemIds = new Set();   // id проблем из последнего ответа бэкенда

// Добавляет пришедшие с бэкенда проблемы к сохранённым.
// Уже известные (тот же id) обновляются, новые добавляются в конец и сразу показываются.
function mergeProblems(list) {
  let firstNew = -1;
  visibleProblemIds = new Set();

  for (const raw of list) {
    if (!raw || raw.id === undefined || raw.id === null) continue;
    const id = String(raw.id);
    const title = raw.problem ?? raw.name ?? '';
    const solution = raw.solution ?? '';
    const saved = problemById.get(id);
    const points = Array.isArray(raw.points) && raw.points.length >= 3 && raw.points.every(isValidPoint)
      ? raw.points : null;
    visibleProblemIds.add(id);

    if (saved) {
      if (points) saved.points = points;
      if (title) saved.problem = title;
      if (solution) saved.solution = solution;
      continue;
    }

    const item = { id, problem: title, solution, points };
    problemById.set(id, item);
    problems.push(item);
    if (firstNew < 0) firstNew = problems.length - 1;

    // Пришёл только id — запрашиваем название и решение отдельно
    if (!title && PROBLEM_DETAILS_URL) loadProblemDetails(item);
  }

  if (firstNew >= 0) problemIndex = firstNew;
  showProblem();
}

async function loadProblemDetails(item) {
  const url = PROBLEM_DETAILS_URL.replace('{id}', encodeURIComponent(item.id));
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (problemById.get(item.id) !== item) return;   // список уже очистили
    item.problem = data.problem ?? data.name ?? item.problem;
    item.solution = data.solution ?? item.solution;
    showProblem();
  } catch (err) {
    console.error('Ошибка загрузки проблемы ' + item.id + ':', err);
  }
}

// Новый QR-код — новый объект, сохранённые проблемы прошлого объекта убираем
function clearProblems() {
  problems = [];
  problemById.clear();
  visibleProblemIds = new Set();
  problemIndex = 0;
  showProblem();
}

function showProblem() {
  render();   // стрелки переезжают к выбранной проблеме
  if (!problems.length) {
    panel.hidden = true;
    return;
  }
  const item = problems[problemIndex];
  panelProblem.textContent = item.problem || 'Загрузка…';
  panelSolution.textContent = item.solution || '';
  panelSolution.hidden = !item.solution;

  // Сколько проблем осталось слева и справа от текущей
  const before = problemIndex;
  const after = problems.length - 1 - problemIndex;
  const many = problems.length > 1;

  prevSide.hidden = !many;
  nextSide.hidden = !many;
  prevSide.classList.toggle('empty', before === 0);
  nextSide.classList.toggle('empty', after === 0);
  prevCount.textContent = 'Осталось: ' + before;
  nextCount.textContent = 'Осталось: ' + after;
  panel.hidden = false;
}

prevBtn.addEventListener('click', () => {
  if (problemIndex > 0) { problemIndex--; showProblem(); }
});
nextBtn.addEventListener('click', () => {
  if (problemIndex < problems.length - 1) { problemIndex++; showProblem(); }
});

// Когда плашка или верхний блок меняют высоту, переставляем подсказки, чтобы они не заходили под них
const stackObserver = new ResizeObserver(() => layoutHints());
stackObserver.observe(topStack);
stackObserver.observe(bottomStack);


// ===== Симулятор движения камеры =====
// Работает, пока API_URL пустой. Объекты лежат на большой «стене» (мире), а камера видит
// только её часть и плавно водится по ней, как будто телефон двигают в руке.
// Объекты въезжают в кадр и уезжают из него, поэтому проблемы появляются в плашке
// и сохраняются там после того, как ушли из кадра.
// Мир для каждой QR-метки один и тот же: тот же код — та же раскладка объектов.

const SIM_TICK_MS = 50;       // как часто обновлять кадр симуляции
const SIM_WORLD = 3;          // размер мира в кадрах: 3 × 3 кадра
const SIM_OBJECTS = 14;       // сколько объектов разбросано по миру
const SIM_SPEED = 0.01;       // скорость движения камеры, доля кадра за шаг
const SIM_SHAKE = 0.002;      // дрожание рук

const SIM_WARNINGS = [
  'Трещина вдоль сварного шва.',
  'Повреждена изоляция кабеля.',
  'Ослаблено болтовое соединение.',
  'Следы коррозии на корпусе.',
  'Нет защитного кожуха.',
  'Посторонний предмет в рабочей зоне.',
  'Истёк срок поверки манометра.',
  'Повреждена табличка с маркировкой.'
];

const SIM_PROBLEMS = [
  { problem: 'Превышена температура подшипника.', solution: 'Остановить двигатель, проверить смазку подшипника и дождаться остывания.' },
  { problem: 'Утечка масла из гидросистемы.', solution: 'Сбросить давление, найти место утечки и заменить уплотнение.' },
  { problem: 'Не работает аварийная кнопка.', solution: 'Вывести оборудование из работы и вызвать электрика для замены кнопки.' },
  { problem: 'Сильная вибрация насоса.', solution: 'Остановить насос, проверить крепление и балансировку рабочего колеса.' },
  { problem: 'Оголённый провод под напряжением.', solution: 'Обесточить участок, оградить зону и заизолировать провод.' },
  { problem: 'Давление выше допустимого.', solution: 'Открыть перепускной клапан и проверить регулятор давления.' }
];

let sim = null;

// Генератор случайных чисел, который из одной и той же строки даёт одну и ту же последовательность
function seededRandom(text) {
  let seed = 2166136261;
  for (let i = 0; i < text.length; i++) seed = Math.imul(seed ^ text.charCodeAt(i), 16777619);
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Слегка неровный четырёхугольник вокруг точки (cx, cy), в координатах мира
function randomQuad(rand, cx, cy) {
  const w = 0.12 + rand() * 0.2;
  const h = 0.07 + rand() * 0.12;
  const j = () => (rand() - 0.5) * 0.05;
  return [
    [cx - w / 2 + j(), cy - h / 2 + j()],
    [cx + w / 2 + j(), cy - h / 2 + j()],
    [cx + w / 2 + j(), cy + h / 2 + j()],
    [cx - w / 2 + j(), cy + h / 2 + j()]
  ];
}

function randomTarget() {
  return { x: Math.random() * (SIM_WORLD - 1), y: Math.random() * (SIM_WORLD - 1) };
}

function startSimulation(forTag) {
  if (sim && sim.tag === forTag) return;   // уже идёт для этой метки
  stopSimulation();

  const rand = seededRandom(forTag);
  const objects = [];
  for (let i = 0; i < SIM_OBJECTS; i++) {
    const isProblem = rand() < 0.4;
    const cx = 0.2 + rand() * (SIM_WORLD - 0.4);
    const cy = 0.2 + rand() * (SIM_WORLD - 0.4);
    const obj = { id: (isProblem ? 'p' : 'w') + (i + 1), kind: isProblem ? 'problem' : 'warning', points: randomQuad(rand, cx, cy) };
    if (isProblem) Object.assign(obj, SIM_PROBLEMS[Math.floor(rand() * SIM_PROBLEMS.length)]);
    else obj.problem = SIM_WARNINGS[Math.floor(rand() * SIM_WARNINGS.length)];
    objects.push(obj);
  }

  // Камера — левый верхний угол видимого кадра в координатах мира
  const center = (SIM_WORLD - 1) / 2;
  sim = { tag: forTag, objects, cam: { x: center, y: center }, target: randomTarget(), pause: 0 };
  sim.timer = setInterval(simulationStep, SIM_TICK_MS);
  simulationStep();
}

function stopSimulation() {
  if (sim) clearInterval(sim.timer);
  sim = null;
}

function simulationStep() {
  if (!sim || sim.tag !== tag) return;
  const cam = sim.cam;

  // Плавно ведём камеру к цели; дойдя, немного стоим и выбираем новую
  if (sim.pause > 0) {
    sim.pause--;
  } else {
    const dx = sim.target.x - cam.x;
    const dy = sim.target.y - cam.y;
    const dist = Math.hypot(dx, dy);
    if (dist < SIM_SPEED) {
      sim.target = randomTarget();
      sim.pause = Math.floor(Math.random() * 40);   // до 2 секунд на месте
    } else {
      cam.x += (dx / dist) * SIM_SPEED;
      cam.y += (dy / dist) * SIM_SPEED;
    }
  }
  const shakeX = (Math.random() - 0.5) * SIM_SHAKE;
  const shakeY = (Math.random() - 0.5) * SIM_SHAKE;

  // Переводим объекты в координаты кадра и оставляем те, что хоть одним углом в кадре
  const warnings = [];
  const seenProblems = [];
  for (const obj of sim.objects) {
    const points = obj.points.map(([x, y]) => [x - cam.x + shakeX, y - cam.y + shakeY]);
    const inFrame = points.some(([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1);
    if (!inFrame) continue;
    if (obj.kind === 'warning') warnings.push({ id: obj.id, points, problem: obj.problem });
    else seenProblems.push({ id: obj.id, points, problem: obj.problem, solution: obj.solution });
  }

  setIssues(warnings);
  mergeProblems(seenProblems);
}


// ===== Запуск =====

resizeCanvas();
if (POLL_MS > 0) setInterval(loadIssues, POLL_MS);

if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
  startCamera();
  initScanner()
    .then(scanLoop)
    .catch(err => {
      console.error(err);
      showToast('Не удалось запустить сканер QR-кодов');
    });
} else {
  showMessage('Браузер не даёт доступ к камере. Страница должна быть открыта по адресу https://, а не как файл.', false);
}
