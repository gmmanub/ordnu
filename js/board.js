// Unendliche Fläche: Verschieben, Zoomen, Auswahl, Skalieren, Ausschnitt/Bildtransform.

import {
  zoomAt, screenToWorld, fitView, boundsOf, intersects, scaleGroup,
  imageRect, setImageRect, setWindow, resetCrop, rotate, normalizeAngle, MIN_SIZE,
  FRAME_COLORS, FRAME_DEFAULT, frameHex, frameContents, drawOrder, contains,
  NOTE_COLORS, TEXT_COLORS, FONT_SIZES, colorHex, ZOOM_MAX,
} from './model.js';

const ROT_HANDLE_PX = 34;  // Abstand des Dreh-Anfassers über dem Bild (Bildschirm-Pixel)
const SNAP_DEG = 15;       // Umschalt beim Drehen
const EDGE_PX = 8;         // so nah (Bildschirm-Pixel) am Rahmenrand gilt ein Klick als „auf den Rahmen“
const VIEW_ANIM_MS = 250;  // Dauer der Ansichtssprünge (A, F, 0)
const FIT_SEL_MAX = 4;     // F zoomt höchstens auf 400 %
const isNote = i => i.type === 'note' || i.type === 'text';

export class Board {
  constructor(viewport, world, overlay, cb) {
    this.viewport = viewport;
    this.world = world;
    this.overlay = overlay;             // Anfasser, Auswahlrahmen (Bildschirm-Koordinaten)
    this.cb = cb;                       // onBeforeChange, onChange, onRemove, onViewChange, onDropImage, getImageUrl
    this.view = { x: 0, y: 0, scale: 1 };
    this.items = [];
    this.selected = new Set();
    this.nodes = new Map();
    this.cropId = null;                 // Element im Ausschnitt-Modus
    this.ghost = null;
    this.tool = null;                   // 'frame' = nächstes Ziehen legt einen Rahmen an
    this.renaming = null;               // { id, input } – Rahmen-Name wird bearbeitet
    this.editing = null;                // { id, ta, isNew } – Notiz/Text wird bearbeitet
    this.anim = null;                   // laufender Ansichtssprung
    this.spaceDown = false;
    this.bind();
  }

  setContent(items, view) {
    this.cropId = null;
    this.renaming = null;
    this.editing?.ta.remove();
    this.editing = null;
    this.stopAnim();
    this.setTool(null);
    this.items = items;
    this.view = { ...view };
    this.selected.clear();
    this.world.replaceChildren();
    this.nodes.clear();
    this.ghost = null;
    this.render();
  }

  // Inhalt ersetzen, Ansicht und (soweit noch vorhanden) Auswahl behalten – z. B. nach Rückgängig.
  replaceItems(items) {
    this.items = items;
    const ids = new Set(items.map(i => i.id));
    this.selected = new Set([...this.selected].filter(id => ids.has(id)));
    if (this.cropId && !ids.has(this.cropId)) this.cropId = null;
    if (this.editing && !ids.has(this.editing.id)) { this.editing.ta.remove(); this.editing = null; }
    this.render();
  }

  byId(id) { return this.items.find(i => i.id === id); }

  // Oberstes Element an einem Board-Punkt (Rahmen zählen nicht – deren Inneres ist frei klickbar).
  hitTest(p) {
    const order = drawOrder(this.items);
    for (let n = order.length - 1; n >= 0; n--) {
      const i = order[n];
      if (i.type === 'frame') continue;
      if (p.x >= i.x && p.x <= i.x + i.w && p.y >= i.y && p.y <= i.y + i.h) return i;
    }
    return null;
  }

  // Rahmen, dessen Rand nahe am Punkt liegt (kleinere/vordere zuerst).
  frameEdgeAt(p) {
    const tol = EDGE_PX / this.view.scale;
    const frames = drawOrder(this.items).filter(i => i.type === 'frame').reverse();
    for (const f of frames) {
      const outer = p.x >= f.x - tol && p.x <= f.x + f.w + tol && p.y >= f.y - tol && p.y <= f.y + f.h + tol;
      const inner = p.x > f.x + tol && p.x < f.x + f.w - tol && p.y > f.y + tol && p.y < f.y + f.h - tol;
      if (outer && !inner) return f;
    }
    return null;
  }

  // Rahmen, dessen Beschriftung unter dem Bildschirmpunkt liegt.
  frameLabelAt(clientX, clientY) {
    for (const f of drawOrder(this.items).filter(i => i.type === 'frame').reverse()) {
      const lbl = this.nodes.get(f.id)?.querySelector('.frame-label');
      if (!lbl) continue;
      const r = lbl.getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) return f;
    }
    return null;
  }

  setTool(tool) {
    this.tool = tool;
    this.viewport.classList.toggle('tool-frame', tool === 'frame');
    this.viewport.classList.toggle('tool-note', tool === 'note' || tool === 'text');
    this.cb.onToolChange?.(tool);
  }
  selectedItems() { return this.items.filter(i => this.selected.has(i.id)); }

  toScreen(x, y) {
    return { x: x * this.view.scale + this.view.x, y: y * this.view.scale + this.view.y };
  }

  pointerWorld(e) {
    const r = this.viewport.getBoundingClientRect();
    return screenToWorld(this.view, e.clientX - r.left, e.clientY - r.top);
  }

  // ---------- Darstellung ----------

  applyView() {
    const { x, y, scale } = this.view;
    this.world.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    this.world.style.setProperty('--inv', String(1 / scale)); // Rahmenlinien/Beschriftung gleich groß auf dem Bildschirm
    const g = 24 * scale;
    this.viewport.style.backgroundSize = `${g}px ${g}px`;
    this.viewport.style.backgroundPosition = `${x}px ${y}px`;
    this.refreshSources();
    this.renderOverlay();
    this.cb.onViewApplied?.(this.view);
  }

  render() {
    const alive = new Set();
    for (const item of drawOrder(this.items)) {
      alive.add(item.id);
      let node = this.nodes.get(item.id);
      if (!node) {
        node = document.createElement('div');
        node.className = `item ${item.type}`;
        node.dataset.id = item.id;
        this.nodes.set(item.id, node);
      }
      this.world.appendChild(node); // Reihenfolge = Stapelreihenfolge
      this.layoutNode(item, node);
      node.classList.toggle('selected', this.selected.has(item.id));
      node.classList.toggle('cropping', this.cropId === item.id);
    }
    for (const [id, node] of this.nodes) {
      if (!alive.has(id)) { node.remove(); this.nodes.delete(id); }
    }
    this.applyView();
  }

  layoutNode(item, node = this.nodes.get(item.id)) {
    if (!node) return;
    node.style.left = `${item.x}px`;
    node.style.top = `${item.y}px`;
    node.style.width = `${item.w}px`;
    node.style.height = `${item.h}px`;
    if (item.type === 'frame') {
      node.style.setProperty('--fc', frameHex(item.color));
      let lbl = node.querySelector('.frame-label');
      if (!lbl) { lbl = Object.assign(document.createElement('div'), { className: 'frame-label' }); node.appendChild(lbl); }
      lbl.textContent = item.name || 'Rahmen';
      lbl.classList.toggle('editing', this.renaming?.id === item.id);
      return;
    }
    if (isNote(item)) return this.layoutNote(item, node);
    const img = node.querySelector('img');
    if (img && item.type === 'image') this.layoutImg(item, img, item.x, item.y);
    if (this.cropId === item.id && this.ghost) this.layoutImg(item, this.ghost, 0, 0);
  }

  // Bild innerhalb eines Elternelements platzieren, dessen Ursprung bei (ox, oy) in Board-Koordinaten liegt.
  layoutImg(item, img, ox, oy) {
    const r = imageRect(item);
    img.style.width = `${r.w}px`;
    img.style.height = `${r.h}px`;
    img.style.left = `${r.cx - r.w / 2 - ox}px`;
    img.style.top = `${r.cy - r.h / 2 - oy}px`;
    img.style.transform = r.rot ? `rotate(${r.rot}deg)` : '';
  }

  layoutNote(item, node) {
    if (item.type === 'note') node.style.setProperty('--bg', colorHex(NOTE_COLORS, item.bg));
    node.style.setProperty('--tc', colorHex(TEXT_COLORS, item.color));
    node.style.fontSize = `${item.fontSize}px`;
    let body = node.querySelector('.note-body');
    if (!body) { body = Object.assign(document.createElement('div'), { className: 'note-body' }); node.prepend(body); }
    body.textContent = item.text; // nur reiner Text – nie als HTML
    const editing = this.editing?.id === item.id;
    body.hidden = editing;
    node.classList.toggle('empty', !item.text && !editing);
    if (editing && this.editing.ta.parentNode !== node) node.appendChild(this.editing.ta);
  }

  // Höhe an den Text anpassen: freier Text immer genau, Zettel wachsen nur mit.
  autosize(item) {
    const node = this.nodes.get(item.id);
    if (!node || !isNote(item)) return;
    const oldH = node.style.height;
    node.style.height = 'auto';
    const el = this.editing?.id === item.id ? this.editing.ta : node.querySelector('.note-body');
    let need = node.offsetHeight;
    if (el && el.scrollHeight > need) need = el.scrollHeight;
    node.style.height = oldH;
    need = Math.ceil(need);
    item.h = item.type === 'text' ? Math.max(item.fontSize * 1.4, need) : Math.max(item.h, need);
    this.layoutNode(item, node);
  }

  // Text bearbeiten: Textfeld direkt im Element (zoomt mit). Esc oder Klick daneben beendet, Enter = neue Zeile.
  startEdit(id, { isNew = false } = {}) {
    const item = this.byId(id);
    if (!item || !isNote(item)) return;
    this.finishEdit();
    const ta = document.createElement('textarea');
    ta.className = 'note-edit';
    ta.value = item.text;
    ta.spellcheck = false;
    this.editing = { id, ta, isNew };
    let done = false;
    const end = () => { if (!done) { done = true; this.finishEdit(); } };
    ta.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); end(); }
    });
    ta.addEventListener('input', () => { if (item.type === 'text') this.autosizeLive(item); });
    ta.addEventListener('blur', end);
    ta.addEventListener('pointerdown', e => e.stopPropagation());
    this.setSelection([id]);
    this.layoutNode(item);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  autosizeLive(item) {
    const ta = this.editing?.ta;
    if (!ta) return;
    ta.style.height = 'auto';
    const need = Math.max(item.fontSize * 1.4, ta.scrollHeight);
    ta.style.height = '';
    if (need > item.h) { item.h = Math.ceil(need); this.layoutNode(item); this.renderOverlay(); }
  }

  finishEdit() {
    const ed = this.editing;
    if (!ed) return;
    this.editing = null;
    const item = this.byId(ed.id);
    const text = ed.ta.value.replace(/\s+$/, '');
    ed.ta.remove();
    if (!item) return;
    if (ed.isNew) {
      // Anlegen + erster Text = ein Rückgängig-Schritt. Leerer freier Text wird wieder verworfen.
      if (item.type === 'text' && !text.trim()) {
        this.items = this.items.filter(i => i.id !== item.id);
        this.selected.delete(item.id);
        this.render();
        this.cb.onDiscardNew?.(item.id);
        this.viewport.focus();
        return;
      }
      item.text = text;
      this.layoutNode(item);
      this.autosize(item);
      this.cb.onChange();
    } else if (text !== item.text) {
      this.cb.onBeforeChange();
      item.text = text;
      this.layoutNode(item);
      this.autosize(item);
      this.cb.onChange();
    } else {
      this.layoutNode(item);
      if (item.type === 'text') { this.cb.onBeforeChange(); this.autosize(item); this.cb.onChange(); }
    }
    this.renderOverlay();
    this.viewport.focus();
  }

  // Farbe/Textfarbe/Größe für alle ausgewählten Notizen/Texte.
  setNoteStyle(field, value) {
    const notes = this.selectedItems().filter(i => isNote(i) && (field !== 'bg' || i.type === 'note'));
    if (!notes.length || notes.every(n => n[field] === value)) return;
    this.cb.onBeforeChange();
    for (const n of notes) {
      n[field] = value;
      this.layoutNode(n);
      if (field === 'fontSize') this.autosize(n);
    }
    this.renderOverlay();
    this.cb.onChange();
  }

  // Bildquelle je nach Bildschirmgröße wählen (Vorschau oder Original), inkl. Ausschnitt-Vergrößerung.
  refreshSources() {
    for (const item of this.items) {
      if (item.type !== 'image') continue;
      const node = this.nodes.get(item.id);
      if (!node) continue;
      const src = this.cb.getImageUrl(item.path, imageRect(item).w * this.view.scale);
      if (!src) {
        if (!node.querySelector('.missing')) {
          node.replaceChildren(Object.assign(document.createElement('div'),
            { className: 'missing', textContent: `Datei fehlt:\n${item.path}` }));
        }
        continue;
      }
      let img = node.querySelector('img');
      if (!img) {
        img = document.createElement('img'); img.draggable = false; img.alt = '';
        node.replaceChildren(img);
        this.layoutImg(item, img, item.x, item.y);
      }
      if (img.getAttribute('src') !== src.url) img.src = src.url;
      if (this.ghost && this.cropId === item.id && this.ghost.getAttribute('src') !== src.url) this.ghost.src = src.url;
    }
  }

  setSelection(ids) {
    this.selected = new Set(ids);
    for (const [id, node] of this.nodes) node.classList.toggle('selected', this.selected.has(id));
    this.renderOverlay();
  }

  // ---------- Ansichtssprünge (A, F, 0) – sanft animiert, keine Rückgängig-Schritte ----------

  animateTo(target) {
    this.stopAnim();
    const from = { ...this.view };
    const t0 = performance.now();
    const ease = t => 1 - Math.pow(1 - t, 3);
    const step = now => {
      const t = Math.min(1, (now - t0) / VIEW_ANIM_MS);
      const k = ease(t);
      // Skalierung logarithmisch überblenden, Position so, dass der Bildmittelpunkt gleichmäßig wandert
      const scale = Math.exp(Math.log(from.scale) + (Math.log(target.scale) - Math.log(from.scale)) * k);
      const r = this.viewport.getBoundingClientRect();
      const c0 = screenToWorld(from, r.width / 2, r.height / 2), c1 = screenToWorld(target, r.width / 2, r.height / 2);
      const cx = c0.x + (c1.x - c0.x) * k, cy = c0.y + (c1.y - c0.y) * k;
      this.view = { x: r.width / 2 - cx * scale, y: r.height / 2 - cy * scale, scale };
      if (t >= 1) { this.view = { ...target }; this.anim = null; }
      this.applyView();
      if (this.anim) this.anim = requestAnimationFrame(step);
      else this.cb.onViewChange(this.view);
    };
    this.anim = requestAnimationFrame(step);
  }

  stopAnim() {
    if (this.anim) { cancelAnimationFrame(this.anim); this.anim = null; this.cb.onViewChange?.(this.view); }
  }

  // A = alles zeigen
  fitAll() {
    const r = this.viewport.getBoundingClientRect();
    this.animateTo(fitView(this.items, r.width, r.height));
  }

  // F = auf die Auswahl einpassen; ohne Auswahl wie A
  fitSelection() {
    const sel = this.selectedItems();
    if (!sel.length) return this.fitAll();
    const r = this.viewport.getBoundingClientRect();
    this.animateTo(fitView(sel, r.width, r.height, 60, Math.min(FIT_SEL_MAX, ZOOM_MAX)));
  }

  // 0 = Zoom 100 %, Bildmitte bleibt
  resetZoom() {
    const r = this.viewport.getBoundingClientRect();
    const c = screenToWorld(this.view, r.width / 2, r.height / 2);
    this.animateTo({ x: r.width / 2 - c.x, y: r.height / 2 - c.y, scale: 1 });
  }

  centerWorld() {
    const r = this.viewport.getBoundingClientRect();
    return screenToWorld(this.view, r.width / 2, r.height / 2);
  }

  // ---------- Overlay: Anfasser, Mülleimer, Ausschnitt-Werkzeuge ----------

  renderOverlay() {
    const o = this.overlay;
    o.replaceChildren();
    if (this.cropId) return this.renderCropOverlay();
    const sel = this.selectedItems();
    if (!sel.length) return this.placeRenameInput();
    const b = boundsOf(sel);
    const p1 = this.toScreen(b.x, b.y), p2 = this.toScreen(b.x + b.w, b.y + b.h);
    o.appendChild(box('sel-box', p1.x, p1.y, p2.x - p1.x, p2.y - p1.y));
    for (const [name, x, y] of [['nw', p1.x, p1.y], ['ne', p2.x, p1.y], ['sw', p1.x, p2.y], ['se', p2.x, p2.y]]) {
      o.appendChild(handle(`scale-${name}`, x, y, `handle corner ${name}`));
    }
    // Auswahl-Leiste unter der Auswahl: Rahmen um Auswahl, Farben (bei Rahmen), Mülleimer
    const bar = document.createElement('div');
    bar.className = 'sel-bar overlay-ui';
    bar.style.left = `${p1.x}px`; bar.style.top = `${p2.y + 10}px`;
    const around = uiButton('▢ Rahmen um Auswahl', 'Rahmen um die Auswahl legen (Strg+G)', () => this.cb.onFrameAround?.());
    around.classList.add('frame-around');
    bar.appendChild(around);
    if (sel.some(i => i.type === 'frame')) {
      for (const c of FRAME_COLORS) {
        const dot = uiButton('', `Farbe: ${c.label}`, () => this.setFrameColor(c.key));
        dot.className = 'overlay-ui color-dot';
        dot.dataset.color = c.key;
        dot.style.setProperty('--dot', c.hex);
        bar.appendChild(dot);
      }
    }
    if (sel.some(isNote)) bar.appendChild(this.noteControls(sel));
    const trash = uiButton('🗑', 'Vom Board entfernen (Entf) – Dateien und Rahmeninhalt bleiben erhalten', () => this.removeSelected());
    trash.classList.add('trash');
    bar.appendChild(trash);
    o.appendChild(bar);
    this.placeRenameInput();
  }

  // Auswahl-Leiste für Notizen/Text: Hintergrund (nur Zettel), Textfarbe, Schriftgröße.
  noteControls(sel) {
    const wrap = document.createElement('div');
    wrap.className = 'note-controls';
    const group = (title, cls) => {
      const g = document.createElement('div');
      g.className = `ctl-group ${cls}`;
      g.appendChild(Object.assign(document.createElement('span'), { className: 'ctl-title', textContent: title }));
      wrap.appendChild(g);
      return g;
    };
    const dots = (g, list, field) => {
      for (const c of list) {
        const dot = uiButton('', c.label, () => this.setNoteStyle(field, c.key));
        dot.className = 'overlay-ui color-dot';
        dot.dataset[field === 'bg' ? 'bg' : 'tc'] = c.key;
        dot.style.setProperty('--dot', c.hex);
        if (sel.every(i => !isNote(i) || (field === 'bg' && i.type !== 'note') || i[field] === c.key)) dot.classList.add('on');
        g.appendChild(dot);
      }
    };
    if (sel.some(i => i.type === 'note')) dots(group('Zettel', 'bg'), NOTE_COLORS, 'bg');
    dots(group('Text', 'tc'), TEXT_COLORS, 'color');
    const g = group('Größe', 'fs');
    for (const f of FONT_SIZES) {
      const b = uiButton(f.key, `Schriftgröße ${f.key}`, () => this.setNoteStyle('fontSize', f.size));
      b.dataset.fs = f.key;
      if (sel.filter(isNote).every(i => i.fontSize === f.size)) b.classList.add('on');
      g.appendChild(b);
    }
    return wrap;
  }

  // ---------- Rahmen ----------

  setFrameColor(key) {
    const frames = this.selectedItems().filter(i => i.type === 'frame');
    if (!frames.length || frames.every(f => f.color === key)) return;
    this.cb.onBeforeChange();
    frames.forEach(f => { f.color = key; this.layoutNode(f); });
    this.cb.onChange();
  }

  // Name bearbeiten: Eingabefeld über der Beschriftung (Enter = übernehmen, Esc = abbrechen).
  startRename(id) {
    const f = this.byId(id);
    if (!f || f.type !== 'frame') return;
    this.finishRename(true);
    const input = document.createElement('input');
    input.className = 'frame-rename overlay-ui';
    input.value = f.name || '';
    input.style.setProperty('--fc', frameHex(f.color));
    this.renaming = { id, input };
    let done = false;
    const end = commit => { if (!done) { done = true; this.finishRename(commit); } };
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); end(true); }
      if (e.key === 'Escape') { e.preventDefault(); end(false); }
    });
    input.addEventListener('blur', () => end(true));
    input.addEventListener('pointerdown', e => e.stopPropagation());
    this.layoutNode(f);
    this.renderOverlay();
    input.focus(); input.select();
  }

  finishRename(commit) {
    const r = this.renaming;
    if (!r) return;
    this.renaming = null;
    const f = this.byId(r.id);
    const v = r.input.value.trim();
    r.input.remove();
    if (f && commit && v && v !== f.name) {
      this.cb.onBeforeChange();
      f.name = v;
      this.cb.onChange();
    }
    if (f) this.layoutNode(f);
    this.viewport.focus();
  }

  placeRenameInput() {
    const r = this.renaming;
    if (!r) return;
    const f = this.byId(r.id);
    if (!f) { this.renaming = null; return; }
    const p = this.toScreen(f.x, f.y);
    r.input.style.left = `${p.x}px`;
    r.input.style.top = `${p.y - 30}px`;
    // eigenes Element im Board (nicht im Overlay), damit Neuzeichnen das Eingabefeld nicht verliert
    if (r.input.parentNode !== this.viewport) this.viewport.appendChild(r.input);
  }

  renderCropOverlay() {
    const o = this.overlay;
    const item = this.byId(this.cropId);
    if (!item) return;
    const p1 = this.toScreen(item.x, item.y), p2 = this.toScreen(item.x + item.w, item.y + item.h);
    o.appendChild(box('crop-box', p1.x, p1.y, p2.x - p1.x, p2.y - p1.y));
    const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
    for (const [name, x, y] of [['nw', p1.x, p1.y], ['n', mx, p1.y], ['ne', p2.x, p1.y], ['e', p2.x, my],
      ['se', p2.x, p2.y], ['s', mx, p2.y], ['sw', p1.x, p2.y], ['w', p1.x, my]]) {
      o.appendChild(handle(`win-${name}`, x, y, `handle win ${name}`));
    }
    // Bild-Anfasser (an den gedrehten Bildecken) und Dreh-Anfasser
    const r = imageRect(item);
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const d = rotate(sx * r.w / 2, sy * r.h / 2, r.rot);
      const p = this.toScreen(r.cx + d.x, r.cy + d.y);
      o.appendChild(handle('img-scale', p.x, p.y, 'handle img'));
    }
    const top = rotate(0, -r.h / 2, r.rot);
    const pt = this.toScreen(r.cx + top.x, r.cy + top.y);
    const dir = rotate(0, -1, r.rot);
    const pr = { x: pt.x + dir.x * ROT_HANDLE_PX, y: pt.y + dir.y * ROT_HANDLE_PX };
    const stem = document.createElement('div');
    stem.className = 'rot-stem';
    stem.style.left = `${pt.x}px`; stem.style.top = `${pt.y}px`;
    stem.style.height = `${ROT_HANDLE_PX}px`;
    stem.style.transform = `rotate(${r.rot + 180}deg)`;
    o.appendChild(stem);
    o.appendChild(handle('img-rotate', pr.x, pr.y, 'handle rot'));

    const bar = document.createElement('div');
    bar.className = 'crop-bar overlay-ui';
    bar.style.left = `${p1.x}px`; bar.style.top = `${Math.max(4, p1.y - 44)}px`;
    bar.append(
      Object.assign(document.createElement('span'), { className: 'crop-title', textContent: 'Ausschnitt' }),
      uiButton('90°', 'Bild um 90° drehen', () => this.cropAction(it => {
        const ir = imageRect(it); ir.rot = normalizeAngle(ir.rot + 90); setImageRect(it, ir);
      })),
      uiButton('Zurücksetzen', 'Ganzes Bild, ohne Drehung', () => this.cropAction(it => resetCrop(it))),
      uiButton('Fertig', 'Ausschnitt-Modus beenden (Esc)', () => this.exitCrop()),
    );
    bar.dataset.ui = 'crop-bar';
    o.appendChild(bar);
  }

  cropAction(fn) {
    const item = this.byId(this.cropId);
    if (!item) return;
    this.cb.onBeforeChange();
    fn(item);
    this.layoutNode(item);
    this.refreshSources();
    this.renderOverlay();
    this.cb.onChange();
  }

  enterCrop(id) {
    const item = this.byId(id);
    if (!item || item.type !== 'image' || !this.nodes.get(id)?.querySelector('img')) return;
    this.cropId = id;
    this.setSelection([id]);
    this.ghost = document.createElement('img');
    this.ghost.className = 'crop-ghost';
    this.ghost.draggable = false; this.ghost.alt = '';
    this.world.appendChild(this.ghost);
    this.render();
  }

  exitCrop() {
    if (!this.cropId) return;
    this.cropId = null;
    this.ghost?.remove();
    this.ghost = null;
    this.render();
  }

  // ---------- Bedienung ----------

  bind() {
    const vp = this.viewport;

    vp.addEventListener('wheel', e => {
      e.preventDefault();
      this.stopAnim();
      const r = vp.getBoundingClientRect();
      const speed = e.ctrlKey ? 0.01 : 0.0015; // ctrlKey = Touchpad-Pinch
      this.view = zoomAt(this.view, Math.exp(-e.deltaY * speed), e.clientX - r.left, e.clientY - r.top);
      this.applyView();
      this.cb.onViewChange(this.view);
    }, { passive: false });

    vp.addEventListener('contextmenu', e => e.preventDefault());

    vp.addEventListener('pointerdown', e => {
      if (e.target.closest('textarea.note-edit')) return; // Text markieren im Textfeld
      this.stopAnim();
      if (!e.target.closest('input, textarea')) vp.focus();
      const wantsPan = e.button === 1 || e.button === 2 || (e.button === 0 && this.spaceDown);
      if (wantsPan) return this.startPan(e);
      if (e.button !== 0) return;
      const h = e.target.closest('[data-handle]');
      if (h) return this.startHandle(e, h.dataset.handle);
      if (e.target.closest('.overlay-ui')) return; // Knöpfe reagieren auf click
      const itemNode = e.target.closest('.item');
      if (this.cropId) {
        if ((itemNode && itemNode.dataset.id === this.cropId) || e.target === this.ghost) return this.startCropMove(e);
        this.exitCrop();
        return;
      }
      if (this.tool === 'frame') return this.startFrameDraw(e);
      if (this.tool === 'note' || this.tool === 'text') {
        e.preventDefault();
        const tool = this.tool;
        this.setTool(null);
        return this.cb.onCreateNote?.(tool, this.pointerWorld(e));
      }
      const label = e.target.closest('.frame-label');
      if (label) return this.startMove(e, label.parentNode.dataset.id);
      if (itemNode && !itemNode.classList.contains('frame')) return this.startMove(e, itemNode.dataset.id);
      const edge = this.frameEdgeAt(this.pointerWorld(e));
      if (edge) return this.startMove(e, edge.id);
      this.startMarquee(e);
    });

    // Ziel über die Position bestimmen (wegen Zeiger-Erfassung ist e.target hier das Board).
    vp.addEventListener('dblclick', e => {
      if (this.cropId || this.tool) return;
      const p = this.pointerWorld(e);
      const hit = this.hitTest(p);
      if (hit && isNote(hit)) return this.startEdit(hit.id);
      if (hit) return this.enterCrop(hit.id);
      const frame = this.frameLabelAt(e.clientX, e.clientY) || this.frameEdgeAt(p);
      if (frame) this.startRename(frame.id);
    });

    window.addEventListener('keydown', e => {
      if (e.target.closest('input, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
      if (document.querySelector('.modal:not([hidden])')) return;
      if (e.code === 'Space') { this.spaceDown = true; vp.classList.add('space'); e.preventDefault(); }
      if (e.key === 'Escape' && this.tool) { e.preventDefault(); this.setTool(null); return; }
      if (e.key === 'Escape' || (e.key === 'Enter' && this.cropId)) { e.preventDefault(); this.exitCrop(); }
      if ($app().hidden) return;
      const k = e.key.toLowerCase();
      if (k === 'a' && !this.cropId) this.fitAll();
      if (k === 'f' && !this.cropId) this.fitSelection();
      if (e.key === '0') this.resetZoom();
      if (!this.cropId) {
        if (k === 'r') this.setTool(this.tool === 'frame' ? null : 'frame');
        if (k === 'n') this.setTool(this.tool === 'note' ? null : 'note');
        if (k === 't') this.setTool(this.tool === 'text' ? null : 'text');
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !this.cropId) this.removeSelected();
    });
    window.addEventListener('keyup', e => {
      if (e.code === 'Space') { this.spaceDown = false; vp.classList.remove('space'); }
    });

    vp.addEventListener('dragover', e => {
      const types = e.dataTransfer.types;
      if (types.includes('application/x-ordnu-path') || types.includes('Files')) {
        e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
      }
    });
    vp.addEventListener('drop', e => {
      const p = this.pointerWorld(e);
      const path = e.dataTransfer.getData('application/x-ordnu-path');
      if (path) { e.preventDefault(); this.cb.onDropImage(path, p.x, p.y); return; }
      // Ordner/Dateien aus dem Explorer: Handles müssen sofort (noch im Ereignis) angefordert werden.
      const items = [...e.dataTransfer.items].filter(i => i.kind === 'file');
      if (!items.length) return;
      e.preventDefault();
      const handles = items.map(i => (typeof i.getAsFileSystemHandle === 'function' ? i.getAsFileSystemHandle() : null));
      this.cb.onDropHandles(handles, p.x, p.y);
    });

    new ResizeObserver(() => this.applyView()).observe(vp);
  }

  // Gemeinsamer Ablauf für Zieh-Gesten: move(ev) während, end(changed) danach.
  drag(e, move, end) {
    e.preventDefault();
    const vp = this.viewport;
    vp.setPointerCapture(e.pointerId);
    const onMove = ev => move(ev);
    const onUp = ev => {
      vp.removeEventListener('pointermove', onMove);
      vp.removeEventListener('pointerup', onUp);
      vp.removeEventListener('pointercancel', onUp);
      end?.(ev);
    };
    vp.addEventListener('pointermove', onMove);
    vp.addEventListener('pointerup', onUp);
    vp.addEventListener('pointercancel', onUp);
  }

  startPan(e) {
    this.viewport.classList.add('panning');
    const sx = e.clientX, sy = e.clientY, ox = this.view.x, oy = this.view.y;
    this.drag(e, ev => {
      this.view = { ...this.view, x: ox + ev.clientX - sx, y: oy + ev.clientY - sy };
      this.applyView();
    }, () => {
      this.viewport.classList.remove('panning');
      this.cb.onViewChange(this.view);
    });
  }

  startMove(e, id) {
    if (e.shiftKey) {
      e.preventDefault();
      const next = new Set(this.selected);
      next.has(id) ? next.delete(id) : next.add(id);
      this.setSelection(next);
      return;
    }
    if (!this.selected.has(id)) this.setSelection([id]);
    // Rahmen nehmen ihren Inhalt mit (Stand bei Beginn des Ziehens, auch verschachtelt).
    const moving = new Set(this.selectedItems());
    for (const f of this.selectedItems()) if (f.type === 'frame') frameContents(f, this.items).forEach(i => moving.add(i));
    const start = [...moving].map(i => ({ i, x: i.x, y: i.y }));
    const sx = e.clientX, sy = e.clientY;
    let moved = false;
    this.drag(e, ev => {
      const dx = (ev.clientX - sx) / this.view.scale, dy = (ev.clientY - sy) / this.view.scale;
      if (!moved && Math.abs(dx) + Math.abs(dy) > 0) { moved = true; this.cb.onBeforeChange(); }
      for (const s of start) { s.i.x = s.x + dx; s.i.y = s.y + dy; this.layoutNode(s.i); }
      this.renderOverlay();
    }, () => { if (moved) this.cb.onChange(); });
  }

  // Auswahlrahmen auf leerer Fläche; Umschalt = hinzufügen. Klick ohne Ziehen = Auswahl aufheben.
  startMarquee(e) {
    const base = e.shiftKey ? new Set(this.selected) : new Set();
    const r = this.viewport.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const w0 = screenToWorld(this.view, sx, sy);
    let rect = null;
    this.drag(e, ev => {
      const cx = ev.clientX - r.left, cy = ev.clientY - r.top;
      if (!rect && Math.abs(cx - sx) + Math.abs(cy - sy) < 4) return;
      if (!rect) { rect = document.createElement('div'); rect.className = 'marquee'; }
      Object.assign(rect.style, {
        left: `${Math.min(sx, cx)}px`, top: `${Math.min(sy, cy)}px`,
        width: `${Math.abs(cx - sx)}px`, height: `${Math.abs(cy - sy)}px`,
      });
      const w1 = screenToWorld(this.view, cx, cy);
      const area = { x: Math.min(w0.x, w1.x), y: Math.min(w0.y, w1.y), w: Math.abs(w1.x - w0.x), h: Math.abs(w1.y - w0.y) };
      const ids = new Set(base);
      for (const it of this.items) {
        if (it.type === 'frame' ? contains(area, it) : intersects(area, it)) ids.add(it.id);
      }
      this.setSelection(ids);
      this.overlay.appendChild(rect);
    }, () => {
      rect?.remove();
      if (!rect) this.setSelection(base);
    });
  }

  startHandle(e, name) {
    if (name.startsWith('scale-')) return this.startScale(e, name.slice(6));
    if (name.startsWith('win-')) return this.startWindow(e, name.slice(4));
    if (name === 'img-scale') return this.startImgScale(e);
    if (name === 'img-rotate') return this.startImgRotate(e);
  }

  // Gruppe an einer Ecke skalieren; Anker = gegenüberliegende Ecke.
  startScale(e, corner) {
    const sel = this.selectedItems();
    const b = boundsOf(sel);
    const ax = corner.includes('w') ? b.x + b.w : b.x;
    const ay = corner.includes('n') ? b.y + b.h : b.y;
    const cx = corner.includes('w') ? b.x : b.x + b.w;
    const cy = corner.includes('n') ? b.y : b.y + b.h;
    const vx = cx - ax, vy = cy - ay, len2 = vx * vx + vy * vy;
    const start = sel.map(i => ({ x: i.x, y: i.y, w: i.w, h: i.h, fs: i.fontSize }));
    // Rahmen/Notizen/Text: Seitenverhältnis frei, Inhalt bleibt stehen. Mit Bildern: fest, Schrift skaliert mit.
    const onlyFrames = sel.every(i => i.type !== 'image');
    this.cb.onBeforeChange();
    this.drag(e, ev => {
      const p = this.pointerWorld(ev);
      if (onlyFrames) {
        const minW = Math.min(...start.map(s => s.w)), minH = Math.min(...start.map(s => s.h));
        const kx = Math.max(MIN_SIZE / minW, (p.x - ax) / vx);
        const ky = Math.max(MIN_SIZE / minH, (p.y - ay) / vy);
        sel.forEach((it, n) => {
          const s0 = start[n];
          it.x = ax + (s0.x - ax) * kx; it.y = ay + (s0.y - ay) * ky;
          it.w = s0.w * kx; it.h = s0.h * ky;
        });
        sel.forEach(i => this.layoutNode(i));
        this.renderOverlay();
        return;
      }
      const k = scaleGroup(sel, start, ax, ay, ((p.x - ax) * vx + (p.y - ay) * vy) / len2);
      sel.forEach((it, n) => { if (isNote(it)) it.fontSize = Math.round(start[n].fs * k * 10) / 10; });
      sel.forEach(i => this.layoutNode(i));
      this.refreshSources();
      this.renderOverlay();
    }, () => {
      sel.filter(i => i.type === 'text').forEach(i => this.autosize(i));
      this.renderOverlay();
      this.cb.onChange();
    });
  }

  // Ausschnitt-Kante/-Ecke ziehen: sichtbarer Bereich ändert sich, Bild bleibt stehen.
  startWindow(e, edge) {
    const item = this.byId(this.cropId);
    const s = { x: item.x, y: item.y, w: item.w, h: item.h };
    const p0 = this.pointerWorld(e);
    this.cb.onBeforeChange();
    this.drag(e, ev => {
      const p = this.pointerWorld(ev);
      const dx = p.x - p0.x, dy = p.y - p0.y;
      let x1 = s.x, y1 = s.y, x2 = s.x + s.w, y2 = s.y + s.h;
      if (edge.includes('w')) x1 = Math.min(x2 - MIN_SIZE, x1 + dx);
      if (edge.includes('e')) x2 = Math.max(x1 + MIN_SIZE, x2 + dx);
      if (edge.includes('n')) y1 = Math.min(y2 - MIN_SIZE, y1 + dy);
      if (edge.includes('s')) y2 = Math.max(y1 + MIN_SIZE, y2 + dy);
      setWindow(item, x1, y1, x2 - x1, y2 - y1);
      this.layoutNode(item);
      this.renderOverlay();
    }, () => this.cb.onChange());
  }

  // Bild im Ausschnitt verschieben.
  startCropMove(e) {
    const item = this.byId(this.cropId);
    const r0 = imageRect(item);
    const p0 = this.pointerWorld(e);
    let moved = false;
    this.drag(e, ev => {
      const p = this.pointerWorld(ev);
      if (!moved) { moved = true; this.cb.onBeforeChange(); }
      setImageRect(item, { ...r0, cx: r0.cx + p.x - p0.x, cy: r0.cy + p.y - p0.y });
      this.layoutNode(item);
      this.renderOverlay();
    }, () => { if (moved) this.cb.onChange(); });
  }

  // Bild im Ausschnitt größer/kleiner (um die Bildmitte).
  startImgScale(e) {
    const item = this.byId(this.cropId);
    const r0 = imageRect(item);
    const p0 = this.pointerWorld(e);
    const d0 = Math.hypot(p0.x - r0.cx, p0.y - r0.cy) || 1;
    this.cb.onBeforeChange();
    this.drag(e, ev => {
      const p = this.pointerWorld(ev);
      const k = Math.max(MIN_SIZE / Math.min(r0.w, r0.h), Math.hypot(p.x - r0.cx, p.y - r0.cy) / d0);
      setImageRect(item, { ...r0, w: r0.w * k, h: r0.h * k });
      this.layoutNode(item);
      this.refreshSources();
      this.renderOverlay();
    }, () => this.cb.onChange());
  }

  // Bild im Ausschnitt drehen; Umschalt rastet in 15°-Schritten.
  startImgRotate(e) {
    const item = this.byId(this.cropId);
    const r0 = imageRect(item);
    const p0 = this.pointerWorld(e);
    const a0 = Math.atan2(p0.y - r0.cy, p0.x - r0.cx);
    this.cb.onBeforeChange();
    this.drag(e, ev => {
      const p = this.pointerWorld(ev);
      let rot = r0.rot + (Math.atan2(p.y - r0.cy, p.x - r0.cx) - a0) * 180 / Math.PI;
      if (ev.shiftKey) rot = Math.round(rot / SNAP_DEG) * SNAP_DEG;
      setImageRect(item, { ...r0, rot });
      this.layoutNode(item);
      this.renderOverlay();
    }, () => this.cb.onChange());
  }

  // Rahmen aufziehen (Werkzeug „Rahmen“). Klick ohne Ziehen = Rahmen in Standardgröße.
  startFrameDraw(e) {
    const r = this.viewport.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const w0 = screenToWorld(this.view, sx, sy);
    let rect = null, area = null;
    this.drag(e, ev => {
      const cx = ev.clientX - r.left, cy = ev.clientY - r.top;
      if (!rect && Math.abs(cx - sx) + Math.abs(cy - sy) < 4) return;
      if (!rect) { rect = document.createElement('div'); rect.className = 'frame-draft'; this.overlay.appendChild(rect); }
      Object.assign(rect.style, {
        left: `${Math.min(sx, cx)}px`, top: `${Math.min(sy, cy)}px`,
        width: `${Math.abs(cx - sx)}px`, height: `${Math.abs(cy - sy)}px`,
      });
      const w1 = screenToWorld(this.view, cx, cy);
      area = { x: Math.min(w0.x, w1.x), y: Math.min(w0.y, w1.y), w: Math.abs(w1.x - w0.x), h: Math.abs(w1.y - w0.y) };
    }, () => {
      rect?.remove();
      this.setTool(null);
      if (!area || area.w < MIN_SIZE || area.h < MIN_SIZE) {
        area = { x: w0.x - FRAME_DEFAULT.w / 2, y: w0.y - FRAME_DEFAULT.h / 2, ...FRAME_DEFAULT };
      }
      this.cb.onCreateFrame?.(area);
    });
  }

  // Entfernt nur vom Board – nie die Datei (PFLICHTENHEFT 0.3).
  removeSelected() {
    if (!this.selected.size) return;
    if (this.editing) { this.editing.ta.remove(); this.editing = null; }
    this.cb.onBeforeChange();
    const ids = new Set(this.selected);
    this.items = this.items.filter(i => !ids.has(i.id));
    this.selected = new Set();
    this.render();
    this.cb.onRemove(ids);
  }
}

// ---------- kleine DOM-Hilfen ----------

function $app() { return document.getElementById('app') || { hidden: false }; }

function box(cls, x, y, w, h) {
  const d = document.createElement('div');
  d.className = cls;
  Object.assign(d.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
  return d;
}

function handle(name, x, y, cls) {
  const d = document.createElement('div');
  d.className = cls;
  d.dataset.handle = name;
  d.style.left = `${x}px`; d.style.top = `${y}px`;
  return d;
}

function uiButton(label, title, onClick) {
  const b = document.createElement('button');
  b.className = 'overlay-ui';
  b.textContent = label;
  b.title = title;
  b.addEventListener('click', e => { e.stopPropagation(); onClick(); });
  return b;
}
