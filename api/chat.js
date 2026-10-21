// AI-чат лендинга (Vercel Serverless Function, в `npm run dev` подключается через vite.config.js).
// Модель — OpenAI через Responses API (по умолчанию gpt-6-luna), только на сервере.
//
// GET  /api/chat?session_id=…  → настройки виджета (включён ли бот, имя, приветствие) и история сессии
// POST /api/chat { session_id?, message } → ответ агента потоком text/plain;
//      id сессии — в заголовке X-Chat-Session. Ошибка до начала ответа — JSON { ok:false, error }.
//
// Цикл function calling: модель → вызовы функций → серверная проверка аргументов и выполнение →
// function_call_output обратно модели → … → текст ответа. Число раундов и вызовов ограничено.
// История хранится в Supabase (chat_sessions/chat_messages) — клиенту не доверяем:
// контекст для модели собирается на сервере. Расходы: короткая история, лимит токенов ответа,
// лимиты сообщений с IP, на диалог и на сутки, учёт токенов по каждому ответу.
import { createHash } from 'node:crypto';
import { send, readBody, BodyTooLarge, safeError } from './lead.js';
import { db, dbConfigured, check, rateLimit } from '../server/db.js';
import { systemPrompt, createTools, loadSettings } from '../server/agent.js';
import { openai, openaiConfigured, chatModel, openaiError } from '../server/openai.js';

const MAX_MESSAGE = 1000;
const HISTORY_LIMIT = 12;          // последние сообщения диалога, которые видит модель
const HISTORY_MESSAGE_CHARS = 1500;
const SESSION_MESSAGE_LIMIT = 60;
const IP_LIMIT = { hits: 20, windowSeconds: 600 };
const MAX_TOOL_ROUNDS = 4;         // раундов «модель → функции»; затем ответ без инструментов
const MAX_TOOL_CALLS = 8;
const MAX_OUTPUT_TOKENS = 900;     // на один вызов модели, включая reasoning
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dailyLimit = () => Number(process.env.CHAT_DAILY_LIMIT) || 1000;
const reasoningEffort = () => process.env.OPENAI_REASONING_EFFORT || 'low';

export const FALLBACK_REPLY = 'Извините, AI-помощник сейчас недоступен. Оставьте заявку через форму на сайте — менеджер свяжется с вами.';
const BUSY_REPLY = 'Сейчас слишком много обращений к AI-помощнику. Попробуйте через минуту или оставьте заявку через форму на сайте.';

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
    enabled: settings.bot_enabled !== false && openaiConfigured(),
    bot_name: settings.bot_name || 'Помощник',
    greeting: settings.bot_greeting || '',
    messages,
  });
}

// Ошибки OpenAI, при которых повтор через минуту может помочь
const isRateLimit = (err) => err?.status === 429 || /rate.?limit|quota/i.test(String(err?.code || err?.message || ''));

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

  if (!openaiConfigured()) {
    console.error('chat: OPENAI_API_KEY не задан');
    return send(res, 503, { ok: false, error: FALLBACK_REPLY });
  }

  const ipHash = hashIp(clientIp(req));
  if (!(await rateLimit(`chat:${ipHash}`, IP_LIMIT.hits, IP_LIMIT.windowSeconds))) {
    return send(res, 429, { ok: false, error: 'Слишком много сообщений. Подождите несколько минут.' });
  }
  // Общий суточный предел — защита бюджета OpenAI от накрутки
  if (!(await rateLimit('chat:global:day', dailyLimit(), 86400))) {
    return send(res, 429, { ok: false, error: BUSY_REPLY });
  }

  let settings, session, history;
  try {
    settings = await loadSettings();
    if (settings.bot_enabled === false) return send(res, 503, { ok: false, error: 'Чат временно отключён' });

    const requested = typeof body.session_id === 'string' && UUID.test(body.session_id) ? body.session_id : null;
    if (requested) {
      session = check(await db().from('chat_sessions').select('id,message_count,input_tokens,output_tokens').eq('id', requested).maybeSingle(), 'chat_sessions');
    }
    if (!session) {
      session = check(await db().from('chat_sessions').insert({ ip_hash: ipHash }).select('id,message_count,input_tokens,output_tokens').single(), 'chat_sessions insert');
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
  const { definitions, execute, toolLog } = createTools({ sessionId: session.id, ipHash, userText: () => userTexts.join('\n') });

  let reply = '';
  let failed = null;
  const usage = { input: 0, output: 0, reasoning: 0, calls: 0 };
  const startStream = () => {
    if (res.headersSent) return;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Chat-Session', session.id);
    res.setHeader('X-Accel-Buffering', 'no');
  };
  const write = (text) => { startStream(); reply += text; res.write(text); };

  // Вход модели: короткая история + новое сообщение. Далее сюда добавляются вызовы функций и их результаты.
  let input = [
    ...history.map(({ role, content }) => ({ role, content: content.slice(0, HISTORY_MESSAGE_CHARS) })),
    { role: 'user', content: message },
  ];
  let toolCalls = 0;

  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const forceAnswer = round === MAX_TOOL_ROUNDS || toolCalls >= MAX_TOOL_CALLS;
      const stream = await openai().responses.create({
        model: chatModel(),
        instructions: systemPrompt(settings),
        input,
        tools: definitions,
        tool_choice: forceAnswer ? 'none' : 'auto',
        parallel_tool_calls: true,
        reasoning: { effort: reasoningEffort() },
        max_output_tokens: MAX_OUTPUT_TOKENS,
        // Без хранения на стороне OpenAI; рассуждения передаются между шагами в зашифрованном виде
        store: false,
        include: ['reasoning.encrypted_content'],
        // Общий префикс (инструкции + инструменты) кэшируется — дешевле входные токены
        prompt_cache_key: 'woodora-chat-v1',
        safety_identifier: ipHash,
        stream: true,
      });

      let final = null;
      for await (const event of stream) {
        if (event.type === 'response.output_text.delta') write(event.delta);
        else if (event.type === 'response.completed' || event.type === 'response.incomplete') final = event.response;
        else if (event.type === 'response.failed') throw Object.assign(new Error(event.response?.error?.message || 'response failed'), { code: event.response?.error?.code });
        else if (event.type === 'error') throw Object.assign(new Error(event.message || 'stream error'), { code: event.code });
      }
      if (!final) throw new Error('Ответ модели оборвался');

      usage.calls++;
      usage.input += final.usage?.input_tokens ?? 0;
      usage.output += final.usage?.output_tokens ?? 0;
      usage.reasoning += final.usage?.output_tokens_details?.reasoning_tokens ?? 0;

      const calls = final.output.filter((item) => item.type === 'function_call');
      if (!calls.length || forceAnswer) break;

      toolCalls += calls.length;
      const outputs = await Promise.all(calls.map((call) => execute(call.name, call.arguments)));
      input = [
        ...input,
        ...final.output,
        ...calls.map((call, i) => ({ type: 'function_call_output', call_id: call.call_id, output: outputs[i] })),
      ];
      if (reply && !/\s$/.test(reply)) write('\n');
    }
  } catch (err) {
    failed = err;
  }

  if (failed) console.error('chat: ошибка OpenAI:', openaiError(failed));
  if (!reply.trim()) {
    const text = failed && isRateLimit(failed) ? BUSY_REPLY : FALLBACK_REPLY;
    if (!res.headersSent) {
      await db().from('chat_messages').insert({ session_id: session.id, role: 'assistant', content: text, model: chatModel() }).then(() => {}, () => {});
      return send(res, failed && isRateLimit(failed) ? 429 : 503, { ok: false, error: text, session_id: session.id });
    }
    write(text);
  } else if (failed) {
    write('\n\n(Ответ прервался. Повторите вопрос или оставьте заявку через форму.)');
  }
  res.end();

  try {
    await db().from('chat_messages').insert({
      session_id: session.id,
      role: 'assistant',
      content: reply.slice(0, 8000),
      tool_calls: toolLog.length ? toolLog : null,
      model: chatModel(),
      input_tokens: usage.input,
      output_tokens: usage.output,
    });
    await db().from('chat_sessions').update({
      message_count: session.message_count + 2,
      input_tokens: (session.input_tokens ?? 0) + usage.input,
      output_tokens: (session.output_tokens ?? 0) + usage.output,
    }).eq('id', session.id);
  } catch (err) {
    console.error('chat: ответ не сохранён:', safeError(err));
  }
  console.log(`chat: ${chatModel()} вызовов=${usage.calls} инструментов=${toolCalls} токены in=${usage.input} out=${usage.output} (reasoning ${usage.reasoning})`);
}
