/* Shipment Tracker: website logic. Data lives in Supabase; see ../supabase/schema.sql. */
(() => {
  const $ = (id) => document.getElementById(id);
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const cfg = window.TRACKER_CONFIG || {};
  const S = {
    sb: null, session: null, me: null, profile: null, profiles: new Map(),
    ships: new Map(), recent: [], docs: new Map(), detail: [],
    stage: 'open', q: '', kind: '', logFilter: '', view: 'ships',
    openId: null, isNew: false, saving: false, uploading: false, started: false, recovering: false,
  };

  // ---------- helpers ----------
  const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v; else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
    return el;
  };
  const todayIso = () => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`; };
  const isDateStr = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const fmtDate = (s) => { if (!isDateStr(s)) return s || ''; const [y, m, d] = s.split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };
  const fmtShort = (s) => { if (!isDateStr(s)) return s || ''; const [, m, d] = s.split('-').map(Number); return `${d} ${MONTHS[m - 1]}`; };
  const fmtWhen = (iso) => { if (!iso) return ''; const d = new Date(iso); if (isNaN(d)) return iso; return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const days = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
  const fmtNum = (v, dp) => (v === null || v === undefined || v === '' ? '' : Number(v).toLocaleString('en', { minimumFractionDigits: dp || 0, maximumFractionDigits: dp ?? 3 }));
  const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
  const toast = (msg) => { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 2800); };
  const notice = (msg, bad) => { const n = $('notice'); n.textContent = msg || ''; n.className = 'notice' + (bad ? ' bad' : ''); n.hidden = !msg; };
  const errText = (e) => (e && (e.message || e.error_description)) || 'Something went wrong.';

  const stageOf = (s) => {
    const st = String(s.status || '').trim().toLowerCase();
    if (st.startsWith('cancel')) return 'other';
    if (st === 'received' || st.startsWith('delivered') || (s.arrived_on && !st.startsWith('picked') && !st.startsWith('not pick'))) return 'done';
    if (st.startsWith('not pick')) return 'wait';
    if (st.startsWith('picked') || st.includes('transit')) return (s.eta && s.eta < todayIso()) ? 'late' : 'way';
    return st ? 'other' : 'wait';
  };
  const STAGE_LABEL = { wait: 'Waiting at supplier', way: 'On the way', late: 'Past ETA', done: 'Arrived', other: 'Other' };
  const nextDate = (s) => { const g = stageOf(s); return g === 'wait' ? s.ready_on : g === 'done' ? s.arrived_on : s.eta; };
  const nameOf = (id) => {
    if (!id) return 'Imported from Google Sheet';
    const p = S.profiles.get(id);
    const n = p ? [p.first_name, p.last_name].filter(Boolean).join(' ') : '';
    return (n || 'A team member') + (id === S.me ? ' (you)' : '');
  };

  // ---------- screens ----------
  const FORMS = ['in-form', 'up-form', 'fg-form', 'pw-form', 'nm-form'];
  const gate = (title, text, form, showOut) => {
    $('gate').hidden = false;
    ['view-ships', 'view-log', 'view-team'].forEach((id) => { $(id).hidden = true; });
    $('tabs').hidden = true; $('add-btn').hidden = true; $('foot').hidden = true;
    $('gate-title').textContent = title; $('gate-text').textContent = text || '';
    FORMS.forEach((f) => { $(f).hidden = f !== form; });
    $('gate-out').hidden = !showOut;
    document.querySelectorAll('.err').forEach((e) => { e.hidden = true; });
    if (S.openId || S.isNew) closeSheet();
  };
  const showErr = (id, msg) => { $(id).textContent = msg; $(id).hidden = false; };

  // ---------- data ----------
  const loadProfiles = async () => {
    const { data, error } = await S.sb.from('profiles').select('id, first_name, last_name, email, role, created_at');
    if (error) throw error;
    S.profiles = new Map(data.map((p) => [p.id, p]));
    S.profile = S.profiles.get(S.me) || S.profile;
  };
  const loadShipments = async () => {
    const { data, error } = await S.sb.from('shipments').select('*').limit(5000);
    if (error) throw error;
    S.ships = new Map(data.map((s) => [s.id, s]));
  };
  const loadRecent = async () => {
    const { data, error } = await S.sb.from('history').select('*').order('changed_at', { ascending: false }).limit(300);
    if (error) throw error;
    S.recent = data;
  };
  const loadDocs = async () => {
    const { data, error } = await S.sb.from('documents').select('*').limit(5000);
    if (error) throw error;
    S.docs = new Map(data.map((d) => [d.id, d]));
  };
  const loadDetail = async (id) => {
    const { data } = await S.sb.from('history').select('*').eq('shipment_id', id).order('changed_at', { ascending: false }).limit(500);
    if (S.openId === id) { S.detail = data || []; renderDetailLog(); }
  };

  // ---------- list ----------
  const filtered = () => [...S.ships.values()].filter((s) => {
    const g = stageOf(s);
    if (S.kind && s.kind !== S.kind) return false;
    if (S.stage === 'open' && !(g === 'wait' || g === 'way' || g === 'late')) return false;
    if (['wait', 'way', 'late', 'done'].includes(S.stage) && g !== S.stage) return false;
    if (S.q && ![s.sn, s.po_number, s.product, s.tracking, s.carrier, s.remarks, s.status, s.company, s.contact].join(' ').toLowerCase().includes(S.q)) return false;
    return true;
  }).sort((a, b) => {
    if (S.stage === 'done' || S.stage === 'all') return String(nextDate(b) || '').localeCompare(String(nextDate(a) || '')) || (b.sn || 0) - (a.sn || 0);
    return String(nextDate(a) || '9999').localeCompare(String(nextDate(b) || '9999'));
  });

  const normPoL = (p) => String(p || '').trim().toLowerCase();
  const renderList = () => {
    const all = [...S.ships.values()];
    const c = { open: 0, wait: 0, way: 0, late: 0, done: 0, all: all.length };
    for (const s of all) { const g = stageOf(s); if (c[g] !== undefined) c[g]++; if (g === 'wait' || g === 'way' || g === 'late') c.open++; }
    for (const [k, v] of Object.entries(c)) document.querySelectorAll(`[data-n="${k}"]`).forEach((el) => { el.textContent = v; });
    const rows = filtered();
    $('count').textContent = `${rows.length} of ${all.length} shipments`;
    const poModes = {};
    for (const x of all) { const k = normPoL(x.po_number); if (!k) continue; (poModes[k] = poModes[k] || { n: 0, modes: new Set() }).n++; if (x.mode) poModes[k].modes.add(x.mode); }
    const docCount = {};
    for (const d of S.docs.values()) docCount[d.shipment_id] = (docCount[d.shipment_id] || 0) + 1;
    const body = $('rows');
    if (!rows.length) { body.replaceChildren(h('tr', null, h('td', { colspan: 7, class: 'empty', text: all.length ? 'No shipments match.' : 'No shipments yet.' }))); return; }
    body.replaceChildren(...rows.map((s) => {
      const g = stageOf(s);
      const etaCell = h('td', { class: 'nowrap' });
      if (g === 'wait') etaCell.append(s.ready_on ? h('span', null, 'Ready ', fmtShort(s.ready_on)) : h('span', { class: 'muted', text: 'No date' }));
      else if (g === 'done') etaCell.append(s.arrived_on ? h('span', { class: 'muted' }, 'Arrived ', fmtShort(s.arrived_on)) : '');
      else if (s.eta) {
        etaCell.append(fmtDate(s.eta));
        if (s.promised_eta && s.promised_eta !== s.eta) { const d = days(s.promised_eta, s.eta); etaCell.append(h('span', { class: 'shift ' + (d > 0 ? 'later' : 'earlier'), title: 'Compared with the first ETA ' + fmtDate(s.promised_eta), text: (d > 0 ? '+' : '') + d + 'd' })); }
      } else etaCell.append(h('span', { class: 'muted', text: 'No ETA' }));
      const last = s.updated_by ? h('span', { class: 'who' }, nameOf(s.updated_by), h('br'), fmtWhen(s.updated_at)) : h('span', { class: 'who', text: 'Imported' });
      const n = docCount[s.id];
      return h('tr', { tabindex: 0, onclick: () => openSheet(s.id), onkeydown: (e) => { if (e.key === 'Enter') openSheet(s.id); } },
        h('td', { class: 'mono' }, fmtNum(s.sn)),
        h('td', { class: 'prod' }, s.product, h('small', null, [s.kind, s.po_number ? 'PO ' + s.po_number : '', s.qty ? fmtNum(s.qty) + ' pcs' : '', s.company].filter(Boolean).join(' · '), n ? h('span', { class: 'clip', text: ' · ' + n + (n === 1 ? ' document' : ' documents') }) : '', (() => { const pm = poModes[normPoL(s.po_number)]; return pm && pm.n > 1 ? h('span', { class: 'clip', text: ' · split: ' + pm.n + ' parts' + (pm.modes.size ? ' (' + [...pm.modes].join(' + ') + ')' : '') }) : ''; })())),
        h('td', null, h('span', { class: 'pill ' + g, text: g === 'other' ? (s.status || 'Other') : STAGE_LABEL[g] })),
        etaCell,
        h('td', { class: 'hide-sm' }, s.mode || ''),
        h('td', { class: 'hide-sm' }, s.carrier || '', s.tracking && s.tracking !== s.carrier ? h('div', { class: 'mono muted', text: s.tracking }) : ''),
        h('td', { class: 'hide-sm' }, last));
    }));
  };

  // ---------- change log ----------
  const DATE_FIELDS = ['eta', 'ready_on', 'arrived_on', 'promised_eta', 'duty_paid_on'];
  const describe = (ev) => {
    const box = h('div', { class: 'what' });
    if (ev.field === 'note') { box.append('Added a note'); return [box, h('div', { class: 'note', text: ev.new_value || '' })]; }
    if (ev.field === 'created') { box.append('Added this shipment'); return [box]; }
    if (ev.field === 'split' || ev.field === 'stock') { box.append(h('b', { text: ev.field === 'split' ? 'Split: ' : 'Stock: ' }), ev.new_value || ''); return [box]; }
    if (ev.field === 'file') { box.append('Uploaded ', h('b', { text: (ev.label || 'document').toLowerCase() }), ': ', ev.new_value || ''); return [box]; }
    const isDate = DATE_FIELDS.includes(ev.field);
    const f = (v) => (v === null || v === undefined || v === '' ? 'blank' : isDate ? fmtDate(v) : String(v));
    box.append('Changed ', h('b', { text: ev.label || ev.field }), ' ');
    if (ev.old_value !== null && ev.old_value !== undefined && ev.old_value !== '') box.append(h('span', { class: 'from', text: f(ev.old_value) }), ' → ');
    box.append(h('b', { text: f(ev.new_value) }));
    if (isDate && isDateStr(ev.old_value) && isDateStr(ev.new_value)) { const d = days(ev.old_value, ev.new_value); if (d) box.append(h('span', { class: 'shift ' + (d > 0 ? 'later' : 'earlier'), text: (d > 0 ? '+' : '') + d + ' days' })); }
    const out = [box];
    if (ev.reason) out.push(h('div', { class: 'reason', text: ev.reason }));
    return out;
  };
  const evRow = (ev, withShipment) => {
    const s = S.ships.get(ev.shipment_id);
    return h('div', { class: 'ev' }, h('span'),
      h('div', { style: 'min-width:0' },
        h('div', { class: 'line1' }, h('b', { text: nameOf(ev.changed_by) }), h('span', { class: 'who', text: fmtWhen(ev.changed_at) })),
        withShipment ? h('div', null, h('button', { class: 'linkish', onclick: () => s && openSheet(ev.shipment_id), text: (s && s.sn ? 'S/N ' + fmtNum(s.sn) + ' · ' : '') + (s ? s.product : 'Shipment') })) : '',
        ...describe(ev)));
  };
  const renderLog = () => {
    const evs = S.recent.filter((e) => !S.logFilter || e.field === S.logFilter);
    $('log-count').textContent = evs.length ? `Latest ${evs.length} changes` : '';
    $('log').replaceChildren(...(evs.length ? evs.map((e) => evRow(e, true)) : [h('div', { class: 'empty', text: 'No changes yet. When someone edits a shipment, it shows here with their name and the time.' })]));
  };
  const renderDetailLog = () => {
    const s = S.ships.get(S.openId);
    const tail = s ? [h('div', { class: 'ev' }, h('span'), h('div', null, h('div', { class: 'line1' }, h('b', { text: s.created_by ? nameOf(s.created_by) : 'Imported from Google Sheet' }), h('span', { class: 'who', text: fmtWhen(s.created_at) })), h('div', { class: 'what muted', text: s.source || 'Shipment created' })))] : [];
    $('sh-log').replaceChildren(...S.detail.map((e) => evRow(e, false)), ...tail);
  };

  // ---------- side sheet ----------
  const F = { status: 'f-status', eta: 'f-eta', ready_on: 'f-ready', arrived_on: 'f-arrived', remarks: 'f-remarks', product: 'f-product', po_number: 'f-po', kind: 'f-kind', sn: 'f-sn', qty: 'f-qty', company: 'f-company', contact: 'f-contact', mode: 'f-mode', carrier: 'f-carrier', tracking: 'f-tracking', month: 'f-month', shipping_kwd: 'f-ship', clearance_kwd: 'f-clear', duty_kwd: 'f-duty', customs_declaration: 'f-decl', duty_paid_on: 'f-dutydate' };
  const NUMS = ['sn', 'qty', 'shipping_kwd', 'clearance_kwd', 'duty_kwd'];
  const DATES = ['eta', 'ready_on', 'arrived_on', 'duty_paid_on'];
  const STATUSES = ['Not pick up yet', 'Picked up', 'Received', 'Delivered', 'Canceled'];
  const same = (a, b) => (a === null || a === undefined || a === '' ? '' : String(a)) === (b === null || b === undefined || b === '' ? '' : String(b));
  const sameNum = (a, b) => (a === null || a === undefined || a === '' ? null : Number(a)) === (b === null || b === undefined || b === '' ? null : Number(b));

  const fillEtaBox = (s) => {
    const g = s ? stageOf(s) : 'wait';
    const cells = [['Stage', s ? (g === 'other' ? s.status || 'Other' : STAGE_LABEL[g]) : 'New', g === 'late'],
      ['First ETA (promised)', s && s.promised_eta ? fmtDate(s.promised_eta) : '–', false],
      ['Current ETA', s && s.eta ? fmtDate(s.eta) : '–', false]];
    if (s && s.eta && s.promised_eta) { const d = days(s.promised_eta, s.eta); cells.push(['Moved since promise', d === 0 ? 'On time' : (d > 0 ? '+' : '') + d + ' days', d > 0]); }
    $('sh-eta').replaceChildren(...cells.map(([k, v, bad]) => h('div', null, h('div', { class: 'k', text: k }), h('div', { class: 'v' + (bad ? ' bad' : ''), text: v }))));
  };
  const calcTotal = () => {
    const a = $('f-ship').value.trim(), b = $('f-clear').value.trim(), c = $('f-duty').value.trim();
    $('f-total').value = a === '' && b === '' && c === '' ? '' : (Math.round(((Number(a) || 0) + (Number(b) || 0) + (Number(c) || 0)) * 1000) / 1000).toFixed(3);
  };
  ['f-ship', 'f-clear', 'f-duty'].forEach((id) => $(id).addEventListener('input', calcTotal));

  const openSheet = (id) => {
    const s = id ? S.ships.get(id) : null;
    S.openId = id || null; S.isNew = !id;
    $('sh-title').textContent = s ? s.product : 'New shipment';
    $('sh-meta').textContent = s ? [s.kind + ' shipments', s.sn ? 'S/N ' + fmtNum(s.sn) : '', s.po_number ? 'PO ' + s.po_number : '', s.tracking ? 'Tracking ' + s.tracking : ''].filter(Boolean).join(' · ') : 'Fill in what you know. The first ETA you save becomes the promised ETA.';
    fillEtaBox(s);
    const opts = [...new Set([...STATUSES, ...(s && s.status ? [s.status] : [])])];
    $('f-status').replaceChildren(...opts.map((o) => h('option', { value: o, text: o })));
    $('f-status').value = s ? (s.status || 'Not pick up yet') : 'Not pick up yet';
    for (const [k, fid] of Object.entries(F)) { if (k === 'status') continue; const v = s ? s[k] : (k === 'kind' ? (S.kind || 'Bulk') : ''); $(fid).value = v === null || v === undefined ? '' : v; }
    $('f-total').value = s && s.total_kwd !== null && s.total_kwd !== undefined ? Number(s.total_kwd).toFixed(3) : '';
    if (!s) { const kind = $('f-kind').value; $('f-sn').value = Math.max(0, ...[...S.ships.values()].filter((x) => x.kind === kind).map((x) => Number(x.sn) || 0)) + 1; }
    $('f-reason').value = ''; $('reason-wrap').hidden = true; $('reason-err').hidden = true; $('reason-wrap').classList.remove('need');
    $('sh-msg').textContent = ''; $('sh-msg').className = 'msg'; $('note-text').value = '';
    $('sh-save').textContent = s ? 'Save changes' : 'Add shipment';
    $('note-wrap').hidden = !s; $('docs-wrap').hidden = !s; upMsg(UP_HINT);
    S.detail = [];
    $('sh-log').replaceChildren(h('div', { class: 'empty', text: s ? 'Loading history…' : 'History starts when you save.' }));
    $('split-wrap').hidden = !s; $('stock-wrap').hidden = !s; $('po-stock-wrap').hidden = true;
    $('stock-preview').hidden = true; $('stock-confirm').hidden = true; S.items = []; pending = null;
    if (s) { loadDetail(id); renderDocs(); renderSplit(); stockMsg(STOCK_HINT); renderStock(); loadItems(); }
    if (!$('sheet').open) $('sheet').showModal();
    try { history.replaceState(null, '', '#' + (s ? 'ship-' + id : 'new')); } catch (e) { /* ignore */ }
  };
  const closeSheet = () => { if ($('sheet').open) $('sheet').close(); };
  $('sheet').addEventListener('close', () => {
    S.openId = null; S.isNew = false;
    try { history.replaceState(null, '', location.pathname + location.search + (S.view === 'ships' ? '' : '#' + S.view)); } catch (e) { /* ignore */ }
  });
  $('sh-close').addEventListener('click', closeSheet);
  $('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) closeSheet(); });
  $('f-eta').addEventListener('input', () => {
    const s = S.ships.get(S.openId);
    $('reason-wrap').hidden = !(s && s.eta && !same(s.eta, $('f-eta').value || null));
  });
  $('f-kind').addEventListener('change', () => { if (S.isNew) { const kind = $('f-kind').value; $('f-sn').value = Math.max(0, ...[...S.ships.values()].filter((x) => x.kind === kind).map((x) => Number(x.sn) || 0)) + 1; } });

  const formValues = () => {
    const out = {};
    for (const [k, fid] of Object.entries(F)) {
      const raw = $(fid).value.trim();
      out[k] = NUMS.includes(k) ? (raw === '' ? null : Number(raw)) : DATES.includes(k) ? (raw || null) : raw;
    }
    return out;
  };

  $('sh-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (S.saving) return;
    const s = S.ships.get(S.openId);
    const v = formValues();
    const msg = (t, bad) => { $('sh-msg').textContent = t; $('sh-msg').className = 'msg' + (bad ? ' bad' : ''); };
    if (!v.product) { msg('Write the product name first.', true); return; }
    let change = {};
    if (s) {
      for (const k of Object.keys(F)) if (NUMS.includes(k) ? !sameNum(s[k], v[k]) : !same(s[k], v[k])) change[k] = v[k];
      if (!Object.keys(change).length) { msg('Nothing changed.'); return; }
      if ('eta' in change && s.eta) {
        const reason = $('f-reason').value.trim();
        if (!reason) { $('reason-wrap').hidden = false; $('reason-wrap').classList.add('need'); $('reason-err').hidden = false; $('f-reason').focus(); return; }
        change.change_reason = reason;
      }
    }
    S.saving = true; $('sh-save').disabled = true; msg('Saving…');
    try {
      if (s) {
        const { data, error } = await S.sb.from('shipments').update(change).eq('id', s.id).select().single();
        if (error) throw error;
        S.ships.set(data.id, data);
        msg('Saved.'); $('reason-wrap').hidden = true; $('f-reason').value = '';
        fillEtaBox(data); $('f-total').value = data.total_kwd !== null ? Number(data.total_kwd).toFixed(3) : '';
        toast('Saved. The change is in the log.'); queueRefresh();
        loadDetail(s.id);
      } else {
        const { data, error } = await S.sb.from('shipments').insert(Object.assign(v, { source: 'Added on the website' })).select().single();
        if (error) throw error;
        S.ships.set(data.id, data);
        toast('Shipment added.'); closeSheet(); queueRefresh();
      }
      renderList();
    } catch (err) {
      msg(/row-level security|permission/i.test(errText(err)) ? 'Your account cannot make changes. Ask the admin to approve you.' : errText(err), true);
    } finally { S.saving = false; $('sh-save').disabled = false; }
  });

  $('note-add').addEventListener('click', async () => {
    const text = $('note-text').value.trim();
    const s = S.ships.get(S.openId);
    if (!text || !s) return;
    $('note-add').disabled = true;
    const { error } = await S.sb.from('history').insert({ shipment_id: s.id, field: 'note', label: 'Note', new_value: text, changed_by: S.me });
    $('note-add').disabled = false;
    if (error) { toast('Could not add the note: ' + errText(error)); return; }
    $('note-text').value = ''; toast('Note added.'); loadDetail(s.id); queueRefresh();
  });

  // ---------- documents ----------
  const MAX_BYTES = 10 * 1024 * 1024;
  const UP_HINT = 'Choose a file or drop it here. PDF, Excel, Word, CSV or a photo, up to 10 MB.';
  const OK_EXT = ['pdf', 'xlsx', 'xls', 'docx', 'doc', 'csv', 'jpg', 'jpeg', 'png', 'webp'];
  const upMsg = (t, bad) => { $('up-msg').textContent = t; $('up-msg').className = 'hint' + (bad ? ' bad' : ''); };
  const renderDocs = () => {
    const list = [...S.docs.values()].filter((d) => d.shipment_id === S.openId).sort((a, b) => String(b.uploaded_at).localeCompare(String(a.uploaded_at)));
    if (!list.length) { $('docs-list').replaceChildren(h('div', { class: 'empty', text: 'No invoice or packing list yet.' })); return; }
    $('docs-list').replaceChildren(...list.map((d) => {
      const row = h('div', { class: 'doc' });
      const acts = h('div', { class: 'acts' });
      const link = async (download) => {
        const { data, error } = await S.sb.storage.from('documents').createSignedUrl(d.path, 300, download ? { download: d.name } : undefined);
        if (error) { toast('Could not open the file: ' + errText(error)); return null; }
        return data.signedUrl;
      };
      acts.append(h('button', { class: 'btn', type: 'button', text: 'Open', onclick: async () => { const u = await link(false); if (u) window.open(u, '_blank', 'noopener'); } }));
      acts.append(h('button', { class: 'btn', type: 'button', text: 'Download', onclick: async () => { const u = await link(true); if (u) { const a = h('a', { href: u }); document.body.append(a); a.click(); a.remove(); } } }));
      row.append(h('div', { style: 'min-width:0' },
        h('div', { class: 'nm' }, h('span', { class: 'kind', text: d.kind || 'Document' }), d.name),
        h('div', { class: 'sub', text: fmtSize(d.size || 0) + ' · ' + nameOf(d.uploaded_by) + ' · ' + fmtWhen(d.uploaded_at) })), acts);
      return row;
    }));
  };
  const uploadFile = async (file) => {
    const s = S.ships.get(S.openId);
    if (!file || !s || S.uploading) return;
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!OK_EXT.includes(ext)) { upMsg('This file type is not supported. Use PDF, Excel, Word, CSV or a photo.', true); return; }
    if (file.size > MAX_BYTES) { upMsg('This file is ' + fmtSize(file.size) + '. The limit is 10 MB.', true); return; }
    S.uploading = true;
    const kind = $('up-kind').value;
    const safe = file.name.replace(/[^\w.\-]+/g, '_').slice(-80);
    const path = `${s.id}/${Date.now()}-${safe}`;
    upMsg('Uploading ' + file.name + '…');
    try {
      const up = await S.sb.storage.from('documents').upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
      if (up.error) throw up.error;
      const { data, error } = await S.sb.from('documents').insert({ shipment_id: s.id, kind, name: file.name, path, size: file.size, type: file.type || '', uploaded_by: S.me }).select().single();
      if (error) throw error;
      S.docs.set(data.id, data);
      upMsg(UP_HINT); toast(kind + ' uploaded.'); renderDocs(); renderList(); loadDetail(s.id); queueRefresh();
    } catch (err) { upMsg('The upload did not finish: ' + errText(err), true); }
    finally { S.uploading = false; $('up-file').value = ''; }
  };
  $('up-file').addEventListener('change', () => uploadFile($('up-file').files[0]));
  const upWrap = $('up-wrap');
  ['dragenter', 'dragover'].forEach((t) => upWrap.addEventListener(t, (e) => { e.preventDefault(); upWrap.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((t) => upWrap.addEventListener(t, (e) => { e.preventDefault(); upWrap.classList.remove('drag'); }));
  upWrap.addEventListener('drop', (e) => { const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) uploadFile(f); });

  // ---------- split shipments (same PO, part by air, part by sea) ----------
  const normPo = (p) => String(p || '').trim().toLowerCase();
  const groupOf = (s) => {
    if (!s) return [];
    const all = [...S.ships.values()];
    const seen = new Set([s.id]);
    const queue = [s];
    while (queue.length) {
      const cur = queue.shift();
      for (const x of all) {
        if (seen.has(x.id)) continue;
        const linked = (normPo(cur.po_number) && normPo(x.po_number) === normPo(cur.po_number)) || x.parent_id === cur.id || cur.parent_id === x.id;
        if (linked) { seen.add(x.id); queue.push(x); }
      }
    }
    return all.filter((x) => seen.has(x.id)).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  };
  const modeTag = (m) => { const k = String(m || '').toLowerCase(); return h('span', { class: 'mode ' + (['air', 'sea', 'land'].includes(k) ? k : 'none'), text: m || 'No mode' }); };
  const renderSplit = () => {
    const s = S.ships.get(S.openId);
    if (!s) return;
    const group = groupOf(s);
    $('split-hint').textContent = group.length > 1
      ? 'This order is sent as ' + group.length + ' shipments' + (s.po_number ? ' under PO ' + s.po_number : '') + '. Each part has its own ETA, status and stock list.'
      : (s.po_number ? 'Only this shipment has PO ' + s.po_number + '. If part of the order goes another way, split it here.' : 'Add the PO number above so all parts of the order stay together. You can split this shipment when part of it goes by air and part by sea.');
    $('split-list').replaceChildren(...group.map((x) => {
      const g = stageOf(x);
      const cur = x.id === s.id;
      const date = g === 'wait' ? (x.ready_on ? 'Ready ' + fmtShort(x.ready_on) : 'No date') : g === 'done' ? (x.arrived_on ? 'Arrived ' + fmtShort(x.arrived_on) : 'Arrived') : (x.eta ? 'ETA ' + fmtShort(x.eta) : 'No ETA');
      return h('div', { class: 'part' + (cur ? ' cur' : ''), onclick: cur ? null : () => openSheet(x.id) },
        h('div', { style: 'min-width:0' }, h('div', { class: 'nm' }, modeTag(x.mode), x.product),
          h('div', { class: 'sub', text: [cur ? 'This shipment' : '', x.qty ? fmtNum(x.qty) + ' pcs' : '', x.carrier, date].filter(Boolean).join(' · ') })),
        h('span', { class: 'pill ' + g, text: g === 'other' ? (x.status || 'Other') : STAGE_LABEL[g] }));
    }));
    $('split-form').hidden = true; $('split-open').hidden = false;
  };
  $('split-open').addEventListener('click', () => {
    const s = S.ships.get(S.openId);
    if (!s) return;
    const m = String(s.mode || '').toLowerCase();
    $('sp-mode').value = m === 'air' ? 'Sea' : 'Air';
    $('sp-qty').value = ''; $('sp-eta').value = ''; $('sp-carrier').value = ''; $('sp-tracking').value = '';
    $('sp-qty-hint').textContent = s.qty ? 'Taken out of this shipment\'s ' + fmtNum(s.qty) + ' pcs' : 'This shipment has no Qty yet';
    $('sp-err').hidden = true; $('split-form').hidden = false; $('split-open').hidden = true;
    $('sp-qty').focus();
  });
  $('sp-cancel').addEventListener('click', () => { $('split-form').hidden = true; $('split-open').hidden = false; });
  $('split-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const s = S.ships.get(S.openId);
    if (!s) return;
    const qty = $('sp-qty').value.trim() === '' ? null : Number($('sp-qty').value);
    const err = (t) => { $('sp-err').textContent = t; $('sp-err').hidden = false; };
    if (qty !== null && (!(qty > 0) || (s.qty && qty >= Number(s.qty)))) { err(s.qty ? 'Enter a Qty between 1 and ' + fmtNum(Number(s.qty) - 1) + '.' : 'Enter a Qty above 0.'); return; }
    const mode = $('sp-mode').value;
    $('sp-go').disabled = true;
    try {
      const part = {
        kind: s.kind, sn: s.sn, product: s.product, po_number: s.po_number || '', company: s.company, contact: s.contact, month: s.month,
        mode, qty, eta: $('sp-eta').value || null, carrier: $('sp-carrier').value.trim(), tracking: $('sp-tracking').value.trim(),
        status: s.status || 'Not pick up yet', remarks: '', parent_id: s.parent_id || s.id, source: 'Split from ' + (s.mode ? s.mode.toLowerCase() + ' ' : '') + 'shipment S/N ' + (s.sn ?? ''),
      };
      const { data, error } = await S.sb.from('shipments').insert(part).select().single();
      if (error) throw error;
      S.ships.set(data.id, data);
      if (qty !== null && s.qty) {
        const { data: upd, error: e2 } = await S.sb.from('shipments').update({ qty: Number(s.qty) - qty }).eq('id', s.id).select().single();
        if (!e2 && upd) { S.ships.set(upd.id, upd); $('f-qty').value = upd.qty ?? ''; }
      }
      await S.sb.from('history').insert({ shipment_id: s.id, field: 'split', label: 'Split', new_value: (qty !== null ? fmtNum(qty) + ' pcs' : 'Part of the order') + ' moved to a new ' + mode.toLowerCase() + ' shipment', changed_by: S.me });
      await S.sb.from('history').insert({ shipment_id: data.id, field: 'split', label: 'Split', new_value: 'Created as the ' + mode.toLowerCase() + ' part of ' + (s.po_number ? 'PO ' + s.po_number : 'S/N ' + (s.sn ?? '')), changed_by: S.me });
      toast('New ' + mode.toLowerCase() + ' part created.');
      renderSplit(); renderList(); loadDetail(s.id); queueRefresh();
    } catch (ex) { err(errText(ex)); }
    finally { $('sp-go').disabled = false; }
  });

  // ---------- stock lines ----------
  S.items = [];
  const loadItems = async () => {
    const s = S.ships.get(S.openId);
    if (!s) return;
    const ids = groupOf(s).map((x) => x.id);
    const { data, error } = await S.sb.from('shipment_items').select('*').in('shipment_id', ids).order('id').limit(10000);
    if (error) { $('stock-msg').textContent = 'Could not load the stock list: ' + errText(error); return; }
    if (S.openId === s.id) { S.items = data; renderStock(); }
  };
  const itemKey = (i) => [i.sku || i.description, i.color, i.size].map((x) => String(x || '').trim().toLowerCase()).join('|');
  const renderStock = () => {
    const s = S.ships.get(S.openId);
    if (!s) return;
    const mine = S.items.filter((i) => i.shipment_id === s.id);
    const body = $('stock-rows');
    if (!mine.length) body.replaceChildren(h('tr', null, h('td', { colspan: 6, class: 'empty', text: 'No stock list yet. Import the packing list or stock sheet for this shipment.' })));
    else body.replaceChildren(...mine.map((i) => h('tr', null, h('td', { class: 'mono', text: i.sku || '' }), h('td', { text: i.description || '' }), h('td', { class: 'hide-sm', text: i.color || '' }), h('td', { class: 'hide-sm', text: i.size || '' }), h('td', { class: 'num hide-sm', text: fmtNum(i.cartons) }), h('td', { class: 'num', text: fmtNum(i.qty) }))));
    const tq = mine.reduce((a, i) => a + (Number(i.qty) || 0), 0), tc = mine.reduce((a, i) => a + (Number(i.cartons) || 0), 0);
    $('stock-foot').hidden = !mine.length;
    $('stock-foot').replaceChildren(h('tr', null, h('td', { colspan: 4, text: 'Total · ' + mine.length + (mine.length === 1 ? ' line' : ' lines') }), h('td', { class: 'num hide-sm', text: tc ? fmtNum(tc) : '' }), h('td', { class: 'num', text: fmtNum(tq) })));
    $('stock-clear').hidden = !(mine.length && S.profile && S.profile.role === 'admin');
    // across the PO
    const group = groupOf(s);
    const wrap = $('po-stock-wrap');
    if (group.length < 2 || !S.items.length) { wrap.hidden = true; return; }
    wrap.hidden = false;
    const modeOf = (id) => { const m = String((S.ships.get(id) || {}).mode || '').trim(); return m ? m[0].toUpperCase() + m.slice(1).toLowerCase() : 'No mode'; };
    const modes = [...new Set(group.map((g) => modeOf(g.id)))].sort((a, b) => ['Air', 'Sea', 'Land'].indexOf(a) - ['Air', 'Sea', 'Land'].indexOf(b));
    const rows = new Map();
    for (const i of S.items) {
      const k = itemKey(i);
      if (!rows.has(k)) rows.set(k, { sku: i.sku, description: i.description, color: i.color, size: i.size, by: {} });
      const r = rows.get(k); const m = modeOf(i.shipment_id);
      r.by[m] = (r.by[m] || 0) + (Number(i.qty) || 0);
    }
    $('po-stock-head').replaceChildren(h('tr', null, h('th', { text: 'Item' }), ...modes.map((m) => h('th', { class: 'num', text: m })), h('th', { class: 'num', text: 'Total' })));
    const list = [...rows.values()];
    $('po-stock-rows').replaceChildren(...list.map((r) => {
      const total = modes.reduce((a, m) => a + (r.by[m] || 0), 0);
      return h('tr', null, h('td', null, [r.sku, r.description].filter(Boolean).join(' · '), r.color || r.size ? h('div', { class: 'muted', style: 'font-size:12px', text: [r.color, r.size].filter(Boolean).join(' · ') }) : ''),
        ...modes.map((m) => h('td', { class: 'num', text: r.by[m] ? fmtNum(r.by[m]) : '–' })), h('td', { class: 'num', text: fmtNum(total) }));
    }));
    const sums = modes.map((m) => list.reduce((a, r) => a + (r.by[m] || 0), 0));
    $('po-stock-foot').replaceChildren(h('tr', null, h('td', { text: 'Total' }), ...sums.map((v) => h('td', { class: 'num', text: fmtNum(v) })), h('td', { class: 'num', text: fmtNum(sums.reduce((a, b) => a + b, 0)) })));
  };

  const STOCK_HINT = 'Excel or CSV with columns like SKU, Description, Color, Size, Cartons, Qty. A packing list usually works as it is.';
  const stockMsg = (t, bad) => { $('stock-msg').textContent = t; $('stock-msg').className = 'hint' + (bad ? ' bad' : ''); };
  let xlsxReady = null;
  const loadXlsx = () => xlsxReady || (xlsxReady = new Promise((res, rej) => {
    if (window.XLSX) { res(window.XLSX); return; }
    const sc = document.createElement('script'); sc.src = 'vendor/xlsx.full.min.js';
    sc.onload = () => res(window.XLSX); sc.onerror = () => { xlsxReady = null; rej(new Error('Could not load the Excel reader. Check your connection.')); };
    document.head.append(sc);
  }));
  const parseCsv = (text) => {
    const out = []; let row = [], cell = '', q = false;
    const sep = (text.split('\n')[0].match(/;/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
      else if (ch === '"') q = true;
      else if (ch === sep) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); out.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); out.push(row); }
    return out;
  };
  const COLS = [
    ['qty', /^(total\s*)?(qty|q'?ty|quantity|pcs|pieces|units|total\s*pcs|total\s*qty)\b|quantity|\bpcs\b|\bqty\b/i],
    ['cartons', /carton|\bctns?\b|\bboxe?s?\b|no\.?\s*of\s*(ctn|box)/i],
    ['sku', /\bsku\b|item\s*(code|no)|style|article|\bcode\b|model|\bref\b|barcode|part\s*no/i],
    ['color', /colou?r/i],
    ['size', /\bsize\b/i],
    ['description', /desc|item|product|name|goods|article/i],
  ];
  const mapHeader = (row) => {
    const map = {};
    row.forEach((cellv, idx) => {
      const t = String(cellv ?? '').trim();
      if (!t) return;
      for (const [k, re] of COLS) { if (map[k] === undefined && re.test(t)) { map[k] = idx; return; } }
    });
    return map;
  };
  const toNum = (v) => { if (v === null || v === undefined || v === '') return null; if (typeof v === 'number') return v; const n = parseFloat(String(v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? null : n; };
  const buildLines = (rows) => {
    let hi = -1, map = null;
    for (let r = 0; r < Math.min(rows.length, 25); r++) {
      const m = mapHeader(rows[r] || []);
      if (m.qty !== undefined && (m.sku !== undefined || m.description !== undefined)) { hi = r; map = m; break; }
    }
    if (hi < 0) return { error: 'Could not find a header row with a Qty column and an item or SKU column. Use the template, or rename the columns to SKU, Description, Qty.' };
    const lines = [];
    for (const r of rows.slice(hi + 1)) {
      const g = (k) => (map[k] === undefined ? '' : String(r[map[k]] ?? '').trim());
      const qty = toNum(map.qty === undefined ? null : r[map.qty]);
      const sku = g('sku'), desc = g('description');
      if (qty === null || (!sku && !desc)) continue;
      if (/^(sub)?total|^grand/i.test(sku) || /^(sub)?total|^grand/i.test(desc)) continue;
      lines.push({ sku, description: desc, color: g('color'), size: g('size'), cartons: toNum(map.cartons === undefined ? null : r[map.cartons]), qty });
    }
    if (!lines.length) return { error: 'The file has a header row but no lines with a quantity.' };
    const headers = rows[hi];
    const used = Object.entries(map).map(([k, i]) => String(headers[i]).trim() + ' → ' + { sku: 'SKU', description: 'Item', color: 'Color', size: 'Size', cartons: 'Cartons', qty: 'Qty' }[k]);
    return { lines, used };
  };
  let pending = null;
  $('stock-file').addEventListener('change', async () => {
    const file = $('stock-file').files[0];
    $('stock-file').value = '';
    const s = S.ships.get(S.openId);
    if (!file || !s) return;
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    stockMsg('Reading ' + file.name + '…');
    try {
      let rows;
      if (ext === 'csv') rows = parseCsv(await file.text());
      else {
        const X = await loadXlsx();
        const wb = X.read(await file.arrayBuffer(), { type: 'array' });
        let best = null;
        for (const name of wb.SheetNames) {
          const r = X.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' });
          const b = buildLines(r);
          if (!b.error && (!best || b.lines.length > best.lines.length)) best = Object.assign(b, { sheet: name });
        }
        if (!best) { rows = X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' }); }
        else { pending = Object.assign(best, { file: file.name }); showPreview(); return; }
      }
      const b = buildLines(rows);
      if (b.error) { stockMsg(b.error, true); return; }
      pending = Object.assign(b, { file: file.name }); showPreview();
    } catch (ex) { stockMsg('Could not read the file: ' + errText(ex), true); }
  });
  const showPreview = () => {
    const p = pending; const total = p.lines.reduce((a, l) => a + (Number(l.qty) || 0), 0);
    const s = S.ships.get(S.openId);
    stockMsg(STOCK_HINT);
    const setQty = h('input', { type: 'checkbox', id: 'stock-setqty' });
    if (!s.qty) setQty.checked = true;
    $('stock-preview').hidden = false;
    $('stock-preview').replaceChildren(
      h('div', { style: 'padding:12px 14px;display:flex;flex-direction:column;gap:8px' },
        h('div', null, h('b', { text: p.file }), (p.sheet ? ' (sheet "' + p.sheet + '")' : ''), ': ', h('b', { text: p.lines.length + ' lines, ' + fmtNum(total) + ' pcs' }), ' will be added to this ', h('b', { text: (s.mode || '').toLowerCase() || '' }), ' shipment.'),
        h('div', { class: 'muted', style: 'font-size:12px', text: 'Columns found: ' + p.used.join(', ') }),
        h('div', { class: 'scroll' }, h('table', { class: 'list mini' },
          h('thead', null, h('tr', null, ...['SKU', 'Item', 'Color', 'Size', 'Cartons', 'Qty'].map((t, i) => h('th', { class: i > 3 ? 'num' : '', text: t })))),
          h('tbody', null, ...p.lines.slice(0, 8).map((l) => h('tr', null, h('td', { class: 'mono', text: l.sku }), h('td', { text: l.description }), h('td', { text: l.color }), h('td', { text: l.size }), h('td', { class: 'num', text: fmtNum(l.cartons) }), h('td', { class: 'num', text: fmtNum(l.qty) })))))),
        p.lines.length > 8 ? h('div', { class: 'muted', style: 'font-size:12px', text: '…and ' + (p.lines.length - 8) + ' more lines' }) : '',
        h('label', { style: 'display:flex;gap:8px;align-items:center' }, setQty, 'Set this shipment\'s Qty to ' + fmtNum(total) + ' pcs'),
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary', type: 'button', text: 'Add ' + p.lines.length + ' lines', onclick: (e) => saveStock(e.target, setQty.checked, total) }),
          h('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: () => { pending = null; $('stock-preview').hidden = true; } }))));
  };
  const saveStock = async (btn, setQty, total) => {
    const s = S.ships.get(S.openId);
    if (!pending || !s) return;
    btn.disabled = true;
    const importId = 'imp-' + Date.now().toString(36);
    try {
      const rows = pending.lines.map((l) => Object.assign({ shipment_id: s.id, import_id: importId, created_by: S.me }, l));
      for (let i = 0; i < rows.length; i += 500) {
        stockMsg('Saving lines ' + (i + 1) + '–' + Math.min(i + 500, rows.length) + ' of ' + rows.length + '…');
        const { error } = await S.sb.from('shipment_items').insert(rows.slice(i, i + 500));
        if (error) throw error;
      }
      await S.sb.from('history').insert({ shipment_id: s.id, field: 'stock', label: 'Stock list', new_value: 'Imported ' + pending.file + ': ' + rows.length + ' lines, ' + fmtNum(total) + ' pcs', changed_by: S.me });
      if (setQty && !sameNum(s.qty, total)) {
        const { data } = await S.sb.from('shipments').update({ qty: total }).eq('id', s.id).select().single();
        if (data) { S.ships.set(data.id, data); $('f-qty').value = data.qty ?? ''; }
      }
      pending = null; $('stock-preview').hidden = true; stockMsg(STOCK_HINT);
      toast('Stock list added: ' + rows.length + ' lines.');
      loadItems(); loadDetail(s.id); queueRefresh();
    } catch (ex) { stockMsg('Could not save the stock list: ' + errText(ex), true); btn.disabled = false; }
  };
  $('stock-template').addEventListener('click', () => {
    const csv = 'SKU,Description,Color,Size,Cartons,Qty\nKS-001,Kondura socks crew,Black,M,10,500\n';
    const a = h('a', { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: 'stock-list-template.csv' });
    document.body.append(a); a.click(); a.remove();
  });
  $('stock-clear').addEventListener('click', () => {
    const s = S.ships.get(S.openId);
    if (!s) return;
    const n = S.items.filter((i) => i.shipment_id === s.id).length;
    $('stock-confirm').hidden = false;
    $('stock-confirm').replaceChildren(h('span', { text: 'Remove all ' + n + ' stock lines from this shipment? This is written to the change log.' }),
      h('button', { class: 'btn', type: 'button', text: 'Remove lines', onclick: async (e) => {
        e.target.disabled = true;
        const { error } = await S.sb.from('shipment_items').delete().eq('shipment_id', s.id);
        if (error) { toast('Could not remove the lines: ' + errText(error)); e.target.disabled = false; return; }
        await S.sb.from('history').insert({ shipment_id: s.id, field: 'stock', label: 'Stock list', new_value: 'Removed the stock list (' + n + ' lines)', changed_by: S.me });
        $('stock-confirm').hidden = true; toast('Stock list removed.'); loadItems(); loadDetail(s.id); queueRefresh();
      } }),
      h('button', { class: 'btn', type: 'button', text: 'Keep them', onclick: () => { $('stock-confirm').hidden = true; } }));
  });

  // ---------- team (admin) ----------
  const renderTeam = () => {
    const pending = [...S.profiles.values()].filter((p) => p.role === 'pending');
    $('team-badge').textContent = pending.length; $('team-badge').hidden = !pending.length;
    const order = { pending: 0, member: 1, admin: 2, removed: 3 };
    const list = [...S.profiles.values()].sort((a, b) => (order[a.role] - order[b.role]) || nameOf(a.id).localeCompare(nameOf(b.id)));
    if (!list.length) { $('team-rows').replaceChildren(h('tr', null, h('td', { colspan: 5, class: 'empty', text: 'No one has signed up yet.' }))); return; }
    const setRole = async (p, role, btn) => {
      btn.disabled = true;
      const { error } = await S.sb.from('profiles').update({ role }).eq('id', p.id);
      btn.disabled = false;
      if (error) { toast('Could not change access: ' + errText(error)); return; }
      p.role = role; renderTeam();
      toast(role === 'member' ? nameOf(p.id) + ' can now use the tracker.' : nameOf(p.id) + ' can no longer use the tracker.');
    };
    $('team-rows').replaceChildren(...list.map((p) => {
      const act = h('div', { class: 'row-actions' });
      if (p.id !== S.me) {
        if (p.role === 'pending' || p.role === 'removed') act.append(h('button', { class: 'btn primary', type: 'button', text: p.role === 'removed' ? 'Give access again' : 'Approve', onclick: (e) => setRole(p, 'member', e.target) }));
        if (p.role === 'member' || p.role === 'pending') act.append(h('button', { class: 'btn', type: 'button', text: p.role === 'pending' ? 'Decline' : 'Remove access', onclick: (e) => setRole(p, 'removed', e.target) }));
      }
      const pill = { pending: ['wait', 'Waiting for you'], member: ['done', 'Approved'], admin: ['way', 'Admin'], removed: ['other', 'Removed'] }[p.role] || ['other', p.role];
      return h('tr', null,
        h('td', { class: 'prod' }, nameOf(p.id), ''),
        h('td', { class: 'hide-sm muted', text: p.email || '' }),
        h('td', { class: 'who', text: fmtWhen(p.created_at) }),
        h('td', null, h('span', { class: 'pill ' + pill[0], text: pill[1] })),
        h('td', null, act));
    }));
  };

  // ---------- views ----------
  const setView = (v) => {
    if (v === 'team' && !(S.profile && S.profile.role === 'admin')) v = 'ships';
    S.view = v;
    $('view-ships').hidden = v !== 'ships'; $('view-log').hidden = v !== 'log'; $('view-team').hidden = v !== 'team';
    $('tab-ships').setAttribute('aria-selected', v === 'ships'); $('tab-log').setAttribute('aria-selected', v === 'log'); $('tab-team').setAttribute('aria-selected', v === 'team');
    try { history.replaceState(null, '', v === 'ships' ? location.pathname + location.search : '#' + v); } catch (e) { /* ignore */ }
    if (v === 'log') renderLog();
    if (v === 'team') renderTeam();
  };
  $('tab-ships').addEventListener('click', () => setView('ships'));
  $('tab-log').addEventListener('click', () => setView('log'));
  $('tab-team').addEventListener('click', () => setView('team'));
  document.querySelectorAll('.stage').forEach((b) => b.addEventListener('click', () => {
    S.stage = b.dataset.stage;
    document.querySelectorAll('.stage').forEach((x) => x.setAttribute('aria-pressed', x === b));
    renderList();
  }));
  let qt; $('q').addEventListener('input', () => { clearTimeout(qt); qt = setTimeout(() => { S.q = $('q').value.trim().toLowerCase(); renderList(); }, 120); });
  $('kind').addEventListener('change', () => { S.kind = $('kind').value; renderList(); });
  $('log-filter').addEventListener('change', () => { S.logFilter = $('log-filter').value; renderLog(); });
  $('add-btn').addEventListener('click', () => openSheet(null));

  // ---------- account ----------
  const showSignIn = (text) => gate('Sign in', text || 'Use the email and password you signed up with.', 'in-form');
  $('to-up').addEventListener('click', () => gate('Create an account', 'Use your real first and last name. Everyone sees it next to the changes you make. The admin approves new accounts.', 'up-form'));
  $('to-in').addEventListener('click', () => showSignIn());
  $('to-in2').addEventListener('click', () => showSignIn());
  $('to-forgot').addEventListener('click', () => gate('Reset your password', 'We will email you a link to choose a new password.', 'fg-form'));

  $('in-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('in-email').value.trim(), password = $('in-pw').value;
    if (!email || !password) { showErr('in-err', 'Enter your email and password.'); return; }
    $('in-go').disabled = true;
    const { error } = await S.sb.auth.signInWithPassword({ email, password });
    $('in-go').disabled = false;
    if (error) showErr('in-err', /invalid/i.test(error.message) ? 'The email or password is not right.' : /confirm/i.test(error.message) ? 'Confirm your email first: open the link we emailed you.' : error.message);
  });
  $('up-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const first = $('up-first').value.trim(), last = $('up-last').value.trim(), email = $('up-email').value.trim(), pw = $('up-pw').value;
    if (!first || !last) { showErr('up-err', 'Enter your first and last name.'); return; }
    if (!/^\S+@\S+\.\S+$/.test(email)) { showErr('up-err', 'Enter a valid email.'); return; }
    if (pw.length < 8) { showErr('up-err', 'Use a password of at least 8 characters.'); return; }
    if (pw !== $('up-pw2').value) { showErr('up-err', 'The two passwords are not the same.'); return; }
    $('up-go').disabled = true;
    const { data, error } = await S.sb.auth.signUp({ email, password: pw, options: { data: { first_name: first, last_name: last }, emailRedirectTo: location.origin + location.pathname } });
    $('up-go').disabled = false;
    if (error) { showErr('up-err', error.message); return; }
    if (!data.session) gate('Check your email', 'We sent a confirmation link to ' + email + '. Open it, then come back and sign in.', 'in-form');
  });
  $('fg-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('fg-email').value.trim();
    if (!email) { showErr('fg-err', 'Enter your email.'); return; }
    $('fg-go').disabled = true;
    const { error } = await S.sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    $('fg-go').disabled = false;
    if (error) { showErr('fg-err', error.message); return; }
    gate('Check your email', 'If ' + email + ' has an account, a reset link is on its way. Open it on this device to choose a new password.', null);
  });
  $('pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = $('pw1').value;
    if (pw.length < 8) { showErr('pw-err', 'Use at least 8 characters.'); return; }
    if (pw !== $('pw2').value) { showErr('pw-err', 'The two passwords are not the same.'); return; }
    $('pw-go').disabled = true;
    const { error } = await S.sb.auth.updateUser({ password: pw });
    $('pw-go').disabled = false;
    if (error) { showErr('pw-err', error.message); return; }
    S.recovering = false; toast('Password saved.'); route();
  });
  $('pw-cancel').addEventListener('click', () => route());
  $('repw-btn').addEventListener('click', () => { gate('Change your password', '', 'pw-form', false); $('pw-cancel').hidden = false; });
  $('rename-btn').addEventListener('click', () => {
    gate('Change your name', 'This is the name everyone sees next to your changes.', 'nm-form');
    $('nm-first').value = (S.profile && S.profile.first_name) || ''; $('nm-last').value = (S.profile && S.profile.last_name) || '';
  });
  $('nm-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const first = $('nm-first').value.trim(), last = $('nm-last').value.trim();
    if (!first || !last) { showErr('nm-err', 'Enter your first and last name.'); return; }
    const { error } = await S.sb.from('profiles').update({ first_name: first, last_name: last }).eq('id', S.me);
    if (error) { showErr('nm-err', error.message); return; }
    S.profile.first_name = first; S.profile.last_name = last; toast('Name saved.'); route();
  });
  $('nm-cancel').addEventListener('click', () => route());
  const signOut = async () => { await S.sb.auth.signOut(); };
  $('out-btn').addEventListener('click', signOut);
  $('gate-out-btn').addEventListener('click', signOut);

  // ---------- live updates ----------
  let refreshT = null;
  const queueRefresh = () => {
    clearTimeout(refreshT);
    refreshT = setTimeout(async () => {
      try {
        await Promise.all([loadShipments(), loadRecent(), loadDocs(), loadProfiles()]);
        renderList(); if (S.view === 'log') renderLog(); renderTeam();
        if (S.openId) { fillEtaBox(S.ships.get(S.openId)); renderDocs(); loadDetail(S.openId); renderSplit(); loadItems(); }
        applyHeader();
      } catch (e) { /* next change retries */ }
    }, 400);
  };
  const subscribe = () => {
    S.sb.channel('tracker')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shipments' }, queueRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'history' }, queueRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'documents' }, queueRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shipment_items' }, queueRefresh)
      .subscribe();
    if (!S.timer) S.timer = setInterval(queueRefresh, 60000);
  };

  // ---------- routing ----------
  const applyHeader = () => {
    const p = S.profile;
    const nm = p ? [p.first_name, p.last_name].filter(Boolean).join(' ') : '';
    $('who-line').textContent = S.session ? (nm || S.session.user.email) + (p && p.role === 'admin' ? ' · admin' : p && p.role === 'member' ? ' · can edit' : '') : 'Not signed in';
    const signedIn = !!S.session;
    $('out-btn').hidden = !signedIn; $('repw-btn').hidden = !signedIn; $('rename-btn').hidden = !signedIn || !p;
  };
  const route = async () => {
    applyHeader();
    if (S.recovering) { gate('Choose a new password', 'Type a new password for your account.', 'pw-form', true); $('pw-cancel').hidden = true; return; }
    if (!S.session) { showSignIn(); return; }
    try { await loadProfiles(); } catch (e) { gate('Could not load', errText(e), null, true); return; }
    const p = S.profile;
    applyHeader();
    if (!p) { gate('Almost there', 'Your account is being set up. Reload the page in a moment.', null, true); return; }
    if (p.role === 'pending') { gate('Waiting for approval', 'Thanks, ' + (p.first_name || 'there') + '. The admin has your request and needs to approve you. Reload this page after you are approved.', null, true); return; }
    if (p.role === 'removed') { gate('No access', 'Your access to the tracker was removed. Ask the admin if you think this is a mistake.', null, true); return; }
    $('gate').hidden = true; $('tabs').hidden = false; $('foot').hidden = false; $('add-btn').hidden = false;
    $('tab-team').hidden = p.role !== 'admin';
    renderTeam();
    if (!S.started) {
      S.started = true;
      $('rows').replaceChildren(h('tr', null, h('td', { colspan: 7, class: 'empty', text: 'Loading shipments…' })));
      try { await Promise.all([loadShipments(), loadRecent(), loadDocs()]); }
      catch (e) { notice('Could not load the shipments: ' + errText(e), true); }
      subscribe();
    }
    renderList();
    const hsh = location.hash.slice(1);
    if (hsh === 'log' || hsh === 'team') setView(hsh);
    else { setView(S.view === 'team' || S.view === 'log' ? S.view : 'ships'); if (hsh.startsWith('ship-') && S.ships.has(hsh.slice(5))) openSheet(hsh.slice(5)); }
  };

  // ---------- start ----------
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || /YOUR-/.test(cfg.SUPABASE_URL + cfg.SUPABASE_ANON_KEY) || !window.supabase) {
    gate('Setup needed', 'This website is not connected to its database yet. Put the Supabase Project URL and anon key into config.js.', null);
    $('who-line').textContent = 'Not connected';
    return;
  }
  S.sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  S.sb.auth.onAuthStateChange((event, session) => {
    const before = S.session && S.session.user.id;
    S.session = session; S.me = session ? session.user.id : null;
    if (event === 'PASSWORD_RECOVERY') S.recovering = true;
    if (event === 'SIGNED_OUT') { S.profile = null; S.profiles = new Map(); S.started = false; S.ships = new Map(); S.recent = []; S.docs = new Map(); try { S.sb.removeAllChannels(); } catch (e) { /* ignore */ } }
    if (event === 'TOKEN_REFRESHED' && before === S.me) return;
    if (event === 'USER_UPDATED' && !S.recovering) return;
    setTimeout(route, 0);
  });
})();
