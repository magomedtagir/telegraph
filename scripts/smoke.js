'use strict';

// Smoke-тест логики каталога без сети и токенов: node scripts/smoke.js

const { normalizeCatalog } = require('../src/normalize');
const v = require('../src/views');

const raw = [
  { id: 'a1', 'название': 'iPhone 13 128GB Blue Новый', 'цена': '45 000', 'запас': 1 },
  { id: 'a2', 'название': 'iPhone 13 128GB Blue Новый', 'цена': '45 000', 'запас': 1 },
  { id: 'a3', name: 'iPhone 13 Pro Max 256GB Silver Новый', price: 75000, stock: 2 },
  { id: 'b1', name: 'iPhone XS Max 64GB Gold б/у', price: '18 500,00', stock: 1, imey: '111', box: 'Есть', repair: 'Не было', charge: '87', quality: 'б/у' },
  { id: 'b2', name: 'iPhone Air 256GB Sky Blue Новый', price: 99990, stock: 1 },
  { id: 'hidden1', name: 'iPhone 12 64GB Black б/у', price: 20000, stock: 1, imey: '358686090564372' },
  { id: 'zero', name: 'iPhone 11 64GB Black Новый', price: 25000, stock: 0 },
  { id: 'sams', name: 'Samsung Galaxy S24', price: 50000, stock: 3 },
];

let failed = 0;
const check = (label, cond) => {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${label}`);
  if (!cond) failed++;
};

// normalize: iPhone-only, stock>0, дедуп по id
const items = normalizeCatalog(raw);
check('нормализация: 6 позиций (без Samsung и stock=0)', items.length === 6);
check('память извлечена из name', items.find((p) => p.id === 'a1').memory === 128);
check('цена "45 000" → 45000', items.find((p) => p.id === 'a1').price === 45000);
check('цена "18 500,00" → 18500', items.find((p) => p.id === 'b1').price === 18500);
check('XS Max → baseModel iPhone XS', items.find((p) => p.id === 'b1').baseModel === 'iPhone XS');

// скрытые IMEI фильтруются на уровне catalog.js; здесь имитируем
const visible = items.filter((p) => p.imei !== '358686090564372');
check('скрытый IMEI отфильтрован', !visible.find((p) => p.id === 'hidden1'));

// модели: новые
const mv = v.modelsView(visible, 'iphone', 'new');
const modelBtns = mv.reply_markup.inline_keyboard.map((r) => r[0].text);
check('модели (новые): iPhone 13 и iPhone Air', modelBtns.includes('iPhone 13') && modelBtns.includes('iPhone Air'));
check('iPhone Air в конце списка', modelBtns[modelBtns.length - 2] === 'iPhone Air');

// модели: б/у
const mvU = v.modelsView(visible, 'iphone', 'used');
check('модели (б/у): iPhone XS (б/у)', mvU.reply_markup.inline_keyboard[0][0].text === 'iPhone XS (б/у)');

// варианты: новые группируются
const vv = v.variantsView(visible, 'iphone', 'new', 'iPhone 13');
const vBtns = vv.reply_markup.inline_keyboard.map((r) => r[0].text);
check('варианты: дубль сгруппирован "(2 шт.)"', vBtns.some((t) => t.includes('(2 шт.)')));
check('варианты: Pro Max после обычного', vBtns.findIndex((t) => t.includes('Pro Max')) === 1);
check('callback_data ≤ 64 байт', vv.reply_markup.inline_keyboard.every((r) => r.every((b) => !b.callback_data || Buffer.byteLength(b.callback_data) <= 64)));

// карточка б/у
const used = visible.find((p) => p.id === 'b1');
const card = v.cardView(used, '+79285024111');
check('карточка: аккумулятор 87 %', card.text.includes('Состояние аккумулятора: 87 %'));
check('карточка: состояние Б/У', card.text.includes('Состояние: Б/У'));
check('карточка: WhatsApp-кнопка', card.reply_markup.inline_keyboard[0][0].url.startsWith('https://wa.me/79285024111'));
check('карточка: назад к вариантам', card.reply_markup.inline_keyboard[1][0].callback_data === 'vars:used:iPhone XS');

// пустые варианты
const empty = v.variantsView(visible, 'iphone', 'used', 'iPhone 15');
check('пустой список — сообщение с кнопкой назад', empty.text.includes('нет доступных вариантов'));

// --- регрессии из код-ревью ---

// 1TB память парсится (раньше давала 0 → строка "Память" пропадала)
const tb = normalizeCatalog([
  { id: 'tb1', name: 'iPhone 14 Pro Max 1TB Deep Purple б/у', price: 90000, stock: 1, imey: '222', quality: 'б/у' },
]);
check('1TB → память 1024 GB', tb[0].memory === 1024);
check('карточка: 1TB показывается как "1 TB"', v.cardView(tb[0], '+79285024111').text.includes('Память: 1 TB'));

// состояние "бу" без слэша → used (раньше /\bбу\b/ не срабатывал на кириллице)
check('getCondition: "бу" без слэша → used', v.getCondition({ name: 'iPhone 12 64GB Black бу', quality: '' }) === 'used');
check('getCondition: "бумага" не путается с бу', v.getCondition({ name: 'iPhone 12 бумага', quality: '' }) === 'new');

// длинный id → короткий key в callback_data
const longId = normalizeCatalog([
  { id: 'очень-длинный-идентификатор-из-1с-которому-не-место-в-callback-data-вообще-никак', name: 'iPhone 15 128GB Black Новый', price: 60000, stock: 1 },
]);
const vvLong = v.variantsView(longId, 'iphone', 'new', 'iPhone 15');
check('длинный id → callback_data ≤ 64 байт', vvLong.reply_markup.inline_keyboard.every((r) => r.every((b) => !b.callback_data || Buffer.byteLength(b.callback_data) <= 64)));

// экран подписки
const sub = v.subscribeView('https://t.me/testchannel');
check('подписка: кнопка канала + "Я подписался"', sub.reply_markup.inline_keyboard.length === 2 && sub.reply_markup.inline_keyboard[1][0].callback_data === 'checksub');

console.log(failed ? `\n${failed} проверок упало` : '\nВсе проверки прошли');
process.exit(failed ? 1 : 0);
