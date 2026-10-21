import { useState } from 'react';
import { supabase, unwrap } from '../supabase';
import { Badge, Chips, DataTable, Drawer, ErrorBox, PageHeader, PageLoader, navigate, useAsync, type Column } from '../ui';
import { formatDateTime, relative } from '../format';
import type { ChatMessage, ChatSession } from '../types';

const TOOL_LABEL: Record<string, string> = {
  search_knowledge: 'поиск в базе знаний',
  get_services: 'каталог и услуги',
  check_availability: 'проверка наличия',
  get_business_info: 'информация о компании',
  create_lead: 'создание заявки',
};

export function Chats({ routeId }: { routeId?: string }) {
  const { data, error, loading, reload } = useAsync(async () =>
    unwrap(await supabase.from('chat_sessions').select('*').gt('message_count', 0).order('updated_at', { ascending: false }).limit(500)) as ChatSession[]);
  const [filter, setFilter] = useState<'all' | 'lead'>('all');

  const sessions = (data ?? []).filter((s) => filter === 'all' || s.application_id);
  const columns: Column<ChatSession>[] = [
    { key: 'updated', header: 'Последнее сообщение', render: (s) => <span title={formatDateTime(s.updated_at)}>{relative(s.updated_at)}</span>, sort: (s) => s.updated_at },
    { key: 'created', header: 'Начат', render: (s) => formatDateTime(s.created_at), sort: (s) => s.created_at },
    { key: 'count', header: 'Сообщений', render: (s) => s.message_count, sort: (s) => s.message_count, className: 'num' },
    {
      key: 'lead', header: 'Заявка',
      render: (s) => (s.application_id ? <a href={`#/applications/${s.application_id}`} onClick={(e) => e.stopPropagation()}><Badge tone="success">№{s.application_id}</Badge></a> : <span className="muted">—</span>),
      sort: (s) => s.application_id ?? 0,
    },
  ];

  return (
    <>
      <PageHeader title="AI-диалоги" subtitle="Переписки посетителей с AI-агентом и вызванные им инструменты" />
      <div className="toolbar">
        <Chips<'all' | 'lead'>
          value={filter}
          onChange={setFilter}
          options={[{ value: 'all', label: 'Все', count: data?.length }, { value: 'lead', label: 'С заявкой', count: data?.filter((s) => s.application_id).length }]}
        />
      </div>
      {loading && !data ? <PageLoader /> : error && !data ? <ErrorBox error={error} onRetry={reload} /> : (
        <DataTable rows={sessions} columns={columns} rowKey={(s) => s.id} onRowClick={(s) => navigate('chats', s.id)} initialSort={{ key: 'updated', dir: 'desc' }} />
      )}
      {routeId && <Transcript sessionId={routeId} onClose={() => navigate('chats')} />}
    </>
  );
}

function Transcript({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { data, error, loading } = useAsync(async () =>
    unwrap(await supabase.from('chat_messages').select('*').eq('session_id', sessionId).order('created_at')) as ChatMessage[], [sessionId]);

  return (
    <Drawer title="Переписка" onClose={onClose}>
      {loading ? <PageLoader /> : error ? <ErrorBox error={error} /> : (
        <div className="transcript">
          {data?.map((m) => (
            <div key={m.id} className={`bubble bubble--${m.role}`}>
              <p className="pre">{m.content}</p>
              {m.tool_calls?.length ? (
                <p className="bubble__tools">
                  Инструменты: {m.tool_calls.map((t, i) => (
                    <span key={i} className={t.ok ? '' : 'is-error'} title={JSON.stringify(t.input)}>{TOOL_LABEL[t.name] ?? t.name}{t.ok ? '' : ' (ошибка)'}</span>
                  ))}
                </p>
              ) : null}
              <time className="muted small">{formatDateTime(m.created_at)}</time>
            </div>
          ))}
          {!data?.length && <p className="muted">Сообщений нет</p>}
        </div>
      )}
    </Drawer>
  );
}
