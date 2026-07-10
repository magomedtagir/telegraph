'use strict';

// Нормализация сырого phone.json из 1С.
// Единственная копия — раньше в n8n этот код был продублирован в трёх узлах
// (и уже разъехался: поле charge было только в одном). Здесь объединена полная версия.

const crypto = require('crypto');

const toStr = (v) => (v === null || v === undefined) ? '' : String(v).trim();

const cleanNumString = (v) => toStr(v)
  .replace(/\u00A0/g, " ")
  .replace(/\s+/g, '')
  .replace(/,/g, '.')
  .replace(/[^\d.\-]/g, '');

const toNum = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const s = cleanNumString(v);
  if (!s) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};

const pick = (obj, keys) => {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return undefined;
};

// Возможные имена полей в выгрузке 1С (рус/англ)
const K = {
  id: ['id', 'ID', 'uuid'],
  brand: ['brand', 'бренд'],
  model: ['model', 'модель'],
  memory: ['memory', 'память'],
  color: ['color', 'цвет'],
  name: ['name', 'название'],
  price: ['price', 'цена'],
  stock: ['stock', 'запас'],
  imei: ['imey', 'IMEI', 'imei'],
  box: ['box', 'коробка'],
  repair: ['repair', 'ремонт'],
  quality: ['quality', 'состояние'],
  charge: ['charge', 'заряд', 'аккумулятор', 'battery'],
};

const COLOR_WORDS_EN = [
  'Black', 'White', 'Blue', 'Pink', 'Green', 'Yellow', 'Red', 'Orange', 'Purple', 'Gray', 'Grey',
  'Silver', 'Gold', 'Titanium', 'Natural', 'Desert', 'Starlight', 'Midnight',
];

const COLOR_WORDS_RU = [
  'черный', 'чёрный', 'белый', 'синий', 'голубой', 'красный', 'зеленый', 'зелёный',
  'желтый', 'жёлтый', 'фиолетовый', 'серый', 'серебристый', 'золотой', 'розовый',
  'оранжевый', 'титановый',
];

function normalizeSpaces(s) {
  return toStr(s).replace(/\s+/g, ' ').trim();
}

function extractModelLine(name, fallbackModelField) {
  const n = normalizeSpaces(name);

  const sp = n.match(/iPhone\s*(XS\s*Max|XSMax|XR|XS|X|SE)\b/i);
  if (sp) {
    let token = sp[1].replace(/\s+/g, ' ').toUpperCase();
    if (token === 'XSMAX') token = 'XS Max';
    return `iPhone ${token}`;
  }

  const m = n.match(/iPhone\s*(\d{1,2})\s*(Pro\s*Max|ProMax|Pro|Plus|Mini|SE|E)?/i);
  if (m) {
    const num = m[1];
    let suffix = (m[2] || '').replace(/\s+/g, ' ').trim();
    if (/^promax$/i.test(suffix)) suffix = 'Pro Max';
    if (suffix === 'E') return `iPhone ${num}E`;
    return `iPhone ${num}${suffix ? ' ' + suffix : ''}`;
  }

  const mf = normalizeSpaces(fallbackModelField);
  if (mf) {
    const m2 = mf.match(/(\d{1,2})\s*(Pro\s*Max|Pro|Plus|Mini|SE|E)?/i);
    if (m2) {
      const num = m2[1];
      let suffix = (m2[2] || '').replace(/\s+/g, ' ').trim();
      if (/^promax$/i.test(suffix)) suffix = 'Pro Max';
      if (suffix === 'E') return `iPhone ${num}E`;
      return `iPhone ${num}${suffix ? ' ' + suffix : ''}`;
    }
  }

  return '';
}

function extractBaseModel(name, fallbackModelField) {
  const n = normalizeSpaces(name);

  const sp = n.match(/iPhone\s*(XS\s*Max|XSMax|XR|XS|X|SE)\b/i);
  if (sp) {
    let token = sp[1].replace(/\s+/g, ' ').toUpperCase();
    if (token === 'XSMAX' || token === 'XS MAX') return 'iPhone XS';
    return `iPhone ${token}`;
  }

  const mE = n.match(/iPhone\s*(\d{1,2})\s*E\b/i);
  if (mE) return `iPhone ${mE[1]}E`;

  const m = n.match(/iPhone\s*(\d{1,2})/i);
  if (m) return `iPhone ${m[1]}`;

  const mf = normalizeSpaces(fallbackModelField);
  if (mf) {
    const m2 = mf.match(/(\d{1,2})/);
    if (m2) return `iPhone ${m2[1]}`;
  }

  return '';
}

function extractMemoryGB(name, fallbackMemoryField) {
  const n = normalizeSpaces(name);
  // TB (1TB/2TB) переводим в GB, чтобы 1TB не превращался в 0 при парсинге "только GB".
  const tb = n.match(/(\d{1,2})\s*(TB|ТБ)\b/i);
  if (tb) return toNum(tb[1]) * 1024;
  const m = n.match(/(\d{2,4})\s*(GB|ГБ)\b/i);
  if (m) return toNum(m[1]);
  const mf = toNum(fallbackMemoryField);
  return mf || 0;
}

function extractColor(name, fallbackColorField) {
  const cf = normalizeSpaces(fallbackColorField);
  if (cf) return cf;

  const n = normalizeSpaces(name);

  for (const c of COLOR_WORDS_EN) {
    if (new RegExp(`\\b${c}\\b`, 'i').test(n)) return c;
  }
  for (const c of COLOR_WORDS_RU) {
    if (new RegExp(`\\b${c}\\b`, 'i').test(n)) return c;
  }

  const m = n.match(/\b\d{2,3}\s*(?:GB|ГБ)\s+([A-Za-zА-Яа-яЁё-]+)/i);
  if (m) return m[1];

  return '';
}

function normalizeOne(x) {
  const id = toStr(pick(x, K.id));
  const name = normalizeSpaces(pick(x, K.name) ?? '');

  const stock = toNum(pick(x, K.stock));
  const price = toNum(pick(x, K.price));

  const brandRaw = normalizeSpaces(pick(x, K.brand) ?? '');
  const modelField = normalizeSpaces(pick(x, K.model) ?? '');
  const memoryField = pick(x, K.memory);
  const colorField = pick(x, K.color);

  const imei = toStr(pick(x, K.imei));
  const box = toStr(pick(x, K.box));
  const repair = toStr(pick(x, K.repair));
  const quality = toStr(pick(x, K.quality));
  const charge = toStr(pick(x, K.charge));

  const modelLine = extractModelLine(name, modelField);
  const baseModel = extractBaseModel(name, modelField);
  const memoryGB = extractMemoryGB(name, memoryField);
  const color = extractColor(name, colorField);

  let brand = brandRaw;
  if (!brand && /iphone/i.test(name)) brand = 'Apple';

  return {
    id,
    brand,
    model: modelLine,
    baseModel,
    memory: memoryGB,
    color,
    name,
    price,
    stock,
    imei,
    box,
    repair,
    quality,
    charge,
  };
}

function score(p) {
  let s = 0;
  if (p.brand) s++;
  if (p.baseModel) s++;
  if (p.model) s++;
  if (p.memory) s++;
  if (p.color) s++;
  if (p.name) s++;
  if (p.price > 0) s++;
  if (p.imei) s++;
  if (p.box) s++;
  if (p.repair) s++;
  if (p.quality) s++;
  if (p.charge) s++;
  return s;
}

/**
 * Массив сырых записей из phone.json → нормализованный каталог.
 * Оставляет только iPhone с stock > 0, дедуплицирует по id (берёт самую полную запись).
 */
function normalizeCatalog(raw) {
  let norm = raw.map(normalizeOne);

  norm = norm.filter((p) => p.stock > 0 && /iphone/i.test(p.name));

  const byId = new Map();
  for (const p of norm) {
    if (!p.id) continue;
    const prev = byId.get(p.id);
    if (!prev || score(p) > score(prev)) byId.set(p.id, p);
  }

  const items = [...byId.values()];

  // Короткий стабильный ключ для callback_data (лимит Telegram — 64 байта,
  // а id из 1С может быть длинным). 12 hex-символов достаточно.
  for (const p of items) {
    p.key = crypto.createHash('md5').update(String(p.id)).digest('hex').slice(0, 12);
  }

  return items;
}

module.exports = { normalizeCatalog, toNum, toStr };
