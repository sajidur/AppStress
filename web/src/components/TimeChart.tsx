import { useLayoutEffect, useMemo, useRef, useState } from 'react';

export interface Point {
  x: number; // seconds since start
  y: number;
}

interface Props {
  title: string;
  unit: string;
  points: Point[];
  color: string; // CSS color / var
  format: (v: number) => string;
  height?: number;
}

const M = { top: 10, right: 12, bottom: 24, left: 48 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= v) return m * exp;
  return 10 * exp;
}

/** Axis ticks: integers stay integers, fractions keep up to 2 significant decimals. */
function fmtTick(v: number): string {
  if (Number.isInteger(v)) return v >= 10_000 ? `${v / 1000}k` : String(v);
  return String(Math.round(v * 100) / 100);
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

/** Single-series time chart: 2px line, recessive grid, crosshair + tooltip on hover. */
export function TimeChart({ title, unit, points, color, format, height = 180 }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const geo = useMemo(() => {
    const maxX = Math.max(10, ...points.map((p) => p.x));
    const maxY = niceMax(Math.max(0, ...points.map((p) => p.y)) * 1.05);
    const w = width - M.left - M.right;
    const h = height - M.top - M.bottom;
    const sx = (x: number) => M.left + (x / maxX) * w;
    const sy = (y: number) => M.top + h - (y / maxY) * h;
    const path = points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join('');
    const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxY);
    const xStep = niceMax(maxX / 6);
    const xTicks: number[] = [];
    for (let x = 0; x <= maxX + 0.001; x += xStep) xTicks.push(x);
    return { maxX, maxY, w, h, sx, sy, path, yTicks, xTicks };
  }, [points, width, height]);

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    if (!points.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * geo.maxX;
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(points[i].x - x) < Math.abs(points[best].x - x)) best = i;
    setHover(best);
  };

  const hp = hover !== null ? points[hover] : null;

  return (
    <figure className="card" style={{ margin: 0 }}>
      <figcaption className="card-header" style={{ padding: '10px 14px' }}>
        <h3>
          {title} <span className="faint" style={{ fontWeight: 400 }}>({unit})</span>
        </h3>
        {points.length > 0 && <span className="muted num">latest {format(points[points.length - 1].y)}</span>}
      </figcaption>
      <div className="chart" ref={ref} style={{ padding: '6px 8px 4px' }}>
        {points.length === 0 ? (
          <div className="faint" style={{ height, display: 'grid', placeItems: 'center' }}>
            Waiting for data…
          </div>
        ) : (
          <svg height={height} role="img" aria-label={`${title} over time`}>
            <g className="axis">
              {geo.yTicks.map((t) => (
                <g key={`y${t}`}>
                  <line className={t === 0 ? 'baseline' : 'gridline'} x1={M.left} x2={M.left + geo.w} y1={geo.sy(t)} y2={geo.sy(t)} />
                  <text x={M.left - 8} y={geo.sy(t) + 4} textAnchor="end">
                    {fmtTick(t)}
                  </text>
                </g>
              ))}
              {geo.xTicks.map((t) => (
                <text key={`x${t}`} x={geo.sx(t)} y={height - 6} textAnchor="middle">
                  {fmtTime(t)}
                </text>
              ))}
            </g>
            <path d={geo.path} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {hp && (
              <g>
                <line className="crosshair" x1={geo.sx(hp.x)} x2={geo.sx(hp.x)} y1={M.top} y2={M.top + geo.h} />
                <circle cx={geo.sx(hp.x)} cy={geo.sy(hp.y)} r={4.5} fill={color} stroke="var(--surface)" strokeWidth={2} />
              </g>
            )}
            <rect
              x={M.left}
              y={M.top}
              width={geo.w}
              height={geo.h}
              fill="transparent"
              onPointerMove={onMove}
              onPointerLeave={() => setHover(null)}
            />
          </svg>
        )}
        {hp && (
          <div
            className="tooltip"
            style={{
              left: Math.min(geo.sx(hp.x) + 16, width - 150),
              top: Math.max(0, geo.sy(hp.y) - 44),
            }}
          >
            <div className="faint">t = {fmtTime(hp.x)}</div>
            <div className="tt-value">
              {format(hp.y)} {unit}
            </div>
          </div>
        )}
      </div>
    </figure>
  );
}
