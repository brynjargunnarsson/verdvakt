// Verðvakt – vefsíða. Les gögn úr repo-inu og skrifar breytingar í gegnum GitHub API.
import { drawPriceChart } from './chart.js';

const CFG = window.VERDVAKT;
const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname) || location.protocol === 'file:';
const API = `https://api.github.com/repos/${CFG.owner}/${CFG.repo}`;
const LS = {
  get: (k, d = null) => {
    try {
      return localStorage.getItem('verdvakt.' + k) ?? d;
    } catch {
      return d;
    }
  },
  set: (k, v) => {
    try {
      v == null ? localStorage.removeItem('verdvakt.' + k) : localStorage.setItem('verdvakt.' + k, v);
    } catch {}
  },
};
const token = () => LS.get('token');

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const thous = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const kr = (n) => (n == null ? '–' : `${thous(n)} kr.`);
const MONTHS = ['jan.', 'feb.', 'mars', 'apr.', 'maí', 'júní', 'júlí', 'ágúst', 'sept.', 'okt.', 'nóv.', 'des.'];
// Iceland is on UTC all year, so UTC fields are local time.
const when = (iso) => {
  if (!iso) return '–';
  const d = new Date(iso);
  return `${d.getUTCDate()}. ${MONTHS[d.getUTCMonth()]} kl. ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};
const day = (iso) => {
  if (!iso) return '–';
  const d = new Date(iso);
  return `${d.getUTCDate()}. ${MONTHS[d.getUTCMonth()]}${d.getUTCFullYear() !== new Date().getUTCFullYear() ? ' ' + d.getUTCFullYear() : ''}`;
};
const hhmm = (d) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
const pct = (from, to) => (from ? Math.round(((to - from) / from) * 1000) / 10 : 0);
const hostOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};
function canonicalUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    u.hostname = u.hostname.replace(/^www\./, '');
    u.pathname = u.pathname.replace(/\/collections\/[^/]+\/products\//, '/products/').replace(/\/+$/, '');
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref|_pos|_sid|_ss|_psq|_v)/.test(k)) u.searchParams.delete(k);
    return u.toString().toLowerCase();
  } catch {
    return url;
  }
}
async function sha1(s) {
  const b = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
const offerKey = async (pid, url) => (await sha1(pid + '|' + url)).slice(0, 10);

function toast(msg, ms = 4500) {
  const t = $('#toast');
  t.textContent = msg;
  t.show();
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.close(), ms);
}

// ---------- GitHub I/O ----------
const b64dec = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\n/g, '')), (c) => c.charCodeAt(0)));
const b64enc = (str) => {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

async function gh(path, opts = {}) {
  const res = await fetch(API + path, {
    // GitHub gives the raw and JSON forms of a file the same ETag, so a browser cache
    // can hand back the raw file when we asked for JSON. Never cache API calls.
    cache: 'no-store',
    ...opts,
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token()}`, 'X-GitHub-Api-Version': '2022-11-28', ...(opts.headers || {}) },
  });
  if (!res.ok && res.status !== 404) {
    const t = await res.text();
    const e = new Error(`GitHub ${res.status}: ${t.slice(0, 200)}`);
    e.status = res.status;
    throw e;
  }
  return res;
}

async function load(rel, fallback) {
  try {
    if (LOCAL) {
      const r = await fetch(`../data/${rel}?t=${Date.now()}`, { cache: 'no-store' });
      return r.ok ? await r.json() : fallback;
    }
    if (token()) {
      const r = await gh(`/contents/data/${rel}?ref=${CFG.branch}`, { headers: { Accept: 'application/vnd.github.raw+json' } });
      return r.ok ? await r.json() : fallback;
    }
    const r = await fetch(`https://raw.githubusercontent.com/${CFG.owner}/${CFG.repo}/${CFG.branch}/data/${rel}?t=${Date.now()}`, { cache: 'no-store' });
    return r.ok ? await r.json() : fallback;
  } catch {
    return fallback;
  }
}

/** Read-modify-write a data file, retrying if someone else (the watcher) wrote in between. */
async function mutate(rel, fn, message) {
  if (!token()) throw new Error('Settu inn GitHub-lykil í Stillingum fyrst.');
  for (let i = 0; i < 4; i++) {
    const r = await gh(`/contents/data/${rel}?ref=${CFG.branch}`);
    const meta = r.status === 404 ? null : await r.json();
    if (meta && typeof meta.content !== 'string') throw new Error('Óvænt svar frá GitHub. Endurhladdu síðuna og reyndu aftur.');
    const obj = meta ? JSON.parse(b64dec(meta.content)) : {};
    const next = (await fn(obj)) ?? obj;
    try {
      await gh(`/contents/data/${rel}`, {
        method: 'PUT',
        body: JSON.stringify({ message, content: b64enc(JSON.stringify(next, null, 1) + '\n'), sha: meta?.sha, branch: CFG.branch }),
      });
      return next;
    } catch (e) {
      if (e.status === 409 || e.status === 422) continue;
      throw e;
    }
  }
  throw new Error('Tókst ekki að vista (árekstur). Reyndu aftur.');
}

async function dispatch(inputs) {
  if (!token()) return;
  await gh(`/actions/workflows/${CFG.workflow}/dispatches`, { method: 'POST', body: JSON.stringify({ ref: CFG.branch, inputs: Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, String(v)])) }) });
}

// ---------- data ----------
const D = { products: [], prices: { offers: {}, products: {} }, summaries: { items: [] }, state: {}, sale: { events: [] }, stores: { stores: [] }, cache: {}, codes: {}, cands: {}, hist: {} };

async function loadAll() {
  const [products, prices, summaries, state, sale, stores, cache, codes] = await Promise.all([
    load('products.json', { products: [] }),
    load('prices.json', { offers: {}, products: {} }),
    load('summaries.json', { items: [] }),
    load('state.json', {}),
    load('sale-days.json', { events: [] }),
    load('stores.json', { stores: [] }),
    load('store-cache.json', {}),
    load('codes.json', {}),
  ]);
  Object.assign(D, { products: products.products || [], prices, summaries, state, sale, stores, cache, codes });
  const cands = await Promise.all(D.products.map((p) => load(`candidates/${p.id}.json`, null)));
  D.cands = Object.fromEntries(D.products.map((p, i) => [p.id, cands[i]]));
  D.keys = {};
  for (const p of D.products) for (const o of p.offers || []) D.keys[p.id + '|' + o.url] = await offerKey(p.id, o.url);
}

const offerRec = (p, o) => D.prices.offers?.[D.keys[p.id + '|' + o.url]];
const storeName = (domain) => D.stores.stores.find((s) => hostOf('https://' + s.domain) === hostOf('https://' + domain))?.name || domain;
function openCands(p) {
  const c = D.cands[p.id];
  if (!c) return [];
  const known = new Set([...(p.offers || []).map((o) => o.url), ...(p.rejected || [])].map(canonicalUrl));
  return (c.results || []).filter((r) => !known.has(canonicalUrl(r.url)));
}

function activeEvent(now = new Date()) {
  const s = D.sale;
  for (const ev of s.events || []) {
    const a = Date.parse(ev.start + 'T00:00:00Z') - (s.windowBeforeHours ?? 12) * 3600e3;
    const b = Date.parse((ev.end || ev.start) + 'T23:59:59Z') + (s.windowAfterHours ?? 24) * 3600e3;
    if (now >= a && now <= b) return ev;
  }
  return null;
}
function nextEvent(now = new Date()) {
  return (D.sale.events || []).filter((e) => Date.parse((e.end || e.start) + 'T23:59:59Z') >= now).sort((a, b) => a.start.localeCompare(b.start))[0];
}

// ---------- render ----------
const open = new Set(JSON.parse(LS.get('open', '[]')));

function renderStatus() {
  const ev = activeEvent();
  const last = D.state.lastRun;
  const mins = ev ? D.sale.saleIntervalMin ?? 30 : (D.sale.normalIntervalHours ?? 3) * 60;
  const next = last ? new Date(Date.parse(last) + mins * 60e3) : null;
  $('#status').textContent = last
    ? `Síðast athugað ${when(last)} · næst um ${next < new Date() ? 'bráðum' : when(next)} · ${ev ? 'afsláttartímabil, athugað á ' + mins + ' mín. fresti' : 'athugað á ' + mins / 60 + ' klst. fresti'}`
    : 'Vaktin hefur ekki keyrt enn.';

  const notes = [];
  if (ev) notes.push(`<div class="note sale"><b>${esc(ev.name)}</b> stendur yfir. Vaktin athugar oftar, skoðar tilboðssíður og leitar að afsláttarkóðum.</div>`);
  else {
    const nx = nextEvent();
    if (nx) notes.push(`<div class="note sale" style="opacity:.85">Næsti afsláttardagur: <b>${esc(nx.name)}</b>, ${day(nx.start + 'T12:00:00Z')}</div>`);
  }
  if (!token() && !LOCAL) notes.push(`<div class="note">Þú ert í skoðunarham. Settu inn GitHub-lykil í <a href="#" data-goto="stillingar">Stillingum</a> til að bæta við vörum og breyta.</div>`);
  $('#banner').innerHTML = notes.join('');
}

function trendChip(cur, prev) {
  if (cur == null || prev == null || cur === prev) return '';
  const p = pct(prev, cur);
  return `<span class="chip ${cur < prev ? 'down' : 'up'}">${cur < prev ? '▼' : '▲'} ${String(Math.abs(p)).replace('.', ',')}%</span>`;
}

function renderProducts() {
  const f = $('#filter').value.trim().toLowerCase();
  const cat = $('#cat-filter').value;
  const cats = [...new Set(D.products.map((p) => p.category).filter(Boolean))].sort();
  $('#cat-filter').innerHTML = `<option value="">Allir flokkar</option>` + cats.map((c) => `<option ${c === cat ? 'selected' : ''}>${esc(c)}</option>`).join('');
  $('#cats').innerHTML = cats.map((c) => `<option value="${esc(c)}">`).join('');

  const list = D.products.filter((p) => (!f || (p.name + ' ' + p.query + ' ' + (p.category || '')).toLowerCase().includes(f)) && (!cat || p.category === cat));
  if (!D.products.length) {
    $('#products').innerHTML = `<div class="card empty">Engar vörur enn. Smelltu á <b>+ Bæta við vöru</b>.</div>`;
    return;
  }
  const rows = list.map((p) => {
    const ps = D.prices.products?.[p.id] || {};
    const offers = (p.offers || []).filter((o) => !o.removed);
    const recs = offers.map((o) => offerRec(p, o)).filter(Boolean);
    const errs = recs.filter((r) => r.error).length;
    const flags = recs.flatMap((r) => r.flags || []);
    const nc = openCands(p).length;
    const searching = !D.state.lastDiscovery?.[p.id];
    const chips = [
      trendChip(ps.current, ps.previous),
      p.targetPrice && ps.current != null && ps.current <= p.targetPrice ? `<span class="chip down">Undir markverði</span>` : '',
      flags.length ? `<span class="chip warn" title="${esc(flags.map((x) => x.text).join('\n'))}">⚠ ${flags.some((x) => x.type === 'lestur') ? 'Athugaðu verðið' : 'Grunsamlegur afsláttur'}</span>` : '',
      nc ? `<span class="chip new">${nc} ${nc === 1 ? 'tillaga' : 'tillögur'}</span>` : '',
      searching ? `<span class="chip">Leitar í verslunum…</span>` : '',
      errs ? `<span class="chip warn">${errs} ${errs === 1 ? 'síða svarar' : 'síður svara'} ekki</span>` : '',
      p.paused ? `<span class="chip">Í hléi</span>` : '',
    ].join(' ');
    const isOpen = open.has(p.id);
    return `<tr class="p ${p.paused ? 'paused' : ''}" data-id="${esc(p.id)}">
      <td><span class="muted">${isOpen ? '▾' : '▸'}</span> <span class="pname">${esc(p.name)}</span><div class="muted small">${esc(p.category || '')}${p.targetPrice ? ' · markverð ' + kr(p.targetPrice) : ''}</div></td>
      <td class="num"><div class="price">${kr(ps.current)}</div><div class="muted small">${esc(ps.storeName || '')}</div></td>
      <td class="num">${kr(ps.previous)}<div class="muted small">${ps.previous != null ? 'til ' + when(ps.changedAt) : ''}</div></td>
      <td class="num">${kr(ps.min)}<div class="muted small">${ps.min != null ? esc(ps.minStore || '') + ' · ' + day(ps.minAt) : ''}</div></td>
      <td class="num">${kr(ps.max)}<div class="muted small">${ps.max != null ? esc(ps.maxStore || '') + ' · ' + day(ps.maxAt) : ''}</div></td>
      <td class="num">${offers.length}</td>
      <td>${chips}</td>
    </tr>${isOpen ? `<tr class="detail"><td colspan="7" id="detail-${esc(p.id)}">${renderDetail(p)}</td></tr>` : ''}`;
  });
  $('#products').innerHTML = `<div class="products"><table class="t">
    <thead><tr><th>Vara</th><th class="num">Besta verð núna</th><th class="num">Síðasta verð</th><th class="num">Lægst frá upphafi</th><th class="num">Hæst frá upphafi</th><th class="num">Verslanir</th><th>Staða</th></tr></thead>
    <tbody>${rows.join('') || `<tr><td colspan="7" class="empty">Engin vara passar við síuna.</td></tr>`}</tbody></table></div>`;
  for (const p of list) if (open.has(p.id)) loadHistory(p);
}

function codeFor(store, price) {
  const c = D.codes?.[store]?.codes?.find((x) => x.pct);
  if (!c || !price) return '';
  return `<span title="${esc(c.text)}">${kr(price * (1 - c.pct / 100))}<div class="muted small">${esc(c.code)} (−${c.pct}%)</div></span>`;
}

function renderDetail(p) {
  const offers = (p.offers || []).filter((o) => !o.removed);
  const rows = offers
    .map((o) => ({ o, r: offerRec(p, o) || {} }))
    .sort((a, b) => (a.r.current ?? 1e12) - (b.r.current ?? 1e12))
    .map(({ o, r }) => {
      const flags = (r.flags || []).map((f) => `<div class="flag">⚠ ${esc(f.text)}</div>`).join('');
      const err = r.error ? `<div class="err">${esc(r.error)}${r.errorSince ? ' (síðan ' + when(r.errorSince) + ')' : ''}</div>` : '';
      return `<tr>
        <td><a href="${esc(o.url)}" target="_blank" rel="noopener">${esc(r.storeName || storeName(hostOf(o.url)))}</a>${r.marketplace ? ' <span class="chip">markaðstorg</span>' : ''}${r.available === false ? ' <span class="chip warn">uppselt</span>' : ''}
          <div class="muted small">${esc(r.title || o.url)}</div>${flags}${err}</td>
        <td class="num"><b>${kr(r.current)}</b> ${trendChip(r.current, r.previous)}</td>
        <td class="num">${kr(r.previous)}</td>
        <td class="num">${kr(r.min)}<div class="muted small">${day(r.minAt)}</div></td>
        <td class="num">${kr(r.max)}<div class="muted small">${day(r.maxAt)}</div></td>
        <td class="num">${r.wasPrice ? `<s>${kr(r.wasPrice)}</s>` : '–'}</td>
        <td class="num">${r.memberPrice ? kr(r.memberPrice) : '–'}</td>
        <td class="num">${codeFor(r.store || hostOf(o.url), r.current) || '–'}</td>
        <td class="small muted">${when(r.lastChecked)}</td>
        <td><button class="link danger" data-act="rm-offer" data-pid="${esc(p.id)}" data-url="${esc(o.url)}">Fjarlægja</button></td>
      </tr>`;
    })
    .join('');
  const c = D.cands[p.id];
  const cands = openCands(p);
  const seen = LS.get('seen-cands-' + p.id, '');
  const candRows = cands
    .map(
      (x, i) => `<tr>
      <td><input type="checkbox" class="cand" data-pid="${esc(p.id)}" data-i="${i}" ${x.score >= 1 && !x.accessory ? 'checked' : ''}></td>
      <td>${esc(x.storeName || x.store)}${x.marketplace ? ' <span class="chip">markaðstorg</span>' : ''} ${x.foundAt > seen ? '<span class="chip new">Ný</span>' : ''}</td>
      <td><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title || x.url)}</a>${x.via === 'tilboðssíða' ? ' <span class="chip down">af tilboðssíðu</span>' : ''}${x.accessory ? ' <span class="chip warn" title="Mun ódýrara en verðin sem þú hefur staðfest">líklega aukahlutur</span>' : ''}</td>
      <td class="num">${kr(x.price)}</td>
      <td class="num muted small">${Math.round(x.score * 100)}%</td>
    </tr>`
    )
    .join('');
  const searchInfo = c
    ? `Leitað ${when(c.searchedAt)} að „${esc(c.query)}“ í ${c.storesSearched} verslunum${c.storesFailed?.length ? ` (${c.storesFailed.length} svöruðu ekki)` : ''}.`
    : 'Leit hefur ekki farið fram enn. Hún hefst í næstu keyrslu.';
  return `
    <div class="actions">
      <button data-act="edit" data-pid="${esc(p.id)}">Breyta</button>
      <button data-act="pause" data-pid="${esc(p.id)}">${p.paused ? 'Halda áfram að vakta' : 'Setja í hlé'}</button>
      <button data-act="research" data-pid="${esc(p.id)}">Leita aftur í verslunum</button>
      <span class="grow"></span>
      <button class="danger" data-act="delete" data-pid="${esc(p.id)}">Eyða vöru</button>
    </div>
    ${p.notes ? `<p class="muted">${esc(p.notes)}</p>` : ''}
    <h3>Verslanir sem eru vaktaðar</h3>
    ${offers.length ? `<table class="t"><thead><tr><th>Verslun</th><th class="num">Verð núna</th><th class="num">Síðasta</th><th class="num">Lægst</th><th class="num">Hæst</th><th class="num">Fyrra verð skv. verslun</th><th class="num">Klúbbverð</th><th class="num">Með afsl.kóða</th><th>Athugað</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="muted">Engin verslun staðfest enn. Veldu úr tillögunum hér fyrir neðan.</p>`}
    <div class="hist" id="hist-${esc(p.id)}"></div>
    <h3>Tillögur úr leit <span class="muted small" style="font-weight:400">${searchInfo}</span></h3>
    ${cands.length ? `<table class="t"><thead><tr><th></th><th>Verslun</th><th>Vara</th><th class="num">Verð</th><th class="num">Samsvörun</th></tr></thead><tbody>${candRows}</tbody></table>
      <div class="row"><button class="primary" data-act="accept" data-pid="${esc(p.id)}">Vakta valdar</button><button data-act="reject" data-pid="${esc(p.id)}">Hafna völdum</button><button class="link" data-act="selall" data-pid="${esc(p.id)}">Velja allar</button></div>`
      : `<p class="muted">Engar nýjar tillögur.</p>`}
    <form class="row" data-act="add-url" data-pid="${esc(p.id)}"><input name="url" type="url" placeholder="Bæta við slóð á vöruna í annarri verslun" size="60" required><button type="submit">Bæta við</button></form>`;
}

const chartHidden = new Map(); // vara -> mengi lykla sem eru faldir (í minni, endist meðan síðan er opin)
const charts = new Map(); // vara -> teikna aftur (við breytta gluggastærð)
const slugTail = (u) => {
  try {
    return decodeURIComponent(new URL(u).pathname.split('/').filter(Boolean).pop() || '').slice(0, 26);
  } catch {
    return '';
  }
};

async function loadHistory(p) {
  const el = document.getElementById('hist-' + p.id);
  if (!el) return;
  D.hist[p.id] ||= await load(`history/${p.id}.json`, {});
  if (!el.isConnected) return;
  const hist = D.hist[p.id];
  const offers = (p.offers || []).filter((o) => !o.removed);

  // Ein röð á verslun. Litur fylgir versluninni (röð í vörunni), ekki stöðu hennar í verðröð.
  const series = offers
    .map((o, i) => {
      const rec = offerRec(p, o) || {};
      const key = D.keys[p.id + '|' + o.url];
      const pts = (hist[key] || []).map(([t, v]) => [Date.parse(t), v]).filter(([t, v]) => t && v).sort((a, b) => a[0] - b[0]);
      return { key, url: o.url, base: rec.storeName || storeName(hostOf(o.url)), color: `var(--series-${(i % 8) + 1})`, pts, marketplace: !!rec.marketplace, avail: rec.available !== false, i };
    })
    .filter((s) => s.pts.length);
  if (!series.length) {
    el.innerHTML = `<h3>Verðsaga</h3><p class="muted">Verðsaga birtist eftir fyrstu verðathugun.</p>`;
    return;
  }
  const dup = {};
  for (const s of series) dup[s.base] = (dup[s.base] || 0) + 1;
  for (const s of series) s.name = dup[s.base] > 1 ? `${s.base} · ${slugTail(s.url)}` : s.base;

  // Besta verð = lægsta verð hjá verslun (ekki markaðstorgi, ekki uppselt núna) á hverjum tíma – eins og taflan.
  const shops = series.filter((s) => !s.marketplace && s.avail);
  let best = null;
  if (shops.length > 1) {
    const times = [...new Set(shops.flatMap((s) => s.pts.map(([t]) => t)))].sort((a, b) => a - b);
    best = [];
    for (const t of times) {
      const vals = shops.map((s) => s.pts.filter(([ts]) => ts <= t).at(-1)?.[1]).filter((v) => v != null);
      const v = Math.min(...vals);
      if (!best.length || best.at(-1)[1] !== v) best.push([t, v]);
    }
  }

  const t0 = Math.min(...series.map((s) => s.pts[0][0]));
  const t1 = Date.now();
  if (!chartHidden.has(p.id)) chartHidden.set(p.id, new Set(series.length > 4 ? series.map((s) => s.key) : [])); // margar verslanir: byrja á besta verði einu
  const hidden = chartHidden.get(p.id);

  // Allar verðbreytingar, nýjustu efst.
  const rows = [];
  for (const s of series) s.pts.forEach(([t, v], i) => rows.push({ t, name: s.name, url: s.url, from: i ? s.pts[i - 1][1] : null, to: v }));
  rows.sort((a, b) => b.t - a.t);
  const changes = rows.filter((r) => r.from != null).length;
  const tbl = rows
    .slice(0, 300)
    .map((r) => {
      const ch = r.from == null ? '<span class="muted">Vöktun hófst</span>' : trendChip(r.to, r.from);
      return `<tr><td>${when(new Date(r.t).toISOString())}</td><td><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name)}</a></td><td class="num">${kr(r.from)}</td><td class="num"><b>${kr(r.to)}</b></td><td>${ch}</td></tr>`;
    })
    .join('');

  el.innerHTML = `<h3>Verðsaga <span class="muted small" style="font-weight:400">frá ${day(new Date(t0).toISOString())} til dagsins í dag · ${changes} ${changes === 1 ? 'verðbreyting' : 'verðbreytingar'}</span></h3>
    <div class="chartbox"></div>
    <details class="chart-table"><summary>Sýna allar verðbreytingar sem tafla</summary>
      <table class="t"><thead><tr><th>Tími</th><th>Verslun</th><th class="num">Fyrra verð</th><th class="num">Nýtt verð</th><th>Breyting</th></tr></thead><tbody>${tbl}</tbody></table>
    </details>`;
  const box = el.querySelector('.chartbox');
  const fmt = {
    kr: (v) => kr(v),
    num: (v) => thous(v),
    day: (t) => day(new Date(t).toISOString()),
    time: (t) => hhmm(new Date(t)),
    when: (t) => when(new Date(t).toISOString()),
  };
  const draw = () =>
    drawPriceChart(box, {
      series,
      best,
      t0,
      t1,
      hidden,
      fmt,
      label: `Verðsaga: ${p.name}`,
      onToggle: (key) => {
        hidden.has(key) ? hidden.delete(key) : hidden.add(key);
        draw();
      },
    });
  charts.set(p.id, () => (box.isConnected ? draw() : charts.delete(p.id)));
  draw();
}

let resizeT;
window.addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => charts.forEach((f) => f()), 150);
});

function renderSummaries() {
  const seen = LS.get('seen-summary', '');
  const items = D.summaries.items || [];
  const unread = items.filter((s) => s.at > seen).length;
  $('#unread').hidden = !unread;
  $('#unread').textContent = unread;
  if (!items.length) {
    $('#summaries').innerHTML = `<div class="card empty">Engar verðlækkanir enn. Þær birtast hér eftir hverja athugun.</div>`;
    return;
  }
  $('#summaries').innerHTML = items
    .slice(0, 80)
    .map((s) => {
      const isNew = s.at > seen;
      if (s.type === 'morgunyfirlit') {
        return `<div class="card summary ${isNew ? 'unread' : ''}"><h3>☀️ Morgunyfirlit: ${esc(s.event)} <span class="muted small">${when(s.at)}</span> ${isNew ? '<span class="chip new">Nýtt</span>' : ''}</h3>
          <table class="t"><thead><tr><th>Vara</th><th class="num">Besta verð</th><th>Verslun</th><th class="num">Fyrra besta verð</th><th class="num">Lægst frá upphafi</th></tr></thead><tbody>
          ${(s.best || []).map((b) => `<tr><td>${esc(b.name)}</td><td class="num"><b>${kr(b.price)}</b> ${trendChip(b.price, b.previous)}</td><td><a href="${esc(b.url)}" target="_blank" rel="noopener">${esc(b.storeName)}</a></td><td class="num">${kr(b.previous)}</td><td class="num">${kr(b.min)}</td></tr>`).join('')}
          </tbody></table>
          ${(s.codes || []).length ? `<p class="small"><b>Auglýstir kóðar:</b> ${s.codes.map((c) => `${esc(storeName(c.store))}: ${c.codes.map((k) => `<code>${esc(k.code)}</code>${k.pct ? ' −' + k.pct + '%' : ''}`).join(', ')}`).join(' · ')}</p>` : ''}
        </div>`;
      }
      return `<div class="card summary ${isNew ? 'unread' : ''}"><h3>${s.changes.length} ${s.changes.length === 1 ? 'verðlækkun' : 'verðlækkanir'} <span class="muted small">${when(s.at)}${s.event ? ' · ' + esc(s.event) : ''}</span> ${isNew ? '<span class="chip new">Nýtt</span>' : ''}</h3>
        <table class="t"><tbody>${s.changes
          .map(
            (c) => `<tr><td>${esc(c.name)}</td><td><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.storeName)}</a>${c.marketplace ? ' <span class="chip">markaðstorg</span>' : ''}</td>
            <td class="num"><s class="muted">${kr(c.from)}</s> → <b>${kr(c.to)}</b></td><td>${trendChip(c.to, c.from)} ${c.newLow ? '<span class="chip down">Nýtt lægsta verð</span>' : ''} ${c.suspect ? '<span class="chip warn">Gæti verið villa í lestri</span>' : ''} ${c.target ? '<span class="chip down">Undir markverði</span>' : ''}</td></tr>`
          )
          .join('')}</tbody></table></div>`;
    })
    .join('');
}

function renderDays() {
  const s = D.sale;
  $('#win-before').textContent = s.windowBeforeHours ?? 12;
  $('#win-after').textContent = s.windowAfterHours ?? 24;
  $('#sale-int').textContent = s.saleIntervalMin ?? 30;
  $('#norm-int').textContent = s.normalIntervalHours ?? 3;
  for (const k of ['normalIntervalHours', 'saleIntervalMin', 'windowBeforeHours', 'windowAfterHours']) $(`#int-form [name=${k}]`).value = s[k] ?? '';
  const ev = activeEvent();
  const evs = [...(s.events || [])].sort((a, b) => a.start.localeCompare(b.start));
  $('#days').innerHTML =
    `<thead><tr><th>Heiti</th><th>Frá</th><th>Til</th><th></th><th></th></tr></thead><tbody>` +
    evs
      .map(
        (e) => `<tr><td>${esc(e.name)}</td><td>${day(e.start + 'T12:00:00Z')}</td><td>${day((e.end || e.start) + 'T12:00:00Z')}</td>
      <td>${ev === e ? '<span class="chip down">Stendur yfir</span>' : (e.end || e.start) < new Date().toISOString().slice(0, 10) ? '<span class="chip">Liðinn</span>' : ''}</td>
      <td><button class="link danger" data-act="rm-day" data-start="${esc(e.start)}" data-name="${esc(e.name)}">Eyða</button></td></tr>`
      )
      .join('') +
    `</tbody>`;
  const codes = Object.entries(D.codes || {}).filter(([, c]) => c.codes?.length || c.salePages?.length);
  $('#codes').innerHTML = codes.length
    ? `<table class="t"><thead><tr><th>Verslun</th><th>Kóðar</th><th>Tilboðssíður</th><th>Skoðað</th></tr></thead><tbody>${codes
        .map(
          ([d, c]) => `<tr><td>${esc(storeName(d))}</td><td>${(c.codes || []).map((k) => `<code title="${esc(k.text)}">${esc(k.code)}</code>${k.pct ? ' −' + k.pct + '%' : ''}`).join('<br>') || '–'}</td>
          <td class="small">${(c.salePages || []).map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(decodeURIComponent(new URL(u).pathname))}</a>`).join('<br>') || '–'}</td><td class="small muted">${when(c.checkedAt)}</td></tr>`
        )
        .join('')}</tbody></table>`
    : `<p class="muted">Ekkert fundið enn. Skoðað er á afsláttartímabilum.</p>`;
}

function renderStores() {
  const rows = D.stores.stores
    .map((s) => {
      const c = D.cache[s.domain] || {};
      const how = s.kind || c.learned?.kind;
      const howTxt = { shopify: 'Shopify-leit', woo: 'WooCommerce-leit', html: 'Leitarsíða', type: 'Leitarreitur' }[how] || 'Ekki fundin enn';
      let status;
      if (s.disabled) status = '<span class="chip">Slökkt</span>';
      else if (c.pausedUntil && Date.parse(c.pausedUntil) > Date.now()) status = `<span class="chip warn" title="${esc(c.lastError || '')}">Í hvíld til ${day(c.pausedUntil)}</span>`;
      else if (c.lastError && (!c.lastOk || c.lastErrorAt > c.lastOk)) status = `<span class="chip warn" title="${esc(c.lastError)}">Villa: ${esc(c.lastError.slice(0, 40))}</span>`;
      else if (c.lastOk) status = how ? `<span class="chip down">Virkar</span>` : `<span class="chip">Svarar – leit ekki fundin enn</span>`;
      else status = '<span class="chip">Óprófuð</span>';
      return `<tr><td>${esc(s.name)}${s.marketplace ? ' <span class="chip">markaðstorg</span>' : ''}</td><td><a href="https://${esc(s.domain)}" target="_blank" rel="noopener">${esc(s.domain)}</a></td><td>${esc(s.cat || '')}</td>
        <td class="small">${howTxt}${s.searchUrl || c.learned?.searchUrl ? `<div class="muted">${esc(s.searchUrl || c.learned.searchUrl)}</div>` : ''}</td><td>${status}</td>
        <td><button class="link" data-act="toggle-store" data-domain="${esc(s.domain)}">${s.disabled ? 'Kveikja' : 'Slökkva'}</button></td></tr>`;
    })
    .join('');
  $('#stores').innerHTML = `<thead><tr><th>Verslun</th><th>Lén</th><th>Flokkur</th><th>Hvernig er leitað</th><th>Staða</th><th></th></tr></thead><tbody>${rows}</tbody>`;
}

function renderSettings() {
  $('#repo-name').textContent = `${CFG.owner}/${CFG.repo}`;
  $('#token-status').innerHTML = token() ? '✔ Lykill vistaður í þessum vafra.' : 'Enginn lykill. Síðan er í skoðunarham.';
  $('#runs').innerHTML =
    `<thead><tr><th>Tími</th><th>Hamur</th><th class="num">Verð athuguð</th><th class="num">Breytingar</th><th class="num">Lækkanir</th><th class="num">Villur</th><th class="num">Tími (s)</th></tr></thead><tbody>` +
    (D.state.runs || []).slice(0, 30).map((r) => `<tr><td>${when(r.at)}</td><td>${esc(r.mode)}</td><td class="num">${r.checked}</td><td class="num">${r.changed}</td><td class="num">${r.drops}</td><td class="num">${r.errors}</td><td class="num">${r.seconds}</td></tr>`).join('') +
    `</tbody>`;
}

function renderAll() {
  renderStatus();
  renderProducts();
  renderSummaries();
  renderDays();
  renderStores();
  renderSettings();
}

// ---------- actions ----------
const slug = (s) =>
  s.toLowerCase().replace(/[áàâä]/g, 'a').replace(/[éè]/g, 'e').replace(/í/g, 'i').replace(/[óö]/g, 'o').replace(/ú/g, 'u').replace(/ý/g, 'y').replace(/æ/g, 'ae').replace(/ð/g, 'd').replace(/þ/g, 'th')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

async function withBusy(btn, fn) {
  if (btn) btn.disabled = true;
  try {
    await fn();
  } catch (e) {
    toast('Villa: ' + e.message, 8000);
  } finally {
    if (btn) btn.disabled = false;
  }
}

const saveProducts = (fn, msg) => mutate('products.json', async (o) => ({ products: (await fn(o.products || [])) || o.products }), msg).then((o) => (D.products = o.products));

let editing = null;
function showForm(p = null) {
  editing = p?.id || null;
  const f = $('#add-form');
  f.reset();
  $('#add-title').textContent = p ? `Breyta: ${p.name}` : 'Ný vara';
  f.querySelector('button[type=submit]').textContent = p ? 'Vista breytingar' : 'Vista og leita í verslunum';
  if (p) for (const k of ['name', 'query', 'category', 'targetPrice', 'notes']) f.elements[k].value = p[k] ?? '';
  f.elements.urls.closest('label').hidden = !!p;
  f.hidden = false;
  f.elements.name.focus();
}

$('#btn-add').onclick = () => showForm();
$('#add-cancel').onclick = () => ($('#add-form').hidden = true);
$('#add-form').onsubmit = (e) => {
  e.preventDefault();
  const f = e.target;
  const v = Object.fromEntries(new FormData(f));
  const target = parseInt(String(v.targetPrice).replace(/\D/g, ''), 10) || null;
  withBusy(f.querySelector('button[type=submit]'), async () => {
    if (editing) {
      const id = editing;
      await saveProducts(
        (ps) => ps.map((p) => (p.id === id ? { ...p, name: v.name.trim(), query: (v.query || v.name).trim(), category: v.category.trim(), targetPrice: target, notes: v.notes.trim() } : p)),
        `Breyta vöru: ${v.name}`
      );
      toast('Vistað.');
    } else {
      const id = `${slug(v.name)}-${Math.random().toString(36).slice(2, 6)}`;
      const now = new Date().toISOString();
      const urls = String(v.urls || '').split(/\s+/).filter((u) => /^https?:\/\/[^/]+\.is(\/|$)/i.test(u));
      await saveProducts(
        (ps) => [...ps, { id, name: v.name.trim(), query: (v.query || v.name).trim(), category: v.category.trim(), notes: v.notes.trim(), paused: false, targetPrice: target, createdAt: now, offers: urls.map((url) => ({ url, addedAt: now })), rejected: [] }],
        `Ný vara: ${v.name}`
      );
      await dispatch({ discover: id, force: urls.length > 0 }).catch(() => {});
      open.add(id);
      LS.set('open', JSON.stringify([...open]));
      toast('Vara vistuð. Leit í verslunum er hafin og tillögur birtast eftir 5–15 mínútur.', 7000);
    }
    f.hidden = true;
    await refresh();
  });
};

$('#btn-check').onclick = (e) =>
  withBusy(e.target, async () => {
    if (!token()) throw new Error('Settu inn GitHub-lykil í Stillingum fyrst.');
    await dispatch({ force: true });
    toast('Athugun hafin. Niðurstöður birtast eftir nokkrar mínútur.');
  });

$('#products').addEventListener('click', (e) => {
  const tr = e.target.closest('tr.p');
  if (tr && !e.target.closest('a,button,input')) {
    const id = tr.dataset.id;
    open.has(id) ? open.delete(id) : open.add(id);
    LS.set('open', JSON.stringify([...open]));
    if (open.has(id) && D.cands[id]) setTimeout(() => LS.set('seen-cands-' + id, new Date().toISOString()), 3000);
    renderProducts();
    return;
  }
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const p = D.products.find((x) => x.id === b.dataset.pid);
  const act = b.dataset.act;
  const checked = () => $$(`input.cand[data-pid="${CSS.escape(p.id)}"]:checked`).map((c) => openCands(p)[+c.dataset.i]).filter(Boolean);
  withBusy(b, async () => {
    if (act === 'edit') return showForm(p);
    if (act === 'pause') {
      await saveProducts((ps) => ps.map((x) => (x.id === p.id ? { ...x, paused: !x.paused } : x)), `${p.paused ? 'Halda áfram' : 'Hlé'}: ${p.name}`);
    } else if (act === 'delete') {
      if (!confirm(`Eyða „${p.name}“ og allri verðsögu hennar?`)) return;
      await saveProducts((ps) => ps.filter((x) => x.id !== p.id), `Eyða vöru: ${p.name}`);
    } else if (act === 'research') {
      if (!token()) throw new Error('Settu inn GitHub-lykil í Stillingum fyrst.');
      await dispatch({ discover: p.id });
      toast('Leit hafin. Nýjar tillögur birtast eftir 5–15 mínútur.');
      return;
    } else if (act === 'selall') {
      $$(`input.cand[data-pid="${CSS.escape(p.id)}"]`).forEach((c) => (c.checked = true));
      return;
    } else if (act === 'accept' || act === 'reject') {
      const sel = checked();
      if (!sel.length) throw new Error('Veldu fyrst eina eða fleiri tillögur.');
      const now = new Date().toISOString();
      await saveProducts(
        (ps) =>
          ps.map((x) =>
            x.id !== p.id
              ? x
              : act === 'accept'
                ? { ...x, offers: [...(x.offers || []), ...sel.filter((s) => !(x.offers || []).some((o) => canonicalUrl(o.url) === canonicalUrl(s.url))).map((s) => ({ url: s.url, addedAt: now }))] }
                : { ...x, rejected: [...new Set([...(x.rejected || []), ...sel.map((s) => s.url)])] }
          ),
        `${act === 'accept' ? 'Vakta' : 'Hafna'} ${sel.length} tillögum: ${p.name}`
      );
      if (act === 'accept') {
        await dispatch({ force: true }).catch(() => {});
        toast(`${sel.length} ${sel.length === 1 ? 'verslun bætt' : 'verslunum bætt'} við. Verð sótt eftir nokkrar mínútur.`);
      }
    } else if (act === 'rm-offer') {
      if (!confirm('Hætta að vakta þessa verslun fyrir vöruna?')) return;
      await saveProducts((ps) => ps.map((x) => (x.id === p.id ? { ...x, offers: x.offers.filter((o) => o.url !== b.dataset.url), rejected: [...(x.rejected || []), b.dataset.url] } : x)), `Fjarlægja verslun: ${p.name}`);
    }
    await refresh();
  });
});

$('#products').addEventListener('submit', (e) => {
  const f = e.target.closest('form[data-act="add-url"]');
  if (!f) return;
  e.preventDefault();
  const url = f.elements.url.value.trim();
  const p = D.products.find((x) => x.id === f.dataset.pid);
  withBusy(f.querySelector('button'), async () => {
    if (!/^https?:\/\/[^/]+\.is(\/|$)/i.test(url)) throw new Error('Aðeins íslenskar síður (.is).');
    await saveProducts((ps) => ps.map((x) => (x.id === p.id ? { ...x, offers: [...(x.offers || []), { url, addedAt: new Date().toISOString() }] } : x)), `Bæta við slóð: ${p.name}`);
    await dispatch({ force: true }).catch(() => {});
    toast('Slóð bætt við. Verð sótt eftir nokkrar mínútur.');
    await refresh();
  });
});

$('#filter').oninput = renderProducts;
$('#cat-filter').onchange = renderProducts;

$('#day-form').onsubmit = (e) => {
  e.preventDefault();
  const v = Object.fromEntries(new FormData(e.target));
  withBusy(e.target.querySelector('button'), async () => {
    D.sale = await mutate('sale-days.json', (s) => ({ ...s, events: [...(s.events || []), { name: v.name.trim(), start: v.start, end: v.end || v.start }] }), `Afsláttardagur: ${v.name}`);
    e.target.reset();
    renderDays();
    renderStatus();
  });
};
$('#int-form').onsubmit = (e) => {
  e.preventDefault();
  const v = Object.fromEntries(new FormData(e.target));
  withBusy(e.target.querySelector('button'), async () => {
    D.sale = await mutate('sale-days.json', (s) => ({ ...s, normalIntervalHours: +v.normalIntervalHours || 3, saleIntervalMin: Math.max(30, +v.saleIntervalMin || 30), windowBeforeHours: +v.windowBeforeHours || 0, windowAfterHours: +v.windowAfterHours || 0 }), 'Breyta tíðni athugana');
    toast('Vistað.');
    renderDays();
    renderStatus();
  });
};
$('#days').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act="rm-day"]');
  if (!b) return;
  withBusy(b, async () => {
    D.sale = await mutate('sale-days.json', (s) => ({ ...s, events: s.events.filter((x) => !(x.start === b.dataset.start && x.name === b.dataset.name)) }), `Eyða afsláttardegi: ${b.dataset.name}`);
    renderDays();
  });
});

$('#store-form').onsubmit = (e) => {
  e.preventDefault();
  const v = Object.fromEntries(new FormData(e.target));
  const domain = v.domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  withBusy(e.target.querySelector('button'), async () => {
    D.stores = await mutate(
      'stores.json',
      (s) => {
        if (s.stores.some((x) => x.domain === domain)) throw new Error('Verslunin er þegar á listanum.');
        return { ...s, stores: [...s.stores, { domain, name: v.name.trim() || domain, cat: v.cat.trim(), ...(v.marketplace ? { marketplace: true } : {}), addedByUser: true }] };
      },
      `Ný verslun: ${domain}`
    );
    e.target.reset();
    renderStores();
    toast('Verslun bætt við. Hún verður með í næstu leit.');
  });
};
$('#stores').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act="toggle-store"]');
  if (!b) return;
  withBusy(b, async () => {
    D.stores = await mutate('stores.json', (s) => ({ ...s, stores: s.stores.map((x) => (x.domain === b.dataset.domain ? { ...x, disabled: !x.disabled } : x)) }), `Kveikja/slökkva á verslun: ${b.dataset.domain}`);
    renderStores();
  });
});

$('#token-form').onsubmit = (e) => {
  e.preventDefault();
  const t = e.target.elements.token.value.trim();
  if (!t) return;
  LS.set('token', t);
  withBusy(e.target.querySelector('button'), async () => {
    const r = await gh('');
    if (r.status === 404) throw new Error(`Fann ekki repo-ið ${CFG.owner}/${CFG.repo} með þessum lykli.`);
    const j = await r.json();
    if (!j.permissions?.push) throw new Error('Lykillinn hefur ekki skrifaðgang (Contents: Read and write).');
    e.target.reset();
    toast('Lykill virkar og er vistaður.');
    await refresh();
  }).catch(() => {});
};
$('#token-clear').onclick = () => {
  LS.set('token', null);
  renderAll();
};

// tabs
function showTab(name) {
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  $$('main > section').forEach((s) => (s.hidden = s.id !== 'tab-' + name));
  LS.set('tab', name);
  if (name === 'breytingar') {
    const latest = D.summaries.items?.[0]?.at;
    if (latest) setTimeout(() => LS.set('seen-summary', latest), 4000);
  }
}
$('#tabs').onclick = (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) showTab(b.dataset.tab);
};
document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-goto]');
  if (g) {
    e.preventDefault();
    showTab(g.dataset.goto);
  }
});

async function refresh() {
  await loadAll();
  D.hist = {};
  renderAll();
}

showTab(LS.get('tab', 'vorur'));
await refresh();
setInterval(() => {
  if (!document.hidden && $('#add-form').hidden) refresh();
}, 5 * 60e3);
