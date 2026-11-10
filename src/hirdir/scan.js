#!/usr/bin/env node
// Skref 1: skanna godihirdirinn.is og vista nýjar, óseldar vörur í SQLite.
//
//   node src/hirdir/scan.js [--db skrá] [--verify N] [--max-pages N] [--list] [--quiet]
//
//   --verify N     sækir N vörusíður af handahófi og ber saman við forsíðugögnin
//   --max-pages N  hámark vörusíðna sem sóttar eru í einni keyrslu (sjálfgefið 40)
//   --list         prentar nýjar vörur sem JSON-línur á stdout
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, applyScan, recordRun, pendingProducts } from './db.js';
import { ORIGIN, createClient, productsFromFlight, productsFromCards, detailsFromProductPage } from './site.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DEFAULT_DB = path.join(ROOT, 'data', 'hirdir', 'hirdir.db');

function args(argv) {
  const o = { db: process.env.HIRDIR_DB || DEFAULT_DB, verify: 0, maxPages: 40, list: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') o.db = argv[++i];
    else if (a === '--verify') o.verify = Number(argv[++i]);
    else if (a === '--max-pages') o.maxPages = Number(argv[++i]);
    else if (a === '--list') o.list = true;
    else if (a === '--quiet') o.quiet = true;
    else throw new Error(`Óþekkt viðfang: ${a}`);
  }
  return o;
}

const kr = (n) => `${n.toLocaleString('de-DE')} kr`;

export async function scan({ db, client, maxPages = 40, verify = 0, log = () => {} }) {
  const startedAt = new Date().toISOString();
  const html = await client.get(`${ORIGIN}/`);

  let items = productsFromFlight(html);
  const source = items ? 'flight' : 'cards';
  if (!items) {
    log('Vörulisti fannst ekki í síðugögnum – les sýnileg vöruspjöld í staðinn.');
    items = productsFromCards(html);
  }
  if (!items.length) throw new Error('Engar vörur fundust á forsíðunni – hefur síðan breyst?');

  // Vörusíður eru aðeins sóttar fyrir nýjar, óseldar vörur sem vantar lýsingu.
  const known = new Set(db.prepare('SELECT handle FROM products').all().map((r) => r.handle));
  const needDetail = items.filter((p) => !p.sold && !p.description && !known.has(p.handle));
  const deferred = new Set(needDetail.slice(maxPages).map((p) => p.handle));
  for (const p of needDetail.slice(0, maxPages)) {
    try {
      const d = detailsFromProductPage(await client.get(p.url));
      if (!d) throw new Error('engin vörugögn á síðunni');
      p.description = d.description;
      p.image ||= d.image;
      if (d.sold) p.sold = true;
    } catch (e) {
      log(`  ${p.handle}: ${e.message} – reyni aftur í næstu keyrslu`);
      deferred.add(p.handle);
    }
  }
  if (deferred.size) log(`${deferred.size} vörur bíða næstu keyrslu (vörusíður ósóttar).`);
  const ready = items.filter((p) => !deferred.has(p.handle));

  const res = applyScan(db, ready, { now: startedAt, complete: source === 'flight' });

  const mismatches = [];
  if (verify > 0) {
    const pool = ready.filter((p) => !p.sold);
    const sample = [...pool].sort(() => Math.random() - 0.5).slice(0, verify);
    for (const p of sample) {
      const d = detailsFromProductPage(await client.get(p.url));
      const diff = [];
      if (!d) diff.push('engin JSON-LD vörugögn');
      else {
        if (d.title !== p.title) diff.push(`titill: „${d.title}“ ≠ „${p.title}“`);
        if (d.priceIsk !== p.priceIsk) diff.push(`verð: ${d.priceIsk} ≠ ${p.priceIsk}`);
        if ((d.description || '') !== (p.description || '')) diff.push('lýsing ólík');
        if (d.image !== p.image) diff.push('mynd ólík');
        if (d.sold) diff.push('merkt seld á vörusíðu');
      }
      log(`  ${diff.length ? '✗' : '✓'} ${p.handle}${diff.length ? ' – ' + diff.join('; ') : ''}`);
      if (diff.length) mismatches.push({ handle: p.handle, diff });
    }
  }

  const summary = {
    startedAt,
    source,
    listed: items.length,
    skippedSold: res.skippedSold,
    newCount: res.added.length,
    priceChanges: res.priceChanges.length,
    markedSold: res.markedSold,
    markedGone: res.markedGone,
    requests: client.requests,
  };
  recordRun(db, summary);
  return { ...summary, added: res.added, priceChangeList: res.priceChanges, mismatches };
}

async function main() {
  const o = args(process.argv.slice(2));
  const log = o.quiet ? () => {} : (m) => console.error(m);
  const db = openDb(o.db);
  const client = createClient({ log: o.quiet ? undefined : (m) => console.error(`  ${m}`) });
  try {
    const r = await scan({ db, client, maxPages: o.maxPages, verify: o.verify, log });
    log(
      `\nGóði hirðirinn: ${r.listed} vörur á síðunni (${r.source}), ${r.skippedSold} seldum sleppt.` +
        `\n  Nýjar: ${r.newCount}   Verðbreytingar: ${r.priceChanges}   Seldust: ${r.markedSold}   Horfnar: ${r.markedGone}` +
        `\n  Óunnar í grunni: ${pendingProducts(db, 1e6).length}   Fyrirspurnir: ${r.requests}   Grunnur: ${o.db}`,
    );
    for (const p of r.added.slice(0, 15)) log(`  + ${kr(p.priceIsk).padStart(11)}  ${p.category || '?'} · ${p.title}`);
    if (r.added.length > 15) log(`  … og ${r.added.length - 15} til viðbótar`);
    if (o.list) for (const p of r.added) console.log(JSON.stringify(p));
    if (r.mismatches.length) process.exitCode = 2;
  } finally {
    db.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`Villa: ${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ""}`);
    process.exit(1);
  });
}
