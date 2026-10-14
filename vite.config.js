import { defineConfig, loadEnv } from 'vite';
import leadHandler from './api/lead.js';
import telegramHandler, { createTelegramHandler } from './api/telegram.js';

// Серверные переменные для /api/* в режиме разработки.
// Без префикса VITE_, поэтому в код для браузера они не попадают.
const SERVER_ENV = [
  'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_WEBHOOK_SECRET',
  'SUPABASE_URL', 'SUPABASE_SECRET_KEY',
];

// Локальный «сухой прогон» webhook (TELEGRAM_DRY_RUN=1 в .env): ответы бота печатаются
// в терминал вместо отправки в Telegram. Есть только в `npm run dev`, на Vercel его нет.
const dryRunTelegramHandler = createTelegramHandler({
  sendMessage: async (chatId, text) => {
    console.log(`\n[telegram dry-run] сообщение в чат (${text.length} симв.):\n${text}\n`);
  },
});

// Подключает Vercel-функцию к dev-серверу. Обработчик вызывается один раз.
// Непойманная ошибка уходит в обработчик ошибок Vite (а не повторно в handler) —
// иначе запрос повис бы без ответа.
function mount(server, path, handler) {
  server.middlewares.use(path, (req, res, next) => {
    handler(req, res).catch((err) => {
      if (res.headersSent) {
        console.error(`Ошибка ${path} после отправки ответа:`, err?.message);
        if (!res.writableEnded) res.destroy?.();
        return;
      }
      next(err);
    });
  });
}

// В разработке обслуживаем /api/* теми же обработчиками, что и на Vercel,
// чтобы форму и webhook можно было проверить через `npm run dev`.
function devApi({ dryRun }) {
  return {
    name: 'dev-api',
    configureServer(server) {
      mount(server, '/api/lead', leadHandler);
      mount(server, '/api/telegram', dryRun ? dryRunTelegramHandler : telegramHandler);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), ['TELEGRAM_', 'SUPABASE_']);
  for (const name of SERVER_ENV) {
    if (env[name] && !process.env[name]) process.env[name] = env[name];
  }
  return { plugins: [devApi({ dryRun: env.TELEGRAM_DRY_RUN === '1' })] };
});
