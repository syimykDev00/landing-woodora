// Webhook Telegram-бота: команды /start и /history.
// Работает как Vercel Serverless Function (POST /api/telegram),
// а в режиме разработки подключается через vite.config.js.
//
// Защита:
// - заголовок X-Telegram-Bot-Api-Secret-Token сверяется с TELEGRAM_WEBHOOK_SECRET;
// - команды выполняются только для чата TELEGRAM_CHAT_ID (сравнение строк);
// - заявки читаются через Supabase REST API серверным ключом (RLS остаётся включённым).
//
// Если секрет проверен, отвечаем 200 даже при внутренних ошибках:
// на любой другой код Telegram будет повторять то же обновление снова и снова.

import { createHash, timingSafeEqual } from 'node:crypto';
import { send, readBody, escapeHtml, safeError } from './lead.js';

const TIMEOUT_MS = 8000;
const MAX_UPDATE_BODY = 256 * 1024; // обновление с длинным сообщением и ответом на него больше 16 КБ
const HISTORY_DAYS = 7;
const HISTORY_LIMIT = 200; // больше — слишком много сообщений подряд; итог всё равно покажет общее число
const MESSAGE_LIMIT = 4096; // Telegram: до 4096 символов после разбора HTML
const PART_LABEL_RESERVE = 40; // место под «Часть N/M»
const FIELD_LIMIT = { customer_name: 200, phone: 60, product_name: 300, comment: 1500, status: 40 };
const COLUMNS = 'id,created_at,customer_name,phone,product_name,quantity,comment,status';

export const HELP_TEXT = [
  '<b>Бот заявок WOODORA</b>',
  '',
  '/start — список команд',
  `/history — заявки за последние ${HISTORY_DAYS} дней`,
].join('\n');

// Сравнение за постоянное время: по времени ответа нельзя подобрать секрет по символам.
// Хэши выравнивают длину, которую требует timingSafeEqual.
function secretMatches(header, secret) {
  if (typeof header !== 'string' || header === '') return false;
  const a = createHash('sha256').update(header).digest();
  const b = createHash('sha256').update(secret).digest();
  return timingSafeEqual(a, b);
}

// «/history», «/history@Woodora_new_bot», «/history что-то» → «history»
export function parseCommand(text) {
  const match = /^\/([a-z_]+)(?:@\w+)?(?:\s|$)/i.exec(text.trim());
  return match ? match[1].toLowerCase() : null;
}

const dateFormat = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Asia/Bishkek',
  day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit',
});

export function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value ?? '') : dateFormat.format(date);
}

const present = (value) => value !== null && value !== undefined && String(value).trim() !== '';

// Значение из базы: обрезаем слишком длинное (в базе нет ограничения длины), затем экранируем
function field(value, max) {
  let text = String(value).trim();
  if (text.length > max) text = `${text.slice(0, max)}…`;
  return escapeHtml(text);
}

export function formatApplication(row) {
  const lines = [`<b>№${escapeHtml(String(row.id))}</b> · ${escapeHtml(formatDate(row.created_at))}`];
  if (present(row.customer_name)) lines.push(`<b>Имя:</b> ${field(row.customer_name, FIELD_LIMIT.customer_name)}`);
  if (present(row.phone)) lines.push(`<b>Телефон:</b> ${field(row.phone, FIELD_LIMIT.phone)}`);
  if (present(row.product_name)) lines.push(`<b>Товар:</b> ${field(row.product_name, FIELD_LIMIT.product_name)}`);
  if (present(row.quantity)) lines.push(`<b>Количество:</b> ${escapeHtml(String(row.quantity))}`);
  if (present(row.comment)) lines.push(`<b>Комментарий:</b> ${field(row.comment, FIELD_LIMIT.comment)}`);
  if (present(row.status)) lines.push(`<b>Статус:</b> ${field(row.status, FIELD_LIMIT.status)}`);
  return lines.join('\n');
}

// Длина так, как её считает Telegram: без HTML-тегов, сущность (&amp;) — один символ
export function visibleLength(html) {
  return html.replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot|#\d+);/g, '_').length;
}

// Упаковка записей в сообщения. Запись никогда не разрезается, поэтому HTML-теги
// остаются парными, а каждая запись целиком попадает ровно в одно сообщение.
export function splitMessages(header, blocks, limit = MESSAGE_LIMIT - PART_LABEL_RESERVE) {
  const messages = [];
  let current = header;
  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (visibleLength(candidate) <= limit) {
      current = candidate;
    } else {
      if (current) messages.push(current);
      current = block; // одна запись короче лимита благодаря FIELD_LIMIT
    }
  }
  if (current) messages.push(current);
  if (messages.length < 2) return messages;
  return messages.map((text, i) => `<i>Часть ${i + 1}/${messages.length}</i>\n${text}`);
}

// Заявки за последние 7 суток, от новых к старым
export async function fetchHistory(now = Date.now()) {
  const baseUrl = process.env.SUPABASE_URL.replace(/\/+$/, '');
  const key = process.env.SUPABASE_SECRET_KEY;
  const since = new Date(now - HISTORY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const params = new URLSearchParams({
    select: COLUMNS,
    created_at: `gte.${since}`,
    order: 'created_at.desc,id.desc',
    limit: String(HISTORY_LIMIT),
  });

  const response = await fetch(`${baseUrl}/rest/v1/applications?${params}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    // В лог — только код и текст ошибки, без details
    const error = await response.json().catch(() => ({}));
    throw new Error(`Supabase select failed: HTTP ${response.status} ${error.code || ''} ${String(error.message || '').slice(0, 300)}`);
  }
  const rows = await response.json().catch(() => null);
  if (!Array.isArray(rows)) throw new Error('Supabase select returned no array');

  // Content-Range: «0-199/350» или «*/0» — после «/» общее число строк
  const total = Number(response.headers.get('content-range')?.split('/')[1]);
  return { rows, total: Number.isFinite(total) && total >= rows.length ? total : rows.length };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Отправка одного сообщения. При 429 (слишком часто) — одна повторная попытка после паузы.
async function telegramSendMessage(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.ok) return;
    const data = await response.json().catch(() => ({}));
    const retryAfter = Number(data?.parameters?.retry_after);
    if (response.status === 429 && attempt === 0 && retryAfter > 0 && retryAfter <= 5) {
      await sleep(retryAfter * 1000);
      continue;
    }
    throw new Error(`Telegram API error: HTTP ${response.status} ${String(data?.description || '').slice(0, 200)}`);
  }
}

async function sendHistory(chatId, sendMessage) {
  let history;
  try {
    history = await fetchHistory();
  } catch (err) {
    console.error('/history: заявки не получены из Supabase:', safeError(err));
    await sendMessage(chatId, 'Не удалось получить историю заявок. Попробуйте позже.');
    return;
  }

  const { rows, total } = history;
  if (rows.length === 0) {
    await sendMessage(chatId, `За последние ${HISTORY_DAYS} дней заявок нет.`);
    return;
  }

  let header = `<b>Заявки за последние ${HISTORY_DAYS} дней: ${total}</b>`;
  if (total > rows.length) header += `\nПоказаны последние ${rows.length}, остальные — в Supabase.`;
  const messages = splitMessages(header, rows.map(formatApplication));

  // Ошибка одной части не останавливает отправку остальных
  let failed = 0;
  for (const text of messages) {
    try {
      await sendMessage(chatId, text);
    } catch (err) {
      failed++;
      console.error('/history: часть не отправлена:', safeError(err));
    }
  }
  if (failed) console.error(`/history: не отправлено ${failed} из ${messages.length} сообщений`);
}

// sendMessage можно подменить (тесты, локальный «сухой прогон» без реальных сообщений)
export function createTelegramHandler({ sendMessage = telegramSendMessage } = {}) {
  return async function telegramWebhook(req, res) {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return send(res, 405, { ok: false, error: 'Метод не поддерживается' });
    }

    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    const allowedChatId = String(process.env.TELEGRAM_CHAT_ID ?? '').trim();
    const missing = ['TELEGRAM_WEBHOOK_SECRET', 'TELEGRAM_CHAT_ID', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY']
      .concat(sendMessage === telegramSendMessage ? ['TELEGRAM_BOT_TOKEN'] : [])
      .filter((name) => !String(process.env[name] ?? '').trim());
    if (missing.length) {
      console.error('Webhook Telegram не настроен, нет переменных:', missing.join(', '));
      return send(res, 500, { ok: false });
    }

    if (!secretMatches(req.headers?.['x-telegram-bot-api-secret-token'], secret)) {
      return send(res, 401, { ok: false });
    }

    let update;
    try {
      update = await readBody(req, MAX_UPDATE_BODY);
    } catch {
      console.error('Webhook Telegram: обновление не разобрано, пропущено');
      return send(res, 200, { ok: true });
    }

    const message = update?.message;
    const chatId = message?.chat?.id;
    if (!message || chatId === undefined || chatId === null || typeof message.text !== 'string') {
      return send(res, 200, { ok: true }); // не текстовое сообщение — игнорируем
    }
    if (String(chatId).trim() !== allowedChatId) {
      console.warn('Webhook Telegram: сообщение из постороннего чата проигнорировано');
      return send(res, 200, { ok: true });
    }

    const command = parseCommand(message.text);
    try {
      if (command === 'start' || command === 'help') {
        await sendMessage(chatId, HELP_TEXT);
      } else if (command === 'history') {
        await sendHistory(chatId, sendMessage);
      } else {
        await sendMessage(chatId, `Неизвестная команда.\n\n${HELP_TEXT}`);
      }
    } catch (err) {
      console.error(`Webhook Telegram: ошибка команды /${command ?? '?'}:`, safeError(err));
    }

    return send(res, 200, { ok: true });
  };
}

export default createTelegramHandler();
