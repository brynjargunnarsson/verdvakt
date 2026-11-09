import { chromium } from 'playwright';
import { sleep } from './util.js';

export const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const lastHit = new Map();
/** Be polite: at most one request per host every ~1.5s. */
async function throttle(url) {
  const h = new URL(url).hostname;
  const wait = (lastHit.get(h) || 0) + 1500 - Date.now();
  lastHit.set(h, Date.now() + Math.max(0, wait));
  if (wait > 0) await sleep(wait);
}

export async function fetchHtml(url, { timeout = 25000 } = {}) {
  await throttle(url);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, 'accept-language': 'is,en;q=0.8', accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    const text = await res.text();
    return { status: res.status, url: res.url, text, type: res.headers.get('content-type') || '' };
  } finally {
    clearTimeout(t);
  }
}

let browserP = null;
export function getBrowser() {
  browserP ||= chromium.launch({ args: ['--no-sandbox'] });
  return browserP;
}

export async function closeBrowser() {
  if (browserP) (await browserP).close().catch(() => {});
  browserP = null;
}

/** Open url in a real browser, run fn in the page, return { result, html, url, status }. */
export async function render(url, fn, { timeout = 35000, settle = 1500 } = {}) {
  await throttle(url);
  const browser = await getBrowser();
  const ctx = await browser.newContext({ userAgent: UA, locale: 'is-IS', viewport: { width: 1366, height: 1000 } });
  const page = await ctx.newPage();
  await page.route('**/*', (route) => {
    const t = route.request().resourceType();
    if (t === 'image' || t === 'media' || t === 'font') return route.abort();
    return route.continue();
  });
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await sleep(settle);
    // dismiss cookie banners that may hide content
    await page
      .locator('button:has-text("Samþykkja"), button:has-text("Leyfa allar"), button:has-text("Accept all"), button:has-text("Samþykkja allar")')
      .first()
      .click({ timeout: 800 })
      .catch(() => {});
    const result = fn ? await page.evaluate(fn) : null;
    const html = await page.content();
    return { result, html, url: page.url(), status: resp?.status() ?? 0 };
  } finally {
    await ctx.close().catch(() => {});
  }
}
