// AI-чат лендинга (Vercel Serverless Function, в `npm run dev` подключается через vite.config.js).
//
// GET  /api/chat?session_id=…  → настройки виджета (включён ли бот, имя, приветствие) и история сессии
// POST /api/chat { session_id?, message } → ответ агента потоком text/plain;
//      id сессии — в заголовке X-Chat-Session. Ошибка до начала ответа — JSON { ok:false, error }.
//
// История хранится в Supabase (chat_sessions/chat_messages) — клиенту не доверяем:
// контекст для модели собирается на сервере. Лимиты: сообщения с IP, длина сессии, заявки.
import { createHash } from 'node:crypto';
import { streamText, isStepCount } from 'ai';
import { send, readBody, BodyTooLarge, safeError } from './lead.js';
import { db, dbConfigured, check, rateLimit } from '../server/db.js';
import { chatModel, systemPrompt, createTools, loadSettings } from '../server/agent.js';

const MAX_MESSAGE = 1000;
const HISTORY_LIMIT = 20;
const SESSION_MESSAGE_LIMIT = 60;
const IP_LIMIT = { hits: 20, windowSeconds: 600 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const FALLBACK_REPLY = 'Извините, AI-помощник сейчас недоступен. Оставьте заявку через форму на сайте — менеджер свяжется с вами.';

export function clientIp(req) {
  const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || String(req.headers?.['x-real-ip'] || '') || req.socket?.remoteAddress || 'unknown';
}

// IP в базе не храним — только хэш с секретом сервера
const hashIp = (ip) => createHash('sha256').update(`${ip}|${process.env.SUPABASE_SECRET_KEY || ''}`).digest('hex').slice(0, 32);

async function loadHistory(sessionId) {
  const rows = check(
    await db().from('chat_messages').select('role,content,created_at')
      .eq('session_id', sessionId).order('created_at', { ascending: false }).limit(HISTORY_LIMIT),
    'chat_messages',
  );
  return rows.reverse();
}

async function handleGet(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const sessionId = url.searchParams.get('session_id');
  const settings = await loadSettings();
  let messages = [];
  if (sessionId && UUID.test(sessionId)) {
    messages = (await loadHistory(sessionId)).map(({ role, content }) => ({ role, content }));
  }
  res.setHeader('Cache-Control', 'no-store');
  return send(res, 200, {
    ok: true,
    enabled: settings.bot_enabled !== false,
    bot_name: settings.bot_name || 'Помощник',
    greeting: settings.bot_greeting || '',
    messages,
  });
}

export default async function handler(req, res) {
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Чат не настроен' });

  try {
    if (req.method === 'GET') return await handleGet(req, res);
  } catch (err) {
    console.error('chat GET:', safeError(err));
    return send(res, 500, { ok: false, error: 'Чат временно недоступен' });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return send(res, 405, { ok: false, error: 'Метод не поддерживается' });
  }

  let body;
  try {
    body = await readBody(req, 8 * 1024);
  } catch (err) {
    if (err instanceof BodyTooLarge) return send(res, 413, { ok: false, error: 'Слишком длинное сообщение' });
    return send(res, 400, { ok: false, error: 'Некорректный запрос' });
  }
  const message = String(body?.message ?? '').trim();
  if (!message) return send(res, 400, { ok: false, error: 'Пустое сообщение' });
  if (message.length > MAX_MESSAGE) return send(res, 400, { ok: false, error: `Сообщение длиннее ${MAX_MESSAGE} символов` });

  const ipHash = hashIp(clientIp(req));
  if (!(await rateLimit(`chat:${ipHash}`, IP_LIMIT.hits, IP_LIMIT.windowSeconds))) {
    return send(res, 429, { ok: false, error: 'Слишком много сообщений. Подождите несколько минут.' });
  }

  let settings, session, history;
  try {
    settings = await loadSettings();
    if (settings.bot_enabled === false) return send(res, 503, { ok: false, error: 'Чат временно отключён' });

    const requested = typeof body.session_id === 'string' && UUID.test(body.session_id) ? body.session_id : null;
    if (requested) {
      session = check(await db().from('chat_sessions').select('id,message_count').eq('id', requested).maybeSingle(), 'chat_sessions');
    }
    if (!session) {
      session = check(await db().from('chat_sessions').insert({ ip_hash: ipHash }).select('id,message_count').single(), 'chat_sessions insert');
    }
    if (session.message_count >= SESSION_MESSAGE_LIMIT) {
      return send(res, 429, { ok: false, error: 'Диалог слишком длинный. Начните новый чат или оставьте заявку.' });
    }
    history = await loadHistory(session.id);
    check(await db().from('chat_messages').insert({ session_id: session.id, role: 'user', content: message }), 'chat_messages insert');
  } catch (err) {
    console.error('chat: ошибка базы:', safeError(err));
    return send(res, 502, { ok: false, error: 'Чат временно недоступен' });
  }

  const userTexts = [...history.filter((m) => m.role === 'user').map((m) => m.content), message];
  const { tools, toolLog } = createTools({ sessionId: session.id, ipHash, userText: () => userTexts.join('\n') });

  let reply = '';
  let failed = null;
  const startStream = () => {
    if (res.headersSent) return;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Chat-Session', session.id);
    res.setHeader('X-Accel-Buffering', 'no');
  };

  try {
    const result = streamText({
      model: chatModel(),
      system: systemPrompt(settings),
      messages: [
        ...history.map(({ role, content }) => ({ role, content })),
        { role: 'user', content: message },
      ],
      tools,
      stopWhen: isStepCount(6),
      maxOutputTokens: 800,
      maxRetries: 1,
      timeout: { totalMs: 60_000 },
    });

    for await (const part of result.stream) {
      if (part.type === 'text-delta' && part.text) {
        startStream();
        reply += part.text;
        res.write(part.text);
      } else if (part.type === 'error') {
        failed = part.error;
      }
    }
  } catch (err) {
    failed = err;
  }

  if (failed) console.error('chat: ошибка модели:', safeError(failed));
  if (!reply.trim()) {
    // Модель недоступна (нет AI_GATEWAY_API_KEY/OIDC, нет кредитов) — честно сообщаем, не выдумывая ответ
    if (!res.headersSent) {
      return send(res, 503, { ok: false, error: FALLBACK_REPLY, session_id: session.id });
    }
    reply = FALLBACK_REPLY;
    res.write(reply);
  }
  res.end();

  try {
    await db().from('chat_messages').insert({
      session_id: session.id, role: 'assistant', content: reply.slice(0, 8000), tool_calls: toolLog.length ? toolLog : null,
    });
    await db().from('chat_sessions').update({ message_count: session.message_count + 2 }).eq('id', session.id);
  } catch (err) {
    console.error('chat: ответ не сохранён:', safeError(err));
  }
}
