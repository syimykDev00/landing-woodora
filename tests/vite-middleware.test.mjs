// Тест middleware из vite.config.js: каждый обработчик вызывается один раз,
// ошибка уходит в next ровно один раз и не вызывает обработчик повторно.
// fetch подменён: реальные запросы невозможны. Конфиг запускается из пустой временной
// папки с поддельным .env, поэтому настоящие секреты проекта не читаются.
// Запуск: npm test
import { Readable } from 'node:stream';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('реальные запросы запрещены'); };

const { default: configFn } = await import('../vite.config.js');

// Собирает маршруты, которые плагин регистрирует в dev-сервере
function mountRoutes(envFile) {
  const dir = mkdtempSync(join(tmpdir(), 'woodora-vite-'));
  writeFileSync(join(dir, '.env'), envFile);
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const config = configFn({ mode: 'test', command: 'serve' });
    const routes = {};
    config.plugins[0].configureServer({ middlewares: { use(path, fn) { routes[path] = fn; } } });
    return routes;
  } finally {
    process.chdir(cwd);
  }
}

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(`ok   ${name}`); } catch (e) { results.push(`FAIL ${name}: ${e.message}`); }
}

// res, который считает вызовы. Каждый обработчик начинается с проверки метода
// и вызывает res.setHeader/res.end — по ним и считаем число вызовов обработчика.
function makeRes({ throwOnSetHeader = false, throwOnEnd = false } = {}) {
  return {
    headersSent: false, writableEnded: false, statusCode: 0, setHeaderCalls: 0, endCalls: 0, body: '',
    setHeader() { this.setHeaderCalls++; if (throwOnSetHeader) throw new Error('setHeader сломан'); },
    end(b) {
      this.endCalls++;
      if (throwOnEnd) { this.headersSent = true; throw new Error('end сломан'); }
      this.headersSent = true; this.writableEnded = true; this.body = b;
    },
  };
}
function makeReq(method, { headers = {}, body } = {}) {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  req.method = method; req.headers = headers;
  return req;
}
async function run(middleware, req, res) {
  const nextCalls = [];
  middleware(req, res, (err) => nextCalls.push(err));
  await new Promise((r) => setTimeout(r, 50)); // дать промису обработчика завершиться
  return nextCalls;
}
const origError = console.error; const origLog = console.log;
const logs = []; const out = [];
console.error = (...a) => logs.push(a.join(' '));

const routes = mountRoutes('TELEGRAM_CHAT_ID=42\n');

await test('зарегистрированы ровно /api/lead и /api/telegram', async () => {
  assert.deepEqual(Object.keys(routes).sort(), ['/api/lead', '/api/telegram']);
});
for (const path of ['/api/lead', '/api/telegram']) {
  await test(`${path}: обычный запрос — обработчик один раз, next не вызван`, async () => {
    const res = makeRes();
    const next = await run(routes[path], makeReq('GET'), res);
    assert.equal(res.statusCode, 405); assert.equal(res.endCalls, 1); assert.equal(next.length, 0);
  });
  await test(`${path}: ошибка до ответа — next(err) ровно один раз, повторного вызова нет`, async () => {
    const res = makeRes({ throwOnSetHeader: true });
    const next = await run(routes[path], makeReq('GET'), res);
    assert.equal(next.length, 1); assert.ok(next[0] instanceof Error);
    assert.equal(res.setHeaderCalls, 1, `setHeader вызван ${res.setHeaderCalls} раз — обработчик запускался повторно`);
    assert.equal(res.endCalls, 0);
  });
  await test(`${path}: ошибка после отправки заголовков — next не вызван, обработчик не повторён`, async () => {
    logs.length = 0;
    const res = makeRes({ throwOnEnd: true });
    const next = await run(routes[path], makeReq('GET'), res);
    assert.equal(next.length, 0); assert.equal(res.setHeaderCalls, 2);
    assert.ok(logs.some((l) => l.includes('после отправки ответа')));
  });
}

await test('TELEGRAM_DRY_RUN=1: /start печатается в терминал, в Telegram ничего не уходит', async () => {
  const saved = { ...process.env };
  Object.assign(process.env, {
    TELEGRAM_WEBHOOK_SECRET: 'local-secret', TELEGRAM_CHAT_ID: '42',
    SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_TESTKEY',
  });
  delete process.env.TELEGRAM_BOT_TOKEN; // в dry-run токен не нужен
  console.log = (...a) => out.push(a.join(' '));
  try {
    const dry = mountRoutes('TELEGRAM_DRY_RUN=1\n');
    const before = fetchCalls;
    const res = makeRes();
    await run(dry['/api/telegram'], makeReq('POST', {
      headers: { 'x-telegram-bot-api-secret-token': 'local-secret' },
      body: { update_id: 1, message: { chat: { id: 42, type: 'private' }, text: '/start' } },
    }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(fetchCalls, before, 'был сетевой запрос');
    assert.ok(out.some((l) => l.includes('[telegram dry-run]') && l.includes('/history')), out.join('\n'));
  } finally {
    console.log = origLog;
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
await test('без TELEGRAM_DRY_RUN подключается обычный обработчик', async () => {
  const { default: telegramHandler } = await import('../api/telegram.js');
  // обычный обработчик без токена бота отвечает 500 «не настроен», dry-run ответил бы 401/200
  const saved = { ...process.env };
  Object.assign(process.env, { TELEGRAM_WEBHOOK_SECRET: 's', TELEGRAM_CHAT_ID: '42', SUPABASE_URL: 'u', SUPABASE_SECRET_KEY: 'k' });
  delete process.env.TELEGRAM_BOT_TOKEN;
  try {
    const res = makeRes();
    await run(routes['/api/telegram'], makeReq('POST', { headers: {} }), res);
    assert.equal(res.statusCode, 500);
    const res2 = makeRes();
    await telegramHandler(makeReq('POST', { headers: {} }), res2);
    assert.equal(res2.statusCode, 500);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
await test('ни одного сетевого запроса', async () => { assert.equal(fetchCalls, 0); });

console.error = origError;
process.stdout.write(results.join('\n') + `\n\nВсего: ${results.length}, провалено: ${results.filter((r) => r.startsWith('FAIL')).length}\n`);
process.exitCode = results.some((r) => r.startsWith('FAIL')) ? 1 : 0;
