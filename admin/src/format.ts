import type { ApplicationSource, ApplicationStatus, ClientSource, KbKind, OrderStatus, Room } from './types';

export const money = (value: number | null | undefined) =>
  value == null ? '—' : `${Number(value).toLocaleString('ru-RU')} сом`;

const dateTime = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Asia/Bishkek', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});
const dateOnly = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Bishkek', day: '2-digit', month: '2-digit', year: 'numeric' });

export const formatDateTime = (value: string | null | undefined) => (value ? dateTime.format(new Date(value)) : '—');
export const formatDate = (value: string | null | undefined) => (value ? dateOnly.format(new Date(value)) : '—');

export function relative(value: string) {
  const diff = (Date.now() - new Date(value).getTime()) / 1000;
  if (diff < 60) return 'только что';
  if (diff < 3600) return `${Math.floor(diff / 60)} мин назад`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} ч назад`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} дн назад`;
  return formatDate(value);
}

export type Tone = 'neutral' | 'info' | 'warning' | 'success' | 'danger' | 'accent';

export const APPLICATION_STATUS: Record<ApplicationStatus, { label: string; tone: Tone }> = {
  new: { label: 'Новая', tone: 'info' },
  in_progress: { label: 'В работе', tone: 'warning' },
  converted: { label: 'Заказ оформлен', tone: 'success' },
  rejected: { label: 'Отказ', tone: 'neutral' },
};

export const APPLICATION_SOURCE: Record<ApplicationSource, string> = {
  site: 'Форма сайта',
  modal: 'Кнопка «Заказать»',
  chat: 'AI-чат',
  manual: 'Вручную',
};

export const ORDER_STATUS: Record<OrderStatus, { label: string; tone: Tone }> = {
  new: { label: 'Новый', tone: 'info' },
  confirmed: { label: 'Подтверждён', tone: 'accent' },
  in_production: { label: 'В производстве', tone: 'warning' },
  ready: { label: 'Готов', tone: 'accent' },
  delivered: { label: 'Доставлен', tone: 'success' },
  completed: { label: 'Завершён', tone: 'success' },
  cancelled: { label: 'Отменён', tone: 'neutral' },
};

export const CLIENT_SOURCE: Record<ClientSource, string> = {
  site: 'Сайт', chat: 'AI-чат', manual: 'Вручную', phone: 'Звонок', showroom: 'Шоурум', other: 'Другое',
};

export const ROOMS: Record<Room, string> = {
  living: 'Гостиная', bedroom: 'Спальня', dining: 'Столовая', office: 'Кабинет', decor: 'Декор',
};

export const KB_KIND: Record<KbKind, string> = {
  company: 'О компании', faq: 'Вопрос-ответ', product: 'Товары', service: 'Услуги',
  policy: 'Условия', article: 'Статья', file: 'Файл',
};

// Цвета серий графиков (проверены валидатором палитры: CVD и контраст)
export const SERIES_COLORS = { site: '#b5651d', chat: '#008a9e', manual: '#7a4fb0' } as const;

export const digits = (value: string | null | undefined) => (value || '').replace(/\D/g, '');

export function matchesQuery(query: string, ...fields: (string | number | null | undefined)[]) {
  const q = query.trim().toLowerCase().replace(/ё/g, 'е');
  if (!q) return true;
  const hay = fields.map((f) => String(f ?? '')).join(' ').toLowerCase().replace(/ё/g, 'е');
  const qDigits = digits(q);
  return q.split(/\s+/).every((word) => hay.includes(word)) || (qDigits.length >= 3 && digits(hay).includes(qDigits));
}
