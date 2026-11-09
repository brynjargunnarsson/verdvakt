import { render, fetchHtml, getBrowser, UA } from './browser.js';
import { cardProbe } from './extract.js';
import { matchScore, hostOf, sleep } from './util.js';

// Common search URL shapes on Icelandic stores, tried if the search box can't be used.
export const SEARCH_PATTERNS = [
  '/search?q={q}',
  '/leit?q={q}',
  '/?s={q}&post_type=product',
  '/catalogsearch/result/?q={q}',
  '/is/search?q={q}',
  '/leit/?q={q}',
  '/search?query={q}',
];

const SEARCH_INPUT =
  'input[type="search"], input[name="q"], input[name="s"], input[name="search"], input[name="query"], input[name="leit"], ' +
  'input[placeholder*="eita" i], input[placeholder*="earch" i], input[aria-label*="eit" i], input[aria-label*="earch" i]';
const SEARCH_TOGGLE =
  'button[aria-label*="eit" i], a[aria-label*="eit" i], button[aria-label*="earch" i], [class*="search-toggle"], ' +
  'button[class*="search"], a[class*="search"], [class*="search"] > button, [data-action*="search"]';

export function buildUrl(base, pattern, q) {
  const enc = encodeURIComponent(q);
  return pattern.startsWith('http') ? pattern.replace('{q}', enc) : base.replace(/\/$/, '') + pattern.replace('{q}', enc);
}

/** Shopify stores have a JSON search endpoint — fast and exact. */
async function shopifySearch(base, q) {
  const url = `${base}/search/suggest.json?q=${encodeURIComponent(q)}&resources%5Btype%5D=product&resources%5Blimit%5D=10`;
  const r = await fetchHtml(url);
  if (r.status !== 200 || !r.type.includes('json')) return null;
  const prods = JSON.parse(r.text)?.resources?.results?.products;
  if (!Array.isArray(prods)) return null;
  return prods.map((p) => ({
    href: new URL(p.url.split('?')[0], base).toString(),
    title: [p.vendor, p.title].filter(Boolean).join(' '),
    price: Math.round(parseFloat(p.price_min ?? p.price)) || null,
  }));
}

/** WooCommerce Store API. Prices come in minor units. */
async function wooSearch(base, q) {
  const r = await fetchHtml(`${base}/wp-json/wc/store/v1/products?search=${encodeURIComponent(q)}&per_page=20`);
  if (r.status !== 200 || !r.type.includes('json')) return null;
  const arr = JSON.parse(r.text);
  if (!Array.isArray(arr)) return null;
  return arr.map((p) => {
    const minor = p.prices?.currency_minor_unit ?? 0;
    return {
      href: p.permalink,
      title: String(p.name || '').replace(/<[^>]+>/g, ''),
      price: Math.round(parseInt(p.prices?.price, 10) / 10 ** minor) || null,
    };
  });
}

async function htmlSearch(url) {
  const r = await render(url, cardProbe, { settle: 3000 });
  if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
  return r.result || [];
}

/**
 * Use the store's own search box like a person would. Returns
 * { cards, template } — template is a reusable URL with {q} if the search navigated.
 */
async function typeSearch(base, q) {
  const browser = await getBrowser();
  const ctx = await browser.newContext({ userAgent: UA, locale: 'is-IS', viewport: { width: 1366, height: 1000 } });
  const page = await ctx.newPage();
  await page.route('**/*', (r) => (['image', 'media', 'font'].includes(r.request().resourceType()) ? r.abort() : r.continue()));
  try {
    const resp = await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 35000 });
    if (resp && resp.status() >= 400) throw Object.assign(new Error(`HTTP ${resp.status()}`), { unreachable: true });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page
      .locator('button:has-text("Samþykkja"), button:has-text("Leyfa allar"), button:has-text("Accept")')
      .first()
      .click({ timeout: 1000 })
      .catch(() => {});
    let inp = page.locator(SEARCH_INPUT).filter({ visible: true }).first();
    if (!(await inp.count())) {
      await page.locator(SEARCH_TOGGLE).filter({ visible: true }).first().click({ timeout: 2500 }).catch(() => {});
      await sleep(800);
      inp = page.locator(SEARCH_INPUT).filter({ visible: true }).first();
    }
    if (!(await inp.count())) return null;
    await inp.click({ timeout: 3000 }).catch(() => {});
    await inp.fill(q);
    const before = page.url();
    await Promise.all([page.waitForURL((u) => u.toString() !== before, { timeout: 10000 }).catch(() => {}), inp.press('Enter')]);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await sleep(3000);
    const cards = await page.evaluate(cardProbe);
    let template = null;
    const after = page.url();
    if (after !== before) {
      for (const v of [encodeURIComponent(q), q.replace(/ /g, '+'), encodeURIComponent(q).replace(/%20/g, '+'), q]) {
        if (after.includes(v)) {
          const origin = new URL(after).origin;
          template = after.slice(origin.length).replace(v, '{q}');
          break;
        }
      }
    }
    return { cards, template };
  } finally {
    await ctx.close().catch(() => {});
  }
}

function scoreList(base, query, list, minScore) {
  return list
    .filter((x) => x.href && hostOf(x.href) === hostOf(base))
    .map((x) => {
      let path = '';
      try {
        path = decodeURIComponent(new URL(x.href).pathname).replace(/[-_/]/g, ' ');
      } catch {}
      return { ...x, score: matchScore(query, `${x.title} ${path}`) };
    })
    .filter((x, i, arr) => x.score >= minScore && arr.findIndex((y) => y.href === x.href) === i)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

/**
 * Search a store for `query`. `store` = { domain, kind?, searchUrl? }.
 * Returns { results:[{href,title,price,score}], learned:{kind,searchUrl}|null, failed?, error? }.
 * `learned` is how the search worked, so next time it's fast.
 */
async function searchStoreInner(store, query, { minScore = 0.6 } = {}) {
  const base = `https://${store.domain}`;
  const score = (list) => scoreList(base, query, list, minScore);

  if (store.kind === 'shopify' || store.kind === 'woo') {
    const res = await (store.kind === 'shopify' ? shopifySearch : wooSearch)(base, query).catch(() => null);
    if (res) return { results: score(res), learned: null };
  } else if (store.kind === 'html' && store.searchUrl) {
    try {
      return { results: score(await htmlSearch(buildUrl(base, store.searchUrl, query))), learned: null };
    } catch (e) {
      return { results: [], learned: null, failed: true, error: e.message };
    }
  } else if (store.kind === 'type') {
    const r = await typeSearch(base, query).catch(() => null);
    if (r) return { results: score(r.cards), learned: null };
  }

  // Auto-detect.
  for (const [kind, fn] of [
    ['shopify', shopifySearch],
    ['woo', wooSearch],
  ]) {
    const res = await fn(base, query).catch(() => null);
    if (res) return { results: score(res), learned: { kind } };
  }
  let unreachable = null;
  const typed = await typeSearch(base, query).catch((e) => {
    // The site itself can't be reached (DNS, 403, timeout on the front page) – that's a real failure.
    unreachable = e.message;
    return null;
  });
  if (unreachable && !/Timeout|locator/i.test(unreachable)) return { results: [], learned: null, failed: true, error: unreachable.slice(0, 120) };
  if (typed?.template) return { results: score(typed.cards), learned: { kind: 'html', searchUrl: typed.template } };
  if (typed?.cards?.length) return { results: score(typed.cards), learned: { kind: 'type' } };
  for (const pattern of SEARCH_PATTERNS) {
    const res = await htmlSearch(buildUrl(base, pattern, query)).catch(() => null);
    const scored = res ? score(res) : [];
    if (scored.length) return { results: scored, learned: { kind: 'html', searchUrl: pattern } };
  }
  // The store answered but no search was found or nothing matched. Not a failure:
  // most stores simply don't sell most products. Detection is retried next time.
  return { results: [], learned: null, unknown: true };
}

/**
 * Search a store. Stores may also list fixed pages (`listUrls`, e.g. a deals or
 * gift-card page) that are read every time and matched against the query —
 * useful for sites whose own search doesn't work. kind 'list' = only those pages.
 */
export async function searchStore(store, query, opts = {}) {
  const minScore = opts.minScore ?? 0.6;
  const fromLists = [];
  let listOk = false;
  for (const path of store.listUrls || []) {
    const url = path.startsWith('http') ? path : `https://${store.domain}${path}`;
    const cards = await htmlSearch(url).catch(() => null);
    if (cards) {
      listOk = true;
      fromLists.push(...cards);
    }
  }
  const lists = scoreList(`https://${store.domain}`, query, fromLists, minScore);
  if (store.kind === 'list') {
    return listOk ? { results: lists, learned: null } : { results: [], learned: null, failed: true, error: 'Gat ekki lesið tilboðslista' };
  }
  const r = await searchStoreInner(store, query, opts);
  if (!store.listUrls?.length) return r;
  const seen = new Set(r.results.map((x) => x.href));
  const merged = [...r.results, ...lists.filter((x) => !seen.has(x.href))].sort((a, b) => b.score - a.score).slice(0, 12);
  return listOk ? { results: merged, learned: r.learned } : r;
}
