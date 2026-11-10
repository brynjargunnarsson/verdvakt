import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRobots, isAllowed, productsFromFlight, productsFromCards, detailsFromProductPage, createClient } from '../src/hirdir/site.js';
import { openDb, applyScan, pendingProducts } from '../src/hirdir/db.js';
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
    return scan({ db, client }).then((r) => (t && db.exec(`UPDATE products SET analyzed_at = '${t}'`), r));
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
