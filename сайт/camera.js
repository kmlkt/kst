// Камера, QR-сканер и контуры поверх видео (index.html).
// Работает вместе с script.js:
//   • найденный QR-код становится текущим тегом и передаётся в window.onQrCodeDetected(тег) —
//     script.js загружает параметры и показывает плашку оборудования;
//   • пока тег известен, кадры камеры по одному отправляются на анализ (POST /ai/{тег}),
//     а результат рисуется поверх видео: контур насоса, жёлтые предупреждения
//     и красные проблемы в плашке внизу.
(() => {
  'use strict';

  // ===== Настройки =====

  // Анализ кадра: POST {адрес}/{тег}, в теле — кадр камеры в поле image (JPEG, multipart/form-data).
  // По умолчанию '/ai' — тот же сервер, что отдаёт страницу. Другой адрес можно задать в index.html:
  //   <script>window.PUMP_ANALYSIS_URL = 'https://api.example.ru/ai';</script>
  // Пустая строка выключает анализ: камера только сканирует QR-коды.
  const ANALYSIS_URL = (window.PUMP_ANALYSIS_URL ?? ((window.PUMP_SERVER || '').replace(/\/$/, '') + '/ai')).replace(/\/$/, '');

  // Тег при открытии страницы (index.html, window.PUMP_DEFAULT_TAG): в режиме отладки AMS_1.
  // Сканер QR-кодов работает всегда, и отсканированный код заменяет этот тег.
  const DEFAULT_TAG = (window.PUMP_DEFAULT_TAG || '').trim();

  // Пауза между анализами, в миллисекундах. Следующий кадр отправляется только после ответа
  // на предыдущий, поэтому запросы не копятся, даже если сервер считает долго.
  const ANALYSIS_INTERVAL_MS = 1000;

  // Сколько ждать ответа анализа, в миллисекундах
  const ANALYSIS_TIMEOUT_MS = 30000;

  // Наибольшая сторона отправляемого кадра в пикселях и качество JPEG (0..1)
  const FRAME_MAX_SIDE = 1920;
  const FRAME_JPEG_QUALITY = 0.85;

  // Цвет контура насоса (device_points)
  const DEVICE_COLOR = 'rgba(255, 255, 255, 0.9)';

  // Необязательный адрес, по которому можно получить название и решение проблемы по её id.
  // Нужен, только если основной ответ присылает одни id без текста. {id} заменяется на id проблемы.
  // Например: const PROBLEM_DETAILS_URL = '/api/problems/{id}';
  const PROBLEM_DETAILS_URL = '';

  // true — если задней камеры нет (например, на ПК), использовать любую доступную.
  // Для тестов на компьютере. На смартфонах в рабочей версии поставьте false.
  const ALLOW_ANY_CAMERA = true;

  // Как часто проверять кадр на наличие QR-кода, в миллисекундах
  const SCAN_INTERVAL_MS = 300;

  // Если QR-код пропал из кадра дольше, чем на это время, и появился снова,
  // он отправляется в панель ещё раз (например, чтобы повторить неудачный поиск)
  const RESCAN_AFTER_MS = 1500;

  // Запасной распознаватель QR для браузеров без BarcodeDetector (например, Safari на iPhone)
  const JSQR_URL = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';

  const WARNING_COLOR = '#FFD400';   // жёлтые контуры-предупреждения
  const PROBLEM_COLOR = '#FF4D4D';   // красные проблемы из плашки и стрелки у выбранной

  // Как вписывать кадр камеры в область камеры:
  // 'contain' — кадр виден целиком, все линии на экране, но могут быть чёрные полосы;
  // 'cover'   — кадр заполняет область без полос, но края кадра (и линии на них) обрезаются;
  // 'auto'    — 'cover', если при этом видно не меньше AUTO_COVER_MIN кадра, иначе 'contain'.
  const VIDEO_FIT = 'auto';
  const AUTO_COVER_MIN = 0.7;

  // Панель отладки: статус анализа, выбор фото или видео вместо камеры, пауза, сохранение кадра.
  // Включается в index.html (window.PUMP_DEBUG): по умолчанию на компьютере, ?debug=1 / ?debug=0.
  const DEBUG = Boolean(window.PUMP_DEBUG);

  // Ответ анализа (Analysis_Dto в dtos.py):
  //   {
  //     device_points: [{ x, y }, …],                                 // контур насоса
  //     warnings: [{ label, points: [{ x, y }, …] }],                 // жёлтые контуры с подписью
  //     errors:   [{ code, label, advice, points: [{ x, y }, …] }]    // красные: в плашке label и advice
  //   }
  // x и y — пиксели отправленного кадра. Точки контура идут по порядку, последняя соединяется
  // с первой. У ошибки points может быть пустым: тогда она есть в плашке, но без контура.
  // Ошибки различаются по code: та же ошибка в следующем ответе не дублируется в плашке.


  const byId = id => document.getElementById(id);

  // Текущий тег оборудования: тот, что определила панель (script.js)
  let tag = null;


  // ===== Камера (задняя) =====

  const viewport = byId('cameraViewport');
  const video = byId('video');
  const message = byId('cameraMessage');
  const messageText = byId('cameraMessageText');
  const retryBtn = byId('cameraRetry');
  const toast = byId('toast');

  let stream = null;
  let sourceName = 'камера';   // что сейчас вместо камеры: 'камера' или имя файла

  function showMessage(text, withRetry) {
    messageText.textContent = text;
    retryBtn.hidden = !withRetry;
    message.hidden = false;
  }

  let toastTimer = null;
  function showToast(text) {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 4000);
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
    stopFileSource();
  }

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
    sourceName = 'камера';
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
      if ('wakeLock' in navigator) await navigator.wakeLock.request('screen');
    } catch (e) { /* не критично */ }
  }

  retryBtn.addEventListener('click', startCamera);

  // При повороте телефона перезапрашиваем камеру под новую ориентацию
  let orientationTimer = null;
  window.matchMedia('(orientation: portrait)').addEventListener('change', () => {
    clearTimeout(orientationTimer);
    orientationTimer = setTimeout(() => { if (stream && !fileSource) startCamera(); }, 300);
  });

  // После возврата на вкладку камера могла отключиться — включаем снова
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || fileSource) return;
    const track = stream && stream.getVideoTracks()[0];
    if (!track || track.readyState === 'ended') startCamera();
    else keepScreenOn();
  });


  // ===== Фото или видео вместо камеры (отладка) =====
  // Файл рисуется в холст, а поток холста подаётся в тот же <video>, что и камера.
  // Поэтому сканер, анализ и отрисовка работают с файлом точно так же, как с камерой.

  let fileSource = null;   // { url, media, raf }

  function stopFileSource() {
    if (!fileSource) return;
    cancelAnimationFrame(fileSource.raf);
    if (fileSource.media.pause) fileSource.media.pause();
    URL.revokeObjectURL(fileSource.url);
    fileSource = null;
  }

  async function startFileSource(file) {
    const url = URL.createObjectURL(file);
    let media;
    let width;
    let height;
    try {
      if (file.type.startsWith('video/')) {
        media = document.createElement('video');
        media.muted = true;
        media.loop = true;
        media.playsInline = true;
        media.src = url;
        await media.play();
        width = media.videoWidth;
        height = media.videoHeight;
      } else {
        media = new Image();
        media.src = url;
        await media.decode();
        width = media.naturalWidth;
        height = media.naturalHeight;
      }
    } catch (err) {
      URL.revokeObjectURL(url);
      showToast('Не удалось открыть файл: ' + file.name);
      return;
    }

    stopCamera();
    const source = document.createElement('canvas');
    source.width = width;
    source.height = height;
    const sourceCtx = source.getContext('2d');
    fileSource = { url, media, raf: 0 };
    const draw = () => {
      sourceCtx.drawImage(media, 0, 0, width, height);
      fileSource.raf = requestAnimationFrame(draw);
    };
    draw();
    stream = source.captureStream(30);
    video.srcObject = stream;
    sourceName = file.name;
    message.hidden = true;
    console.info(`Источник кадров: ${file.name}, ${width}×${height}`);
  }


  // ===== Сканирование QR-кодов =====

  let detector = null;          // встроенный BarcodeDetector, если есть
  const scanCanvas = document.createElement('canvas');
  const scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true });
  let lastScanned = null;       // последний код, который был в кадре
  let lastSeenAt = 0;           // когда код в последний раз был в кадре

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
      const code = window.jsQR(scanCtx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
      return code ? code.data : null;
    }
    return null;
  }

  async function scanLoop() {
    // Пока открыты параметры, QR-коды не ищем: тег не должен смениться под ними
    if (document.visibilityState === 'visible' && !parametersOpen()) {
      try {
        const value = ((await scanFrame()) || '').trim();
        if (value) {
          const now = Date.now();
          // Тот же код, пока он не уходил из кадра, повторно не отправляем
          const isNew = value !== lastScanned || now - lastSeenAt > RESCAN_AFTER_MS;
          lastScanned = value;
          lastSeenAt = now;
          if (isNew) setTag(value);
        }
      } catch (err) {
        console.warn('Ошибка сканирования QR:', err);
      }
    }
    setTimeout(scanLoop, SCAN_INTERVAL_MS);
  }


  // ===== Текущий тег =====

  const scanPrompt = byId('scanPrompt');

  function parametersOpen() {
    return Boolean(window.PumpPanel && window.PumpPanel.isOpen());
  }

  // Вызывается, когда в кадре появился QR-код. Новый тег сбрасывает контуры и проблемы
  // прежнего; тот же тег ничего не сбрасывает.
  function setTag(newTag) {
    if (newTag !== tag) {
      tag = newTag;
      scanPrompt.hidden = true;
      if (DEBUG) console.info('Тег:', tag);
      // Вибрация — только на найденный QR-код (без касания экрана браузер её всё равно блокирует)
      if (navigator.vibrate && newTag !== DEFAULT_TAG) navigator.vibrate(50);
      clearAnalysis();
    }
    // script.js загружает параметры этого тега и показывает плашку оборудования
    if (typeof window.onQrCodeDetected === 'function') window.onQrCodeDetected(newTag);
  }


  // ===== Контуры и подсказки поверх видео =====

  const canvas = byId('overlay');
  const ctx = canvas.getContext('2d');
  const hintsLayer = byId('hints');
  const topStack = byId('topStack');
  const bottomStack = byId('bottomStack');

  let issues = [];
  let devicePoints = null;      // контур насоса из последнего анализа, доли кадра
  const hintEls = new Map();    // id контура → элемент подсказки

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    render();
  }

  // Переводит точку кадра (доли 0..1) в пиксели области камеры с учётом того,
  // как видео в неё вписано (cover обрезает края кадра).
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

    // Контур насоса: тонкая линия без заливки, под остальными контурами
    const device = devicePoints && devicePoints.map(toScreen);
    if (device && device.length >= 3 && !device.includes(null)) {
      tracePolygon(device);
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.stroke();
      ctx.lineWidth = 2;
      ctx.strokeStyle = DEVICE_COLOR;
      ctx.stroke();
    }

    for (const issue of issues) {
      const pts = screenPoints(issue);
      if (!pts) continue;
      const color = issue.color || WARNING_COLOR;
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
      el.className = 'cam-hint';
      el.style.color = issue.color || WARNING_COLOR;
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
  // туда, где она помещается в области камеры и меньше всего перекрывает другие подсказки.
  function layoutHints() {
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    const margin = 8;
    const gap = 10;
    const placed = [];
    // Подсказки не заходят под верхний блок и под плашку проблем
    const origin = canvas.getBoundingClientRect().top;
    const topRect = topStack.getBoundingClientRect();
    const bottomRect = bottomStack.getBoundingClientRect();
    const topLimit = Math.max(margin, (topRect.height ? topRect.bottom - origin : 0) + margin);
    const bottomLimit = Math.min(H - margin, bottomRect.top - origin - margin);

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
        const shift = Math.abs(x - c.x) + Math.abs(y - c.y);   // насколько пришлось сдвинуть внутрь области
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

  // Проблемы из плашки — замкнутые красные четырёхугольники. Рисуются только проблемы,
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

  // Отладочная строка: размеры кадра и области камеры, какая доля кадра видна,
  // и предупреждение, если координаты с бэкенда похожи на пиксели, а не на доли 0..1
  const debugEl = byId('debug');

  // Сведения о последнем анализе для отладочной строки
  const analysisStats = { status: 'ждём кадр', ms: 0, at: null, count: 0, summary: '' };

  function updateDebug() {
    if (!DEBUG) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    const lines = [];
    lines.push(`Источник: ${sourceName}` + (vw ? `, кадр ${vw}×${vh}` : ', кадра ещё нет'));
    if (vw && vh) {
      const fit = getComputedStyle(video).objectFit;
      const scale = fit === 'contain' ? Math.min(W / vw, H / vh) : Math.max(W / vw, H / vh);
      const seenW = Math.round(Math.min(1, W / (vw * scale)) * 100);
      const seenH = Math.round(Math.min(1, H / (vh * scale)) * 100);
      lines.push(`Экран ${W}×${H}, ${fit}, видно ${seenW}%×${seenH}% кадра`);
    }
    lines.push(`Тег: ${tag || '— (наведите на QR-код)'}` + (tag && tag === DEFAULT_TAG ? ' (по умолчанию)' : tag ? ' (из QR-кода)' : ''));
    lines.push(`Анализ: ${ANALYSIS_URL ? ANALYSIS_URL + '/{тег}' : 'выключен'}`);
    const time = analysisStats.at ? analysisStats.at.toLocaleTimeString('ru-RU') : '';
    lines.push(`Последний: ${analysisStats.status}` +
      (analysisStats.ms ? `, ${analysisStats.ms} мс` : '') + (time ? `, ${time}` : '') +
      (analysisStats.count ? `, всего ${analysisStats.count}` : '') + (analysisPaused ? ' · ПАУЗА' : ''));
    if (analysisStats.summary) lines.push(analysisStats.summary);
    debugEl.textContent = lines.join('\n');
    debugEl.hidden = false;
  }

  // Выбирает, как вписать кадр в область камеры (см. VIDEO_FIT)
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
    // Какая доля кадра останется видна, если заполнить область
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

  function isValidPoint(p) {
    return Array.isArray(p) && p.length >= 2 && isFinite(p[0]) && isFinite(p[1]);
  }

  let hintsKey = '';

  function setIssues(list) {
    issues = list
      .filter(i => i && Array.isArray(i.points) && i.points.length >= 3 && i.points.every(isValidPoint))
      .map((i, index) => ({ ...i, id: i.id ?? 'issue-' + index }));

    // Пересобираем подсказки, только если поменялся набор контуров или их текст,
    // иначе при частых обновлениях они бы мигали
    const key = issues.map(i => i.id + '\u0000' + (i.problem || '')).join('\u0001');
    if (key !== hintsKey) {
      hintsKey = key;
      buildHints();
    }
    render();
  }

  // Углы контура из ответа бэкенда: [{ x, y }, …] (или [[x, y], …]) → [[x, y], …]
  function toPoints(row) {
    if (!Array.isArray(row)) return null;
    return row.map(p => Array.isArray(p) ? [Number(p[0]), Number(p[1])] : [Number(p && p.x), Number(p && p.y)]);
  }

  // Приводит список из ответа к внутреннему виду: { id, problem, solution, points }
  function normalizeItems(list, kind) {
    const sameLabel = new Map();
    return (Array.isArray(list) ? list : []).filter(Boolean).map(item => {
      const label = String(item.label ?? item.problem ?? item.name ?? '');
      // Без id различаем проблемы по label; вторая с тем же label в одном ответе получает «#2»
      const n = (sameLabel.get(label) || 0) + 1;
      sameLabel.set(label, n);
      return {
        id: item.id ?? item.code ?? kind + ':' + label + (n > 1 ? '#' + n : ''),
        problem: label,
        solution: String(item.advice ?? item.solution ?? ''),
        points: toPoints(item.row ?? item.points)
      };
    });
  }

  // Разбирает ответ анализа. frameW и frameH — размер отправленного кадра:
  // по ним пиксели переводятся в доли кадра.
  function applyIssues(data, frameW, frameH) {
    let warningList;
    let errorList;
    if (Array.isArray(data)) {
      // Один общий список: ошибки — элементы с advice (или с type/state: 'error')
      const isError = i => i && (i.advice != null || i.type === 'error' || i.state === 'error');
      errorList = data.filter(isError);
      warningList = data.filter(i => i && !isError(i));
    } else {
      warningList = data.warning ?? data.warnings ?? data.issues;
      errorList = data.error ?? data.errors ?? data.problems;
    }
    const warnings = normalizeItems(warningList, 'w');
    const errors = normalizeItems(errorList, 'e');
    const device = Array.isArray(data) ? null : toPoints(data.device_points);

    // Пиксели отправленного кадра → доли кадра
    const allPoints = [...warnings, ...errors].flatMap(i => i.points || []).concat(device || []);
    for (const p of allPoints) {
      p[0] /= frameW;
      p[1] /= frameH;
    }

    devicePoints = device && device.length >= 3 && device.every(isValidPoint) ? device : null;
    setIssues(warnings);
    mergeProblems(errors);
  }



  // ===== Анализ кадров =====

  const frameCanvas = document.createElement('canvas');
  const frameCtx = frameCanvas.getContext('2d');
  let lastAnalysisError = '';
  let lastFrame = null;        // последний отправленный кадр (для «Сохранить кадр»)
  let analysisPaused = false;  // пауза из панели отладки
  let analyzing = false;

  // Снимает текущий кадр камеры в JPEG. Возвращает { blob, width, height } или null.
  function captureFrame() {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!stream || video.readyState < 2 || !vw || !vh) return Promise.resolve(null);
    const scale = Math.min(1, FRAME_MAX_SIDE / Math.max(vw, vh));
    const width = Math.round(vw * scale);
    const height = Math.round(vh * scale);
    frameCanvas.width = width;
    frameCanvas.height = height;
    frameCtx.drawImage(video, 0, 0, width, height);
    return new Promise(resolve => {
      frameCanvas.toBlob(blob => resolve(blob ? { blob, width, height } : null), 'image/jpeg', FRAME_JPEG_QUALITY);
    });
  }

  // Отправляет один кадр на анализ и рисует результат
  async function analyzeFrame() {
    const forTag = tag;
    const frame = await captureFrame();
    if (!frame) return;

    lastFrame = frame;

    const body = new FormData();
    body.append('image', frame.blob, 'frame.jpg');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ANALYSIS_TIMEOUT_MS);
    const url = `${ANALYSIS_URL}/${encodeURIComponent(forTag)}`;
    const started = performance.now();
    analysisStats.status = 'отправлен…';
    updateDebug();
    try {
      const res = await fetch(url, { method: 'POST', body, signal: controller.signal, cache: 'no-store' });
      const ms = Math.round(performance.now() - started);
      if (!res.ok) {
        // Текст ошибки FastAPI ({"detail": …}) — в консоль и в отладочную строку
        const detail = await res.text().catch(() => '');
        analysisStats.summary = `HTTP ${res.status}: ${detail.slice(0, 200)}`;
        Object.assign(analysisStats, { status: `ошибка HTTP ${res.status}`, ms, at: new Date() });
        console.warn(`Анализ ${forTag}: HTTP ${res.status}`, detail);
        throw new Error(res.status === 404 ? 'Оборудование не найдено, анализ недоступен' : `Сервер не смог проанализировать кадр (HTTP ${res.status})`);
      }
      const data = await res.json();
      analysisStats.count++;
      Object.assign(analysisStats, { status: 'HTTP 200', ms, at: new Date() });
      analysisStats.summary = [
        `Насос: ${data.device_points?.length ? data.device_points.length + ' точек' : 'не найден'}`,
        `жёлтых: ${data.warnings?.length ?? 0}`,
        `красных: ${data.errors?.length ?? 0}`
      ].join(', ') + (data.warnings?.length ? '\n  ' + data.warnings.map(w => w.label).join(', ') : '');
      if (DEBUG) {
        console.groupCollapsed(`Анализ ${forTag}: ${ms} мс, кадр ${frame.width}×${frame.height}`);
        console.log(data);
        console.groupEnd();
      }
      if (forTag !== tag) return;   // пока ждали ответ, отсканировали другой QR-код
      applyIssues(data, frame.width, frame.height);
      lastAnalysisError = '';
    } catch (err) {
      if (err.name === 'AbortError' || err instanceof TypeError) {
        Object.assign(analysisStats, {
          status: err.name === 'AbortError' ? `нет ответа за ${ANALYSIS_TIMEOUT_MS / 1000} с` : 'нет связи (сеть или CORS)',
          ms: 0, at: new Date(), summary: `Адрес: ${url}`
        });
      }
      if (forTag !== tag) return;
      const message = err.name === 'AbortError' ? 'Сервер долго анализирует кадр'
        : err instanceof TypeError ? 'Нет связи с сервером анализа' : err.message;
      console.error('Ошибка анализа кадра:', err);
      // Контуры прошлого кадра уже не соответствуют картинке — убираем их
      devicePoints = null;
      setIssues([]);
      mergeProblems([]);
      // Одинаковую ошибку не показываем каждую секунду
      if (message !== lastAnalysisError) showToast(message);
      lastAnalysisError = message;
    } finally {
      clearTimeout(timeout);
      updateDebug();
    }
  }

  async function analyzeOnce() {
    if (analyzing || !tag) return;
    analyzing = true;
    try {
      await analyzeFrame();
    } catch (err) {
      console.error('Ошибка анализа кадра:', err);
    } finally {
      analyzing = false;
    }
  }

  // Кадры анализируются по одному: следующий — только после ответа на предыдущий
  async function analysisLoop() {
    const ready = tag && !analysisPaused && document.visibilityState === 'visible' && !parametersOpen();
    if (ready) await analyzeOnce();
    setTimeout(analysisLoop, ANALYSIS_INTERVAL_MS);
  }

  // Новый тег: всё, что нашёл анализ для прошлого оборудования, убираем
  function clearAnalysis() {
    devicePoints = null;
    lastAnalysisError = '';
    setIssues([]);
    clearProblems();
  }


  // ===== Панель отладки =====

  function setupDebug() {
    document.body.classList.add('debug-mode');
    const bar = byId('debugBar');
    const pauseBtn = byId('debugPause');
    const onceBtn = byId('debugOnce');
    bar.hidden = false;

    byId('debugFile').addEventListener('change', event => {
      const file = event.target.files && event.target.files[0];
      if (file) startFileSource(file);
      event.target.value = '';   // тот же файл можно выбрать снова
    });
    byId('debugCamera').addEventListener('click', startCamera);
    pauseBtn.addEventListener('click', () => {
      analysisPaused = !analysisPaused;
      pauseBtn.textContent = analysisPaused ? 'Продолжить анализ' : 'Пауза анализа';
      pauseBtn.classList.toggle('active', analysisPaused);
      onceBtn.hidden = !analysisPaused;
      updateDebug();
    });
    onceBtn.addEventListener('click', analyzeOnce);
    // Последний отправленный кадр — чтобы повторить запрос на бэкенде тем же изображением
    byId('debugClear').addEventListener('click', () => {
      clearProblems();
      showToast('Список проблем очищен');
    });
    byId('debugSave').addEventListener('click', () => {
      if (!lastFrame) { showToast('Кадр ещё не отправлялся'); return; }
      const link = document.createElement('a');
      link.href = URL.createObjectURL(lastFrame.blob);
      link.download = `frame-${tag || 'notag'}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.jpg`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    });

    // Для экспериментов из консоли браузера: PumpDebug.setTag('AMS_2'), PumpDebug.analyze() …
    window.PumpDebug = {
      setTag,
      analyze: analyzeOnce,
      pause: () => { if (!analysisPaused) pauseBtn.click(); },
      resume: () => { if (analysisPaused) pauseBtn.click(); },
      lastFrame: () => lastFrame,
      clearProblems,
      stats: () => ({ ...analysisStats })
    };
    console.info('Отладка включена. Команды: PumpDebug.setTag(тег), PumpDebug.analyze(), PumpDebug.pause(), PumpDebug.resume()');
    updateDebug();
  }


  // ===== Плашка с проблемами внизу области камеры =====

  const panel = byId('problemPanel');
  const panelProblem = byId('panelProblem');
  const panelSolution = byId('panelSolution');
  const prevSide = byId('prevSide');
  const nextSide = byId('nextSide');
  const prevBtn = byId('prevProblem');
  const nextBtn = byId('nextProblem');
  const prevCount = byId('prevCount');
  const nextCount = byId('nextCount');

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

  // Очищает список проблем (при смене тега и кнопкой в панели отладки)
  function clearProblems() {
    problems = [];
    problemById.clear();
    visibleProblemIds = new Set();
    problemIndex = 0;
    showProblem();
  }

  function showProblem() {
    if (!problems.length) {
      panel.hidden = true;
      render();
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
    render();   // стрелки переезжают к выбранной проблеме
  }

  prevBtn.addEventListener('click', () => {
    if (problemIndex > 0) { problemIndex--; showProblem(); }
  });
  nextBtn.addEventListener('click', () => {
    if (problemIndex < problems.length - 1) { problemIndex++; showProblem(); }
  });


  // ===== Запуск =====

  // Перерисовываем, когда меняется размер окна или высота плашек внизу
  const sizeObserver = new ResizeObserver(resizeCanvas);
  sizeObserver.observe(viewport);
  sizeObserver.observe(topStack);
  sizeObserver.observe(bottomStack);
  video.addEventListener('loadedmetadata', render);
  video.addEventListener('resize', render);

  resizeCanvas();
  if (DEBUG) setupDebug();

  // Тег по умолчанию (в режиме отладки): оборудование известно сразу, QR-код его сменит
  if (DEFAULT_TAG) setTag(DEFAULT_TAG);
  if (ANALYSIS_URL) analysisLoop();

  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    startCamera();
  } else {
    showMessage('Браузер не даёт доступ к камере: страница должна быть открыта по адресу https:// или http://localhost.' +
      (DEBUG ? ' Можно выбрать фото или видео кнопкой вверху.' : ''), false);
  }

  // Сканер QR-кодов работает всегда, в том числе с фото или видео из панели отладки
  initScanner()
    .then(scanLoop)
    .catch(err => {
      console.error(err);
      showToast('Не удалось запустить сканер QR-кодов');
    });
})();
