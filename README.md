# WOODORA — лендинг мебельной мастерской в Бишкеке

Одностраничный сайт на Vite и чистом HTML/CSS/JS. Заявки с сайта сохраняются в Supabase и дублируются уведомлением в Telegram через серверную функцию Vercel.

## Возможности

- Каталог товаров с фильтрами по категориям и поиском
- Карточки категорий и ссылки в футере сразу фильтруют каталог
- Кнопка «Заказать» открывает окно заявки с выбранным товаром
- Форма заявки внизу страницы
- Заявки сохраняются в таблицу Supabase `public.applications`, затем приходит уведомление в Telegram (`api/lead.js`)
- Команды бота `/start` и `/history` — история заявок за 7 дней прямо в Telegram (`api/telegram.js`)

## Структура

```
index.html        — разметка страницы
src/style.css     — стили
src/main.js       — каталог, фильтры, поиск, формы, модальное окно
src/products.js   — список товаров (название, материал, цена, фото, категория)
api/lead.js       — серверная функция: сохранение заявки в Supabase и уведомление в Telegram
api/telegram.js   — webhook Telegram-бота: команды /start и /history
scripts/          — telegram-local.mjs: локальная проверка webhook
tests/            — автоматические тесты (npm test), Supabase и Telegram подменены
public/           — статические файлы (favicon)
```

## Локальный запуск

```bash
npm install
cp .env.example .env   # вписать токен бота, chat id и ключи Supabase
npm run dev            # http://localhost:5173
```

`npm run dev` обслуживает `/api/lead` и `/api/telegram`, поэтому форму и команды бота можно проверить локально.

```bash
npm test               # тесты без реальных запросов к Supabase и Telegram
```

## Как обрабатывается заявка

1. Форма проверяет имя, телефон и количество (1–99) и отправляет данные на `/api/lead`.
2. Сервер повторно проверяет данные и записывает заявку в `public.applications` (статус `new`).
3. Только после успешной записи бот отправляет уведомление в Telegram.
4. Если записать в базу не удалось, клиент видит ошибку, Telegram не вызывается.
5. Если заявка сохранена, а Telegram недоступен, клиент видит «заявка отправлена», ошибка пишется в лог Vercel (Logs) с номером заявки.

## Настройка Supabase

Таблица `public.applications`: `id`, `created_at`, `customer_name`, `phone`, `product_name`, `quantity`, `comment`, `status`.
RLS включён, у ролей `anon` и `authenticated` нет прав — таблицу читает и пишет только сервер по секретному ключу.

Укажите `SUPABASE_URL` и `SUPABASE_SECRET_KEY` (Project Settings → API) в `.env` и в Vercel. Префикс `VITE_` не использовать.

## Настройка Telegram-бота

1. В Telegram откройте [@BotFather](https://t.me/BotFather), выполните `/newbot` и скопируйте **токен**.
2. Напишите своему боту любое сообщение (или добавьте бота в группу менеджеров и напишите там).
3. Откройте `https://api.telegram.org/bot<ТОКЕН>/getUpdates` и найдите `"chat":{"id": ...}` — это **chat id** (у групп он отрицательный).
4. Укажите `TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHAT_ID` в `.env` (локально) и в Vercel → Project → Settings → Environment Variables.

## Команды бота (webhook)

`api/telegram.js` принимает обновления Telegram и отвечает на команды:

- `/start` — список команд;
- `/history` — заявки за последние 7 суток, от новых к старым, время по Бишкеку. Длинная история разбивается на несколько сообщений («Часть 1/3»), запись никогда не разрезается. Показывается до 200 последних заявок, общее число указано в заголовке.

Защита:

- запрос без верного заголовка `X-Telegram-Bot-Api-Secret-Token` (= `TELEGRAM_WEBHOOK_SECRET`) получает 401;
- команды выполняются только из чата `TELEGRAM_CHAT_ID`, сообщения из других чатов молча игнорируются;
- заявки читаются серверным ключом Supabase, RLS не меняется.

### Подключение в production

1. Сгенерируйте секрет (значение никому не показывайте):
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
2. Добавьте `TELEGRAM_WEBHOOK_SECRET` в `.env` и в Vercel → Settings → Environment Variables (Production и Preview, отметка Sensitive).
3. Задеплойте проект (переменные применяются только к новому деплою).
4. Зарегистрируйте webhook — один запрос `setWebhook` с параметрами:
   `url=https://<домен>/api/telegram`, `secret_token=<TELEGRAM_WEBHOOK_SECRET>`, `allowed_updates=["message"]`, `drop_pending_updates=true`.
   Делайте это скриптом, который читает токен и секрет из `.env`, а не вставкой токена в адресную строку или `curl` (останется в истории).
5. Проверьте `getWebhookInfo`: правильный `url`, пустой `last_error_message`. Затем отправьте боту `/start` и `/history`.

После регистрации webhook метод `getUpdates` перестаёт работать — это нормально.

### Локальная проверка без реальных сообщений

1. В `.env` добавьте `TELEGRAM_DRY_RUN=1` и `TELEGRAM_WEBHOOK_SECRET`.
2. `npm run dev`
3. В другом терминале:
   ```bash
   npm run tg:local -- /start
   npm run tg:local -- /history              # читает настоящие заявки из Supabase (только чтение)
   npm run tg:local -- /history --foreign    # посторонний чат — должен игнорироваться
   npm run tg:local -- /start --bad-secret   # ожидается 401
   ```
   Ответы бота появятся в терминале с `npm run dev`, в Telegram ничего не уйдёт.

## Деплой на Vercel

1. Vercel → **Add New → Project** → импортировать репозиторий с GitHub.
2. Framework Preset: **Vite** (определится автоматически), остальные настройки по умолчанию.
3. Добавить переменные окружения `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (`TELEGRAM_DRY_RUN` на Vercel не нужен).
4. Deploy. После этого каждый `git push` в `main` деплоится автоматически.

## Что заменить на реальные данные

- [ ] Контакты в футере (`index.html`): телефон, WhatsApp, Telegram, Instagram, адрес, график
- [ ] Товары, цены и фото — `src/products.js`
- [ ] Тексты и цифры в блоке «О нас»
- [ ] Отзывы — сейчас это примеры, нужны реальные
- [ ] Фото — сейчас с Unsplash, заменить на свои (положить в `public/images/`)
