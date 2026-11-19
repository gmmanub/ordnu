// Rückgängig/Wiederholen pro Tab (PFLICHTENHEFT 2, V1).
// Jeder Schritt speichert nur die Unterschiede: geänderte Elemente (vorher/nachher je ID)
// und geänderte Tags (vorher/nachher je Bildpfad und Feld). Gespeichert in .ordnu/verlauf.json.

export const HISTORY_VERSION = 1;

const j = v => JSON.stringify(v ?? null);
const clone = v => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)));

// Zustand vor einer Änderung festhalten (nur der betroffene Tab + Tags).
export function capture(data, tabId) {
  const items = new Map();
  const order = [];
  for (const it of data.items) {
    if (it.tab !== tabId) continue;
    items.set(it.id, j(it));
    order.push(it.id);
  }
  return { tabId, items, order, tags: j(data.tags) };
}

// Unterschied zwischen festgehaltenem und aktuellem Zustand → Verlaufsschritt oder null.
export function diff(pre, data) {
  const now = new Map();
  for (const it of data.items) if (it.tab === pre.tabId) now.set(it.id, it);

  const items = [];
  for (const [id, before] of pre.items) {
    const after = now.get(id);
    if (!after) items.push({ id, before: JSON.parse(before), after: null, prev: pre.order[pre.order.indexOf(id) - 1] ?? null });
    else if (j(after) !== before) items.push({ id, before: JSON.parse(before), after: clone(after) });
  }
  for (const [id, it] of now) if (!pre.items.has(id)) items.push({ id, before: null, after: clone(it) });

  // Tags je Bild und Feld (z. B. shot, variante), damit Änderungen anderer Tabs an anderen Feldern unberührt bleiben.
  const tags = [];
  const preTags = JSON.parse(pre.tags) || {};
  const curTags = data.tags || {};
  for (const path of new Set([...Object.keys(preTags), ...Object.keys(curTags)])) {
    const a = preTags[path] || {}, b = curTags[path] || {};
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (j(a[key]) !== j(b[key])) tags.push({ path, key, before: clone(a[key]), after: clone(b[key]) });
    }
  }
  return items.length || tags.length ? { items, tags } : null;
}

// Schritt anwenden: dir = 'undo' oder 'redo'. Tags werden nur zurückgesetzt, wenn sie seitdem
// nicht woanders geändert wurden (sonst bleibt die spätere Änderung stehen). Rückgabe: übersprungene Tags.
export function apply(entry, data, tabId, dir) {
  const undo = dir === 'undo';
  // Vorwärts, damit beim Wiedereinfügen mehrerer Elemente die Vorgänger schon da sind.
  for (const ch of entry.items) {
    const target = undo ? ch.before : ch.after;
    const idx = data.items.findIndex(i => i.id === ch.id);
    if (!target) { if (idx >= 0) data.items.splice(idx, 1); continue; }
    const item = { ...clone(target), tab: tabId };
    if (idx >= 0) { data.items[idx] = item; continue; }
    // wieder einfügen: möglichst an der alten Stelle (Stapelreihenfolge)
    let at = -1;
    if (undo && ch.prev) at = data.items.findIndex(i => i.id === ch.prev) + 1;
    if (at <= 0) {
      const first = data.items.findIndex(i => i.tab === tabId);
      at = undo && ch.prev === null && first >= 0 ? first : data.items.length;
    }
    data.items.splice(at, 0, item);
  }
  let skipped = 0;
  for (const t of entry.tags) {
    const expect = undo ? t.after : t.before;
    const target = undo ? t.before : t.after;
    const cur = data.tags[t.path] || {};
    if (j(cur[t.key]) !== j(expect)) { skipped++; continue; } // inzwischen woanders geändert
    const next = { ...cur };
    if (target === null) delete next[t.key]; else next[t.key] = clone(target);
    if (Object.keys(next).length) data.tags[t.path] = next; else delete data.tags[t.path];
  }
  return skipped;
}

export class TabHistory {
  constructor(limit) {
    this.limit = limit;
    this.tabs = {};
  }

  of(tabId) {
    return (this.tabs[tabId] ||= { past: [], future: [] });
  }

  push(tabId, entry) {
    const h = this.of(tabId);
    h.past.push(entry);
    if (h.past.length > this.limit) h.past.splice(0, h.past.length - this.limit);
    h.future = [];
  }

  canUndo(tabId) { return this.of(tabId).past.length > 0; }
  canRedo(tabId) { return this.of(tabId).future.length > 0; }

  undo(tabId, data) {
    const h = this.of(tabId);
    const e = h.past.pop();
    if (!e) return null;
    const skipped = apply(e, data, tabId, 'undo');
    h.future.push(e);
    return { skipped };
  }

  redo(tabId, data) {
    const h = this.of(tabId);
    const e = h.future.pop();
    if (!e) return null;
    const skipped = apply(e, data, tabId, 'redo');
    h.past.push(e);
    return { skipped };
  }

  removeTab(tabId) {
    const h = this.tabs[tabId] || { past: [], future: [] };
    delete this.tabs[tabId];
    return h;
  }

  restoreTab(tabId, h) { this.tabs[tabId] = h; }

  toJSON() {
    return { version: HISTORY_VERSION, tabs: this.tabs };
  }

  // Geladenen Verlauf übernehmen; alles Unlesbare wird verworfen (nie Absturz).
  static from(raw, limit, tabIds) {
    const hist = new TabHistory(limit);
    if (!raw || typeof raw !== 'object' || raw.version !== HISTORY_VERSION || typeof raw.tabs !== 'object') return hist;
    const ok = e => e && Array.isArray(e.items) && Array.isArray(e.tags) && e.tags.every(t => t && typeof t.key === 'string');
    for (const [id, h] of Object.entries(raw.tabs)) {
      if (!tabIds.has(id) || !h) continue;
      hist.tabs[id] = {
        past: (Array.isArray(h.past) ? h.past.filter(ok) : []).slice(-limit),
        future: (Array.isArray(h.future) ? h.future.filter(ok) : []).slice(-limit),
      };
    }
    return hist;
  }
}
