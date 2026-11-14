// Параметры оборудования: плашка на экране камеры и экран параметров поверх неё.
// camera.js вызывает window.onQrCodeDetected(тег), когда в кадре появился QR-код.
(() => {
  'use strict';

  // ===== Настройки =====

  // Адрес бэкенда с параметрами: https://api.{домен сайта}/devices.
  // Запрос: GET https://api.{домен сайта}/devices/{номер}, где номер — текст QR-кода.
  // Например, сайт открыт на pump.ru → запрос на https://api.pump.ru/devices/ASK-014.
  // Для локальной проверки адрес можно задать вручную в index.html перед скриптами:
  //   <script>window.PUMP_API_BASE_URL = 'http://localhost:3000/devices';</script>
  
  // Адрес бэкенда задаётся в index.html (window.PUMP_SERVER); пусто — тот же сервер, что и страница
  const API_BASE = (window.PUMP_SERVER || '').replace(/\/$/, '');

  // Как часто обновлять параметры (показания датчиков) текущего тега, в миллисекундах.
  // Обновляются и плашка вверху, и открытый экран параметров.
  const REFRESH_MS = 2000;

  // Сколько ждать ответа сервера, в миллисекундах
  const TIMEOUT_MS = 10000;

  // Название, если бэкенд не прислал поле name
  const DEFAULT_NAME = 'Насос';

  // Формат ответа бэкенда (Device_Dto в dtos.py):
  //   {
  //     tag: 'AMS_1',
  //     name: 'Насосная станция',              // название для шапки и плашки
  //     parameters: [
  //       { parameter: 'Температура вала', value: '84', unit: '°C',
  //         state: 'normal' | 'warning' | 'error', norm: '75', operator: '≤' | '≥' | '' }
  //     ]
  //   }
  // Принимаются и прежние названия полей: properties вместо parameters, label вместо parameter.
  // state решает, как показать значение: normal — обычным цветом, error — красным,
  // warning — жёлто-коричневым. У отклонений под значением пишется норма.


  const byId = id => document.getElementById(id);

  const card = byId('equipmentCard');
  const cardName = byId('equipmentName');
  const cardId = byId('equipmentId');
  const warningCount = byId('warningCount');
  const errorCount = byId('errorCount');

  const screen = byId('parameters');
  const backBtn = byId('parametersBack');
  const titleName = byId('parametersName');
  const titleId = byId('parametersId');
  const list = byId('parametersList');
  const note = byId('parametersNote');
  const errorBox = byId('parametersError');
  const errorText = byId('parametersErrorText');
  const retryBtn = byId('parametersRetry');

  let tag = null;        // текущий тег оборудования
  let data = null;       // последние успешно загруженные параметры этого тега
  let loadError = '';    // текст ошибки последней загрузки, если она не удалась
  let loading = false;
  let request = 0;       // номер запроса: ответ на устаревший запрос отбрасывается


  // ===== Данные =====

  async function fetchParameters(forTag) {
    console.log("Asasas")
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(`${API_BASE}/devices/${encodeURIComponent(forTag)}`, { cache: 'no-store' });
      console.log(response);
      if (!response.ok) {
        throw new Error(response.status === 404 ? 'Оборудование с таким тегом не найдено.' : 'Сервер не смог вернуть параметры.');
      }
      const result = await response.json();
      // Бэкенд (main.py) присылает { tag, name, parameters: [{ parameter, … }] }
      const list = result && (result.parameters ?? result.properties);
      if (!Array.isArray(list)) throw new Error('Сервер вернул параметры в неизвестном формате.');
      return { ...result, properties: list };
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Сервер не ответил. Проверьте соединение.');
      if (error instanceof TypeError) throw new Error('Нет связи с сервером. Проверьте соединение.');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function load() {
    if (!tag) return;
    const current = ++request;
    const forTag = tag;
    loading = true;
    render();
    try {
      const result = await fetchParameters(forTag);
      if (current !== request) return;   // пока ждали ответ, тег сменился
      data = result;
      loadError = '';
    } catch (error) {
      if (current !== request) return;
      // Прежние данные этого тега остаются на экране, если они были
      loadError = error.message;
    }
    loading = false;
    render();
  }


  // ===== Отображение =====

  function numberOf(value) {
    if (typeof value === 'number') return value;
    if (typeof value !== 'string' || !value.trim()) return NaN;
    return Number(value.replace(/\s/g, '').replace(',', '.'));
  }

  // Числа показываем по-русски: 0.12 → 0,12. Текстовые значения — как есть.
  function formatValue(value) {
    const number = numberOf(value);
    return Number.isFinite(number)
      ? new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(number)
      : String(value ?? '—');
  }

  // Состояние параметра. Обычно его присылает бэкенд; если не прислал, сравниваем с нормой.
  function stateOf(item) {
    if (['normal', 'warning', 'error'].includes(item.state)) return item.state;
    const value = numberOf(item.value);
    const norm = numberOf(item.norm);
    if (Number.isFinite(value) && Number.isFinite(norm)) {
      if (['≤', '<='].includes(item.operator)) return value <= norm ? 'normal' : 'error';
      if (['≥', '>='].includes(item.operator)) return value >= norm ? 'normal' : 'error';
    }
    return 'normal';
  }

  function element(tagName, className, text) {
    const node = document.createElement(tagName);
    if (className) node.className = className;
    if (text != null) node.textContent = text;   // textContent: данные с бэкенда не становятся разметкой
    return node;
  }

  function renderRow(item) {
    const state = stateOf(item);
    const row = element('div', 'param-row' + (state === 'normal' ? '' : ' ' + state));
    row.setAttribute('role', 'listitem');
    row.append(element('span', 'param-label', item.parameter ?? item.label ?? ''));

    const reading = element('div', 'param-reading');
    reading.append(element('p', 'param-value', [formatValue(item.value), item.unit].filter(Boolean).join(' ')));
    // Норма пишется только под значением, которое от неё отклонилось
    const hasNorm = item.norm != null && String(item.norm).trim() !== '';
    if (state !== 'normal' && hasNorm) {
      reading.append(element('p', 'param-norm', ['Норма', item.operator, formatValue(item.norm), item.unit].filter(Boolean).join(' ')));
    }
    row.append(reading);
    return row;
  }

  function render() {
    card.hidden = !tag;
    if (!tag) return;

    const properties = data ? data.properties.filter(item => item && typeof item === 'object') : [];
    const name = data ? (data.name || data.model || DEFAULT_NAME) : loading ? 'Загрузка…' : 'Параметры недоступны';
    const warnings = properties.filter(item => stateOf(item) === 'warning').length;
    const errors = properties.filter(item => stateOf(item) === 'error').length;

    // Плашка на экране камеры
    cardName.textContent = name;
    cardId.textContent = tag;
    warningCount.textContent = warnings;
    warningCount.hidden = !warnings;
    errorCount.textContent = errors;
    errorCount.hidden = !errors;
    card.setAttribute('aria-label',
      `${name}, ${tag}. Предупреждений: ${warnings}, отклонений: ${errors}. Открыть параметры`);

    // Экран параметров
    titleName.textContent = name;
    titleId.textContent = tag;
    list.replaceChildren(...properties.map(renderRow));
    errorText.textContent = loadError;
    errorBox.hidden = !loadError;
    retryBtn.disabled = loading;
    const noteText = data
      ? (properties.length ? '' : 'Параметры пока не поступили.')
      : (loading ? 'Загружаем параметры…' : '');
    note.textContent = noteText;
    note.hidden = !noteText;
  }


  // ===== Открытие и закрытие параметров =====

  function isOpen() {
    return !screen.hidden;
  }

  function openParameters() {
    if (isOpen() || !tag) return;
    screen.hidden = false;
    // Системная кнопка «Назад» закрывает параметры, а не уводит со страницы
    history.pushState({ pumpParameters: true }, '');
    backBtn.focus();
    if (!loading) load();   // при открытии показываем свежие данные
  }

  function closeParameters(fromHistory) {
    if (!isOpen()) return;
    screen.hidden = true;
    if (!fromHistory && history.state && history.state.pumpParameters) history.back();
    card.focus();
  }

  card.addEventListener('click', openParameters);
  backBtn.addEventListener('click', () => closeParameters(false));
  retryBtn.addEventListener('click', load);
  window.addEventListener('popstate', () => closeParameters(true));
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeParameters(false); });


  // ===== Связь с камерой =====

  // Вызывается из camera.js, когда в кадре появился QR-код.
  // Тот же тег данные не сбрасывает; загрузка повторяется, только если прошлая не удалась.
  function onQrCodeDetected(newTag) {
    const next = typeof newTag === 'string' ? newTag.trim() : '';
    if (!next) return;
    if (next === tag) {
      if (loadError && !loading) load();
      return;
    }
    tag = next;
    data = null;
    loadError = '';
    closeParameters(false);
    load();
  }

  window.onQrCodeDetected = onQrCodeDetected;
  window.PumpPanel = { isOpen, open: openParameters, close: () => closeParameters(false) };

  {
    // Автообновление; скрытая вкладка сервер не опрашивает
    setInterval(() => { if (tag && !document.hidden && !loading) load(); }, REFRESH_MS);
    document.addEventListener('visibilitychange', () => { if (tag && !document.hidden && !loading) load(); });
  }

  render();
})();
