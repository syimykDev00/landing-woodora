// Проверка администратора для серверных функций /api/admin/*.
// Браузер присылает access token сессии Supabase Auth в заголовке Authorization: Bearer …
// Сервер проверяет токен в Supabase Auth и наличие пользователя в public.admins.
import { db } from './db.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function requireAdmin(req) {
  const header = String(req.headers?.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new HttpError(401, 'Требуется вход');

  const { data, error } = await db().auth.getUser(token);
  if (error || !data?.user) throw new HttpError(401, 'Сессия недействительна, войдите снова');

  const { data: admin, error: adminError } = await db()
    .from('admins').select('user_id').eq('user_id', data.user.id).maybeSingle();
  if (adminError) throw new Error(`admins: ${adminError.message}`);
  if (!admin) throw new HttpError(403, 'Нет прав администратора');
  return data.user;
}
