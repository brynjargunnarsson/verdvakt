import { fetchHtml, render } from './browser.js';
import { extractStructured, pageProbe } from './extract.js';

const decodeEnt = (t) =>
  String(t || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

/**
 * WooCommerce shops expose a public storefront API (the one their own product blocks use).
 * Handy when the page itself is behind a bot challenge. Only for /product/<slug>/ URLs.
 */
async function wooStorePrice(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const m = u.pathname.match(/\/product\/([^/]+)\/?$/);
  if (!m) return null;
  const r = await fetchHtml(`${u.origin}/wp-json/wc/store/v1/products?slug=${encodeURIComponent(m[1])}`).catch(() => null);
  if (!r || r.status !== 200 || !r.type.includes('json')) return null;
  let p;
  try {
    p = JSON.parse(r.text)?.[0];
  } catch {
    return null;
  }
  if (!p?.prices || (p.prices.currency_code && p.prices.currency_code !== 'ISK')) return null;
  const minor = p.prices.currency_minor_unit ?? 0;
  const f = (x) => {
    const n = parseInt(x, 10);
    return Number.isFinite(n) && n > 0 ? Math.round(n / 10 ** minor) : null;
  };
  const price = f(p.prices.price);
  if (!price) return null;
  const was = f(p.prices.regular_price);
  return {
    ok: true,
    price,
    source: 'woocommerce',
    wasPrice: was && was > price ? was : null,
    memberPrice: null,
    available: p.is_in_stock !== false && p.is_purchasable !== false,
    title: decodeEnt(p.name).trim().slice(0, 200),
  };
}

/**
 * Read the current price of a product page.
 * thorough=true always renders the page in a browser as well (used around sale days),
 * since some stores only show the discounted price via JavaScript.
 */
export async function getPrice(url, { thorough = false } = {}) {
  let st = null;
  let staticErr = null;
  try {
    const r = await fetchHtml(url);
    if (r.status >= 400) staticErr = `HTTP ${r.status}`;
    else st = extractStructured(r.text);
    if (r.status === 404 || r.status === 410) return { ok: false, error: 'Síða fannst ekki (404)', gone: true };
  } catch (e) {
    staticErr = e.name === 'AbortError' ? 'Tímamörk' : e.message;
  }
  if (st?.currency && !/ISK/i.test(st.currency)) st = null; // only ISK prices

  // The store's page is blocked or has no price: try its public WooCommerce API before a browser.
  if (!st?.price) {
    const w = await wooStorePrice(url);
    if (w) return w;
  }

  let dom = null;
  // A structured "OutOfStock" is checked against the visible page: several shops get it wrong
  // (Byggt og búið marks every product OutOfStock while the page sells it normally).
  if (!st?.price || thorough || staticErr || st?.available === false) {
    try {
      const r = await render(url, pageProbe);
      if (r.status === 404) return { ok: false, error: 'Síða fannst ekki (404)', gone: true };
      dom = r.result;
      if (!st?.price) {
        const st2 = extractStructured(r.html);
        if (st2.price && (!st2.currency || /ISK/i.test(st2.currency))) st = st2;
      }
    } catch (e) {
      if (!st?.price) return { ok: false, error: `Gat ekki opnað síðu: ${staticErr || e.message}`.slice(0, 200) };
    }
  }

  let price = st?.price ?? null;
  let source = st?.source ?? null;
  // The visible price wins if it's a plausible discount on the structured one.
  const saleConfirmed = dom?.wasPrice && price && Math.abs(dom.wasPrice - price) <= price * 0.03;
  if (dom?.price && (!price || (dom.price < price && (saleConfirmed || dom.price >= price * 0.6)))) {
    price = dom.price;
    source = price === st?.price ? source : 'síða';
  }
  if (!price) return { ok: false, error: 'Fann ekkert verð á síðunni' };
  return {
    ok: true,
    price,
    source,
    wasPrice: dom?.wasPrice ?? st?.wasPrice ?? null,
    memberPrice: dom?.memberPrice ?? null,
    available: availability(st, dom),
    title: (st?.title || dom?.title || '').trim().slice(0, 200),
  };
}

/**
 * What the visitor sees beats what the page's metadata claims:
 *  - visible "uppselt / ekki á lager" text → unavailable
 *  - otherwise a working add-to-basket button → available, even if the metadata says OutOfStock
 *  - otherwise believe the metadata
 */
function availability(st, dom) {
  if (dom?.available === false) return false;
  if (dom?.canBuy) return true;
  return st?.available !== false;
}
