import { supabase, unwrap } from './supabase';
import { digits } from './format';
import type { Admin, Client, Product } from './types';

export async function fetchAdmins(): Promise<Admin[]> {
  return unwrap(await supabase.from('admins').select('user_id,email,full_name').order('email'));
}

export async function fetchClients(): Promise<Client[]> {
  return unwrap(await supabase.from('clients').select('*').order('created_at', { ascending: false }).limit(2000));
}

export async function fetchProducts(): Promise<Product[]> {
  return unwrap(await supabase.from('products').select('*').order('sort_order').order('name'));
}

// Клиент по цифрам телефона (уникален) или новый — так же, как это делает сервер для заявок с сайта
export async function findOrCreateClient(name: string, phone: string, source: Client['source'] = 'manual'): Promise<number> {
  const all = digits(phone);
  if (all.length < 9) throw new Error('Укажите телефон (минимум 9 цифр)');
  // Как в базе: клиент определяется по последним 9 цифрам (+996 555… и 0555… — один номер)
  const existing = unwrap(await supabase.from('clients').select('id').eq('phone_digits', all.slice(-9)).maybeSingle()) as { id: number } | null;
  if (existing) return existing.id;
  const created = unwrap(await supabase.from('clients').insert({ name: name.trim(), phone: phone.trim(), source }).select('id').single()) as { id: number };
  return created.id;
}

export const adminName = (admins: Admin[], id: string | null) => {
  const a = admins.find((x) => x.user_id === id);
  return a ? a.full_name || a.email : '—';
};
