// Hand-drawn SVG so the charts carry the product's own identity. Each follows the same
// rules: one axis, thin marks, a legend for two series, and a hover layer.
import { useState } from 'react';
import { compact, money, monthLabel, shortDate } from './lib/format';

const BLUE = 'var(--series-1)';
const SKY = 'var(--series-2)';

interface TideDay {
  date: string;
  billed: number;
  collected: number;
  forecastBilled: number;
  forecastCash: number;
  count: number;
}

function niceMax(value: number) {
  if (value <= 0) return 100;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 1.5, 2, 3, 5, 7.5, 10].find((m) => m * magnitude >= value) ?? 10;
  return step * magnitude;
}

/**
 * The tide chart. Bars are money billed, the area is money collected, and the magenta
 * line is today. Everything right of the line is what the contracts say comes next.
 */
export function TideChart({ days, today, onPick }: { days: TideDay[]; today: string; onPick?: (date: string) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 1100, H = 280, L = 62, R = 8, T = 14, B = 26;
  const plotW = W - L - R, plotH = H - T - B;
  const peak = niceMax(Math.max(...days.map((d) => Math.max(d.billed, d.forecastBilled, d.collected, d.forecastCash)), 1));
  const step = plotW / days.length;
  const x = (i: number) => L + i * step;
  const y = (v: number) => T + plotH - (v / peak) * plotH;
  const barW = Math.max(3, step - 2);
  const todayIndex = days.findIndex((d) => d.date === today);

  const cash = days.map((d) => d.collected + d.forecastCash);
  const areaTo = (end: number, start = 0) => {
    const points = cash.slice(start, end + 1).map((v, i) => `${x(start + i) + step / 2},${y(v)}`);
    return `M${x(start) + step / 2},${y(0)} L${points.join(' L')} L${x(end) + step / 2},${y(0)} Z`;
  };

  const ticks = [0, 0.5, 1].map((f) => peak * f);
  const hovered = hover !== null ? days[hover] : null;

  return (
    <div>
      <div className="legend" style={{ marginBottom: 8 }}>
        <span><i style={{ background: BLUE }} />Billed</span>
        <span><i style={{ background: SKY, opacity: 0.55 }} />Cash collected</span>
        <span><i style={{ background: 'repeating-linear-gradient(45deg, #dcebf2 0 2px, #17608f 2px 4px)' }} />Forecast from live contracts</span>
      </div>
      <div className="tide" onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Daily money billed and collected, with a forecast after today">
          <defs>
            <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" fill="#dcebf2" />
              <line x1="0" y1="0" x2="0" y2="6" stroke="#17608f" strokeWidth="1.8" opacity="0.7" />
            </pattern>
          </defs>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth="1" />
              <text x={L - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fontFamily="var(--mono)" fill="var(--ink-3)">{compact(t)}</text>
            </g>
          ))}
          <path d={areaTo(Math.max(todayIndex, 0))} fill={SKY} opacity="0.32" />
          {todayIndex < days.length - 1 && <path d={areaTo(days.length - 1, Math.max(todayIndex, 0))} fill={SKY} opacity="0.14" />}

          {days.map((d, i) => {
            const v = d.billed + d.forecastBilled;
            if (v <= 0) return null;
            const top = y(v);
            const h = Math.max(2, y(0) - top);
            const future = d.date > today;
            return <rect key={d.date} x={x(i) + (step - barW) / 2} y={y(0) - h} width={barW} height={h} rx={Math.min(3, barW / 2)} fill={future ? 'url(#hatch)' : BLUE} />;
          })}

          {todayIndex >= 0 && (
            <g>
              <line x1={x(todayIndex) + step / 2} x2={x(todayIndex) + step / 2} y1={T - 8} y2={y(0) + 4} stroke="var(--oxide)" strokeWidth="3" />
              <text x={x(todayIndex) + step / 2 + 7} y={T + 1} fontSize="17" fontWeight="800" fontFamily="var(--display)" letterSpacing="0.05em" fill="var(--oxide-deep)">TODAY</text>
            </g>
          )}

          {days.map((d, i) => (i % 7 === 0 ? (
            <text key={d.date} x={x(i) + step / 2} y={H - 8} textAnchor="middle" fontSize="11" fill="var(--ink-3)">{shortDate(d.date)}</text>
          ) : null))}
          <line x1={L} x2={W - R} y1={y(0)} y2={y(0)} stroke="var(--line-strong)" />

          {hover !== null && <rect x={x(hover)} y={T} width={step} height={plotH} fill="var(--ink)" opacity="0.06" />}
          {days.map((d, i) => (
            <rect key={d.date} x={x(i)} y={T} width={step} height={plotH + B} fill="transparent"
              style={{ cursor: onPick ? 'pointer' : 'default' }}
              onMouseEnter={() => setHover(i)} onClick={() => onPick?.(d.date)} />
          ))}
        </svg>
        {hovered && hover !== null && (
          <div className="chart-tip" style={{ left: `${((x(hover) + step / 2) / W) * 100}%`, top: 34 }}>
            <div className="strong">{shortDate(hovered.date)}{hovered.date > today ? ', forecast' : ''}</div>
            <div className="mono">Billed {money(hovered.billed + hovered.forecastBilled)}{hovered.count ? ` (${hovered.count})` : ''}</div>
            <div className="mono">Cash {money(hovered.collected + hovered.forecastCash)}</div>
          </div>
        )}
      </div>
    </div>
  );
}

export function MrrLine({ series }: { series: { month: string; mrr: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 560, H = 220, L = 58, R = 12, T = 12, B = 24;
  const peak = niceMax(Math.max(...series.map((s) => s.mrr), 1));
  const x = (i: number) => L + (i / Math.max(1, series.length - 1)) * (W - L - R);
  const y = (v: number) => T + (H - T - B) - (v / peak) * (H - T - B);
  const path = series.map((s, i) => `${x(i)},${y(s.mrr)}`).join(' L');
  const last = series[series.length - 1];
  return (
    <div className="tide" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Monthly recurring revenue over twelve months">
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={L} x2={W - R} y1={y(peak * f)} y2={y(peak * f)} stroke="var(--line)" />
            <text x={L - 8} y={y(peak * f) + 4} textAnchor="end" fontSize="11" fontFamily="var(--mono)" fill="var(--ink-3)">{compact(peak * f)}</text>
          </g>
        ))}
        <path d={`M${L},${y(0)} L${path} L${x(series.length - 1)},${y(0)} Z`} fill={SKY} opacity="0.16" />
        <path d={`M${path}`} fill="none" stroke={BLUE} strokeWidth="2" strokeLinejoin="round" />
        {series.map((s, i) => (i % 2 === 0 ? <text key={s.month} x={x(i)} y={H - 6} textAnchor="middle" fontSize="11" fill="var(--ink-3)">{monthLabel(s.month)}</text> : null))}
        {last && <circle cx={x(series.length - 1)} cy={y(last.mrr)} r="4" fill={BLUE} stroke="#fff" strokeWidth="2" />}
        {hover !== null && <circle cx={x(hover)} cy={y(series[hover].mrr)} r="5" fill={BLUE} stroke="#fff" strokeWidth="2" />}
        {series.map((s, i) => (
          <rect key={s.month} x={x(i) - (W - L - R) / series.length / 2} y={T} width={(W - L - R) / series.length} height={H - T - B}
            fill="transparent" onMouseEnter={() => setHover(i)} />
        ))}
      </svg>
      {hover !== null && (
        <div className="chart-tip" style={{ left: `${(x(hover) / W) * 100}%`, top: 40 }}>
          <div className="strong">{monthLabel(series[hover].month)}</div>
          <div className="mono">MRR {money(series[hover].mrr)}</div>
        </div>
      )}
    </div>
  );
}

export function PairedBars({ series }: { series: { month: string; invoiced: number; collected: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 560, H = 220, L = 58, R = 8, T = 12, B = 24;
  const peak = niceMax(Math.max(...series.flatMap((s) => [s.invoiced, s.collected]), 1));
  const slot = (W - L - R) / series.length;
  const y = (v: number) => T + (H - T - B) - (v / peak) * (H - T - B);
  const barW = Math.max(4, (slot - 8) / 2 - 1);
  return (
    <div>
      <div className="legend" style={{ marginBottom: 6 }}>
        <span><i style={{ background: BLUE }} />Invoiced</span>
        <span><i style={{ background: SKY }} />Collected</span>
      </div>
      <div className="tide" onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Money invoiced and collected by month">
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line x1={L} x2={W - R} y1={y(peak * f)} y2={y(peak * f)} stroke="var(--line)" />
              <text x={L - 8} y={y(peak * f) + 4} textAnchor="end" fontSize="11" fontFamily="var(--mono)" fill="var(--ink-3)">{compact(peak * f)}</text>
            </g>
          ))}
          {hover !== null && <rect x={L + hover * slot} y={T} width={slot} height={H - T - B} fill="var(--ink)" opacity="0.05" />}
          {series.map((s, i) => {
            const x0 = L + i * slot + (slot - barW * 2 - 2) / 2;
            const h1 = Math.max(1, y(0) - y(s.invoiced));
            const h2 = Math.max(1, y(0) - y(s.collected));
            return (
              <g key={s.month}>
                <rect x={x0} y={y(0) - h1} width={barW} height={h1} rx="2" fill={BLUE} />
                <rect x={x0 + barW + 2} y={y(0) - h2} width={barW} height={h2} rx="2" fill={SKY} />
                {i % 2 === 0 && <text x={L + i * slot + slot / 2} y={H - 6} textAnchor="middle" fontSize="11" fill="var(--ink-3)">{monthLabel(s.month)}</text>}
                <rect x={L + i * slot} y={T} width={slot} height={H - T - B} fill="transparent" onMouseEnter={() => setHover(i)} />
              </g>
            );
          })}
        </svg>
        {hover !== null && (
          <div className="chart-tip" style={{ left: `${((L + hover * slot + slot / 2) / W) * 100}%`, top: 40 }}>
            <div className="strong">{monthLabel(series[hover].month)}</div>
            <div className="mono">Invoiced {money(series[hover].invoiced)}</div>
            <div className="mono">Collected {money(series[hover].collected)}</div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Opening MRR, every movement, closing MRR. It must add up, and on screen you can see that it does. */
export function Bridge({ opening, moves, closing }: { opening: number; moves: { kind: string; amount: number; events: number }[]; closing: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const LABELS: Record<string, string> = { new: 'New', expansion: 'Expansion', reactivation: 'Reactivated', contraction: 'Contraction', churn: 'Churn' };
  const steps: { label: string; from: number; to: number; kind: 'total' | 'up' | 'down'; amount: number; events?: number }[] = [
    { label: 'Opening', from: 0, to: opening, kind: 'total', amount: opening },
  ];
  let running = opening;
  for (const m of moves) {
    steps.push({ label: LABELS[m.kind], from: running, to: running + m.amount, kind: m.amount >= 0 ? 'up' : 'down', amount: m.amount, events: m.events });
    running += m.amount;
  }
  steps.push({ label: 'Closing', from: 0, to: closing, kind: 'total', amount: closing });

  const W = 620, H = 230, L = 8, R = 8, T = 22, B = 26;
  const values = steps.flatMap((s) => [s.from, s.to]);
  const spread = Math.max(...values) - Math.min(...steps.filter((s) => s.kind !== 'total').flatMap((s) => [s.from, s.to]), Math.max(...values));
  // Zoom the axis in, otherwise small movements vanish beside the opening total.
  const floor = Math.max(0, Math.min(...steps.filter((s) => s.kind !== 'total').flatMap((s) => [s.from, s.to])) - spread * 2.2);
  const top = Math.max(...values) * 1.002;
  const y = (v: number) => T + (H - T - B) - ((Math.max(v, floor) - floor) / Math.max(1, top - floor)) * (H - T - B);
  const slot = (W - L - R) / steps.length;
  const barW = slot - 16;
  const fill = (k: string) => (k === 'total' ? BLUE : k === 'up' ? SKY : '#c2571a');

  return (
    <div className="tide" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Bridge from opening to closing recurring revenue">
        <line x1={L} x2={W - R} y1={y(floor)} y2={y(floor)} stroke="var(--line-strong)" />
        {steps.map((s, i) => {
          const a = y(s.from), b = y(s.to);
          const yTop = Math.min(a, b), h = Math.max(2, Math.abs(a - b));
          const x0 = L + i * slot + 8;
          return (
            <g key={s.label}>
              <rect x={x0} y={s.kind === 'total' ? y(s.to) : yTop} width={barW} height={s.kind === 'total' ? y(floor) - y(s.to) : h} rx="3" fill={fill(s.kind)} />
              {i < steps.length - 1 && <line x1={x0 + barW} x2={x0 + slot} y1={y(s.to)} y2={y(s.to)} stroke="var(--ink-3)" strokeDasharray="2 2" />}
              <text x={x0 + barW / 2} y={yTop - 6} textAnchor="middle" fontSize="11" fontFamily="var(--mono)" fill="var(--ink)">{s.kind === 'total' ? compact(s.amount) : `${s.amount >= 0 ? '+' : ''}${compact(s.amount)}`}</text>
              <text x={x0 + barW / 2} y={H - 8} textAnchor="middle" fontSize="11" fill="var(--ink-2)">{s.label}</text>
              <rect x={L + i * slot} y={0} width={slot} height={H} fill="transparent" onMouseEnter={() => setHover(i)} />
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <div className="chart-tip" style={{ left: `${((L + hover * slot + slot / 2) / W) * 100}%`, top: 40 }}>
          <div className="strong">{steps[hover].label}</div>
          <div className="mono">{money(steps[hover].amount)}</div>
          {steps[hover].events !== undefined && <div>{steps[hover].events} changes</div>}
        </div>
      )}
    </div>
  );
}

export function HBars({ rows, format = money }: { rows: { label: string; value: number; tone?: string; href?: string }[]; format?: (n: number) => string }) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <div className="col gap-6">
      {rows.map((r) => (
        <div key={r.label}>
          <div className="row between small"><span>{r.label}</span><span className="mono">{format(r.value)}</span></div>
          <div className="progress" style={{ height: 6, marginTop: 3 }}>
            <div style={{ width: `${(r.value / max) * 100}%`, background: r.tone ?? BLUE }} />
          </div>
        </div>
      ))}
    </div>
  );
}
