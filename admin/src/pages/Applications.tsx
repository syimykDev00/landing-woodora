import { useEffect, useMemo, useState } from 'react';
import { supabase, unwrap } from '../supabase';
import {
  Badge, Button, Chips, DataTable, Detail, Drawer, ErrorBox, Field, Modal, PageHeader, PageLoader, SearchInput,
  navigate, orNull, useAction, useAsync, type Column,
} from '../ui';
import { APPLICATION_SOURCE, APPLICATION_STATUS, formatDateTime, matchesQuery, relative } from '../format';
import { adminName, fetchAdmins, fetchProducts, findOrCreateClient } from '../data';
import type { Admin, Application, ApplicationSource, ApplicationStatus, Product } from '../types';

type StatusFilter = 'all' | ApplicationStatus;

export function Applications({ routeId }: { routeId?: string }) {
  const { data, error, loading, reload } = useAsync(async () => {
    const [apps, admins, products] = await Promise.all([
      supabase.from('applications').select('*').order('created_at', { ascending: false }).limit(2000),
      fetchAdmins(),
      fetchProducts(),
    ]);
    return { apps: unwrap(apps) as Application[], admins, products };
  });
  const [status, setStatus] = useState<StatusFilter>('all');
  const [source, setSource] = useState<'all' | ApplicationSource>('all');
  const [query, setQuery] = useState('');

  const apps = data?.apps ?? [];
  const filtered = useMemo(() => apps.filter((a) =>
    (status === 'all' || a.status === status)
    && (source === 'all' || a.source === source)
    && matchesQuery(query, a.customer_name, a.phone, a.product_name, a.comment, a.id),
  ), [apps, status, source, query]);

  const selected = routeId && routeId !== 'new' ? apps.find((a) => String(a.id) === routeId) : undefined;
  const close = () => navigate('applications');

  const counts = (s: ApplicationStatus) => apps.filter((a) => a.status === s).length;

  const columns: Column<Application>[] = [
    { key: 'id', header: '№', render: (a) => <span className="mono">{a.id}</span>, sort: (a) => a.id, className: 'col-narrow' },
    { key: 'created_at', header: 'Дата', render: (a) => <span title={formatDateTime(a.created_at)}>{relative(a.created_at)}</span>, sort: (a) => a.created_at },
    { key: 'customer_name', header: 'Клиент', render: (a) => <><strong>{a.customer_name}</strong><div className="muted small">{a.phone}</div></>, sort: (a) => a.customer_name },
    { key: 'product', header: 'Интерес', render: (a) => <>{a.product_name || <span className="muted">Консультация / на заказ</span>}{a.quantity > 1 && <span className="muted"> × {a.quantity}</span>}</>, sort: (a) => a.product_name },
    { key: 'source', header: 'Источник', render: (a) => (a.source === 'ai_chat' ? <Badge tone="accent">AI-чат</Badge> : APPLICATION_SOURCE[a.source]), sort: (a) => a.source },
    { key: 'status', header: 'Статус', render: (a) => <Badge tone={APPLICATION_STATUS[a.status].tone}>{APPLICATION_STATUS[a.status].label}</Badge>, sort: (a) => a.status },
    { key: 'assigned', header: 'Ответственный', render: (a) => adminName(data?.admins ?? [], a.assigned_to), sort: (a) => a.assigned_to },
  ];

  return (
    <>
      <PageHeader
        title="Заявки"
        subtitle="Обращения с сайта, из AI-чата и добавленные вручную"
        actions={<Button variant="primary" onClick={() => navigate('applications', 'new')}>+ Новая заявка</Button>}
      />
      <div className="toolbar">
        <Chips<StatusFilter>
          value={status}
          onChange={setStatus}
          options={[
            { value: 'all', label: 'Все', count: apps.length },
            ...(Object.keys(APPLICATION_STATUS) as ApplicationStatus[]).map((s) => ({ value: s, label: APPLICATION_STATUS[s].label, count: counts(s) })),
          ]}
        />
        <div className="toolbar__right">
          <select value={source} onChange={(e) => setSource(e.target.value as typeof source)} aria-label="Источник">
            <option value="all">Все источники</option>
            {(Object.keys(APPLICATION_SOURCE) as ApplicationSource[]).map((s) => <option key={s} value={s}>{APPLICATION_SOURCE[s]}</option>)}
          </select>
          <SearchInput value={query} onChange={setQuery} placeholder="Имя, телефон, товар…" />
        </div>
      </div>

      {loading && !data ? <PageLoader /> : error && !data ? <ErrorBox error={error} onRetry={reload} /> : (
        <DataTable
          rows={filtered}
          columns={columns}
          rowKey={(a) => a.id}
          onRowClick={(a) => navigate('applications', a.id)}
          initialSort={{ key: 'created_at', dir: 'desc' }}
        />
      )}

      {selected && data && <ApplicationDrawer app={selected} admins={data.admins} onClose={close} onChanged={reload} />}
      {routeId === 'new' && data && <ApplicationForm products={data.products} onClose={close} onSaved={(id) => { reload(); navigate('applications', id); }} />}
    </>
  );
}

function ApplicationDrawer({ app, admins, onClose, onChanged }: { app: Application; admins: Admin[]; onClose: () => void; onChanged: () => void }) {
  const [status, setStatus] = useState(app.status);
  const [assigned, setAssigned] = useState(app.assigned_to ?? '');
  const [note, setNote] = useState(app.manager_note ?? '');
  const { busy, run } = useAction();

  useEffect(() => {
    setStatus(app.status); setAssigned(app.assigned_to ?? ''); setNote(app.manager_note ?? '');
  }, [app]);

  const dirty = status !== app.status || assigned !== (app.assigned_to ?? '') || note !== (app.manager_note ?? '');

  const save = () => run(async () => {
    unwrap(await supabase.from('applications').update({ status, assigned_to: assigned || null, manager_note: orNull(note) }).eq('id', app.id));
    onChanged();
  }, 'Заявка обновлена');

  const remove = () => {
    if (!confirm(`Удалить заявку №${app.id}? Это действие необратимо.`)) return;
    run(async () => {
      unwrap(await supabase.from('applications').delete().eq('id', app.id));
      onChanged();
      onClose();
    }, 'Заявка удалена');
  };

  return (
    <Drawer
      title={<>Заявка №{app.id} <Badge tone={APPLICATION_STATUS[app.status].tone}>{APPLICATION_STATUS[app.status].label}</Badge></>}
      onClose={onClose}
      footer={<>
        <Button variant="danger" onClick={remove} disabled={busy}>Удалить</Button>
        <span className="spacer" />
        <Button onClick={() => navigate('orders', `from-${app.id}`)}>Создать заказ</Button>
        <Button variant="primary" onClick={save} loading={busy} disabled={!dirty}>Сохранить</Button>
      </>}
    >
      <dl className="details">
        <Detail label="Получена">{formatDateTime(app.created_at)}</Detail>
        <Detail label="Источник">{APPLICATION_SOURCE[app.source]}</Detail>
        <Detail label="Имя">{app.customer_name}</Detail>
        <Detail label="Телефон">{app.phone ? <a href={`tel:${app.phone.replace(/[^\d+]/g, '')}`}>{app.phone}</a> : null}</Detail>
        <Detail label="Интерес">{app.product_name || 'Консультация / изготовление на заказ'}</Detail>
        <Detail label="Количество">{app.quantity}</Detail>
        <Detail label="Комментарий">{app.comment ? <span className="pre">{app.comment}</span> : null}</Detail>
        <Detail label="Клиент">{app.client_id ? <a href={`#/clients/${app.client_id}`}>Карточка клиента →</a> : null}</Detail>
        {app.chat_session_id && <Detail label="AI-диалог"><a href={`#/chats/${app.chat_session_id}`}>Открыть переписку →</a></Detail>}
      </dl>

      <div className="form-grid">
        <Field label="Статус">
          <select value={status} onChange={(e) => setStatus(e.target.value as ApplicationStatus)}>
            {(Object.keys(APPLICATION_STATUS) as ApplicationStatus[]).map((s) => <option key={s} value={s}>{APPLICATION_STATUS[s].label}</option>)}
          </select>
        </Field>
        <Field label="Ответственный">
          <select value={assigned} onChange={(e) => setAssigned(e.target.value)}>
            <option value="">Не назначен</option>
            {admins.map((a) => <option key={a.user_id} value={a.user_id}>{a.full_name || a.email}</option>)}
          </select>
        </Field>
        <Field label="Заметка менеджера" wide>
          <textarea rows={4} maxLength={5000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Итог звонка, договорённости…" />
        </Field>
      </div>
    </Drawer>
  );
}

function ApplicationForm({ products, onClose, onSaved }: { products: Product[]; onClose: () => void; onSaved: (id: number) => void }) {
  const [form, setForm] = useState({ name: '', phone: '', product_id: '', quantity: '1', comment: '' });
  const { busy, run } = useAction();
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = () => run(async () => {
    if (form.name.trim().length < 2) throw new Error('Укажите имя');
    const qty = Number(form.quantity);
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) throw new Error('Количество — от 1 до 99');
    const clientId = await findOrCreateClient(form.name, form.phone, 'phone');
    const product = products.find((p) => p.id === form.product_id);
    const row = unwrap(await supabase.from('applications').insert({
      customer_name: form.name.trim(),
      phone: form.phone.trim(),
      client_id: clientId,
      product_id: product?.id ?? null,
      product_name: product?.name ?? null,
      quantity: qty,
      comment: orNull(form.comment),
      source: 'manual',
      status: 'new',
    }).select('id').single()) as { id: number };
    onSaved(row.id);
  }, 'Заявка создана');

  return (
    <Modal
      title="Новая заявка"
      onClose={onClose}
      footer={<><Button onClick={onClose}>Отмена</Button><Button variant="primary" onClick={save} loading={busy}>Создать</Button></>}
    >
      <p className="muted">Например, после звонка. Клиент найдётся по телефону или будет создан.</p>
      <div className="form-grid">
        <Field label="Имя"><input value={form.name} onChange={set('name')} maxLength={80} /></Field>
        <Field label="Телефон"><input value={form.phone} onChange={set('phone')} maxLength={30} placeholder="+996 …" /></Field>
        <Field label="Товар">
          <select value={form.product_id} onChange={set('product_id')}>
            <option value="">Консультация / изготовление на заказ</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="Количество"><input type="number" min={1} max={99} value={form.quantity} onChange={set('quantity')} /></Field>
        <Field label="Комментарий" wide><textarea rows={3} maxLength={1000} value={form.comment} onChange={set('comment')} /></Field>
      </div>
    </Modal>
  );
}
