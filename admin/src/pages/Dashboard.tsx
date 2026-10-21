import { supabase, unwrap } from '../supabase';
import { Badge, Button, Card, Empty, ErrorBox, PageHeader, PageLoader, Stat, navigate, useAsync } from '../ui';
import { DailyColumns } from '../charts';
import { APPLICATION_SOURCE, APPLICATION_STATUS, ORDER_STATUS, SERIES_COLORS, money, relative } from '../format';
import type { Analytics, Application, Order } from '../types';

export function Dashboard() {
  const { data, error, loading, reload } = useAsync(async () => {
    const [analytics, applications, orders] = await Promise.all([
      supabase.rpc('crm_analytics', { p_days: 14 }),
      supabase.from('applications').select('*').order('created_at', { ascending: false }).limit(6),
      supabase.from('orders').select('*, clients(name,phone)').order('created_at', { ascending: false }).limit(5),
    ]);
    return {
      analytics: unwrap(analytics) as Analytics,
      applications: unwrap(applications) as Application[],
      orders: unwrap(orders) as Order[],
    };
  });

  if (loading && !data) return <PageLoader />;
  if (error && !data) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return null;
  const { analytics: a, applications, orders } = data;

  return (
    <>
      <PageHeader
        title="Обзор"
        subtitle="Ключевые показатели мастерской по данным CRM"
        actions={<>
          <Button onClick={() => navigate('applications', 'new')}>+ Заявка</Button>
          <Button variant="primary" onClick={() => navigate('orders', 'new')}>+ Заказ</Button>
        </>}
      />

      <div className="stats">
        <Stat label="Новые заявки" value={a.totals.applications_new} hint={`всего ${a.totals.applications}`} tone="accent" />
        <Stat label="Клиенты" value={a.totals.clients} hint={`+${a.period.clients} за 14 дней`} />
        <Stat label="Активные заказы" value={a.totals.orders_active} hint={`всего ${a.totals.orders}`} />
        <Stat label="Сумма заказов" value={money(a.totals.revenue)} hint={`${money(a.period.revenue)} за 14 дней`} />
      </div>

      <div className="grid grid--2-1">
        <Card title="Заявки за 14 дней" actions={<a className="link-btn" href="#/analytics">Аналитика →</a>}>
          <DailyColumns
            title="Заявки по дням и источникам"
            data={a.daily}
            series={[
              { key: 'site', label: 'Сайт', color: SERIES_COLORS.site },
              { key: 'chat', label: 'AI-чат', color: SERIES_COLORS.chat },
              { key: 'manual', label: 'Вручную', color: SERIES_COLORS.manual },
            ]}
          />
        </Card>
        <Card title="Быстрые действия">
          <div className="quick">
            <a className="quick__item" href="#/applications"><strong>{a.totals.applications_new}</strong> новых заявок ждут ответа</a>
            <a className="quick__item" href="#/chats"><strong>{a.period.chat_sessions}</strong> AI-диалогов за 14 дней</a>
            <a className="quick__item" href="#/products"><strong>{a.totals.products_active}</strong> товаров на сайте</a>
            <a className="quick__item" href="#/knowledge">Обновить базу знаний AI-агента</a>
          </div>
        </Card>
      </div>

      <div className="grid grid--2">
        <Card title="Последние заявки" actions={<a className="link-btn" href="#/applications">Все →</a>}>
          {applications.length ? (
            <ul className="feed">
              {applications.map((app) => (
                <li key={app.id}>
                  <a href={`#/applications/${app.id}`} className="feed__item">
                    <span className="feed__main">
                      <strong>{app.customer_name}</strong>
                      <span className="muted">{app.product_name || 'Консультация / на заказ'} · {APPLICATION_SOURCE[app.source]}</span>
                    </span>
                    <span className="feed__side">
                      <Badge tone={APPLICATION_STATUS[app.status].tone}>{APPLICATION_STATUS[app.status].label}</Badge>
                      <span className="muted small">{relative(app.created_at)}</span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          ) : <Empty title="Заявок пока нет" />}
        </Card>
        <Card title="Последние заказы" actions={<a className="link-btn" href="#/orders">Все →</a>}>
          {orders.length ? (
            <ul className="feed">
              {orders.map((o) => (
                <li key={o.id}>
                  <a href={`#/orders/${o.id}`} className="feed__item">
                    <span className="feed__main">
                      <strong>Заказ №{o.id} · {o.clients?.name}</strong>
                      <span className="muted">{money(o.total)}</span>
                    </span>
                    <span className="feed__side">
                      <Badge tone={ORDER_STATUS[o.status].tone}>{ORDER_STATUS[o.status].label}</Badge>
                      <span className="muted small">{relative(o.created_at)}</span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          ) : <Empty title="Заказов пока нет">Создайте заказ из заявки или вручную.</Empty>}
        </Card>
      </div>
    </>
  );
}
