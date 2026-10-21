// Клиент Supabase для админки. В браузере только адрес проекта и publishable-ключ:
// он не даёт доступа к данным сам по себе — всё решает RLS (public.is_admin()).
import { createClient } from '@supabase/supabase-js';

declare const __SUPABASE_URL__: string;
declare const __SUPABASE_PUBLISHABLE_KEY__: string;

export const supabaseConfigured = Boolean(__SUPABASE_URL__ && __SUPABASE_PUBLISHABLE_KEY__);

export const supabase = createClient(
  __SUPABASE_URL__ || 'https://not-configured.invalid',
  __SUPABASE_PUBLISHABLE_KEY__ || 'not-configured',
  { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'woodora-admin-auth' } },
);

// Результат запроса Supabase → данные или исключение с понятным текстом
export function unwrap<T>(result: { data: T | null; error: { message: string; code?: string } | null }): T {
  if (result.error) throw new Error(humanError(result.error));
  return result.data as T;
}

export function humanError(error: { message: string; code?: string }): string {
  switch (error.code) {
    case '23503': return 'Запись связана с другими данными (например, у клиента есть заказы) — удаление невозможно';
    case '23505': return 'Такая запись уже существует (например, клиент с этим телефоном)';
    case '23514': return 'Значение не прошло проверку: проверьте заполнение полей';
    case '42501': return 'Нет прав на это действие';
    case 'PGRST301': return 'Сессия истекла — войдите снова';
    default: return error.message || 'Ошибка запроса';
  }
}

// Серверные операции админки (/api/admin/*) — с токеном текущей сессии
export async function adminApi<T = Record<string, unknown>>(path: string, body: unknown): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Сессия истекла — войдите снова');
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.error || `Ошибка сервера (${response.status})`);
  return result as T;
}
