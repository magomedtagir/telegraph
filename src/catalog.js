'use strict';

// Загрузка каталога с Яндекс.Диска через REST API (бесплатен, в отличие от WebDAV)
// + кэш в памяти + снапшот на диске (бот переживает недоступность Яндекса и рестарты).

const fs = require('fs');
const path = require('path');
const { normalizeCatalog } = require('./normalize');

// В Node 18+ fetch встроен; на старых системах (Windows Server 2012 R2 → Node 16)
// используем пакет node-fetch. Динамический import, т.к. node-fetch v3 — ESM-only.
const fetchFn = (typeof fetch === 'function')
  ? fetch
  : ((...args) => import('node-fetch').then(({ default: f }) => f(...args)));

// AbortSignal.timeout есть с Node 16.14, но подстрахуемся на случай ещё более старых
const abortTimeout = (ms) => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout
  ? AbortSignal.timeout(ms)
  : undefined);

const API_BASE = 'https://cloud-api.yandex.net/v1/disk';
const DATA_DIR = path.join(__dirname, '..', 'data');
const SNAPSHOT = path.join(DATA_DIR, 'catalog-cache.json');
const HIDDEN_FILE = path.join(DATA_DIR, 'hidden_imei.txt');

// Number(...) || 300 превратил бы CACHE_TTL_SECONDS=0 (кэш выключен) в 300 —
// поэтому 0 и положительные значения принимаем явно.
const TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS);
const TTL_MS = (Number.isFinite(TTL_SECONDS) && TTL_SECONDS >= 0 ? TTL_SECONDS : 300) * 1000;

let mem = { items: null, ts: 0 };
let inFlight = null; // общий промис активной загрузки — гасит «стадо» одновременных запросов

function hiddenImeiSet() {
  try {
    return new Set(
      fs.readFileSync(HIDDEN_FILE, 'utf8')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith('#')),
    );
  } catch {
    return new Set();
  }
}

async function download() {
  const token = process.env.YANDEX_OAUTH_TOKEN;
  const diskPath = process.env.YANDEX_DISK_PATH || '/bot-data/phone.json';
  if (!token) throw new Error('YANDEX_OAUTH_TOKEN не задан (.env)');

  // Шаг 1: получить временную ссылку на скачивание
  const meta = await fetchFn(
    `${API_BASE}/resources/download?path=${encodeURIComponent(diskPath)}`,
    { headers: { Authorization: `OAuth ${token}` }, signal: abortTimeout(15000) },
  );
  if (!meta.ok) {
    throw new Error(`Яндекс API ${meta.status}: ${(await meta.text()).slice(0, 300)}`);
  }
  const { href } = await meta.json();

  // Шаг 2: скачать файл
  const file = await fetchFn(href, { signal: abortTimeout(30000) });
  if (!file.ok) throw new Error(`Скачивание файла с Диска: HTTP ${file.status}`);
  const raw = await file.json();

  const arr = Array.isArray(raw) ? raw
    : Array.isArray(raw?.items) ? raw.items
      : Array.isArray(raw?.data) ? raw.data
        : null;
  if (!arr) throw new Error('phone.json: ожидался массив товаров');

  const hidden = hiddenImeiSet();
  return normalizeCatalog(arr).filter((p) => !hidden.has(String(p.imei || '').trim()));
}

function forceRefresh() {
  // Если загрузка уже идёт — переиспользуем её промис, а не запускаем вторую.
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const items = await download();
    mem = { items, ts: Date.now() };
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(SNAPSHOT, JSON.stringify(items));
    } catch (e) {
      console.warn('Не удалось сохранить снапшот каталога:', e.message);
    }
    return items;
  })();
  // finally, чтобы и после ошибки следующий запрос мог попробовать снова.
  inFlight.finally(() => { inFlight = null; }).catch(() => {});
  return inFlight;
}

async function getCatalog() {
  if (mem.items && Date.now() - mem.ts < TTL_MS) return mem.items;

  try {
    return await forceRefresh();
  } catch (e) {
    console.error('Не удалось обновить каталог:', e.message);
    if (mem.items) return mem.items; // отдаём последний удачный
    try {
      const snap = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
      mem = { items: snap, ts: 0 };
      return snap;
    } catch { /* снапшота нет */ }
    throw e;
  }
}

module.exports = { getCatalog, forceRefresh };
