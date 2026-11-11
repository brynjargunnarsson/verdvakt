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

// Dálkar sem bættust við eftir fyrstu útgáfu (skref 2: greining Claude).
const ADDED_COLUMNS = {
  analysis_status: 'TEXT',        // ok | no_comparison | backlog  (NULL = óunnin)
  brand: 'TEXT',
  model: 'TEXT',
  product_type: 'TEXT',
  ebay_query: 'TEXT',
  quantity: 'INTEGER',
  id_confidence: 'TEXT',          // high | medium | low
  analysis_note: 'TEXT',          // rökstuðningur, eða ástæða fyrir „enginn samanburður“
  analysis_model: 'TEXT',
  analysis_image_used: 'INTEGER',
  analysis_attempts: 'INTEGER NOT NULL DEFAULT 0',
  analysis_error: 'TEXT',
};
export const MAX_ATTEMPTS = 3;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  const have = new Set(db.prepare('PRAGMA table_info(products)').all().map((c) => c.name));
  for (const [name, type] of Object.entries(ADDED_COLUMNS)) {
    if (!have.has(name)) db.exec(`ALTER TABLE products ADD COLUMN ${name} ${type}`);
  }
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
  const get = db.prepare('SELECT id, price_isk, status, analysis_status FROM products WHERE id = ? OR handle = ?');
  const insert = db.prepare(`INSERT INTO products
    (id, handle, url, title, price_isk, compare_at_isk, category, description, image_url, images_json,
     condition, condition_notes, item_count, listed_at, status, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', ?, ?)`);
  const seen = db.prepare(`UPDATE products SET last_seen_at = ?, status = 'available', sold_at = NULL,
    price_isk = ?, compare_at_isk = ?, title = ?, category = COALESCE(?, category),
    description = COALESCE(?, description), image_url = COALESCE(?, image_url),
    analyzed_at = CASE WHEN ? THEN NULL ELSE analyzed_at END,
    analysis_attempts = CASE WHEN ? THEN 0 ELSE analysis_attempts END WHERE id = ?`);
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
      // Verðlækkun setur vöruna aftur í vinnslu – nema hún sé í bakskrá.
      const requeue = p.priceIsk < row.price_isk && row.analysis_status !== 'backlog' ? 1 : 0;
      if (p.priceIsk !== row.price_isk) res.priceChanges.push({ handle: p.handle, from: row.price_isk, to: p.priceIsk });
      seen.run(...[now, p.priceIsk, p.compareAtIsk, p.title, p.category, p.description, p.image, requeue, requeue, row.id].map(nn));
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
    .prepare(`SELECT * FROM products WHERE analyzed_at IS NULL AND status = 'available' AND analysis_attempts < ?
      ORDER BY listed_at DESC LIMIT ?`)
    .all(MAX_ATTEMPTS, limit);
}

/** Merkir allar óunnar vörur sem bakskrá: þær verða hvorki greindar né bornar saman. */
export function markBacklog(db, now = new Date().toISOString()) {
  return Number(
    db.prepare(`UPDATE products SET analyzed_at = ?, analysis_status = 'backlog' WHERE analyzed_at IS NULL`).run(now).changes,
  );
}

export function saveAnalysis(db, id, { analysis: a, model, imageUsed }, now = new Date().toISOString()) {
  db.prepare(`UPDATE products SET analyzed_at = ?, analysis_status = ?, brand = ?, model = ?, product_type = ?,
    ebay_query = ?, quantity = ?, id_confidence = ?, analysis_note = ?, analysis_model = ?, analysis_image_used = ?,
    analysis_error = NULL WHERE id = ?`).run(...[now, a.comparable ? 'ok' : 'no_comparison', a.brand, a.model, a.productType,
    a.ebayQuery, a.quantity, a.confidence, a.comparable ? a.evidence : a.reason, model, imageUsed ? 1 : 0, id].map(nn));
}

/** Skráir misheppnaða tilraun; eftir MAX_ATTEMPTS er vörunni sleppt. Skilar fjölda tilrauna. */
export function recordAnalysisError(db, id, message) {
  db.prepare('UPDATE products SET analysis_attempts = analysis_attempts + 1, analysis_error = ? WHERE id = ?').run(String(message).slice(0, 500), id);
  return db.prepare('SELECT analysis_attempts n FROM products WHERE id = ?').get(id).n;
}

export function recordRun(db, r) {
  db.prepare(`INSERT INTO runs (started_at, source, listed, skipped_sold, new_count, price_changes, marked_sold, requests)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(r.startedAt, r.source, r.listed, r.skippedSold, r.newCount, r.priceChanges, r.markedSold, r.requests);
}
