// Тесты api/lead.js с подменённым fetch: реальные Supabase и Telegram не вызываются.
// Запуск: npm test
import { Readable } from 'node:stream';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://test.supabase.co/';
process.env.SUPABASE_SECRET_KEY = 'sb_secret_TESTKEY';
process.env.TELEGRAM_BOT_TOKEN = '123456:FAKE-token_x';
process.env.TELEGRAM_CHAT_ID = '42';

const { default: handler } = await import('../api/lead.js');

const okSupabase = () => new Response('7', { status: 200 });
const okTelegram = () => new Response('{"ok":true}', { status: 200 });
let supabase, telegram, calls;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  calls.push({ url: u, init });
  if (u.startsWith('https://test.supabase.co/')) return supabase(init);
  if (u.startsWith('https://api.telegram.org/')) return telegram(init);
  throw new Error('Неожиданный адрес: ' + u); // защита от реальных запросов
};
const sbCalls = () => calls.filter((c) => c.url.includes('supabase.co'));
const tgCalls = () => calls.filter((c) => c.url.includes('telegram.org'));

const logs = [];
console.error = (...a) => logs.push(a.map(String).join(' '));

// Имитация запроса: поток из кусков, при необходимости — заранее разобранный req.body (как на Vercel)
function makeReq(method, { chunks = [], headers = {}, body } = {}) {
  const req = Readable.from(chunks.map((c) => (typeof c === 'string' ? Buffer.from(c) : c)));
  req.method = method;
  req.headers = headers;
  if (body !== undefined) {
    let touched = false;
    Object.defineProperty(req, 'body', { get() { touched = true; return body; } });
    req.bodyTouched = () => touched;
  }
  return req;
}

async function call(req) {
  const res = {
    headers: {}, statusCode: 0, body: '',
    setHeader(k, v) { this.headers[k] = v; },
    endCalls: 0,
    end(b) { this.endCalls++; this.body = b; },
  };
  calls = []; logs.length = 0;
  await handler(req, res);
  // Общие инварианты для всех тестов
  assert.equal(res.endCalls, 1, `res.end() вызван ${res.endCalls} раз`);
  assert.ok(sbCalls().length <= 1, 'Supabase вызван больше одного раза');
  assert.ok(tgCalls().length <= 1, 'Telegram вызван больше одного раза');
  if (tgCalls().length) {
    assert.ok(calls.indexOf(sbCalls()[0]) < calls.indexOf(tgCalls()[0]), 'Telegram вызван раньше Supabase');
  }
  const allLogs = logs.join('\n');
  for (const secret of ['sb_secret_TESTKEY', 'FAKE-token_x', '700 123 456', '700123456']) {
    assert.ok(!allLogs.includes(secret), `В логе утечка: ${secret}`);
  }
  return { status: res.statusCode, json: JSON.parse(res.body), res };
}
const post = (data) => call(makeReq('POST', { chunks: [JSON.stringify(data)] }));

const good = { name: 'Айбек', phone: '+996 700 123 456', product: 'Диван <b>', comment: 'a & b', quantity: '3' };
const results = [];
async function test(name, fn) {
  supabase = okSupabase; telegram = okTelegram;
  try { await fn(); results.push(`ok   ${name}`); }
  catch (e) { results.push(`FAIL ${name}: ${e.message}`); }
}

// --- Метод и тело запроса ---
await test('GET → 405 с Allow: POST', async () => {
  const r = await call(makeReq('GET'));
  assert.equal(r.status, 405); assert.equal(r.res.headers.Allow, 'POST'); assert.equal(calls.length, 0);
});
await test('битый JSON → 400', async () => {
  const r = await call(makeReq('POST', { chunks: ['{oops'] })); assert.equal(r.status, 400); assert.equal(calls.length, 0);
});
await test('пустое тело → 400 (нет имени)', async () => {
  const r = await call(makeReq('POST')); assert.equal(r.status, 400); assert.equal(calls.length, 0);
});
await test('массив вместо объекта → 400', async () => {
  const r = await post([1]); assert.equal(r.status, 400); assert.equal(calls.length, 0);
});
await test('поток больше 16 КБ → 413', async () => {
  const r = await call(makeReq('POST', { chunks: ['x'.repeat(10000), 'x'.repeat(10000)] }));
  assert.equal(r.status, 413); assert.equal(calls.length, 0);
});
await test('лимит считается в байтах: 9000 «ж» (18 КБ) → 413', async () => {
  const r = await call(makeReq('POST', { chunks: [JSON.stringify({ ...good, comment: 'ж'.repeat(9000) })] }));
  assert.equal(r.status, 413);
});
await test('Content-Length > 16 КБ → 413, req.body не читается', async () => {
  const req = makeReq('POST', { headers: { 'content-length': '5000000' }, body: { ...good } });
  const r = await call(req);
  assert.equal(r.status, 413); assert.equal(req.bodyTouched(), false); assert.equal(calls.length, 0);
});
await test('кириллица, разрезанная между кусками потока, не портится', async () => {
  const buf = Buffer.from(JSON.stringify(good));
  const cut = buf.indexOf(Buffer.from('Айбек')) + 1; // посередине буквы «А»
  const r = await call(makeReq('POST', { chunks: [buf.subarray(0, cut), buf.subarray(cut)] }));
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(sbCalls()[0].init.body).p_name, 'Айбек');
});
await test('Vercel: req.body уже объект → поток не читается', async () => {
  const r = await call(makeReq('POST', { body: { ...good } })); assert.equal(r.status, 200);
});
await test('Vercel: req.body строка JSON', async () => {
  const r = await call(makeReq('POST', { body: JSON.stringify(good) })); assert.equal(r.status, 200);
});
await test('Vercel: req.body Buffer', async () => {
  const r = await call(makeReq('POST', { body: Buffer.from(JSON.stringify(good)) }));
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(sbCalls()[0].init.body).p_name, 'Айбек');
});
await test('Vercel: req.body бросает (битый JSON) → 400', async () => {
  const req = makeReq('POST');
  Object.defineProperty(req, 'body', { get() { throw new Error('Invalid JSON'); } });
  const r = await call(req); assert.equal(r.status, 400); assert.equal(calls.length, 0);
});

// --- Точный учёт байтов ---
// JSON заданного размера в байтах: комментарий из «ж» (2 байта) + добивка ASCII
function jsonOfBytes(total) {
  const base = { ...good, comment: '' };
  const empty = Buffer.byteLength(JSON.stringify(base));
  const free = total - empty;
  const comment = 'ж'.repeat(Math.floor(free / 2)) + 'x'.repeat(free % 2);
  const text = JSON.stringify({ ...base, comment });
  assert.equal(Buffer.byteLength(text), total);
  return text;
}
// Режем строку на куски по символам (не по байтам), чтобы получить строковые chunks
const splitChars = (text, n) => Array.from({ length: Math.ceil(text.length / n) }, (_, i) => text.slice(i * n, (i + 1) * n));
function rawReq(chunks) {
  const req = Readable.from(chunks, { objectMode: true }); // chunks как есть: строки или Buffer
  req.method = 'POST'; req.headers = {};
  return req;
}
await test('поток строк-кусков ровно 16384 байт → принят, кириллица цела', async () => {
  const text = jsonOfBytes(16384);
  const r = await call(rawReq(splitChars(text, 777)));
  assert.equal(r.status, 200);
  const row = JSON.parse(sbCalls()[0].init.body);
  assert.equal(row.p_name, 'Айбек'); assert.match(row.p_comment, /^ж+x?$/);
});
await test('поток строк-кусков 16385 байт → 413 (байты не считаются дважды и не теряются)', async () => {
  const r = await call(rawReq(splitChars(jsonOfBytes(16385), 777))); assert.equal(r.status, 413);
});
await test('поток Buffer-кусков по 1 байту ровно 16384 → принят', async () => {
  const buf = Buffer.from(jsonOfBytes(16384));
  const r = await call(rawReq([...buf].map((b) => Buffer.from([b]))));
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(sbCalls()[0].init.body).p_name, 'Айбек');
});
await test('Vercel: req.body строка 16385 байт → 413', async () => {
  const r = await call(makeReq('POST', { body: jsonOfBytes(16385) })); assert.equal(r.status, 413);
});
await test('Vercel: req.body Buffer 16385 байт → 413', async () => {
  const r = await call(makeReq('POST', { body: Buffer.from(jsonOfBytes(16385)) })); assert.equal(r.status, 413);
});
await test('Vercel: req.body объект > 16 КБ без Content-Length (chunked) → 413', async () => {
  const r = await call(makeReq('POST', { body: JSON.parse(jsonOfBytes(20000)) })); assert.equal(r.status, 413);
});
await test('Vercel: req.body строка ровно 16384 байт → принята', async () => {
  const r = await call(makeReq('POST', { body: jsonOfBytes(16384) })); assert.equal(r.status, 200);
});

// --- Валидация ---
await test('honeypot → 200 без записи и без Telegram', async () => {
  const r = await post({ ...good, website: 'spam' }); assert.equal(r.status, 200); assert.equal(calls.length, 0);
});
await test('короткое имя → 400', async () => {
  const r = await post({ ...good, name: ' A ' }); assert.equal(r.status, 400); assert.equal(calls.length, 0);
});
await test('плохой телефон → 400', async () => {
  const r = await post({ ...good, phone: '12-34' }); assert.equal(r.status, 400); assert.equal(calls.length, 0);
});
for (const q of ['0', '100', '2.5', 'abc', -1, '1e1', true, ' 5x']) {
  await test(`quantity=${JSON.stringify(q)} → 400`, async () => {
    const r = await post({ ...good, quantity: q }); assert.equal(r.status, 400); assert.equal(calls.length, 0);
  });
}
for (const q of [1, '1', 99, ' 42 ']) {
  await test(`quantity=${JSON.stringify(q)} → принято`, async () => {
    const r = await post({ ...good, quantity: q }); assert.equal(r.status, 200);
    assert.equal(JSON.parse(sbCalls()[0].init.body).p_quantity, Number(String(q).trim()));
  });
}
await test('слишком длинные поля обрезаются', async () => {
  const r = await post({ ...good, name: 'я'.repeat(200), comment: 'к'.repeat(1500) });
  assert.equal(r.status, 200);
  const row = JSON.parse(sbCalls()[0].init.body);
  assert.equal(row.p_name.length, 80); assert.equal(row.p_comment.length, 1000);
});

// --- Успешный путь ---
await test('успех: одна запись, затем ровно одно сообщение Telegram', async () => {
  const r = await post(good);
  assert.equal(r.status, 200); assert.deepEqual(r.json, { ok: true });
  assert.equal(sbCalls().length, 1); assert.equal(tgCalls().length, 1);
  const sb = sbCalls()[0];
  assert.equal(sb.url, 'https://test.supabase.co/rest/v1/rpc/create_application');
  assert.equal(sb.init.method, 'POST');
  assert.equal(sb.init.headers.apikey, 'sb_secret_TESTKEY');
  assert.equal(sb.init.headers.Authorization, 'Bearer sb_secret_TESTKEY');
  assert.ok(sb.init.signal instanceof AbortSignal, 'у запроса к Supabase нет тайм-аута');
  assert.deepEqual(JSON.parse(sb.init.body), {
    p_name: 'Айбек', p_phone: '+996 700 123 456', p_source: 'site', p_product_id: null, p_product_name: 'Диван <b>',
    p_quantity: 3, p_comment: 'a & b', p_chat_session_id: null,
  });
  const tg = tgCalls()[0];
  assert.equal(tg.url, 'https://api.telegram.org/bot123456:FAKE-token_x/sendMessage');
  assert.ok(tg.init.signal instanceof AbortSignal, 'у запроса к Telegram нет тайм-аута');
  const msg = JSON.parse(tg.init.body);
  assert.equal(msg.chat_id, '42'); assert.equal(msg.parse_mode, 'HTML');
  assert.equal(msg.text, [
    '<b>Новая заявка с сайта WOODORA</b> (№7)', '',
    '<b>Имя:</b> Айбек', '<b>Телефон:</b> +996 700 123 456',
    '<b>Товар:</b> Диван &lt;b&gt;', '<b>Количество:</b> 3', '<b>Комментарий:</b> a &amp; b',
  ].join('\n'));
});
await test('старая форма без quantity/product/comment → quantity 1, null', async () => {
  const r = await post({ name: 'Айбек', phone: '0700123456' });
  assert.equal(r.status, 200);
  const row = JSON.parse(sbCalls()[0].init.body);
  assert.equal(row.p_quantity, 1); assert.equal(row.p_product_name, null); assert.equal(row.p_comment, null);
  assert.ok(!JSON.parse(tgCalls()[0].init.body).text.includes('Товар'));
});

await test('ответ не отправляется, пока вставка в Supabase не завершена', async () => {
  let release;
  supabase = () => new Promise((resolve) => { release = () => resolve(okSupabase()); });
  const res = {
    headers: {}, statusCode: 0, body: '', endCalls: 0,
    setHeader(k, v) { this.headers[k] = v; },
    end(b) { this.endCalls++; this.body = b; },
  };
  calls = [];
  const done = handler(makeReq('POST', { chunks: [JSON.stringify(good)] }), res);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(sbCalls().length, 1, 'вставка не началась');
  assert.equal(res.endCalls, 0, 'ответ отправлен до завершения вставки');
  assert.equal(tgCalls().length, 0, 'Telegram вызван до завершения вставки');
  release();
  await done;
  assert.equal(res.endCalls, 1); assert.equal(res.statusCode, 200); assert.equal(tgCalls().length, 1);
});

// --- Ошибки Supabase: клиент получает ошибку, Telegram не вызывается ---
const sbFailures = {
  'HTTP 400 с данными клиента в details и message': () => new Response(JSON.stringify({
    code: '23514', message: 'invalid value "+996 700 123 456"', details: 'Failing row contains (Айбек, +996 700 123 456)',
  }), { status: 400 }),
  'HTTP 401 (неверный ключ)': () => new Response('{"message":"Invalid API key"}', { status: 401 }),
  'HTTP 500, тело не JSON': () => new Response('<html>oops</html>', { status: 500 }),
  '200, но в ответе не число': () => new Response('null', { status: 200 }),
  '201, но тело не JSON': () => new Response('not json', { status: 201 }),
  'сеть недоступна': () => { throw new TypeError('fetch failed'); },
  'тайм-аут': () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); },
};
for (const [label, impl] of Object.entries(sbFailures)) {
  await test(`Supabase: ${label} → 502, Telegram не вызван`, async () => {
    supabase = impl;
    const r = await post(good);
    assert.equal(r.status, 502); assert.equal(r.json.ok, false);
    assert.equal(sbCalls().length, 1); assert.equal(tgCalls().length, 0);
    assert.ok(logs.some((l) => l.includes('НЕ сохранена')), 'нет записи в логе');
  });
}
await test('Supabase тайм-аут пишется в лог как timeout', async () => {
  supabase = sbFailures['тайм-аут'];
  await post(good); assert.ok(logs.join().includes('timeout'));
});
await test('нет переменных Supabase → 500, никаких запросов', async () => {
  delete process.env.SUPABASE_SECRET_KEY;
  try {
    const r = await post(good); assert.equal(r.status, 500); assert.equal(calls.length, 0);
  } finally { process.env.SUPABASE_SECRET_KEY = 'sb_secret_TESTKEY'; }
});

// --- Ошибки Telegram после сохранения: клиент получает успех ---
const tgFailures = {
  'HTTP 400': () => new Response('{"ok":false,"description":"Bad Request: chat not found"}', { status: 400 }),
  'HTTP 500': () => new Response('bad', { status: 500 }),
  'сеть недоступна (в сообщении URL с токеном)': () => {
    throw new TypeError('connect failed https://api.telegram.org/bot123456:FAKE-token_x/sendMessage');
  },
  'тайм-аут': () => { throw new DOMException('aborted', 'TimeoutError'); },
};
for (const [label, impl] of Object.entries(tgFailures)) {
  await test(`Telegram: ${label} после сохранения → 200, одна попытка, лог без секретов`, async () => {
    telegram = impl;
    const r = await post(good);
    assert.equal(r.status, 200); assert.deepEqual(r.json, { ok: true });
    assert.equal(sbCalls().length, 1); assert.equal(tgCalls().length, 1);
    assert.ok(logs.some((l) => l.includes('№7') && l.includes('не отправлено')), logs.join());
  });
}
await test('нет переменных Telegram → заявка сохранена, 200, в лог', async () => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  try {
    const r = await post(good);
    assert.equal(r.status, 200); assert.equal(sbCalls().length, 1); assert.equal(tgCalls().length, 0);
    assert.ok(logs.some((l) => l.includes('не отправлено')));
  } finally { process.env.TELEGRAM_BOT_TOKEN = '123456:FAKE-token_x'; }
});

// --- Реальный тайм-аут (AbortSignal срабатывает на «зависшем» сервере) ---
await test('зависший Supabase прерывается тайм-аутом (≈8 с) → 502', async () => {
  supabase = (init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  });
  // Таймер AbortSignal.timeout не держит процесс Node; на сервере процесс живёт сам
  const keepAlive = setInterval(() => {}, 1000);
  const started = Date.now();
  const r = await post(good).finally(() => clearInterval(keepAlive));
  const ms = Date.now() - started;
  assert.equal(r.status, 502); assert.equal(tgCalls().length, 0);
  assert.ok(ms >= 7500 && ms < 12000, `тайм-аут сработал за ${ms} мс`);
});

globalThis.fetch = realFetch;
process.stdout.write(results.join('\n') + `\n\nВсего: ${results.length}, провалено: ${results.filter((r) => r.startsWith('FAIL')).length}\n`);
process.exitCode = results.some((r) => r.startsWith('FAIL')) ? 1 : 0;
