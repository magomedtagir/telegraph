'use strict';

// Экраны бота: тексты + inline-клавиатуры.
// Навигация через callback_data (никакого парсинга текста кнопок регэкспами,
// как было в n8n) — выбор товара идёт по его id из 1С.
//
// Схема callback_data:
//   home                     — главное меню (бренды)
//   brand:<brand>            — выбор состояния (новый/б-у)
//   cond:<brand>:<new|used>  — список моделей
//   vars:<new|used>:<model>  — список вариантов модели
//   card:<id>                — карточка товара

function safeStr(v) {
  return (v ?? '').toString().replace(/\s+/g, ' ').trim();
}

function safeNum(v) {
  const n = Number(
    String(v ?? '')
      .replace(/ /g, ' ')
      .replace(/\s+/g, '')
      .replace(',', '.')
      .replace(/[^\d.\-]/g, ''),
  );
  return Number.isFinite(n) ? n : 0;
}

function normalizeText(s) {
  return safeStr(s).toLowerCase().replace(/ё/g, 'е');
}

function formatPrice(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  return n.toLocaleString('ru-RU') + ' ₽';
}

// Состояние: сначала смотрим name, потом quality; по умолчанию — новый
function getCondition(v) {
  const name = normalizeText(v.name);
  const q = normalizeText(v.quality);

  // \b в JS не работает для кириллицы (word-char — только [A-Za-z0-9_]),
  // поэтому "бу" отдельным словом ловим границами по не-кириллице.
  if (name.includes('б/у') || /(?:^|[^а-я])бу(?:[^а-я]|$)/.test(name) || name.includes('used')) return 'used';
  if (name.includes('новый') || name.includes('new')) return 'new';

  if (q.includes('б/у') || q === 'бу' || q.includes('used')) return 'used';
  if (q.includes('нов')) return 'new';

  return 'new';
}

function normModelKey(s) {
  let x = safeStr(s);
  x = x.replace(/^iphone/i, 'iPhone');
  x = x.replace(/iPhone\s*air\b/i, 'iPhone Air');
  x = x.replace(/iPhone\s*xs\s*max/i, 'iPhone XS');
  x = x.replace(/iPhone\s*xs\b/i, 'iPhone XS');
  x = x.replace(/iPhone\s*xr\b/i, 'iPhone XR');
  x = x.replace(/iPhone\s*x\b/i, 'iPhone X');
  x = x.replace(/iPhone\s*se\b/i, 'iPhone SE');
  x = x.replace(/iPhone\s*(\d{1,2})\s*e\b/i, 'iPhone $1E');
  x = x.replace(/iPhone\s*(\d{1,2})\b/i, 'iPhone $1');
  return x.replace(/\s+/g, ' ').trim();
}

// Базовая модель товара с fallback для iPhone Air (у него пустой baseModel)
function baseModelOf(item) {
  const base = normModelKey(item.baseModel);
  if (base) return base;
  if (/iphone\s*air\b/i.test(safeStr(item.name))) return 'iPhone Air';
  return '';
}

function modelRank(model) {
  const s = String(model || '').toUpperCase().replace(/\s+/g, ' ').trim();

  const fixed = {
    'IPHONE SE': 5.5,
    'IPHONE AIR': 9.8,
    'IPHONE X': 10,
    'IPHONE XR': 10.1,
    'IPHONE XS': 10.2,
  };
  if (fixed[s] !== undefined) return fixed[s];

  const mE = s.match(/IPHONE\s+(\d+)E/);
  if (mE) return Number(mE[1]) + 0.05;

  const m = s.match(/IPHONE\s+(\d+)/);
  if (m) return Number(m[1]);

  return 999;
}

// Порядок вариантов внутри модели: mini → обычный → Pro → Pro Max
function getVariantTypeRank(name, modelKey) {
  const s = String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const mk = String(modelKey || '').toLowerCase().replace(/\s+/g, ' ').trim();

  let tail = s;
  if (mk && s.startsWith(mk)) tail = s.slice(mk.length).trim();

  if (/\bmini\b/.test(tail)) return 0;
  if (/\bpro\s*max\b/.test(tail)) return 3;
  if (/\bpro\b/.test(tail)) return 2;
  return 1;
}

function getMemoryForSort(name) {
  const s = String(name || '');
  const tb = s.match(/(\d+)\s*(?:TB|ТБ)/i);
  if (tb) return Number(tb[1]) * 1024;
  const m = s.match(/(\d+)\s*(?:GB|ГБ)/i);
  return m ? Number(m[1]) : 999999;
}

// Гигабайты → человекочитаемо (1024 GB показываем как 1 TB)
function formatMemory(gb) {
  const n = safeNum(gb);
  if (n <= 0) return '';
  if (n >= 1024 && n % 1024 === 0) return `${n / 1024} TB`;
  return `${n} GB`;
}

function hasNoRuStore(name) {
  return /без\s*rustore/i.test(name || '');
}

function hasEsim(name) {
  return /e-?sim/i.test(name || '');
}

function filterByCondition(items, condition) {
  return items
    .filter((v) => safeNum(v.stock) > 0)
    .filter((v) => getCondition(v) === (condition === 'used' ? 'used' : 'new'));
}

// ---------- экраны ----------

function brandsView() {
  return {
    text: 'Выберите желаемый телефон',
    reply_markup: {
      inline_keyboard: [[{ text: 'iPhone', callback_data: 'brand:iphone' }]],
    },
  };
}

function conditionView(brand) {
  return {
    text: 'Выберите состояние телефона',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Новый', callback_data: `cond:${brand}:new` }],
        [{ text: 'Б/У', callback_data: `cond:${brand}:used` }],
        [{ text: '⬅ Назад', callback_data: 'home' }],
      ],
    },
  };
}

function modelsView(items, brand, condition) {
  const filtered = filterByCondition(items, condition);

  const models = [...new Set(filtered.map(baseModelOf).filter(Boolean))];

  models.sort((a, b) => {
    const aAir = a.trim().toLowerCase() === 'iphone air';
    const bAir = b.trim().toLowerCase() === 'iphone air';
    if (aAir && !bAir) return 1;
    if (!aAir && bAir) return -1;

    const diff = modelRank(a) - modelRank(b);
    if (diff !== 0) return diff;

    return a.localeCompare(b, 'ru', { numeric: true, sensitivity: 'base' });
  });

  const back = [{ text: '⬅ К состоянию', callback_data: `brand:${brand}` }];

  if (!models.length) {
    return {
      text: `Сейчас нет ${condition === 'used' ? 'б/у' : 'новых'} телефонов в наличии`,
      reply_markup: { inline_keyboard: [back] },
    };
  }

  const rows = models.map((m) => [{
    text: condition === 'used' ? `${m} (б/у)` : m,
    callback_data: `vars:${condition}:${m}`,
  }]);
  rows.push(back);

  return {
    text: 'Выберите модель iPhone',
    reply_markup: { inline_keyboard: rows },
  };
}

function variantsView(items, brand, condition, modelKey) {
  const filtered = filterByCondition(items, condition)
    .filter((v) => baseModelOf(v) === modelKey);

  const back = [{ text: '⬅ К моделям', callback_data: `cond:${brand}:${condition}` }];

  const sortVariants = (a, b) => {
    const typeDiff = getVariantTypeRank(a.name, modelKey) - getVariantTypeRank(b.name, modelKey);
    if (typeDiff !== 0) return typeDiff;
    const memDiff = getMemoryForSort(a.name) - getMemoryForSort(b.name);
    if (memDiff !== 0) return memDiff;
    return a.price - b.price;
  };

  let entries;

  if (condition === 'used') {
    // б/у — каждый аппарат отдельной кнопкой
    entries = filtered
      .map((v) => ({ key: v.key || v.id, name: safeStr(v.name), price: safeNum(v.price), count: 1 }))
      .sort(sortVariants);
  } else {
    // новые — группируем одинаковые позиции (name + price)
    const groups = new Map();
    for (const v of filtered) {
      const name = safeStr(v.name);
      const price = safeNum(v.price);
      const gkey = `${name}|||${price}`;
      if (!groups.has(gkey)) groups.set(gkey, { key: v.key || v.id, name, price, count: 0 });
      groups.get(gkey).count += 1;
    }
    entries = [...groups.values()].sort(sortVariants);
  }

  if (!entries.length) {
    return {
      text: `Для модели ${modelKey} сейчас нет доступных вариантов`,
      reply_markup: { inline_keyboard: [back] },
    };
  }

  const rows = entries.map((e) => {
    const qty = e.count > 1 ? ` (${e.count} шт.)` : '';
    return [{
      text: `${e.name} — ${formatPrice(e.price)}${qty}`,
      callback_data: `card:${e.key}`,
    }];
  });
  rows.push(back);

  return {
    text: `Выберите вариант ${modelKey}`,
    reply_markup: { inline_keyboard: rows },
  };
}

function cardView(item, managerPhoneDisplay) {
  const name = safeStr(item.name);
  const model = safeStr(item.model || item.baseModel);
  const color = safeStr(item.color);
  const memory = safeNum(item.memory);
  const price = safeNum(item.price);

  const imei = safeStr(item.imei);
  const box = safeStr(item.box);
  const repair = safeStr(item.repair);
  const charge = safeStr(item.charge);

  const condition = getCondition(item);
  const used = condition === 'used';

  const lines = [];
  lines.push(`📱 ${name || model || 'Телефон'}`);
  lines.push('');
  if (imei) lines.push(`IMEI: ${imei}`);
  if (color) lines.push(`Цвет: ${color}`);
  if (memory > 0) lines.push(`Память: ${formatMemory(memory)}`);
  lines.push(`Состояние: ${used ? 'Б/У' : 'Новый'}`);
  if (hasNoRuStore(name)) lines.push('RuStore: без RuStore');
  if (hasEsim(name)) lines.push('eSIM: есть');
  if (price > 0) lines.push(`Цена: ${formatPrice(price)}`);
  lines.push('');
  if (used) {
    lines.push(`Коробка: ${box || 'Нет данных'}`);
    lines.push(`Ремонт: ${repair || 'Нет данных'}`);
    lines.push(`Состояние аккумулятора: ${charge ? `${charge} %` : 'Нет данных'}`);
    lines.push('');
  }
  lines.push(`Связаться с менеджером: ${managerPhoneDisplay}`);

  const waLines = [];
  waLines.push('Здравствуйте! Меня интересует этот телефон:');
  waLines.push('');
  waLines.push(`📱 ${name || model || 'Телефон'}`);
  if (imei) waLines.push(`IMEI: ${imei}`);
  if (color) waLines.push(`Цвет: ${color}`);
  if (memory > 0) waLines.push(`Память: ${formatMemory(memory)}`);
  waLines.push(`Состояние: ${used ? 'Б/У' : 'Новый'}`);
  if (price > 0) waLines.push(`Цена: ${formatPrice(price)}`);

  const managerPhoneWa = String(managerPhoneDisplay).replace(/\D/g, '');
  const waUrl = `https://wa.me/${managerPhoneWa}?text=${encodeURIComponent(waLines.join('\n'))}`;

  const backCb = `vars:${condition}:${baseModelOf(item)}`;

  return {
    text: lines.join('\n'),
    reply_markup: {
      inline_keyboard: [
        [{ text: '💬 Написать в WhatsApp', url: waUrl }],
        [{ text: '⬅ К вариантам', callback_data: backCb }],
      ],
    },
  };
}

function subscribeView(channelUrl) {
  const rows = [];
  if (channelUrl) rows.push([{ text: '📢 Подписаться на канал', url: channelUrl }]);
  rows.push([{ text: '✅ Я подписался', callback_data: 'checksub' }]);
  return {
    text: 'Чтобы пользоваться каталогом, подпишитесь на наш канал.\nПосле подписки нажмите «Я подписался».',
    reply_markup: { inline_keyboard: rows },
  };
}

function notFoundView() {
  return {
    text: 'Не удалось найти выбранный телефон в наличии. Возможно, его уже продали — выберите вариант ещё раз.',
    reply_markup: {
      inline_keyboard: [[{ text: '🏠 В меню', callback_data: 'home' }]],
    },
  };
}

function catalogErrorView() {
  return {
    text: 'Каталог временно недоступен, попробуйте чуть позже.',
    reply_markup: {
      inline_keyboard: [[{ text: '🔄 Попробовать снова', callback_data: 'home' }]],
    },
  };
}

module.exports = {
  brandsView,
  conditionView,
  modelsView,
  variantsView,
  cardView,
  subscribeView,
  notFoundView,
  catalogErrorView,
  getCondition,
  baseModelOf,
};
