import { fetchHtml, render } from './browser.js';
import { extractStructured, pageProbe } from './extract.js';

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

  let dom = null;
  if (!st?.price || thorough || staticErr) {
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
  if (dom?.price && (!price || (dom.price < price && dom.price >= price * 0.3))) {
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
    available: st?.available === false || dom?.available === false ? false : true,
    title: (st?.title || dom?.title || '').trim().slice(0, 200),
  };
}
