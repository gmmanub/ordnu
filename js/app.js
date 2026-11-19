// ordnu – Steuerung: Startbildschirm, Projekte, Tabs, Seitenleiste, Speichern.

import { createTab, newId, DEFAULT_IMAGE_WIDTH } from './model.js';
import {
  supportsFolders, rememberRoot, recallRoot, hasPermission, listProjects,
  loadProjectData, saveProjectData, scanImages, getThumbnail,
} from './files.js';
import { Board } from './board.js';

const $ = id => document.getElementById(id);
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
const SAVE_DELAY = 1000;          // ms nach letzter Änderung (PFLICHTENHEFT 1.2)
const ORIGINAL_ABOVE_PX = 600;    // ab dieser Bildschirmbreite wird das Original statt der Vorschau gezeigt
export const UNDO_STEPS = 200;    // Schritte Rückgängig (PFLICHTENHEFT 2, V1)

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
  past: [],   // Rückgängig-Verlauf (nur für die laufende Sitzung)
  future: [], // Wiederholen-Verlauf
};

let board;

// ---------- Hilfen ----------

function show(screen) {
  for (const id of ['start', 'projects', 'app']) $(id).hidden = id !== screen;
}

let toastTimer;
function toast(text, ms = 4000) {
  const t = $('toast');
  t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
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

window.addEventListener('beforeunload', e => {
  if (state.dirty) { flushSave(); e.preventDefault(); e.returnValue = ''; }
});

// ---------- Rückgängig / Wiederholen ----------
// Gemerkt wird der Inhalt (Tabs, Elemente, Tags), nicht die Ansicht (Zoom/Position).

function snapshot() {
  const d = state.data;
  return JSON.stringify({ tabs: d.tabs.map(t => ({ id: t.id, name: t.name })), items: d.items, tags: d.tags });
}

// Vor jeder Inhaltsänderung aufrufen.
function beforeChange() {
  state.past.push(snapshot());
  if (state.past.length > UNDO_STEPS) state.past.shift();
  state.future = [];
}

function restore(text) {
  const snap = JSON.parse(text);
  const views = new Map(state.data.tabs.map(t => [t.id, t.view]));
  state.data.tabs = snap.tabs.map(t => ({ ...t, view: views.get(t.id) || { x: 0, y: 0, scale: 1 } }));
  state.data.items = snap.items;
  state.data.tags = snap.tags;
  if (!state.data.tabs.some(t => t.id === state.data.activeTab)) state.data.activeTab = state.data.tabs[0].id;
  renderTabs();
  board.setContent(tabItems(), activeTab().view);
  markPlaced();
  scheduleSave();
}

export function undo() {
  if (!state.data || !state.past.length) return false;
  state.future.push(snapshot());
  restore(state.past.pop());
  return true;
}

export function redo() {
  if (!state.data || !state.future.length) return false;
  state.past.push(snapshot());
  restore(state.future.pop());
  return true;
}

window.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || e.target.closest('input, textarea')) return;
  const key = e.key.toLowerCase();
  if (key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if ((key === 'z' && e.shiftKey) || key === 'y') { e.preventDefault(); redo(); }
});

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

// Board fragt: welche Bildquelle bei dieser Bildschirmbreite?
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
  const h = t ? Math.round(w * t.height / t.width) : w;
  beforeChange();
  const item = {
    id: newId('img'), tab: state.data.activeTab, type: 'image', path,
    x: Math.round(centered ? x - w / 2 : x), y: Math.round(centered ? y - h / 2 : y), w, h,
  };
  state.data.items.push(item);
  board.items = tabItems();
  board.render();
  board.setSelection([item.id]);
  markPlaced();
  scheduleSave();
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
  const onBoard = new Set(tabItems().filter(i => i.type === 'image').map(i => i.path));
  for (const li of $('image-list').children) li.classList.toggle('on-board', onBoard.has(li.dataset.path));
  $('board-empty').hidden = tabItems().length > 0;
}

// ---------- Tabs ----------

function renderTabs() {
  const nav = $('tabs');
  nav.replaceChildren();
  for (const tab of state.data.tabs) {
    const b = document.createElement('button');
    b.className = 'tab' + (tab.id === state.data.activeTab ? ' active' : '');
    b.textContent = tab.name;
    b.title = 'Doppelklick: umbenennen';
    b.addEventListener('click', () => switchTab(tab.id));
    b.addEventListener('dblclick', () => renameTab(tab, b));
    nav.appendChild(b);
  }
}

function switchTab(id) {
  if (id === state.data.activeTab) return;
  state.data.activeTab = id;
  renderTabs();
  board.setContent(tabItems(), activeTab().view);
  markPlaced();
  scheduleSave();
}

function renameTab(tab, button) {
  const input = document.createElement('input');
  input.value = tab.name;
  button.replaceChildren(input);
  input.focus(); input.select();
  let done = false;
  const finish = commit => {
    if (done) return; done = true;
    const v = input.value.trim();
    if (commit && v && v !== tab.name) { beforeChange(); tab.name = v; scheduleSave(); }
    renderTabs();
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
    e.stopPropagation();
  });
  input.addEventListener('blur', () => finish(true));
}

function addTab() {
  beforeChange();
  const tab = createTab(`Board ${state.data.tabs.length + 1}`);
  state.data.tabs.push(tab);
  state.data.activeTab = null;
  switchTab(tab.id);
  const btn = $('tabs').lastElementChild;
  renameTab(tab, btn);
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
  await flushSave();
  releaseImages();
  const projectDir = await state.root.getDirectoryHandle(name);
  const { appDir, data, notice } = await loadProjectData(projectDir);
  Object.assign(state, { projectName: name, projectDir, appDir, data, dirty: false, past: [], future: [] });
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

function updateZoomLabel(view) {
  $('zoom-label').textContent = `${Math.round(view.scale * 100)} %`;
}

async function init() {
  board = new Board($('viewport'), $('world'), {
    onBeforeChange: beforeChange,
    onChange: () => { markPlaced(); scheduleSave(); },
    onRemove: ids => {
      state.data.items = state.data.items.filter(i => !ids.has(i.id));
      markPlaced(); scheduleSave();
    },
    onViewChange: view => {
      if (!state.data) return;
      activeTab().view = { ...view };
      updateZoomLabel(view);
      scheduleSave();
    },
    onDropImage: (path, x, y) => placeImage(path, x, y),
    getImageUrl: imageUrlFor,
  });
  const origApply = board.applyView.bind(board);
  board.applyView = () => { origApply(); updateZoomLabel(board.view); };

  $('btn-pick-root').addEventListener('click', pickRoot);
  $('btn-change-root').addEventListener('click', pickRoot);
  $('btn-add-tab').addEventListener('click', addTab);
  $('btn-back').addEventListener('click', async () => {
    await flushSave();
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
