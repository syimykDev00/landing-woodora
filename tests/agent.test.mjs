// Тесты RAG-нарезки, защиты инструмента create_lead и валидации /api/chat.
// Сеть подменена: реальные Supabase, Telegram и AI Gateway не вызываются.
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'sb_secret_TESTKEY';

let fetchCalls = [];
globalThis.fetch = async (url) => { fetchCalls.push(String(url)); throw new Error('сеть запрещена в тестах'); };
console.error = () => {};

const { chunkText } = await import('../server/kb.js');
const { createTools, systemPrompt } = await import('../server/agent.js');
const { default: chatHandler } = await import('../api/chat.js');

const results = [];
async function test(name, fn) {
  fetchCalls = [];
  try { await fn(); results.push(`ok   ${name}`); } catch (e) { results.push(`FAIL ${name}: ${e.message}`); }
}

// --- chunkText ---
await test('короткий текст — один фрагмент', () => {
  assert.deepEqual(chunkText('Гарантия на каркас.'), ['Гарантия на каркас.']);
});
await test('пустой текст — нет фрагментов', () => {
  assert.deepEqual(chunkText('   \n\n  '), []);
});
await test('длинный текст режется на фрагменты не длиннее предела + перекрытие', () => {
  const para = 'Мы делаем мебель из массива дуба и ясеня. '.repeat(60);
  const chunks = chunkText(`${para}\n\n${para}`, 500, 100);
  assert.ok(chunks.length > 3, `фрагментов: ${chunks.length}`);
  for (const c of chunks) assert.ok(c.length <= 500 + 100 + 2, `длина ${c.length}`);
  assert.ok(chunks.join(' ').includes('ясеня'));
});
await test('соседние фрагменты перекрываются', () => {
  const text = Array.from({ length: 12 }, (_, i) => `Абзац номер ${i} про доставку и сборку мебели.`).join('\n\n');
  const chunks = chunkText(text, 120, 40);
  const tail = chunks[0].slice(-15);
  assert.ok(chunks[1].includes(tail.trim().split(' ').pop()), 'нет перекрытия');
});

// --- create_lead ---
const makeTools = (userText) => createTools({ sessionId: '00000000-0000-0000-0000-000000000000', ipHash: 'x', userText: () => userText }).tools;

await test('create_lead: телефон, которого посетитель не писал, отклоняется без записи в базу', async () => {
  const tools = makeTools('Хочу диван, меня зовут Айбек');
  const r = await tools.create_lead.execute(
    { name: 'Айбек', phone: '+996 555 123 456', quantity: 1, consent_confirmed: true },
    { toolCallId: '1', messages: [] },
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /не писал/);
  assert.equal(fetchCalls.length, 0, 'обращение к сети');
});
await test('create_lead: короткий телефон отклоняется', async () => {
  const tools = makeTools('мой номер 12345');
  const r = await tools.create_lead.execute({ name: 'Айбек', phone: '12345', quantity: 1, consent_confirmed: true }, { toolCallId: '1', messages: [] });
  assert.equal(r.ok, false);
});
await test('create_lead: схема требует consent_confirmed: true', () => {
  const schema = tools().create_lead.inputSchema;
  assert.equal(schema.safeParse({ name: 'Айбек', phone: '0555123456', consent_confirmed: false }).success, false);
  assert.equal(schema.safeParse({ name: 'Айбек', phone: '0555123456', consent_confirmed: true }).success, true);
  function tools() { return makeTools(''); }
});
await test('системный промпт: факты только из инструментов, доп. инструкции админа добавляются', () => {
  const p = systemPrompt({ company_name: 'WOODORA', bot_name: 'Помощник', bot_instructions: 'Упоминай шоурум' });
  assert.match(p, /ТОЛЬКО из результатов инструментов/);
  assert.match(p, /Упоминай шоурум/);
});

// --- /api/chat: валидация до обращения к базе и модели ---
function makeReq(method, body, headers = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  req.method = method; req.headers = headers; req.url = '/api/chat';
  return req;
}
async function call(req) {
  const res = { statusCode: 0, headers: {}, body: '', headersSent: false, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b ?? ''; this.headersSent = true; }, write() {} };
  await chatHandler(req, res);
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null, res };
}

await test('/api/chat: PUT → 405', async () => {
  const r = await call(makeReq('PUT'));
  assert.equal(r.status, 405);
});
await test('/api/chat: пустое сообщение → 400 без запросов в сеть', async () => {
  const r = await call(makeReq('POST', { message: '   ' }));
  assert.equal(r.status, 400);
  assert.equal(fetchCalls.length, 0);
});
await test('/api/chat: сообщение длиннее 1000 символов → 400', async () => {
  const r = await call(makeReq('POST', { message: 'а'.repeat(1001) }));
  assert.equal(r.status, 400);
});
await test('/api/chat: тело больше 8 КБ → 413', async () => {
  const r = await call(makeReq('POST', { message: 'ж'.repeat(5000) }));
  assert.equal(r.status, 413);
});
await test('/api/chat: без переменных Supabase → 500', async () => {
  const saved = process.env.SUPABASE_URL;
  delete process.env.SUPABASE_URL;
  try {
    const r = await call(makeReq('POST', { message: 'Привет' }));
    assert.equal(r.status, 500);
  } finally { process.env.SUPABASE_URL = saved; }
});

console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\nВсего: ${results.length}, провалено: ${failed}`);
if (failed) process.exitCode = 1;
