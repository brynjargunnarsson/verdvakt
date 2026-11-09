import { parsePrice } from './util.js';

const OOS = /OutOfStock|SoldOut|Discontinued/i;

function* walkLd(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) yield* walkLd(n);
    return;
  }
  yield node;
  for (const k of ['@graph', 'mainEntity', 'itemListElement', 'item', 'hasVariant']) {
    if (node[k]) yield* walkLd(node[k]);
  }
}

function isType(n, t) {
  const ty = n['@type'];
  return Array.isArray(ty) ? ty.includes(t) : ty === t;
}

/** Structured data: JSON-LD Product/Offer, OpenGraph/product meta, microdata. */
export function extractStructured(html) {
  const out = { source: null, price: null, wasPrice: null, available: null, title: null, currency: null };
  const offers = [];
  let title = null;

  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let json;
    try {
      json = JSON.parse(m[1].trim().replace(/[\u0000-\u001f]/g, ' '));
    } catch {
      continue;
    }
    for (const n of walkLd(json)) {
      if (isType(n, 'Product') || isType(n, 'ProductGroup')) {
        title ||= n.name;
        const list = [].concat(n.offers || []);
        for (const o of list) {
          for (const off of [].concat(o.offers || o)) {
            const p = parsePrice(off.price ?? off.lowPrice ?? off.priceSpecification?.price);
            if (p) offers.push({ price: p, currency: off.priceCurrency, oos: OOS.test(off.availability || '') });
          }
        }
      }
    }
  }
  if (offers.length) {
    const inStock = offers.filter((o) => !o.oos);
    const pool = inStock.length ? inStock : offers;
    const best = pool.reduce((a, b) => (b.price < a.price ? b : a));
    Object.assign(out, {
      source: 'json-ld',
      price: best.price,
      currency: best.currency || null,
      available: inStock.length > 0,
      title,
    });
    return out;
  }

  const meta = (prop) => {
    const r = new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${prop}["'][^>]*>`, 'i');
    const tag = html.match(r)?.[0];
    return tag?.match(/content=["']([^"']*)["']/i)?.[1] ?? null;
  };
  const mp = parsePrice(meta('product:sale_price:amount') || meta('product:price:amount') || meta('og:price:amount'));
  if (mp) {
    const reg = parsePrice(meta('product:original_price:amount'));
    return {
      source: 'meta',
      price: mp,
      wasPrice: reg && reg > mp ? reg : null,
      currency: meta('product:price:currency') || meta('og:price:currency'),
      available: /out ?of ?stock|oos/i.test(meta('product:availability') || meta('og:availability') || '') ? false : null,
      title: meta('og:title'),
    };
  }
  const ip = html.match(/itemprop=["']price["'][^>]*content=["']([^"']+)["']/i) || html.match(/content=["']([^"']+)["'][^>]*itemprop=["']price["']/i);
  if (ip && parsePrice(ip[1])) return { ...out, source: 'microdata', price: parsePrice(ip[1]) };
  return out;
}

/**
 * Runs inside the browser. Finds the main product price near the <h1>.
 * Returns { price, wasPrice, memberPrice, available, title } or null.
 */
export function pageProbe() {
  const PRICE = /(\d{1,3}(?:[.\s ]\d{3})+|\d{3,7})(?:,-|,00)?\s*(?:kr\.?|ISK|krónur)(?![a-zá-ú])/i;
  const PRICE_G = new RegExp(PRICE.source, 'gi');
  const OLD = /\b(old|was|before|compare|regular|original|strike|line-through|previous|fyrra|adur|retail|list-price)\b/i;
  const MEMBER = /(klúbb|vildar|félaga|meðlima|member|áskrif)/i;
  const BAD_AREA = 'header, nav, footer, [class*="related"], [class*="upsell"], [class*="cross"], [class*="recommend"], [class*="carousel"], [class*="slider"], [id*="related"], [class*="cart"], [class*="minicart"]';
  const num = (s) => {
    const m = s.match(PRICE);
    if (!m) return null;
    return parseInt(m[1].replace(/[.\s ]/g, ''), 10) || null;
  };
  const visible = (e) => {
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const isOld = (e) => {
    for (let x = e, i = 0; x && i < 4; x = x.parentElement, i++) {
      if (/^(S|DEL|STRIKE)$/.test(x.tagName)) return true;
      if (OLD.test((x.className && x.className.baseVal === undefined ? x.className : '') + ' ' + (x.id || ''))) return true;
      if (getComputedStyle(x).textDecorationLine.includes('line-through')) return true;
    }
    return false;
  };
  const h1s = [...document.querySelectorAll('h1')].filter((h) => visible(h) && !h.closest('header, nav, footer'));
  const h1 = h1s[0] || null;

  // Leaf-ish elements whose own text is a price.
  const cands = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  while (walker.nextNode()) {
    const t = walker.currentNode;
    if (!/\d/.test(t.nodeValue)) continue;
    let el = t.parentElement;
    if (!el || seen.has(el)) continue;
    // climb while the text is small so "34.990" + "<span>kr.</span>" combine
    let txt = el.textContent.trim();
    while (!PRICE.test(txt) && el.parentElement && el.parentElement.textContent.trim().length < 40) {
      el = el.parentElement;
      txt = el.textContent.trim();
    }
    if (!PRICE.test(txt) || txt.length > 80 || seen.has(el)) continue;
    seen.add(el);
    if (!visible(el) || el.closest(BAD_AREA)) continue;
    const label = (el.parentElement?.parentElement?.textContent || '').slice(0, 200);
    cands.push({ el, price: num(txt), old: isOld(el), member: MEMBER.test(label) && !/verð\s*$/i.test(label) && MEMBER.test(el.parentElement?.textContent || '') });
  }
  if (!cands.length) return null;

  let chosen = cands;
  if (h1) {
    // Prefer prices sharing the deepest common ancestor with the h1.
    const depthOfCommon = (a) => {
      const anc = new Set();
      for (let x = h1; x; x = x.parentElement) anc.add(x);
      let d = 0;
      let x = a;
      while (x && !anc.has(x)) x = x.parentElement;
      for (; x; x = x.parentElement) d++;
      return d;
    };
    let best = -1;
    for (const c of cands) {
      c.depth = depthOfCommon(c.el);
      best = Math.max(best, c.depth);
    }
    chosen = cands.filter((c) => c.depth === best);
    // take the cluster closest after h1 in document order
    const after = chosen.filter((c) => h1.compareDocumentPosition(c.el) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (after.length) chosen = after.slice(0, 4);
    else chosen = chosen.slice(0, 4);
  } else {
    chosen = cands.slice(0, 3);
  }
  const cur = chosen.filter((c) => !c.old && !c.member && c.price);
  const old = chosen.filter((c) => c.old && c.price);
  const mem = chosen.filter((c) => c.member && c.price);
  if (!cur.length) return null;
  const price = Math.min(...cur.map((c) => c.price));
  const wasPrice = old.length ? Math.max(...old.map((c) => c.price)) : null;
  const memberPrice = mem.length ? Math.min(...mem.map((c) => c.price)) : null;

  const body = (document.querySelector('main') || document.body).innerText.slice(0, 20000);
  const oos = /(uppselt|ekki til á lager|ekki á lager|ekki til í vefverslun|out of stock|sold out|væntanleg)/i.test(
    (h1?.parentElement?.parentElement?.innerText || body).slice(0, 3000)
  );
  return {
    price,
    wasPrice: wasPrice && wasPrice > price ? wasPrice : null,
    memberPrice: memberPrice && memberPrice < price ? memberPrice : null,
    available: oos ? false : null,
    title: h1?.innerText.trim() || document.title,
    allPrices: [...body.matchAll(PRICE_G)].length,
  };
}

/**
 * Runs inside the browser on a search/listing page. Returns product cards
 * [{ href, title, price }] where each card has a link and a price.
 */
export function cardProbe() {
  const PRICE = /(\d{1,3}(?:[.\s ]\d{3})+|\d{3,7})(?:,-|,00)?\s*(?:kr\.?|ISK)(?![a-zá-ú])/i;
  const OLD = /\b(old|was|before|compare|regular|original|strike|previous)\b/i;
  const host = location.hostname.replace(/^www\./, '');
  const out = new Map();
  const anchors = [...document.querySelectorAll('a[href]')].filter((a) => {
    if (a.closest('header, nav, footer, [role="navigation"]')) return false;
    let u;
    try {
      u = new URL(a.href, location.href);
    } catch {
      return false;
    }
    if (u.hostname.replace(/^www\./, '') !== host) return false;
    if (u.pathname === '/' || /\/(search|leit|cart|karfa|account|login|innskraning)(\/|$)/i.test(u.pathname)) return false;
    return true;
  });
  for (const a of anchors) {
    const href = new URL(a.href, location.href);
    href.hash = '';
    const key = href.toString();
    if (out.has(key)) continue;
    let card = a;
    for (let i = 0; i < 7 && card; i++) {
      if (PRICE.test(card.innerText || '')) break;
      card = card.parentElement;
    }
    if (!card || !PRICE.test(card.innerText || '')) continue;
    const links = new Set(
      [...card.querySelectorAll('a[href]')].map((x) => {
        try {
          const u = new URL(x.href, location.href);
          u.hash = '';
          return u.toString();
        } catch {
          return '';
        }
      })
    );
    if (links.size > 3) continue; // ancestor too big: a whole grid
    // Prefer the link that looks like a product page over brand/category links in the card.
    const PROD = /\/(products?|vara|vorur|vöru|shop|p|item|is\/product)\/[^/]+/i;
    const CAT = /\/(collections|categories|category|flokkar|vorumerki|brands?)\/?[^/]*\/?$/i;
    let best = key;
    const arr = [...links].filter(Boolean);
    best = arr.find((l) => PROD.test(new URL(l).pathname) && !CAT.test(new URL(l).pathname)) || arr.find((l) => !CAT.test(new URL(l).pathname)) || key;
    if (best !== key && out.has(best)) continue;
    if ((card.innerText || '').length > 700) continue;
    const prices = [];
    card.querySelectorAll('*').forEach((e) => {
      if (e.children.length > 2) return;
      const t = (e.innerText || '').trim();
      if (t.length > 40) return;
      const m = t.match(PRICE);
      if (!m) return;
      const old =
        /^(S|DEL|STRIKE)$/.test(e.tagName) ||
        !!e.closest('s, del, strike') ||
        OLD.test(String(e.className)) ||
        getComputedStyle(e).textDecorationLine.includes('line-through');
      prices.push({ v: parseInt(m[1].replace(/[.\s ]/g, ''), 10), old });
    });
    const cur = prices.filter((p) => !p.old && p.v);
    if (!cur.length) continue;
    const notPrice = (t) => (t && !PRICE.test(t) && /[a-zá-ú]{2}/i.test(t) ? t : '');
    const slug = decodeURIComponent(new URL(best).pathname.split('/').filter(Boolean).pop() || '').replace(/[-_]+/g, ' ');
    const title =
      [...card.querySelectorAll('h1,h2,h3,h4,[class*="title"],[class*="name"]')].map((e) => notPrice(e.innerText?.trim())).find(Boolean) ||
      notPrice(a.getAttribute('title')) ||
      notPrice(a.innerText.trim().split('\n')[0]) ||
      notPrice(card.querySelector('img')?.alt) ||
      slug;
    out.set(best, { href: best, title: title.replace(/\s+/g, ' ').slice(0, 200), price: Math.min(...cur.map((p) => p.v)) });
  }
  return [...out.values()];
}
