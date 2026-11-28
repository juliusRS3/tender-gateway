/* Tender Gateway - front-end logic for the standalone PWA. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeUrl = u => /^https?:\/\//i.test(String(u || '')) ? String(u) : '#';
  const ext = '<svg class="icon" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 3H3v10h10v-3M9 3h4v4M13 3L7 9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtDate = iso => { if (!iso) return ''; const d = new Date(String(iso).length === 10 ? iso + 'T00:00:00' : iso); if (isNaN(d)) return iso; return `${String(d.getDate()).padStart(2, '0')} ${MON[d.getMonth()]} ${d.getFullYear()}`; };
  const fmtDT = iso => { const d = new Date(iso); if (isNaN(d)) return ''; return `${fmtDate(iso)}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const LEVELS = {
    review: { label: 'Review only', fee: 650, turnaround: '3-5 business days', scope: 'Feedback and compliance check on your existing draft' },
    cowrite: { label: 'Co-write proposal support', fee: 2400, turnaround: '7-10 business days', scope: 'Structure, key technical and commercial sections, compliance review' },
    full: { label: 'Full preparation', fee: 4800, turnaround: '10-15 business days', scope: 'End-to-end drafting, technical input coordination, final compliance pass' },
  };
  const STATUS_LBL = { pending: 'Awaiting quote', quoted: 'Quote ready', accepted: 'Accepted', declined: 'Declined', completed: 'Completed' };
  const money = (n, c) => { const v = Number(n); if (!isFinite(v)) return '-'; return `${c || 'USD'} ${v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`; };

  // ---- API helpers ----
  async function api(method, path, body) {
    const opt = { method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    const res = await fetch('/api' + path, opt);
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) { const e = new Error(data.error || 'Something went wrong.'); e.status = res.status; throw e; }
    return data;
  }

  // ---- local record of this device's requests ----
  const LS = 'tg_my_requests';
  function myIds() { try { return JSON.parse(localStorage.getItem(LS) || '[]'); } catch { return []; } }
  function rememberId(id) { try { const s = new Set(myIds()); s.add(id); localStorage.setItem(LS, JSON.stringify([...s])); } catch {} }

  let toastT;
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 3200); }

  const S = { tenders: [], tendersLoaded: false, lastChecked: null,
    myReqs: {}, isAdmin: false, adminReqs: [], adminReqsLoaded: false,
    flow: { tender: null, step: 'confirm', email: '' }, adminTab: 'req', reqFilter: 'pending', openReq: null, editing: null, delConfirm: null, view: 'board' };

  // ---------- routing ----------
  const VIEWS = ['board', 'requests', 'admin', 'flow', 'privacy', 'notice'];
  function go(v) { location.hash = v === 'board' ? '' : v; }
  function route() {
    const h = (location.hash || '').replace(/^#/, '');
    if (h.startsWith('request=')) { const id = h.slice(8); show('requests'); openRequest(id); return; }
    if (h === 'privacy-bm') { show('privacy'); const el = document.getElementById('privacy-bm'); if (el) el.scrollIntoView(); return; }
    let v = h || 'board';
    if (!VIEWS.includes(v)) v = 'board';
    show(v);
  }
  function show(v) {
    S.view = v;
    VIEWS.forEach(n => $('#v-' + n).hidden = n !== v);
    $$('.nav a').forEach(a => { if (a.dataset.go === v) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    if (v === 'requests') renderMine();
    if (v === 'admin') enterAdmin();
    window.scrollTo({ top: 0 });
  }
  window.addEventListener('hashchange', route);
  document.addEventListener('click', e => { const g = e.target.closest('[data-go]'); if (g) { e.preventDefault(); go(g.dataset.go); } });

  // ---------- tender helpers ----------
  function tenderState(t) {
    if (!t.closes) return 'open';
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const c = new Date(t.closes + 'T00:00:00');
    if (isNaN(c)) return 'open';
    const days = Math.round((c - today) / 864e5);
    if (days < 0) return 'closed';
    if (days <= 14) return 'soon';
    return 'open';
  }
  const statePill = s => s === 'closed' ? '<span class="pill p-closed"><span class="d"></span>Closed</span>'
    : s === 'soon' ? '<span class="pill p-soon"><span class="d"></span>Closing soon</span>'
      : '<span class="pill p-open"><span class="d"></span>Open</span>';
  const SECTOR_LBL = { upstream: 'Upstream', midstream: 'Midstream', downstream: 'Downstream', power: 'Power', public: 'Government' };
  const sectorPill = s => `<span class="pill p-${esc(s)}">${esc(SECTOR_LBL[s] || (s || '').replace(/^./, c => c.toUpperCase()))}</span>`;
  const reqPill = s => `<span class="pill p-${esc(s)}"><span class="d"></span>${esc(STATUS_LBL[s] || s)}</span>`;
  function sortTenders(list) {
    const rank = t => ({ soon: 0, open: 1, closed: 2 }[tenderState(t)]);
    return [...list].sort((a, b) => rank(a) - rank(b) || (a.closes || '9999').localeCompare(b.closes || '9999') || String(a.org).localeCompare(String(b.org)));
  }


  // ---------- Malaysian state detection ----------
  // Works out the state from the issuer and title. A tender may also carry an explicit `state` field.
  const MY_STATES = [
    ['Johor', ['johor', 'johor bahru', 'batu pahat', 'muar', 'kluang', 'segamat', 'pontian', 'kota tinggi', 'mersing', 'pasir gudang', 'iskandar puteri', 'kulai', 'tangkak']],
    ['Kedah', ['kedah', 'alor setar', 'alor star', 'sungai petani', 'kulim', 'langkawi', 'kubang pasu', 'jitra', 'baling', 'pendang']],
    ['Kelantan', ['kelantan', 'kota bharu', 'tumpat', 'pasir mas', 'tanah merah', 'machang', 'gua musang', 'kuala krai', 'bachok', 'jeli', 'nenggiri', 'pergau']],
    ['Melaka', ['melaka', 'malacca', 'alor gajah', 'jasin']],
    ['Negeri Sembilan', ['negeri sembilan', 'seremban', 'port dickson', 'rembau', 'jelebu', 'tampin', 'kuala pilah', 'tuanku muhriz', 'tuanku jaafar']],
    ['Pahang', ['pahang', 'kuantan', 'temerloh', 'bentong', 'raub', 'cameron highlands', 'rompin', 'jerantut', 'kuala lipis']],
    ['Penang', ['pulau pinang', 'penang', 'george town', 'georgetown', 'butterworth', 'seberang perai', 'bukit mertajam', 'gelugor', 'bayan lepas', 'prai']],
    ['Perak', ['perak', 'ipoh', 'taiping', 'teluk intan', 'kuala kangsar', 'manjung', 'janamanjung', 'lumut', 'sitiawan', 'batu gajah', 'kampar', 'sultan azlan shah', 'slim river', 'tapah', 'temenggor', 'chenderoh']],
    ['Perlis', ['perlis', 'kangar', 'arau', 'padang besar']],
    ['Sabah', ['sabah', 'kota kinabalu', 'sandakan', 'tawau', 'lahad datu', 'keningau', 'kudat', 'semporna', 'beaufort']],
    ['Sarawak', ['sarawak', 'kuching', 'miri', 'sibu', 'bintulu', 'mukah', 'kapit', 'sri aman', 'betong', 'limbang', 'lawas', 'samarahan', 'serian', 'sarikei', 'kanowit', 'baleh', 'selangau', 'bario', 'julau', 'meradong', 'simunjan', 'kabong', 'maludam', 'balingian', 'kayangeran']],
    ['Selangor', ['selangor', 'shah alam', 'petaling jaya', 'klang', 'subang', 'kajang', 'bangi', 'sepang', 'rawang', 'serdang', 'puchong', 'kapar', 'sungai buloh', 'gombak', 'hulu langat', 'banting', 'cyberjaya', 'sabak bernam', 'connaught bridge', 'sultan salahuddin abdul aziz']],
    ['Terengganu', ['terengganu', 'kemaman', 'dungun', 'besut', 'marang', 'setiu', 'kerteh', 'kertih', 'kenyir']],
    ['Kuala Lumpur', ['kuala lumpur', 'wpkl']],
    ['Putrajaya', ['putrajaya']],
    ['Labuan', ['labuan']],
  ].map(([name, words]) => [name, new RegExp('\\b(' + words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')).join('|') + ')\\b', 'i')]);
  const MULTI = 'Multiple states', NATIONAL = 'Nationwide / not stated';
  const FT = ['Kuala Lumpur', 'Putrajaya', 'Labuan'];
  function statesIn(text) { return MY_STATES.filter(([, re]) => re.test(text || '')).map(([n]) => n); }
  const isMY = t => (t.country || 'Malaysia').trim().toLowerCase() === 'malaysia';
  function tenderRegion(t) {
    if (t._region) return t._region;
    let r;
    if (!isMY(t)) r = t.country;
    else if (t.state) r = t.state;
    else {
      const byOrg = statesIn(t.org);
      if (byOrg.length === 1) r = byOrg[0];
      else {
        const found = statesIn(t.title);
        if (/\bKL\b/.test(t.title || '') && !found.includes('Kuala Lumpur')) found.push('Kuala Lumpur');
        r = found.length === 1 ? found[0] : found.length > 1 ? MULTI : NATIONAL;
      }
    }
    Object.defineProperty(t, '_region', { value: r, enumerable: false });
    return r;
  }

  // ---------- board ----------
  function renderTicker() {
    const live = S.tenders.filter(t => tenderState(t) !== 'closed');
    $('#tkListings').textContent = live.length;
    $('#tkSources').textContent = new Set(S.tenders.map(t => t.org)).size;
    const ccount = {};
    live.forEach(t => { const c = (t.country || 'Malaysia').trim(); ccount[c] = (ccount[c] || 0) + 1; });
    $('#tkCountries').textContent = Object.keys(ccount).length;
    const liveMY = live.filter(isMY);
    $('#tkStates').textContent = new Set(liveMY.map(tenderRegion).filter(r => r !== MULTI && r !== NATIONAL)).size;
    $('#lastChecked').textContent = S.lastChecked ? `Links last checked ${fmtDT(S.lastChecked)}` : (S.tendersLoaded ? 'Link index live' : 'Loading listings…');
    // Country dropdown: Malaysia first, then the others A–Z
    const csel = $('#fCountry'), ccur = csel.value;
    const ME = ['Bahrain', 'Iraq', 'Kuwait', 'Oman', 'Qatar', 'Saudi Arabia', 'United Arab Emirates'];
    const extra = Object.keys(ccount).filter(c => c !== 'Malaysia' && !ME.includes(c)).sort();
    const copt = c => `<option value="${esc(c)}"${c === ccur ? ' selected' : ''}>${esc(c)} (${ccount[c] || 0})</option>`;
    csel.innerHTML = '<option value="">All countries</option>' + copt('Malaysia')
      + `<optgroup label="Middle East (oil &amp; gas)">${ME.map(copt).join('')}</optgroup>`
      + (extra.length ? `<optgroup label="Other">${extra.map(copt).join('')}</optgroup>` : '');
    // State dropdown: Malaysian tenders only
    const sel = $('#fState'), cur = sel.value, counts = {};
    liveMY.forEach(t => { const r = tenderRegion(t); counts[r] = (counts[r] || 0) + 1; });
    const opt = n => `<option value="${esc(n)}"${n === cur ? ' selected' : ''}>${esc(n)} (${counts[n] || 0})</option>`;
    const states = MY_STATES.map(([n]) => n).filter(n => !FT.includes(n));
    sel.innerHTML = '<option value="">All states (Malaysia)</option>'
      + `<optgroup label="States">${states.map(opt).join('')}</optgroup>`
      + `<optgroup label="Federal Territories">${FT.map(opt).join('')}</optgroup>`
      + `<optgroup label="Other">${[MULTI, NATIONAL].map(opt).join('')}</optgroup>`;
  }
  function boardSort(list, how) {
    const rank = t => ({ soon: 0, open: 1, closed: 2 }[tenderState(t)]);
    const closeKey = t => t.closes || '';
    const byOrg = (a, b) => String(a.org).localeCompare(String(b.org)) || String(a.title).localeCompare(String(b.title));
    const arr = [...list];
    if (how === 'late') return arr.sort((a, b) => (rank(a) === 2) - (rank(b) === 2) || (!closeKey(a)) - (!closeKey(b)) || closeKey(b).localeCompare(closeKey(a)) || byOrg(a, b));
    if (how === 'org') return arr.sort(byOrg);
    if (how === 'country') return arr.sort((a, b) => String(a.country).localeCompare(String(b.country)) || tenderRegion(a).localeCompare(tenderRegion(b)) || (a.closes || '9999').localeCompare(b.closes || '9999'));
    return sortTenders(arr);
  }
  function renderBoard() {
    renderTicker();
    const el = $('#manifest');
    if (!S.tendersLoaded) return;
    const q = $('#fSearch').value.trim().toLowerCase(), sec = $('#fSector').value, ctf = $('#fCountry').value, stf = $('#fCountry').value === 'Malaysia' ? $('#fState').value : '', showClosed = $('#fClosed').checked;
    const list = boardSort(S.tenders, $('#fSort').value).filter(t => {
      if (!showClosed && tenderState(t) === 'closed') return false;
      if (sec && t.sector !== sec) return false;
      if (ctf && (t.country || 'Malaysia').trim() !== ctf) return false;
      if (stf && (!isMY(t) || tenderRegion(t) !== stf)) return false;
      if (q && !`${t.title} ${t.org} ${t.ref} ${t.country || 'Malaysia'} ${tenderRegion(t)} ${isMY(t) ? '' : 'middle east'}`.toLowerCase().includes(q)) return false;
      return true;
    });
    { const ctf2 = $('#fCountry').value, st2 = $('#fState').value;
      const where = st2 && ctf2 === 'Malaysia' ? ` in ${st2}, Malaysia` : ctf2 ? ` in ${ctf2}` : ' in all countries';
      $('#resultCount').textContent = S.tenders.length ? `Showing ${list.length} ${list.length === 1 ? 'tender' : 'tenders'}${where}` : ''; }
    if (!S.tenders.length) { el.innerHTML = `<div class="empty" style="margin-top:16px"><strong>No tenders listed yet</strong><p>New listings will appear here as they are indexed.</p></div>`; return; }
    if (!list.length) { el.innerHTML = `<div class="empty" style="margin-top:16px"><strong>No tenders match these filters</strong><p>Try clearing the search or ticking "Show closed".</p></div>`; return; }
    el.innerHTML = list.map(t => {
      const st = tenderState(t);
      return `<article class="row${st === 'closed' ? ' closed' : ''}">
        <div class="ref">${esc(t.ref)}</div>
        <div style="min-width:0"><h3>${esc(t.title)}</h3>
          <div class="meta"><span>${esc(t.org)}</span><span>${esc(!isMY(t) ? t.country : tenderRegion(t) === NATIONAL ? 'Malaysia (nationwide)' : tenderRegion(t) + ', Malaysia')}</span><span>${t.closes ? (st === 'closed' ? 'Closed ' : 'Closes ') + fmtDate(t.closes) : esc(t.closesLabel || 'Rolling registration')}</span></div>
          <div class="pills">${statePill(st)}${sectorPill(t.sector)}</div></div>
        <div class="acts">
          <a class="btn btn-p" href="${esc(safeUrl(t.source))}" target="_blank" rel="noopener noreferrer"><span class="k">1.</span> Get tender document ${ext}</a>
          <button class="btn" data-consult="${esc(t.id)}" ${st === 'closed' ? 'disabled' : ''}><span class="k">2.</span> Request consultancy</button>
        </div></article>`;
    }).join('');
  }
  ['#fSearch', '#fSector', '#fSort', '#fClosed'].forEach(s => $(s).addEventListener('input', renderBoard));
  // Picking a state switches Country to Malaysia; picking any other country (or All countries) clears the state
  const onState = () => { if ($('#fState').value) $('#fCountry').value = 'Malaysia'; renderBoard(); };
  const onCountry = () => { if ($('#fCountry').value !== 'Malaysia') $('#fState').value = ''; renderBoard(); };
  ['input', 'change'].forEach(ev => { $('#fState').addEventListener(ev, onState); $('#fCountry').addEventListener(ev, onCountry); });
  $('#manifest').addEventListener('click', e => { const b = e.target.closest('[data-consult]'); if (b) startFlow(b.dataset.consult); });

  // ---------- flow ----------
  const STEPS = [['confirm', 'Confirm'], ['terms', 'Terms'], ['request', 'Request']];
  function startFlow(id) {
    const t = S.tenders.find(x => x.id === id); if (!t) return;
    S.flow = { tender: t, step: 'confirm', email: '' };
    $('#cDoc').checked = false; $('#cTerms').checked = false; $('#toTerms').disabled = true; $('#toRequest').disabled = true;
    $$('.js-org').forEach(e => e.textContent = t.org);
    $('.js-ref').textContent = t.ref; $('.js-title').textContent = t.title; $('.js-src').href = safeUrl(t.source);
    $('#rTender').value = `${t.ref} · ${t.title}`;
    $('#reqErr').hidden = true;
    setStep('confirm'); show('flow');
  }
  function setStep(step) {
    S.flow.step = step;
    $$('.fs').forEach(f => f.hidden = f.id !== 'fs-' + step);
    const idx = STEPS.findIndex(s => s[0] === step), done = step === 'done';
    $('#rail').hidden = done; $('#flowBack').hidden = done;
    $('#rail').innerHTML = STEPS.map(([k, l], i) => {
      const cls = done || i < idx ? 'done' : i === idx ? 'on' : '';
      return (i ? `<div class="ln ${done || i <= idx ? 'done' : ''}"></div>` : '') + `<div class="step ${cls}"><span class="n">${cls === 'done' ? '✓' : i + 1}</span><span class="lbl">${l}</span></div>`;
    }).join('');
    $('#flowBackLbl').textContent = idx <= 0 ? 'Back to tenders' : `Back to ${STEPS[idx - 1][1].toLowerCase()}`;
    window.scrollTo({ top: 0 });
  }
  $('#flowBack').addEventListener('click', () => { const i = STEPS.findIndex(s => s[0] === S.flow.step); if (i <= 0) go('board'); else setStep(STEPS[i - 1][0]); });
  $('#cDoc').addEventListener('change', e => $('#toTerms').disabled = !e.target.checked);
  $('#cTerms').addEventListener('change', e => $('#toRequest').disabled = !e.target.checked);
  $('#toTerms').addEventListener('click', () => setStep('terms'));
  $('#toRequest').addEventListener('click', () => setStep('request'));

  $('#reqForm').addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#reqErr'); err.hidden = true;
    const v = id => $('#' + id).value.trim();
    const missing = [['rCompany', 'company name'], ['rCountry', 'country'], ['rName', 'contact person'], ['rEmail', 'email']].filter(([id]) => !v(id)).map(x => x[1]);
    if (missing.length) { err.textContent = `Please fill in: ${missing.join(', ')}.`; err.hidden = false; return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v('rEmail'))) { err.textContent = 'Enter a valid email address, like name@company.com.'; err.hidden = false; return; }
    const btn = $('#reqSubmit'); btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const { request } = await api('POST', '/requests', {
        tenderId: S.flow.tender.id, company: v('rCompany'), country: v('rCountry'),
        contactName: v('rName'), email: v('rEmail'), level: $('#rLevel').value, notes: v('rNotes'),
      });
      rememberId(request.id); S.myReqs[request.id] = request;
      $('.js-email').textContent = request.email; $('.js-reqid').textContent = request.id;
      $('#rNotes').value = '';
      setStep('done');
    } catch (ex) {
      err.textContent = ex.message || 'The request could not be sent. Please try again.'; err.hidden = false;
    } finally { btn.disabled = false; btn.textContent = 'Submit request'; }
  });

  // ---------- my requests ----------
  function quoteBox(q) {
    return `<div class="quote">
      <div class="qrow"><span>Estimated turnaround</span><span>${esc(q.turnaround)}</span></div>
      <div class="qrow"><span>Scope</span><span>${esc(q.scope)}</span></div>
      ${q.note ? `<div class="qrow"><span>Note from consultant</span><span>${esc(q.note)}</span></div>` : ''}
      <div class="qtotal"><span class="muted">Quoted fee</span><span class="amt">${esc(money(q.fee, q.currency))}</span></div>
    </div>`;
  }
  function reqDetails(r) {
    const L = LEVELS[r.level] || {};
    return `<dl class="kv">
      <div><dt>Issuer</dt><dd>${esc(r.tenderOrg)}</dd></div>
      <div><dt>Support level</dt><dd>${esc(L.label || r.level)}</dd></div>
      <div><dt>Company</dt><dd>${esc(r.company)} · ${esc(r.country)}</dd></div>
      <div><dt>Contact</dt><dd>${esc(r.contactName)}<br><span class="mono" style="font-size:12px">${esc(r.email)}</span></dd></div>
      <div><dt>Requested</dt><dd>${fmtDT(r.createdAt)}</dd></div>
    </dl>${r.notes ? `<div class="inset" style="font-size:13px;color:var(--text-2);white-space:pre-wrap">${esc(r.notes)}</div>` : ''}`;
  }
  async function loadMine() {
    const ids = myIds();
    await Promise.all(ids.map(async id => {
      try { const { request } = await api('GET', '/requests/' + encodeURIComponent(id)); S.myReqs[id] = request; }
      catch (e) { if (e.status === 404) delete S.myReqs[id]; }
    }));
  }
  async function openRequest(id) {
    show('requests');
    try { const { request } = await api('GET', '/requests/' + encodeURIComponent(id)); rememberId(id); S.myReqs[id] = request; renderMine(); }
    catch { toast('That request reference was not found.'); }
  }
  async function renderMine() {
    await loadMine();
    const el = $('#myList');
    const list = Object.values(S.myReqs).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    if (!list.length) { el.innerHTML = `<div class="empty"><strong>No requests yet</strong><p>Browse tenders and request consultancy to prepare your proposal.</p><button class="btn btn-p" data-go="board">Browse tenders</button></div>`; return; }
    el.innerHTML = list.map(r => {
      const q = r.quote; let action = '';
      if (r.status === 'pending') action = `<p class="hint" style="margin:0">Our team is reviewing your request. The quote will appear here and be emailed to you.</p>`;
      if (r.status === 'quoted' && q) action = `${quoteBox(q)}
        <label class="agree"><input type="checkbox" data-accchk="${esc(r.id)}"><span><b>I accept this quote</b> and understand the fee is specific to the scope above. Tender Gateway's consultancy does not guarantee tender success.</span></label>
        <div class="btnrow"><button class="btn btn-p" data-accept="${esc(r.id)}" disabled>Accept quote and proceed</button><button class="btn" data-decline="${esc(r.id)}">Decline</button></div>`;
      if (r.status === 'accepted' && q) action = `${quoteBox(q)}<p class="hint" style="margin:0">Accepted ${fmtDT(r.acceptedAt)}. A consultant will contact you at ${esc(r.email)} within one business day to begin work.</p>`;
      if (r.status === 'completed' && q) action = `${quoteBox(q)}<p class="hint" style="margin:0">Work completed ${fmtDate(r.completedAt)}.</p>`;
      if (r.status === 'declined') action = `${q ? quoteBox(q) : ''}<p class="hint" style="margin:0">${r.declinedBy === 'team' ? 'Our team was unable to take on this request.' : 'You declined this quote.'}</p>`;
      return `<article class="req"><header><div><div class="mono muted" style="font-size:12px">${esc(r.tenderRef)}</div><h3>${esc(r.tenderTitle)}</h3><span class="muted" style="font-size:12px">${esc(r.tenderOrg)} · ref ${esc(r.id)} · requested ${fmtDate(r.createdAt)}</span></div>${reqPill(r.status)}</header>
        <div class="body">${action}<details><summary class="muted" style="cursor:pointer;font-size:12px">Request details</summary><div style="margin-top:12px" class="stack">${reqDetails(r)}</div></details></div></article>`;
    }).join('');
  }
  $('#lookupForm').addEventListener('submit', e => { e.preventDefault(); const id = $('#lookupId').value.trim(); if (id) { $('#lookupId').value = ''; go('request=' + encodeURIComponent(id)); } });
  $('#myList').addEventListener('change', e => { const c = e.target.closest('[data-accchk]'); if (c) { const b = $(`[data-accept="${CSS.escape(c.dataset.accchk)}"]`); if (b) b.disabled = !c.checked; } });
  $('#myList').addEventListener('click', async e => {
    const a = e.target.closest('[data-accept]'), d = e.target.closest('[data-decline]');
    const id = a?.dataset.accept || d?.dataset.decline; if (!id) return;
    (a || d).disabled = true;
    try {
      const { request } = await api('POST', `/requests/${encodeURIComponent(id)}/${a ? 'accept' : 'decline'}`);
      S.myReqs[id] = request; toast(a ? 'Quote accepted' : 'Quote declined'); renderMine();
    } catch (ex) { toast(ex.message || 'That change could not be saved.'); (a || d).disabled = false; }
  });

  // ---------- admin ----------
  async function enterAdmin() {
    try { const { admin } = await api('GET', '/admin/status'); S.isAdmin = !!admin; } catch { S.isAdmin = false; }
    $('#adminLogin').hidden = S.isAdmin; $('#adminPanel').hidden = !S.isAdmin;
    if (S.isAdmin) { await loadAdminReqs(); renderAdmin(); }
  }
  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault(); const err = $('#loginErr'); err.hidden = true;
    try { await api('POST', '/admin/login', { password: $('#adminPw').value }); $('#adminPw').value = ''; S.isAdmin = true; await enterAdmin(); toast('Signed in'); }
    catch (ex) { err.textContent = ex.message || 'Wrong password.'; err.hidden = false; }
  });
  $('#logoutBtn').addEventListener('click', async () => { try { await api('POST', '/admin/logout'); } catch {} S.isAdmin = false; enterAdmin(); });

  async function loadAdminReqs() {
    try { const { requests } = await api('GET', '/admin/requests'); S.adminReqs = requests; S.adminReqsLoaded = true; }
    catch { S.adminReqs = []; S.adminReqsLoaded = true; }
  }
  $('#tabReq').addEventListener('click', () => { S.adminTab = 'req'; renderAdmin(); });
  $('#tabTen').addEventListener('click', () => { S.adminTab = 'ten'; renderAdmin(); });
  $('#reqFilter').addEventListener('click', e => { const b = e.target.closest('[data-f]'); if (!b) return; S.reqFilter = b.dataset.f; renderAdmin(); });

  function renderAdmin() {
    if (!S.isAdmin) return;
    $('#tcReq').textContent = S.adminReqs.length || ''; $('#tcTen').textContent = S.tenders.length || '';
    $('#tabReq').setAttribute('aria-selected', S.adminTab === 'req'); $('#tabTen').setAttribute('aria-selected', S.adminTab === 'ten');
    $('#ap-req').hidden = S.adminTab !== 'req'; $('#ap-ten').hidden = S.adminTab !== 'ten';
    $$('#reqFilter [data-f]').forEach(b => b.setAttribute('aria-pressed', b.dataset.f === S.reqFilter));
    renderAdminReqs(); renderAdminTenders();
  }
  function renderAdminReqs() {
    const el = $('#adminReqs');
    if (!S.adminReqsLoaded) { el.innerHTML = '<div class="empty"><strong>Loading requests…</strong><p>&nbsp;</p></div>'; return; }
    const f = S.reqFilter;
    const list = S.adminReqs.filter(r => f === 'all' || (f === 'closed' ? (r.status === 'completed' || r.status === 'declined') : r.status === f));
    if (!list.length) { el.innerHTML = `<div class="empty"><strong>${f === 'pending' ? 'No requests waiting for a quote' : 'Nothing here'}</strong><p>New consultancy requests appear under "Needs quote".</p></div>`; return; }
    el.innerHTML = list.map(r => {
      const open = S.openReq === r.id, L = LEVELS[r.level] || LEVELS.cowrite, q = r.quote || {};
      let actions = '';
      if (r.status === 'pending' || (r.status === 'quoted' && open)) actions = `
        <form class="stack" data-qform="${esc(r.id)}" novalidate>
          <h3 style="font-size:14px;font-weight:600">${r.status === 'quoted' ? 'Revise quote' : 'Send quote'}</h3>
          <div class="grid2">
            <div class="field"><label for="qf-${esc(r.id)}">Fee</label><div style="display:flex;gap:6px"><select class="ctl" id="qc-${esc(r.id)}" aria-label="Currency" style="flex:0 0 auto">${['USD', 'MYR', 'OMR', 'AED', 'QAR', 'SAR', 'INR'].map(c => `<option${(q.currency || 'USD') === c ? ' selected' : ''}>${c}</option>`).join('')}</select><input id="qf-${esc(r.id)}" type="number" min="0" step="any" value="${esc(q.fee ?? L.fee)}"></div><span class="hint">Suggested for ${esc(L.label.toLowerCase())}: USD ${L.fee.toLocaleString()}</span></div>
            <div class="field"><label for="qt-${esc(r.id)}">Turnaround</label><input id="qt-${esc(r.id)}" value="${esc(q.turnaround || L.turnaround)}"></div>
          </div>
          <div class="field"><label for="qs-${esc(r.id)}">Scope</label><textarea id="qs-${esc(r.id)}" style="min-height:64px">${esc(q.scope || L.scope)}</textarea></div>
          <div class="field"><label for="qn-${esc(r.id)}">Note to client <span class="muted">(optional)</span></label><input id="qn-${esc(r.id)}" value="${esc(q.note || '')}"></div>
          <div class="btnrow"><button class="btn btn-p" type="submit">${r.status === 'quoted' ? 'Update quote' : 'Send quote'}</button>${r.status === 'pending' ? `<button class="btn btn-danger" type="button" data-adecline="${esc(r.id)}">Decline request</button>` : `<button class="btn" type="button" data-toggle="${esc(r.id)}">Cancel</button>`}</div>
        </form>`;
      else if (r.status === 'quoted') actions = `${quoteBox(q)}<div class="btnrow"><span class="hint" style="align-self:center">Sent ${fmtDT(q.sentAt)}. Waiting for the client to accept.</span><button class="btn btn-sm" data-toggle="${esc(r.id)}">Revise quote</button></div>`;
      else if (r.status === 'accepted') actions = `${quoteBox(q)}<div class="btnrow"><span class="hint" style="align-self:center">Accepted ${fmtDT(r.acceptedAt)}. Contact ${esc(r.contactName)} to start.</span><button class="btn btn-sm" data-complete="${esc(r.id)}">Mark completed</button></div>`;
      else actions = `${r.quote ? quoteBox(q) : ''}<p class="hint" style="margin:0">${r.status === 'completed' ? 'Completed ' + fmtDate(r.completedAt) : (r.declinedBy === 'team' ? 'Declined by your team.' : 'Declined by the client.')}</p>`;
      return `<article class="req"><header><div><div class="mono muted" style="font-size:12px">${esc(r.tenderRef)} · ${esc(L.label)}</div><h3>${esc(r.company)} <span class="muted" style="font-weight:400">— ${esc(r.tenderTitle)}</span></h3><span class="muted" style="font-size:12px">${esc(r.contactName)} · ${esc(r.email)} · ${fmtDT(r.createdAt)}</span></div>${reqPill(r.status)}</header>
        <div class="body">${reqDetails(r)}<a class="link" href="${esc(safeUrl(r.tenderSource))}" target="_blank" rel="noopener noreferrer">Open the tender at source ${ext}</a>${actions}</div></article>`;
    }).join('');
  }
  $('#adminReqs').addEventListener('click', async e => {
    const t = e.target.closest('[data-toggle]'); if (t) { S.openReq = S.openReq === t.dataset.toggle ? null : t.dataset.toggle; renderAdmin(); return; }
    const dc = e.target.closest('[data-adecline]'), cp = e.target.closest('[data-complete]');
    const btn = dc || cp; if (!btn) return;
    const id = dc ? dc.dataset.adecline : cp.dataset.complete; btn.disabled = true;
    try {
      const { request } = await api('POST', `/admin/requests/${encodeURIComponent(id)}/${dc ? 'decline' : 'complete'}`);
      upsertAdminReq(request); toast(dc ? 'Request declined' : 'Marked completed'); renderAdmin();
    } catch (ex) { btn.disabled = false; toast(ex.message || 'That change could not be saved.'); }
  });
  $('#adminReqs').addEventListener('submit', async e => {
    const f = e.target.closest('[data-qform]'); if (!f) return; e.preventDefault();
    const id = f.dataset.qform;
    const g = p => $('#' + p + '-' + CSS.escape(id)).value.trim();
    const fee = Number(g('qf'));
    if (!isFinite(fee) || fee <= 0) { toast('Enter a fee above zero.'); return; }
    if (!g('qt') || !g('qs')) { toast('Fill in the turnaround and scope.'); return; }
    const btn = f.querySelector('[type=submit]'); btn.disabled = true;
    try {
      const { request } = await api('POST', `/admin/requests/${encodeURIComponent(id)}/quote`, { fee, currency: g('qc'), turnaround: g('qt'), scope: g('qs'), note: g('qn') });
      upsertAdminReq(request); S.openReq = null; toast('Quote sent to ' + request.contactName); renderAdmin();
    } catch (ex) { btn.disabled = false; toast(ex.message || 'The quote could not be sent.'); }
  });
  function upsertAdminReq(r) { const i = S.adminReqs.findIndex(x => x.id === r.id); if (i >= 0) S.adminReqs[i] = r; else S.adminReqs.unshift(r); }

  function renderAdminTenders() {
    $('#checkedNote').textContent = S.lastChecked ? `Links last marked checked ${fmtDT(S.lastChecked)}` : 'Links not yet marked as checked';
    const el = $('#adminTenders');
    if (!S.tenders.length) { el.innerHTML = '<div class="empty" style="border:0"><strong>No tenders yet</strong><p>Add your first listing with "+ Add tender".</p></div>'; return; }
    el.innerHTML = sortTenders(S.tenders).map(t => {
      const st = tenderState(t);
      const del = S.delConfirm === t.id
        ? `<span class="confirmdel">Delete this listing? <button class="btn btn-sm btn-danger" data-delyes="${esc(t.id)}">Delete</button><button class="btn btn-sm" data-delno>Keep</button></span>`
        : `<button class="btn btn-sm" data-edit="${esc(t.id)}">Edit</button><button class="btn btn-sm btn-danger" data-del="${esc(t.id)}">Delete</button>`;
      return `<div class="arow"><div style="min-width:0"><div class="top1"><span class="mono muted" style="font-size:11px">${esc(t.ref)}</span>${statePill(st)}${sectorPill(t.sector)}</div>
        <div class="t">${esc(t.title)}</div><div class="s">${esc(t.org)} · ${esc(t.country)} · ${t.closes ? 'Closes ' + fmtDate(t.closes) : esc(t.closesLabel || 'Rolling')} · <a class="link" href="${esc(safeUrl(t.source))}" target="_blank" rel="noopener noreferrer">source ${ext}</a></div></div>
        <div class="btnrow" style="justify-content:flex-end">${del}</div></div>`;
    }).join('');
  }
  function openEditor(t) {
    S.editing = t ? t.id : 'new';
    $('#tEdTitle').textContent = t ? 'Edit tender' : 'Add tender';
    $('#tRef').value = t?.ref || ''; $('#tOrg').value = t?.org || ''; $('#tTitle').value = t?.title || ''; $('#tCountry').value = t?.country || '';
    $('#tSector').value = t?.sector || 'upstream'; $('#tCloses').value = t?.closes || ''; $('#tSource').value = t?.source || '';
    $('#tErr').hidden = true; $('#tEditor').hidden = false; $('#tRef').focus();
  }
  $('#addTender').addEventListener('click', () => openEditor(null));
  $('#tCancel').addEventListener('click', () => { $('#tEditor').hidden = true; S.editing = null; });
  $('#adminTenders').addEventListener('click', async e => {
    const ed = e.target.closest('[data-edit]'), dl = e.target.closest('[data-del]'), yes = e.target.closest('[data-delyes]'), no = e.target.closest('[data-delno]');
    if (ed) { openEditor(S.tenders.find(t => t.id === ed.dataset.edit)); window.scrollTo({ top: 0 }); }
    if (dl) { S.delConfirm = dl.dataset.del; renderAdminTenders(); }
    if (no) { S.delConfirm = null; renderAdminTenders(); }
    if (yes) {
      try { await api('DELETE', '/admin/tenders/' + encodeURIComponent(yes.dataset.delyes)); S.tenders = S.tenders.filter(t => t.id !== yes.dataset.delyes); S.delConfirm = null; toast('Listing deleted'); renderBoard(); renderAdmin(); }
      catch (ex) { toast(ex.message || 'The listing could not be deleted.'); }
    }
  });
  $('#tEditor').addEventListener('submit', async e => {
    e.preventDefault();
    const v = id => $('#' + id).value.trim(), err = $('#tErr');
    const payload = { ref: v('tRef'), org: v('tOrg'), title: v('tTitle'), country: v('tCountry'), sector: $('#tSector').value, closes: $('#tCloses').value || '', source: v('tSource') };
    if (S.editing && S.editing !== 'new') payload.id = S.editing;
    const miss = ['ref', 'org', 'title', 'country', 'source'].filter(k => !payload[k]);
    if (miss.length) { err.textContent = 'Fill in every field except the closing date.'; err.hidden = false; return; }
    if (!/^https?:\/\//i.test(payload.source)) { err.textContent = 'The source link must start with https://'; err.hidden = false; return; }
    try {
      const { tender } = await api('POST', '/admin/tenders', payload);
      const i = S.tenders.findIndex(t => t.id === tender.id); if (i >= 0) S.tenders[i] = tender; else S.tenders.push(tender);
      $('#tEditor').hidden = true; S.editing = null; toast('Tender saved'); renderBoard(); renderAdmin();
    } catch (ex) { err.textContent = ex.message || 'The tender could not be saved.'; err.hidden = false; }
  });
  $('#markChecked').addEventListener('click', async () => {
    try { const { lastChecked } = await api('POST', '/admin/checked'); S.lastChecked = lastChecked; toast('Marked links as checked'); renderTicker(); renderAdminTenders(); }
    catch (ex) { toast(ex.message || 'Could not update the check date.'); }
  });

  // ---------- boot ----------
  async function boot() {
    route();
    try {
      const { tenders, lastChecked } = await api('GET', '/tenders');
      S.tenders = tenders; S.lastChecked = lastChecked; S.tendersLoaded = true;
    } catch {
      S.tendersLoaded = true;
      $('#dbBanner').innerHTML = '<div class="banner bad">The tender list could not be loaded. Please reload the page.</div>';
    }
    renderBoard();
    if (S.view === 'admin') enterAdmin();
    if (S.view === 'requests') renderMine();
  }
  boot();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }
})();
