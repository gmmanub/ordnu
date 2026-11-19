// ordnu – Steuerung: Startbildschirm, Projekte, Tabs, Seitenleiste, Speichern, Verlauf.

import {
  createTab, newId, DEFAULT_IMAGE_WIDTH, defaultCrop, isImageName,
  effectiveDate, dateSuggestion, formatDate, formatDay,
  createFrame, boundsOf, FRAME_PAD,
} from './model.js';
import {
  supportsFolders, rememberRoot, recallRoot, hasPermission, listProjects,
  loadProjectData, saveProjectData, scanImages, getThumbnail, loadHistoryRaw, saveHistoryRaw,
} from './files.js';
import { Board } from './board.js';
import { TabHistory, capture, diff } from './history.js';

const $ = id => document.getElementById(id);
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
const SAVE_DELAY = 1000;          // ms nach letzter Änderung (PFLICHTENHEFT 1.2)
const HISTORY_SAVE_DELAY = 3000;  // Verlauf seltener speichern
const ORIGINAL_ABOVE_PX = 600;    // ab dieser Bildschirmbreite wird das Original statt der Vorschau gezeigt
const TAB_UNDO_MS = 8000;         // so lange kann ein gelöschter Tab zurückgeholt werden
export const UNDO_STEPS = 200;    // Schritte Rückgängig je Tab (PFLICHTENHEFT 2, V1)
const RESCAN_EVERY_MS = 60 * 60 * 1000; // automatisch 1×/Stunde nach neuen Dateien schauen
const RESCAN_MIN_GAP_MS = 5000;   // beim Zurückwechseln höchstens alle 5 s
const GRID_GAP = 24;              // Abstand im Raster beim Ablegen eines Ordners

export const state = {
  root: null,
  projectName: null,
  projectDir: null,
  appDir: null,
  data: null,
  images: new Map(), // path → { img, thumb, thumbPromise, origUrl, origPromise }
  saveTimer: null,
  saving: null,
  dirty: false,
  hist: new TabHistory(UNDO_STEPS),
  histTimer: null,
  histDirty: false,
  tx: null, // laufende Änderung (Zustand davor)
  scanning: null,
  lastScan: 0,
  observer: null,
  filter: { onlyNew: false, day: '' },
  editDatePath: null,
};

let board;
export const _board = () => board; // nur für Tests

// ---------- Hilfen ----------

function show(screen) {
  for (const id of ['start', 'projects', 'app']) $(id).hidden = id !== screen;
}

let toastTimer;
// Hinweis unten; optional mit Knopf (z. B. „Rückgängig“).
function toast(text, ms = 4000, action = null) {
  const t = $('toast');
  t.replaceChildren(Object.assign(document.createElement('span'), { textContent: text }));
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.addEventListener('click', () => { t.hidden = true; action.fn(); });
    t.appendChild(b);
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// Rückfrage in der App (keine Browser-Dialoge). Ergebnis: true/false.
function ask(title, text, okLabel) {
  return new Promise(resolve => {
    const m = $('modal');
    $('modal-title').textContent = title;
    $('modal-text').textContent = text;
    $('modal-ok').textContent = okLabel;
    m.hidden = false;
    $('modal-cancel').focus();
    const done = v => {
      m.hidden = true;
      $('modal-ok').onclick = $('modal-cancel').onclick = null;
      document.removeEventListener('keydown', key, true);
      resolve(v);
    };
    const key = e => {
      if (e.key === 'Escape') { e.stopPropagation(); done(false); }
      if (e.key === 'Enter') { e.stopPropagation(); e.preventDefault(); done(true); }
    };
    $('modal-ok').onclick = () => done(true);
    $('modal-cancel').onclick = () => done(false);
    document.addEventListener('keydown', key, true);
  });
}

function activeTab() {
  return state.data.tabs.find(t => t.id === state.data.activeTab);
}

function tabItems() {
  return state.data.items.filter(i => i.tab === state.data.activeTab);
}

// ---------- Speichern ----------

function setSaveState(text) { $('save-state').textContent = text; }

function scheduleSave() {
  state.dirty = true;
  setSaveState('Ungespeichert …');
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(flushSave, SAVE_DELAY);
}

export async function flushSave() {
  clearTimeout(state.saveTimer);
  if (!state.dirty || !state.appDir) return;
  if (state.saving) await state.saving;
  state.dirty = false;
  const run = (async () => {
    try {
      await saveProjectData(state.appDir, state.data);
      if (!state.dirty) setSaveState('Gespeichert');
    } catch (err) {
      state.dirty = true;
      setSaveState('Speichern fehlgeschlagen');
      toast(`Speichern fehlgeschlagen: ${err.message}`, 8000);
    }
  })();
  state.saving = run;
  await run;
  state.saving = null;
}

function scheduleHistorySave() {
  state.histDirty = true;
  clearTimeout(state.histTimer);
  state.histTimer = setTimeout(flushHistory, HISTORY_SAVE_DELAY);
}

export async function flushHistory() {
  clearTimeout(state.histTimer);
  if (!state.histDirty || !state.appDir) return;
  state.histDirty = false;
  try {
    await saveHistoryRaw(state.appDir, state.hist.toJSON());
  } catch (err) {
    state.histDirty = true;
    console.warn('Verlauf speichern fehlgeschlagen', err);
  }
}

export async function flushAll() {
  await Promise.all([flushSave(), flushHistory()]);
}

window.addEventListener('beforeunload', e => {
  if (state.dirty || state.histDirty) { flushAll(); e.preventDefault(); e.returnValue = ''; }
});

// ---------- Rückgängig / Wiederholen (pro Tab) ----------
// Jede Änderung: beginChange() → ändern → commitChange(). Gespeichert werden nur Unterschiede.

function beginChange() {
  if (!state.tx) state.tx = capture(state.data, state.data.activeTab);
}

function commitChange() {
  const tx = state.tx;
  state.tx = null;
  if (!tx) return;
  const entry = diff(tx, state.data);
  if (!entry) return;
  state.hist.push(tx.tabId, entry);
  scheduleHistorySave();
  markPlaced();
  if (markSeen() || entry.tags.length) renderImageList();
  scheduleSave();
}

function afterHistoryStep(res) {
  if (!res) return false;
  board.replaceItems(tabItems());
  markPlaced();
  renderImageList();
  scheduleSave();
  scheduleHistorySave();
  if (res.skipped) toast('Einige Tags wurden inzwischen in einem anderen Tab geändert und bleiben so.');
  return true;
}

export function undo() {
  if (!state.data) return false;
  return afterHistoryStep(state.hist.undo(state.data.activeTab, state.data));
}

export function redo() {
  if (!state.data) return false;
  return afterHistoryStep(state.hist.redo(state.data.activeTab, state.data));
}

window.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || e.target.closest('input, textarea')) return;
  if (!$('modal').hidden || $('app').hidden) return;
  const key = e.key.toLowerCase();
  if (key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if ((key === 'z' && e.shiftKey) || key === 'y') { e.preventDefault(); redo(); }
  else if (key === 'g' && !e.shiftKey) { e.preventDefault(); frameAroundSelection(); }
});

// ---------- Rahmen (Bau-Schritt 3) ----------

// Rahmen anlegen (aufgezogen oder um Auswahl). Danach gleich Namen bearbeiten.
export function addFrame(area, { rename = true } = {}) {
  beginChange();
  const f = createFrame(state.data.activeTab, area.x, area.y, area.w, area.h);
  state.data.items.push(f);
  board.replaceItems(tabItems());
  board.setSelection([f.id]);
  commitChange();
  if (rename) board.startRename(f.id);
  return f;
}

export function frameAroundSelection() {
  if (!state.data || $('app').hidden || board.cropId) return null;
  const sel = board.selectedItems();
  if (!sel.length) { toast('Erst etwas auswählen – dann Strg+G.'); return null; }
  const b = boundsOf(sel);
  return addFrame({ x: b.x - FRAME_PAD, y: b.y - FRAME_PAD, w: b.w + 2 * FRAME_PAD, h: b.h + 2 * FRAME_PAD });
}

// ---------- Tags (Datenebene; Bedienoberfläche folgt in Bau-Schritt 5) ----------
// Tags hängen am Bild (Pfad) und gelten in allen Tabs. Rückgängig im Tab, in dem geändert wurde.

export function setTags(paths, changes) {
  beginChange();
  for (const path of paths) {
    const t = { ...(state.data.tags[path] || {}) };
    for (const [k, v] of Object.entries(changes)) {
      if (v === null || v === '') delete t[k]; else t[k] = v;
    }
    if (Object.keys(t).length) state.data.tags[path] = t; else delete state.data.tags[path];
  }
  commitChange();
}

// ---------- Bilder ----------

function ensureThumb(path) {
  const entry = state.images.get(path);
  if (!entry) return Promise.resolve(null);
  if (!entry.thumbPromise) {
    entry.thumbPromise = getThumbnail(state.appDir, entry.img)
      .then(t => { entry.thumb = t; return t; })
      .catch(err => { console.warn('Vorschau fehlgeschlagen', entry.img.path, err); return null; });
  }
  return entry.thumbPromise;
}

function ensureOriginal(path) {
  const entry = state.images.get(path);
  if (!entry) return Promise.resolve(null);
  if (!entry.origPromise) {
    entry.origPromise = entry.img.handle.getFile()
      .then(f => { entry.origUrl = URL.createObjectURL(f); return entry.origUrl; });
  }
  return entry.origPromise;
}

// Board fragt: welche Bildquelle bei dieser Bildschirmbreite (ganzes Bild, inkl. Ausschnitt-Vergrößerung)?
function imageUrlFor(path, displayPx) {
  const entry = state.images.get(path);
  if (!entry) return null; // Datei fehlt
  if (displayPx > ORIGINAL_ABOVE_PX) {
    if (entry.origUrl) return { url: entry.origUrl };
    ensureOriginal(path).then(() => board.refreshSources());
  }
  if (entry.thumb) return { url: entry.thumb.url };
  ensureThumb(path).then(() => board.refreshSources());
  return { url: entry.origUrl || BLANK };
}

function releaseImages() {
  for (const e of state.images.values()) {
    if (e.thumb) URL.revokeObjectURL(e.thumb.url);
    if (e.origUrl) URL.revokeObjectURL(e.origUrl);
  }
  state.images.clear();
}

// Vorschauen nacheinander im Hintergrund erzeugen (2 gleichzeitig), Seitenleiste aktualisieren.
async function generateThumbsInBackground(project, paths = null) {
  const queue = paths ? [...paths] : [...state.images.keys()];
  const worker = async () => {
    while (queue.length && state.projectName === project) {
      const path = queue.shift();
      const t = await ensureThumb(path);
      if (t && state.projectName === project) {
        const img = document.querySelector(`#image-list li[data-path="${CSS.escape(path)}"] img`);
        if (img) img.src = t.url;
      }
    }
  };
  await Promise.all([worker(), worker()]);
  if (state.projectName === project) board.refreshSources();
}

export async function placeImage(path, x, y, { centered = true } = {}) {
  const t = await ensureThumb(path);
  const w = DEFAULT_IMAGE_WIDTH;
  const ar = t ? t.height / t.width : 1;
  const h = Math.round(w * ar);
  beginChange();
  const item = {
    id: newId('img'), tab: state.data.activeTab, type: 'image', path,
    x: Math.round(centered ? x - w / 2 : x), y: Math.round(centered ? y - h / 2 : y), w, h,
    ar, crop: defaultCrop(),
  };
  state.data.items.push(item);
  board.replaceItems(tabItems());
  board.setSelection([item.id]);
  commitChange();
  return item;
}

// ---------- Dateien: Einlesen, Aktualisieren, Eingangsdatum (PFLICHTENHEFT 1.5) ----------

// Gefundene Dateien mit data.files abgleichen. Rückgabe: { added (neu bei Aktualisierung), changed }.
async function syncFiles(found) {
  const d = state.data;
  const first = !d.firstScanDone;
  const now = Date.now();
  const added = [], changed = [];
  let dirty = first;
  for (const img of found) {
    let mtime = null;
    try { mtime = (await img.handle.getFile()).lastModified; } catch { /* Datei gerade weg */ }
    const info = d.files[img.path];
    if (!info) {
      // Beim allerersten Einlesen gilt das Dateidatum, danach der Moment, in dem ordnu die Datei sieht.
      d.files[img.path] = first ? { eingang: mtime ?? now, mtime } : { eingang: now, mtime, neu: true };
      if (!first) added.push(img.path);
      dirty = true;
    } else if (mtime != null && info.mtime !== mtime) {
      if (info.mtime != null) changed.push(img.path);
      info.mtime = mtime;
      dirty = true;
    }
  }
  d.firstScanDone = true;
  if (dirty) scheduleSave();
  return { added, changed };
}

// Bilder, die auf irgendeinem Board liegen, gelten als gesehen.
function markSeen() {
  const onBoard = new Set(state.data.items.filter(i => i.type === 'image').map(i => i.path));
  let changed = false;
  for (const path of onBoard) {
    const info = state.data.files[path];
    if (info && info.neu) { delete info.neu; changed = true; }
  }
  if (changed) scheduleSave();
  return changed;
}

export function markAllSeen() {
  let n = 0;
  for (const info of Object.values(state.data.files)) if (info.neu) { delete info.neu; n++; }
  if (n) { scheduleSave(); renderImageList(); }
  return n;
}

// Projektordner (neu) einlesen. Findet neue, geänderte und verschwundene Dateien.
export async function rescan({ quiet = false } = {}) {
  if (!state.projectDir) return { added: [], removed: [] };
  if (state.scanning) return state.scanning;
  const project = state.projectName;
  const run = (async () => {
    const found = await scanImages(state.projectDir);
    if (state.projectName !== project) return { added: [], removed: [] };
    const foundSet = new Set(found.map(f => f.path));
    const removed = [];
    for (const [path, e] of state.images) {
      if (foundSet.has(path)) continue;
      if (e.thumb) URL.revokeObjectURL(e.thumb.url);
      if (e.origUrl) URL.revokeObjectURL(e.origUrl);
      state.images.delete(path);
      removed.push(path);
    }
    const fresh = [];
    for (const img of found) {
      const e = state.images.get(img.path);
      if (e) e.img = img;
      else { state.images.set(img.path, { img, thumb: null }); fresh.push(img.path); }
    }
    const { added, changed } = await syncFiles(found);
    for (const path of changed) { // Datei ersetzt → Vorschau/Original neu laden
      const e = state.images.get(path);
      if (!e) continue;
      if (e.thumb) URL.revokeObjectURL(e.thumb.url);
      if (e.origUrl) URL.revokeObjectURL(e.origUrl);
      Object.assign(e, { thumb: null, thumbPromise: null, origUrl: null, origPromise: null });
      fresh.push(path);
    }
    if (state.projectName !== project) return { added: [], removed: [] };
    markSeen();
    renderImageList();
    board.refreshSources();
    if (fresh.length) generateThumbsInBackground(project, fresh);
    state.lastScan = Date.now();
    if (!quiet && added.length) toast(added.length === 1 ? '1 neues Bild gefunden' : `${added.length} neue Bilder gefunden`);
    return { added, removed, changed };
  })();
  state.scanning = run;
  try { return await run; } finally { state.scanning = null; }
}

// Automatisch: beim Zurückwechseln in die App, 1×/Stunde, und – falls Chrome es kann – bei Ordneränderungen.
let rescanSoonTimer;
function rescanSoon(delay = 500) {
  clearTimeout(rescanSoonTimer);
  rescanSoonTimer = setTimeout(() => {
    if (!state.projectDir || $('app').hidden) return;
    const wait = state.lastScan + RESCAN_MIN_GAP_MS - Date.now();
    if (wait > 0) { rescanSoon(wait + 50); return; } // zu kurz nach dem letzten Einlesen → etwas später
    rescan().catch(err => console.warn('Aktualisieren fehlgeschlagen', err));
  }, delay);
}

function watchProject() {
  if (state.observer) { try { state.observer.disconnect(); } catch { /* egal */ } state.observer = null; }
  if (typeof window.FileSystemObserver !== 'function' || !state.projectDir) return;
  try {
    // Eigene Schreibvorgänge in .ordnu/ ignorieren, sonst liest die App sich ständig selbst neu ein.
    const obs = new window.FileSystemObserver(records => {
      const relevant = records.some(r => !(r.relativePathComponents || []).some(p => p.startsWith('.')));
      if (relevant) rescanSoon(1500);
    });
    obs.observe(state.projectDir, { recursive: true }).catch(() => obs.disconnect());
    state.observer = obs;
  } catch { state.observer = null; }
}

// ---------- Ablegen: Ordner/Dateien aus dem Explorer, mehrere Bilder als Raster ----------

// Mehrere Bilder als Raster um (x, y) ablegen. Was im selben Tab schon liegt, wird übersprungen.
export async function placeMany(paths, x, y, { outside = 0 } = {}) {
  const onTab = new Set(tabItems().filter(i => i.type === 'image').map(i => i.path));
  const unique = [...new Set(paths)].sort((a, b) => a.localeCompare(b, 'de', { numeric: true }));
  const todo = unique.filter(p => state.images.has(p) && !onTab.has(p));
  const skipped = unique.filter(p => onTab.has(p)).length;
  const result = { placed: todo.length, skipped, outside };
  if (todo.length) {
    const thumbs = [];
    for (let i = 0; i < todo.length; i += 4) thumbs.push(...await Promise.all(todo.slice(i, i + 4).map(ensureThumb)));
    const w = DEFAULT_IMAGE_WIDTH;
    const cols = Math.ceil(Math.sqrt(todo.length));
    const ars = thumbs.map(t => (t ? t.height / t.width : 1));
    const rowH = [];
    ars.forEach((ar, i) => { const r = Math.floor(i / cols); rowH[r] = Math.max(rowH[r] || 0, Math.round(w * ar)); });
    const totalW = cols * w + (cols - 1) * GRID_GAP;
    const totalH = rowH.reduce((a, b) => a + b, 0) + (rowH.length - 1) * GRID_GAP;
    const x0 = Math.round(x - totalW / 2), y0 = Math.round(y - totalH / 2);
    beginChange(); // ganzer Drop = ein Rückgängig-Schritt
    const ids = [];
    let top = y0;
    todo.forEach((path, i) => {
      const r = Math.floor(i / cols), c = i % cols;
      if (c === 0 && r > 0) top += rowH[r - 1] + GRID_GAP;
      const item = {
        id: newId('img'), tab: state.data.activeTab, type: 'image', path,
        x: x0 + c * (w + GRID_GAP), y: top, w, h: Math.round(w * ars[i]), ar: ars[i], crop: defaultCrop(),
      };
      state.data.items.push(item);
      ids.push(item.id);
    });
    board.replaceItems(tabItems());
    board.setSelection(ids);
    commitChange();
  }
  const parts = [`${result.placed} neu platziert`, `${result.skipped} schon auf diesem Board`];
  if (outside) parts.push(`${outside} außerhalb des Projekts (nicht übernommen)`);
  toast(parts.join(', '), 6000);
  return result;
}

// Vom Explorer abgelegte Ordner/Dateien. Nur was im Projekt liegt – ordnu kopiert nichts.
export async function dropHandles(handlePromises, x, y) {
  const settled = await Promise.allSettled(handlePromises.map(h => Promise.resolve(h)));
  const handles = settled.map(r => (r.status === 'fulfilled' ? r.value : null)).filter(Boolean);
  if (!handles.length) { toast('Ablegen von Ordnern wird von diesem Browser nicht unterstützt.'); return null; }
  let outside = 0;
  const paths = [];
  for (const h of handles) {
    let rel = null;
    try { rel = await state.projectDir.resolve(h); } catch { rel = null; }
    if (!rel) { outside++; continue; }
    if (rel.some(p => p.startsWith('.'))) continue; // versteckte Ordner (z. B. .ordnu)
    const prefix = rel.join('/');
    if (h.kind === 'directory') for (const img of await scanImages(h, prefix)) paths.push(img.path);
    else if (isImageName(h.name)) paths.push(prefix);
  }
  if (!paths.length) {
    toast(outside
      ? 'Das liegt nicht in diesem Projekt. ordnu kopiert keine Dateien – bitte zuerst in den Projektordner legen.'
      : 'Keine unterstützten Bilder gefunden.', 7000);
    return { placed: 0, skipped: 0, outside };
  }
  if (paths.some(p => !state.images.has(p))) await rescan({ quiet: true });
  return placeMany(paths, x, y, { outside });
}

// ---------- Seitenleiste: Bilderliste nach Tagen, Filter, Datum-Vorschläge ----------

function dateInfo(path) {
  return effectiveDate(path, state.data.files[path], state.data.tags[path]);
}

const SOURCE_LABEL = { ordner: 'Tagesordner', eingang: 'Eingang', hand: 'von Hand' };

export function renderImageList() {
  if (!state.data) return;
  const list = $('image-list');
  list.replaceChildren();
  const d = state.data;
  const rows = [...state.images.keys()].map(path => ({ path, eff: dateInfo(path), info: d.files[path] }));

  // Tag-Auswahl aktualisieren (Auswahl behalten)
  const days = [...new Set(rows.map(r => r.eff.date || ''))].sort().reverse();
  const sel = $('filter-day');
  if (state.filter.day && !days.includes(state.filter.day)) state.filter.day = '';
  sel.replaceChildren(new Option('Alle Tage', ''), ...days.map(day => new Option(day ? formatDay(day) : 'ohne Datum', day || '-')));
  sel.value = state.filter.day;

  const newCount = rows.filter(r => r.info && r.info.neu).length;
  $('new-count').textContent = newCount;
  $('btn-seen').disabled = newCount === 0;
  $('opt-suggest').checked = d.settings.dateSuggestions !== false;

  let shown = rows;
  if (state.filter.onlyNew) shown = shown.filter(r => r.info && r.info.neu);
  if (state.filter.day) shown = shown.filter(r => (r.eff.date || '-') === state.filter.day);
  shown.sort((a, b) => (b.eff.date || '').localeCompare(a.eff.date || '')
    || (b.eff.time || '').localeCompare(a.eff.time || '')
    || a.path.localeCompare(b.path, 'de', { numeric: true }));

  let day = null;
  for (const r of shown) {
    const key = r.eff.date || '-';
    if (key !== day) {
      day = key;
      const head = document.createElement('li');
      head.className = 'group-head';
      head.textContent = r.eff.date ? formatDay(r.eff.date) : 'ohne Datum';
      list.appendChild(head);
    }
    list.appendChild(imageTile(r));
    const sug = dateSuggestion(r.path, r.info, d.tags[r.path], d.settings);
    if (sug) list.appendChild(suggestionRow(r.path, sug));
    if (state.editDatePath === r.path) list.appendChild(dateEditRow(r.path, r.eff));
  }
  if (!shown.length) {
    list.appendChild(Object.assign(document.createElement('li'), {
      className: 'list-empty muted small',
      textContent: state.images.size ? 'Keine Bilder für diesen Filter.' : 'Keine Bilder im Projekt.',
    }));
  }
  $('image-count').textContent = `${state.images.size}`;
  markPlaced();
}

function imageTile({ path, eff, info }) {
  const entry = state.images.get(path);
  const li = document.createElement('li');
  li.className = 'tile' + (info && info.neu ? ' is-new' : '');
  li.dataset.path = path;
  const when = eff.date ? `${formatDate(eff.date)}${eff.time ? ` ${eff.time}` : ''} (${SOURCE_LABEL[eff.source]})` : 'ohne Datum';
  li.title = `${path}\nDatum: ${when}\nRechtsklick: Datum ändern`;
  li.draggable = true;
  const img = document.createElement('img');
  img.src = entry.thumb ? entry.thumb.url : BLANK;
  img.alt = '';
  const name = Object.assign(document.createElement('span'), { className: 'name', textContent: entry.img.name });
  li.append(img, name);
  if (info && info.neu) li.appendChild(Object.assign(document.createElement('span'), { className: 'badge-new', textContent: 'Neu' }));
  li.addEventListener('click', () => {
    const c = board.centerWorld();
    const n = tabItems().length % 8; // leicht versetzt, damit nichts exakt übereinander liegt
    placeImage(path, c.x + n * 24, c.y + n * 24);
  });
  li.addEventListener('contextmenu', e => {
    e.preventDefault();
    state.editDatePath = state.editDatePath === path ? null : path;
    renderImageList();
  });
  li.addEventListener('dragstart', e => {
    e.dataTransfer.setData('application/x-ordnu-path', path);
    e.dataTransfer.effectAllowed = 'copy';
  });
  return li;
}

function suggestionRow(path, sug) {
  const li = document.createElement('li');
  li.className = 'row-note suggest';
  li.dataset.path = path;
  const name = state.images.get(path).img.name;
  li.append(Object.assign(document.createElement('span'), {
    textContent: `${name}: Dateidatum ${formatDate(sug.date)} übernehmen?`,
  }));
  const ok = Object.assign(document.createElement('button'), { textContent: 'Übernehmen', className: 'suggest-ok' });
  const no = Object.assign(document.createElement('button'), { textContent: 'Ignorieren', className: 'suggest-no' });
  ok.addEventListener('click', () => acceptSuggestion(path));
  no.addEventListener('click', () => ignoreSuggestion(path));
  li.append(ok, no);
  return li;
}

export function acceptSuggestion(path) {
  const d = state.data;
  const sug = dateSuggestion(path, d.files[path], d.tags[path], d.settings);
  if (!sug) return false;
  setTags([path], { datum: sug.date, uhrzeit: sug.time });
  renderImageList();
  return true;
}

export function ignoreSuggestion(path) {
  const info = state.data.files[path];
  if (!info) return false;
  info.ignoreSuggest = true;
  scheduleSave();
  renderImageList();
  return true;
}

export function setDateSuggestions(on) {
  state.data.settings.dateSuggestions = Boolean(on);
  scheduleSave();
  renderImageList();
}

// Datum von Hand setzen (null = zurück auf automatisch). Ein Rückgängig-Schritt.
export function setManualDate(path, date, time = null) {
  setTags([path], { datum: date || null, uhrzeit: date ? (time || null) : null });
  renderImageList();
}

function dateEditRow(path, eff) {
  const li = document.createElement('li');
  li.className = 'row-note date-edit';
  const date = Object.assign(document.createElement('input'), { type: 'date', value: eff.date || '' });
  const time = Object.assign(document.createElement('input'), { type: 'time', value: eff.time || '' });
  const save = Object.assign(document.createElement('button'), { textContent: 'Speichern' });
  const auto = Object.assign(document.createElement('button'), { textContent: 'Automatisch', title: 'Datum wieder automatisch bestimmen' });
  save.addEventListener('click', () => { state.editDatePath = null; setManualDate(path, date.value, time.value); });
  auto.addEventListener('click', () => { state.editDatePath = null; setManualDate(path, null); });
  li.append(date, time, save, auto);
  return li;
}

function markPlaced() {
  if (!state.data) return;
  const onBoard = new Set(tabItems().filter(i => i.type === 'image').map(i => i.path));
  for (const li of $('image-list').querySelectorAll('li.tile')) li.classList.toggle('on-board', onBoard.has(li.dataset.path));
  $('board-empty').hidden = tabItems().length > 0;
}

// ---------- Tabs ----------
// Umbenennen, Sortieren und Löschen gehören zu keinem Tab-Verlauf (nicht per Strg+Z).

let dragTabId = null;

function renderTabs() {
  const nav = $('tabs');
  nav.replaceChildren();
  for (const tab of state.data.tabs) {
    const b = document.createElement('div');
    b.className = 'tab' + (tab.id === state.data.activeTab ? ' active' : '');
    b.dataset.id = tab.id;
    b.draggable = true;
    b.title = 'Doppelklick: umbenennen · Ziehen: sortieren';
    const label = Object.assign(document.createElement('span'), { className: 'tab-label', textContent: tab.name });
    const close = Object.assign(document.createElement('button'), { className: 'tab-close', textContent: '×', title: 'Tab löschen' });
    close.addEventListener('click', e => { e.stopPropagation(); deleteTab(tab.id); });
    b.append(label, close);
    b.addEventListener('click', () => switchTab(tab.id));
    b.addEventListener('dblclick', () => renameTab(tab, b));
    b.addEventListener('dragstart', e => {
      dragTabId = tab.id;
      e.dataTransfer.setData('application/x-ordnu-tab', tab.id);
      e.dataTransfer.effectAllowed = 'move';
    });
    b.addEventListener('dragover', e => {
      if (!dragTabId || dragTabId === tab.id) return;
      e.preventDefault();
      const r = b.getBoundingClientRect();
      b.classList.toggle('drop-before', e.clientX < r.left + r.width / 2);
      b.classList.toggle('drop-after', e.clientX >= r.left + r.width / 2);
    });
    b.addEventListener('dragleave', () => b.classList.remove('drop-before', 'drop-after'));
    b.addEventListener('drop', e => {
      e.preventDefault();
      const r = b.getBoundingClientRect();
      moveTab(dragTabId, tab.id, e.clientX >= r.left + r.width / 2);
    });
    b.addEventListener('dragend', () => { dragTabId = null; });
    nav.appendChild(b);
  }
}

// Tab id vor (after=false) bzw. hinter (after=true) den Tab targetId setzen.
export function moveTab(id, targetId, after) {
  const tabs = state.data.tabs;
  const from = tabs.findIndex(t => t.id === id);
  if (from < 0 || id === targetId) return renderTabs();
  const [tab] = tabs.splice(from, 1);
  let to = tabs.findIndex(t => t.id === targetId);
  if (to < 0) to = tabs.length; else if (after) to++;
  tabs.splice(to, 0, tab);
  renderTabs();
  scheduleSave();
}

export function switchTab(id) {
  if (id === state.data.activeTab || !state.data.tabs.some(t => t.id === id)) return;
  state.data.activeTab = id;
  renderTabs();
  board.setContent(tabItems(), activeTab().view);
  markPlaced();
  scheduleSave();
}

function renameTab(tab, el) {
  const input = document.createElement('input');
  input.value = tab.name;
  el.replaceChildren(input);
  el.draggable = false;
  input.focus(); input.select();
  let done = false;
  const finish = commit => {
    if (done) return; done = true;
    const v = input.value.trim();
    if (commit && v && v !== tab.name) { tab.name = v; scheduleSave(); }
    renderTabs();
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
    e.stopPropagation();
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', e => e.stopPropagation());
}

function addTab() {
  const tab = createTab(`Board ${state.data.tabs.length + 1}`);
  state.data.tabs.push(tab);
  switchTab(tab.id);
  renameTab(tab, $('tabs').lastElementChild);
}

// Löschen mit Rückfrage; danach einige Sekunden „Rückgängig“ (stellt Inhalt und Verlauf wieder her).
export async function deleteTab(id) {
  const tabs = state.data.tabs;
  const tab = tabs.find(t => t.id === id);
  if (!tab) return false;
  if (tabs.length <= 1) { toast('Der letzte Tab kann nicht gelöscht werden.'); return false; }
  const ok = await ask(`Tab „${tab.name}“ löschen?`,
    'Die Anordnung in diesem Tab wird entfernt. Deine Bilddateien bleiben unverändert.', 'Löschen');
  if (!ok) return false;

  await flushSave();
  const index = tabs.indexOf(tab);
  const items = state.data.items.filter(i => i.tab === id);
  const hist = state.hist.removeTab(id);
  tabs.splice(index, 1);
  state.data.items = state.data.items.filter(i => i.tab !== id);
  if (state.data.activeTab === id) {
    state.data.activeTab = tabs[Math.min(index, tabs.length - 1)].id;
    board.setContent(tabItems(), activeTab().view);
  }
  renderTabs();
  markPlaced();
  scheduleSave();
  scheduleHistorySave();

  toast(`Tab „${tab.name}“ gelöscht`, TAB_UNDO_MS, {
    label: 'Rückgängig',
    fn: () => {
      if (state.data.tabs.some(t => t.id === id)) return;
      state.data.tabs.splice(Math.min(index, state.data.tabs.length), 0, tab);
      state.data.items.push(...items);
      state.hist.restoreTab(id, hist);
      state.data.activeTab = null;
      switchTab(id);
      scheduleHistorySave();
    },
  });
  return true;
}

// ---------- Ablauf ----------

export async function openRoot(handle, { remember = true } = {}) {
  state.root = handle;
  if (remember) {
    try { await rememberRoot(handle); } catch { /* Merken ist optional */ }
  }
  const names = await listProjects(handle);
  $('root-name').textContent = `Hauptordner: ${handle.name}`;
  const list = $('project-list');
  list.replaceChildren();
  for (const name of names) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.textContent = name;
    b.addEventListener('click', () => openProject(name).catch(err => toast(err.message, 10000)));
    li.appendChild(b);
    list.appendChild(li);
  }
  $('project-empty').hidden = names.length > 0;
  show('projects');
  return names;
}

export async function openProject(name) {
  await flushAll();
  releaseImages();
  const projectDir = await state.root.getDirectoryHandle(name);
  const { appDir, data, notice } = await loadProjectData(projectDir);
  const hist = TabHistory.from(await loadHistoryRaw(appDir), UNDO_STEPS, new Set(data.tabs.map(t => t.id)));
  Object.assign(state, { projectName: name, projectDir, appDir, data, hist, dirty: false, histDirty: false, tx: null });
  if (notice) toast(notice, 10000);

  state.filter = { onlyNew: false, day: '' };
  $('filter-new').checked = false;
  state.editDatePath = null;
  state.lastScan = 0;

  $('project-name').textContent = name;
  setSaveState('');
  show('app');
  renderTabs();
  board.setContent(tabItems(), activeTab().view);
  const { added } = await rescan({ quiet: true });
  if (added.length) toast(`${added.length} neue ${added.length === 1 ? 'Datei' : 'Dateien'} seit dem letzten Öffnen`);
  watchProject();
  return { images: state.images.size, added: added.length };
}

async function pickRoot() {
  try {
    const handle = await window.showDirectoryPicker({ id: 'ordnu-root', mode: 'readwrite' });
    await openRoot(handle);
  } catch (err) {
    if (err.name !== 'AbortError') toast(err.message, 8000);
  }
}

async function init() {
  board = new Board($('viewport'), $('world'), $('overlay'), {
    onBeforeChange: beginChange,
    onChange: commitChange,
    onRemove: ids => {
      state.data.items = state.data.items.filter(i => !ids.has(i.id));
      commitChange();
    },
    onViewChange: view => {
      if (!state.data) return;
      activeTab().view = { ...view };
      scheduleSave();
    },
    onViewApplied: view => { $('zoom-label').textContent = `${Math.round(view.scale * 100)} %`; },
    onDropImage: (path, x, y) => placeImage(path, x, y),
    onCreateFrame: area => addFrame(area),
    onFrameAround: () => frameAroundSelection(),
    onToolChange: tool => $('btn-frame')?.classList.toggle('active', tool === 'frame'),
    onDropHandles: (handles, x, y) => dropHandles(handles, x, y).catch(err => toast(err.message, 8000)),
    getImageUrl: imageUrlFor,
  });

  $('btn-pick-root').addEventListener('click', pickRoot);
  $('btn-change-root').addEventListener('click', pickRoot);
  $('btn-add-tab').addEventListener('click', addTab);
  $('btn-frame').addEventListener('click', () => board.setTool(board.tool === 'frame' ? null : 'frame'));
  $('btn-rescan').addEventListener('click', () => rescan().then(r => {
    if (!r.added.length) toast('Keine neuen Bilder.');
  }));
  $('filter-new').addEventListener('change', e => { state.filter.onlyNew = e.target.checked; renderImageList(); });
  $('filter-day').addEventListener('change', e => { state.filter.day = e.target.value; renderImageList(); });
  $('btn-seen').addEventListener('click', markAllSeen);
  $('opt-suggest').addEventListener('change', e => setDateSuggestions(e.target.checked));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') rescanSoon(); });
  window.addEventListener('focus', () => rescanSoon());
  setInterval(() => { if (state.projectDir && !$('app').hidden) rescan().catch(() => {}); }, RESCAN_EVERY_MS);

  $('btn-back').addEventListener('click', async () => {
    await flushAll();
    if (state.observer) { try { state.observer.disconnect(); } catch { /* egal */ } state.observer = null; }
    releaseImages();
    state.projectName = null;
    state.projectDir = null;
    show('projects');
  });

  if (!supportsFolders()) {
    $('start-unsupported').hidden = false;
    $('btn-pick-root').disabled = true;
  } else {
    const remembered = await recallRoot();
    if (remembered) {
      const btn = $('btn-reopen-root');
      btn.textContent = `Zuletzt genutzt: ${remembered.name}`;
      btn.hidden = false;
      btn.addEventListener('click', async () => {
        if (await hasPermission(remembered, true)) await openRoot(remembered);
        else toast('Kein Zugriff erlaubt. Bitte Ordner neu wählen.');
      });
    }
  }
  show('start');
  document.body.dataset.ready = '1';

  // Offline-Start: Service Worker cacht nur den App-Code (PFLICHTENHEFT 1).
  if ('serviceWorker' in navigator && !new URLSearchParams(location.search).has('nosw')) {
    navigator.serviceWorker.register('./sw.js').catch(err => console.warn('Service Worker', err));
  }
}

init();
