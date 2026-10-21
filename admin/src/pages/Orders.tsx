import { useMemo, useState } from 'react';
import { supabase, unwrap } from '../supabase';
import {
  Badge, Button, Chips, DataTable, ErrorBox, Field, Modal, PageHeader, PageLoader, SearchInput,
  navigate, orNull, useAction, useAsync, type Column,
} from '../ui';
import { ORDER_STATUS, formatDate, formatDateTime, matchesQuery, money } from '../format';
import { fetchClients, fetchProducts } from '../data';
import type { Application, Client, Order, OrderItem, OrderStatus, Product } from '../types';

type StatusFilter = 'all' | 'active' | OrderStatus;
const ACTIVE: OrderStatus[] = ['new', 'confirmed', 'in_production', 'ready', 'delivered'];

export function Orders({ routeId }: { routeId?: string }) {
  const { data, error, loading, reload } = useAsync(async () => {
    const [orders, clients, products] = await Promise.all([
      supabase.from('orders').select('*, clients(name,phone)').order('created_at', { ascending: false }).limit(2000),
      fetchClients(),
      fetchProducts(),
    ]);
    return { orders: unwrap(orders) as Order[], clients, products };
  });
  const [status, setStatus] = useState<StatusFilter>('active');
  const [query, setQuery] = useState('');

  const orders = data?.orders ?? [];
  const filtered = orders.filter((o) =>
    (status === 'all' || (status === 'active' ? ACTIVE.includes(o.status) : o.status === status))
    && matchesQuery(query, o.id, o.clients?.name, o.clients?.phone, o.delivery_address, o.notes));

  const columns: Column<Order>[] = [
    { key: 'id', header: '№', render: (o) => <span className="mono">{o.id}</span>, sort: (o) => o.id, className: 'col-narrow' },
    { key: 'created_at', header: 'Создан', render: (o) => formatDate(o.created_at), sort: (o) => o.created_at },
    { key: 'client', header: 'Клиент', render: (o) => <><strong>{o.clients?.name}</strong><div className="muted small">{o.clients?.phone}</div></>, sort: (o) => o.clients?.name ?? '' },
    { key: 'status', header: 'Статус', render: (o) => <Badge tone={ORDER_STATUS[o.status].tone}>{ORDER_STATUS[o.status].label}</Badge>, sort: (o) => o.status },
    { key: 'total', header: 'Сумма', render: (o) => money(o.total), sort: (o) => o.total, className: 'num' },
    { key: 'debt', header: 'К оплате', render: (o) => money(Math.max(0, o.total - o.prepayment)), sort: (o) => o.total - o.prepayment, className: 'num' },
    { key: 'due', header: 'Срок', render: (o) => formatDate(o.due_date), sort: (o) => o.due_date },
  ];

  const editingId = routeId && /^\d+$/.test(routeId) ? Number(routeId) : null;
  const creating = routeId === 'new' || routeId?.startsWith('from-') || routeId?.startsWith('client-');

  return (
    <>
      <PageHeader
        title="Заказы"
        subtitle="Производство и доставка: позиции, оплата, сроки"
        actions={<Button variant="primary" onClick={() => navigate('orders', 'new')}>+ Новый заказ</Button>}
      />
      <div className="toolbar">
        <Chips<StatusFilter>
          value={status}
          onChange={setStatus}
          options={[
            { value: 'active', label: 'В работе', count: orders.filter((o) => ACTIVE.includes(o.status)).length },
            { value: 'all', label: 'Все', count: orders.length },
            ...(Object.keys(ORDER_STATUS) as OrderStatus[]).map((s) => ({ value: s, label: ORDER_STATUS[s].label })),
          ]}
        />
        <div className="toolbar__right"><SearchInput value={query} onChange={setQuery} placeholder="№, клиент, адрес…" /></div>
      </div>

      {loading && !data ? <PageLoader /> : error && !data ? <ErrorBox error={error} onRetry={reload} /> : (
        <DataTable rows={filtered} columns={columns} rowKey={(o) => o.id} onRowClick={(o) => navigate('orders', o.id)} initialSort={{ key: 'created_at', dir: 'desc' }} />
      )}

      {data && (editingId || creating) && (
        <OrderEditor
          key={routeId}
          orderId={editingId}
          routeId={routeId!}
          clients={data.clients}
          products={data.products}
          onClose={() => navigate('orders')}
          onSaved={(id) => { reload(); navigate('orders', id); }}
          onDeleted={() => { reload(); navigate('orders'); }}
        />
      )}
    </>
  );
}

type FormState = {
  client_id: string; application_id: number | null; status: OrderStatus; prepayment: string;
  delivery_address: string; due_date: string; notes: string; items: OrderItem[];
};

function OrderEditor({ orderId, routeId, clients, products, onClose, onSaved, onDeleted }: {
  orderId: number | null; routeId: string; clients: Client[]; products: Product[];
  onClose: () => void; onSaved: (id: number) => void; onDeleted: () => void;
}) {
  // Начальное состояние: существующий заказ, заказ из заявки или для клиента
  const initial = useAsync(async (): Promise<FormState & { created_at?: string }> => {
    if (orderId) {
      const order = unwrap(await supabase.from('orders').select('*').eq('id', orderId).single()) as Order;
      const items = unwrap(await supabase.from('order_items').select('*').eq('order_id', orderId).order('id')) as OrderItem[];
      return {
        client_id: String(order.client_id), application_id: order.application_id, status: order.status,
        prepayment: String(order.prepayment), delivery_address: order.delivery_address ?? '', due_date: order.due_date ?? '',
        notes: order.notes ?? '', items, created_at: order.created_at,
      };
    }
    const base: FormState = { client_id: '', application_id: null, status: 'new', prepayment: '0', delivery_address: '', due_date: '', notes: '', items: [] };
    if (routeId.startsWith('client-')) base.client_id = routeId.slice(7);
    if (routeId.startsWith('from-')) {
      const app = unwrap(await supabase.from('applications').select('*').eq('id', Number(routeId.slice(5))).single()) as Application;
      base.application_id = app.id;
      base.client_id = app.client_id ? String(app.client_id) : '';
      base.notes = app.comment ?? '';
      const product = products.find((p) => p.id === app.product_id) ?? products.find((p) => app.product_name?.startsWith(p.name));
      base.items = [product
        ? { product_id: product.id, title: product.name, unit_price: product.price, quantity: app.quantity, options: null }
        : { product_id: null, title: app.product_name || 'Изготовление на заказ', unit_price: 0, quantity: app.quantity, options: null }];
    }
    return base;
  }, [orderId, routeId]);

  if (initial.loading) return <Modal title="Заказ" onClose={onClose}><PageLoader /></Modal>;
  if (initial.error || !initial.data) return <Modal title="Заказ" onClose={onClose}><ErrorBox error={initial.error ?? 'Нет данных'} /></Modal>;
  return <OrderForm initial={initial.data} orderId={orderId} clients={clients} products={products} onClose={onClose} onSaved={onSaved} onDeleted={onDeleted} />;
}

function OrderForm({ initial, orderId, clients, products, onClose, onSaved, onDeleted }: {
  initial: FormState & { created_at?: string }; orderId: number | null; clients: Client[]; products: Product[];
  onClose: () => void; onSaved: (id: number) => void; onDeleted: () => void;
}) {
  const [form, setForm] = useState<FormState>(initial);
  const [clientQuery, setClientQuery] = useState('');
  const { busy, run } = useAction();
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setItem = (i: number, patch: Partial<OrderItem>) => set('items', form.items.map((it, j) => (j === i ? { ...it, ...patch } : it)));

  const total = form.items.reduce((s, it) => s + (Number(it.unit_price) || 0) * (Number(it.quantity) || 0), 0);
  const clientOptions = useMemo(() => {
    const list = clients.filter((c) => matchesQuery(clientQuery, c.name, c.phone)).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    const current = clients.find((c) => String(c.id) === form.client_id);
    return current && !list.includes(current) ? [current, ...list] : list;
  }, [clients, clientQuery, form.client_id]);

  const save = () => run(async () => {
    if (!form.client_id) throw new Error('Выберите клиента');
    if (!form.items.length) throw new Error('Добавьте хотя бы одну позицию');
    for (const it of form.items) {
      if (!it.title.trim()) throw new Error('У каждой позиции должно быть название');
      if (!(Number(it.quantity) >= 1)) throw new Error('Количество — от 1');
      if (!(Number(it.unit_price) >= 0)) throw new Error('Цена не может быть отрицательной');
    }
    const prepayment = Math.max(0, Math.round(Number(form.prepayment) || 0));
    const row = {
      client_id: Number(form.client_id), application_id: form.application_id, status: form.status, prepayment,
      delivery_address: orNull(form.delivery_address), due_date: form.due_date || null, notes: orNull(form.notes),
    };
    const saved = orderId
      ? unwrap(await supabase.from('orders').update(row).eq('id', orderId).select('id').single()) as { id: number }
      : unwrap(await supabase.from('orders').insert(row).select('id').single()) as { id: number };

    // Позиции: удалить убранные, обновить изменённые, добавить новые. Сумму пересчитывает триггер в базе.
    const keepIds = form.items.filter((it) => it.id).map((it) => it.id!);
    const removed = initial.items.filter((it) => it.id && !keepIds.includes(it.id)).map((it) => it.id!);
    if (removed.length) unwrap(await supabase.from('order_items').delete().in('id', removed));
    for (const it of form.items) {
      const item = {
        order_id: saved.id, product_id: it.product_id, title: it.title.trim(),
        unit_price: Math.round(Number(it.unit_price)), quantity: Math.round(Number(it.quantity)), options: orNull(it.options ?? ''),
      };
      if (it.id) unwrap(await supabase.from('order_items').update(item).eq('id', it.id));
      else unwrap(await supabase.from('order_items').insert(item));
    }
    // Заявка, из которой создан заказ, получает статус «Заказ оформлен»
    if (!orderId && form.application_id) {
      unwrap(await supabase.from('applications').update({ status: 'converted' }).eq('id', form.application_id));
    }
    onSaved(saved.id);
  }, orderId ? 'Заказ сохранён' : 'Заказ создан');

  const remove = () => {
    if (!orderId || !confirm(`Удалить заказ №${orderId} со всеми позициями?`)) return;
    run(async () => { unwrap(await supabase.from('orders').delete().eq('id', orderId)); onDeleted(); }, 'Заказ удалён');
  };

  return (
    <Modal
      wide
      title={orderId ? `Заказ №${orderId}` : 'Новый заказ'}
      onClose={onClose}
      footer={<>
        {orderId && <Button variant="danger" onClick={remove} disabled={busy}>Удалить</Button>}
        <span className="spacer" />
        <Button onClick={onClose}>Отмена</Button>
        <Button variant="primary" onClick={save} loading={busy}>Сохранить</Button>
      </>}
    >
      {initial.created_at && <p className="muted small">Создан {formatDateTime(initial.created_at)}</p>}
      {form.application_id && <p className="muted small">По заявке <a href={`#/applications/${form.application_id}`}>№{form.application_id}</a></p>}

      <div className="form-grid">
        <Field label="Клиент" hint={<a href="#/clients">Нет в списке? Создайте клиента</a>}>
          <input placeholder="Поиск клиента…" value={clientQuery} onChange={(e) => setClientQuery(e.target.value)} />
          <select value={form.client_id} onChange={(e) => set('client_id', e.target.value)} size={1}>
            <option value="">— выберите —</option>
            {clientOptions.map((c) => <option key={c.id} value={c.id}>{c.name}{c.phone ? ` · ${c.phone}` : ''}</option>)}
          </select>
        </Field>
        <Field label="Статус">
          <select value={form.status} onChange={(e) => set('status', e.target.value as OrderStatus)}>
            {(Object.keys(ORDER_STATUS) as OrderStatus[]).map((s) => <option key={s} value={s}>{ORDER_STATUS[s].label}</option>)}
          </select>
        </Field>
        <Field label="Срок готовности"><input type="date" value={form.due_date} onChange={(e) => set('due_date', e.target.value)} /></Field>
        <Field label="Предоплата, сом"><input type="number" min={0} value={form.prepayment} onChange={(e) => set('prepayment', e.target.value)} /></Field>
        <Field label="Адрес доставки" wide><input value={form.delivery_address} maxLength={300} onChange={(e) => set('delivery_address', e.target.value)} /></Field>
      </div>

      <h3 className="section-title">Позиции</h3>
      <div className="items">
        {form.items.map((it, i) => (
          <div className="item-row" key={it.id ?? `new-${i}`}>
            <select
              aria-label="Товар"
              value={it.product_id ?? ''}
              onChange={(e) => {
                const p = products.find((x) => x.id === e.target.value);
                setItem(i, p ? { product_id: p.id, title: p.name, unit_price: p.price } : { product_id: null });
              }}
            >
              <option value="">Своя позиция</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <input aria-label="Название" placeholder="Название" value={it.title} maxLength={200} onChange={(e) => setItem(i, { title: e.target.value })} />
            <input aria-label="Параметры" placeholder="Размеры, тонировка…" value={it.options ?? ''} maxLength={1000} onChange={(e) => setItem(i, { options: e.target.value })} />
            <input aria-label="Цена" type="number" min={0} value={it.unit_price} onChange={(e) => setItem(i, { unit_price: Number(e.target.value) })} />
            <input aria-label="Количество" type="number" min={1} max={999} value={it.quantity} onChange={(e) => setItem(i, { quantity: Number(e.target.value) })} />
            <span className="item-row__sum">{money((Number(it.unit_price) || 0) * (Number(it.quantity) || 0))}</span>
            <button type="button" className="icon-btn" aria-label="Удалить позицию" onClick={() => set('items', form.items.filter((_, j) => j !== i))}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
            </button>
          </div>
        ))}
        <Button size="sm" onClick={() => set('items', [...form.items, { product_id: null, title: '', unit_price: 0, quantity: 1, options: null }])}>+ Позиция</Button>
      </div>
      <div className="order-total">
        <span>Итого: <strong>{money(total)}</strong></span>
        <span className="muted">К оплате после предоплаты: {money(Math.max(0, total - (Number(form.prepayment) || 0)))}</span>
      </div>

      <Field label="Заметки" wide><textarea rows={3} maxLength={5000} value={form.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
    </Modal>
  );
}
