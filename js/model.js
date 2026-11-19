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
