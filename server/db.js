// Серверный клиент Supabase с секретным ключом. Обходит RLS, поэтому импортируется
// только из серверных функций (api/*), никогда — из кода для браузера.
import { createClient } from '@supabase/supabase-js';

let cached = null;

export function dbConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY);
}

export function db() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL или SUPABASE_SECRET_KEY не заданы');
  // В `npm run dev` .env может перечитаться — пересоздаём клиент, если значения поменялись
  if (!cached || cached.url !== url || cached.key !== key) {
    cached = {
      url,
      key,
      client: createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }),
    };
  }
  return cached.client;
}

// Ошибка запроса Supabase → исключение с безопасным текстом (без значений из details)
export function check({ data, error }, label) {
  if (error) throw new Error(`${label}: ${error.code || ''} ${String(error.message || '').slice(0, 200)}`);
  return data;
}

// Ограничение частоты: true — можно, false — превышен лимит. При сбое базы пропускаем
// запрос (лучше ответить посетителю, чем заблокировать всех), но пишем в лог.
export async function rateLimit(key, limit, windowSeconds) {
  try {
    const { data, error } = await db().rpc('hit_rate_limit', {
      p_key: key, p_limit: limit, p_window_seconds: windowSeconds,
    });
    if (error) throw error;
    return data !== false;
  } catch (err) {
    console.error('rate limit недоступен:', String(err?.message || err).slice(0, 200));
    return true;
  }
}
