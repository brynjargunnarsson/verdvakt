import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const DATA = path.join(ROOT, 'data');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function hash(s, n = 10) {
  return createHash('sha1').update(String(s)).digest('hex').slice(0, n);
}

export async function readJson(rel, fallback) {
  try {
    return JSON.parse(await readFile(path.join(DATA, rel), 'utf8'));
  } catch {
    return fallback;
  }
}

export async function writeJson(rel, obj) {
  const p = path.join(DATA, rel);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(obj, null, 1) + '\n');
}

/**
 * Parse an Icelandic/ISK price. Handles "34.990 kr.", "34 990 kr", "41.700",
 * "41700.0", "4.990,-", "4.990,00 kr", 41700.
 */
export function parsePrice(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
  let s = String(v).replace(/ | /g, ' ').trim();
  const m = s.match(/\d[\d.\s,]*/);
  if (!m) return null;
  s = m[0].trim().replace(/[\s]/g, '');
  s = s.replace(/,-$/, '').replace(/[.,]$/, '');
  let n;
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s)) n = parseFloat(s.replace(/\./g, '').replace(',', '.'));
  else if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(s)) n = parseFloat(s.replace(/,/g, ''));
  else if (/^\d+,\d{1,2}$/.test(s)) n = parseFloat(s.replace(',', '.'));
  else n = parseFloat(s.replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

const FOLD = { á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u', ý: 'y', ö: 'o', æ: 'ae', ð: 'd', þ: 'th' };
export function fold(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[áéíóúýöæðþ]/g, (c) => FOLD[c])
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');
}

export function tokens(s) {
  return fold(s)
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length > 1 || /\d/.test(t));
}

/** How well does `text` match `query`? 0..1. Numbers in the query are mandatory. */
export function matchScore(query, text) {
  const q = [...new Set(tokens(query))];
  if (!q.length) return 0;
  const t = new Set(tokens(text));
  const joined = tokens(text).join('');
  let hit = 0;
  for (const tok of q) {
    const ok = t.has(tok) || (tok.length >= 4 && joined.includes(tok));
    if (ok) hit++;
    else if (/\d/.test(tok)) return Math.min(0.4, hit / q.length); // model numbers must match
  }
  return hit / q.length;
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function fmtKr(n) {
  return n == null ? '–' : n.toLocaleString('de-DE') + ' kr.';
}

/** Run fn over items with limited concurrency. */
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        try {
          out[k] = await fn(items[k], k);
        } catch (e) {
          out[k] = { error: e.message };
        }
      }
    })
  );
  return out;
}

/** Alternative phrasings to make store searches more thorough. */
export function queryVariants(q) {
  const words = String(q).trim().split(/\s+/).filter(Boolean);
  const v = [words.join(' ')];
  if (words.length >= 3) v.push(words.slice(1).join(' ')); // without brand
  if (words.length >= 3) v.push(words.slice(0, -1).join(' ')); // without last word (colour/size)
  return [...new Set(v)];
}

/** Required share of query words that must match, by query length. */
export function minScoreFor(query) {
  const n = new Set(tokens(query)).size;
  return n <= 2 ? 1 : n === 3 ? 0.66 : 0.6;
}

/** Same product page, written differently? Compare canonical forms. */
export function canonicalUrl(url) {
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
