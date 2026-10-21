# WOODORA — лендинг, CRM/ERP и AI-агент мебельной мастерской

Лендинг на Vite (HTML/CSS/JS), админ-панель `/admin` (React + TypeScript), база Supabase (PostgreSQL + RLS + pgvector), серверные функции Vercel и AI-агент на **OpenAI Responses API** (`gpt-6-luna`, embeddings `text-embedding-3-small`). Всё связано в одну систему. Все AI-запросы приложения идут только в OpenAI и только с сервера.

## Как работает система

```
Лендинг ── форма / «Заказать» ──► /api/lead ──► RPC create_application ──► applications + clients ──► Telegram
   │                                                                              ▲
   ├── каталог ◄── /api/catalog ◄── products (правятся в админке)                 │
   │                                                                              │
   └── AI-чат ──► /api/chat ──► OpenAI Responses API + инструменты ──► search_knowledge (kb_chunks: полнотекстовый + pgvector)
                                                   ├─► get_services / check_availability (products, services)
                                                   ├─► get_business_info (company_settings)
                                                   └─► create_lead (после согласия) ─────┘
/admin (Supabase Auth + RLS is_admin) ── CRUD: заявки, клиенты, заказы, каталог, услуги, база знаний, настройки
```

## Возможности

**Лендинг**
- Каталог с фильтрами и поиском; товары загружаются из CRM (`/api/catalog`), при недоступности сервера — встроенный список `src/products.js`
- Заявки (форма и «Заказать») → CRM: клиент находится по телефону или создаётся, заявка получает источник
- AI-чат в правом нижнем углу (`src/chat.js`): ответы потоком, история сессии, заявка прямо из диалога

**Админка `/admin`**
- Обзор: показатели, график заявок по источникам, последние заявки и заказы
- Заявки: фильтры по статусу и источнику, поиск, статус, ответственный, заметка, переписка AI-чата, «Создать заказ»
- Клиенты: CRUD, история обращений и заказов
- Заказы: позиции из каталога или свои, предоплата, срок, адрес; сумма считается в базе триггером
- Каталог: товары сайта, наличие, срок изготовления, публикация
- Аналитика: конверсия, суммы, средний чек, динамика, разбивки (функция `crm_analytics`)
- AI-диалоги: переписки и вызванные инструменты
- База знаний: статьи, загрузка .pdf/.txt/.md, индексация, проверка поиска
- Настройки: контакты и условия компании, услуги, параметры чат-бота

**AI-агент** (`server/agent.js`, `api/chat.js`)
- OpenAI Responses API, модель `gpt-6-luna` (`OPENAI_MODEL`), потоковый ответ, официальный SDK `openai`
- Полный цикл function calling: вызов от модели → проверка аргументов (strict JSON Schema + zod) → выполнение на сервере → `function_call_output` → ответ; до 4 раундов и 8 вызовов
- Отвечает по-русски и по-кыргызски
- Заявки из чата получают источник `ai_chat`, переписка и вызванные инструменты видны в админке
- Инструменты: `search_knowledge`, `get_services`, `check_availability`, `get_business_info`, `create_lead`
- Факты — только из результатов инструментов; при отсутствии данных агент так и говорит и предлагает заявку
- `create_lead`: только после явного согласия (`consent_confirmed: true`), телефон обязан быть в сообщениях посетителя, одна заявка на диалог, не больше 3 заявок в час с устройства
- Лимиты: 20 сообщений за 10 минут с IP, 60 сообщений на диалог, общий суточный лимит (`CHAT_DAILY_LIMIT`), сообщение до 1000 символов
- Расходы: модели передаются последние 12 сообщений и только найденные RAG-фрагменты, `max_output_tokens` 900, `reasoning.effort=low`, кэширование префикса (`prompt_cache_key`), `store: false`; токены каждого ответа сохраняются (`chat_messages.input_tokens/output_tokens`) и видны в «AI-диалогах» и «Аналитике»

**RAG** (`server/kb.js`, SQL `match_kb_chunks`)
- Документ → фрагменты ~900 символов с перекрытием → `kb_chunks` (tsvector, русская морфология) + embeddings OpenAI `text-embedding-3-small`, 1536 измерений (pgvector, HNSW)
- Сохранение документа в админке сразу переиндексирует его; векторы неизменённых фрагментов берутся из базы без повторного запроса к OpenAI
- Поиск гибридный: полнотекстовый + векторный, объединение Reciprocal Rank Fusion
- Если embeddings недоступны (нет ключа OpenAI), индекс строится без них и работает честный полнотекстовый поиск; режим виден в админке

## Структура

```
index.html, src/          — лендинг (main.js — каталог и формы, chat.js — AI-чат, style.css)
admin/                    — админ-панель (React + TS): app.tsx, pages/*, ui.tsx, charts.tsx
api/lead.js               — заявка с сайта → CRM → Telegram
api/catalog.js            — публичный каталог из Supabase
api/chat.js               — AI-чат (GET — настройки и история, POST — ответ потоком)
api/admin/kb.js           — индексация, загрузка файлов и проверка поиска (только админ)
api/telegram.js           — webhook Telegram-бота (/start, /history)
server/                   — серверные модули: db (Supabase), auth (проверка админа), openai (клиент), kb (RAG), agent (промпт и инструменты)
supabase/migrations/      — SQL-миграции (схема, RLS, функции, начальные данные с сайта)
scripts/                  — create-admin.mjs, kb-reindex.mjs, telegram-local.mjs
tests/                    — тесты (npm test), сеть подменена
```

## База данных

Таблицы: `admins`, `clients`, `products`, `services`, `applications`, `orders`, `order_items`, `company_settings`, `kb_documents`, `kb_chunks`, `chat_sessions`, `chat_messages`, `rate_limits`.

Безопасность:
- RLS включён на всех таблицах. У `anon` нет прав ни на одну таблицу.
- `authenticated` проходит RLS только при наличии строки в `admins` (`public.is_admin()`).
- Публичной регистрации с правами нет: администратора добавляет только сервер (`npm run admin:create`).
- Секретный ключ используется только в `api/` и `server/`. В браузер попадают лишь адрес проекта и publishable-ключ.

Применение миграций: Supabase → SQL Editor → выполнить по очереди файлы из `supabase/migrations/` (или `supabase db push`).

## Запуск

```bash
npm install
cp .env.example .env      # SUPABASE_URL, SUPABASE_SECRET_KEY, SUPABASE_PUBLISHABLE_KEY, Telegram, OPENAI_API_KEY
npm run dev               # сайт http://localhost:5173, админка http://localhost:5173/admin
npm run admin:create -- you@example.com "Имя"   # создать администратора (пароль покажется один раз)
npm run kb:reindex        # построить индекс базы знаний (или кнопка в админке)
npm test                  # тесты
npm run typecheck         # TypeScript админки
```

## Переменные окружения

| Переменная | Где | Зачем |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | сервер | доступ к базе из функций |
| `SUPABASE_PUBLISHABLE_KEY` | сборка | вход в админку (публичный, защищён RLS) |
| `OPENAI_API_KEY` | сервер (Vercel: Sensitive) | AI-чат, function calling, embeddings |
| `OPENAI_MODEL`, `OPENAI_EMBEDDING_MODEL` | сервер | `gpt-6-luna`, `text-embedding-3-small` |
| `OPENAI_REASONING_EFFORT`, `CHAT_DAILY_LIMIT` | сервер, необязательно | глубина рассуждений, суточный лимит сообщений |
| `TELEGRAM_*` | сервер | уведомления и бот |

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
3. Добавить переменные окружения `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_PUBLISHABLE_KEY` (`TELEGRAM_DRY_RUN` на Vercel не нужен).
   Для AI-агента добавьте `OPENAI_API_KEY` (тип Sensitive), `OPENAI_MODEL`, `OPENAI_EMBEDDING_MODEL`.
4. Deploy. После этого каждый `git push` в `main` деплоится автоматически.

## Что заменить на реальные данные

- [ ] Контакты в футере (`index.html`): телефон, WhatsApp, Telegram, Instagram, адрес, график
- [ ] Товары, цены и фото — в админке, раздел «Каталог» (`src/products.js` — только запасной список)
- [ ] Контакты, адрес, оплата — в админке, «Настройки» (их использует AI-агент)
- [ ] Тексты и цифры в блоке «О нас»
- [ ] Отзывы — сейчас это примеры, нужны реальные
- [ ] Фото — сейчас с Unsplash, заменить на свои (положить в `public/images/`)
