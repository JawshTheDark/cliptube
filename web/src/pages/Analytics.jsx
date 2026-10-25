import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useTitle } from '../auth.jsx';
import { Icon } from '../components/Icons.jsx';
import { compact, formatDuration } from '../util.js';

const hours = (s) => (s >= 3600 ? `${(s / 3600).toFixed(1)} h` : s >= 60 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`);
const niceMax = (v) => {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / p) * p;
};

/** Single-series column chart over days: thin bars from one baseline, rounded at the data end, hover tooltip. */
function DailyBars({ data, value, format, label }) {
  const [hover, setHover] = useState(null);
  const W = 640;
  const H = 180;
  const pad = { l: 36, r: 8, t: 8, b: 22 };
  const max = niceMax(Math.max(0, ...data.map(value)));
  const band = (W - pad.l - pad.r) / data.length;
  const bw = Math.min(24, Math.max(2, band - 2));
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const ticks = [0, max / 2, max];
  const bar = (x, top, bottom) => {
    const h = bottom - top;
    if (h <= 0) return '';
    const r = Math.min(4, h, bw / 2);
    return `M${x},${bottom} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${bottom} Z`;
  };
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="chart-grid" />
            <text x={pad.l - 6} y={y(t) + 4} className="chart-tick" textAnchor="end">
              {format === 'time' ? hours(t) : compact(t)}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const x = pad.l + i * band + (band - bw) / 2;
          return (
            <g key={d.day} onMouseEnter={() => setHover(i)}>
              <rect x={pad.l + i * band} y={pad.t} width={band} height={H - pad.t - pad.b} fill="transparent" />
              <path d={bar(x, y(value(d)), y(0))} className={`chart-bar ${hover === i ? 'hover' : ''}`} />
              {(i === 0 || i === data.length - 1 || i % 7 === 0) && (
                <text x={x + bw / 2} y={H - 6} className="chart-tick" textAnchor="middle">
                  {d.day.slice(5)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <div className="chart-tip" style={{ left: `${((pad.l + (hover + 0.5) * band) / W) * 100}%` }}>
          <b>{format === 'time' ? hours(value(data[hover])) : compact(value(data[hover]))}</b>
          <span>{data[hover].day}</span>
        </div>
      )}
    </div>
  );
}

/** Retention: share of viewers still watching at each point of the video. Crosshair and tooltip on hover. */
function RetentionLine({ points, duration }) {
  const [hover, setHover] = useState(null);
  const W = 640;
  const H = 180;
  const pad = { l: 40, r: 10, t: 10, b: 22 };
  const x = (at) => pad.l + ((W - pad.l - pad.r) * at) / 100;
  const y = (s) => pad.t + (H - pad.t - pad.b) * (1 - s);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.at).toFixed(1)},${y(p.share).toFixed(1)}`).join(' ');
  const onMove = (e) => {
    const box = e.currentTarget.getBoundingClientRect();
    const at = (((e.clientX - box.left) / box.width) * W - pad.l) / (W - pad.l - pad.r);
    const i = Math.max(0, Math.min(points.length - 1, Math.round(at * (points.length - 1))));
    setHover(i);
  };
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Share of viewers still watching through the video" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {[0, 0.5, 1].map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="chart-grid" />
            <text x={pad.l - 6} y={y(t) + 4} className="chart-tick" textAnchor="end">
              {Math.round(t * 100)}%
            </text>
          </g>
        ))}
        {[0, 50, 100].map((at) => (
          <text key={at} x={x(at)} y={H - 6} className="chart-tick" textAnchor={at === 0 ? 'start' : at === 100 ? 'end' : 'middle'}>
            {formatDuration(((duration || 0) * at) / 100)}
          </text>
        ))}
        <path d={d} className="chart-line" />
        {hover !== null && (
          <>
            <line x1={x(points[hover].at)} x2={x(points[hover].at)} y1={pad.t} y2={H - pad.b} className="chart-cross" />
            <circle cx={x(points[hover].at)} cy={y(points[hover].share)} r={4.5} className="chart-dot" />
          </>
        )}
      </svg>
      {hover !== null && (
        <div className="chart-tip" style={{ left: `${(x(points[hover].at) / W) * 100}%` }}>
          <b>{Math.round(points[hover].share * 100)}% still watching</b>
          <span>at {formatDuration(((duration || 0) * points[hover].at) / 100)}</span>
        </div>
      )}
    </div>
  );
}

const SOURCE_LABELS = {
  direct: 'Direct or app',
  'site:home': 'Home on this site',
  'site:trending': 'Trending',
  'site:search': 'Search',
  'site:channel': 'Your channel',
  'site:watch': 'Other videos (related)',
  'site:subscriptions': 'Subscriptions feed',
  'site:network': 'Network page',
  'site:game': 'Game pages',
  'site:history': 'Watch history',
  'site:liked': 'Liked videos',
  'site:notifications': 'Notifications',
  'site:studio': 'Studio',
  'site:compare': 'Compare',
  'site:other': 'Elsewhere on this site',
};

export default function Analytics() {
  const { id } = useParams();
  const [days, setDays] = useState(28);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [table, setTable] = useState(false);
  useTitle(data?.video ? `Analytics · ${data.video.title}` : 'Analytics');
  useEffect(() => {
    setData(null);
    api(`/studio/analytics?days=${days}${id ? `&video=${encodeURIComponent(id)}` : ''}`)
      .then(setData)
      .catch(setError);
  }, [id, days]);
  const avg = useMemo(() => (data && data.totals.views ? data.totals.watch_seconds / data.totals.views : 0), [data]);
  if (error) return <div className="page page-narrow error">{error.message}</div>;
  if (!data) return <div className="spinner" />;
  const maxRef = Math.max(1, ...data.referrers.map((r) => r.views));
  return (
    <div className="page page-wide analytics">
      <div className="page-head">
        <h1>
          <Icon name="chart" /> {data.video ? data.video.title : 'Channel analytics'}
        </h1>
        <div className="row-actions">
          <select className="select select-inline" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Time range">
            <option value={7}>Last 7 days</option>
            <option value={28}>Last 28 days</option>
            <option value={90}>Last 90 days</option>
            <option value={365}>Last year</option>
          </select>
          <button className="btn btn-ghost" onClick={() => setTable((t) => !t)}>
            {table ? 'Show charts' : 'Show as table'}
          </button>
          <Link to={data.video ? `/watch/${data.video.id}` : '/studio'} className="btn btn-ghost">
            <Icon name="back" /> {data.video ? 'Video' : 'Studio'}
          </Link>
        </div>
      </div>
      <p className="page-sub flush">Counts only: nothing here identifies who watched. Viewers who aren't signed in are included.</p>

      <div className="stats">
        <div className="stat">
          <div className="n">{compact(data.totals.views)}</div>
          <div className="l">Views</div>
        </div>
        <div className="stat">
          <div className="n">{hours(data.totals.watch_seconds)}</div>
          <div className="l">Watch time</div>
        </div>
        <div className="stat">
          <div className="n">{avg ? formatDuration(avg) : '—'}</div>
          <div className="l">Average view</div>
        </div>
      </div>

      {table ? (
        <section className="card-panel">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Day</th>
                  <th className="num">Views</th>
                  <th className="num">Watch time</th>
                </tr>
              </thead>
              <tbody>
                {[...data.daily].reverse().map((d) => (
                  <tr key={d.day}>
                    <td>{d.day}</td>
                    <td className="num">{d.views}</td>
                    <td className="num">{hours(d.watch_seconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        <div className="admin-grid">
          <section className="card-panel">
            <h2>Views per day</h2>
            <DailyBars data={data.daily} value={(d) => d.views} label="Views per day" />
          </section>
          <section className="card-panel">
            <h2>Watch time per day</h2>
            <DailyBars data={data.daily} value={(d) => d.watch_seconds} format="time" label="Watch time per day" />
          </section>
          {data.video && (
            <section className="card-panel">
              <h2>Audience retention</h2>
              {data.retention.length ? <RetentionLine points={data.retention} duration={data.video.duration} /> : <p className="muted">Not enough plays yet.</p>}
            </section>
          )}
        </div>
      )}

      <div className="admin-grid">
        <section className="card-panel">
          <h2>Where views came from</h2>
          {data.referrers.length === 0 ? (
            <p className="muted">No views in this period.</p>
          ) : (
            <div className="ref-list">
              {data.referrers.map((r) => (
                <div key={r.source} className="ref-row">
                  <span className="ref-name">{SOURCE_LABELS[r.source] || r.source}</span>
                  <span className="ref-bar">
                    <span style={{ width: `${(r.views / maxRef) * 100}%` }} />
                  </span>
                  <span className="ref-n">{compact(r.views)}</span>
                </div>
              ))}
            </div>
          )}
        </section>
        {!data.video && data.top.length > 0 && (
          <section className="card-panel">
            <h2>Top videos</h2>
            <div className="table-wrap">
              <table className="table">
                <tbody>
                  {data.top.map((v) => (
                    <tr key={v.id}>
                      <td>
                        <Link to={`/studio/analytics/${v.id}`}>{v.title}</Link>
                      </td>
                      <td className="num">{compact(v.views)} views</td>
                      <td className="num">{hours(v.watch_seconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
