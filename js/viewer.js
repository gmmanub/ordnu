// Bildansicht (Doppelklick auf ein Bild): ganzes Original, startet bei 100 % (echte Pixel).
// Klick auf die Zoomanzeige = 100 % ↔ Bildschirm füllen. Rad zoomt (nichtlinear), Ziehen verschiebt,
// Pfeiltasten blättern räumlich zum nächsten Bild auf dem Board, Esc/× schließt.
// Die Seitenleiste ist für V2 (Versionshistorie, Vergleich) vorbereitet und noch unsichtbar.

import { createDynamics, wheelFactor } from './scaling.js';

export const VIEWER_ZOOM_MIN = 0.02;
export const VIEWER_ZOOM_MAX = 32;
const PIXELATED_FROM = 2; // ab 200 % Pixel scharf zeigen (zum Beurteilen von Details)
const KEY_DIRS = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };

export class Viewer {
  // cb: getItem(id), getFile(path) → File|null, describe(path) → { name, date }, neighbor(id, dir) → id|null, onClose(id)
  constructor(root, cb) {
    this.root = root;
    this.cb = cb;
    this.stage = root.querySelector('.viewer-stage');
    this.img = root.querySelector('.viewer-img');
    this.zoomBtn = root.querySelector('.viewer-zoom');
    this.nameEl = root.querySelector('.viewer-name');
    this.dateEl = root.querySelector('.viewer-date');
    this.msgEl = root.querySelector('.viewer-msg');
    this.id = null;
    this.url = null;
    this.size = null;            // natürliche Größe des Originals
    this.view = { x: 0, y: 0, scale: 1 };
    this.dyn = createDynamics();
    this.token = 0;
    this.bind();
  }

  get isOpen() { return !this.root.hidden; }

  async open(id) {
    const item = this.cb.getItem(id);
    if (!item || item.type !== 'image') return false;
    this.id = id;
    this.root.hidden = false;
    this.root.focus();
    const token = ++this.token;
    const { name, date } = this.cb.describe(item.path);
    this.nameEl.textContent = name;
    this.dateEl.textContent = date || '';
    this.msgEl.hidden = true;
    let file = null;
    try { file = await this.cb.getFile(item.path); } catch { file = null; }
    if (token !== this.token) return false;
    this.release();
    if (!file) {
      this.img.hidden = true;
      this.msgEl.textContent = `Datei fehlt: ${item.path}`;
      this.msgEl.hidden = false;
      this.size = null;
      this.zoomBtn.textContent = '–';
      return false;
    }
    this.url = URL.createObjectURL(file);
    this.img.src = this.url;
    try { await this.img.decode(); } catch { /* wird unten geprüft */ }
    if (token !== this.token) return false;
    this.size = { w: this.img.naturalWidth, h: this.img.naturalHeight };
    this.img.hidden = false;
    this.setActual();
    return true;
  }

  close() {
    if (!this.isOpen) return;
    this.token++;
    this.root.hidden = true;
    this.release();
    const id = this.id;
    this.id = null;
    this.cb.onClose?.(id);
  }

  release() {
    if (this.url) { URL.revokeObjectURL(this.url); this.url = null; }
    this.img.removeAttribute('src');
  }

  stageRect() { return this.stage.getBoundingClientRect(); }

  // 100 % (echte Pixel), mittig – auch wenn das Bild größer als der Bildschirm ist.
  setActual(centerOn = null) {
    if (!this.size) return;
    const r = this.stageRect();
    if (centerOn) {
      // Bildpunkt, der gerade in der Mitte liegt, bleibt in der Mitte
      this.view = { scale: 1, x: r.width / 2 - centerOn.x, y: r.height / 2 - centerOn.y };
    } else {
      this.view = { scale: 1, x: (r.width - this.size.w) / 2, y: (r.height - this.size.h) / 2 };
    }
    this.apply();
  }

  // Bildschirm füllen = ganz einpassen.
  setFit() {
    if (!this.size) return;
    const r = this.stageRect();
    const scale = Math.min(r.width / this.size.w, r.height / this.size.h);
    this.view = { scale, x: (r.width - this.size.w * scale) / 2, y: (r.height - this.size.h * scale) / 2 };
    this.apply();
  }

  isActual() { return Math.abs(this.view.scale - 1) < 1e-3; }

  toggleZoom() {
    if (!this.size) return;
    if (this.isActual()) return this.setFit();
    const r = this.stageRect();
    this.setActual({ x: (r.width / 2 - this.view.x) / this.view.scale, y: (r.height / 2 - this.view.y) / this.view.scale });
  }

  apply() {
    if (!this.size) return;
    const { x, y, scale } = this.view;
    Object.assign(this.img.style, {
      width: `${this.size.w}px`, height: `${this.size.h}px`,
      transform: `translate(${x}px, ${y}px) scale(${scale})`,
    });
    this.img.classList.toggle('pixelated', scale >= PIXELATED_FROM);
    const fit = Math.min(this.stageRect().width / this.size.w, this.stageRect().height / this.size.h);
    const label = this.isActual() ? '100 %' : `${Math.round(scale * 100)} %`;
    this.zoomBtn.textContent = label;
    this.zoomBtn.title = this.isActual()
      ? 'Klick: Bildschirm füllen'
      : `Klick: 100 % (echte Pixel)${Math.abs(scale - fit) < 1e-3 ? ' – gerade eingepasst' : ''}`;
  }

  zoomAround(factor, sx, sy) {
    const scale = Math.min(VIEWER_ZOOM_MAX, Math.max(VIEWER_ZOOM_MIN, this.view.scale * factor));
    const k = scale / this.view.scale;
    this.view = { scale, x: sx - (sx - this.view.x) * k, y: sy - (sy - this.view.y) * k };
    this.apply();
  }

  async go(dir) {
    const next = this.cb.neighbor(this.id, dir);
    if (next) await this.open(next);
    return next;
  }

  bind() {
    this.stage.addEventListener('wheel', e => {
      e.preventDefault();
      if (!this.size) return;
      const f = wheelFactor(this.dyn, e);
      if (!Number.isFinite(f) || f === 1) return;
      const r = this.stageRect();
      this.zoomAround(f, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });

    this.stage.addEventListener('pointerdown', e => {
      if (e.button !== 0 && e.button !== 1) return;
      e.preventDefault();
      this.stage.setPointerCapture(e.pointerId);
      this.stage.classList.add('panning');
      const sx = e.clientX, sy = e.clientY, ox = this.view.x, oy = this.view.y;
      const move = ev => { this.view = { ...this.view, x: ox + ev.clientX - sx, y: oy + ev.clientY - sy }; this.apply(); };
      const up = () => {
        this.stage.classList.remove('panning');
        this.stage.removeEventListener('pointermove', move);
        this.stage.removeEventListener('pointerup', up);
        this.stage.removeEventListener('pointercancel', up);
      };
      this.stage.addEventListener('pointermove', move);
      this.stage.addEventListener('pointerup', up);
      this.stage.addEventListener('pointercancel', up);
    });
    this.stage.addEventListener('contextmenu', e => e.preventDefault());

    this.zoomBtn.addEventListener('click', () => this.toggleZoom());
    this.root.querySelector('.viewer-close').addEventListener('click', () => this.close());

    // Tasten nur, solange die Ansicht offen ist – vor allen anderen Tasten-Behandlungen der App.
    window.addEventListener('keydown', e => {
      if (!this.isOpen) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); this.close(); return; }
      const dir = KEY_DIRS[e.key];
      if (dir) { e.preventDefault(); e.stopImmediatePropagation(); this.go(dir); return; }
      if (e.key === '0') { e.preventDefault(); this.setActual(); }
    }, true);

    window.addEventListener('resize', () => { if (this.isOpen) this.apply(); });
  }
}
