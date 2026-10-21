import { useEffect, useState } from 'react';
import { supabase, unwrap } from '../supabase';
import { Button, Card, ErrorBox, Field, Modal, PageHeader, PageLoader, intOrNull, orNull, useAction, useAsync } from '../ui';
import { money } from '../format';
import type { Service, Settings as SettingsRow } from '../types';

const COMPANY_FIELDS: { key: keyof SettingsRow; label: string; hint?: string; multiline?: boolean }[] = [
  { key: 'company_name', label: 'Название' },
  { key: 'tagline', label: 'Слоган' },
  { key: 'phone', label: 'Телефон' },
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'telegram', label: 'Telegram' },
  { key: 'instagram', label: 'Instagram' },
  { key: 'email', label: 'Email' },
  { key: 'working_hours', label: 'График работы' },
  { key: 'address', label: 'Адрес шоурума/мастерской', multiline: true },
  { key: 'about', label: 'О компании', multiline: true },
  { key: 'delivery_info', label: 'Доставка и сборка', multiline: true },
  { key: 'warranty_info', label: 'Гарантия', multiline: true },
  { key: 'payment_info', label: 'Оплата', hint: 'Способы оплаты, предоплата', multiline: true },
];

export function Settings() {
  const settings = useAsync(async () => unwrap(await supabase.from('company_settings').select('*').eq('id', 1).single()) as SettingsRow);
  const services = useAsync(async () => unwrap(await supabase.from('services').select('*').order('sort_order').order('name')) as Service[]);

  return (
    <>
      <PageHeader title="Настройки" subtitle="Данные компании и чат-бота. AI-агент берёт контакты, график и условия отсюда" />
      {settings.loading && !settings.data ? <PageLoader /> : settings.error && !settings.data ? <ErrorBox error={settings.error} onRetry={settings.reload} /> : settings.data && (
        <SettingsForm initial={settings.data} onSaved={settings.reload} />
      )}
      <ServicesCard state={services} />
    </>
  );
}

function SettingsForm({ initial, onSaved }: { initial: SettingsRow; onSaved: () => void }) {
  const [form, setForm] = useState(initial);
  const { busy, run } = useAction();
  useEffect(() => setForm(initial), [initial]);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  const save = () => run(async () => {
    if (!form.company_name?.trim()) throw new Error('Укажите название компании');
    if (!form.bot_name?.trim()) throw new Error('Укажите имя бота');
    const row: Record<string, unknown> = {};
    for (const f of COMPANY_FIELDS) row[f.key] = f.key === 'company_name' ? String(form[f.key]).trim() : orNull(String(form[f.key] ?? ''));
    Object.assign(row, {
      bot_enabled: form.bot_enabled,
      bot_name: form.bot_name.trim(),
      bot_greeting: form.bot_greeting.trim(),
      bot_instructions: orNull(form.bot_instructions ?? ''),
    });
    unwrap(await supabase.from('company_settings').update(row).eq('id', 1));
    onSaved();
  }, 'Настройки сохранены — агент использует их со следующего сообщения');

  return (
    <>
      <Card title="Компания">
        <p className="muted small">Пустое поле агент не выдумывает — отвечает, что информации нет, и предлагает оставить заявку.</p>
        <div className="form-grid">
          {COMPANY_FIELDS.map((f) => (
            <Field key={f.key} label={f.label} hint={f.hint} wide={f.multiline}>
              {f.multiline
                ? <textarea rows={3} value={String(form[f.key] ?? '')} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
                : <input value={String(form[f.key] ?? '')} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />}
            </Field>
          ))}
        </div>
      </Card>

      <Card title="AI-чат на сайте">
        <div className="form-grid">
          <label className="check field--wide">
            <input type="checkbox" checked={form.bot_enabled} onChange={(e) => setForm({ ...form, bot_enabled: e.target.checked })} />
            Чат включён на сайте
          </label>
          <Field label="Имя помощника"><input value={form.bot_name} maxLength={80} onChange={(e) => setForm({ ...form, bot_name: e.target.value })} /></Field>
          <Field label="Приветствие"><input value={form.bot_greeting} maxLength={300} onChange={(e) => setForm({ ...form, bot_greeting: e.target.value })} /></Field>
          <Field label="Дополнительные инструкции агенту" wide hint="Тон общения, о чём обязательно упоминать, акции. Факты лучше добавлять в базу знаний.">
            <textarea rows={4} maxLength={3000} value={form.bot_instructions ?? ''} onChange={(e) => setForm({ ...form, bot_instructions: e.target.value })} />
          </Field>
        </div>
      </Card>

      <div className="sticky-save">
        <Button variant="primary" onClick={save} loading={busy} disabled={!dirty}>Сохранить настройки</Button>
        {dirty && <span className="muted small">Есть несохранённые изменения</span>}
      </div>
    </>
  );
}

function ServicesCard({ state }: { state: { data: Service[] | null; error: string | null; loading: boolean; reload: () => void } }) {
  const [editing, setEditing] = useState<Service | 'new' | null>(null);
  return (
    <Card title="Услуги" actions={<Button size="sm" onClick={() => setEditing('new')}>+ Услуга</Button>}>
      <p className="muted small">Список услуг получает AI-агент (инструмент get_services).</p>
      {state.loading && !state.data ? <PageLoader /> : state.error && !state.data ? <ErrorBox error={state.error} onRetry={state.reload} /> : (
        <ul className="service-list">
          {state.data?.map((s) => (
            <li key={s.id}>
              <button type="button" className="service-list__item" onClick={() => setEditing(s)}>
                <span><strong>{s.name}</strong>{!s.is_active && <span className="muted"> · скрыта</span>}<span className="muted small block">{s.description}</span></span>
                <span className="muted">{s.price_from != null ? `от ${money(s.price_from)}` : 'индивидуально'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {editing && <ServiceForm service={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); state.reload(); }} />}
    </Card>
  );
}

function ServiceForm({ service, onClose, onSaved }: { service: Service | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    name: service?.name ?? '', description: service?.description ?? '',
    price_from: service?.price_from != null ? String(service.price_from) : '', sort_order: String(service?.sort_order ?? 100),
    is_active: service?.is_active ?? true,
  });
  const { busy, run } = useAction();
  const save = () => run(async () => {
    if (form.name.trim().length < 2) throw new Error('Укажите название');
    const row = { name: form.name.trim(), description: orNull(form.description), price_from: intOrNull(form.price_from), sort_order: intOrNull(form.sort_order) ?? 100, is_active: form.is_active };
    if (service) unwrap(await supabase.from('services').update(row).eq('id', service.id));
    else unwrap(await supabase.from('services').insert(row));
    onSaved();
  }, 'Услуга сохранена');
  const remove = () => {
    if (!service || !confirm(`Удалить услугу «${service.name}»?`)) return;
    run(async () => { unwrap(await supabase.from('services').delete().eq('id', service.id)); onSaved(); }, 'Услуга удалена');
  };
  return (
    <Modal
      title={service ? 'Услуга' : 'Новая услуга'}
      onClose={onClose}
      footer={<>
        {service && <Button variant="danger" onClick={remove} disabled={busy}>Удалить</Button>}
        <span className="spacer" />
        <Button onClick={onClose}>Отмена</Button>
        <Button variant="primary" onClick={save} loading={busy}>Сохранить</Button>
      </>}
    >
      <div className="form-grid">
        <Field label="Название"><input value={form.name} maxLength={120} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Цена от, сом" hint="Пусто — рассчитывается индивидуально"><input type="number" min={0} value={form.price_from} onChange={(e) => setForm({ ...form, price_from: e.target.value })} /></Field>
        <Field label="Описание" wide><textarea rows={3} maxLength={3000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
        <Field label="Порядок"><input type="number" value={form.sort_order} onChange={(e) => setForm({ ...form, sort_order: e.target.value })} /></Field>
        <label className="check"><input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} /> Активна</label>
      </div>
    </Modal>
  );
}
