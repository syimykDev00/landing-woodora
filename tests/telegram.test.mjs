// Тесты api/telegram.js с подменённым fetch: реальные Supabase и Telegram не вызываются.
// Запуск: npm test
import { Readable } from 'node:stream';
import assert from 'node:assert/strict';

const SECRET = 'webhook-secret_TEST';
const TOKEN = '123456:FAKE-token_x';
const SB_KEY = 'sb_secret_TESTKEY';
Object.assign(process.env, {
  SUPABASE_URL: 'https://test.supabase.co/',
  SUPABASE_SECRET_KEY: SB_KEY,
  TELEGRAM_BOT_TOKEN: TOKEN,
  TELEGRAM_CHAT_ID: '1586',
  TELEGRAM_WEBHOOK_SECRET: SECRET,
});

const tg = await import('../api/telegram.js');
const handler = tg.default;

// --- Подмена fetch ---
let calls, supabase, telegram;
const sent = () => calls.filter((c) => c.url.includes('api.telegram.org')).map((c) => JSON.parse(c.init.body));
const sbCalls = () => calls.filter((c) => c.url.includes('supabase.co'));
const sbRows = (rows, total = rows.length) => () => new Response(JSON.stringify(rows), {
  status: 200, headers: { 'Content-Range': rows.length ? `0-${rows.length - 1}/${total}` : `*/${total}` },
});
const okTelegram = () => new Response('{"ok":true,"result":{}}', { status: 200 });
globalThis.fetch = async (url, init) => {
  const u = String(url);
  calls.push({ url: u, init });
  if (u.startsWith('https://test.supabase.co/')) return supabase(init, u);
  if (u.startsWith('https://api.telegram.org/')) return telegram(init, u);
  throw new Error('Неожиданный адрес: ' + u); // защита от реальных запросов
};

const logs = [];
console.error = (...a) => logs.push(a.map(String).join(' '));
console.warn = (...a) => logs.push(a.map(String).join(' '));

// --- Запрос / ответ ---
function makeReq(method, { body, headers = { 'x-telegram-bot-api-secret-token': SECRET } } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  req.method = method; req.headers = headers;
  return req;
}
const update = (text, chatId = 1586) => ({
  update_id: 1, message: { message_id: 1, date: 0, chat: { id: chatId, type: 'private' }, from: { id: chatId }, text },
});

async function call(req, h = handler) {
  const res = {
    headers: {}, statusCode: 0, body: '', endCalls: 0,
    setHeader(k, v) { this.headers[k] = v; },
    end(b) { this.endCalls++; this.body = b; },
  };
  calls = []; logs.length = 0;
  await h(req, res);
  assert.equal(res.endCalls, 1, `res.end() вызван ${res.endCalls} раз`);
  assert.ok(sbCalls().length <= 1, 'Supabase вызван больше одного раза');
  for (const c of sbCalls()) assert.equal(c.init.method ?? 'GET', 'GET', 'запрос к Supabase не только чтение');
  const allLogs = logs.join('\n');
  for (const secret of [SECRET, TOKEN, SB_KEY, '+996 555 000 111']) {
    assert.ok(!allLogs.includes(secret), `В логе утечка: ${secret}`);
    assert.ok(!res.body.includes(secret), `В ответе утечка: ${secret}`);
  }
  for (const m of sent()) {
    for (const secret of [SECRET, TOKEN, SB_KEY]) assert.ok(!m.text.includes(secret), `В сообщении утечка: ${secret}`);
    assert.ok(tg.visibleLength(m.text) <= 4096, `сообщение длиннее 4096: ${tg.visibleLength(m.text)}`);
  }
  return { status: res.statusCode, json: JSON.parse(res.body) };
}
const post = (text, chatId) => call(makeReq('POST', { body: update(text, chatId) }));

const row = (id, extra = {}) => ({
  id, created_at: '2026-10-13T08:05:00+00:00', customer_name: 'Айбек', phone: '+996 555 000 111',
  product_name: 'Диван «Осло»', quantity: 2, comment: null, status: 'new', ...extra,
});

const results = [];
async function test(name, fn) {
  supabase = sbRows([]); telegram = okTelegram;
  try { await fn(); results.push(`ok   ${name}`); } catch (e) { results.push(`FAIL ${name}: ${e.message}`); }
}

// --- Доступ ---
await test('GET → 405', async () => {
  const r = await call(makeReq('GET')); assert.equal(r.status, 405); assert.equal(calls.length, 0);
});
await test('без секретного заголовка → 401, никаких запросов', async () => {
  const r = await call(makeReq('POST', { body: update('/history'), headers: {} }));
  assert.equal(r.status, 401); assert.equal(calls.length, 0);
});
await test('неверный секрет → 401, никаких запросов', async () => {
  const r = await call(makeReq('POST', { body: update('/history'), headers: { 'x-telegram-bot-api-secret-token': 'wrong' } }));
  assert.equal(r.status, 401); assert.equal(calls.length, 0);
});
await test('секрет с лишним символом → 401', async () => {
  const r = await call(makeReq('POST', { body: update('/start'), headers: { 'x-telegram-bot-api-secret-token': SECRET + 'x' } }));
  assert.equal(r.status, 401); assert.equal(calls.length, 0);
});
await test('чужой chat_id → 200, база не читается, ответа в чат нет', async () => {
  const r = await post('/history', 999);
  assert.equal(r.status, 200); assert.equal(calls.length, 0);
  assert.ok(logs.some((l) => l.includes('постороннего чата')));
});
await test('chat_id сравнивается как строка: группа с отрицательным id → игнор', async () => {
  const r = await post('/history', -1586); assert.equal(r.status, 200); assert.equal(calls.length, 0);
});
await test('TELEGRAM_CHAT_ID с пробелами вокруг → свой чат принят', async () => {
  process.env.TELEGRAM_CHAT_ID = ' 1586 ';
  try { const r = await post('/start'); assert.equal(r.status, 200); assert.equal(sent().length, 1); }
  finally { process.env.TELEGRAM_CHAT_ID = '1586'; }
});
await test('нет TELEGRAM_WEBHOOK_SECRET → 500, никаких запросов', async () => {
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
  try {
    const r = await call(makeReq('POST', { body: update('/start'), headers: { 'x-telegram-bot-api-secret-token': '' } }));
    assert.equal(r.status, 500); assert.equal(calls.length, 0);
  } finally { process.env.TELEGRAM_WEBHOOK_SECRET = SECRET; }
});

// --- Разбор обновления ---
await test('битый JSON при верном секрете → 200 (чтобы Telegram не повторял), ничего не отправлено', async () => {
  const r = await call(makeReq('POST', { body: '{oops' })); assert.equal(r.status, 200); assert.equal(calls.length, 0);
});
await test('обновление без message (edited_message) → 200, игнор', async () => {
  const r = await call(makeReq('POST', { body: { update_id: 1, edited_message: update('/start').message } }));
  assert.equal(r.status, 200); assert.equal(calls.length, 0);
});
await test('сообщение без текста (фото) → 200, игнор', async () => {
  const r = await call(makeReq('POST', { body: { update_id: 1, message: { chat: { id: 1586 }, photo: [] } } }));
  assert.equal(r.status, 200); assert.equal(calls.length, 0);
});
await test('обновление 50 КБ (длинное сообщение) принимается', async () => {
  const r = await post('/start ' + 'ж'.repeat(25000)); assert.equal(r.status, 200); assert.equal(sent().length, 1);
});

// --- /start ---
await test('/start → одна справка со списком команд', async () => {
  const r = await post('/start');
  assert.equal(r.status, 200); assert.equal(sbCalls().length, 0);
  const msgs = sent(); assert.equal(msgs.length, 1);
  assert.equal(msgs[0].chat_id, 1586); assert.equal(msgs[0].parse_mode, 'HTML');
  assert.ok(msgs[0].text.includes('/start') && msgs[0].text.includes('/history'));
});
await test('/start@Woodora_new_bot тоже распознаётся', async () => {
  await post('/start@Woodora_new_bot'); assert.equal(sent()[0].text, tg.HELP_TEXT);
});
await test('неизвестная команда → «Неизвестная команда» + справка', async () => {
  await post('/foo'); assert.ok(sent()[0].text.startsWith('Неизвестная команда.'));
});
await test('/historyX не считается /history', async () => {
  await post('/historyX'); assert.equal(sbCalls().length, 0); assert.ok(sent()[0].text.startsWith('Неизвестная'));
});
await test('ошибка Telegram при ответе → всё равно 200, в лог без токена', async () => {
  telegram = () => { throw new TypeError(`connect failed https://api.telegram.org/bot${TOKEN}/sendMessage`); };
  const r = await post('/start'); assert.equal(r.status, 200); assert.ok(logs.length > 0);
});

// --- /history: запрос к базе ---
await test('/history: один GET с нужными колонками, фильтром 7 суток и сортировкой', async () => {
  const before = Date.now();
  await post('/history');
  const after = Date.now();
  assert.equal(sbCalls().length, 1);
  const { url, init } = sbCalls()[0];
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://test.supabase.co/rest/v1/applications');
  assert.equal(u.searchParams.get('select'), 'id,created_at,customer_name,phone,product_name,quantity,comment,status');
  assert.equal(u.searchParams.get('order'), 'created_at.desc,id.desc');
  const since = Date.parse(u.searchParams.get('created_at').replace(/^gte\./, ''));
  const week = 7 * 24 * 3600 * 1000;
  assert.ok(since >= before - week && since <= after - week, 'граница не равна «сейчас минус 7 суток»');
  assert.equal(init.headers.apikey, SB_KEY);
  assert.equal(init.headers.Authorization, `Bearer ${SB_KEY}`);
  assert.ok(init.signal instanceof AbortSignal, 'нет тайм-аута');
});
await test('/history: пустая история → одно сообщение «заявок нет»', async () => {
  supabase = sbRows([]);
  const r = await post('/history');
  assert.equal(r.status, 200); assert.equal(sent().length, 1);
  assert.equal(sent()[0].text, 'За последние 7 дней заявок нет.');
});

// --- /history: ошибки Supabase ---
const sbFailures = {
  'HTTP 401': () => new Response('{"message":"Invalid API key"}', { status: 401 }),
  'HTTP 500 с данными в details': () => new Response(JSON.stringify({ code: 'XX000', message: 'boom', details: '+996 555 000 111' }), { status: 500 }),
  'ответ не JSON': () => new Response('<html>', { status: 200 }),
  'ответ не массив': () => new Response('{"a":1}', { status: 200 }),
  'сеть недоступна': () => { throw new TypeError('fetch failed'); },
  'тайм-аут': () => { throw new DOMException('aborted', 'TimeoutError'); },
};
for (const [label, impl] of Object.entries(sbFailures)) {
  await test(`/history: Supabase ${label} → 200, сообщение об ошибке, в лог`, async () => {
    supabase = impl;
    const r = await post('/history');
    assert.equal(r.status, 200); assert.equal(sent().length, 1);
    assert.equal(sent()[0].text, 'Не удалось получить историю заявок. Попробуйте позже.');
    assert.ok(logs.some((l) => l.includes('/history')));
  });
}

// --- /history: формат ---
await test('/history: поля, дата по Бишкеку (UTC+6), экранирование HTML и кириллица', async () => {
  supabase = sbRows([row(12, {
    customer_name: 'Айгүл <script>alert(1)</script>',
    product_name: 'Стол & стулья "Дуб"',
    comment: 'Ёлка <b>жирно</b> & ещё',
    created_at: '2026-10-13T20:30:00Z', // в Бишкеке уже 14.10, 02:30
  })]);
  await post('/history');
  const text = sent()[0].text;
  assert.ok(text.includes('<b>Заявки за последние 7 дней: 1</b>'), text);
  assert.ok(text.includes('<b>№12</b> · 14.10.2026, 02:30'), text);
  assert.ok(text.includes('<b>Имя:</b> Айгүл &lt;script&gt;alert(1)&lt;/script&gt;'), text);
  assert.ok(text.includes('<b>Телефон:</b> +996 555 000 111'));
  assert.ok(text.includes('<b>Товар:</b> Стол &amp; стулья "Дуб"'), text);
  assert.ok(text.includes('<b>Количество:</b> 2'));
  assert.ok(text.includes('<b>Комментарий:</b> Ёлка &lt;b&gt;жирно&lt;/b&gt; &amp; ещё'), text);
  assert.ok(text.includes('<b>Статус:</b> new'));
  assert.ok(!text.includes('<script>') && !text.includes('<b>жирно'), 'неэкранированный HTML');
  // Все теги в сообщении — только наши
  assert.deepEqual([...new Set(text.match(/<\/?[a-z]+>/g))].sort(), ['</b>', '<b>']);
});
await test('/history: пустые поля не выводятся', async () => {
  supabase = sbRows([row(5, { product_name: null, comment: '  ', status: null, quantity: null })]);
  await post('/history');
  const text = sent()[0].text;
  assert.ok(!/Товар|Комментарий|Статус|Количество/.test(text), text);
  assert.ok(text.includes('Айбек'));
});
await test('/history: сверхдлинный комментарий из базы обрезается с «…»', async () => {
  supabase = sbRows([row(1, { comment: 'к'.repeat(10000) })]);
  await post('/history');
  assert.equal(sent().length, 1); assert.ok(sent()[0].text.includes('к…'));
});

// --- /history: несколько сообщений ---
await test('/history: 120 заявок → несколько сообщений, все записи по одному разу, по порядку', async () => {
  const rows = Array.from({ length: 120 }, (_, i) => row(500 - i, { comment: `Комментарий & <тег> ${'я'.repeat(150)}` }));
  supabase = sbRows(rows);
  const r = await post('/history');
  assert.equal(r.status, 200);
  const msgs = sent();
  assert.ok(msgs.length > 1, `сообщений: ${msgs.length}`);
  const ids = msgs.flatMap((m) => [...m.text.matchAll(/<b>№(\d+)<\/b>/g)].map((x) => Number(x[1])));
  assert.deepEqual(ids, rows.map((x) => x.id), 'записи потеряны, продублированы или перепутаны');
  msgs.forEach((m, i) => {
    assert.ok(m.text.startsWith(`<i>Часть ${i + 1}/${msgs.length}</i>\n`), m.text.slice(0, 40));
    // теги парные: каждая запись целиком в одном сообщении
    assert.equal((m.text.match(/<b>/g) || []).length, (m.text.match(/<\/b>/g) || []).length);
  });
  assert.ok(msgs[0].text.includes('Заявки за последние 7 дней: 120'));
});
await test('/history: экранирование не «раздувает» лимит — &amp; считается как 1 символ', async () => {
  // 25 записей по ~1500 символов «&»: в HTML это в 5 раз длиннее, но Telegram считает после разбора
  const rows = Array.from({ length: 25 }, (_, i) => row(i + 1, { comment: '&'.repeat(1500) }));
  supabase = sbRows(rows);
  await post('/history');
  const msgs = sent();
  for (const m of msgs) assert.ok(tg.visibleLength(m.text) <= 4096);
  const ids = msgs.flatMap((m) => [...m.text.matchAll(/<b>№(\d+)<\/b>/g)].map((x) => Number(x[1])));
  assert.equal(ids.length, 25);
});
await test('/history: больше лимита выборки → «показаны последние N»', async () => {
  supabase = sbRows([row(1), row(2)], 350);
  await post('/history');
  assert.ok(sent()[0].text.includes('Заявки за последние 7 дней: 350'));
  assert.ok(sent()[0].text.includes('Показаны последние 2'));
});
await test('/history: одна часть не отправилась → остальные отправлены, в лог', async () => {
  const rows = Array.from({ length: 60 }, (_, i) => row(i + 1, { comment: 'я'.repeat(300) }));
  supabase = sbRows(rows);
  let n = 0;
  telegram = () => (++n === 2 ? new Response('{"ok":false,"description":"Bad Request"}', { status: 400 }) : okTelegram());
  const r = await post('/history');
  assert.equal(r.status, 200);
  assert.ok(sent().length >= 3, `попыток: ${sent().length}`);
  assert.ok(logs.some((l) => l.includes('не отправлено 1 из')), logs.join('\n'));
});
await test('/history: 429 от Telegram → одна повторная попытка после паузы', async () => {
  supabase = sbRows([row(1)]);
  let n = 0;
  telegram = () => (++n === 1
    ? new Response('{"ok":false,"parameters":{"retry_after":1}}', { status: 429 })
    : okTelegram());
  const started = Date.now();
  const r = await post('/history');
  assert.equal(r.status, 200); assert.equal(sent().length, 2); assert.ok(Date.now() - started >= 900);
  assert.equal(logs.length, 0);
});

// --- Вспомогательные функции ---
await test('splitMessages: одно сообщение без подписи «Часть»', async () => {
  assert.deepEqual(tg.splitMessages('H', ['a', 'b']), ['H\n\na\n\nb']);
});
await test('visibleLength: теги не считаются, сущности как 1 символ', async () => {
  assert.equal(tg.visibleLength('<b>Ёж</b> &amp; &lt;'), 6);
});
await test('formatDate: Asia/Bishkek', async () => {
  assert.equal(tg.formatDate('2026-01-01T00:00:00Z'), '01.01.2026, 06:00');
});

process.stdout.write(results.join('\n') + `\n\nВсего: ${results.length}, провалено: ${results.filter((r) => r.startsWith('FAIL')).length}\n`);
process.exitCode = results.some((r) => r.startsWith('FAIL')) ? 1 : 0;
