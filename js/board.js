// Unendliche Fläche: Verschieben, Zoomen, Elemente zeigen und bewegen.

import { zoomAt, screenToWorld, fitView } from './model.js';

export class Board {
  constructor(viewport, world, { onChange, onRemove, onViewChange, onDropImage, getImageUrl }) {
    this.viewport = viewport;
    this.world = world;
    this.onChange = onChange;           // Inhalt geändert → speichern
    this.onRemove = onRemove;           // (Set von IDs) vom Board entfernt
    this.onViewChange = onViewChange;   // nur Ansicht geändert
    this.onDropImage = onDropImage;     // (path, worldX, worldY)
    this.getImageUrl = getImageUrl;     // (path, displayWidthPx) → { url } | null
    this.view = { x: 0, y: 0, scale: 1 };
    this.items = [];
    this.selected = new Set();
    this.nodes = new Map();
    this.spaceDown = false;
    this.bind();
  }

  setContent(items, view) {
    this.items = items;
    this.view = { ...view };
    this.selected.clear();
    this.world.replaceChildren();
    this.nodes.clear();
    this.render();
  }

  // ---------- Darstellung ----------

  applyView() {
    const { x, y, scale } = this.view;
    this.world.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    // Punktraster mitbewegen
    const g = 24 * scale;
    this.viewport.style.backgroundSize = `${g}px ${g}px`;
    this.viewport.style.backgroundPosition = `${x}px ${y}px`;
    this.refreshSources();
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
        this.world.appendChild(node);
        this.nodes.set(item.id, node);
      }
      node.style.left = `${item.x}px`;
      node.style.top = `${item.y}px`;
      node.style.width = `${item.w}px`;
      node.style.height = `${item.h}px`;
      node.classList.toggle('selected', this.selected.has(item.id));
    }
    for (const [id, node] of this.nodes) {
      if (!alive.has(id)) { node.remove(); this.nodes.delete(id); }
    }
    this.applyView();
  }

  // Bildquelle je nach Bildschirmgröße wählen (Vorschau oder Original).
  refreshSources() {
    for (const item of this.items) {
      if (item.type !== 'image') continue;
      const node = this.nodes.get(item.id);
      if (!node) continue;
      const src = this.getImageUrl(item.path, item.w * this.view.scale);
      if (!src) {
        if (!node.querySelector('.missing')) {
          node.replaceChildren(Object.assign(document.createElement('div'),
            { className: 'missing', textContent: `Datei fehlt:\n${item.path}` }));
        }
        continue;
      }
      let img = node.querySelector('img');
      if (!img) { img = document.createElement('img'); img.draggable = false; node.replaceChildren(img); }
      if (img.getAttribute('src') !== src.url) img.src = src.url;
    }
  }

  setSelection(ids) {
    this.selected = new Set(ids);
    for (const [id, node] of this.nodes) node.classList.toggle('selected', this.selected.has(id));
  }

  fitAll() {
    const r = this.viewport.getBoundingClientRect();
    this.view = fitView(this.items, r.width, r.height);
    this.applyView();
    this.onViewChange(this.view);
  }

  centerWorld() {
    const r = this.viewport.getBoundingClientRect();
    return screenToWorld(this.view, r.width / 2, r.height / 2);
  }

  // ---------- Bedienung ----------

  bind() {
    const vp = this.viewport;

    vp.addEventListener('wheel', e => {
      e.preventDefault();
      const r = vp.getBoundingClientRect();
      const speed = e.ctrlKey ? 0.01 : 0.0015; // ctrlKey = Touchpad-Pinch
      const factor = Math.exp(-e.deltaY * speed);
      this.view = zoomAt(this.view, factor, e.clientX - r.left, e.clientY - r.top);
      this.applyView();
      this.onViewChange(this.view);
    }, { passive: false });

    vp.addEventListener('contextmenu', e => e.preventDefault());

    vp.addEventListener('pointerdown', e => {
      vp.focus();
      const itemNode = e.target.closest('.item');
      const wantsPan = e.button === 1 || e.button === 2 || (e.button === 0 && this.spaceDown);
      if (wantsPan) return this.startPan(e);
      if (e.button !== 0) return;
      if (itemNode) return this.startMove(e, itemNode.dataset.id);
      this.setSelection([]); // Klick auf leere Fläche
    });

    window.addEventListener('keydown', e => {
      if (e.target.closest('input, textarea')) return;
      if (e.code === 'Space') { this.spaceDown = true; vp.classList.add('space'); e.preventDefault(); }
      if (e.key === 'f' || e.key === 'F') this.fitAll();
      if (e.key === 'Delete' || e.key === 'Backspace') this.removeSelected();
    });
    window.addEventListener('keyup', e => {
      if (e.code === 'Space') { this.spaceDown = false; vp.classList.remove('space'); }
    });

    // Bild aus der Seitenleiste herüberziehen
    vp.addEventListener('dragover', e => {
      if (e.dataTransfer.types.includes('application/x-ordnu-path')) {
        e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
      }
    });
    vp.addEventListener('drop', e => {
      const path = e.dataTransfer.getData('application/x-ordnu-path');
      if (!path) return;
      e.preventDefault();
      const r = vp.getBoundingClientRect();
      const p = screenToWorld(this.view, e.clientX - r.left, e.clientY - r.top);
      this.onDropImage(path, p.x, p.y);
    });

    new ResizeObserver(() => this.applyView()).observe(vp);
  }

  startPan(e) {
    e.preventDefault();
    const vp = this.viewport;
    vp.setPointerCapture(e.pointerId);
    vp.classList.add('panning');
    const sx = e.clientX, sy = e.clientY, ox = this.view.x, oy = this.view.y;
    const move = ev => {
      this.view = { ...this.view, x: ox + ev.clientX - sx, y: oy + ev.clientY - sy };
      this.applyView();
    };
    const up = () => {
      vp.classList.remove('panning');
      vp.removeEventListener('pointermove', move);
      vp.removeEventListener('pointerup', up);
      vp.removeEventListener('pointercancel', up);
      this.onViewChange(this.view);
    };
    vp.addEventListener('pointermove', move);
    vp.addEventListener('pointerup', up);
    vp.addEventListener('pointercancel', up);
  }

  startMove(e, id) {
    e.preventDefault();
    if (e.shiftKey) {
      const next = new Set(this.selected);
      next.has(id) ? next.delete(id) : next.add(id);
      this.setSelection(next);
      return;
    }
    if (!this.selected.has(id)) this.setSelection([id]);

    const vp = this.viewport;
    vp.setPointerCapture(e.pointerId);
    const moving = this.items.filter(i => this.selected.has(i.id));
    const start = moving.map(i => ({ i, x: i.x, y: i.y }));
    const sx = e.clientX, sy = e.clientY;
    let moved = false;
    const move = ev => {
      const dx = (ev.clientX - sx) / this.view.scale, dy = (ev.clientY - sy) / this.view.scale;
      if (Math.abs(dx) + Math.abs(dy) > 0) moved = true;
      for (const s of start) {
        s.i.x = s.x + dx; s.i.y = s.y + dy;
        const n = this.nodes.get(s.i.id);
        n.style.left = `${s.i.x}px`; n.style.top = `${s.i.y}px`;
      }
    };
    const up = () => {
      vp.removeEventListener('pointermove', move);
      vp.removeEventListener('pointerup', up);
      vp.removeEventListener('pointercancel', up);
      if (moved) this.onChange();
    };
    vp.addEventListener('pointermove', move);
    vp.addEventListener('pointerup', up);
    vp.addEventListener('pointercancel', up);
  }

  // Entfernt nur vom Board – nie die Datei (PFLICHTENHEFT 3).
  removeSelected() {
    if (!this.selected.size) return;
    const ids = new Set(this.selected);
    this.items = this.items.filter(i => !ids.has(i.id));
    this.selected = new Set();
    this.render();
    this.onRemove(ids);
  }
}
