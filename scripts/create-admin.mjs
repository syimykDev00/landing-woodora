// Создание администратора CRM. Единственный способ получить доступ к /admin:
// публичной регистрации с правами нет, строку в public.admins может добавить только сервер.
//
//   npm run admin:create -- admin@example.com            — пароль сгенерируется и будет показан один раз
//   npm run admin:create -- admin@example.com "Имя"      — с именем для поля «Ответственный»
//   ADMIN_PASSWORD=... npm run admin:create -- admin@example.com   — свой пароль
//
// Если пользователь с таким email уже есть в Supabase Auth — ему просто выдаются права.
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { loadEnv } from './env.mjs';

loadEnv();
const [email, fullName] = process.argv.slice(2);
if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error('Укажите email: npm run admin:create -- admin@example.com ["Имя"]');
  process.exit(1);
}

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function findUser(address) {
  for (let page = 1; page < 50; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const user = data.users.find((u) => u.email?.toLowerCase() === address.toLowerCase());
    if (user || data.users.length < 200) return user ?? null;
  }
  return null;
}

let user = await findUser(email);
let password = null;
if (!user) {
  password = process.env.ADMIN_PASSWORD || randomBytes(12).toString('base64url');
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) { console.error('Не удалось создать пользователя:', error.message); process.exit(1); }
  user = data.user;
}

const { error } = await db.from('admins').upsert({ user_id: user.id, email: user.email, full_name: fullName || null });
if (error) { console.error('Не удалось выдать права (применена ли миграция?):', error.message); process.exit(1); }

console.log(`Готово: ${user.email} — администратор CRM.`);
if (password && !process.env.ADMIN_PASSWORD) {
  console.log(`Пароль (показан один раз, сохраните его): ${password}`);
} else if (!password) {
  console.log('Пользователь уже существовал — пароль не менялся.');
}
