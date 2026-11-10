// SQLite-geymsla fyrir vörur Góða hirðisins (innbyggða node:sqlite, Node 22.13+).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id              TEXT PRIMARY KEY,      -- Shopify-auðkenni (eða slóðarheiti í varaleið)
  handle          TEXT NOT NULL UNIQUE,
  url             TEXT NOT NULL,
  title           TEXT NOT NULL,
  price_isk       INTEGER NOT NULL,
  compare_at_isk  INTEGER,
  category        TEXT,
  description     TEXT,
  image_url       TEXT,
  images_json     TEXT,
  condition       TEXT,
  condition_notes TEXT,
  item_count      INTEGER,
  listed_at       TEXT,                  -- hvenær varan kom á vefinn (frá síðunni)
  status          TEXT NOT NULL DEFAULT 'available',  -- available | sold | gone
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  sold_at         TEXT,
  analyzed_at     TEXT                   -- NULL = óunnin; næstu skref (Claude/eBay) fylla þetta
);
CREATE INDEX IF NOT EXISTS products_pending ON products (analyzed_at) WHERE analyzed_at IS NULL;
CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT NOT NULL,
  source      TEXT NOT NULL,             -- flight | cards
  listed      INTEGER NOT NULL,
  skipped_sold INTEGER NOT NULL,
  new_count   INTEGER NOT NULL,
  price_changes INTEGER NOT NULL,
  marked_sold INTEGER NOT NULL,
  requests    INTEGER NOT NULL
);
`;

const nn = (v) => v ?? null;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

/**
 * Ber skannaðan lista saman við grunninn.
 * - Óseldar vörur sem ekki eru til fyrir → settar inn (skilað í `added`).
 * - Seldar vörur sem aldrei sáust óseldar → sleppt.
 * - Þekktar vörur: verð/staða uppfærð. Lækki verðið er varan sett aftur í vinnslu.
 * - Þekktar vörur sem hverfa af síðunni → 'gone' (aðeins ef listinn er tæmandi).
 */
export function applyScan(db, items, { now = new Date().toISOString(), complete = true } = {}) {
  const get = db.prepare('SELECT id, price_isk, status FROM products WHERE id = ? OR handle = ?');
  const insert = db.prepare(`INSERT INTO products
    (id, handle, url, title, price_isk, compare_at_isk, category, description, image_url, images_json,
     condition, condition_notes, item_count, listed_at, status, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', ?, ?)`);
  const seen = db.prepare(`UPDATE products SET last_seen_at = ?, status = 'available', sold_at = NULL,
    price_isk = ?, compare_at_isk = ?, title = ?, category = COALESCE(?, category),
    description = COALESCE(?, description), image_url = COALESCE(?, image_url),
    analyzed_at = CASE WHEN ? THEN NULL ELSE analyzed_at END WHERE id = ?`);
  const sold = db.prepare(`UPDATE products SET status = 'sold', sold_at = ?, last_seen_at = ? WHERE id = ? AND status != 'sold'`);

  const res = { added: [], priceChanges: [], markedSold: 0, markedGone: 0, skippedSold: 0 };
  db.exec('BEGIN');
  try {
    for (const p of items) {
      const row = get.get(p.id, p.handle);
      if (p.sold) {
        if (row) res.markedSold += Number(sold.run(now, now, row.id).changes);
        else res.skippedSold++;
        continue;
      }
      if (!row) {
        insert.run(...[p.id, p.handle, p.url, p.title, p.priceIsk, p.compareAtIsk, p.category, p.description,
          p.image, JSON.stringify(p.images || []), p.condition, p.conditionNotes, p.itemCount, p.listedAt, now, now].map(nn));
        res.added.push(p);
        continue;
      }
      const dropped = p.priceIsk < row.price_isk;
      if (p.priceIsk !== row.price_isk) res.priceChanges.push({ handle: p.handle, from: row.price_isk, to: p.priceIsk });
      seen.run(...[now, p.priceIsk, p.compareAtIsk, p.title, p.category, p.description, p.image, dropped ? 1 : 0, row.id].map(nn));
    }
    if (complete && items.length) {
      res.markedGone = Number(
        db.prepare(`UPDATE products SET status = 'gone' WHERE status = 'available' AND last_seen_at < ?`).run(now).changes,
      );
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return res;
}

/** Vörur sem næstu skref eiga eftir að vinna. */
export function pendingProducts(db, limit = 1000) {
  return db
    .prepare(`SELECT * FROM products WHERE analyzed_at IS NULL AND status = 'available' ORDER BY listed_at DESC LIMIT ?`)
    .all(limit);
}

export function recordRun(db, r) {
  db.prepare(`INSERT INTO runs (started_at, source, listed, skipped_sold, new_count, price_changes, marked_sold, requests)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(r.startedAt, r.source, r.listed, r.skippedSold, r.newCount, r.priceChanges, r.markedSold, r.requests);
}
