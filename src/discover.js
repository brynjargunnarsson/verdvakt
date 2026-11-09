// Find which Icelandic stores sell a product. Results become *candidates*
// which the user confirms on the page before they are tracked.
import { searchStore } from './search.js';
import { readJson, writeJson, pool, queryVariants, nowIso, hostOf, minScoreFor, canonicalUrl } from './util.js';
import { closeBrowser } from './browser.js';

export async function loadStores() {
  const { stores } = await readJson('stores.json', { stores: [] });
  const cache = await readJson('store-cache.json', {});
  const now = Date.now();
  const list = stores
    .filter((s) => !s.disabled)
    .map((s) => ({ ...s, ...(s.kind ? {} : cache[s.domain]?.learned || {}) }))
    .filter((s) => !(cache[s.domain]?.pausedUntil && Date.parse(cache[s.domain].pausedUntil) > now));
  return { list, cache };
}

export function noteStore(cache, domain, { ok, error, learned }) {
  const c = (cache[domain] ||= { fails: 0 });
  if (learned) c.learned = learned;
  if (ok) {
    c.fails = 0;
    c.lastOk = nowIso();
    delete c.lastError;
    delete c.pausedUntil;
  } else {
    c.fails = (c.fails || 0) + 1;
    c.lastError = String(error || 'villa').slice(0, 160);
    c.lastErrorAt = nowIso();
    // A store that keeps failing is rested for a week, then retried.
    if (c.fails >= 4) c.pausedUntil = new Date(Date.now() + 7 * 864e5).toISOString();
  }
}

/** Search every store for one product. Updates data/candidates/<id>.json. */
export async function discoverProduct(product, { stores, cache, concurrency = 6, log = console.log } = {}) {
  const q = product.query || product.name;
  const variants = queryVariants(q);
  const t0 = Date.now();
  const found = [];
  const failed = [];
  await pool(stores, concurrency, async (store) => {
    let any = false;
    for (const v of variants) {
      const r = await searchStore(store, v, { minScore: minScoreFor(v) }).catch((e) => ({ failed: true, error: e.message, results: [] }));
      if (r.learned) store = { ...store, ...r.learned };
      noteStore(cache, store.domain, { ok: !r.failed, error: r.error, learned: r.learned });
      if (r.failed) {
        failed.push({ domain: store.domain, error: r.error });
        return;
      }
      if (r.unknown) return; // store answered, but its search wasn't found / nothing matched – no point retrying variants
      for (const x of r.results) found.push({ ...x, store: store.domain, storeName: store.name, marketplace: !!store.marketplace });
      if (r.results.length) any = true;
      if (any) break;
    }
  });

  const prev = await readJson(`candidates/${product.id}.json`, { results: [] });
  const known = new Set([...(product.offers || []).map((o) => o.url), ...(product.rejected || [])].map(canonicalUrl));
  // Keep earlier results only where this search couldn't check again (store failed) or they came from a sale page.
  const failedSet = new Set(failed.map((f) => f.domain));
  const byUrl = new Map(prev.results.filter((r) => r.via === 'tilboðssíða' || failedSet.has(r.store)).map((r) => [canonicalUrl(r.url), r]));
  const prevByUrl = new Map(prev.results.map((r) => [canonicalUrl(r.url), r]));
  for (const f of found) {
    const cu = canonicalUrl(f.href);
    if (known.has(cu)) continue;
    const old = prevByUrl.get(cu);
    byUrl.set(cu, {
      url: f.href,
      store: f.store,
      storeName: f.storeName,
      title: f.title,
      price: f.price,
      score: Math.round(f.score * 100) / 100,
      marketplace: f.marketplace,
      foundAt: old?.foundAt || nowIso(),
      seenAt: nowIso(),
      via: old?.via || 'leit',
    });
  }
  const results = [...byUrl.values()]
    .filter((r) => !known.has(canonicalUrl(r.url)))
    .sort((a, b) => b.score - a.score || (a.price ?? 1e12) - (b.price ?? 1e12));
  await writeJson(`candidates/${product.id}.json`, {
    productId: product.id,
    query: q,
    variants,
    searchedAt: nowIso(),
    storesSearched: stores.length,
    storesFailed: failed,
    seconds: Math.round((Date.now() - t0) / 1000),
    results,
  });
  log(`Leit: „${q}“ – ${results.length} tillögur úr ${new Set(found.map((f) => hostOf(f.href))).size} verslunum, ${failed.length} verslanir svöruðu ekki (${Math.round((Date.now() - t0) / 1000)} s)`);
  return results;
}

// CLI: node src/discover.js [productId ...]
if (import.meta.url === `file://${process.argv[1]}`) {
  const ids = process.argv.slice(2);
  const { products } = await readJson('products.json', { products: [] });
  const { list, cache } = await loadStores();
  const state = await readJson('state.json', {});
  state.lastDiscovery ||= {};
  for (const p of products.filter((p) => !ids.length || ids.includes(p.id))) {
    await discoverProduct(p, { stores: list, cache });
    state.lastDiscovery[p.id] = nowIso();
    await writeJson('store-cache.json', cache);
  }
  await writeJson('state.json', state);
  await closeBrowser();
}
