// Локальная проверка webhook: отправляет в `npm run dev` поддельное обновление Telegram.
//
//   npm run tg:local -- /history            — команда от вашего чата (TELEGRAM_CHAT_ID)
//   npm run tg:local -- /start --foreign    — то же от постороннего чата (должно игнорироваться)
//   npm run tg:local -- /start --bad-secret — с неверным секретом (ожидается 401)
//
// Без TELEGRAM_DRY_RUN=1 в .env dev-сервер отправит ответы бота в настоящий Telegram,
// поэтому скрипт откажется работать, если не передать --real.
// Значения секретов из .env не выводятся.

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const text = args.find((a) => !a.startsWith('--')) ?? '/start';
const flag = (name) => args.includes(`--${name}`);
const port = process.env.PORT || '5173';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((line) => /^\s*[A-Z_][A-Z0-9_]*\s*=/.test(line))
    .map((line) => {
      const i = line.indexOf('=');
      return [line.slice(0, i).trim(), line.slice(i + 1).trim().replace(/^(['"])(.*)\1$/, '$2')];
    }),
);

for (const name of ['TELEGRAM_WEBHOOK_SECRET', 'TELEGRAM_CHAT_ID']) {
  if (!env[name]) {
    console.error(`В .env нет ${name}`);
    process.exit(1);
  }
}
if (env.TELEGRAM_DRY_RUN !== '1' && !flag('real')) {
  console.error('В .env нет TELEGRAM_DRY_RUN=1: ответы ушли бы в настоящий Telegram.');
  console.error('Добавьте TELEGRAM_DRY_RUN=1 и перезапустите `npm run dev` или запустите с --real.');
  process.exit(1);
}

const chatId = flag('foreign') ? 1 : Number(env.TELEGRAM_CHAT_ID);
const update = {
  update_id: Date.now(),
  message: {
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
    chat: { id: chatId, type: 'private' },
    from: { id: chatId, is_bot: false, first_name: 'Local test' },
    text,
  },
};

const response = await fetch(`http://localhost:${port}/api/telegram`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Telegram-Bot-Api-Secret-Token': flag('bad-secret') ? 'wrong-secret' : env.TELEGRAM_WEBHOOK_SECRET,
  },
  body: JSON.stringify(update),
});
console.log(`POST /api/telegram «${text}»${flag('foreign') ? ' (посторонний чат)' : ''} → HTTP ${response.status} ${await response.text()}`);
console.log('Ответы бота (в режиме dry-run) смотрите в терминале с `npm run dev`.');
