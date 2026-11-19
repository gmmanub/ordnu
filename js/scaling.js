// Skalieren per Mausrad (Alt + Rad auf dem Board, Rad in der Bildansicht):
// nichtlineare Dynamik und Einrasten des Skalierzentrums an Ecken/Mitte.
// Alle Werte hier oben – leicht anpassbar (PFLICHTENHEFT 3, Bau-Schritt 4b).

export const WHEEL_NOTCH_PX = 100;     // so viele Pixel liefert eine Mausrad-Raste (Chrome/Windows)
export const PCT_SLOW = 0.008;         // langsames Drehen: 0,8 % pro Raste
export const PCT_FAST = 0.15;          // schnelles Drehen: bis 15 % pro Raste
export const SPEED_SLOW = 5;           // Rasten pro Sekunde, bis zu denen es fein bleibt
export const SPEED_FAST = 40;          // ab hier volle Geschwindigkeit
export const SPEED_SMOOTH = 0.7;       // Glättung der Geschwindigkeit (0 = keine, 1 = träge)
export const SPEED_RESET_MS = 250;     // längere Pause = wieder fein beginnen
export const PINCH_SPEED = 0.01;       // Touchpad-Pinch (Strg + Rad): direkte Umsetzung
export const SNAP_FRACTION = 0.15;     // Fangbereich = 15 % der kleineren Seite …
export const SNAP_MIN_PX = 12;         // … aber mindestens 12 px
export const SNAP_MAX_PX = 32;         // … und höchstens 32 px auf dem Bildschirm
export const SESSION_END_MS = 500;     // Pause, nach der ein Dreh-Vorgang als ein Rückgängig-Schritt endet

// Rad-Ereignis → Rasten (Vorzeichen: positiv = größer). Beide Achsen auswerten:
// mit Alt/Umschalt liefert Chrome teils deltaX statt deltaY.
export function wheelNotches(e) {
  const dx = e.deltaX || 0, dy = e.deltaY || 0;
  let d = Math.abs(dy) >= Math.abs(dx) ? dy : dx;
  if (e.deltaMode === 1) d *= 33;          // Zeilen
  else if (e.deltaMode === 2) d *= 800;    // Seiten
  return -d / WHEEL_NOTCH_PX;
}

// Zustand für die Dynamik: { v, t } – Geschwindigkeit in Rasten/s, Zeit des letzten Ereignisses.
export function createDynamics() { return { v: 0, t: 0 }; }

const smoothstep = x => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };

// Prozent pro Raste für eine Geschwindigkeit (Rasten/s).
export function pctForSpeed(v) {
  return PCT_SLOW + (PCT_FAST - PCT_SLOW) * smoothstep((v - SPEED_SLOW) / (SPEED_FAST - SPEED_SLOW));
}

// Faktor für ein Rad-Ereignis. Langsam = fein, schnell = beschleunigt (nicht linear).
export function wheelFactor(dyn, e, now = performance.now()) {
  if (e.ctrlKey) return Math.exp(-(e.deltaY || 0) * PINCH_SPEED); // Touchpad-Pinch
  const n = wheelNotches(e);
  if (!n) return 1;
  const dt = dyn.t ? now - dyn.t : Infinity;
  dyn.t = now;
  if (dt > SPEED_RESET_MS) dyn.v = 0;
  else {
    const inst = Math.abs(n) / Math.max(dt, 8) * 1000;
    dyn.v = dyn.v * SPEED_SMOOTH + inst * (1 - SPEED_SMOOTH);
  }
  return Math.exp(n * Math.log(1 + pctForSpeed(dyn.v)));
}

// Fangradius in Bildschirm-Pixeln für eine Box (Bildschirm-Maße).
export function snapRadius(wPx, hPx) {
  return Math.min(SNAP_MAX_PX, Math.max(SNAP_MIN_PX, SNAP_FRACTION * Math.min(wPx, hPx)));
}

// Skalierzentrum: Mauszeiger, außer er liegt im Fangbereich eines Punkts (Ecken, Mitte).
// points = [{ key, x, y }] in Bildschirm-Koordinaten. Rückgabe { x, y, snap: key | null }.
export function snapPivot(points, pointer, radius) {
  let best = null, bestD = Infinity;
  for (const p of points) {
    const d = Math.hypot(p.x - pointer.x, p.y - pointer.y);
    if (d <= radius && d < bestD) { best = p; bestD = d; }
  }
  return best ? { x: best.x, y: best.y, snap: best.key } : { x: pointer.x, y: pointer.y, snap: null };
}

// Ecken + Mitte einer achsparallelen Box (Bildschirm-Koordinaten).
export function boxSnapPoints(x, y, w, h) {
  return [
    { key: 'nw', x, y }, { key: 'ne', x: x + w, y }, { key: 'sw', x, y: y + h }, { key: 'se', x: x + w, y: y + h },
    { key: 'c', x: x + w / 2, y: y + h / 2 },
  ];
}
