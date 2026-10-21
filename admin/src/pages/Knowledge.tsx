import { useRef, useState, type FormEvent } from 'react';
import { adminApi, supabase, unwrap } from '../supabase';
import {
  Badge, Button, Card, Chips, DataTable, ErrorBox, Field, Modal, PageHeader, PageLoader, SearchInput, Stat,
  useAction, useAsync, useToast, type Column,
} from '../ui';
import { KB_KIND, formatDateTime, matchesQuery, relative } from '../format';
import type { KbDocument, KbKind } from '../types';

type SearchResult = { mode: 'hybrid' | 'fulltext'; results: { document_id: number; title: string; content: string; score: number }[] };

const indexState = (d: KbDocument) => {
  if (!d.indexed_at) return { label: 'Не проиндексирован', tone: 'danger' as const };
  if (new Date(d.updated_at) > new Date(d.indexed_at)) return { label: 'Требует обновления', tone: 'warning' as const };
  return { label: 'В индексе', tone: 'success' as const };
};

export function Knowledge() {
  const { data, error, loading, reload } = useAsync(async () => {
    const [docs, embedded] = await Promise.all([
      supabase.from('kb_documents').select('*, kb_chunks(count)').order('updated_at', { ascending: false }),
      supabase.from('kb_chunks').select('id', { count: 'exact', head: true }).not('embedding', 'is', null),
    ]);
    return { docs: unwrap(docs) as KbDocument[], embeddedChunks: embedded.count ?? 0 };
  });
  const [editing, setEditing] = useState<KbDocument | 'new' | null>(null);
  const [uploading, setUploading] = useState(false);
  const [kind, setKind] = useState<'all' | KbKind>('all');
  const [query, setQuery] = useState('');
  const { busy, run } = useAction();

  const docs = data?.docs ?? [];
  const chunks = (d: KbDocument) => d.kb_chunks?.[0]?.count ?? 0;
  const totalChunks = docs.reduce((s, d) => s + chunks(d), 0);
  const stale = docs.filter((d) => indexState(d).tone !== 'success').length;
  const filtered = docs.filter((d) => (kind === 'all' || d.kind === kind) && matchesQuery(query, d.title, d.content));

  const reindexAll = () => run(async () => {
    const r = await adminApi<{ documents: number; chunks: number; embedded: boolean }>('/api/admin/kb', { action: 'reindex_all' });
    reload();
    return r;
  }).then((r) => r && alertIndex(r.embedded, `${r.documents} документов, ${r.chunks} фрагментов`));

  const toast = useToast();
  const alertIndex = (embedded: boolean, what: string) => toast(
    embedded ? `Индекс обновлён: ${what}, с embeddings (векторный поиск)` : `Индекс обновлён: ${what}. Embeddings недоступны — работает полнотекстовый поиск`,
    embedded ? 'success' : 'error',
  );

  const columns: Column<KbDocument>[] = [
    { key: 'title', header: 'Документ', render: (d) => <><strong>{d.title}</strong><div className="muted small">{d.content.slice(0, 110)}{d.content.length > 110 ? '…' : ''}</div></>, sort: (d) => d.title },
    { key: 'kind', header: 'Тип', render: (d) => KB_KIND[d.kind], sort: (d) => d.kind },
    { key: 'published', header: 'Доступен агенту', render: (d) => (d.is_published ? 'Да' : <span className="muted">Скрыт</span>), sort: (d) => (d.is_published ? 1 : 0) },
    { key: 'chunks', header: 'Фрагменты', render: (d) => chunks(d), sort: chunks, className: 'num' },
    { key: 'index', header: 'Индекс', render: (d) => <><Badge tone={indexState(d).tone}>{indexState(d).label}</Badge>{d.embedding_model && <div className="muted small">векторы: {d.embedding_model}</div>}</>, sort: (d) => indexState(d).label },
    { key: 'updated', header: 'Изменён', render: (d) => <span title={formatDateTime(d.updated_at)}>{relative(d.updated_at)}</span>, sort: (d) => d.updated_at },
  ];

  return (
    <>
      <PageHeader
        title="База знаний"
        subtitle="Источник ответов AI-агента (RAG): текст делится на фрагменты, индексируется и ищется по смыслу и словам"
        actions={<>
          <Button onClick={reindexAll} loading={busy}>Переиндексировать всё</Button>
          <Button onClick={() => setUploading(true)}>Загрузить файл</Button>
          <Button variant="primary" onClick={() => setEditing('new')}>+ Статья</Button>
        </>}
      />

      {loading && !data ? <PageLoader /> : error && !data ? <ErrorBox error={error} onRetry={reload} /> : data && (
        <>
          <div className="stats">
            <Stat label="Документов" value={docs.length} hint={`${docs.filter((d) => d.is_published).length} доступны агенту`} />
            <Stat label="Фрагментов в индексе" value={totalChunks} />
            <Stat
              label="Режим поиска"
              value={data.embeddedChunks > 0 ? 'Гибридный' : 'Полнотекстовый'}
              hint={data.embeddedChunks > 0 ? `pgvector: ${data.embeddedChunks} из ${totalChunks} фрагментов с embeddings` : 'Embeddings не созданы: нет доступа к модели'}
              tone="accent"
            />
            <Stat label="Требуют индексации" value={stale} hint={stale ? 'Нажмите «Переиндексировать всё»' : 'Индекс актуален'} />
          </div>

          <SearchTester />

          <div className="toolbar">
            <Chips<'all' | KbKind>
              value={kind}
              onChange={setKind}
              options={[{ value: 'all', label: 'Все', count: docs.length }, ...(Object.keys(KB_KIND) as KbKind[]).filter((k) => docs.some((d) => d.kind === k)).map((k) => ({ value: k, label: KB_KIND[k] }))]}
            />
            <div className="toolbar__right"><SearchInput value={query} onChange={setQuery} placeholder="Поиск по документам…" /></div>
          </div>
          <DataTable rows={filtered} columns={columns} rowKey={(d) => d.id} onRowClick={setEditing} initialSort={{ key: 'updated', dir: 'desc' }} />
        </>
      )}

      {editing && (
        <DocumentForm
          doc={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(embedded) => { setEditing(null); reload(); alertIndex(embedded, 'документ'); }}
          onDeleted={() => { setEditing(null); reload(); }}
        />
      )}
      {uploading && <UploadForm onClose={() => setUploading(false)} onDone={(embedded) => { setUploading(false); reload(); alertIndex(embedded, 'файл загружен'); }} />}
    </>
  );
}

function SearchTester() {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<SearchResult | null>(null);
  const { busy, run } = useAction();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (query.trim().length < 2) return;
    run(async () => setResult(await adminApi<SearchResult>('/api/admin/kb', { action: 'search', query })));
  };

  return (
    <Card title="Проверка поиска" actions={result && <Badge tone="accent">{result.mode === 'hybrid' ? 'векторы + полнотекстовый' : 'полнотекстовый'}</Badge>}>
      <form className="inline-form" onSubmit={submit}>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Например: есть ли гарантия на диван?" aria-label="Вопрос" />
        <Button type="submit" variant="primary" loading={busy}>Найти</Button>
      </form>
      <p className="muted small">Это те же фрагменты, которые получит AI-агент через инструмент search_knowledge.</p>
      {result && (result.results.length ? (
        <ol className="search-results">
          {result.results.map((r, i) => (
            <li key={i}><strong>{r.title}</strong> <span className="muted small">релевантность {r.score}</span><p className="pre">{r.content}</p></li>
          ))}
        </ol>
      ) : <p className="muted">Ничего не найдено — агент ответит, что подтверждённой информации нет.</p>)}
    </Card>
  );
}

function DocumentForm({ doc, onClose, onSaved, onDeleted }: { doc: KbDocument | null; onClose: () => void; onSaved: (embedded: boolean) => void; onDeleted: () => void }) {
  const [form, setForm] = useState({ title: doc?.title ?? '', kind: doc?.kind ?? 'faq', content: doc?.content ?? '', is_published: doc?.is_published ?? true });
  const { busy, run } = useAction();

  const save = () => run(async () => {
    if (form.title.trim().length < 2) throw new Error('Укажите заголовок');
    if (!form.content.trim()) throw new Error('Добавьте текст');
    const row = { title: form.title.trim(), kind: form.kind, content: form.content.trim(), is_published: form.is_published };
    const saved = doc
      ? unwrap(await supabase.from('kb_documents').update(row).eq('id', doc.id).select('id').single()) as { id: number }
      : unwrap(await supabase.from('kb_documents').insert(row).select('id').single()) as { id: number };
    // Сразу обновляем индекс, чтобы агент отвечал по новой версии
    const r = await adminApi<{ embedded: boolean }>('/api/admin/kb', { action: 'reindex', document_id: saved.id });
    onSaved(r.embedded);
  });

  const remove = () => {
    if (!doc || !confirm(`Удалить «${doc.title}» из базы знаний?`)) return;
    run(async () => { unwrap(await supabase.from('kb_documents').delete().eq('id', doc.id)); onDeleted(); }, 'Документ удалён');
  };

  return (
    <Modal
      wide
      title={doc ? 'Документ базы знаний' : 'Новая статья'}
      onClose={onClose}
      footer={<>
        {doc && <Button variant="danger" onClick={remove} disabled={busy}>Удалить</Button>}
        <span className="spacer" />
        <Button onClick={onClose}>Отмена</Button>
        <Button variant="primary" onClick={save} loading={busy}>Сохранить и проиндексировать</Button>
      </>}
    >
      <div className="form-grid">
        <Field label="Заголовок"><input value={form.title} maxLength={200} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Сроки изготовления" /></Field>
        <Field label="Тип">
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as KbKind })}>
            {(Object.keys(KB_KIND) as KbKind[]).map((k) => <option key={k} value={k}>{KB_KIND[k]}</option>)}
          </select>
        </Field>
        <Field label="Текст" wide hint="Пишите фактами. Для FAQ: «Вопрос: … Ответ: …». Абзацы разделяйте пустой строкой.">
          <textarea rows={14} value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} />
        </Field>
        <label className="check"><input type="checkbox" checked={form.is_published} onChange={(e) => setForm({ ...form, is_published: e.target.checked })} /> Доступен AI-агенту</label>
      </div>
      {doc?.source_filename && <p className="muted small">Источник: файл {doc.source_filename}</p>}
    </Modal>
  );
}

function UploadForm({ onClose, onDone }: { onClose: () => void; onDone: (embedded: boolean) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<KbKind>('file');
  const { busy, run } = useAction();

  const upload = () => run(async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) throw new Error('Выберите файл');
    if (file.size > 3 * 1024 * 1024) throw new Error('Файл больше 3 МБ');
    const buffer = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let i = 0; i < buffer.length; i += 0x8000) binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
    const r = await adminApi<{ embedded: boolean; chunks: number }>('/api/admin/kb', {
      action: 'upload', filename: file.name, title: title.trim() || undefined, kind, data_base64: btoa(binary),
    });
    onDone(r.embedded);
  });

  return (
    <Modal
      title="Загрузка документа"
      onClose={onClose}
      footer={<><Button onClick={onClose}>Отмена</Button><Button variant="primary" onClick={upload} loading={busy}>Загрузить</Button></>}
    >
      <div className="form-grid">
        <Field label="Файл" hint=".pdf (с текстовым слоем), .txt, .md, .csv — до 3 МБ" wide>
          <input ref={fileRef} type="file" accept=".pdf,.txt,.md,.markdown,.csv,application/pdf,text/plain" />
        </Field>
        <Field label="Заголовок" hint="Пусто — имя файла"><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} /></Field>
        <Field label="Тип">
          <select value={kind} onChange={(e) => setKind(e.target.value as KbKind)}>
            {(Object.keys(KB_KIND) as KbKind[]).map((k) => <option key={k} value={k}>{KB_KIND[k]}</option>)}
          </select>
        </Field>
      </div>
    </Modal>
  );
}
