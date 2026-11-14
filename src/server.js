// Tender Gateway - standalone server.
// Serves the website and a small API backed by Postgres.

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const { pool, init, tenderOut, requestOut } = require('./db');
const mailer = require('./mailer');

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(16).toString('hex');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';

if (!ADMIN_PASSWORD) {
  console.warn('ADMIN_PASSWORD is not set. Set it on Railway so you can sign in to the Admin page.');
}

// ---------- tiny signed-cookie admin session ----------
function makeToken() {
  const body = `admin.${Date.now()}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('hex');
  return `${body}.${sig}`;
}
function validToken(token) {
  if (!token) return false;
  const i = token.lastIndexOf('.');
  if (i < 0) return false;
  const body = token.slice(0, i), sig = token.slice(i + 1);
  const expect = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('hex');
  if (sig.length !== expect.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return false;
  const ts = Number((body.split('.')[1]) || 0);
  return Date.now() - ts < 1000 * 60 * 60 * 24 * 30; // 30 days
}
function requireAdmin(req, res, next) {
  if (validToken(req.cookies.tg_admin)) return next();
  res.status(401).json({ error: 'Please sign in as admin.' });
}

const genId = (prefix) => prefix + crypto.randomBytes(9).toString('base64url');
const nowIso = () => new Date().toISOString();
const clean = (s, max = 2000) => String(s == null ? '' : s).trim().slice(0, max);
const isHttp = (u) => /^https?:\/\//i.test(String(u || ''));

// ================= PUBLIC API =================

// All current tenders (anyone can browse).
app.get('/api/tenders', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM tenders');
    const { rows: m } = await pool.query(`SELECT value FROM meta WHERE key = 'lastChecked'`);
    res.json({ tenders: rows.map(tenderOut), lastChecked: m[0] ? m[0].value : null });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not load tenders.' }); }
});

// Submit a consultancy request. No sign-in needed; email is the contact.
app.post('/api/requests', async (req, res) => {
  try {
    const b = req.body || {};
    const email = clean(b.email, 200);
    const required = { company: clean(b.company, 200), country: clean(b.country, 120),
      contactName: clean(b.contactName, 200), email };
    for (const k of ['company', 'country', 'contactName', 'email']) {
      if (!required[k]) return res.status(400).json({ error: 'Please fill in company, country, contact person and email.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    const level = ['review', 'cowrite', 'full'].includes(b.level) ? b.level : 'cowrite';
    const tenderId = clean(b.tenderId, 200);
    const t = (await pool.query('SELECT * FROM tenders WHERE id = $1', [tenderId])).rows[0];
    if (!t) return res.status(400).json({ error: 'That tender could not be found.' });

    const id = genId('r');
    await pool.query(
      `INSERT INTO requests (id, tender_id, tender_ref, tender_title, tender_org, tender_source,
         company, country, contact_name, email, level, notes, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending')`,
      [id, t.id, t.ref, t.title, t.org, t.source, required.company, required.country,
       required.contactName, email, level, clean(b.notes, 4000)]
    );
    const out = requestOut((await pool.query('SELECT * FROM requests WHERE id = $1', [id])).rows[0]);
    res.json({ request: out });
    // Fire-and-forget emails.
    mailer.confirmToClient(out).catch(() => {});
    if (ADMIN_EMAIL) mailer.notifyNewRequest(ADMIN_EMAIL, out).catch(() => {});
  } catch (e) { console.error(e); res.status(500).json({ error: 'Your request could not be sent. Please try again.' }); }
});

// A client looks up their own request by its reference id.
app.get('/api/requests/:id', async (req, res) => {
  try {
    const r = (await pool.query('SELECT * FROM requests WHERE id = $1', [clean(req.params.id, 60)])).rows[0];
    if (!r) return res.status(404).json({ error: 'Request not found.' });
    res.json({ request: requestOut(r) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not load that request.' }); }
});

// Client accepts or declines a quote.
app.post('/api/requests/:id/:action', async (req, res) => {
  const action = req.params.action;
  if (action !== 'accept' && action !== 'decline') return res.status(404).json({ error: 'Unknown action.' });
  try {
    const r = (await pool.query('SELECT * FROM requests WHERE id = $1', [clean(req.params.id, 60)])).rows[0];
    if (!r) return res.status(404).json({ error: 'Request not found.' });
    if (r.status !== 'quoted') return res.status(400).json({ error: 'This request has no quote to act on.' });
    if (action === 'accept') {
      await pool.query(`UPDATE requests SET status='accepted', accepted_at=$2, updated_at=now() WHERE id=$1`, [r.id, nowIso()]);
    } else {
      await pool.query(`UPDATE requests SET status='declined', declined_by='client', declined_at=$2, updated_at=now() WHERE id=$1`, [r.id, nowIso()]);
    }
    res.json({ request: requestOut((await pool.query('SELECT * FROM requests WHERE id = $1', [r.id])).rows[0]) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'That change could not be saved.' }); }
});

// ================= ADMIN API =================

app.get('/api/admin/status', (req, res) => res.json({ admin: validToken(req.cookies.tg_admin) }));

app.post('/api/admin/login', (req, res) => {
  const pw = (req.body && req.body.password) || '';
  if (!ADMIN_PASSWORD || pw !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong password.' });
  res.cookie('tg_admin', makeToken(), {
    httpOnly: true, sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 30,
  });
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => { res.clearCookie('tg_admin'); res.json({ ok: true }); });

app.get('/api/admin/requests', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM requests ORDER BY created_at DESC');
    res.json({ requests: rows.map(requestOut) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not load requests.' }); }
});

// Send or revise a quote.
app.post('/api/admin/requests/:id/quote', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const fee = Number(b.fee);
    if (!isFinite(fee) || fee <= 0) return res.status(400).json({ error: 'Enter a fee above zero.' });
    if (!clean(b.turnaround) || !clean(b.scope)) return res.status(400).json({ error: 'Fill in the turnaround and scope.' });
    const id = clean(req.params.id, 60);
    const r = (await pool.query('SELECT * FROM requests WHERE id = $1', [id])).rows[0];
    if (!r) return res.status(404).json({ error: 'Request not found.' });
    await pool.query(
      `UPDATE requests SET status='quoted', quote_fee=$2, quote_currency=$3, quote_turnaround=$4,
         quote_scope=$5, quote_note=$6, quote_sent_at=$7, updated_at=now() WHERE id=$1`,
      [id, fee, clean(b.currency, 8) || 'USD', clean(b.turnaround, 200),
       clean(b.scope, 2000), clean(b.note, 1000), nowIso()]
    );
    const out = requestOut((await pool.query('SELECT * FROM requests WHERE id = $1', [id])).rows[0]);
    res.json({ request: out });
    mailer.quoteToClient(out).catch(() => {});
  } catch (e) { console.error(e); res.status(500).json({ error: 'The quote could not be sent.' }); }
});

// Admin declines or completes a request.
app.post('/api/admin/requests/:id/:action', requireAdmin, async (req, res) => {
  const action = req.params.action;
  if (action !== 'decline' && action !== 'complete') return res.status(404).json({ error: 'Unknown action.' });
  try {
    const id = clean(req.params.id, 60);
    const r = (await pool.query('SELECT * FROM requests WHERE id = $1', [id])).rows[0];
    if (!r) return res.status(404).json({ error: 'Request not found.' });
    if (action === 'decline') {
      await pool.query(`UPDATE requests SET status='declined', declined_by='team', declined_at=$2, updated_at=now() WHERE id=$1`, [id, nowIso()]);
    } else {
      await pool.query(`UPDATE requests SET status='completed', completed_at=$2, updated_at=now() WHERE id=$1`, [id, nowIso()]);
    }
    res.json({ request: requestOut((await pool.query('SELECT * FROM requests WHERE id = $1', [id])).rows[0]) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'That change could not be saved.' }); }
});

// Create or update a tender.
app.post('/api/admin/tenders', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const data = {
      ref: clean(b.ref, 200), org: clean(b.org, 200), title: clean(b.title, 400),
      country: clean(b.country, 120), sector: clean(b.sector, 40) || 'public',
      closes: clean(b.closes, 20), closesLabel: clean(b.closesLabel, 200), source: clean(b.source, 500),
    };
    for (const k of ['ref', 'org', 'title', 'country', 'source']) {
      if (!data[k]) return res.status(400).json({ error: 'Fill in every field except the closing date.' });
    }
    if (!isHttp(data.source)) return res.status(400).json({ error: 'The source link must start with https://' });
    let id = clean(b.id, 200);
    const editing = !!id;
    if (!id) id = (data.ref.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 120)) || genId('t');
    if (!editing) {
      const exists = (await pool.query('SELECT 1 FROM tenders WHERE id=$1', [id])).rows[0];
      if (exists) return res.status(400).json({ error: 'A tender with this reference already exists.' });
    }
    await pool.query(
      `INSERT INTO tenders (id, ref, org, title, country, sector, closes, closes_label, source, added_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'admin',now())
       ON CONFLICT (id) DO UPDATE SET ref=$2, org=$3, title=$4, country=$5, sector=$6,
         closes=$7, closes_label=$8, source=$9, updated_at=now()`,
      [id, data.ref, data.org, data.title, data.country, data.sector, data.closes, data.closesLabel, data.source]
    );
    res.json({ tender: tenderOut((await pool.query('SELECT * FROM tenders WHERE id=$1', [id])).rows[0]) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'The tender could not be saved.' }); }
});

app.delete('/api/admin/tenders/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM tenders WHERE id = $1', [clean(req.params.id, 200)]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'The listing could not be deleted.' }); }
});

app.post('/api/admin/checked', requireAdmin, async (req, res) => {
  try {
    const v = nowIso();
    await pool.query(
      `INSERT INTO meta (key, value) VALUES ('lastChecked', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`, [v]);
    res.json({ lastChecked: v });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not update the check date.' }); }
});

// ================= STATIC SITE =================
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
app.get('/healthz', (req, res) => res.send('ok'));
app.use((req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

init()
  .then(() => app.listen(PORT, () => console.log(`Tender Gateway running on port ${PORT}`)))
  .catch((e) => { console.error('Failed to start:', e); process.exit(1); });
