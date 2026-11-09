/**
 * SHIPMENT ETA TRACKER — Google Apps Script for the "Shipments-2025" sheet.
 *
 * What it does
 *  - Adds tracking columns to a shipment tab (Tracker ID, Promised ETA, Current ETA, ...).
 *  - The FIRST ETA ever entered for a shipment is saved as the "Promised ETA" and locked.
 *  - Every later change to "Current ETA" is written to an "ETA Change Log" tab with
 *    who changed it, when, old -> new date, how many days it moved, and the reason.
 *  - Changes to Status / Shipped by / Tracking No / Remarks are logged too.
 *  - An "ETA Dashboard" tab shows open shipments, delays, and carrier reliability.
 *
 * Install: see README.md in this folder.
 */

// ───────────────────────────── CONFIG ─────────────────────────────
const CONFIG = {
  HEADER_ROW: 1,
  LOG_SHEET: 'ETA Change Log',
  DASH_SHEET: 'ETA Dashboard',

  // Existing columns in your sheet (matched by header text, case-insensitive).
  EXISTING: {
    sn: ['S/N'],
    product: ['Prodects', 'Products', 'Product'],
    tracking: ['Tracking No'],
    carrier: ['Shipped by'],
    status: ['Status'],
    mode: ['Shipping', 'Shipping Modus'],
  },

  // Columns this script adds to the right of your data.
  COL: {
    id: 'Tracker ID',
    promised: 'Promised ETA 🔒',
    current: 'Current ETA',
    reason: 'ETA Change Reason',
    changes: '# ETA Changes',
    delay: 'Delay vs Promise (days)',
    lastBy: 'Last ETA Change By',
    lastAt: 'Last ETA Change At',
  },

  // Other existing columns whose edits are also logged (who changed what).
  WATCH: ['Status', 'Shipped by', 'Tracking No', 'Remarks, from WH'],

  // Statuses that mean the shipment is finished (excluded from "open" on dashboard).
  DONE_STATUSES: ['received', 'delivered'],

  DATE_FORMAT: 'dd-MMM-yyyy',
  STAMP_FORMAT: 'dd-MMM-yyyy HH:mm',
};

const LOG_HEADERS = [
  'Timestamp', 'Changed By', 'Tab', 'Tracker ID', 'S/N', 'Product', 'Tracking No',
  'Carrier', 'Field', 'Old Value', 'New Value', 'Moved (days)', 'Total Delay vs Promise (days)', 'Reason',
];
const LOG_IDX = Object.fromEntries(LOG_HEADERS.map((h, i) => [h, i + 1]));

// ───────────────────────────── MENU ─────────────────────────────
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('📦 ETA Tracker')
    .addItem('Set up tracking on this tab', 'setupThisTab')
    .addSeparator()
    .addItem('Show ETA history of selected shipment', 'showHistoryForSelection')
    .addItem('Refresh dashboard', 'refreshDashboard')
    .addSeparator()
    .addItem('Re-baseline promised ETA (owner only)', 'rebaselinePromise')
    .addToUi();
}

// ───────────────────────────── SETUP ─────────────────────────────
function setupThisTab() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getActiveSheet();
  const ui = SpreadsheetApp.getUi();
  if ([CONFIG.LOG_SHEET, CONFIG.DASH_SHEET].includes(sh.getName())) {
    ui.alert('Open a shipment tab (e.g. "Bulk Shipments") first, then run setup.');
    return;
  }

  // 1) Add missing tracker columns at the end.
  let map = headerMap_(sh);
  Object.values(CONFIG.COL).forEach((name) => {
    if (!map[name.toLowerCase()]) {
      const col = sh.getLastColumn() + 1;
      if (col > sh.getMaxColumns()) sh.insertColumnAfter(sh.getMaxColumns());
      sh.getRange(CONFIG.HEADER_ROW, col).setValue(name);
      map = headerMap_(sh);
    }
  });
  const c = cols_(map);
  const lastRow = Math.max(sh.getLastRow(), CONFIG.HEADER_ROW + 1);
  const maxRows = sh.getMaxRows() - CONFIG.HEADER_ROW;

  // 2) Header styling.
  Object.values(CONFIG.COL).forEach((name) => {
    sh.getRange(CONFIG.HEADER_ROW, map[name.toLowerCase()])
      .setBackground('#1f3864').setFontColor('#ffffff').setFontWeight('bold').setWrap(true);
  });
  sh.getRange(CONFIG.HEADER_ROW, c.promised).setBackground('#7f1d1d');

  // 3) Formats + date validation on Current ETA.
  [c.promised, c.current].forEach((col) =>
    sh.getRange(CONFIG.HEADER_ROW + 1, col, maxRows, 1).setNumberFormat(CONFIG.DATE_FORMAT));
  sh.getRange(CONFIG.HEADER_ROW + 1, c.lastAt, maxRows, 1).setNumberFormat(CONFIG.STAMP_FORMAT);
  sh.getRange(CONFIG.HEADER_ROW + 1, c.current, maxRows, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false)
      .setHelpText('Enter the ETA as a date (e.g. 25-Nov-2026). The first ETA you enter becomes the locked Promised ETA.')
      .build());
  sh.getRange(CONFIG.HEADER_ROW, c.promised).setNote(
    'Filled automatically with the FIRST ETA entered in "Current ETA". Locked: only the owner can re-baseline it via the ETA Tracker menu.');
  sh.getRange(CONFIG.HEADER_ROW, c.reason).setNote(
    'After changing Current ETA, write WHY here (e.g. "Vessel delayed at Jebel Ali", "Customs hold"). The reason is attached to the log entry.');

  const props = PropertiesService.getDocumentProperties();
  const firstSetup = !props.getProperty('setup:' + sh.getSheetId());

  // 4) Conditional formatting for delay / repeated changes.
  if (firstSetup) {
  const delayRng = sh.getRange(CONFIG.HEADER_ROW + 1, c.delay, maxRows, 1);
  const chgRng = sh.getRange(CONFIG.HEADER_ROW + 1, c.changes, maxRows, 1);
  const rules = sh.getConditionalFormatRules();
  rules.push(
    SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(7).setBackground('#f4cccc').setFontColor('#990000').setRanges([delayRng]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(0).setBackground('#fce5cd').setRanges([delayRng]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenNumberLessThan(0).setBackground('#d9ead3').setRanges([delayRng]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThanOrEqualTo(3).setBackground('#f4cccc').setRanges([chgRng]).build(),
  );
  sh.setConditionalFormatRules(rules);
  }

  // 5) Tracker IDs for every existing row + seed snapshot of current ETAs.
  for (let r = CONFIG.HEADER_ROW + 1; r <= lastRow; r++) {
    const id = ensureId_(sh, r, c);
    if (id) {
      const v = sh.getRange(r, c.current).getValue();
      setSnap_(id, v instanceof Date ? v : null);
    }
  }

  // 6) Protect tracker-managed columns (owner + script only can write).
  if (firstSetup) [c.id, c.promised, c.changes, c.delay, c.lastBy, c.lastAt].forEach((col) => {
    const p = sh.getRange(1, col, sh.getMaxRows(), 1).protect()
      .setDescription('ETA Tracker — managed automatically');
    lockToOwner_(p);
  });
  props.setProperty('setup:' + sh.getSheetId(), '1');

  // 7) Log sheet + dashboard + triggers.
  getLogSheet_();
  installTriggers_();
  refreshDashboard();

  ui.alert('✅ ETA tracking is set up on "' + sh.getName() + '".\n\n' +
    'Team instructions:\n' +
    '• Type the ETA in "Current ETA". The first one becomes the locked Promised ETA.\n' +
    '• When the shipping company gives a new date, just overwrite "Current ETA".\n' +
    '• Then write the reason in "ETA Change Reason" (cell turns yellow until you do).\n' +
    '• Every change is recorded in the "' + CONFIG.LOG_SHEET + '" tab.');
}

function installTriggers_() {
  const ss = SpreadsheetApp.getActive();
  const existing = ScriptApp.getProjectTriggers().map((t) => t.getHandlerFunction());
  if (!existing.includes('handleEdit')) {
    ScriptApp.newTrigger('handleEdit').forSpreadsheet(ss).onEdit().create();
  }
  if (!existing.includes('refreshDashboard')) {
    ScriptApp.newTrigger('refreshDashboard').timeBased().everyDays(1).atHour(7).create();
  }
}

// ───────────────────────────── EDIT HANDLER ─────────────────────────────
/** Installable onEdit trigger (runs as the owner, so it can write protected cells). */
function handleEdit(e) {
  if (!e || !e.range) return;
  const sh = e.range.getSheet();
  if ([CONFIG.LOG_SHEET, CONFIG.DASH_SHEET].includes(sh.getName())) return;
  const map = headerMap_(sh);
  if (!map[CONFIG.COL.current.toLowerCase()]) return; // tab not set up
  const c = cols_(map);
  const headersByCol = invert_(map);

  const lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try {
    const user = editorEmail_(e);
    const single = e.range.getNumRows() === 1 && e.range.getNumColumns() === 1;
    const r0 = e.range.getRow();
    const c0 = e.range.getColumn();
    for (let i = 0; i < e.range.getNumRows(); i++) {
      const row = r0 + i;
      if (row <= CONFIG.HEADER_ROW) continue;
      for (let j = 0; j < e.range.getNumColumns(); j++) {
        const col = c0 + j;
        if (col === c.current) {
          onEtaEdited_(sh, row, c, user, single ? e.oldValue : undefined);
        } else if (col === c.reason) {
          onReasonEdited_(sh, row, c);
        } else {
          const header = headersByCol[col];
          if (header && CONFIG.WATCH.some((w) => w.toLowerCase() === header)) {
            const newVal = sh.getRange(row, col).getDisplayValue();
            const oldVal = single ? (e.oldValue || '') : '(bulk edit)';
            if (String(oldVal) !== String(newVal)) {
              const id = ensureId_(sh, row, c);
              appendLog_(sh, row, c, user, id, sh.getRange(CONFIG.HEADER_ROW, col).getValue(), oldVal, newVal, '', '', '');
            }
          }
        }
      }
    }
  } finally {
    lock.releaseLock();
  }
}

function onEtaEdited_(sh, row, c, user, oldHint) {
  const id = ensureId_(sh, row, c);
  if (!id) return;
  const newVal = sh.getRange(row, c.current).getValue();
  const newDate = newVal instanceof Date ? dateOnly_(newVal) : null;
  let prev = getSnap_(id);
  if (prev === undefined) prev = serialToDate_(oldHint);
  if (sameDay_(prev, newDate)) return;

  const promisedCell = sh.getRange(row, c.promised);
  const promised = promisedCell.getValue();
  const now = new Date();

  if (!(promised instanceof Date) && newDate) {
    // First ETA ever → lock it as the promise.
    promisedCell.setValue(newDate);
    sh.getRange(row, c.changes).setValue(0);
    sh.getRange(row, c.delay).setValue(0);
    appendLog_(sh, row, c, user, id, 'Promised ETA (first ETA)', '', newDate, '', 0, 'Initial ETA from supplier / carrier');
  } else {
    const changes = (Number(sh.getRange(row, c.changes).getValue()) || 0) + 1;
    const moved = prev && newDate ? daysBetween_(prev, newDate) : '';
    const delay = promised instanceof Date && newDate ? daysBetween_(dateOnly_(promised), newDate) : '';
    sh.getRange(row, c.changes).setValue(changes);
    sh.getRange(row, c.delay).setValue(delay);
    appendLog_(sh, row, c, user, id, 'Current ETA', prev || '(blank)', newDate || '(cleared)', moved, delay, '');
    // Ask for a reason.
    sh.getRange(row, c.reason).clearContent().setBackground('#fff2cc')
      .setNote('ETA changed by ' + user + ' — please type the reason here.');
  }
  sh.getRange(row, c.lastBy).setValue(user);
  sh.getRange(row, c.lastAt).setValue(now);
  setSnap_(id, newDate);
}

function onReasonEdited_(sh, row, c) {
  const cell = sh.getRange(row, c.reason);
  const reason = String(cell.getValue()).trim();
  if (!reason) return;
  const id = sh.getRange(row, c.id).getValue();
  const log = getLogSheet_();
  const n = log.getLastRow();
  if (n < 2) return;
  const data = log.getRange(2, 1, n - 1, LOG_HEADERS.length).getValues();
  for (let i = data.length - 1; i >= 0; i--) {
    if (data[i][LOG_IDX['Tracker ID'] - 1] === id && data[i][LOG_IDX['Field'] - 1] === 'Current ETA') {
      if (!data[i][LOG_IDX['Reason'] - 1]) log.getRange(i + 2, LOG_IDX['Reason']).setValue(reason);
      break;
    }
  }
  cell.setBackground(null).clearNote();
}

// ───────────────────────────── LOG ─────────────────────────────
function getLogSheet_() {
  const ss = SpreadsheetApp.getActive();
  let log = ss.getSheetByName(CONFIG.LOG_SHEET);
  if (!log) {
    log = ss.insertSheet(CONFIG.LOG_SHEET);
    log.getRange(1, 1, 1, LOG_HEADERS.length).setValues([LOG_HEADERS])
      .setBackground('#1f3864').setFontColor('#ffffff').setFontWeight('bold');
    log.setFrozenRows(1);
    log.getRange('A:A').setNumberFormat(CONFIG.STAMP_FORMAT);
    log.setColumnWidth(LOG_IDX['Product'], 220);
    log.setColumnWidth(LOG_IDX['Reason'], 260);
    log.getRange(1, 1, 1, LOG_HEADERS.length).createFilter();
    const p = log.protect().setDescription('ETA Change Log — append-only, written by the tracker');
    lockToOwner_(p);
  }
  return log;
}

function appendLog_(sh, row, c, user, id, field, oldVal, newVal, moved, delay, reason) {
  const map = headerMap_(sh);
  const get = (keys) => {
    const col = findCol_(map, keys);
    return col ? sh.getRange(row, col).getDisplayValue() : '';
  };
  const fmt = (v) => (v instanceof Date
    ? Utilities.formatDate(v, SpreadsheetApp.getActive().getSpreadsheetTimeZone(), CONFIG.DATE_FORMAT)
    : v);
  getLogSheet_().appendRow([
    new Date(), user, sh.getName(), id,
    get(CONFIG.EXISTING.sn), get(CONFIG.EXISTING.product), get(CONFIG.EXISTING.tracking), get(CONFIG.EXISTING.carrier),
    field, fmt(oldVal), fmt(newVal), moved, delay, reason,
  ]);
}

// ───────────────────────────── HISTORY POPUP ─────────────────────────────
function showHistoryForSelection() {
  const sh = SpreadsheetApp.getActiveSheet();
  const map = headerMap_(sh);
  const idCol = map[CONFIG.COL.id.toLowerCase()];
  if (!idCol) return SpreadsheetApp.getUi().alert('This tab is not set up for ETA tracking.');
  const row = sh.getActiveRange().getRow();
  const id = sh.getRange(row, idCol).getValue();
  const product = sh.getRange(row, findCol_(map, CONFIG.EXISTING.product) || 1).getDisplayValue();
  const log = getLogSheet_();
  const rows = log.getLastRow() > 1
    ? log.getRange(2, 1, log.getLastRow() - 1, LOG_HEADERS.length).getDisplayValues()
        .filter((r) => r[LOG_IDX['Tracker ID'] - 1] === id)
    : [];
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const pick = ['Timestamp', 'Changed By', 'Field', 'Old Value', 'New Value', 'Moved (days)', 'Total Delay vs Promise (days)', 'Reason'];
  const html =
    '<style>body{font-family:Arial;font-size:12px}table{border-collapse:collapse;width:100%}' +
    'th,td{border:1px solid #ddd;padding:4px 6px;text-align:left}th{background:#1f3864;color:#fff}</style>' +
    '<h3>' + esc(product) + ' <small>(' + esc(id) + ')</small></h3>' +
    (rows.length
      ? '<table><tr>' + pick.map((h) => '<th>' + h + '</th>').join('') + '</tr>' +
        rows.map((r) => '<tr>' + pick.map((h) => '<td>' + esc(r[LOG_IDX[h] - 1]) + '</td>').join('') + '</tr>').join('') +
        '</table>'
      : '<p>No changes logged yet for this shipment.</p>');
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(900).setHeight(450), 'ETA history');
}

// ───────────────────────────── RE-BASELINE ─────────────────────────────
function rebaselinePromise() {
  const ui = SpreadsheetApp.getUi();
  const sh = SpreadsheetApp.getActiveSheet();
  const map = headerMap_(sh);
  if (!map[CONFIG.COL.promised.toLowerCase()]) return ui.alert('This tab is not set up for ETA tracking.');
  const c = cols_(map);
  const row = sh.getActiveRange().getRow();
  if (row <= CONFIG.HEADER_ROW) return ui.alert('Select a shipment row first.');
  const d = ui.prompt('Re-baseline promised ETA', 'New promised date (e.g. 25-Nov-2026):', ui.ButtonSet.OK_CANCEL);
  if (d.getSelectedButton() !== ui.Button.OK) return;
  const newDate = new Date(d.getResponseText());
  if (isNaN(newDate)) return ui.alert('Could not read that date.');
  const why = ui.prompt('Reason', 'Why is the promise being changed? (e.g. "Order re-negotiated with supplier")', ui.ButtonSet.OK_CANCEL);
  if (why.getSelectedButton() !== ui.Button.OK || !why.getResponseText().trim()) return ui.alert('A reason is required.');
  const id = ensureId_(sh, row, c);
  const old = sh.getRange(row, c.promised).getValue();
  try {
    sh.getRange(row, c.promised).setValue(dateOnly_(newDate));
  } catch (err) {
    return ui.alert('Only the sheet owner can re-baseline a promised ETA.');
  }
  const cur = sh.getRange(row, c.current).getValue();
  sh.getRange(row, c.delay).setValue(cur instanceof Date ? daysBetween_(dateOnly_(newDate), dateOnly_(cur)) : '');
  appendLog_(sh, row, c, editorEmail_(null), id, 'Promised ETA (RE-BASELINED)', old || '(blank)', dateOnly_(newDate), '', '', why.getResponseText().trim());
}

// ───────────────────────────── DASHBOARD ─────────────────────────────
function refreshDashboard() {
  const ss = SpreadsheetApp.getActive();
  const tz = ss.getSpreadsheetTimeZone();
  const today = dateOnly_(new Date());
  const open = [];
  const carriers = {};
  let total = 0, delayed = 0, changesTotal = 0;

  ss.getSheets().forEach((sh) => {
    if ([CONFIG.LOG_SHEET, CONFIG.DASH_SHEET].includes(sh.getName())) return;
    const map = headerMap_(sh);
    if (!map[CONFIG.COL.id.toLowerCase()]) return;
    const c = cols_(map);
    const n = sh.getLastRow() - CONFIG.HEADER_ROW;
    if (n < 1) return;
    const data = sh.getRange(CONFIG.HEADER_ROW + 1, 1, n, sh.getLastColumn()).getValues();
    const col = (keys) => findCol_(map, keys);
    const pCol = col(CONFIG.EXISTING.product), sCol = col(CONFIG.EXISTING.status), kCol = col(CONFIG.EXISTING.carrier);
    data.forEach((r) => {
      const promised = r[c.promised - 1];
      if (!(promised instanceof Date)) return; // only shipments that have an ETA
      total++;
      const current = r[c.current - 1];
      const delay = Number(r[c.delay - 1]) || 0;
      const changes = Number(r[c.changes - 1]) || 0;
      const status = sCol ? String(r[sCol - 1]) : '';
      const carrier = kCol ? String(r[kCol - 1]).trim() || '(blank)' : '(blank)';
      changesTotal += changes;
      if (delay > 0) delayed++;
      carriers[carrier] = carriers[carrier] || { n: 0, delay: 0, changes: 0, late: 0 };
      carriers[carrier].n++;
      carriers[carrier].delay += delay;
      carriers[carrier].changes += changes;
      if (delay > 0) carriers[carrier].late++;
      if (!CONFIG.DONE_STATUSES.includes(status.trim().toLowerCase())) {
        open.push([
          r[c.id - 1], sh.getName(), pCol ? r[pCol - 1] : '', carrier, status,
          promised, current instanceof Date ? current : '', delay, changes,
          current instanceof Date ? daysBetween_(today, dateOnly_(current)) : '',
          r[c.lastBy - 1], r[c.lastAt - 1],
        ]);
      }
    });
  });

  let dash = ss.getSheetByName(CONFIG.DASH_SHEET);
  if (!dash) dash = ss.insertSheet(CONFIG.DASH_SHEET);
  dash.clear();
  dash.getRange('A1').setValue('📦 Shipment ETA Dashboard').setFontSize(16).setFontWeight('bold');
  dash.getRange('A2').setValue('Last refreshed: ' + Utilities.formatDate(new Date(), tz, CONFIG.STAMP_FORMAT) +
    '  •  Refreshes daily at 7:00, or via menu 📦 ETA Tracker → Refresh dashboard').setFontColor('#666666');

  const kpis = [
    ['Tracked shipments', total],
    ['Open (not received)', open.length],
    ['Later than promised', delayed],
    ['Total ETA changes', changesTotal],
  ];
  dash.getRange(4, 1, 1, 4).setValues([kpis.map((k) => k[0])]).setFontColor('#666666');
  dash.getRange(5, 1, 1, 4).setValues([kpis.map((k) => k[1])]).setFontSize(20).setFontWeight('bold');

  let r = 7;
  dash.getRange(r, 1).setValue('Open shipments — most delayed first').setFontWeight('bold').setFontSize(12);
  r++;
  const openHdr = ['Tracker ID', 'Tab', 'Product', 'Carrier', 'Status', 'Promised ETA', 'Current ETA',
    'Delay (days)', '# Changes', 'Arrives in (days)', 'Last changed by', 'Last changed at'];
  dash.getRange(r, 1, 1, openHdr.length).setValues([openHdr]).setBackground('#1f3864').setFontColor('#fff').setFontWeight('bold');
  open.sort((a, b) => b[7] - a[7]);
  if (open.length) {
    dash.getRange(r + 1, 1, open.length, openHdr.length).setValues(open);
    dash.getRange(r + 1, 6, open.length, 2).setNumberFormat(CONFIG.DATE_FORMAT);
    dash.getRange(r + 1, 12, open.length, 1).setNumberFormat(CONFIG.STAMP_FORMAT);
    const dRng = dash.getRange(r + 1, 8, open.length, 1);
    dash.setConditionalFormatRules([
      SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(7).setBackground('#f4cccc').setRanges([dRng]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(0).setBackground('#fce5cd').setRanges([dRng]).build(),
    ]);
  } else {
    dash.getRange(r + 1, 1).setValue('No open shipments with an ETA.');
  }
  r += Math.max(open.length, 1) + 3;

  dash.getRange(r, 1).setValue('Carrier reliability (all tracked shipments)').setFontWeight('bold').setFontSize(12);
  r++;
  const cHdr = ['Carrier', 'Shipments', 'Late vs promise', '% late', 'Avg delay (days)', 'Avg ETA changes'];
  dash.getRange(r, 1, 1, cHdr.length).setValues([cHdr]).setBackground('#1f3864').setFontColor('#fff').setFontWeight('bold');
  const cRows = Object.entries(carriers)
    .map(([k, v]) => [k, v.n, v.late, v.late / v.n, round1_(v.delay / v.n), round1_(v.changes / v.n)])
    .sort((a, b) => b[4] - a[4]);
  if (cRows.length) {
    dash.getRange(r + 1, 1, cRows.length, cHdr.length).setValues(cRows);
    dash.getRange(r + 1, 4, cRows.length, 1).setNumberFormat('0%');
  }
  r += Math.max(cRows.length, 1) + 3;

  dash.getRange(r, 1).setValue('Latest 20 changes').setFontWeight('bold').setFontSize(12);
  r++;
  const log = getLogSheet_();
  const lHdr = ['Timestamp', 'Changed By', 'Product', 'Field', 'Old Value', 'New Value', 'Moved (days)', 'Reason'];
  dash.getRange(r, 1, 1, lHdr.length).setValues([lHdr]).setBackground('#1f3864').setFontColor('#fff').setFontWeight('bold');
  if (log.getLastRow() > 1) {
    const all = log.getRange(2, 1, log.getLastRow() - 1, LOG_HEADERS.length).getDisplayValues();
    const latest = all.slice(-20).reverse().map((x) => lHdr.map((h) => x[LOG_IDX[h] - 1]));
    dash.getRange(r + 1, 1, latest.length, lHdr.length).setValues(latest);
  }

  dash.setFrozenRows(2);
  dash.autoResizeColumns(1, 12);
  dash.setColumnWidth(3, 240);
}

// ───────────────────────────── HELPERS ─────────────────────────────
function headerMap_(sh) {
  const lastCol = sh.getLastColumn();
  if (lastCol < 1) return {};
  const hdr = sh.getRange(CONFIG.HEADER_ROW, 1, 1, lastCol).getValues()[0];
  const m = {};
  hdr.forEach((h, i) => {
    const k = String(h).trim().toLowerCase();
    if (k && !m[k]) m[k] = i + 1;
  });
  return m;
}

function invert_(map) {
  const out = {};
  Object.entries(map).forEach(([k, v]) => (out[v] = k));
  return out;
}

function findCol_(map, keys) {
  for (const k of keys) if (map[k.toLowerCase()]) return map[k.toLowerCase()];
  return 0;
}

function cols_(map) {
  const c = {};
  Object.entries(CONFIG.COL).forEach(([k, name]) => (c[k] = map[name.toLowerCase()]));
  return c;
}

/** Gives a row a stable Tracker ID (survives sorting / renaming). Empty rows get none. */
function ensureId_(sh, row, c) {
  const cell = sh.getRange(row, c.id);
  const id = cell.getValue();
  if (id) return id;
  const width = Math.min(sh.getLastColumn(), c.id - 1) || 1;
  const hasData = sh.getRange(row, 1, 1, width).getValues()[0].some((v) => v !== '' && v !== null);
  const hasEta = sh.getRange(row, c.current).getValue() !== '';
  if (!hasData && !hasEta) return '';
  const props = PropertiesService.getDocumentProperties();
  const seq = Number(props.getProperty('seq') || 0) + 1;
  props.setProperty('seq', String(seq));
  const newId = 'SHP-' + String(seq).padStart(4, '0');
  cell.setValue(newId);
  return newId;
}

function getSnap_(id) {
  const v = PropertiesService.getDocumentProperties().getProperty('eta:' + id);
  if (v === null) return undefined;
  return v ? new Date(Number(v)) : null;
}

function setSnap_(id, d) {
  PropertiesService.getDocumentProperties().setProperty('eta:' + id, d ? String(dateOnly_(d).getTime()) : '');
}

function editorEmail_(e) {
  let email = '';
  try { email = e && e.user ? e.user.getEmail() : ''; } catch (err) {}
  if (!email) try { email = Session.getActiveUser().getEmail(); } catch (err) {}
  return email || 'Unknown (outside company domain)';
}

function lockToOwner_(protection) {
  const me = Session.getEffectiveUser();
  protection.addEditor(me);
  protection.removeEditors(protection.getEditors().filter((u) => u.getEmail() !== me.getEmail()));
  if (protection.canDomainEdit()) protection.setDomainEdit(false);
}

function dateOnly_(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function sameDay_(a, b) { return (!a && !b) || (a && b && dateOnly_(a).getTime() === dateOnly_(b).getTime()); }
function daysBetween_(a, b) { return Math.round((dateOnly_(b) - dateOnly_(a)) / 86400000); }
function round1_(x) { return Math.round(x * 10) / 10; }

/** e.oldValue for a date cell is a Sheets serial number; convert it if present. */
function serialToDate_(v) {
  const n = Number(v);
  if (!v || isNaN(n)) return null;
  const ms = Math.round((n - 25569) * 86400000);
  const d = new Date(ms);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
