# Бот-каталог телефонов (Node.js + Telegraf)

Замена n8n-воркфлоу. Архитектура:

```
1С (регламентное задание)
   └─ REST API Яндекс.Диска (PUT phone.json)      ← 1c/YandexDisk_REST_Upload.bsl
Яндекс.Диск: /bot-data/phone.json
   └─ REST API (GET, кэш 5 мин + снапшот)          ← бот скачивает сам
Бот (long polling, inline-кнопки, навигация по callback_data)
```

Что изменилось к лучшему относительно n8n-версии: WebDAV заменён на бесплатный REST API; каталог кэшируется (не скачивается с Яндекса на каждое нажатие) и переживает недоступность Диска; выбор товара идёт по id, а не по регэкспам над текстом кнопок; логика нормализации в одном месте; токены в `.env`, а не захардкожены.

## 1. OAuth-токен Яндекс.Диска

1. Зайдите на https://oauth.yandex.ru/client/new под аккаунтом, на Диске которого лежит `bot-data/phone.json`.
2. Создайте приложение: платформа «Веб-сервисы», Redirect URI: `https://oauth.yandex.ru/verification_code`.
3. Права (scopes): «Яндекс.Диск REST API» — чтение и запись (`cloud_api:disk.read`, `cloud_api:disk.write`).
4. Получите токен: откройте `https://oauth.yandex.ru/authorize?response_type=token&client_id=<ID вашего приложения>` — токен будет в адресной строке после `#access_token=`.
5. Токен живёт до года — поставьте напоминание обновить.

Один и тот же токен используется ботом (чтение) и 1С (запись).

## 2. Новый токен Telegram-бота

Старый токен был захардкожен в n8n-воркфлоу и засвечен в его JSON-экспорте. Обязательно отзовите его: в @BotFather → `/mybots` → бот → API Token → Revoke. Новый токен — в `.env`.

## 3. Запуск бота

Нужен Node.js ≥ 18.17 (можно на тот же VPS, где крутится n8n).

```bash
cp .env.example .env   # заполнить BOT_TOKEN, YANDEX_OAUTH_TOKEN
npm install
npm run smoke          # самопроверка логики без сети
npm start
```

Постоянный запуск — pm2:

```bash
npm i -g pm2
pm2 start src/index.js --name phone-bot
pm2 save && pm2 startup
```

или Docker:

```bash
docker build -t phone-bot .
docker run -d --name phone-bot --env-file .env -v $(pwd)/data:/app/data --restart unless-stopped phone-bot
```

## 4. Отключить n8n-воркфлоу

Деактивируйте воркфлоу «Telegraf» в n8n **до** запуска бота. Иначе n8n будет заново регистрировать вебхук Telegram, и long polling бота получит конфликт (409).

## 5. Обновить выгрузку в 1С

Файл `1c/YandexDisk_REST_Upload.bsl` — процедура `ВыгрузитьНаЯндексДискREST(СтрокаJSON, ПутьНаДиске, OAuthТокен)`. Вставьте её в общий модуль (ТФ_ОбщегоНазначения) и вызывайте из регламентного задания вместо WebDAV-выгрузки. Папку `/bot-data` создайте на Диске один раз вручную, если её нет.

## Эксплуатация

- Данные обновляются: 1С пишет файл по своему расписанию; бот перечитывает Диск не чаще `CACHE_TTL_SECONDS` (по умолчанию 5 мин). Команда `/reload` в боте — принудительное обновление (ограничьте через `ADMIN_CHAT_ID`).
- Если Диск недоступен, бот работает на последней удачной копии (`data/catalog-cache.json`).
- Скрытые IMEI — `data/hidden_imei.txt` (по одному в строке). Правильнее со временем передавать признак скрытия полем из 1С.
- Телефон менеджера для карточки и WhatsApp — `MANAGER_PHONE` в `.env`.

## Структура

```
src/index.js      — бот: команды, callback-роутинг, запуск
src/views.js      — экраны: меню, модели, варианты, карточка
src/normalize.js  — нормализация phone.json (бывшие 3 копии кода в n8n)
src/catalog.js    — REST API Яндекс.Диска, кэш, снапшот, скрытые IMEI
scripts/smoke.js  — самопроверка логики (npm run smoke)
1c/…​.bsl          — выгрузка из 1С через REST API
data/             — hidden_imei.txt, кэш каталога
```
