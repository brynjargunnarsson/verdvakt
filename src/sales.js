// Around sale days: look at each store's front page for sale landing pages
// ("Black Friday", "Tilboð", "11.11" ...) and advertised discount codes.
import { render } from './browser.js';
import { cardProbe } from './extract.js';
import { matchScore, nowIso, minScoreFor } from './util.js';

const SALE_WORDS = /(black ?friday|svart(ur|a) ?(föss|fös|vik)|cyber ?monday|singles|11[.\s]?11|dagur einhleypra|tilbo[ðd]|afsl[áa]tt|útsal|utsal|sale|deals?)/i;

/** Runs in the page: sale links + text that may contain discount codes. */
function frontProbe(words) {
  const re = new RegExp(words, 'i');
  const host = location.hostname;
  const links = [];
  for (const a of document.querySelectorAll('a[href]')) {
    const t = `${a.innerText} ${a.getAttribute('aria-label') || ''} ${a.href}`;
    try {
      const u = new URL(a.href, location.href);
      if (u.hostname !== host || u.pathname === '/') continue;
      if (re.test(t)) links.push(u.origin + u.pathname + u.search);
    } catch {}
  }
  return { links: [...new Set(links)].slice(0, 6), text: document.body.innerText.slice(0, 30000) };
}

const STOP = new Set(['KR', 'ISK', 'HTTP', 'HTTPS', 'WWW', 'SALE', 'BLACK', 'FRIDAY', 'CYBER', 'MONDAY', 'TILBOÐ', 'OKKAR', 'ALLT', 'VEFVERSLUN']);

/** Pull "afsláttarkóði BF20 gefur 20%" style codes out of page text. */
export function findCodes(text) {
  const out = new Map();
  const re = /(?:[Aa]fsl[áa]ttark[óo]ð\w*|[Kk][óo]ð(?:i|ann|anum|inn|a)|[Cc]ode|CODE|KÓÐI)\s*(?:er|:|–|-|„|"|')?\s*[„"'“]?([A-Z0-9ÁÉÍÓÚÝÞÆÖ]{3,20})\b/g;
  for (const m of text.matchAll(re)) {
    const code = m[1];
    if (STOP.has(code) || /^\d+$/.test(code)) continue;
    const ctx = text.slice(Math.max(0, m.index - 120), m.index + 160).replace(/\s+/g, ' ');
    const after = text.slice(m.index, m.index + 120).match(/(\d{1,2})\s?%/);
    const before = [...text.slice(Math.max(0, m.index - 100), m.index).matchAll(/(\d{1,2})\s?%/g)].pop();
    const pct = after || before;
    out.set(code, { code, pct: pct ? +pct[1] : null, text: ctx.trim().slice(0, 220) });
  }
  return [...out.values()].slice(0, 5);
}

/**
 * Scan one store. Returns { codes, salePages, matches:[{productId,url,title,price,score}] }.
 */
export async function scanStore(store, products) {
  const front = await render(`https://${store.domain}/`, `(${frontProbe.toString()})(${JSON.stringify(SALE_WORDS.source)})`);
  const { links = [], text = '' } = front.result || {};
  const codes = findCodes(text);
  const matches = [];
  for (const url of links.slice(0, 4)) {
    const r = await render(url, cardProbe, { settle: 2500 }).catch(() => null);
    if (!r) continue;
    codes.push(...findCodes(r.html.replace(/<[^>]+>/g, ' ')).filter((c) => !codes.some((x) => x.code === c.code)));
    for (const card of r.result || []) {
      for (const p of products) {
        const s = matchScore(p.query || p.name, card.title + ' ' + decodeURIComponent(card.href).replace(/[-_/]/g, ' '));
        if (s >= minScoreFor(p.query || p.name)) matches.push({ productId: p.id, url: card.href, title: card.title, price: card.price, score: s });
      }
    }
  }
  return { checkedAt: nowIso(), codes: codes.slice(0, 6), salePages: links, matches };
}
