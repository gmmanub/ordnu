// Dateizugriff von ordnu. Liest Bilder nur; schreibt ausschließlich in <Projekt>/.ordnu/ (PFLICHTENHEFT 0.3).

import { isImageName, normalizeData, createEmptyData, thumbKey } from './model.js';

export const APP_DIR = '.ordnu';
export const DATA_FILE = 'ordnu.json';
export const BACKUP_FILE = 'ordnu.backup.json';
export const THUMB_DIR = 'vorschau';
export const THUMB_SIZE = 512;
export const THUMB_QUALITY = 0.8;

export function supportsFolders() {
  return typeof window.showDirectoryPicker === 'function';
}

// ---------- Ordner-Verweis merken (einziger Browser-Speicher, PFLICHTENHEFT 1) ----------

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('ordnu', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function rememberRoot(handle) {
  const db = await idb();
  await new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(handle, 'root');
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
  db.close();
}

export async function recallRoot() {
  try {
    const db = await idb();
    const handle = await new Promise((res, rej) => {
      const req = db.transaction('kv').objectStore('kv').get('root');
      req.onsuccess = () => res(req.result || null); req.onerror = () => rej(req.error);
    });
    db.close();
    return handle;
  } catch {
    return null;
  }
}

export async function hasPermission(handle, ask = false) {
  if (typeof handle.queryPermission !== 'function') return true; // z. B. Test-Ordner im Browser
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  if (!ask) return false;
  return (await handle.requestPermission(opts)) === 'granted';
}

// ---------- Projekte ----------

export async function listProjects(root) {
  const names = [];
  for await (const [name, h] of root.entries()) {
    if (h.kind === 'directory' && !name.startsWith('.')) names.push(name);
  }
  return names.sort((a, b) => a.localeCompare(b, 'de', { numeric: true }));
}

// Alle Bilder im Projekt (rekursiv, ohne versteckte Ordner). Pfade mit "/" relativ zum Projekt.
export async function scanImages(dir, prefix = '') {
  const out = [];
  for await (const [name, h] of dir.entries()) {
    if (name.startsWith('.')) continue;
    const path = prefix ? `${prefix}/${name}` : name;
    if (h.kind === 'directory') out.push(...await scanImages(h, path));
    else if (isImageName(name)) out.push({ path, name, handle: h });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path, 'de', { numeric: true }));
}

export async function fileByPath(projectDir, path) {
  const parts = path.split('/');
  let dir = projectDir;
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
  return dir.getFileHandle(parts[parts.length - 1]);
}

// ---------- Projektdaten (.ordnu/ordnu.json) ----------

async function readText(dir, name) {
  try {
    const fh = await dir.getFileHandle(name);
    return await (await fh.getFile()).text();
  } catch (e) {
    if (e.name === 'NotFoundError') return null;
    throw e;
  }
}

// createWritable schreibt in eine Zwischendatei und ersetzt erst beim close() – kein Halb-Stand.
async function writeText(dir, name, text) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(text);
  await w.close();
}

// Lädt die Projektdaten. Rückgabe: { data, notice } – notice ist ein Hinweistext für Manu oder null.
export async function loadProjectData(projectDir) {
  const appDir = await projectDir.getDirectoryHandle(APP_DIR, { create: true });
  const text = await readText(appDir, DATA_FILE);
  if (text === null) return { appDir, data: createEmptyData(), notice: null };

  try {
    const data = normalizeData(JSON.parse(text));
    await writeText(appDir, BACKUP_FILE, text); // Stand beim Öffnen sichern
    return { appDir, data, notice: null };
  } catch (err) {
    if (/neueren ordnu-Version/.test(err.message)) throw err; // nicht überschreiben!
    // Beschädigte Datei aufheben, nicht überschreiben.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await writeText(appDir, `ordnu.defekt-${stamp}.json`, text);
    const backup = await readText(appDir, BACKUP_FILE);
    if (backup !== null) {
      try {
        return { appDir, data: normalizeData(JSON.parse(backup)),
          notice: 'Projektdaten waren beschädigt – letzte Sicherung geladen. Die beschädigte Datei liegt in .ordnu/.' };
      } catch { /* Sicherung auch defekt */ }
    }
    throw new Error('Projektdaten sind beschädigt und es gibt keine lesbare Sicherung. Die Datei wurde in .ordnu/ aufgehoben.');
  }
}

export async function saveProjectData(appDir, data) {
  await writeText(appDir, DATA_FILE, JSON.stringify(data, null, 1));
}

// ---------- Vorschaubilder (.ordnu/vorschau/) ----------

// Liefert { url, width, height } – width/height sind die Maße des Originals.
export async function getThumbnail(appDir, img) {
  const file = await img.handle.getFile();
  const key = await thumbKey(img.path, file.size, file.lastModified);
  const thumbDir = await appDir.getDirectoryHandle(THUMB_DIR, { create: true });
  const name = `${key}.webp`;
  const metaName = `${key}.json`;

  const existing = await readText(thumbDir, metaName);
  if (existing) {
    try {
      const meta = JSON.parse(existing);
      const blob = await (await thumbDir.getFileHandle(name)).getFile();
      return { url: URL.createObjectURL(blob), width: meta.width, height: meta.height };
    } catch { /* neu erzeugen */ }
  }

  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;
  const k = Math.min(1, THUMB_SIZE / Math.max(width, height));
  const tw = Math.max(1, Math.round(width * k)), th = Math.max(1, Math.round(height * k));
  const canvas = new OffscreenCanvas(tw, th);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, tw, th);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: THUMB_QUALITY });

  const fh = await thumbDir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();
  await writeText(thumbDir, metaName, JSON.stringify({ width, height }));

  return { url: URL.createObjectURL(blob), width, height };
}

// ---------- Verlauf (.ordnu/verlauf.json) ----------

export const HISTORY_FILE = 'verlauf.json';

// Fehlende oder defekte Datei → null (leerer Verlauf), nie ein Fehler.
export async function loadHistoryRaw(appDir) {
  try {
    const text = await readText(appDir, HISTORY_FILE);
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

export async function saveHistoryRaw(appDir, obj) {
  await writeText(appDir, HISTORY_FILE, JSON.stringify(obj));
}
