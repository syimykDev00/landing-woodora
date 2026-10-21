import { useState } from 'react';
import { supabase, unwrap } from '../supabase';
import { Card, Chips, ErrorBox, PageHeader, PageLoader, Stat, useAsync } from '../ui';
import { BarList, DailyColumns } from '../charts';
import { APPLICATION_SOURCE, APPLICATION_STATUS, ORDER_STATUS, SERIES_COLORS, formatDate, money } from '../format';
import type { Analytics as AnalyticsData, ApplicationSource, ApplicationStatus, OrderStatus } from '../types';

type Period = '7' | '30' | '90' | '365';

export function Analytics() {
  const [period, setPeriod] = useState<Period>('30');
  const { data, error, loading, reload } = useAsync(
    async () => unwrap(await supabase.rpc('crm_analytics', { p_days: Number(period) })) as AnalyticsData,
    [period],
  );

  const p = data?.period;
  const conversion = p && p.applications ? Math.round((p.converted / p.applications) * 100) : 0;
  const avgCheck = p && p.orders ? Math.round(p.revenue / p.orders) : 0;
  const chatShare = data && p?.applications ? Math.round(((data.applications_by_source.ai_chat ?? 0) / p.applications) * 100) : 0;

  return (
    <>
      <PageHeader
        title="Аналитика"
        subtitle={data ? `Период: с ${formatDate(data.since)} по сегодня (время Бишкека)` : 'Показатели по данным CRM'}
        actions={
          <Chips<Period>
            value={period}
            onChange={setPeriod}
            options={[{ value: '7', label: '7 дней' }, { value: '30', label: '30 дней' }, { value: '90', label: '90 дней' }, { value: '365', label: 'Год' }]}
          />
        }
      />

      {loading && !data ? <PageLoader /> : error && !data ? <ErrorBox error={error} onRetry={reload} /> : data && p && (
        <div className={loading ? 'is-loading' : ''}>
          <div className="stats stats--5">
            <Stat label="Заявок" value={p.applications} hint={`AI-чат: ${chatShare}%`} />
            <Stat label="Конверсия в заказ" value={`${conversion}%`} hint={`${p.converted} заявок → заказ`} />
            <Stat label="Заказов" value={p.orders} />
            <Stat label="Сумма заказов" value={money(p.revenue)} hint="без отменённых" tone="accent" />
            <Stat label="Средний чек" value={p.orders ? money(avgCheck) : '—'} />
          </div>

          <Card title="Заявки по дням и источникам">
            <DailyColumns
              title="Заявки по дням и источникам"
              data={data.daily}
              series={[
                { key: 'site', label: 'Сайт', color: SERIES_COLORS.site },
                { key: 'chat', label: 'AI-чат', color: SERIES_COLORS.chat },
                { key: 'manual', label: 'Вручную', color: SERIES_COLORS.manual },
              ]}
            />
          </Card>

          <Card title="Сумма новых заказов по дням">
            <DailyColumns
              title="Сумма заказов по дням"
              data={data.daily}
              series={[{ key: 'revenue', label: 'Сумма', color: SERIES_COLORS.site }]}
              format={(v) => money(v)}
            />
          </Card>

          <div className="grid grid--2">
            <Card title="Заявки по статусам">
              <BarList
                color={SERIES_COLORS.site}
                items={(Object.keys(APPLICATION_STATUS) as ApplicationStatus[]).map((s) => ({ label: APPLICATION_STATUS[s].label, value: data.applications_by_status[s] ?? 0 }))}
              />
            </Card>
            <Card title="Заявки по источникам">
              <BarList
                color={SERIES_COLORS.site}
                items={(Object.keys(APPLICATION_SOURCE) as ApplicationSource[]).map((s) => ({ label: APPLICATION_SOURCE[s], value: data.applications_by_source[s] ?? 0 }))}
              />
            </Card>
            <Card title="Самые востребованные товары">
              <BarList color={SERIES_COLORS.site} items={data.top_products.map((t) => ({ label: t.name, value: t.requests }))} />
            </Card>
            <Card title="Заказы по статусам (все)">
              <BarList
                color={SERIES_COLORS.site}
                items={(Object.keys(ORDER_STATUS) as OrderStatus[]).map((s) => ({ label: ORDER_STATUS[s].label, value: data.orders_by_status[s] ?? 0 }))}
              />
            </Card>
          </div>
          <p className="muted small">
            AI-диалогов за период: {p.chat_sessions}. Новых клиентов: {p.clients}.
            {' '}Токены OpenAI за период: {(p.ai_input_tokens ?? 0).toLocaleString('ru-RU')} входных, {(p.ai_output_tokens ?? 0).toLocaleString('ru-RU')} выходных.
          </p>
        </div>
      )}
    </>
  );
}
