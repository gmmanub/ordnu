// ordnu – Steuerung: Startbildschirm, Projekte, Tabs, Seitenleiste, Speichern, Verlauf.

import { createTab, newId, DEFAULT_IMAGE_WIDTH, defaultCrop } from './model.js';
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
  scheduleSave();
}

function afterHistoryStep(res) {
  if (!res) return false;
  board.replaceItems(tabItems());
  markPlaced();
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
});

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
async function generateThumbsInBackground(project) {
  const queue = [...state.images.keys()];
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

// ---------- Seitenleiste ----------

function renderImageList() {
  const list = $('image-list');
  list.replaceChildren();
  for (const [path, entry] of state.images) {
    const li = document.createElement('li');
    li.dataset.path = path;
    li.title = path;
    li.draggable = true;
    const img = document.createElement('img');
    img.src = entry.thumb ? entry.thumb.url : BLANK;
    img.alt = '';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = entry.img.name;
    li.append(img, name);
    li.addEventListener('click', () => {
      const c = board.centerWorld();
      const n = tabItems().length % 8; // leicht versetzt, damit nichts exakt übereinander liegt
      placeImage(path, c.x + n * 24, c.y + n * 24);
    });
    li.addEventListener('dragstart', e => {
      e.dataTransfer.setData('application/x-ordnu-path', path);
      e.dataTransfer.effectAllowed = 'copy';
    });
    list.appendChild(li);
  }
  $('image-count').textContent = `${state.images.size}`;
  markPlaced();
}

function markPlaced() {
  if (!state.data) return;
  const onBoard = new Set(tabItems().filter(i => i.type === 'image').map(i => i.path));
  for (const li of $('image-list').children) li.classList.toggle('on-board', onBoard.has(li.dataset.path));
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

  const found = await scanImages(projectDir);
  for (const img of found) state.images.set(img.path, { img, thumb: null });

  $('project-name').textContent = name;
  setSaveState('');
  show('app');
  renderTabs();
  board.setContent(tabItems(), activeTab().view);
  renderImageList();
  generateThumbsInBackground(name);
  return { images: found.length };
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
    getImageUrl: imageUrlFor,
  });

  $('btn-pick-root').addEventListener('click', pickRoot);
  $('btn-change-root').addEventListener('click', pickRoot);
  $('btn-add-tab').addEventListener('click', addTab);
  $('btn-back').addEventListener('click', async () => {
    await flushAll();
    releaseImages();
    state.projectName = null;
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
