'use strict';

require('dotenv').config();
const { Telegraf } = require('telegraf');
const { getCatalog, forceRefresh } = require('./catalog');
const v = require('./views');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('BOT_TOKEN не задан. Скопируйте .env.example в .env и заполните.');
  process.exit(1);
}

const MANAGER_PHONE = process.env.MANAGER_PHONE || '+79285024111';
const ADMIN_CHAT_ID = (process.env.ADMIN_CHAT_ID || '').trim();

// Обязательная подписка на канал (пусто = проверка выключена)
const REQUIRED_CHANNEL = (process.env.REQUIRED_CHANNEL || '').trim();
const CHANNEL_URL = (process.env.CHANNEL_URL || '').trim()
  || (REQUIRED_CHANNEL.startsWith('@') ? `https://t.me/${REQUIRED_CHANNEL.slice(1)}` : '');

const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 30_000 });

// Показ экрана: по нажатию кнопки редактируем сообщение на месте,
// по текстовой команде — отправляем новое.
async function render(ctx, view) {
  const opts = { reply_markup: view.reply_markup };
  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(view.text, opts);
      return;
    } catch (e) {
      const desc = String(e.description || e.message || '');
      if (desc.includes('message is not modified')) return;
      console.error('editMessageText:', desc);
      // сообщение слишком старое/удалено — отправим новое
    }
  }
  try {
    await ctx.reply(view.text, opts);
  } catch (e) {
    console.error('reply:', String(e.description || e.message || ''));
  }
}

async function withCatalog(ctx, fn) {
  let items;
  try {
    items = await getCatalog();
  } catch (e) {
    console.error('Каталог недоступен:', e.message);
    return render(ctx, v.catalogErrorView());
  }
  return fn(items);
}

// Проверка подписки на канал. Бот должен быть администратором канала.
async function isSubscribed(ctx) {
  if (!REQUIRED_CHANNEL) return true;
  try {
    const m = await ctx.telegram.getChatMember(REQUIRED_CHANNEL, ctx.from.id);
    return ['creator', 'administrator', 'member'].includes(m.status);
  } catch (e) {
    // Бот не админ канала / канал указан неверно — не блокируем работу, но пишем в лог
    console.warn('Проверка подписки не удалась:', String(e.description || e.message || e));
    return true;
  }
}

// Гейт: без подписки на канал бот не работает
bot.use(async (ctx, next) => {
  if (!REQUIRED_CHANNEL || !ctx.from) return next();

  const isCheck = ctx.callbackQuery?.data === 'checksub';
  const ok = await isSubscribed(ctx);

  if (ok) {
    if (isCheck) {
      ctx.answerCbQuery('Спасибо за подписку!').catch(() => {});
      return render(ctx, v.brandsView());
    }
    return next();
  }

  if (ctx.callbackQuery) {
    ctx.answerCbQuery(
      isCheck ? 'Похоже, вы ещё не подписались' : '',
      isCheck ? { show_alert: true } : undefined,
    ).catch(() => {});
    if (isCheck) return; // сообщение с кнопками уже на экране
  }
  return render(ctx, v.subscribeView(CHANNEL_URL));
});

// Регистрация callback-обработчика с автоматическим answerCbQuery
function action(trigger, handler) {
  bot.action(trigger, async (ctx) => {
    ctx.answerCbQuery().catch(() => {});
    await handler(ctx);
  });
}

// ---------- команды ----------

bot.start((ctx) => render(ctx, v.brandsView()));
bot.command('menu', (ctx) => render(ctx, v.brandsView()));

bot.command('reload', async (ctx) => {
  if (ADMIN_CHAT_ID && String(ctx.chat.id) !== ADMIN_CHAT_ID) return;
  try {
    const items = await forceRefresh();
    await ctx.reply(`Каталог обновлён: ${items.length} позиций`);
  } catch (e) {
    await ctx.reply(`Ошибка обновления каталога: ${e.message}`);
  }
});

// ---------- навигация ----------

action('home', (ctx) => render(ctx, v.brandsView()));

action(/^brand:(.+)$/, (ctx) => {
  const brand = ctx.match[1];
  return render(ctx, v.conditionView(brand));
});

action(/^cond:([^:]+):(new|used)$/, (ctx) => {
  const [, brand, condition] = ctx.match;
  return withCatalog(ctx, (items) => render(ctx, v.modelsView(items, brand, condition)));
});

action(/^vars:(new|used):(.+)$/, (ctx) => {
  const [, condition, modelKey] = ctx.match;
  return withCatalog(ctx, (items) =>
    render(ctx, v.variantsView(items, 'iphone', condition, modelKey)));
});

action(/^card:(.+)$/, (ctx) => {
  const key = ctx.match[1];
  return withCatalog(ctx, (items) => {
    const item = items.find((p) => p.key === key || String(p.id) === key);
    if (!item) return render(ctx, v.notFoundView());
    return render(ctx, v.cardView(item, MANAGER_PHONE));
  });
});

// Любой текст — в главное меню
bot.on('text', (ctx) => render(ctx, v.brandsView()));

bot.catch((err, ctx) => {
  console.error(`Ошибка обработки ${ctx?.updateType}:`, err);
});

// ---------- запуск ----------

(async () => {
  try {
    // Снимаем вебхук, который мог остаться от n8n (иначе long polling получит 409).
    // Важно: сам n8n-воркфлоу с Telegram Trigger должен быть деактивирован,
    // иначе n8n снова зарегистрирует вебхук.
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  } catch (e) {
    console.warn('deleteWebhook:', e.message);
  }

  // Прогреем кэш каталога (не критично, если упадёт)
  getCatalog()
    .then((items) => console.log(`Каталог загружен: ${items.length} позиций`))
    .catch((e) => console.warn('Каталог пока недоступен:', e.message));

  await bot.launch(() => console.log('Бот запущен (long polling)'));
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
