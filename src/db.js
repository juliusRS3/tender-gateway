// Database layer for Tender Gateway.
// Uses PostgreSQL via the DATABASE_URL environment variable (Railway sets this
// automatically when you add a Postgres database to the project).

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set. Add a Postgres database on Railway and link it to this service.');
}

// Railway's internal connection does not need SSL; external connections do.
const needsSsl = /sslmode=require/i.test(connectionString || '') ||
  (process.env.PGSSL || '').toLowerCase() === 'true';

const pool = new Pool({
  connectionString,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
  max: 5,
});

// Create the tables the first time the app runs, then load the starter tenders
// if the table is still empty.
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tenders (
      id           TEXT PRIMARY KEY,
      ref          TEXT NOT NULL DEFAULT '',
      org          TEXT NOT NULL DEFAULT '',
      country      TEXT NOT NULL DEFAULT '',
      sector       TEXT NOT NULL DEFAULT 'public',
      title        TEXT NOT NULL DEFAULT '',
      closes       TEXT NOT NULL DEFAULT '',
      closes_label TEXT NOT NULL DEFAULT '',
      source       TEXT NOT NULL DEFAULT '',
      added_by     TEXT NOT NULL DEFAULT '',
      added_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS requests (
      id               TEXT PRIMARY KEY,
      tender_id        TEXT,
      tender_ref       TEXT,
      tender_title     TEXT,
      tender_org       TEXT,
      tender_source    TEXT,
      company          TEXT,
      country          TEXT,
      contact_name     TEXT,
      email            TEXT,
      level            TEXT,
      notes            TEXT,
      status           TEXT NOT NULL DEFAULT 'pending',
      quote_fee        NUMERIC,
      quote_currency   TEXT,
      quote_turnaround TEXT,
      quote_scope      TEXT,
      quote_note       TEXT,
      quote_sent_at    TIMESTAMPTZ,
      accepted_at      TIMESTAMPTZ,
      declined_at      TIMESTAMPTZ,
      declined_by      TEXT,
      completed_at     TIMESTAMPTZ,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  await seedTenders();
}

async function seedTenders() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM tenders');
  if (rows[0].n > 0) return;
  const file = path.join(__dirname, '..', 'seed', 'tenders.json');
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.warn('No seed tenders loaded:', e.message);
    return;
  }
  for (const t of list) {
    await pool.query(
      `INSERT INTO tenders (id, ref, org, country, sector, title, closes, closes_label, source, added_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'seed')
       ON CONFLICT (id) DO NOTHING`,
      [t.id, t.ref || '', t.org || '', t.country || '', t.sector || 'public',
       t.title || '', t.closes || '', t.closesLabel || '', t.source || '']
    );
  }
  console.log(`Seeded ${list.length} tenders.`);
}

// ---- helpers that shape rows the way the frontend expects ----

function tenderOut(r) {
  return {
    id: r.id, ref: r.ref, org: r.org, country: r.country, sector: r.sector,
    title: r.title, closes: r.closes, closesLabel: r.closes_label, source: r.source,
  };
}

function requestOut(r) {
  const out = {
    id: r.id, tenderId: r.tender_id, tenderRef: r.tender_ref, tenderTitle: r.tender_title,
    tenderOrg: r.tender_org, tenderSource: r.tender_source, company: r.company,
    country: r.country, contactName: r.contact_name, email: r.email, level: r.level,
    notes: r.notes, status: r.status,
    createdAt: r.created_at, acceptedAt: r.accepted_at, declinedAt: r.declined_at,
    declinedBy: r.declined_by, completedAt: r.completed_at,
  };
  if (r.quote_sent_at) {
    out.quote = {
      fee: r.quote_fee == null ? null : Number(r.quote_fee),
      currency: r.quote_currency, turnaround: r.quote_turnaround,
      scope: r.quote_scope, note: r.quote_note, sentAt: r.quote_sent_at,
    };
  }
  return out;
}

module.exports = { pool, init, tenderOut, requestOut };
