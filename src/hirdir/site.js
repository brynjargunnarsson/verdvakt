// Les vörur af godihirdirinn.is.
//
// Forsíðan (Next.js) sendir allan vörulistann með í síðugögnunum (RSC „flight“),
// líka þær vörur sem birtast fyrst þegar smellt er á „Hlaða inn eldri vörum“ –
// sá hnappur sækir ekkert nýtt. Ein fyrirspurn á forsíðuna dugar því yfirleitt.
// Ef síðugögnin breytast og finnast ekki er lesið úr sýnilegu vöruspjöldunum
// og lýsingin sótt af hverri vörusíðu (JSON-LD).

export const ORIGIN = 'https://godihirdirinn.is';
export const USER_AGENT = process.env.HIRDIR_USER_AGENT || 'verdvakt-bot/0.1';
const MIN_GAP_MS = Number(process.env.HIRDIR_GAP_MS || 2500);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- robots.txt ----------

/** Skilar reglum (allow/disallow) sem eiga við þennan user-agent. */
export function parseRobots(text, ua = USER_AGENT) {
  const groups = [];
  let cur = null;
  let inAgents = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      if (!inAgents) groups.push((cur = { agents: [], rules: [], delay: null }));
      cur.agents.push(val.toLowerCase());
      inAgents = true;
    } else if (cur) {
      inAgents = false;
      if (key === 'allow' || key === 'disallow') {
        if (val) cur.rules.push({ allow: key === 'allow', path: val });
      } else if (key === 'crawl-delay' && Number(val) > 0) cur.delay = Number(val);
    }
  }
  const name = ua.toLowerCase().split('/')[0];
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && name.includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes('*'));
  return {
    rules: chosen.flatMap((g) => g.rules),
    crawlDelayMs: Math.max(0, ...chosen.map((g) => (g.delay || 0) * 1000)),
  };
}

function ruleMatches(rulePath, target) {
  const anchored = rulePath.endsWith('$');
  const src = (anchored ? rulePath.slice(0, -1) : rulePath)
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp('^' + src + (anchored ? '$' : '')).test(target);
}

/** Lengsta regla sem passar ræður; Allow vinnur jafntefli. Engin regla = leyft. */
export function isAllowed(robots, url) {
  const u = new URL(url);
  const target = u.pathname + u.search;
  let best = null;
  for (const r of robots.rules) {
    if (!ruleMatches(r.path, target)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}

// ---------- kurteis sækjari ----------

export function createClient({ fetchImpl = fetch, gapMs = MIN_GAP_MS, log = () => {} } = {}) {
  let last = 0;
  let robots = null;
  let requests = 0;

  async function raw(url) {
    const wait = last + Math.max(gapMs, robots?.crawlDelayMs || 0) - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    requests++;
    log(`GET ${url}`);
    const res = await fetchImpl(url, {
      headers: { 'user-agent': USER_AGENT, 'accept-language': 'is,en;q=0.8', accept: 'text/html,*/*;q=0.8' },
      redirect: 'follow',
      signal: AbortSignal.timeout(45000),
    });
    return { status: res.status, text: await res.text() };
  }

  async function loadRobots() {
    if (robots) return robots;
    const res = await raw(`${ORIGIN}/robots.txt`);
    // 4xx = engar reglur; 5xx / annað = óvíst, þá hættum við frekar en að giska.
    if (res.status >= 500) throw new Error(`robots.txt svaraði ${res.status} – hætti við`);
    robots = parseRobots(res.status === 200 ? res.text : '');
    return robots;
  }

  return {
    get requests() {
      return requests;
    },
    async get(url) {
      const r = await loadRobots();
      if (!isAllowed(r, url)) throw new Error(`robots.txt bannar ${url}`);
      const res = await raw(url);
      if (res.status !== 200) throw new Error(`${url} svaraði ${res.status}`);
      return res.text;
    },
  };
}

// ---------- þáttun ----------

/** Setur saman RSC-strauminn úr self.__next_f.push([1,"…"]) skriftunum. */
export function flightText(html) {
  let out = '';
  const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  for (let m; (m = re.exec(html)); ) {
    try {
      out += JSON.parse(m[1]);
    } catch {
      /* skemmdur bútur – sleppa */
    }
  }
  return out;
}

/** Les JSON-gildi sem byrjar á text[start] ('[' eða '{') og skilar því þáttuðu. */
function jsonValueAt(text, start) {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      if (--depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error('ólokað JSON');
}

const str = (v) => (typeof v === 'string' && v && !v.startsWith('$') ? v.trim() : null);

function normalize(p) {
  const handle = str(p.handle);
  const price = Number.isFinite(p.price) ? Math.round(p.price) : null;
  if (!handle || !str(p.title) || price == null) return null;
  return {
    id: str(p.id) || handle,
    handle,
    url: `${ORIGIN}/vara/${handle}`,
    title: str(p.title),
    priceIsk: price,
    compareAtIsk: Number.isFinite(p.compareAtPrice) ? Math.round(p.compareAtPrice) : null,
    category: str(p.categoryName) || str(p.category),
    categorySlug: str(p.category),
    description: str(p.description),
    image: str(p.image) || (Array.isArray(p.images) ? str(p.images[0]) : null),
    images: Array.isArray(p.images) ? p.images.map(str).filter(Boolean) : [],
    condition: str(p.condition),
    conditionNotes: str(p.conditionNotes),
    itemCount: Number.isInteger(p.itemCount) ? p.itemCount : null,
    sold: p.status !== 'available',
    listedAt: str(p.relistedAt) || str(p.arrivedAt) || str(p.createdAt),
  };
}

/** Allur vörulistinn úr síðugögnum forsíðunnar, eða null ef hann finnst ekki. */
export function productsFromFlight(html) {
  const text = flightText(html);
  let best = null;
  for (let i = text.indexOf('"products":['); i !== -1; i = text.indexOf('"products":[', i + 1)) {
    try {
      const arr = jsonValueAt(text, i + '"products":'.length);
      const items = arr.map((p) => (p && typeof p === 'object' ? normalize(p) : null)).filter(Boolean);
      if (items.length && (!best || items.length > best.length)) best = items;
    } catch {
      /* ekki listinn sem við leitum að */
    }
  }
  return best;
}

const decode = (s) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
const textOf = (h) => decode(h.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Varaleið: sýnileg vöruspjöld á forsíðunni (án lýsingar). */
export function productsFromCards(html) {
  const out = [];
  for (const [card] of html.matchAll(/<article\b[\s\S]*?<\/article>/g)) {
    const handle = card.match(/href="\/vara\/([^"?#]+)"/)?.[1];
    if (!handle) continue;
    const title = decode(card.match(/<img[^>]*\salt="([^"]*)"/)?.[1] || '');
    const priceTxt = textOf(card).match(/(\d{1,3}(?:\.\d{3})*|\d+)\s*kr/)?.[1];
    const src = decode(card.match(/<img[^>]*\ssrc="([^"]+)"/)?.[1] || '');
    const inner = src.match(/[?&]url=([^&]+)/)?.[1];
    const divs = [...card.matchAll(/<div[^>]*>([^<]+)<\/div>/g)].map((m) => decode(m[1]).trim());
    if (!title || !priceTxt) continue;
    out.push({
      id: handle,
      handle,
      url: `${ORIGIN}/vara/${handle}`,
      title,
      priceIsk: Number(priceTxt.replace(/\./g, '')),
      compareAtIsk: null,
      category: divs.filter((d) => d !== title).pop() || null,
      categorySlug: null,
      description: null,
      image: inner ? decodeURIComponent(inner) : src ? new URL(src, ORIGIN).href : null,
      images: [],
      condition: null,
      conditionNotes: null,
      itemCount: null,
      sold: /<span[^>]*>\s*SELT\s*<\/span>/.test(card),
      listedAt: null,
    });
  }
  return out;
}

/** Lýsing, mynd, verð og staða af vörusíðu (schema.org Product í JSON-LD). */
export function detailsFromProductPage(html) {
  for (const [, body] of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      continue;
    }
    for (const node of [].concat(data)) {
      if (node?.['@type'] !== 'Product') continue;
      const offer = [].concat(node.offers || [])[0] || {};
      return {
        title: str(node.name),
        description: str(node.description),
        image: str([].concat(node.image || [])[0]),
        priceIsk: Number.isFinite(Number(offer.price)) ? Math.round(Number(offer.price)) : null,
        sold: offer.availability ? !/InStock/i.test(offer.availability) : null,
      };
    }
  }
  return null;
}
