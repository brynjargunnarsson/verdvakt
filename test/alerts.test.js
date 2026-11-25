import test from 'node:test';
import assert from 'node:assert/strict';
import { weightedMedian, evaluate, runAlerts, inQuietHours, bestSeries, DEFAULTS, kr } from '../src/alerts.js';
import { hash } from '../src/util.js';

const DAY = 864e5;
const NOW = Date.parse('2026-11-27T12:00:00Z'); // föstudagur, utan þagnartíma
const iso = (t) => new Date(t).toISOString();

// Vara með eina verslun. hist = [[daga síðan, verð], ...]
function fixture(hist, extra = {}) {
  const url = 'https://shop.is/vara';
  const key = hash('p1|' + url);
  const cur = hist.at(-1)[1];
  return {
    product: { id: 'p1', name: 'Vara', offers: [{ url }], ...extra },
    prices: { offers: { [key]: { storeName: 'Búð', current: cur, available: true, marketplace: false } } },
    history: { [key]: hist.map(([d, v]) => [iso(NOW - d * DAY), v]) },
  };
}
const run = async (fx, state, opts = {}) => {
  const sent = [];
  const r = await runAlerts({
    products: [fx.product], prices: fx.prices, state, settings: opts.settings, now: new Date(opts.now ?? NOW),
    send: async (m) => (sent.push(m), opts.sendResult ?? { sent: true }), log: () => {}, loadHistory: async () => fx.history,
  });
  return { r, sent };
};

test('miðgildi: 25 daga á 100, 5 daga á 70 → 100', () => {
  const pts = [[NOW - 30 * DAY, 100], [NOW - 5 * DAY, 70]];
  assert.equal(weightedMedian(pts, NOW - 30 * DAY, NOW), 100);
});
test('miðgildi hunsar verð eldra en glugginn', () => {
  const pts = [[NOW - 90 * DAY, 500], [NOW - 40 * DAY, 100]];
  assert.equal(weightedMedian(pts, NOW - 30 * DAY, NOW), 100);
});
test('25% lækkun kveikir, 20% ekki', async () => {
  const a = fixture([[30, 100], [1, 75]]);
  assert.equal((await run(a, {})).sent.length, 1);
  const b = fixture([[30, 100], [1, 80]]);
  assert.equal((await run(b, {})).sent.length, 0);
});
test('markverð kveikir óháð prósentu', async () => {
  const fx = fixture([[30, 100], [1, 95]], { targetPrice: 96 });
  const { sent } = await run(fx, {});
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /undir markverði/);
});
test('sérstök prósenta á vöru yfirskrifar sjálfgefið; 0 slekkur á prósentu', async () => {
  assert.equal((await run(fixture([[30, 100], [1, 88]], { alertPct: 10 }), {})).sent.length, 1);
  assert.equal((await run(fixture([[30, 100], [1, 50]], { alertPct: 0 }), {})).sent.length, 0);
});
test('tilkynnir einu sinni, aftur aðeins ef verðið lækkar enn meira', async () => {
  const state = {};
  const fx = fixture([[30, 100], [2, 70]]);
  assert.equal((await run(fx, state)).sent.length, 1);
  assert.equal((await run(fx, state)).sent.length, 0, 'sama verð: engin ný tilkynning');
  const lower = fixture([[30, 100], [2, 70], [0.1, 60]]);
  assert.equal((await run(lower, state)).sent.length, 1, 'lægra verð: tilkynnt aftur');
  const higherAgain = fixture([[30, 100], [2, 70], [0.1, 65]]);
  assert.equal((await run(higherAgain, state)).sent.length, 0, 'hærra en síðast tilkynnt: ekkert');
});
test('þegar verðið fer upp fyrir mörk endurstillist það', async () => {
  const state = {};
  await run(fixture([[30, 100], [2, 70]]), state);
  await run(fixture([[30, 100], [2, 70], [1.5, 100]]), state); // aftur upp
  assert.equal(state.alerts.p1.active, false);
  assert.equal((await run(fixture([[30, 100], [2, 70], [1.5, 100], [0.2, 70]]), state)).sent.length, 1);
});
test('uppseld verslun og markaðstorg teljast ekki', async () => {
  const fx = fixture([[30, 100], [1, 50]]);
  Object.values(fx.prices.offers)[0].available = false;
  assert.equal((await run(fx, {})).sent.length, 0);
});
test('slökkt á tilkynningum fyrir vöru / í hlé', async () => {
  assert.equal((await run(fixture([[30, 100], [1, 50]], { alertsOff: true }), {})).sent.length, 0);
  assert.equal((await run(fixture([[30, 100], [1, 50]], { paused: true }), {})).sent.length, 0);
});
test('þögn á nóttunni: haldið og sent að morgni ef enn í gildi', async () => {
  const night = Date.parse('2026-11-27T02:00:00Z');
  const state = {};
  const fx = fixture([[30, 100], [1, 70]]);
  const a = await run(fx, state, { now: night });
  assert.equal(a.sent.length, 0);
  assert.deepEqual(state.pendingAlerts, ['p1']);
  const morning = await run(fx, state, { now: Date.parse('2026-11-27T08:00:00Z') });
  assert.equal(morning.sent.length, 1);
  assert.deepEqual(state.pendingAlerts, []);
  // ef verðið hækkaði yfir nóttina er engu sent
  const state2 = {};
  await run(fx, state2, { now: night });
  const back = fixture([[30, 100], [1, 70], [0.1, 100]]);
  assert.equal((await run(back, state2, { now: Date.parse('2026-11-27T08:00:00Z') })).sent.length, 0);
});
test('sending mistekst: reynt aftur í næstu keyrslu', async () => {
  const state = {};
  const fx = fixture([[30, 100], [1, 70]]);
  await run(fx, state, { sendResult: { sent: false, retry: true, reason: 'x' } });
  assert.deepEqual(state.pendingAlerts, ['p1']);
  assert.equal((await run(fx, state)).sent.length, 1);
});
test('engin rás stillt: ekkert í biðröð, ekkert merkt tilkynnt – berst þegar rás er sett upp', async () => {
  const state = {};
  const fx = fixture([[30, 100], [1, 70]]);
  const a = await run(fx, state, { sendResult: { sent: false, reason: 'engin rás' } });
  assert.deepEqual(state.pendingAlerts, []);
  assert.equal(a.r.summary, undefined);
  assert.equal(state.alerts.p1, undefined);
  assert.equal((await run(fx, state)).sent.length, 1, 'rás komin: tilkynnt um það sem var þegar undir mörkum');
});
test('margar lækkanir saman í eina tilkynningu', async () => {
  const a = fixture([[30, 100], [1, 70]]);
  const b = fixture([[30, 200], [1, 100]]);
  b.product.id = 'p2';
  const keyB = hash('p2|https://shop.is/vara');
  b.prices = { offers: { [keyB]: { storeName: 'Búð', current: 100, available: true } } };
  b.history = { [keyB]: [[iso(NOW - 30 * DAY), 200], [iso(NOW - DAY), 100]] };
  const sent = [];
  await runAlerts({ products: [a.product, b.product], prices: { offers: { ...a.prices.offers, ...b.prices.offers } }, state: {}, now: new Date(NOW), send: async (m) => (sent.push(m), { sent: true }), log: () => {}, loadHistory: async (id) => (id === 'p1' ? a.history : b.history) });
  assert.equal(sent.length, 1);
  assert.match(sent[0].title, /2 verðlækkanir/);
});
test('þagnartímar', () => {
  const s = { quietFrom: 23, quietTo: 7 };
  assert.equal(inQuietHours(s, new Date('2026-11-27T23:30:00Z')), true);
  assert.equal(inQuietHours(s, new Date('2026-11-27T06:59:00Z')), true);
  assert.equal(inQuietHours(s, new Date('2026-11-27T07:00:00Z')), false);
  assert.equal(inQuietHours({ quietFrom: 0, quietTo: 0 }, new Date('2026-11-27T03:00:00Z')), false);
});
test('kr', () => assert.equal(kr(159995), '159.995 kr.'));
