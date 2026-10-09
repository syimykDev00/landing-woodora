// Приём заявки с сайта и отправка её в Telegram.
// Работает как Vercel Serverless Function (POST /api/lead),
// а в режиме разработки подключается через vite.config.js.

const MAX_LEN = { name: 80, phone: 30, product: 120, comment: 1000 };

function send(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);

  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function clean(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { ok: false, error: 'Метод не поддерживается' });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error('TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID не заданы');
    return send(res, 500, { ok: false, error: 'Сервис заявок не настроен' });
  }

  let body;
  try {
    body = await readBody(req);
  } catch {
    return send(res, 400, { ok: false, error: 'Некорректный запрос' });
  }

  // Скрытое поле-ловушка: люди его не видят, боты заполняют
  if (body.website) return send(res, 200, { ok: true });

  const name = clean(body.name, MAX_LEN.name);
  const phone = clean(body.phone, MAX_LEN.phone);
  const product = clean(body.product, MAX_LEN.product);
  const comment = clean(body.comment, MAX_LEN.comment);

  if (name.length < 2) {
    return send(res, 400, { ok: false, error: 'Укажите имя' });
  }
  if (phone.replace(/\D/g, '').length < 9) {
    return send(res, 400, { ok: false, error: 'Укажите корректный номер телефона' });
  }

  const lines = [
    '<b>Новая заявка с сайта WOODORA</b>',
    '',
    `<b>Имя:</b> ${escapeHtml(name)}`,
    `<b>Телефон:</b> ${escapeHtml(phone)}`,
  ];
  if (product) lines.push(`<b>Товар:</b> ${escapeHtml(product)}`);
  if (comment) lines.push(`<b>Комментарий:</b> ${escapeHtml(comment)}`);

  try {
    const tg = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: lines.join('\n'), parse_mode: 'HTML' }),
    });
    if (!tg.ok) {
      console.error('Telegram API error', tg.status, await tg.text());
      return send(res, 502, { ok: false, error: 'Не удалось отправить заявку' });
    }
  } catch (err) {
    console.error('Telegram request failed', err);
    return send(res, 502, { ok: false, error: 'Не удалось отправить заявку' });
  }

  return send(res, 200, { ok: true });
}
