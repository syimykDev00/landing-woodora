// Тесты RAG-нарезки, инструментов агента (строгие схемы, проверка аргументов, create_lead) и /api/chat.
// Сеть подменена: реальные Supabase, Telegram и OpenAI не вызываются.
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'sb_secret_TESTKEY';
process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key-000000';

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

// --- инструменты: строгие схемы и серверная проверка ---
const { TOOL_DEFINITIONS } = await import('../server/agent.js');
const makeTools = (userText) => createTools({ sessionId: '00000000-0000-0000-0000-000000000000', ipHash: 'x', userText: () => userText });
const run = async (tools, name, args) => JSON.parse(await tools.execute(name, JSON.stringify(args)));
const lead = (extra = {}) => ({ name: 'Айбек', phone: '+996 555 123 456', product_id: null, interest: null, quantity: 1, comment: null, consent_confirmed: true, ...extra });

await test('5 инструментов, у каждого strict-схема: все поля обязательны, лишние запрещены', () => {
  assert.deepEqual(TOOL_DEFINITIONS.map((t) => t.name), ['search_knowledge', 'get_services', 'check_availability', 'get_business_info', 'create_lead']);
  for (const t of TOOL_DEFINITIONS) {
    assert.equal(t.type, 'function'); assert.equal(t.strict, true);
    assert.equal(t.parameters.additionalProperties, false, t.name);
    assert.deepEqual([...t.parameters.required].sort(), Object.keys(t.parameters.properties).sort(), t.name);
  }
});
await test('create_lead: телефон, которого посетитель не писал, отклоняется без записи в базу', async () => {
  const r = await run(makeTools('Хочу диван, меня зовут Айбек'), 'create_lead', lead());
  assert.equal(r.ok, false); assert.match(r.error, /не писал/);
  assert.equal(fetchCalls.length, 0, 'обращение к сети');
});
await test('create_lead: без согласия (consent_confirmed=false) заявка не создаётся', async () => {
  const r = await run(makeTools('мой номер +996 555 123 456'), 'create_lead', lead({ consent_confirmed: false }));
  assert.equal(r.ok, false); assert.match(r.error, /подтверждения/);
  assert.equal(fetchCalls.length, 0);
});
await test('create_lead: короткий телефон отклоняется проверкой аргументов', async () => {
  const r = await run(makeTools('мой номер 12345'), 'create_lead', lead({ phone: '12345' }));
  assert.equal(r.ok, false); assert.match(r.error, /Некорректные аргументы/);
});
await test('лишнее поле в аргументах отклоняется', async () => {
  const r = await run(makeTools(''), 'get_business_info', { sql: 'drop table clients' });
  assert.equal(r.ok, false); assert.equal(fetchCalls.length, 0);
});
await test('неизвестный инструмент и битый JSON не выполняются', async () => {
  const tools = makeTools('');
  assert.equal(JSON.parse(await tools.execute('run_sql', '{}')).ok, false);
  assert.equal(JSON.parse(await tools.execute('search_knowledge', '{не json')).ok, false);
  assert.equal(fetchCalls.length, 0);
});
await test('журнал инструментов не хранит телефон целиком', async () => {
  const tools = makeTools('');
  await tools.execute('create_lead', JSON.stringify(lead()));
  assert.ok(!JSON.stringify(tools.toolLog).includes('123 456'));
});
await test('системный промпт: факты из инструментов, кыргызский язык, доп. инструкции админа', () => {
  const p = systemPrompt({ company_name: 'WOODORA', bot_name: 'Помощник', bot_instructions: 'Упоминай шоурум' });
  assert.match(p, /ТОЛЬКО из результатов инструментов/);
  assert.match(p, /кыргызски/);
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
await test('/api/chat: без OPENAI_API_KEY → 503 с честным сообщением, без запросов', async () => {
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const r = await call(makeReq('POST', { message: 'Привет' }));
    assert.equal(r.status, 503); assert.match(r.json.error, /недоступен/);
    assert.equal(fetchCalls.length, 0);
  } finally { process.env.OPENAI_API_KEY = saved; }
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
