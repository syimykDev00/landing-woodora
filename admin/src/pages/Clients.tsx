import { useMemo, useState } from 'react';
import { supabase, unwrap } from '../supabase';
import {
  Badge, Button, Chips, DataTable, Detail, Drawer, ErrorBox, Field, Modal, PageHeader, PageLoader, SearchInput,
  navigate, orNull, useAction, useAsync, type Column,
} from '../ui';
import { APPLICATION_STATUS, CLIENT_SOURCE, ORDER_STATUS, formatDate, formatDateTime, matchesQuery, money } from '../format';
import { fetchClients } from '../data';
import type { Application, Client, ClientSource, Order } from '../types';

type AppLite = Pick<Application, 'id' | 'client_id' | 'created_at' | 'status' | 'product_name' | 'source' | 'comment'>;
type OrderLite = Pick<Order, 'id' | 'client_id' | 'created_at' | 'status' | 'total'>;

export function Clients({ routeId }: { routeId?: string }) {
  const { data, error, loading, reload } = useAsync(async () => {
    const [clients, apps, orders] = await Promise.all([
      fetchClients(),
      supabase.from('applications').select('id,client_id,created_at,status,product_name,source,comment').order('created_at', { ascending: false }),
      supabase.from('orders').select('id,client_id,created_at,status,total').order('created_at', { ascending: false }),
    ]);
    return { clients, apps: unwrap(apps) as AppLite[], orders: unwrap(orders) as OrderLite[] };
  });
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<'all' | ClientSource>('all');
  const [editing, setEditing] = useState<Client | 'new' | null>(null);

  const stats = useMemo(() => {
    const map = new Map<number, { apps: number; orders: number; spent: number }>();
    const get = (id: number) => map.get(id) ?? (map.set(id, { apps: 0, orders: 0, spent: 0 }), map.get(id)!);
    data?.apps.forEach((a) => { if (a.client_id) get(a.client_id).apps++; });
    data?.orders.forEach((o) => { const s = get(o.client_id); s.orders++; if (o.status !== 'cancelled') s.spent += o.total; });
    return map;
  }, [data]);

  const clients = data?.clients ?? [];
  const filtered = clients.filter((c) => (source === 'all' || c.source === source) && matchesQuery(query, c.name, c.phone, c.email, c.address, c.notes));
  const selected = routeId ? clients.find((c) => String(c.id) === routeId) : undefined;
  const st = (c: Client) => stats.get(c.id) ?? { apps: 0, orders: 0, spent: 0 };

  const columns: Column<Client>[] = [
    { key: 'name', header: 'Имя', render: (c) => <strong>{c.name}</strong>, sort: (c) => c.name },
    { key: 'phone', header: 'Телефон', render: (c) => c.phone || '—', sort: (c) => c.phone },
    { key: 'source', header: 'Источник', render: (c) => CLIENT_SOURCE[c.source], sort: (c) => c.source },
    { key: 'apps', header: 'Заявки', render: (c) => st(c).apps, sort: (c) => st(c).apps, className: 'num' },
    { key: 'orders', header: 'Заказы', render: (c) => st(c).orders, sort: (c) => st(c).orders, className: 'num' },
    { key: 'spent', header: 'Сумма заказов', render: (c) => money(st(c).spent), sort: (c) => st(c).spent, className: 'num' },
    { key: 'created_at', header: 'Добавлен', render: (c) => formatDate(c.created_at), sort: (c) => c.created_at },
  ];

  return (
    <>
      <PageHeader
        title="Клиенты"
        subtitle="Клиент создаётся автоматически из заявки (по телефону) или вручную"
        actions={<Button variant="primary" onClick={() => setEditing('new')}>+ Новый клиент</Button>}
      />
      <div className="toolbar">
        <Chips<'all' | ClientSource>
          value={source}
          onChange={setSource}
          options={[{ value: 'all', label: 'Все', count: clients.length }, ...(['site', 'chat', 'manual', 'phone', 'showroom'] as ClientSource[]).map((s) => ({ value: s, label: CLIENT_SOURCE[s] }))]}
        />
        <div className="toolbar__right"><SearchInput value={query} onChange={setQuery} placeholder="Имя, телефон, email…" /></div>
      </div>

      {loading && !data ? <PageLoader /> : error && !data ? <ErrorBox error={error} onRetry={reload} /> : (
        <DataTable rows={filtered} columns={columns} rowKey={(c) => c.id} onRowClick={(c) => navigate('clients', c.id)} initialSort={{ key: 'created_at', dir: 'desc' }} />
      )}

      {selected && data && (
        <Drawer
          title={selected.name}
          onClose={() => navigate('clients')}
          footer={<>
            <DeleteClient client={selected} onDone={() => { reload(); navigate('clients'); }} />
            <span className="spacer" />
            <Button onClick={() => setEditing(selected)}>Редактировать</Button>
            <Button variant="primary" onClick={() => navigate('orders', `client-${selected.id}`)}>Новый заказ</Button>
          </>}
        >
          <dl className="details">
            <Detail label="Телефон">{selected.phone ? <a href={`tel:${selected.phone.replace(/[^\d+]/g, '')}`}>{selected.phone}</a> : null}</Detail>
            <Detail label="Email">{selected.email}</Detail>
            <Detail label="Адрес">{selected.address}</Detail>
            <Detail label="Источник">{CLIENT_SOURCE[selected.source]}</Detail>
            <Detail label="Добавлен">{formatDateTime(selected.created_at)}</Detail>
            <Detail label="Заметки">{selected.notes ? <span className="pre">{selected.notes}</span> : null}</Detail>
          </dl>

          <h3 className="section-title">История обращений</h3>
          {data.apps.filter((a) => a.client_id === selected.id).map((a) => (
            <a key={a.id} href={`#/applications/${a.id}`} className="history-item">
              <span><strong>Заявка №{a.id}</strong> · {a.product_name || 'консультация'}{a.comment ? <span className="muted"> — {a.comment.slice(0, 80)}</span> : null}</span>
              <span className="history-item__side"><Badge tone={APPLICATION_STATUS[a.status].tone}>{APPLICATION_STATUS[a.status].label}</Badge><span className="muted small">{formatDate(a.created_at)}</span></span>
            </a>
          ))}
          {!data.apps.some((a) => a.client_id === selected.id) && <p className="muted">Заявок нет</p>}

          <h3 className="section-title">Заказы</h3>
          {data.orders.filter((o) => o.client_id === selected.id).map((o) => (
            <a key={o.id} href={`#/orders/${o.id}`} className="history-item">
              <span><strong>Заказ №{o.id}</strong> · {money(o.total)}</span>
              <span className="history-item__side"><Badge tone={ORDER_STATUS[o.status].tone}>{ORDER_STATUS[o.status].label}</Badge><span className="muted small">{formatDate(o.created_at)}</span></span>
            </a>
          ))}
          {!data.orders.some((o) => o.client_id === selected.id) && <p className="muted">Заказов нет</p>}
        </Drawer>
      )}

      {editing && (
        <ClientForm
          client={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(id) => { setEditing(null); reload(); navigate('clients', id); }}
        />
      )}
    </>
  );
}

function DeleteClient({ client, onDone }: { client: Client; onDone: () => void }) {
  const { busy, run } = useAction();
  return (
    <Button
      variant="danger"
      loading={busy}
      onClick={() => {
        if (!confirm(`Удалить клиента «${client.name}»? Заявки останутся, но потеряют связь с карточкой.`)) return;
        run(async () => { unwrap(await supabase.from('clients').delete().eq('id', client.id)); onDone(); }, 'Клиент удалён');
      }}
    >
      Удалить
    </Button>
  );
}

function ClientForm({ client, onClose, onSaved }: { client: Client | null; onClose: () => void; onSaved: (id: number) => void }) {
  const [form, setForm] = useState({
    name: client?.name ?? '', phone: client?.phone ?? '', email: client?.email ?? '',
    address: client?.address ?? '', source: client?.source ?? 'manual', notes: client?.notes ?? '',
  });
  const { busy, run } = useAction();
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = () => run(async () => {
    if (!form.name.trim()) throw new Error('Укажите имя');
    const row = {
      name: form.name.trim(), phone: orNull(form.phone), email: orNull(form.email),
      address: orNull(form.address), source: form.source, notes: orNull(form.notes),
    };
    const result = client
      ? unwrap(await supabase.from('clients').update(row).eq('id', client.id).select('id').single())
      : unwrap(await supabase.from('clients').insert(row).select('id').single());
    onSaved((result as unknown as { id: number }).id);
  }, client ? 'Клиент сохранён' : 'Клиент создан');

  return (
    <Modal
      title={client ? 'Редактирование клиента' : 'Новый клиент'}
      onClose={onClose}
      footer={<><Button onClick={onClose}>Отмена</Button><Button variant="primary" onClick={save} loading={busy}>Сохранить</Button></>}
    >
      <div className="form-grid">
        <Field label="Имя"><input value={form.name} onChange={set('name')} maxLength={120} autoFocus /></Field>
        <Field label="Телефон" hint="Уникален: по нему к клиенту привязываются заявки"><input value={form.phone} onChange={set('phone')} maxLength={40} /></Field>
        <Field label="Email"><input type="email" value={form.email} onChange={set('email')} /></Field>
        <Field label="Источник">
          <select value={form.source} onChange={set('source')}>
            {(Object.keys(CLIENT_SOURCE) as ClientSource[]).map((s) => <option key={s} value={s}>{CLIENT_SOURCE[s]}</option>)}
          </select>
        </Field>
        <Field label="Адрес" wide><input value={form.address} onChange={set('address')} maxLength={300} /></Field>
        <Field label="Заметки" wide><textarea rows={4} value={form.notes} onChange={set('notes')} maxLength={5000} /></Field>
      </div>
    </Modal>
  );
}
