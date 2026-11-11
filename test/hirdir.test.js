import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRobots, isAllowed, productsFromFlight, productsFromCards, detailsFromProductPage, createClient } from '../src/hirdir/site.js';
import { openDb, applyScan, pendingProducts } from '../src/hirdir/db.js';
import Anthropic from '@anthropic-ai/sdk';
import { analyzePending, importAnalyses, imageUrlFor, Analysis } from '../src/hirdir/analyze.js';
import { scan } from '../src/hirdir/scan.js';

const ROBOTS = 'User-Agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\n';

const prod = (handle, over = {}) => ({
  id: `gid://shopify/Product/${handle}`, title: `Vara ${handle}`, handle, price: 1500, category: 'raftaeki',
  categoryName: 'Raftæki', description: `Lýsing "${handle}" [x]`, image: `https://cdn.example/${handle}.jpg`,
  images: [`https://cdn.example/${handle}.jpg`], status: 'available', createdAt: '2026-11-10T10:00:00Z',
  arrivedAt: null, relistedAt: null, compareAtPrice: null, condition: 'good', conditionNotes: null, itemCount: 1, ...over,
});

function page(products) {
  const flight = `9:["$","$L23",null,{"products":${JSON.stringify(products)},"categories":"$7:x"}]\n`;
  // skipt í tvo búta til að líkja eftir streymi
  const a = flight.slice(0, 40), b = flight.slice(40);
  const cards = products.map((p) => `<article><a href="/vara/${p.handle}"><div><div><img alt="${p.title}" src="/_next/image?url=${encodeURIComponent(p.image)}&amp;w=3840&amp;q=75"/></div><div>${p.title}</div><div>${p.status === 'sold' ? `<span>SELT</span><s>1.500 kr</s>` : `<span>${p.price.toLocaleString('de-DE')} kr</span>`}</div><div>${p.categoryName}</div></div></a></article>`).join('');
  return `<html><body>${cards}<script>self.__next_f.push([1,${JSON.stringify(a)}])</script><script>self.__next_f.push([1,${JSON.stringify(b)}])</script></body></html>`;
}

const fakeFetch = (routes, hits = []) => async (url) => {
  hits.push(url);
  const body = routes[new URL(url).pathname];
  return { status: body == null ? 404 : 200, text: async () => body ?? '' };
};

test('robots.txt: /api/ og /admin bönnuð, annað leyft', () => {
  const r = parseRobots(ROBOTS);
  assert.equal(isAllowed(r, 'https://godihirdirinn.is/'), true);
  assert.equal(isAllowed(r, 'https://godihirdirinn.is/vara/x'), true);
  assert.equal(isAllowed(r, 'https://godihirdirinn.is/api/products?page=2'), false);
  assert.equal(isAllowed(r, 'https://godihirdirinn.is/admin'), false);
  assert.equal(isAllowed(parseRobots('User-agent: verdvakt-bot\nDisallow: /\n\nUser-agent: *\nAllow: /'), 'https://x.is/'), false);
});

test('vörur lesnar úr síðugögnum og úr spjöldum', () => {
  const html = page([prod('a', { price: 12500 }), prod('b', { status: 'sold' })]);
  const f = productsFromFlight(html);
  assert.equal(f.length, 2);
  assert.deepEqual([f[0].priceIsk, f[0].category, f[0].sold, f[1].sold], [12500, 'Raftæki', false, true]);
  assert.equal(f[0].description, 'Lýsing "a" [x]');
  const c = productsFromCards(html);
  assert.deepEqual(c.map((p) => [p.handle, p.priceIsk, p.sold, p.category, p.image]), [
    ['a', 12500, false, 'Raftæki', 'https://cdn.example/a.jpg'],
    ['b', 1500, true, 'Raftæki', 'https://cdn.example/b.jpg'],
  ]);
  assert.equal(productsFromFlight('<html></html>'), null);
});

test('JSON-LD af vörusíðu', () => {
  const html = `<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: 'X', description: 'Löng lýsing', image: ['https://i/1.jpg'], offers: { price: 900, availability: 'https://schema.org/InStock' } })}</script>`;
  assert.deepEqual(detailsFromProductPage(html), { title: 'X', description: 'Löng lýsing', image: 'https://i/1.jpg', priceIsk: 900, sold: false });
});

test('aðeins nýjar vörur í hverri keyrslu; seldum sleppt; verðlækkun fer aftur í vinnslu', async () => {
  const db = openDb(':memory:');
  const run = (products, t) => {
    const client = createClient({ gapMs: 0, fetchImpl: fakeFetch({ '/robots.txt': ROBOTS, '/': page(products) }) });
    return scan({ db, client, analyzeAll: true }).then((r) => (t && db.exec(`UPDATE products SET analyzed_at = '${t}'`), r));
  };
  let r = await run([prod('a'), prod('b'), prod('s', { status: 'sold' })], 'x');
  assert.deepEqual([r.newCount, r.skippedSold, r.requests], [2, 1, 2]);
  await new Promise((res) => setTimeout(res, 5));
  r = await run([prod('c'), prod('a', { price: 900 }), prod('b', { status: 'sold' })]);
  assert.deepEqual(r.added.map((p) => p.handle), ['c']);
  assert.deepEqual([r.priceChanges, r.markedSold], [1, 1]);
  assert.deepEqual(pendingProducts(db).map((p) => p.handle).sort(), ['a', 'c']);
  assert.equal(db.prepare(`SELECT status FROM products WHERE handle = 'b'`).get().status, 'sold');
});

test('varaleið: spjöld + lýsing af vörusíðu, robots virt', async () => {
  const db = openDb(':memory:');
  const hits = [];
  const html = page([prod('a'), prod('s', { status: 'sold' })]).replace(/<script>.*<\/script>/s, '');
  const ld = `<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: 'Vara a', description: 'Af vörusíðu', offers: { price: 1500, availability: 'https://schema.org/InStock' } })}</script>`;
  const client = createClient({ gapMs: 0, fetchImpl: fakeFetch({ '/robots.txt': ROBOTS, '/': html, '/vara/a': ld }, hits) });
  const r = await scan({ db, client });
  assert.deepEqual([r.source, r.newCount, r.skippedSold], ['cards', 1, 1]);
  assert.equal(db.prepare('SELECT description FROM products').get().description, 'Af vörusíðu');
  assert.ok(!hits.some((u) => u.includes('/vara/s')), 'seld vara ekki sótt');
  await assert.rejects(client.get('https://godihirdirinn.is/api/x'), /robots/);
});

test('applyScan merkir horfnar vörur', () => {
  const db = openDb(':memory:');
  const mk = (h) => ({ id: h, handle: h, url: h, title: h, priceIsk: 1, images: [], sold: false });
  applyScan(db, [mk('a'), mk('b')], { now: '2026-01-01T00:00:00Z' });
  const r = applyScan(db, [mk('a')], { now: '2026-01-02T00:00:00Z' });
  assert.equal(r.markedGone, 1);
});

// ---------- skref 2 ----------

const reply = (over = {}) => ({
  stop_reason: 'end_turn', model: 'claude-opus-5-5', usage: { input_tokens: 100, output_tokens: 20 },
  parsed_output: { comparable: true, no_comparison_reason: null, brand: 'Stelton', model: 'EM77', product_type: 'vacuum jug',
    ebay_query: 'Stelton EM77 "vacuum jug" 1L red', quantity: 1, confidence: 'high', evidence: 'Merki á botni.', ...over },
});
const fakeClaude = (handler, calls = []) => ({ beta: { messages: { parse: async (req) => (calls.push(req), handler(req, calls.length)) } } });
const freshDb = async (products) => {
  const db = openDb(':memory:');
  const client = createClient({ gapMs: 0, fetchImpl: fakeFetch({ '/robots.txt': ROBOTS, '/': page(products) }) });
  await scan({ db, client, analyzeAll: true });
  return db;
};

test('fyrsta skönnun setur allt í bakskrá; aðeins vörur sem bætast við eru greindar', async () => {
  const db = openDb(':memory:');
  const run = (products) => scan({ db, client: createClient({ gapMs: 0, fetchImpl: fakeFetch({ '/robots.txt': ROBOTS, '/': page(products) }) }) });
  await run([prod('a'), prod('b')]);
  assert.equal(pendingProducts(db).length, 0);
  await new Promise((res) => setTimeout(res, 5));
  await run([prod('c'), prod('a', { price: 100 }), prod('b')]);
  assert.deepEqual(pendingProducts(db).map((p) => p.handle), ['c'], 'verðlækkun vekur ekki bakskrárvöru');
  const calls = [];
  const r = await analyzePending({ db, client: fakeClaude(() => reply(), calls) });
  assert.deepEqual([r.analyzed, r.comparable, calls.length], [1, 1, 1]);
});

test('greining: beiðni til Claude og vistun', async () => {
  const db = await freshDb([prod('a', { image: 'https://cdn.shopify.com/s/files/1/a.jpg?v=1' }), prod('b')]);
  const calls = [];
  const client = fakeClaude((req) => (JSON.stringify(req.messages).includes('Vara b')
    ? reply({ comparable: false, no_comparison_reason: 'Íslensk bók', ebay_query: null, brand: null, model: null })
    : reply()), calls);
  const r = await analyzePending({ db, client });
  assert.deepEqual([r.analyzed, r.comparable, r.noComparison, r.errors, r.inputTokens], [2, 1, 1, 0, 200]);

  const req = calls.find((c) => JSON.stringify(c.messages).includes('Vara a'));
  assert.equal(req.model, 'claude-opus-5-5');
  assert.equal(req.fallbacks, 'default');
  assert.equal(req.output_config.format.type, 'json_schema');
  assert.equal(req.thinking, undefined);
  assert.deepEqual(req.messages[0].content[0], { type: 'image', source: { type: 'url', url: 'https://cdn.shopify.com/s/files/1/a.jpg?v=1&width=1024' } });
  assert.match(req.messages[0].content[1].text, /Title: Vara a[\s\S]*Price: 1500 ISK[\s\S]*Description: Lýsing/);

  const a = db.prepare(`SELECT * FROM products WHERE handle = 'a'`).get();
  assert.deepEqual([a.analysis_status, a.brand, a.model, a.ebay_query, a.id_confidence, a.analysis_image_used],
    ['ok', 'Stelton', 'EM77', 'Stelton EM77 vacuum jug 1L red', 'high', 1]);
  const b = db.prepare(`SELECT * FROM products WHERE handle = 'b'`).get();
  assert.deepEqual([b.analysis_status, b.ebay_query, b.analysis_note], ['no_comparison', null, 'Íslensk bók']);
  assert.equal(pendingProducts(db).length, 0);
  assert.ok(Analysis.safeParse(reply().parsed_output).success);
});

test('greining: villur, mynd sem ekki næst og rangur lykill', async () => {
  const db = await freshDb([prod('a')]);
  const bad = (status, Cls) => new Cls(status, { type: 'error', error: { type: 'x', message: 'x' } }, 'x', new Headers());

  // comparable án leitarstrengs telst „enginn samanburður“
  // mynd sem API-ið nær ekki í → reynt aftur án myndar
  const calls = [];
  let r = await analyzePending({ db, client: fakeClaude((req, n) => { if (n === 1) throw bad(400, Anthropic.BadRequestError); return reply({ ebay_query: ' ' }); }, calls) });
  assert.deepEqual([r.analyzed, r.noComparison, calls.length, calls[1].messages[0].content.length], [1, 1, 2, 1]);
  assert.equal(db.prepare('SELECT analysis_image_used u FROM products').get().u, 0);

  // höfnun og tímabundnar villur: varan bíður, en aðeins þrjár tilraunir
  db.exec('UPDATE products SET analyzed_at = NULL');
  for (let i = 0; i < 4; i++) r = await analyzePending({ db, client: fakeClaude(() => ({ ...reply(), stop_reason: 'refusal', stop_details: { category: 'cyber' } })) });
  assert.equal(db.prepare('SELECT analysis_attempts n FROM products').get().n, 3);
  assert.equal(pendingProducts(db).length, 0);

  // rangur lykill stöðvar keyrsluna strax
  db.exec('UPDATE products SET analysis_attempts = 0');
  await assert.rejects(analyzePending({ db, client: fakeClaude(() => { throw bad(401, Anthropic.AuthenticationError); }) }), Anthropic.AuthenticationError);
  assert.equal(db.prepare('SELECT analysis_attempts n FROM products').get().n, 0);
  assert.equal(imageUrlFor('ekki slóð'), null);
});

test('innlestur greininga án API', async () => {
  const db = await freshDb([prod('a'), prod('b')]);
  const r = importAnalyses(db, [{ handle: 'a', ...reply().parsed_output }, { handle: 'b', comparable: true }, { handle: 'x', ...reply().parsed_output }], 'handvirkt');
  assert.deepEqual([r.saved, r.rejected.map((x) => x.handle)], [1, ['b', 'x']]);
  const a = db.prepare(`SELECT analysis_status s, ebay_query q, analysis_model m FROM products WHERE handle = 'a'`).get();
  assert.deepEqual([a.s, a.q, a.m], ['ok', 'Stelton EM77 vacuum jug 1L red', 'handvirkt']);
  assert.deepEqual(pendingProducts(db).map((p) => p.handle), ['b']);
});
