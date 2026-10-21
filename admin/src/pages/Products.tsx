import { useState } from 'react';
import { supabase, unwrap } from '../supabase';
import {
  Badge, Button, Chips, DataTable, ErrorBox, Field, Modal, PageHeader, PageLoader, SearchInput,
  intOrNull, orNull, useAction, useAsync, type Column,
} from '../ui';
import { ROOMS, matchesQuery, money } from '../format';
import { fetchProducts } from '../data';
import type { Product, Room } from '../types';

export function Products() {
  const { data, error, loading, reload } = useAsync(fetchProducts);
  const [room, setRoom] = useState<'all' | Room>('all');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const { run } = useAction();

  const products = data ?? [];
  const filtered = products.filter((p) => (room === 'all' || p.room === room) && matchesQuery(query, p.name, p.material, p.id));

  const toggleActive = (p: Product) => run(async () => {
    unwrap(await supabase.from('products').update({ is_active: !p.is_active }).eq('id', p.id));
    reload();
  }, p.is_active ? 'Товар скрыт с сайта' : 'Товар опубликован');

  const columns: Column<Product>[] = [
    { key: 'image', header: '', render: (p) => (p.image_url ? <img className="thumb" src={p.image_url} alt="" loading="lazy" /> : <span className="thumb thumb--empty" />), className: 'col-thumb' },
    { key: 'name', header: 'Товар', render: (p) => <><strong>{p.name}</strong>{p.is_new && <> <Badge tone="accent">Новинка</Badge></>}<div className="muted small">{p.material}</div></>, sort: (p) => p.name },
    { key: 'room', header: 'Категория', render: (p) => ROOMS[p.room], sort: (p) => p.room },
    { key: 'price', header: 'Цена', render: (p) => <>{money(p.price)}{p.old_price && <div className="muted small"><s>{money(p.old_price)}</s></div>}</>, sort: (p) => p.price, className: 'num' },
    { key: 'stock', header: 'Наличие', render: (p) => (p.stock == null ? <span className="muted">под заказ</span> : `${p.stock} шт.`), sort: (p) => p.stock ?? -1, className: 'num' },
    { key: 'sort', header: 'Порядок', render: (p) => p.sort_order, sort: (p) => p.sort_order, className: 'num' },
    {
      key: 'active', header: 'На сайте', className: 'col-action',
      render: (p) => (
        <label className="switch" onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={p.is_active} onChange={() => toggleActive(p)} />
          <span aria-hidden="true" />
          <span className="visually-hidden">Показывать на сайте</span>
        </label>
      ),
      sort: (p) => (p.is_active ? 1 : 0),
    },
  ];

  return (
    <>
      <PageHeader
        title="Каталог"
        subtitle="Товары лендинга. Изменения появляются на сайте и у AI-агента в течение минуты"
        actions={<Button variant="primary" onClick={() => setEditing('new')}>+ Товар</Button>}
      />
      <div className="toolbar">
        <Chips<'all' | Room>
          value={room}
          onChange={setRoom}
          options={[{ value: 'all', label: 'Все', count: products.length }, ...(Object.keys(ROOMS) as Room[]).map((r) => ({ value: r, label: ROOMS[r], count: products.filter((p) => p.room === r).length }))]}
        />
        <div className="toolbar__right"><SearchInput value={query} onChange={setQuery} placeholder="Название, материал…" /></div>
      </div>
      {loading && !data ? <PageLoader /> : error && !data ? <ErrorBox error={error} onRetry={reload} /> : (
        <DataTable rows={filtered} columns={columns} rowKey={(p) => p.id} onRowClick={setEditing} initialSort={{ key: 'sort', dir: 'asc' }} />
      )}
      {editing && <ProductForm product={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </>
  );
}

function ProductForm({ product, onClose, onSaved }: { product: Product | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    id: product?.id ?? '',
    name: product?.name ?? '',
    material: product?.material ?? '',
    room: product?.room ?? 'living',
    description: product?.description ?? '',
    price: product ? String(product.price) : '',
    old_price: product?.old_price != null ? String(product.old_price) : '',
    image_url: product?.image_url ?? '',
    stock: product?.stock != null ? String(product.stock) : '',
    lead_time_days: product?.lead_time_days != null ? String(product.lead_time_days) : '',
    sort_order: product ? String(product.sort_order) : '100',
    is_new: product?.is_new ?? false,
    is_active: product?.is_active ?? true,
  });
  const { busy, run } = useAction();
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = () => run(async () => {
    if (form.name.trim().length < 2) throw new Error('Укажите название');
    const price = intOrNull(form.price);
    if (price == null || price < 0) throw new Error('Укажите цену');
    const oldPrice = intOrNull(form.old_price);
    if (oldPrice != null && oldPrice <= price) throw new Error('Старая цена должна быть больше текущей');
    if (form.image_url && !/^https:\/\//.test(form.image_url)) throw new Error('Ссылка на фото должна начинаться с https://');
    const row = {
      name: form.name.trim(), material: form.material.trim(), room: form.room, description: orNull(form.description),
      price, old_price: oldPrice, image_url: orNull(form.image_url), stock: intOrNull(form.stock),
      lead_time_days: intOrNull(form.lead_time_days), sort_order: intOrNull(form.sort_order) ?? 100,
      is_new: form.is_new, is_active: form.is_active,
    };
    if (product) {
      unwrap(await supabase.from('products').update(row).eq('id', product.id));
    } else {
      const id = form.id.trim().toLowerCase();
      if (id && !/^[a-z0-9][a-z0-9-]{1,60}$/.test(id)) throw new Error('Код товара: латиница, цифры и дефис');
      const insertRow: Record<string, unknown> = id ? { ...row, id } : row;
      unwrap(await supabase.from('products').insert(insertRow));
    }
    onSaved();
  }, product ? 'Товар сохранён' : 'Товар добавлен');

  const remove = () => {
    if (!product || !confirm(`Удалить «${product.name}»? Заявки и заказы сохранятся, но потеряют ссылку на товар. Чтобы просто убрать с сайта — выключите «На сайте».`)) return;
    run(async () => { unwrap(await supabase.from('products').delete().eq('id', product.id)); onSaved(); }, 'Товар удалён');
  };

  return (
    <Modal
      wide
      title={product ? product.name : 'Новый товар'}
      onClose={onClose}
      footer={<>
        {product && <Button variant="danger" onClick={remove} disabled={busy}>Удалить</Button>}
        <span className="spacer" />
        <Button onClick={onClose}>Отмена</Button>
        <Button variant="primary" onClick={save} loading={busy}>Сохранить</Button>
      </>}
    >
      <div className="form-grid">
        <Field label="Название"><input value={form.name} onChange={set('name')} maxLength={120} placeholder="Диван «…»" /></Field>
        <Field label="Материал"><input value={form.material} onChange={set('material')} maxLength={200} placeholder="Дуб · лён" /></Field>
        <Field label="Категория">
          <select value={form.room} onChange={set('room')}>
            {(Object.keys(ROOMS) as Room[]).map((r) => <option key={r} value={r}>{ROOMS[r]}</option>)}
          </select>
        </Field>
        {product ? (
          <Field label="Код товара"><input value={product.id} disabled /></Field>
        ) : (
          <Field label="Код товара" hint="Необязательно, латиница: oak-table"><input value={form.id} onChange={set('id')} maxLength={61} /></Field>
        )}
        <Field label="Цена, сом"><input type="number" min={0} value={form.price} onChange={set('price')} /></Field>
        <Field label="Старая цена, сом" hint="Для скидки; пусто — без скидки"><input type="number" min={0} value={form.old_price} onChange={set('old_price')} /></Field>
        <Field label="Остаток, шт." hint="Пусто — остаток не ведётся (под заказ)"><input type="number" min={0} value={form.stock} onChange={set('stock')} /></Field>
        <Field label="Срок изготовления, дней" hint="Пусто — уточняет менеджер"><input type="number" min={1} max={365} value={form.lead_time_days} onChange={set('lead_time_days')} /></Field>
        <Field label="Фото (https://…)" wide><input value={form.image_url} onChange={set('image_url')} /></Field>
        <Field label="Описание" hint="Видит AI-агент: размеры, особенности, уход" wide><textarea rows={3} maxLength={3000} value={form.description} onChange={set('description')} /></Field>
        <Field label="Порядок в каталоге"><input type="number" value={form.sort_order} onChange={set('sort_order')} /></Field>
        <div className="checks">
          <label className="check"><input type="checkbox" checked={form.is_active} onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked }))} /> Показывать на сайте</label>
          <label className="check"><input type="checkbox" checked={form.is_new} onChange={(e) => setForm((f) => ({ ...f, is_new: e.target.checked }))} /> Новинка</label>
        </div>
      </div>
      {form.image_url && /^https:\/\//.test(form.image_url) && <img className="preview" src={form.image_url} alt="Предпросмотр" />}
    </Modal>
  );
}
