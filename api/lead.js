// Приём заявки с сайта: сохранение в Supabase и уведомление в Telegram.
// Работает как Vercel Serverless Function (POST /api/lead),
// а в режиме разработки подключается через vite.config.js.
//
// Порядок: проверка данных → RPC create_application (клиент находится по телефону или создаётся,
// заявка попадает в CRM) → сообщение в Telegram.
// Клиент получает «успешно» только если заявка сохранена в базе.
// Если Telegram недоступен, заявка остаётся в базе, а ошибка пишется в лог.

const MAX_LEN = { name: 80, phone: 30, product: 120, productId: 64, comment: 1000 };
const SOURCES = new Set(['site', 'modal']);
const QUANTITY = { min: 1, max: 99, default: 1 };
const MAX_BODY = 16 * 1024;
const TIMEOUT_MS = 8000;

export function send(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

export class BodyTooLarge extends Error {}

// Разбор тела запроса. На Vercel тело уже получено и разбирается платформой (req.body),
// в `npm run dev` читаем поток сами — один раз, с ограничением в байтах.
//
// Гарантии лимита (limit, по умолчанию MAX_BODY):
// - поток (npm run dev): читается не больше limit байт, дальше чтение прерывается;
// - Vercel: тело к моменту вызова уже принято платформой целиком (её предел — 4,5 МБ).
//   Мы отклоняем запрос по заголовку Content-Length до разбора JSON, а без заголовка
//   (chunked) — после разбора, по размеру содержимого. Память под тело до 4,5 МБ
//   платформа уже потратила; в базу в любом случае попадают поля, обрезанные clean().
export async function readBody(req, limit = MAX_BODY) {
  if (Number(req.headers?.['content-length']) > limit) throw new BodyTooLarge();

  const preParsed = req.body;
  if (Buffer.isBuffer(preParsed)) {
    if (preParsed.length > limit) throw new BodyTooLarge();
    return parseJson(preParsed.toString('utf8'));
  }
  if (typeof preParsed === 'string') {
    if (Buffer.byteLength(preParsed) > limit) throw new BodyTooLarge();
    return parseJson(preParsed);
  }
  if (preParsed && typeof preParsed === 'object') {
    // Исходные байты уже недоступны — оцениваем размер по разобранному объекту
    if (Buffer.byteLength(JSON.stringify(preParsed)) > limit) throw new BodyTooLarge();
    return preParsed;
  }
  if (req.readableEnded) return {};

  // Собираем Buffer-ы и декодируем один раз: при склейке строк русская буква,
  // разрезанная между кусками, превратилась бы в «��».
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += buf.length;
    if (size > limit) throw new BodyTooLarge();
    chunks.push(buf);
  }
  return parseJson(Buffer.concat(chunks).toString('utf8'));
}

function parseJson(text) {
  return text.trim() ? JSON.parse(text) : {};
}

function clean(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

// Количество необязательно (старые формы его не передают) — тогда 1.
// Если передано, это должно быть целое число от 1 до 99, иначе null.
function parseQuantity(value) {
  if (value === undefined || value === null || String(value).trim() === '') return QUANTITY.default;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return n >= QUANTITY.min && n <= QUANTITY.max ? n : null;
}

export function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Запись в Supabase через RPC create_application с секретным ключом (обходит RLS только на сервере).
// Функция в одной транзакции находит клиента по цифрам телефона (или создаёт) и добавляет заявку.
// Возвращает id новой заявки или выбрасывает ошибку. Используется и формой, и AI-агентом.
export async function saveApplication(lead) {
  const baseUrl = process.env.SUPABASE_URL.replace(/\/+$/, '');
  const key = process.env.SUPABASE_SECRET_KEY;

  const response = await fetch(`${baseUrl}/rest/v1/rpc/create_application`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      p_name: lead.name,
      p_phone: lead.phone,
      p_source: lead.source || 'site',
      p_product_id: lead.productId || null,
      p_product_name: lead.product || null,
      p_quantity: lead.quantity,
      p_comment: lead.comment || null,
      p_chat_session_id: lead.chatSessionId || null,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    // В лог — только код и текст ошибки; поле details может содержать данные клиента.
    const error = await response.json().catch(() => ({}));
    throw new Error(`Supabase insert failed: HTTP ${response.status} ${error.code || ''} ${String(error.message || '').slice(0, 300)}`);
  }

  const id = await response.json().catch(() => null);
  if (!Number.isInteger(id)) throw new Error('Supabase insert returned no row');
  return id;
}

export async function notifyTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error('TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID не заданы');

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    const details = (await response.text().catch(() => '')).slice(0, 500);
    throw new Error(`Telegram API error: HTTP ${response.status} ${details}`);
  }
}

// Текст ошибки для лога без секретов и персональных данных:
// - путь /bot<токен> из URL Telegram;
// - ключи Supabase (sb_secret_..., sb_publishable_..., JWT) и OpenAI (sk-...);
// - похожее на номер телефона (Postgres может повторить введённое значение в тексте ошибки).
export function safeError(err) {
  const message = err?.name === 'TimeoutError' ? 'timeout' : String(err?.message || err);
  return message
    .replace(/bot\d+:[\w-]+/g, 'bot<hidden>')
    .replace(/sb_(secret|publishable)_[\w-]+/g, 'sb_<hidden>')
    .replace(/sk-[\w-]{10,}/g, 'sk-<hidden>')
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '<jwt hidden>')
    .replace(/\+?\d[\d\s()-]{6,}\d/g, '<digits hidden>')
    .slice(0, 500);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { ok: false, error: 'Метод не поддерживается' });
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
    console.error('SUPABASE_URL или SUPABASE_SECRET_KEY не заданы');
    return send(res, 500, { ok: false, error: 'Сервис заявок не настроен' });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    if (err instanceof BodyTooLarge) return send(res, 413, { ok: false, error: 'Слишком большой запрос' });
    return send(res, 400, { ok: false, error: 'Некорректный запрос' });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return send(res, 400, { ok: false, error: 'Некорректный запрос' });
  }

  // Скрытое поле-ловушка: люди его не видят, боты заполняют
  if (body.website) return send(res, 200, { ok: true });

  const name = clean(body.name, MAX_LEN.name);
  const phone = clean(body.phone, MAX_LEN.phone);
  const product = clean(body.product, MAX_LEN.product);
  const comment = clean(body.comment, MAX_LEN.comment);
  const productId = clean(body.product_id, MAX_LEN.productId);
  const source = SOURCES.has(body.source) ? body.source : 'site';
  const quantity = parseQuantity(body.quantity);

  if (name.length < 2) {
    return send(res, 400, { ok: false, error: 'Укажите имя' });
  }
  if (phone.replace(/\D/g, '').length < 9) {
    return send(res, 400, { ok: false, error: 'Укажите корректный номер телефона' });
  }
  if (quantity === null) {
    return send(res, 400, { ok: false, error: `Количество — целое число от ${QUANTITY.min} до ${QUANTITY.max}` });
  }

  let id;
  try {
    id = await saveApplication({ name, phone, product, productId, quantity, comment, source });
  } catch (err) {
    console.error('Заявка НЕ сохранена:', safeError(err));
    return send(res, 502, { ok: false, error: 'Не удалось отправить заявку' });
  }

  const lines = [
    `<b>Новая заявка с сайта WOODORA</b> (№${id})`,
    '',
    `<b>Имя:</b> ${escapeHtml(name)}`,
    `<b>Телефон:</b> ${escapeHtml(phone)}`,
  ];
  if (product) lines.push(`<b>Товар:</b> ${escapeHtml(product)}`);
  lines.push(`<b>Количество:</b> ${quantity}`);
  if (comment) lines.push(`<b>Комментарий:</b> ${escapeHtml(comment)}`);

  try {
    await notifyTelegram(lines.join('\n'));
  } catch (err) {
    // Заявка уже в базе — клиенту отвечаем успехом, уведомление можно найти по №.
    console.error(`Заявка №${id} сохранена, но уведомление в Telegram не отправлено:`, safeError(err));
  }

  return send(res, 200, { ok: true });
}
