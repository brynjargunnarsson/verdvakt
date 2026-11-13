// Main job: check all prices, record history, build summaries, search for new
// sellers and scan sale pages. Run by GitHub Actions on a schedule.
import { getPrice } from './price.js';
import { closeBrowser } from './browser.js';
import { discoverProduct, loadStores } from './discover.js';
import { scanStore } from './sales.js';
import { activeEvent, onEventDay, isDue } from './schedule.js';
import { readJson, writeJson, hash, hostOf, nowIso, pool, canonicalUrl, minScoreFor } from './util.js';

const t0 = Date.now();
const now = new Date();
const FORCE = process.env.FORCE === 'true';
const ONLY_DISCOVER = (process.env.DISCOVER || '').split(',').filter(Boolean);
const BUDGET_MS = +(process.env.BUDGET_MIN || 25) * 60e3; // stop optional work after this

const { products } = await readJson('products.json', { products: [] });
const sale = await readJson('sale-days.json', { events: [] });
const state = await readJson('state.json', {});
const prices = await readJson('prices.json', { offers: {}, products: {} });
const summaries = await readJson('summaries.json', { items: [] });
const codes = await readJson('codes.json', {});
const { list: stores, cache } = await loadStores();
const storeByHost = new Map(stores.map((s) => [hostOf('https://' + s.domain), s]));
const allStores = (await readJson('stores.json', { stores: [] })).stores;
for (const s of allStores) if (!storeByHost.has(hostOf('https://' + s.domain))) storeByHost.set(hostOf('https://' + s.domain), s);

state.lastDiscovery ||= {};
state.lastSaleScan ||= {};
state.runs ||= [];
prices.offers ||= {};
prices.products ||= {};

const ev = activeEvent(sale, now);
const thorough = !!ev;
const mode = ev ? `Afsláttartímabil: ${ev.name}` : 'Venjulegt';
const log = (...a) => console.log(...a);

const priceDue = FORCE || isDue(state, sale, now);
const active = products.filter((p) => !p.paused);
log(`${nowIso()} · ${mode} · ${active.length} vörur · verðathugun ${priceDue ? 'já' : 'nei'}`);

// ---------- 1. Price checks ----------
export const offerKey = (pid, url) => hash(pid + '|' + url);
const changes = [];
let checked = 0;
let errors = 0;

function effectiveAt(hist, t) {
  let p = null;
  for (const [ts, v] of hist) {
    if (Date.parse(ts) <= t) p = v;
    else break;
  }
  return p;
}

// FORCE (e.g. a new product saved with URLs) checks prices first, so the search can use the stores' own titles.
if (FORCE || (priceDue && !ONLY_DISCOVER.length)) {
  const jobs = [];
  for (const p of active) for (const o of p.offers || []) if (!o.removed) jobs.push({ p, o });
  // Group by store so each store is visited one page at a time.
  const byHost = new Map();
  for (const j of jobs) {
    const h = hostOf(j.o.url);
    if (!byHost.has(h)) byHost.set(h, []);
    byHost.get(h).push(j);
  }
  const histCache = new Map();
  const getHist = async (pid) => {
    if (!histCache.has(pid)) histCache.set(pid, await readJson(`history/${pid}.json`, {}));
    return histCache.get(pid);
  };

  await pool([...byHost.entries()], 6, async ([host, list]) => {
    for (const { p, o } of list) {
      const key = offerKey(p.id, o.url);
      const rec = (prices.offers[key] ||= { productId: p.id, url: o.url, since: nowIso() });
      const store = storeByHost.get(host);
      rec.store = host;
      rec.storeName = store?.name || host;
      rec.marketplace = !!store?.marketplace;
      const r = await getPrice(o.url, { thorough }).catch((e) => ({ ok: false, error: e.message }));
      checked++;
      rec.lastChecked = nowIso();
      if (!r.ok) {
        errors++;
        rec.error = r.error;
        rec.errorSince ||= nowIso();
        rec.gone = !!r.gone;
        continue;
      }
      delete rec.error;
      delete rec.errorSince;
      delete rec.gone;
      const hist = await getHist(p.id);
      const h = (hist[key] ||= []);
      const old = rec.current;
      rec.title = r.title || rec.title;
      rec.available = r.available;
      rec.wasPrice = r.wasPrice;
      rec.memberPrice = r.memberPrice;
      rec.source = r.source;
      if (old == null) {
        rec.current = r.price;
        rec.min = rec.max = r.price;
        rec.minAt = rec.maxAt = rec.lastChanged = nowIso();
        h.push([nowIso(), r.price]);
      } else if (r.price !== old) {
        const wasMin = rec.min;
        rec.previous = old;
        rec.previousAt = rec.lastChanged || rec.since;
        rec.current = r.price;
        rec.lastChanged = nowIso();
        if (r.price < rec.min) Object.assign(rec, { min: r.price, minAt: nowIso() });
        if (r.price > rec.max) Object.assign(rec, { max: r.price, maxAt: nowIso() });
        h.push([nowIso(), r.price]);
        changes.push({
          productId: p.id,
          name: p.name,
          store: host,
          storeName: rec.storeName,
          url: o.url,
          from: old,
          to: r.price,
          pct: Math.round(((r.price - old) / old) * 1000) / 10,
          newLow: r.price < wasMin,
          suspect: r.price < old * 0.4,
          target: p.targetPrice && r.price <= p.targetPrice && old > p.targetPrice ? p.targetPrice : null,
          marketplace: rec.marketplace,
        });
      }
      // ---- Is the discount real? ----
      rec.flags = [];
      if (rec.previous != null && rec.current < rec.previous * 0.4 && now - Date.parse(rec.lastChanged) < 7 * 864e5) {
        rec.flags.push({ type: 'lestur', text: `Verðið féll um meira en 60% (${rec.previous.toLocaleString('de-DE')} → ${rec.current.toLocaleString('de-DE')} kr.). Kannaðu á síðunni hvort vaktin hafi lesið rétt verð.` });
      }
      const tracked = (now - Date.parse(rec.since)) / 864e5;
      if (ev) {
        const winStart = Date.parse(ev.start + 'T00:00:00Z') - (sale.windowBeforeHours ?? 12) * 3600e3;
        const pts = h.filter(([ts]) => Date.parse(ts) >= winStart - 45 * 864e5 && Date.parse(ts) <= winStart).map(([, v]) => v);
        const carried = effectiveAt(h, winStart - 45 * 864e5);
        if (carried != null) pts.unshift(carried);
        const lowBefore = pts.length ? Math.min(...pts) : null;
        const atStart = effectiveAt(h, winStart);
        if (lowBefore && atStart && atStart > lowBefore && rec.current >= lowBefore * 0.99) {
          rec.flags.push({
            type: 'gervi',
            text: `Verðið var hækkað fyrir afsláttardaginn: það var ${lowBefore.toLocaleString('de-DE')} kr. fyrr á tímabilinu, svo „tilboðið“ er ekki lægra en það.`,
          });
        }
      }
      if (rec.wasPrice && tracked >= 7) {
        const since30 = now - 30 * 864e5;
        const seen = h.filter(([ts]) => Date.parse(ts) >= since30).map(([, v]) => v);
        const c = effectiveAt(h, since30);
        if (c != null) seen.push(c);
        const max30 = Math.max(...seen);
        if (rec.wasPrice > max30 * 1.02) {
          rec.flags.push({
            type: 'fyrraverð',
            text: `Verslunin segir fyrra verð ${rec.wasPrice.toLocaleString('de-DE')} kr., en vaktin hefur ekki séð verðið hærra en ${max30.toLocaleString('de-DE')} kr. síðustu 30 daga.`,
          });
        }
      }
      if (!rec.flags.length) delete rec.flags;
    }
  });
  for (const [pid, hist] of histCache) await writeJson(`history/${pid}.json`, hist);

  // Product-level stats: best price you can buy at from a store right now.
  for (const p of products) {
    const recs = (p.offers || [])
      .filter((o) => !o.removed)
      .map((o) => prices.offers[offerKey(p.id, o.url)])
      .filter((r) => r && r.current != null && !r.error && r.available !== false && !r.marketplace);
    if (!recs.length) continue;
    const best = recs.reduce((a, b) => (b.current < a.current ? b : a));
    const ps = (prices.products[p.id] ||= { since: nowIso() });
    if (ps.current !== best.current) {
      if (ps.current != null) {
        ps.previous = ps.current;
        ps.previousAt = ps.changedAt || ps.since;
      }
      ps.current = best.current;
      ps.changedAt = nowIso();
    }
    ps.store = best.store;
    ps.storeName = best.storeName;
    ps.url = best.url;
    if (ps.min == null || best.current < ps.min) Object.assign(ps, { min: best.current, minAt: nowIso(), minStore: best.storeName });
    if (ps.max == null || best.current > ps.max) Object.assign(ps, { max: best.current, maxAt: nowIso(), maxStore: best.storeName });
    ps.checkedAt = nowIso();
  }
  // Prune records of offers that no longer exist.
  const live = new Set(products.flatMap((p) => (p.offers || []).map((o) => offerKey(p.id, o.url))));
  for (const k of Object.keys(prices.offers)) if (!live.has(k)) delete prices.offers[k];
  for (const k of Object.keys(prices.products)) if (!products.some((p) => p.id === k)) delete prices.products[k];
  prices.updatedAt = nowIso();
  state.lastRun = nowIso();
  // Save now: the seller search below reads these (store titles, reference price).
  await writeJson('prices.json', prices);
}

// ---------- 2. Sale pages and discount codes ----------
const overBudget = () => Date.now() - t0 > BUDGET_MS;
if (ev && !ONLY_DISCOVER.length) {
  const tracked = new Set(products.flatMap((p) => (p.offers || []).map((o) => hostOf(o.url))));
  const toScan = stores.filter(
    (s) => !s.marketplace && !s.unverified && (Date.now() - Date.parse(state.lastSaleScan[s.domain] || 0)) / 3600e3 >= (tracked.has(hostOf('https://' + s.domain)) ? 3 : 8)
  );
  let newCands = 0;
  await pool(toScan, 4, async (s) => {
    if (overBudget()) return;
    try {
      const r = await scanStore(s, active);
      codes[s.domain] = { checkedAt: r.checkedAt, codes: r.codes, salePages: r.salePages };
      state.lastSaleScan[s.domain] = nowIso();
      for (const m of r.matches) {
        const p = products.find((x) => x.id === m.productId);
        const cu = canonicalUrl(m.url);
        if ([...(p.offers || []).map((o) => o.url), ...(p.rejected || [])].some((u) => canonicalUrl(u) === cu)) continue;
        const c = await readJson(`candidates/${p.id}.json`, { productId: p.id, results: [] });
        if (c.results.some((x) => canonicalUrl(x.url) === cu)) continue;
        c.results.push({ url: m.url, store: s.domain, storeName: s.name, title: m.title, price: m.price, score: Math.round(m.score * 100) / 100, foundAt: nowIso(), seenAt: nowIso(), via: 'tilboðssíða' });
        await writeJson(`candidates/${p.id}.json`, c);
        newCands++;
      }
    } catch (e) {
      codes[s.domain] = { ...(codes[s.domain] || {}), checkedAt: nowIso(), error: e.message.slice(0, 160) };
    }
  });
  log(`Tilboðssíður: ${toScan.length} verslanir skoðaðar, ${newCands} nýjar tillögur`);
}

// ---------- 3. Find sellers (new products, and periodic re-search) ----------
{
  const reDays = ev ? 1 : 7;
  const due = products.filter((p) => {
    if (ONLY_DISCOVER.length) return ONLY_DISCOVER.includes(p.id);
    if (p.paused) return false;
    const last = state.lastDiscovery[p.id];
    return !last || (now - Date.parse(last)) / 864e5 >= reDays;
  });
  // New products first, then the oldest searches. Max 3 per run to keep runs short.
  due.sort((a, b) => Date.parse(state.lastDiscovery[a.id] || 0) - Date.parse(state.lastDiscovery[b.id] || 0));
  for (const p of due.slice(0, ONLY_DISCOVER.length ? 50 : 3)) {
    if (overBudget() && !ONLY_DISCOVER.length) break;
    await discoverProduct(p, { stores, cache, log });
    state.lastDiscovery[p.id] = nowIso();
  }
}

// ---------- 4. Summaries ----------
const drops = changes.filter((c) => c.to < c.from);
if (drops.length) {
  summaries.items.unshift({ id: hash(nowIso()), at: nowIso(), type: 'lækkanir', event: ev?.name || null, changes: drops });
}
const today = now.toISOString().slice(0, 10);
const dayEv = onEventDay(sale, now);
if (dayEv && now.getUTCHours() >= 7 && state.lastMorning !== today) {
  const best = products
    .filter((p) => prices.products[p.id])
    .map((p) => {
      const ps = prices.products[p.id];
      return { productId: p.id, name: p.name, price: ps.current, storeName: ps.storeName, url: ps.url, min: ps.min, previous: ps.previous ?? null };
    })
    .sort((a, b) => (a.previous ? a.price / a.previous : 1) - (b.previous ? b.price / b.previous : 1));
  const storeCodes = Object.entries(codes)
    .filter(([, c]) => c.codes?.length)
    .map(([d, c]) => ({ store: d, codes: c.codes }));
  summaries.items.unshift({ id: hash('m' + today), at: nowIso(), type: 'morgunyfirlit', event: dayEv.name, best, codes: storeCodes });
  state.lastMorning = today;
}
summaries.items = summaries.items.slice(0, 300);

// ---------- 5. Save ----------
const ms = Date.now() - t0;
state.runs.unshift({ at: nowIso(), mode: ev ? 'afsláttur' : 'venjulegt', checked, changed: changes.length, drops: drops.length, errors, seconds: Math.round(ms / 1000) });
state.runs = state.runs.slice(0, 100);
state.lastFinished = nowIso();
await writeJson('prices.json', prices);
await writeJson('summaries.json', summaries);
await writeJson('codes.json', codes);
await writeJson('store-cache.json', cache);
await writeJson('state.json', state);
await closeBrowser();
log(`Lokið: ${checked} verð athuguð, ${changes.length} breytingar (${drops.length} lækkanir), ${errors} villur, ${Math.round(ms / 1000)} s`);
