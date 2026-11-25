// Tilkynningar: láta vita þegar besta verð vöru fer undir mörk notandans.
//   1. Markverð:  besta verð <= targetPrice
//   2. Prósenta:  besta verð <= miðgildi síðustu 30 daga × (1 − pct/100)   (sjálfgefið 25%)
// Tilkynnt er aftur ef verðið lækkar enn meira. Þögn á nóttunni (haldið til morguns).
import { readJson, hash, nowIso } from './util.js';

const DAY = 864e5;
export const DEFAULTS = { enabled: true, defaultPct: 25, quietFrom: 23, quietTo: 7, windowDays: 30 };

export const kr = (n) => `${Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')} kr.`;

/** Besta verð sem kaupandi getur fengið á hverjum tíma (ekki markaðstorg, ekki uppselt núna, ekki villa). */
export function bestSeries(product, hist, offerRecs) {
  const parts = [];
  for (const o of product.offers || []) {
    if (o.removed) continue;
    const key = hash(product.id + '|' + o.url);
    const rec = offerRecs[key];
    if (!rec || rec.marketplace || rec.available === false || rec.error || rec.current == null) continue;
    const pts = (hist[key] || [])
      .map(([t, v]) => [Date.parse(t), v])
      .filter(([t, v]) => t && v)
      .sort((a, b) => a[0] - b[0]);
    if (pts.length) parts.push({ pts, url: o.url, rec });
  }
  if (!parts.length) return null;
  const times = [...new Set(parts.flatMap((s) => s.pts.map(([t]) => t)))].sort((a, b) => a - b);
  const best = [];
  for (const t of times) {
    const vals = parts.map((s) => s.pts.filter(([ts]) => ts <= t).at(-1)?.[1]).filter((v) => v != null);
    const v = Math.min(...vals);
    if (!best.length || best.at(-1)[1] !== v) best.push([t, v]);
  }
  // Hver býður núna lægsta verðið?
  const now = parts.map((s) => ({ s, v: s.rec.current })).sort((a, b) => a.v - b.v)[0];
  return { pts: best, current: now.v, url: now.s.url, store: now.s.rec.storeName || '', rec: now.s.rec, since: times[0] };
}

/** Tímavegið miðgildi skreflínu á [from, to]. */
export function weightedMedian(pts, from, to) {
  const segs = [];
  for (let i = 0; i < pts.length; i++) {
    const a = Math.max(pts[i][0], from);
    const b = Math.min(i + 1 < pts.length ? pts[i + 1][0] : to, to);
    if (b > a) segs.push([pts[i][1], b - a]);
  }
  if (!segs.length) return pts.at(-1)?.[1] ?? null;
  segs.sort((x, y) => x[0] - y[0]);
  const total = segs.reduce((s, [, w]) => s + w, 0);
  let acc = 0;
  for (const [v, w] of segs) {
    acc += w;
    if (acc >= total / 2) return v;
  }
  return segs.at(-1)[0];
}

export function inQuietHours(settings, date = new Date()) {
  const h = date.getUTCHours(); // Ísland er á UTC allt árið
  const { quietFrom: a, quietTo: b } = settings;
  if (a == null || b == null || a === b) return false;
  return a < b ? h >= a && h < b : h >= a || h < b;
}

/** Hefur varan uppfyllt reglu núna? */
export function evaluate(product, best, settings, now = Date.now()) {
  const cur = best.current;
  const pct = product.alertPct == null || product.alertPct === '' ? settings.defaultPct : Number(product.alertPct);
  const baseline = weightedMedian(best.pts, now - settings.windowDays * DAY, now);
  const reasons = [];
  if (product.targetPrice && cur <= product.targetPrice) reasons.push({ type: 'verð', target: product.targetPrice });
  if (pct > 0 && baseline && cur <= baseline * (1 - pct / 100)) {
    reasons.push({ type: 'prósenta', pct, baseline, drop: Math.round((1 - cur / baseline) * 1000) / 10 });
  }
  const days = Math.max(1, Math.round((now - best.since) / DAY));
  return { productId: product.id, name: product.name, price: cur, store: best.store, url: best.url, baseline, reasons, days, suspect: !!best.rec.flags?.some((f) => f.type === 'lestur') };
}

export function describe(ev) {
  const parts = ev.reasons.map((r) =>
    r.type === 'verð' ? `undir markverði (${kr(r.target)})` : `${String(r.drop).replace('.', ',')}% undir miðgildi síðustu ${Math.min(30, ev.days)} daga (${kr(r.baseline)})`
  );
  return `${kr(ev.price)} hjá ${ev.store || 'verslun'} – ${parts.join(' og ')}${ev.suspect ? ' ⚠ gæti verið villa í lestri, athugaðu síðuna' : ''}`;
}

/** Sendir tilkynningu með ntfy (https://ntfy.sh). Rásin er leynilegt heiti í NTFY_TOPIC. */
export async function sendNtfy({ title, message, click }, env = process.env) {
  const topic = env.NTFY_TOPIC;
  if (!topic) return { sent: false, reason: 'Engin tilkynningarás er stillt (NTFY_TOPIC vantar).' };
  const server = (env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
  try {
    const res = await fetch(server, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic, title, message, click, tags: ['chart_with_downwards_trend'], priority: 3 }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return { sent: false, retry: true, reason: `ntfy svaraði ${res.status}` };
    return { sent: true };
  } catch (e) {
    return { sent: false, retry: true, reason: `Gat ekki sent: ${e.message}` };
  }
}

/**
 * Fer yfir allar vörur. Skilar { events, summary } og breytir state.alerts / state.pendingAlerts.
 * `send` má skipta út í prófum.
 */
export async function runAlerts({ products, prices, state, settings: userSettings, send = sendNtfy, now = new Date(), log = console.log, loadHistory = (id) => readJson(`history/${id}.json`, {}) }) {
  const settings = { ...DEFAULTS, ...(userSettings || {}) };
  state.alerts ||= {};
  state.pendingAlerts ||= [];
  if (!settings.enabled) return { events: [] };

  const triggered = [];
  const byId = new Map();
  for (const p of products) {
    if (p.paused || p.alertsOff) {
      delete state.alerts[p.id];
      continue;
    }
    const hist = await loadHistory(p.id);
    const best = bestSeries(p, hist, prices.offers || {});
    if (!best) continue;
    const ev = evaluate(p, best, settings, now.getTime());
    byId.set(p.id, ev);
    const st = (state.alerts[p.id] ||= {});
    if (!ev.reasons.length) {
      st.active = false;
      delete st.lastPrice;
      continue;
    }
    // Ný lækkun, eða enn lægra verð en síðast var tilkynnt um.
    if (!st.active || ev.price < st.lastPrice) {
      st.active = true;
      st.lastPrice = ev.price;
      st.lastAt = nowIso();
      triggered.push(ev);
    }
  }

  const quiet = inQuietHours(settings, now);
  // Það sem beið yfir nóttina: sent ef það á enn við.
  let due = [];
  if (!quiet) {
    due = state.pendingAlerts.map((id) => byId.get(id)).filter((ev) => ev?.reasons.length && !triggered.some((t) => t.productId === ev.productId));
    state.pendingAlerts = [];
  }
  const events = [...triggered, ...due];
  if (!events.length) return { events: [] };

  if (quiet) {
    for (const ev of triggered) if (!state.pendingAlerts.includes(ev.productId)) state.pendingAlerts.push(ev.productId);
    log(`Tilkynningar: ${triggered.length} haldið til morguns (þögn á nóttunni)`);
    return { events: triggered, held: true, summary: { type: 'tilkynning', held: true, events: triggered } };
  }

  const one = events.length === 1;
  const title = one ? `Verðlækkun: ${events[0].name}` : `${events.length} verðlækkanir`;
  const message = one ? describe(events[0]) : events.map((e) => `${e.name}: ${describe(e)}`).join('\n');
  const res = await send({ title, message, click: one ? events[0].url : undefined });
  if (!res.sent && res.retry) {
    for (const ev of events) if (!state.pendingAlerts.includes(ev.productId)) state.pendingAlerts.push(ev.productId);
  }
  if (!res.sent && !res.retry) {
    // Engin rás stillt: ekkert merkt sem tilkynnt, svo allt sem þegar er undir mörkum berst þegar rásin er sett upp.
    for (const ev of events) delete state.alerts[ev.productId];
    log(`Tilkynningar: ${events.length} bíða – ${res.reason}`);
    return { events: [] };
  }
  log(`Tilkynningar: ${events.length} ${res.sent ? 'sendar' : 'ekki sendar – ' + res.reason}`);
  return { events, summary: { type: 'tilkynning', held: false, sent: !!res.sent, reason: res.reason || null, events } };
}
