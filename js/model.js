// Datenmodell von ordnu – reine Funktionen ohne Datei- oder Browserzugriff.

export const DATA_VERSION = 1;

// Formate, die Chrome selbst anzeigen kann (PFLICHTENHEFT 1.4).
export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'bmp'];

export const ZOOM_MIN = 0.05;
export const ZOOM_MAX = 8;
export const DEFAULT_IMAGE_WIDTH = 320; // Breite eines neu platzierten Bildes in Board-Einheiten

export function isImageName(name) {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return IMAGE_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase());
}

export function newId(prefix = 'id') {
  const rnd = crypto.getRandomValues(new Uint32Array(2));
  return `${prefix}_${rnd[0].toString(36)}${rnd[1].toString(36)}`;
}

export function createTab(name) {
  return { id: newId('tab'), name, view: { x: 0, y: 0, scale: 1 } };
}

export function createEmptyData() {
  const first = createTab('Board');
  return {
    version: DATA_VERSION,
    tabs: [first],
    activeTab: first.id,
    items: [],
    tags: {},
  };
}

// Bringt geladene Daten in eine gültige Form (fehlende Felder ergänzen).
// Wirft einen Fehler, wenn die Datei von einer neueren App-Version stammt.
export function normalizeData(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Keine gültigen ordnu-Daten.');
  if (typeof raw.version === 'number' && raw.version > DATA_VERSION) {
    throw new Error(`Die Projektdaten stammen von einer neueren ordnu-Version (${raw.version}).`);
  }
  const data = {
    version: DATA_VERSION,
    tabs: Array.isArray(raw.tabs) ? raw.tabs.filter(t => t && t.id) : [],
    activeTab: raw.activeTab,
    items: Array.isArray(raw.items) ? raw.items.filter(i => i && i.id && i.tab) : [],
    tags: raw.tags && typeof raw.tags === 'object' ? raw.tags : {},
  };
  for (const tab of data.tabs) {
    tab.name = typeof tab.name === 'string' && tab.name.trim() ? tab.name : 'Board';
    const v = tab.view || {};
    tab.view = {
      x: Number.isFinite(v.x) ? v.x : 0,
      y: Number.isFinite(v.y) ? v.y : 0,
      scale: clampZoom(Number.isFinite(v.scale) ? v.scale : 1),
    };
  }
  if (data.tabs.length === 0) data.tabs.push(createTab('Board'));
  const tabIds = new Set(data.tabs.map(t => t.id));
  data.items = data.items.filter(i => tabIds.has(i.tab));
  for (const item of data.items) normalizeItem(item);
  if (!tabIds.has(data.activeTab)) data.activeTab = data.tabs[0].id;
  return data;
}

export function clampZoom(s) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s));
}

// Zoomt um einen Bildschirmpunkt (px, py), sodass dieser Punkt fest bleibt.
export function zoomAt(view, factor, px, py) {
  const scale = clampZoom(view.scale * factor);
  const k = scale / view.scale;
  return { x: px - (px - view.x) * k, y: py - (py - view.y) * k, scale };
}

export function screenToWorld(view, sx, sy) {
  return { x: (sx - view.x) / view.scale, y: (sy - view.y) / view.scale };
}

// Ansicht so wählen, dass alle Elemente in den Ausschnitt passen.
export function fitView(items, width, height, margin = 40) {
  if (!items.length) return { x: 0, y: 0, scale: 1 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const i of items) {
    minX = Math.min(minX, i.x); minY = Math.min(minY, i.y);
    maxX = Math.max(maxX, i.x + i.w); maxY = Math.max(maxY, i.y + i.h);
  }
  const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
  const scale = clampZoom(Math.min((width - 2 * margin) / bw, (height - 2 * margin) / bh, 1));
  return {
    x: (width - bw * scale) / 2 - minX * scale,
    y: (height - bh * scale) / 2 - minY * scale,
    scale,
  };
}

// Kurzer, stabiler Name für ein Vorschaubild: ändert sich, wenn sich das Original ändert.
export async function thumbKey(path, size, lastModified) {
  const bytes = new TextEncoder().encode(`${path}|${size}|${lastModified}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest).slice(0, 10), b => b.toString(16).padStart(2, '0')).join('');
}

// ---------- Elemente ----------

export const MIN_SIZE = 20; // kleinste Kante eines Elements in Board-Einheiten

// Ältere Elemente ohne Ausschnitt/Seitenverhältnis ergänzen (ordnu.json Version 1 bleibt gültig).
export function normalizeItem(item) {
  for (const k of ['x', 'y', 'w', 'h']) if (!Number.isFinite(item[k])) item[k] = k === 'w' || k === 'h' ? 100 : 0;
  item.w = Math.max(1, item.w); item.h = Math.max(1, item.h);
  if (item.type === 'image') {
    if (!(item.ar > 0)) item.ar = item.h / item.w; // ohne Ausschnitt entspricht der Rahmen dem Bild
    item.crop = normalizeCrop(item.crop);
  }
  return item;
}

// ---------- Ausschnitt / Bildtransform ----------
// item.x/y/w/h = sichtbarer Ausschnitt auf dem Board.
// item.crop = { ox, oy, scale, rot } relativ zur Ausschnitt-Breite w:
//   Bildmitte = Ausschnittmitte + (ox·w, oy·w), Bildbreite = scale·w, Drehung rot in Grad.
// item.ar = Höhe/Breite des Originalbildes. Die Datei bleibt immer unverändert.

export function defaultCrop() {
  return { ox: 0, oy: 0, scale: 1, rot: 0 };
}

export function normalizeCrop(c) {
  const d = defaultCrop();
  if (!c || typeof c !== 'object') return d;
  return {
    ox: Number.isFinite(c.ox) ? c.ox : d.ox,
    oy: Number.isFinite(c.oy) ? c.oy : d.oy,
    scale: Number.isFinite(c.scale) && c.scale > 0 ? c.scale : d.scale,
    rot: Number.isFinite(c.rot) ? normalizeAngle(c.rot) : d.rot,
  };
}

export function normalizeAngle(deg) {
  let a = ((deg % 360) + 360) % 360;
  if (a > 180) a -= 360;
  return Math.round(a * 1000) / 1000;
}

// Lage des ganzen Bildes in Board-Koordinaten: Mitte, Breite, Höhe, Drehung.
export function imageRect(item) {
  const c = item.crop || defaultCrop();
  const w = c.scale * item.w;
  return {
    cx: item.x + item.w / 2 + c.ox * item.w,
    cy: item.y + item.h / 2 + c.oy * item.w,
    w, h: w * item.ar, rot: c.rot,
  };
}

// Bildlage zurück in item.crop schreiben (Ausschnitt bleibt, wie er ist).
export function setImageRect(item, r) {
  item.crop = {
    ox: (r.cx - (item.x + item.w / 2)) / item.w,
    oy: (r.cy - (item.y + item.h / 2)) / item.w,
    scale: r.w / item.w,
    rot: normalizeAngle(r.rot),
  };
}

// Ausschnitt ändern, das Bild bleibt auf dem Board stehen.
export function setWindow(item, x, y, w, h) {
  const r = imageRect(item);
  Object.assign(item, { x, y, w: Math.max(MIN_SIZE, w), h: Math.max(MIN_SIZE, h) });
  setImageRect(item, r);
}

export function resetCrop(item) {
  item.crop = defaultCrop();
  item.h = item.w * item.ar;
}

// Punkt (dx, dy) um Winkel deg drehen.
export function rotate(dx, dy, deg) {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

// ---------- Auswahl ----------

export function boundsOf(items) {
  if (!items.length) return null;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const i of items) {
    x1 = Math.min(x1, i.x); y1 = Math.min(y1, i.y);
    x2 = Math.max(x2, i.x + i.w); y2 = Math.max(y2, i.y + i.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export function intersects(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// Gruppe um festen Ankerpunkt skalieren (Seitenverhältnis bleibt). start = Kopien der Ausgangswerte.
export function scaleGroup(items, start, ax, ay, k) {
  const minEdge = Math.min(...start.map(s => Math.min(s.w, s.h)));
  k = Math.max(k, MIN_SIZE / minEdge);
  items.forEach((it, n) => {
    const s = start[n];
    it.x = ax + (s.x - ax) * k; it.y = ay + (s.y - ay) * k;
    it.w = s.w * k; it.h = s.h * k;
  });
  return k;
}
