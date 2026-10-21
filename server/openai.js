// Клиент OpenAI — только для серверных функций. Ключ читается из OPENAI_API_KEY
// и никогда не попадает в браузер, ответы API и логи.
import OpenAI from 'openai';

let cached = null;

export const chatModel = () => process.env.OPENAI_MODEL || 'gpt-6-luna';
export const embeddingModel = () => process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
export const openaiConfigured = () => Boolean(process.env.OPENAI_API_KEY);

export function openai() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY не задан');
  // В `npm run dev` .env может перечитаться — пересоздаём клиент при смене ключа
  if (!cached || cached.key !== key) {
    cached = { key, client: new OpenAI({ apiKey: key, maxRetries: 1, timeout: 45_000 }) };
  }
  return cached.client;
}

// Текст ошибки OpenAI для лога: статус и код, без ключа и заголовков запроса
export function openaiError(err) {
  const status = err?.status ? `HTTP ${err.status}` : '';
  const code = err?.code || err?.error?.code || err?.type || '';
  const message = String(err?.error?.message || err?.message || err).replace(/sk-[\w-]{10,}/g, 'sk-<hidden>');
  return `${status} ${code} ${message}`.trim().slice(0, 400);
}
