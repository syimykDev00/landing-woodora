// Тест загрузки серверных переменных в vite.config.js: при повторной загрузке конфига
// (так Vite реагирует на изменение .env) применяются новые значения из файлов,
// а переменные, заданные в терминале, остаются главнее.
// Только фиктивные значения во временной папке; папка удаляется, process.env восстанавливается.
// fetch подменён: реальные запросы невозможны.
// Запуск: npm test
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('реальные запросы запрещены'); };

const SERVER_ENV = [
  'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_WEBHOOK_SECRET', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY',
  'AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN', 'AI_MODEL', 'AI_EMBEDDING_MODEL',
];
const INJECTED_KEY = Symbol.for('woodora.vite.injectedEnv');
const savedEnv = { ...process.env };
const savedCwd = process.cwd();

const { default: configFn } = await import('../vite.config.js');

// Каждый тест — с чистого листа: без серверных переменных и без реестра от прошлых загрузок
function resetEnv() {
  for (const name of SERVER_ENV) delete process.env[name];
  delete globalThis[INJECTED_KEY];
}

// Загрузка конфига из папки dir — как при старте или перезапуске dev-сервера
function loadConfig(dir) {
  process.chdir(dir);
  try {
    return configFn({ mode: 'test', command: 'serve' });
  } finally {
    process.chdir(savedCwd);
  }
}

const results = [];
async function test(name, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'woodora-vite-env-'));
  resetEnv();
  try { await fn(dir); results.push(`ok   ${name}`); } catch (e) { results.push(`FAIL ${name}: ${e.message}`); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
const writeEnv = (dir, text, file = '.env') => writeFileSync(join(dir, file), text);

try {
  await test('изменили .env → после повторной загрузки конфига действует новое значение', async (dir) => {
    writeEnv(dir, 'TELEGRAM_BOT_TOKEN=fake-old-token\n');
    loadConfig(dir);
    assert.equal(process.env.TELEGRAM_BOT_TOKEN, 'fake-old-token');
    writeEnv(dir, 'TELEGRAM_BOT_TOKEN=fake-new-token\n');
    loadConfig(dir);
    assert.equal(process.env.TELEGRAM_BOT_TOKEN, 'fake-new-token');
  });

  await test('переменная из терминала главнее .env и не меняется при перезагрузке', async (dir) => {
    process.env.TELEGRAM_CHAT_ID = 'fake-from-shell';
    writeEnv(dir, 'TELEGRAM_CHAT_ID=fake-file-1\nSUPABASE_URL=https://fake-1.test\n');
    loadConfig(dir);
    assert.equal(process.env.TELEGRAM_CHAT_ID, 'fake-from-shell');
    writeEnv(dir, 'TELEGRAM_CHAT_ID=fake-file-2\nSUPABASE_URL=https://fake-2.test\n');
    loadConfig(dir);
    assert.equal(process.env.TELEGRAM_CHAT_ID, 'fake-from-shell');
    assert.equal(process.env.SUPABASE_URL, 'https://fake-2.test', 'остальные переменные обновляются');
  });

  await test('переменную удалили из .env → после перезагрузки старого значения нет', async (dir) => {
    writeEnv(dir, 'TELEGRAM_WEBHOOK_SECRET=fake-secret\n');
    loadConfig(dir);
    assert.equal(process.env.TELEGRAM_WEBHOOK_SECRET, 'fake-secret');
    writeEnv(dir, '');
    loadConfig(dir);
    assert.equal(process.env.TELEGRAM_WEBHOOK_SECRET, undefined);
  });

  await test('.env.local по-прежнему главнее .env, его изменение тоже применяется', async (dir) => {
    writeEnv(dir, 'SUPABASE_SECRET_KEY=fake-env\n');
    writeEnv(dir, 'SUPABASE_SECRET_KEY=fake-local-1\n', '.env.local');
    loadConfig(dir);
    assert.equal(process.env.SUPABASE_SECRET_KEY, 'fake-local-1');
    writeEnv(dir, 'SUPABASE_SECRET_KEY=fake-local-2\n', '.env.local');
    loadConfig(dir);
    assert.equal(process.env.SUPABASE_SECRET_KEY, 'fake-local-2');
  });

  await test('значение, изменённое после подстановки не конфигом, не перезаписывается', async (dir) => {
    writeEnv(dir, 'TELEGRAM_BOT_TOKEN=fake-file-1\n');
    loadConfig(dir);
    process.env.TELEGRAM_BOT_TOKEN = 'fake-set-at-runtime';
    writeEnv(dir, 'TELEGRAM_BOT_TOKEN=fake-file-2\n');
    loadConfig(dir);
    assert.equal(process.env.TELEGRAM_BOT_TOKEN, 'fake-set-at-runtime');
  });

  await test('ни одного сетевого запроса', async () => { assert.equal(fetchCalls, 0); });
} finally {
  process.chdir(savedCwd);
  delete globalThis[INJECTED_KEY];
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
}

process.stdout.write(results.join('\n') + `\n\nВсего: ${results.length}, провалено: ${results.filter((r) => r.startsWith('FAIL')).length}\n`);
process.exitCode = results.some((r) => r.startsWith('FAIL')) ? 1 : 0;
