// Unendliche Fläche: Verschieben, Zoomen, Auswahl, Skalieren, Ausschnitt/Bildtransform.

import {
  zoomAt, screenToWorld, fitView, boundsOf, intersects, scaleGroup,
  imageRect, setImageRect, setWindow, resetCrop, rotate, normalizeAngle, MIN_SIZE,
} from './model.js';

const ROT_HANDLE_PX = 34;  // Abstand des Dreh-Anfassers über dem Bild (Bildschirm-Pixel)
const SNAP_DEG = 15;       // Umschalt beim Drehen

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
    this.spaceDown = false;
    this.bind();
  }

  setContent(items, view) {
    this.cropId = null;
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
    this.render();
  }

  byId(id) { return this.items.find(i => i.id === id); }

  // Oberstes Element an einem Board-Punkt.
  hitTest(p) {
    for (let n = this.items.length - 1; n >= 0; n--) {
      const i = this.items[n];
      if (p.x >= i.x && p.x <= i.x + i.w && p.y >= i.y && p.y <= i.y + i.h) return i;
    }
    return null;
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
    const g = 24 * scale;
    this.viewport.style.backgroundSize = `${g}px ${g}px`;
    this.viewport.style.backgroundPosition = `${x}px ${y}px`;
    this.refreshSources();
    this.renderOverlay();
    this.cb.onViewApplied?.(this.view);
  }

  render() {
    const alive = new Set();
    for (const item of this.items) {
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

  fitAll() {
    const r = this.viewport.getBoundingClientRect();
    this.view = fitView(this.items, r.width, r.height);
    this.applyView();
    this.cb.onViewChange(this.view);
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
    if (!sel.length) return;
    const b = boundsOf(sel);
    const p1 = this.toScreen(b.x, b.y), p2 = this.toScreen(b.x + b.w, b.y + b.h);
    o.appendChild(box('sel-box', p1.x, p1.y, p2.x - p1.x, p2.y - p1.y));
    for (const [name, x, y] of [['nw', p1.x, p1.y], ['ne', p2.x, p1.y], ['sw', p1.x, p2.y], ['se', p2.x, p2.y]]) {
      o.appendChild(handle(`scale-${name}`, x, y, `handle corner ${name}`));
    }
    const trash = uiButton('🗑', 'Vom Board entfernen (Entf) – die Datei bleibt erhalten', () => this.removeSelected());
    trash.classList.add('trash');
    trash.style.left = `${p2.x + 10}px`; trash.style.top = `${p1.y - 4}px`;
    o.appendChild(trash);
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
      const r = vp.getBoundingClientRect();
      const speed = e.ctrlKey ? 0.01 : 0.0015; // ctrlKey = Touchpad-Pinch
      this.view = zoomAt(this.view, Math.exp(-e.deltaY * speed), e.clientX - r.left, e.clientY - r.top);
      this.applyView();
      this.cb.onViewChange(this.view);
    }, { passive: false });

    vp.addEventListener('contextmenu', e => e.preventDefault());

    vp.addEventListener('pointerdown', e => {
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
      if (itemNode) return this.startMove(e, itemNode.dataset.id);
      this.startMarquee(e);
    });

    // Ziel über die Position bestimmen (wegen Zeiger-Erfassung ist e.target hier das Board).
    vp.addEventListener('dblclick', e => {
      if (this.cropId) return;
      const hit = this.hitTest(this.pointerWorld(e));
      if (hit) this.enterCrop(hit.id);
    });

    window.addEventListener('keydown', e => {
      if (e.target.closest('input, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
      if (document.querySelector('.modal:not([hidden])')) return;
      if (e.code === 'Space') { this.spaceDown = true; vp.classList.add('space'); e.preventDefault(); }
      if (e.key === 'Escape' || (e.key === 'Enter' && this.cropId)) { e.preventDefault(); this.exitCrop(); }
      if ((e.key === 'f' || e.key === 'F') && !this.cropId) this.fitAll();
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
    const start = this.selectedItems().map(i => ({ i, x: i.x, y: i.y }));
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
      for (const it of this.items) if (intersects(area, it)) ids.add(it.id);
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
    const start = sel.map(i => ({ x: i.x, y: i.y, w: i.w, h: i.h }));
    this.cb.onBeforeChange();
    this.drag(e, ev => {
      const p = this.pointerWorld(ev);
      const k = ((p.x - ax) * vx + (p.y - ay) * vy) / len2;
      scaleGroup(sel, start, ax, ay, k);
      sel.forEach(i => this.layoutNode(i));
      this.refreshSources();
      this.renderOverlay();
    }, () => this.cb.onChange());
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

  // Entfernt nur vom Board – nie die Datei (PFLICHTENHEFT 0.3).
  removeSelected() {
    if (!this.selected.size) return;
    this.cb.onBeforeChange();
    const ids = new Set(this.selected);
    this.items = this.items.filter(i => !ids.has(i.id));
    this.selected = new Set();
    this.render();
    this.cb.onRemove(ids);
  }
}

// ---------- kleine DOM-Hilfen ----------

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
