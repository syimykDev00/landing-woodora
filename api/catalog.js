// Публичный каталог для лендинга: активные товары из Supabase (GET /api/catalog).
// Читает сервер секретным ключом — у посетителей прямого доступа к таблицам нет.
// Изменения в админке видны на сайте после истечения кэша CDN (до 60 с).
import { send, safeError } from './lead.js';
import { db, dbConfigured, check } from '../server/db.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return send(res, 405, { ok: false, error: 'Метод не поддерживается' });
  }
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Каталог не настроен' });

  try {
    const rows = check(
      await db().from('products')
        .select('id,name,material,room,price,old_price,is_new,image_url')
        .eq('is_active', true)
        .order('sort_order').order('name'),
      'products',
    );
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    return send(res, 200, {
      ok: true,
      products: rows.map((p) => ({
        id: p.id,
        name: p.name,
        material: p.material,
        room: p.room,
        price: p.price,
        ...(p.old_price ? { oldPrice: p.old_price } : {}),
        ...(p.is_new ? { isNew: true } : {}),
        image: p.image_url || '',
      })),
    });
  } catch (err) {
    console.error('catalog:', safeError(err));
    return send(res, 502, { ok: false, error: 'Каталог временно недоступен' });
  }
}
