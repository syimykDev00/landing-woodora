// Графики на чистом SVG/HTML по правилам: тонкие столбцы (≤ 24px), скругление 4px на конце данных,
// 2px зазор между сегментами, одна ось, легенда для ≥ 2 серий, подсказка при наведении,
// таблица значений для доступности. Текст — цветами текста, не цветом серии.
import { useMemo, useState } from 'react';

export interface Series { key: string; label: string; color: string }

const shortDay = (iso: string) => {
  const [, m, d] = iso.split('-');
  return `${d}.${m}`;
};

function niceMax(value: number) {
  if (value <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(value));
  const n = value / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

const compact = (v: number) => (v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1).replace('.0', '')} млн` : v >= 1000 ? `${Math.round(v / 1000)} тыс` : String(v));

// Столбчатая диаграмма по дням (одна или несколько серий — стопкой)
export function DailyColumns({ data, series, format = String, height = 220, title }: {
  data: Record<string, number | string>[];
  series: Series[];
  format?: (v: number) => string;
  height?: number;
  title: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const totals = data.map((d) => series.reduce((s, x) => s + Number(d[x.key] || 0), 0));
  const max = niceMax(Math.max(0, ...totals));
  const W = 640; const H = height; const padL = 44; const padB = 26; const padT = 10;
  const plotW = W - padL - 8; const plotH = H - padB - padT;
  const band = plotW / Math.max(1, data.length);
  const barW = Math.min(24, Math.max(3, band * 0.62));
  const y = (v: number) => padT + plotH - (v / max) * plotH;
  const labelEvery = Math.ceil(data.length / 8);
  const ticks = [0, max / 2, max];

  if (!data.length) return null;

  return (
    <figure className="chart">
      {series.length > 1 && (
        <figcaption className="legend">
          {series.map((s) => <span key={s.key} className="legend__item"><i style={{ background: s.color }} />{s.label}</span>)}
        </figcaption>
      )}
      <div className="chart__plot">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title} onMouseLeave={() => setHover(null)}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={padL} x2={W - 8} y1={y(t)} y2={y(t)} className="chart__grid" />
              <text x={padL - 8} y={y(t) + 4} textAnchor="end" className="chart__axis">{format === String ? t : compact(t)}</text>
            </g>
          ))}
          {data.map((d, i) => {
            const cx = padL + band * i + band / 2;
            let acc = 0;
            const visible = series.filter((s) => Number(d[s.key] || 0) > 0);
            return (
              <g key={String(d.day)}>
                {hover === i && <rect x={padL + band * i} y={padT} width={band} height={plotH} className="chart__hover" />}
                {visible.map((s, si) => {
                  const v = Number(d[s.key] || 0);
                  const top = y(acc + v);
                  const bottom = y(acc);
                  acc += v;
                  const isTop = si === visible.length - 1;
                  // 2px зазор между сегментами стопки
                  const h = Math.max(1, bottom - top - (si > 0 ? 2 : 0));
                  const r = isTop ? Math.min(4, barW / 2, h) : 0;
                  const x = cx - barW / 2;
                  const yTop = top;
                  const path = r
                    ? `M${x},${yTop + h} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + barW - r} Q${x + barW},${yTop} ${x + barW},${yTop + r} V${yTop + h} Z`
                    : `M${x},${yTop + h} V${yTop} H${x + barW} V${yTop + h} Z`;
                  return <path key={s.key} d={path} fill={s.color} />;
                })}
                {i % labelEvery === 0 && (
                  <text x={cx} y={H - 8} textAnchor="middle" className="chart__axis">{shortDay(String(d.day))}</text>
                )}
                {/* Область наведения шире столбца */}
                <rect x={padL + band * i} y={padT} width={band} height={plotH} fill="transparent" onMouseEnter={() => setHover(i)} />
              </g>
            );
          })}
          <line x1={padL} x2={W - 8} y1={y(0)} y2={y(0)} className="chart__baseline" />
        </svg>
        {hover != null && (
          <div className="chart__tooltip" style={{ left: `${((padL + band * hover + band / 2) / W) * 100}%` }}>
            <strong>{shortDay(String(data[hover].day))}</strong>
            {series.map((s) => (
              <span key={s.key}><i style={{ background: s.color }} />{s.label}: {format(Number(data[hover][s.key] || 0))}</span>
            ))}
            {series.length > 1 && <span className="chart__tooltip-total">Всего: {format(totals[hover])}</span>}
          </div>
        )}
      </div>
      <button type="button" className="link-btn chart__table-toggle" onClick={() => setShowTable((v) => !v)}>
        {showTable ? 'Скрыть таблицу' : 'Показать таблицей'}
      </button>
      {showTable && (
        <div className="table-wrap chart__table">
          <table className="table table--compact">
            <thead><tr><th>День</th>{series.map((s) => <th key={s.key}>{s.label}</th>)}</tr></thead>
            <tbody>
              {data.map((d) => (
                <tr key={String(d.day)}><td>{shortDay(String(d.day))}</td>{series.map((s) => <td key={s.key}>{format(Number(d[s.key] || 0))}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </figure>
  );
}

// Горизонтальные полосы для разбивки по категориям (одна серия)
export function BarList({ items, color = '#b5651d', format = String }: {
  items: { label: string; value: number }[];
  color?: string;
  format?: (v: number) => string;
}) {
  const max = useMemo(() => Math.max(1, ...items.map((i) => i.value)), [items]);
  if (!items.length) return <p className="muted">Нет данных за период</p>;
  return (
    <ul className="barlist">
      {items.map((item) => (
        <li key={item.label} className="barlist__row" title={`${item.label}: ${format(item.value)}`}>
          <span className="barlist__label">{item.label}</span>
          <span className="barlist__track">
            <span className="barlist__bar" style={{ width: `${Math.max(2, (item.value / max) * 100)}%`, background: color }} />
          </span>
          <span className="barlist__value">{format(item.value)}</span>
        </li>
      ))}
    </ul>
  );
}
