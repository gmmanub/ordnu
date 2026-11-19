"""Browser-Test für ordnu (Chrome headless, Playwright).

NDA: nutzt nur selbst erzeugte Dummy-Bilder und Fantasienamen in einem Test-Ordner
im browser-eigenen Speicher (OPFS). Echte Dateien werden nicht angefasst.

Aufruf:  python3 tests/run.py
Screenshots landen in tests/output/ (von .gitignore ausgeschlossen).
"""
import functools
import http.server
import json
import os
import sys
import threading

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "tests", "output")
CHROME = os.environ.get("CHROME", "/usr/bin/google-chrome")


def serve():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
    handler.log_message = lambda *a: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


SETUP_JS = """
async () => {
  const opfs = await navigator.storage.getDirectory();
  try { await opfs.removeEntry('testroot', { recursive: true }); } catch {}
  const root = await opfs.getDirectoryHandle('testroot', { create: true });
  const colors = ['#c0392b', '#2980b9', '#27ae60', '#8e44ad', '#f39c12'];
  async function dummy(dir, name, w, h, color, label) {
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext('2d');
    g.fillStyle = color; g.fillRect(0, 0, w, h);
    g.fillStyle = '#fff'; g.font = `${Math.round(h / 6)}px sans-serif`;
    g.fillText(label, w * 0.08, h * 0.55);
    const blob = await c.convertToBlob({ type: name.endsWith('.png') ? 'image/png' : 'image/jpeg' });
    const fh = await dir.getFileHandle(name, { create: true });
    const wr = await fh.createWritable(); await wr.write(blob); await wr.close();
  }
  const p1 = await root.getDirectoryHandle('Projekt Apfelbaum', { create: true });
  const sub = await p1.getDirectoryHandle('Anlieferung', { create: true });
  await dummy(p1, 'test_motiv_a.jpg', 1920, 1080, colors[0], 'Motiv A');
  await dummy(p1, 'test_motiv_b.png', 1080, 1350, colors[1], 'Motiv B');
  await dummy(sub, 'test_motiv_c_v2.jpg', 2048, 858, colors[2], 'Motiv C v2');
  await p1.getFileHandle('notiz.txt', { create: true });           // kein Bild → ignorieren
  await p1.getFileHandle('render.exr', { create: true });          // nicht unterstützt → ignorieren
  await root.getDirectoryHandle('Projekt Wolkenhaus', { create: true });
  await root.getDirectoryHandle('.versteckt', { create: true });
  return true;
}
"""


def main():
    os.makedirs(OUT, exist_ok=True)
    srv = serve()
    base = f"http://127.0.0.1:{srv.server_address[1]}/"
    errors, failures = [], []

    def check(cond, msg):
        print(("  ok   " if cond else "  FEHL ") + msg)
        if not cond:
            failures.append(msg)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=CHROME, headless=True)
        # Funktionstest: Sicherheitssperre hier aus, weil das Testwerkzeug selbst Code nachlädt.
        # Die Sperre wird unten in einem eigenen Browser-Fenster MIT Sperre geprüft.
        ctx = browser.new_context(viewport={"width": 1400, "height": 850}, bypass_csp=True)
        page = ctx.new_page()
        page.on("console", lambda m: m.type == "error" and errors.append(m.text))
        page.on("pageerror", lambda e: errors.append(str(e)))

        page.goto(base + "?nosw")
        page.wait_for_selector("#start:not([hidden])")
        page.screenshot(path=os.path.join(OUT, "01_start.png"))
        page.evaluate(SETUP_JS)

        print("Projekte")
        names = page.evaluate("""async () => {
          const app = await import('./js/app.js');
          const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('testroot');
          return app.openRoot(root, { remember: false });
        }""")
        check(names == ["Projekt Apfelbaum", "Projekt Wolkenhaus"], f"Projektliste ohne versteckte Ordner: {names}")
        page.screenshot(path=os.path.join(OUT, "02_projekte.png"))

        print("Projekt öffnen")
        res = page.evaluate("""async () => (await import('./js/app.js')).openProject('Projekt Apfelbaum')""")
        check(res["images"] == 3, f"3 Bilder gefunden (rekursiv, nur unterstützte Formate): {res['images']}")
        page.wait_for_function("[...document.querySelectorAll('#image-list img')].every(i => i.src.startsWith('blob:'))")
        check(True, "Vorschaubilder erzeugt")

        print("Bilder platzieren")
        page.click('#image-list li.tile[data-path="Anlieferung/test_motiv_c_v2.jpg"]')
        page.click('#image-list li.tile[data-path="test_motiv_a.jpg"]')
        page.wait_for_function("document.querySelectorAll('#world .item').length === 2")
        check(True, "2 Bilder per Klick aufs Board gelegt")
        page.wait_for_function("document.querySelectorAll('#world .item img').length === 2")

        # Bild per Maus verschieben
        box = page.locator("#world .item").first.bounding_box()
        page.mouse.move(box["x"] + 20, box["y"] + 20)
        page.mouse.down(); page.mouse.move(box["x"] - 180, box["y"] - 60, steps=5); page.mouse.up()
        box2 = page.locator("#world .item").first.bounding_box()
        check(abs(box2["x"] - (box["x"] - 200)) < 2, "Bild per Ziehen verschoben")

        # Zoomen und Verschieben der Fläche
        vp = page.locator("#viewport").bounding_box()
        page.mouse.move(vp["x"] + vp["width"] / 2, vp["y"] + vp["height"] / 2)
        page.mouse.wheel(0, 300)
        zoom = page.text_content("#zoom-label")
        check(zoom.strip() != "100 %", f"Mausrad zoomt: {zoom}")
        page.keyboard.press("f")

        def ev(body):
            """JS mit app (App-Modul), M (Datenmodell), B (Board) und d (Projektdaten) ausführen."""
            return page.evaluate("async () => { const app = await import('./js/app.js'); const M = await import('./js/model.js');"
                                 " const B = app._board(); const d = app.state.data; " + body + " }")

        def labels():
            return page.eval_on_selector_all("#tabs .tab-label", "b => b.map(x => x.textContent)")

        def count():
            return page.locator("#world .item").count()

        def drag(x1, y1, x2, y2, shift=False):
            page.mouse.move(x1, y1)
            if shift: page.keyboard.down("Shift")
            page.mouse.down(); page.mouse.move(x2, y2, steps=6); page.mouse.up()
            if shift: page.keyboard.up("Shift")

        def center(sel):
            b = page.locator(sel).first.bounding_box()
            return b["x"] + b["width"] / 2, b["y"] + b["height"] / 2

        print("Tabs")
        page.click("#btn-add-tab")
        page.fill("#tabs input", "Moods")
        page.keyboard.press("Enter")
        check(labels() == ["Board", "Moods"], f"Tab angelegt und umbenannt: {labels()}")
        check(count() == 0, "Neuer Tab ist leer")
        page.click('#image-list li.tile[data-path="test_motiv_b.png"]')
        page.wait_for_function("document.querySelectorAll('#world .item').length === 1")
        page.click("#tabs .tab >> nth=0")
        check(count() == 2, "Zurück im ersten Tab: 2 Bilder")
        page.screenshot(path=os.path.join(OUT, "03_board.png"))

        print("Löschen vom Board (Datei bleibt)")
        page.locator("#world .item").nth(1).click()
        page.keyboard.press("Delete")
        check(count() == 1, "Bild vom Board entfernt")

        print("Rückgängig pro Tab")
        page.locator("#viewport").focus()
        x_moved = ev("return d.items.find(i => i.path.startsWith('Anlieferung')).x;")
        page.keyboard.press("Control+z")
        check(count() == 2, "Strg+Z: Entfernen rückgängig")
        page.keyboard.press("Control+z")
        x_orig = ev("return d.items.find(i => i.path.startsWith('Anlieferung')).x;")
        check(abs(x_orig - x_moved) > 50, "Strg+Z: Verschieben rückgängig (Schritt im selben Tab, nicht der aus „Moods“)")
        page.keyboard.press("Control+Shift+z")
        check(ev("return d.items.find(i => i.path.startsWith('Anlieferung')).x;") == x_moved, "Strg+Umschalt+Z: Verschieben wiederholt")
        page.keyboard.press("Control+y")
        check(count() == 1, "Strg+Y: Entfernen wiederholt")
        page.click("#tabs .tab >> nth=1")
        page.locator("#viewport").focus()
        page.keyboard.press("Control+z")
        moods_n = count()
        board_n = ev("return d.items.filter(i => i.tab === d.tabs[0].id).length;")
        check(moods_n == 0 and board_n == 1, f"Strg+Z in „Moods“ wirkt nur dort (Moods {moods_n}, Board {board_n})")
        page.keyboard.press("Control+Shift+z")
        check(count() == 1, "Wiederholen in „Moods“")
        page.click("#tabs .tab >> nth=0")
        steps = ev("""let n = 0; while (app.undo()) n++;
          const empty = document.querySelectorAll('#world .item').length;
          let m = 0; while (app.redo()) m++;
          return { n, m, empty, after: document.querySelectorAll('#world .item').length,
                   moods: d.items.filter(i => i.tab === d.tabs[1].id).length };""")
        check(steps["n"] == 4 and steps["empty"] == 0 and steps["m"] == 4 and steps["after"] == 1 and steps["moods"] == 1,
              f"Board: 4 eigene Schritte rückgängig/wiederholt, „Moods“ unberührt: {steps}")

        print("Tabs sortieren")
        page.drag_and_drop("#tabs .tab >> nth=1", "#tabs .tab >> nth=0", target_position={"x": 4, "y": 10})
        check(labels() == ["Moods", "Board"], f"Tab per Ziehen nach vorn: {labels()}")
        page.drag_and_drop("#tabs .tab >> nth=0", "#tabs .tab >> nth=1", target_position={"x": 60, "y": 10})
        check(labels() == ["Board", "Moods"], f"Und zurück: {labels()}")

        print("Tab löschen mit Rückfrage und Rückgängig-Hinweis")
        page.click("#btn-add-tab")
        page.fill("#tabs input", "Grenze")
        page.keyboard.press("Enter")
        many = ev("""for (let i = 0; i < 250; i++) await app.placeImage('test_motiv_a.jpg', i * 5, 0);
          let n = 0; while (app.undo()) n++;
          while (app.redo()) {}
          return { n, limit: app.UNDO_STEPS, items: document.querySelectorAll('#world .item').length };""")
        check(many["n"] == many["limit"] == 200, f"Verlauf je Tab hält {many['limit']} Schritte: {many['n']}")
        check(many["items"] == 250, "Nach Wiederholen wieder 250 Bilder")
        grenze = "#tabs .tab >> nth=2"
        page.hover(grenze); page.click(grenze + " >> .tab-close")
        check(page.is_visible("#modal"), "Rückfrage erscheint in der App")
        page.click("#modal-cancel")
        check(labels() == ["Board", "Moods", "Grenze"] and not page.is_visible("#modal"), "Abbrechen: Tab bleibt")
        page.hover(grenze); page.click(grenze + " >> .tab-close")
        page.keyboard.press("Escape")
        check(labels() == ["Board", "Moods", "Grenze"], "Esc: Tab bleibt")
        page.hover(grenze); page.click(grenze + " >> .tab-close")
        page.click("#modal-ok")
        page.wait_for_function("document.querySelectorAll('#tabs .tab').length === 2")
        check(labels() == ["Board", "Moods"], f"Tab gelöscht: {labels()}")
        check("gelöscht" in page.text_content("#toast") and page.is_visible("#toast button"), "Hinweis mit „Rückgängig“")
        page.click("#toast button")
        page.wait_for_function("document.querySelectorAll('#tabs .tab').length === 3")
        restored = ev("return { labels: d.tabs.map(t => t.name), active: d.tabs.find(t => t.id === d.activeTab).name, items: document.querySelectorAll('#world .item').length, undo: app.state.hist.canUndo(d.activeTab) };")
        check(restored == {"labels": ["Board", "Moods", "Grenze"], "active": "Grenze", "items": 250, "undo": True},
              f"Tab samt Inhalt und Verlauf zurückgeholt: {restored}")
        page.hover(grenze); page.click(grenze + " >> .tab-close"); page.click("#modal-ok")
        page.wait_for_function("document.querySelectorAll('#tabs .tab').length === 2")
        check(labels() == ["Board", "Moods"] and ev("return d.items.length;") == 2, "Endgültig gelöscht, Bilder anderer Tabs bleiben")
        page.click("#tabs .tab >> nth=0")

        print("Skalieren, Auswahlrahmen, Mülleimer")
        ev("B.view = { x: 0, y: 0, scale: 1 }; B.applyView(); return true;")
        ev("const c = d.items.find(i => i.tab === d.activeTab); c.x = 300; c.y = 200; B.replaceItems(d.items.filter(i => i.tab === d.activeTab)); return true;")
        page.click('#image-list li.tile[data-path="test_motiv_a.jpg"]')  # Motiv A dazu, ist danach ausgewählt
        page.wait_for_function("document.querySelectorAll('#world .item img').length === 2")
        ev("const a = d.items.find(i => i.tab === d.activeTab && i.path === 'test_motiv_a.jpg'); a.x = 750; a.y = 220; B.replaceItems(d.items.filter(i => i.tab === d.activeTab)); B.setSelection([a.id]); return true;")
        a0 = ev("return { ...d.items.find(i => i.tab === d.activeTab && i.path === 'test_motiv_a.jpg') };")
        hx, hy = center(".handle.corner.se")
        drag(hx, hy, hx + 90, hy + 60)
        a1 = ev("return { ...d.items.find(i => i.tab === d.activeTab && i.path === 'test_motiv_a.jpg') };")
        check(a1["w"] > a0["w"] + 40 and abs(a1["h"] / a1["w"] - a0["h"] / a0["w"]) < 0.001 and a1["x"] == a0["x"] and a1["y"] == a0["y"],
              f"Einzelbild an Ecke skaliert, Seitenverhältnis fest, Gegenecke bleibt ({a0['w']:.0f} → {a1['w']:.0f})")
        hx2, hy2 = center(".handle.corner.se")
        vpb = page.locator("#viewport").bounding_box()
        drag(hx2, hy2, vpb["x"] + 5, vpb["y"] + 5)
        a_min = ev("return d.items.find(i => i.tab === d.activeTab && i.path === 'test_motiv_a.jpg').h;")
        check(a_min >= 19.9, f"Mindestgröße wird eingehalten: {a_min:.1f}")
        page.keyboard.press("Control+z")
        check(abs(ev("return d.items.find(i => i.tab === d.activeTab && i.path === 'test_motiv_a.jpg').w;") - a1["w"]) < 0.01, "Skalieren rückgängig")

        page.mouse.click(1300, 800)  # leere Fläche
        check(page.locator("#world .item.selected").count() == 0, "Klick auf leere Fläche hebt Auswahl auf")
        drag(250, 150, 1300, 700)
        check(page.locator("#world .item.selected").count() == 2, "Auswahlrahmen wählt beide Bilder")
        before = ev("return d.items.filter(i => i.tab === d.activeTab).map(i => ({ ...i }));")
        bb = ev("return M.boundsOf(d.items.filter(i => i.tab === d.activeTab));")
        hx, hy = center(".handle.corner.nw")
        drag(hx, hy, hx - 100, hy - 100)
        after = ev("return d.items.filter(i => i.tab === d.activeTab).map(i => ({ ...i }));")
        bb2 = ev("return M.boundsOf(d.items.filter(i => i.tab === d.activeTab));")
        k = [a["w"] / b["w"] for a, b in zip(after, before)]
        check(abs(k[0] - k[1]) < 1e-6 and k[0] > 1.1, f"Gruppe gemeinsam skaliert (Faktor {k[0]:.2f})")
        check(abs((bb2["x"] + bb2["w"]) - (bb["x"] + bb["w"])) < 0.01 and abs((bb2["y"] + bb2["h"]) - (bb["y"] + bb["h"])) < 0.01,
              "Gruppe: gegenüberliegende Ecke bleibt fest")
        page.keyboard.press("Control+z")
        page.mouse.click(1300, 800)
        drag(250, 150, 700, 450)
        n1 = page.locator("#world .item.selected").count()
        drag(1300, 120, 760, 300, shift=True)
        n2 = page.locator("#world .item.selected").count()
        check(n1 == 1 and n2 == 2, f"Umschalt + Auswahlrahmen fügt hinzu ({n1} → {n2})")

        page.mouse.click(1300, 800)
        cx, cy = center("#world .item >> nth=1")
        page.mouse.click(cx, cy)
        page.click(".overlay .trash")
        check(count() == 1, "Mülleimer entfernt Bild vom Board")
        page.keyboard.press("Control+z")
        check(count() == 2, "Mülleimer rückgängig")
        page.keyboard.press("Control+Shift+z")
        check(count() == 1, "… und wiederholt (nur Motiv C bleibt)")

        print("Ausschnitt / Bildtransform")
        c0 = ev("const c = d.items.find(i => i.tab === d.activeTab); return { item: JSON.parse(JSON.stringify(c)), r: M.imageRect(c) };")
        cx, cy = center("#world .item")
        page.mouse.dblclick(cx, cy)
        check(page.is_visible(".crop-bar") and page.locator("#world .item.cropping").count() == 1, "Doppelklick öffnet Ausschnitt-Modus")
        hx, hy = center(".handle.win.e")
        drag(hx, hy, hx - 60, hy)
        c1 = ev("const c = d.items.find(i => i.tab === d.activeTab); return { item: { ...c }, r: M.imageRect(c) };")
        same = all(abs(c1["r"][k] - c0["r"][k]) < 0.01 for k in ("cx", "cy", "w", "h"))
        check(abs(c1["item"]["w"] - (c0["item"]["w"] - 60)) < 0.5 and same, "Ausschnitt-Kante verkleinert, Bild bleibt stehen")
        cx, cy = center(".crop-box")
        drag(cx, cy, cx + 30, cy + 20)
        c2 = ev("return M.imageRect(d.items.find(i => i.tab === d.activeTab));")
        check(abs(c2["cx"] - c1["r"]["cx"] - 30) < 0.5 and abs(c2["cy"] - c1["r"]["cy"] - 20) < 0.5, "Bild im Ausschnitt verschoben")
        hx, hy = center(".handle.img")
        ccx, ccy = c2["cx"], c2["cy"]  # Ansicht 1:1, Ursprung 0 → Board = Bildschirm minus Viewport-Versatz
        vpb = page.locator("#viewport").bounding_box()
        mx, my = ccx + vpb["x"], ccy + vpb["y"]
        drag(hx, hy, mx + (hx - mx) * 2.5, my + (hy - my) * 2.5)
        c3 = ev("return { r: M.imageRect(d.items.find(i => i.tab === d.activeTab)), crop: d.items.find(i => i.tab === d.activeTab).crop };")
        check(abs(c3["r"]["w"] / c2["w"] - 2.5) < 0.02, f"Bild im Ausschnitt per Anfasser vergrößert (×{c3['r']['w'] / c2['w']:.2f})")
        page.wait_for_function("""async () => { const app = await import('./js/app.js');
          const c = app.state.data.items.find(i => i.tab === app.state.data.activeTab);
          return document.querySelector('#world .item.cropping img').src === app.state.images.get(c.path).origUrl; }""")
        check(True, "Vergrößerter Ausschnitt zeigt das Original (scharf)")
        hx, hy = center(".handle.rot")
        drag(hx, hy, mx + 220, my - 90, shift=True)
        rot = ev("return d.items.find(i => i.tab === d.activeTab).crop.rot;")
        check(rot != 0 and abs(rot / 15 - round(rot / 15)) < 1e-6, f"Drehen mit Umschalt rastet in 15°-Schritten: {rot}°")
        page.screenshot(path=os.path.join(OUT, "04_ausschnitt.png"))
        page.click(".crop-bar >> text=90°")
        rot2 = ev("return d.items.find(i => i.tab === d.activeTab).crop.rot;")
        check(abs(((rot2 - rot) % 360) - 90) < 1e-6, f"90°-Knopf: {rot}° → {rot2}°")
        page.click(".crop-bar >> text=Zurücksetzen")
        c4 = ev("const c = d.items.find(i => i.tab === d.activeTab); return { crop: c.crop, ratio: c.h / c.w, ar: c.ar };")
        check(c4["crop"] == {"ox": 0, "oy": 0, "scale": 1, "rot": 0} and abs(c4["ratio"] - c4["ar"]) < 1e-9, "Zurücksetzen: ganzes Bild, ohne Drehung")
        und = ev("""let n = 0; for (let i = 0; i < 6; i++) if (app.undo()) n++;
          const c = d.items.find(i => i.tab === d.activeTab);
          const back = JSON.stringify(c);
          let m = 0; for (let i = 0; i < 6; i++) if (app.redo()) m++;
          return { n, m, back: JSON.parse(back), cropping: !!document.querySelector('#world .item.cropping') };""")
        same0 = all(abs(und["back"][k] - c0["item"][k]) < 1e-6 for k in ("x", "y", "w", "h")) and und["back"]["crop"] == c0["item"]["crop"]
        check(und["n"] == 6 and und["m"] == 6 and same0, "Alle 6 Ausschnitt-Schritte einzeln rückgängig und wiederholt")
        check(und["cropping"], "Ausschnitt-Modus bleibt beim Rückgängigmachen offen")
        page.keyboard.press("Escape")
        check(not page.is_visible(".crop-bar") and page.locator("#world .item.cropping").count() == 0, "Esc beendet Ausschnitt-Modus")
        cx, cy = center("#world .item")
        page.mouse.dblclick(cx, cy)
        page.wait_for_selector(".crop-bar", state="visible")
        page.keyboard.press("Enter")
        check(not page.is_visible(".crop-bar") and page.locator("#world .item.cropping").count() == 0, "Enter beendet Ausschnitt-Modus")
        page.screenshot(path=os.path.join(OUT, "05_nach_ausschnitt.png"))
        old = ev("return M.normalizeData({ version: 1, tabs: [{ id: 't', name: 'Alt' }], activeTab: 't', items: [{ id: 'x', tab: 't', type: 'image', path: 'a.jpg', x: 0, y: 0, w: 200, h: 100 }] }).items[0];")
        check(old["crop"] == {"ox": 0, "oy": 0, "scale": 1, "rot": 0} and old["ar"] == 0.5, "Ältere Elemente ohne Ausschnitt werden übernommen")

        print("Tags: Rückgängig je Tab und Feld")
        tg = ev("""const p = 'test_motiv_a.jpg';
          const board = d.tabs[0].id, moods = d.tabs[1].id;
          app.setTags([p], { shot: '010' });
          app.switchTab(moods); app.setTags([p], { variante: 'B' });
          app.switchTab(board); app.undo();
          const r1 = { ...d.tags[p] };
          app.redo(); const r2 = { ...d.tags[p] };
          app.switchTab(moods); app.setTags([p], { shot: '020' });
          app.switchTab(board); app.undo();
          const r3 = { ...d.tags[p] }; const t = document.getElementById('toast').textContent;
          return { r1, r2, r3, t };""")
        check(tg["r1"] == {"variante": "B"}, f"Board-Undo nimmt nur das eigene Feld zurück: {tg['r1']}")
        check(tg["r2"] == {"shot": "010", "variante": "B"}, f"Wiederholen: {tg['r2']}")
        check(tg["r3"] == {"shot": "020", "variante": "B"} and "anderen Tab" in tg["t"],
              f"Spätere Änderung aus anderem Tab wird nicht überschrieben + Hinweis: {tg['r3']}")

        print("Speichern")
        data = page.evaluate("""async () => {
          const app = await import('./js/app.js');
          await app.flushAll();
          const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('testroot');
          const p = await root.getDirectoryHandle('Projekt Apfelbaum');
          const files = [];
          for await (const [n] of p.entries()) files.push(n);
          const appDir = await p.getDirectoryHandle('.ordnu');
          const thumbs = [];
          for await (const [n] of (await appDir.getDirectoryHandle('vorschau')).entries()) thumbs.push(n);
          const json = JSON.parse(await (await (await appDir.getFileHandle('ordnu.json')).getFile()).text());
          const verlauf = JSON.parse(await (await (await appDir.getFileHandle('verlauf.json')).getFile()).text());
          return { files: files.sort(), thumbs: thumbs.length, json, verlauf };
        }""")
        j = data["json"]
        check(j["version"] == 1, "ordnu.json mit Version 1")
        check([t["name"] for t in j["tabs"]] == ["Board", "Moods"], "Tabs gespeichert")
        check(len(j["items"]) == 2, f"2 Elemente gespeichert (1+1): {len(j['items'])}")
        check(data["thumbs"] == 6, f"3 Vorschaubilder + 3 Maß-Dateien in .ordnu/vorschau: {data['thumbs']}")
        check(data["files"] == [".ordnu", "Anlieferung", "notiz.txt", "render.exr", "test_motiv_a.jpg", "test_motiv_b.png"],
              f"Originaldateien unverändert: {data['files']}")
        c_item = [i for i in j["items"] if i["path"] == "Anlieferung/test_motiv_c_v2.jpg"]
        check(len(c_item) == 1 and abs(c_item[0]["ar"] - 858 / 2048) < 0.01 and "crop" in c_item[0], "Seitenverhältnis und Ausschnitt gespeichert")
        v = data["verlauf"]
        check(v["version"] == 1 and set(v["tabs"]) == {t["id"] for t in j["tabs"]}, "verlauf.json mit Verlauf je Tab (gelöschter Tab entfernt)")
        check("crop" not in json.dumps(j["tabs"]) and "past" not in json.dumps(j), "Verlauf nicht in ordnu.json")

        print("Neu laden → Stand bleibt")
        page.close()
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(base + "?nosw")
        page.wait_for_selector("#start:not([hidden])")
        n = page.evaluate("""async () => {
          const app = await import('./js/app.js');
          const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('testroot');
          await app.openRoot(root, { remember: false });
          await app.openProject('Projekt Apfelbaum');
          return document.querySelectorAll('#world .item').length;
        }""")
        check(n == 1, f"Nach Neuladen 1 Bild im ersten Tab: {n}")
        vh = page.evaluate("""async () => { const app = await import('./js/app.js');
          const ok = app.undo(); const n = document.querySelectorAll('#world .item').length; app.redo();
          return { ok, n, after: document.querySelectorAll('#world .item').length }; }""")
        check(vh["ok"] and vh["after"] == 1, f"Verlauf nach Neuladen vorhanden (Rückgängig möglich): {vh}")
        broken = page.evaluate("""async () => {
          const app = await import('./js/app.js');
          await app.flushAll();
          const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('testroot');
          const a = await (await root.getDirectoryHandle('Projekt Apfelbaum')).getDirectoryHandle('.ordnu');
          const w = await (await a.getFileHandle('verlauf.json')).createWritable(); await w.write('{kaputt'); await w.close();
          await app.openProject('Projekt Apfelbaum');
          return { items: document.querySelectorAll('#world .item').length, undo: app.undo() }; }""")
        check(broken == {"items": 1, "undo": False}, f"Defekter Verlauf → leerer Verlauf, kein Absturz: {broken}")
        last = page.evaluate("""async () => { const app = await import('./js/app.js');
          await app.openProject('Projekt Wolkenhaus');
          const r = await app.deleteTab(app.state.data.tabs[0].id);
          const res = { r, tabs: app.state.data.tabs.length, modal: !document.getElementById('modal').hidden };
          await app.openProject('Projekt Apfelbaum'); return res; }""")
        check(last == {"r": False, "tabs": 1, "modal": False}, f"Letzter Tab kann nicht gelöscht werden: {last}")
        bak = page.evaluate("""async () => {
          const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('testroot');
          const a = await (await root.getDirectoryHandle('Projekt Apfelbaum')).getDirectoryHandle('.ordnu');
          return (await (await a.getFileHandle('ordnu.backup.json')).getFile()).size > 0;
        }""")
        check(bak, "Sicherung ordnu.backup.json beim Öffnen angelegt")

        print("Beschädigte Datei → Sicherung laden, nichts überschreiben")
        notice = page.evaluate("""async () => {
          const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('testroot');
          const a = await (await root.getDirectoryHandle('Projekt Apfelbaum')).getDirectoryHandle('.ordnu');
          const w = await (await a.getFileHandle('ordnu.json')).createWritable(); await w.write('{kaputt'); await w.close();
          const app = await import('./js/app.js');
          await app.openProject('Projekt Apfelbaum');
          const names = []; for await (const [nm] of a.entries()) names.push(nm);
          return { items: document.querySelectorAll('#world .item').length, defekt: names.some(x => x.startsWith('ordnu.defekt-')),
                   toast: document.getElementById('toast').textContent };
        }""")
        check(notice["items"] == 1 and notice["defekt"], f"Sicherung geladen, defekte Datei aufgehoben: {notice}")

        print("Datum-Regeln (Datenmodell)")
        r = ev("""return {
          a: M.parseDayFolder('26.11.19'), b: M.parseDayFolder('26.02.30'), c: M.parseDayFolder('26.13.01'),
          e: M.parseDayFolder('2026.11.19'), f: M.parseDayFolder('26.11.1'), g: M.parseDayFolder('19.11.26'),
          h: M.dayFolderDate('x/26.11.19/y/26.11.18/bild.jpg'), i: M.dayFolderDate('26.11.19.jpg'),
          j: M.formatDay('2026-11-19') };""")
        check(r["a"] == "2026-11-19", "Tagesordner 26.11.19 = 19.11.2026 (JJ.MM.TT)")
        check(r["b"] is None and r["c"] is None and r["e"] is None and r["f"] is None, "Ungültige/andere Formate werden ignoriert")
        check(r["g"] == "2019-11-26", "19.11.26 wird fest als JJ.MM.TT gelesen (26.11.2019)")
        check(r["h"] == "2026-11-18" and r["i"] is None, "Nächstgelegener Tagesordner zählt, Dateiname nicht")
        check(r["j"] == "Do 19.11.2026", f"Überschrift mit Wochentag: {r['j']}")

        print("Neue Dateien, Ordner ablegen, Eingangsdatum")
        DUMMY = """
          const opfs = await navigator.storage.getDirectory();
          const root = await opfs.getDirectoryHandle('testroot');
          const proj = await root.getDirectoryHandle('Projekt Sonnendeck', { create: true });
          async function dir(path) { let h = proj; for (const p of path.split('/').filter(Boolean)) h = await h.getDirectoryHandle(p, { create: true }); return h; }
          async function dummy(path, color) {
            const parts = path.split('/'); const name = parts.pop(); const d = await dir(parts.join('/'));
            const c = new OffscreenCanvas(400, 300); const g = c.getContext('2d'); g.fillStyle = color || '#555'; g.fillRect(0, 0, 400, 300);
            const blob = await c.convertToBlob({ type: 'image/jpeg' });
            const w = await (await d.getFileHandle(name, { create: true })).createWritable(); await w.write(blob); await w.close();
          }
        """
        def evd(body):
            return ev(DUMMY + body)

        evd("await dummy('alt_x.jpg', '#884'); await dummy('Archiv/alt_y.jpg', '#488');")
        first = ev("""await app.flushAll(); await app.openProject('Projekt Sonnendeck'); const d2 = app.state.data;
          return { first: d2.firstScanDone, files: Object.keys(d2.files).sort(), neu: Object.values(d2.files).filter(f => f.neu).length,
                   eqm: Object.values(d2.files).every(f => f.eingang === f.mtime) };""")
        check(first["first"] and first["files"] == ["Archiv/alt_y.jpg", "alt_x.jpg"], f"Erst-Einlesen merkt sich die Dateien: {first['files']}")
        check(first["neu"] == 0 and first["eqm"], "Erst-Einlesen: nichts „Neu“, Eingangsdatum = Dateidatum")

        evd("await dummy('Lieferung A/26.11.12/neu_a.jpg'); await dummy('neu_b.jpg'); await dummy('26.13.40/neu_c.jpg'); await dummy('.versteckt/geheim.jpg');")
        page.click("#btn-rescan")
        page.wait_for_function("document.querySelectorAll('#image-list li.tile').length === 5")
        st = ev("""const d2 = app.state.data; const today = M.isoDate(Date.now());
          const eff = p => M.effectiveDate(p, d2.files[p], d2.tags[p]);
          return { neu: Object.entries(d2.files).filter(([, f]) => f.neu).map(([p]) => p).sort(),
                   badge: document.querySelectorAll('#image-list .badge-new').length, count: document.getElementById('new-count').textContent,
                   a: eff('Lieferung A/26.11.12/neu_a.jpg'), c: eff('26.13.40/neu_c.jpg'), b: eff('neu_b.jpg'), today,
                   heads: [...document.querySelectorAll('#image-list li.group-head')].map(h => h.textContent),
                   toast: document.getElementById('toast').textContent };""")
        check(st["neu"] == ["26.13.40/neu_c.jpg", "Lieferung A/26.11.12/neu_a.jpg", "neu_b.jpg"], f"Aktualisieren findet 3 neue Bilder (nicht versteckte): {st['neu']}")
        check(st["badge"] == 3 and st["count"] == "3", "„Neu“-Markierung und Zähler")
        check("3 neue Bilder" in st["toast"], f"Hinweis nach Aktualisieren: {st['toast']}")
        check(st["a"]["date"] == "2026-11-12" and st["a"]["source"] == "ordner", "Tagesordner hat Vorrang vor Eingang")
        check(st["c"]["date"] == st["today"] and st["c"]["source"] == "eingang", "Ungültiger Tagesordner → Eingangsdatum")
        check(st["b"]["date"] == st["today"] and st["b"]["time"] is not None, "Neue Datei: Eingangsdatum + Uhrzeit = jetzt")
        check(len(st["heads"]) == 2 and st["heads"][-1] == "Do 12.11.2026", f"Bilderliste nach Tagen gruppiert, neueste oben: {st['heads']}")
        page.screenshot(path=os.path.join(OUT, "06_bilderliste_tage.png"))

        page.check("#filter-new")
        check(page.locator("#image-list li.tile").count() == 3, "Filter „Nur neue“ zeigt 3 Bilder")
        page.uncheck("#filter-new")
        page.select_option("#filter-day", "2026-11-12")
        check(page.locator("#image-list li.tile").count() == 1, "Filter nach Tag zeigt nur 12.11.2026")
        page.select_option("#filter-day", "")
        check(page.locator("#image-list li.tile").count() == 5, "Filter zurück: alle Bilder")

        page.click('#image-list li.tile[data-path="neu_b.jpg"]')
        page.wait_for_function("document.getElementById('new-count').textContent === '2'")
        check(True, "Auf dem Board platziert → gilt als gesehen")
        page.click("#btn-seen")
        check(ev("return Object.values(app.state.data.files).filter(f => f.neu).length;") == 0 and page.locator("#image-list .badge-new").count() == 0,
              "„Alle als gesehen markieren“")

        # Zurückwechseln in die App löst Aktualisieren aus
        evd("await dummy('neu_fokus.jpg');")
        ev("app.state.lastScan = 0; window.dispatchEvent(new Event('focus'));")
        page.wait_for_function("document.querySelector('#image-list li.tile[data-path=\"neu_fokus.jpg\"]') !== null", timeout=5000)
        check(True, "Beim Zurückwechseln in die App wird automatisch aktualisiert")
        fso = ev("return typeof window.FileSystemObserver === 'function';")
        print(f"  info FileSystemObserver im Test-Chrome vorhanden: {fso}")

        # Ordner ablegen (Handles wie beim Ziehen aus dem Explorer)
        evd("await dummy('Lieferung B/l1.jpg'); await dummy('Lieferung B/l2.jpg'); await dummy('Lieferung B/l3.jpg'); await dummy('Lieferung B/Unter/l4.jpg'); await dummy('Lieferung B/.tmp/x.jpg');")
        ev("await app.rescan({ quiet: true }); await app.placeImage('Lieferung B/l1.jpg', 2000, 2000);")
        before = ev("return app.state.data.items.filter(i => i.tab === app.state.data.activeTab).length;")
        drop = evd("""const h = await proj.getDirectoryHandle('Lieferung B');
          const res = await app.dropHandles([Promise.resolve(h)], 0, 0);
          const d2 = app.state.data; const items = d2.items.filter(i => i.tab === d2.activeTab);
          const placed = items.slice(-3).map(i => ({ path: i.path, x: i.x, y: i.y }));
          return { res, n: items.length, placed, toast: document.getElementById('toast').textContent };""")
        check(drop["res"] == {"placed": 3, "skipped": 1, "outside": 0}, f"Ordner ablegen: 3 neu, 1 schon da: {drop['res']}")
        check(drop["n"] == before + 3, "Versteckte Unterordner werden nicht übernommen")
        check([p["path"] for p in drop["placed"]] == ["Lieferung B/l2.jpg", "Lieferung B/l3.jpg", "Lieferung B/Unter/l4.jpg"], f"Reihenfolge nach Name: {[p['path'] for p in drop['placed']]}")
        xs = sorted({p["x"] for p in drop["placed"]}); ys = sorted({p["y"] for p in drop["placed"]})
        check(len(xs) == 2 and len(ys) == 2, f"Als Raster abgelegt (2 Spalten, 2 Reihen): x={xs} y={ys}")
        check("3 neu platziert, 1 schon auf diesem Board" in drop["toast"], f"Hinweis: {drop['toast']}")
        und = ev("""const t = () => app.state.data.items.filter(i => i.tab === app.state.data.activeTab).length;
          const a = t(); app.undo(); const b = t(); app.redo(); return { a, b, c: t() };""")
        check(und["b"] == und["a"] - 3 and und["c"] == und["a"], "Ganzer Ordner-Drop = ein Rückgängig-Schritt")

        again = evd("""const h = await proj.getDirectoryHandle('Lieferung B'); return app.dropHandles([h], 0, 0);""")
        check(again == {"placed": 0, "skipped": 4, "outside": 0}, f"Zweites Ablegen im selben Tab: alles übersprungen: {again}")
        other = evd("""const d2 = app.state.data; const tab = M.createTab('Zweiter'); d2.tabs.push(tab); app.switchTab(tab.id);
          const h = await proj.getDirectoryHandle('Lieferung B'); return app.dropHandles([h], 0, 0);""")
        check(other == {"placed": 4, "skipped": 0, "outside": 0}, f"In einem anderen Tab erlaubt: {other}")
        single = evd("""const h = await proj.getFileHandle('alt_x.jpg'); return app.dropHandles([h], 500, 0);""")
        check(single == {"placed": 1, "skipped": 0, "outside": 0}, "Einzelne Bilddatei aus dem Projekt ablegen")
        outside = evd("""const other = await root.getDirectoryHandle('Projekt Apfelbaum');
          const f = await other.getFileHandle('test_motiv_a.jpg');
          const n = app.state.data.items.length;
          const res = await app.dropHandles([other, f], 0, 0);
          return { res, same: app.state.data.items.length === n, toast: document.getElementById('toast').textContent };""")
        check(outside["res"] == {"placed": 0, "skipped": 0, "outside": 2} and outside["same"], f"Außerhalb des Projekts: nichts übernommen: {outside['res']}")
        check("kopiert keine Dateien" in outside["toast"], "Hinweis bei Ordnern außerhalb des Projekts")
        late = evd("""await dummy('Lieferung C/spaet.jpg'); const h = await proj.getDirectoryHandle('Lieferung C');
          return app.dropHandles([h], 0, 900);""")
        check(late["placed"] == 1, "Ablegen eines noch nicht eingelesenen Ordners liest ihn automatisch ein")

        # Korrekturvorschlag
        sug = ev("""const d2 = app.state.data; const now = Date.now();
          d2.files['neu_b.jpg'].mtime = now - 10 * 864e5; d2.files['neu_fokus.jpg'].mtime = now - 5 * 864e5;
          d2.files['26.13.40/neu_c.jpg'].mtime = now - 3 * 365 * 864e5;
          d2.files['Lieferung A/26.11.12/neu_a.jpg'].mtime = now - 10 * 864e5;
          d2.files['Lieferung B/l1.jpg'].mtime = now + 5 * 864e5;
          app.renderImageList();
          return [...document.querySelectorAll('#image-list li.suggest')].map(l => l.dataset.path).sort();""")
        check(sug == ["neu_b.jpg", "neu_fokus.jpg"], f"Vorschlag nur bei plausibel älterem Dateidatum (nicht >2 Jahre, nicht Zukunft, nicht Tagesordner): {sug}")
        page.uncheck("#opt-suggest")
        off = ev("return { n: document.querySelectorAll('#image-list li.suggest').length, s: app.state.data.settings.dateSuggestions };")
        check(off == {"n": 0, "s": False}, "Vorschläge abschaltbar (Einstellung pro Projekt)")
        page.check("#opt-suggest")
        check(page.locator("#image-list li.suggest").count() == 2, "Vorschläge wieder an")
        page.click('#image-list li.suggest[data-path="neu_fokus.jpg"] .suggest-no')
        ign = ev("return { n: document.querySelectorAll('#image-list li.suggest').length, f: app.state.data.files['neu_fokus.jpg'].ignoreSuggest };")
        check(ign == {"n": 1, "f": True}, "Ignorieren merkt sich das")
        expected = ev("return M.isoDate(app.state.data.files['neu_b.jpg'].mtime);")
        page.click('#image-list li.suggest[data-path="neu_b.jpg"] .suggest-ok')
        acc = ev("""const p = 'neu_b.jpg'; const d2 = app.state.data;
          return { tags: d2.tags[p], eff: M.effectiveDate(p, d2.files[p], d2.tags[p]), n: document.querySelectorAll('#image-list li.suggest').length };""")
        check(acc["tags"]["datum"] == expected and acc["eff"]["source"] == "hand" and acc["n"] == 0, f"Übernehmen setzt das Datum von Hand: {acc['tags']}")
        u2 = ev("""app.undo(); const a = app.state.data.tags['neu_b.jpg']; app.redo(); return { a: a || null, b: app.state.data.tags['neu_b.jpg'] };""")
        check(u2["a"] is None and u2["b"]["datum"] == expected, "Übernehmen ist ein Rückgängig-Schritt")
        keep = ev("""await app.rescan({ quiet: true }); app.state.data.files['neu_b.jpg'].eingang = Date.now();
          await app.rescan({ quiet: true }); const p = 'neu_b.jpg'; const d2 = app.state.data;
          return M.effectiveDate(p, d2.files[p], d2.tags[p]);""")
        check(keep["date"] == expected and keep["manual"], "Von Hand gesetztes Datum wird nie automatisch überschrieben")
        man = ev("""app.setManualDate('alt_x.jpg', '2026-03-04', '09:15'); const d2 = app.state.data;
          const a = M.effectiveDate('alt_x.jpg', d2.files['alt_x.jpg'], d2.tags['alt_x.jpg']);
          app.setManualDate('alt_x.jpg', null); const b = M.effectiveDate('alt_x.jpg', d2.files['alt_x.jpg'], d2.tags['alt_x.jpg']);
          return { a, b };""")
        check(man["a"]["date"] == "2026-03-04" and man["a"]["time"] == "09:15" and man["b"]["source"] == "eingang", "Datum von Hand setzen und zurück auf automatisch")
        page.click('#image-list li.tile[data-path="alt_x.jpg"]', button="right")
        check(page.locator("#image-list li.date-edit input[type=date]").count() == 1, "Rechtsklick öffnet Datumsfeld")
        page.click('#image-list li.tile[data-path="alt_x.jpg"]', button="right")

        print("Neu seit dem letzten Öffnen + Speichern")
        evd("await dummy('zwischendurch.jpg');")
        reo = ev("""await app.flushAll(); const r = await app.openProject('Projekt Sonnendeck'); const d2 = app.state.data;
          return { r, neu: d2.files['zwischendurch.jpg'] && d2.files['zwischendurch.jpg'].neu === true };""")
        check(reo["r"]["added"] == 1 and reo["neu"], f"Datei, die bei geschlossener App kam, ist beim Öffnen „Neu“: {reo['r']}")
        saved = ev("""await app.flushAll(); const opfs = await navigator.storage.getDirectory();
          const a = await (await (await opfs.getDirectoryHandle('testroot')).getDirectoryHandle('Projekt Sonnendeck')).getDirectoryHandle('.ordnu');
          const j = JSON.parse(await (await (await a.getFileHandle('ordnu.json')).getFile()).text());
          return { first: j.firstScanDone, n: Object.keys(j.files).length, s: j.settings, ign: j.files['neu_fokus.jpg'].ignoreSuggest };""")
        check(saved["first"] and saved["n"] == 12 and saved["s"]["dateSuggestions"] is True and saved["ign"], f"In ordnu.json gespeichert: {saved}")
        files_after = evd("""const names = []; for await (const [n] of proj.entries()) names.push(n); return names.sort();""")
        check(files_after == [".ordnu", ".versteckt", "26.13.40", "Archiv", "Lieferung A", "Lieferung B", "Lieferung C", "alt_x.jpg", "neu_b.jpg", "neu_fokus.jpg", "zwischendurch.jpg"],
              f"Projektordner: nur .ordnu/ von der App angelegt: {files_after}")
        page.screenshot(path=os.path.join(OUT, "07_sonnendeck.png"))

        print("Rahmen")
        ev("""const tab = M.createTab('Rahmentest'); d.tabs.push(tab); app.switchTab(tab.id);
          B.view = { x: 0, y: 0, scale: 1 }; B.applyView();
          await app.placeImage('alt_x.jpg', 100, 100, { centered: false });
          await app.placeImage('neu_b.jpg', 700, 100, { centered: false });
          await app.placeImage('neu_fokus.jpg', 100, 600, { centered: false });
          B.setSelection([]); return true;""")
        vpb = page.locator("#viewport").bounding_box()
        def scr(wx, wy):
            v = ev("return B.view;")
            return vpb["x"] + v["x"] + wx * v["scale"], vpb["y"] + v["y"] + wy * v["scale"]
        def items():
            return ev("return app.state.data.items.filter(i => i.tab === app.state.data.activeTab).map(i => ({ ...i }));")
        def frames():
            return [i for i in items() if i["type"] == "frame"]
        def by(path):
            return [i for i in items() if i.get("path") == path][0]

        # Anlegen per Ziehen (Knopf), danach gleich benennen
        page.click("#btn-frame")
        check(ev("return B.tool;") == "frame" and page.locator("#btn-frame.active").count() == 1, "Knopf „Rahmen“ aktiviert das Werkzeug")
        x1, y1 = scr(60, 60); x2, y2 = scr(480, 400)
        drag(x1, y1, x2, y2)
        f = frames()
        check(len(f) == 1 and abs(f[0]["x"] - 60) <= 1 and abs(f[0]["w"] - 420) <= 1 and abs(f[0]["h"] - 340) <= 1,
              f"Rahmen aufgezogen: {[(r['x'], r['y'], r['w'], r['h']) for r in f]}")
        check(ev("return B.tool;") is None, "Werkzeug danach wieder aus")
        check(page.locator("input.frame-rename").count() == 1, "Nach dem Anlegen: Namensfeld offen")
        page.fill("input.frame-rename", "Shot 010")
        page.keyboard.press("Enter")
        check(frames()[0]["name"] == "Shot 010" and page.locator("input.frame-rename").count() == 0, "Rahmen benannt (Enter)")
        check(frames()[0]["rule"] is None and frames()[0]["color"] == "standard", "Leeres Regel-Feld + Standardfarbe")
        order = page.eval_on_selector_all("#world > .item", "n => n.map(x => x.classList.contains('frame') ? 'F' : 'I')")
        check(order[0] == "F" and "F" not in order[1:], f"Ebene: Rahmen hinter den Bildern: {order}")

        # Taste R + Klick ohne Ziehen = Standardgröße; Esc behält Standardnamen
        page.locator("#viewport").focus()
        page.keyboard.press("r")
        cx, cy = scr(1000, 650)
        page.mouse.click(cx, cy)
        page.keyboard.press("Escape")
        fd = [r for r in frames() if r["name"] == "Rahmen"]
        check(len(fd) == 1 and fd[0]["w"] == 480 and fd[0]["h"] == 320 and abs(fd[0]["x"] + 240 - 1000) <= 1,
              "Taste R + Klick: Rahmen in Standardgröße um den Klickpunkt, Esc behält Namen")

        # Rahmen um Auswahl (Strg+G)
        bx, by_ = scr(860, 220)
        page.mouse.click(bx, by_)
        page.keyboard.press("Control+g")
        page.keyboard.press("Escape")
        b = by("neu_b.jpg")
        fb = [r for r in frames() if r["x"] == b["x"] - 40 and r["y"] == b["y"] - 40]
        check(len(fb) == 1 and fb[0]["w"] == b["w"] + 80 and fb[0]["h"] == b["h"] + 80, "Strg+G: Rahmen um Auswahl mit Rand")
        fb_id = fb[0]["id"]
        page.mouse.click(scr(1100, 450)[0], scr(1100, 450)[1])
        page.click('#viewport')  # Fokus zurück
        page.mouse.click(scr(860, 220)[0], scr(860, 220)[1])
        page.click(".overlay .frame-around")
        page.keyboard.press("Escape")
        check(len(frames()) == 4, "Knopf „Rahmen um Auswahl“ in der Auswahl-Leiste")
        ev("app.undo(); return true;")
        check(len(frames()) == 3, "… rückgängig")

        # Verschachtelt: kleiner Rahmen im Rahmen „Shot 010“
        ev("app.addFrame({ x: 80, y: 80, w: 200, h: 150 }, { rename: false }); B.setSelection([]); return true;")
        f010 = [r for r in frames() if r["name"] == "Shot 010"][0]
        inner = [r for r in frames() if r["w"] == 200][0]
        a0, c0, b0 = by("alt_x.jpg"), by("neu_fokus.jpg"), by("neu_b.jpg")
        lx, ly = center(f'#world .item.frame[data-id="{f010["id"]}"] .frame-label')
        drag(lx, ly, lx + 200, ly + 50)
        f010b = [r for r in frames() if r["id"] == f010["id"]][0]
        innerb = [r for r in frames() if r["id"] == inner["id"]][0]
        a1, c1, b1 = by("alt_x.jpg"), by("neu_fokus.jpg"), by("neu_b.jpg")
        check(round(f010b["x"] - f010["x"]) == 200 and round(f010b["y"] - f010["y"]) == 50, "Rahmen an der Beschriftung verschoben")
        check(round(a1["x"] - a0["x"]) == 200 and round(innerb["x"] - inner["x"]) == 200, "Inhalt wandert mit (inkl. verschachteltem Rahmen)")
        check(c1["x"] == c0["x"] and b1["x"] == b0["x"], "Elemente außerhalb bleiben stehen")
        ev("app.undo(); return true;")
        check(by("alt_x.jpg")["x"] == a0["x"] and [r for r in frames() if r["id"] == inner["id"]][0]["x"] == inner["x"]
              and [r for r in frames() if r["id"] == f010["id"]][0]["x"] == f010["x"], "Verschieben mit Inhalt = ein Rückgängig-Schritt")
        ev("app.redo(); app.undo(); return true;")

        # Auswählen: Inneres frei, Rand wählt Rahmen
        page.mouse.click(1350, 790)
        ix, iy = scr(680, 360)   # im Rahmen um B, aber nicht auf B und nicht am Rand
        page.mouse.click(ix, iy)
        check(ev("return B.selected.size;") == 0, "Klick ins leere Rahmen-Innere wählt nichts (startet Auswahlrahmen)")
        ex, ey = scr(661, 200)
        page.mouse.click(ex, ey)
        check(ev(f"return [...B.selected];") == [fb_id], "Klick auf den Rahmenrand wählt den Rahmen")
        page.mouse.click(1350, 790)
        drag(*scr(650, 50), *scr(1080, 400))
        sel = set(ev("return [...B.selected];"))
        check(fb_id in sel and b["id"] in sel, "Auswahlrahmen erfasst komplett umschlossenen Rahmen")
        page.mouse.click(1350, 790)
        drag(*scr(690, 90), *scr(900, 300))
        sel = set(ev("return [...B.selected];"))
        check(fb_id not in sel and b["id"] in sel, "Teilweise berührter Rahmen wird nicht erfasst")

        # Skalieren: nur der Rahmen, Seitenverhältnis frei
        page.mouse.click(1350, 790)
        page.mouse.click(ex, ey)
        f0 = [r for r in frames() if r["id"] == fb_id][0]
        hx, hy = center(".handle.corner.se")
        drag(hx, hy, hx + 100, hy + 30)
        f1 = [r for r in frames() if r["id"] == fb_id][0]
        check(round(f1["w"] - f0["w"]) == 100 and round(f1["h"] - f0["h"]) == 30 and f1["x"] == f0["x"], "Rahmen skaliert, Seitenverhältnis frei")
        check(by("neu_b.jpg")["w"] == b["w"] and by("neu_b.jpg")["x"] == b["x"], "Inhalt bleibt beim Skalieren stehen")
        page.keyboard.press("Control+z")
        check([r for r in frames() if r["id"] == fb_id][0]["w"] == f0["w"], "Skalieren rückgängig")

        # Farbe
        page.click('.overlay .color-dot[data-color="blau"]')
        col = page.eval_on_selector(f'#world .item.frame[data-id="{fb_id}"] .frame-label', "e => getComputedStyle(e).color")
        check([r for r in frames() if r["id"] == fb_id][0]["color"] == "blau" and col == "rgb(111, 168, 220)",
              f"Farbe geändert, Beschriftung in Rahmenfarbe: {col}")
        page.keyboard.press("Control+z")
        check([r for r in frames() if r["id"] == fb_id][0]["color"] == "standard", "Farbe rückgängig")
        page.keyboard.press("Control+Shift+z")

        # Umbenennen per Doppelklick auf die Beschriftung
        lx, ly = center(f'#world .item.frame[data-id="{fb_id}"] .frame-label')
        page.mouse.dblclick(lx, ly)
        check(page.locator("input.frame-rename").count() == 1, "Doppelklick auf Beschriftung öffnet Namensfeld")
        page.fill("input.frame-rename", "Varianten")
        page.keyboard.press("Enter")
        check([r for r in frames() if r["id"] == fb_id][0]["name"] == "Varianten", "Umbenannt")
        page.mouse.dblclick(lx, ly)
        page.fill("input.frame-rename", "Verworfen")
        page.keyboard.press("Escape")
        check([r for r in frames() if r["id"] == fb_id][0]["name"] == "Varianten", "Esc verwirft die Eingabe")
        page.keyboard.press("Control+z")
        check([r for r in frames() if r["id"] == fb_id][0]["name"] == "Rahmen", "Umbenennen rückgängig")
        page.keyboard.press("Control+Shift+z")

        # Löschen: nur der Rahmen, Inhalt bleibt
        page.mouse.click(1350, 790)
        page.mouse.click(ex, ey)
        page.keyboard.press("Delete")
        check(not [r for r in frames() if r["id"] == fb_id] and by("neu_b.jpg")["x"] == b["x"], "Rahmen gelöscht, Inhalt bleibt liegen")
        page.keyboard.press("Control+z")
        check(len([r for r in frames() if r["id"] == fb_id]) == 1, "Löschen rückgängig")

        # Alles zeigen berücksichtigt Rahmen; Beschriftung bei kleinem Zoom lesbar
        page.mouse.click(1350, 790)
        page.keyboard.press("f")
        fit = ev("""const r = document.getElementById('viewport').getBoundingClientRect();
          return [...document.querySelectorAll('#world .item.frame')].every(n => { const b = n.getBoundingClientRect();
            return b.left >= r.left - 1 && b.right <= r.right + 1 && b.top >= r.top - 1 && b.bottom <= r.bottom + 1; });""")
        check(fit, "F zeigt alle Rahmen")
        page.screenshot(path=os.path.join(OUT, "08_rahmen.png"))
        ev("B.view = { x: 300, y: 200, scale: 0.2 }; B.applyView(); return true;")
        hgt = ev("return document.querySelector('#world .item.frame .frame-label').getBoundingClientRect().height;")
        check(12 <= hgt <= 24, f"Beschriftung bei 20 % Zoom lesbar (Höhe {hgt:.1f} px)")
        page.screenshot(path=os.path.join(OUT, "09_rahmen_klein.png"))

        # Alles rückgängig / wiederholen
        cnt = ev("""let n = 0; while (app.undo()) n++; const empty = app.state.data.items.filter(i => i.tab === app.state.data.activeTab).length;
          let m = 0; while (app.redo()) m++; app.undo(); return { n, m, empty };""")
        # +1: das zuvor rückgängig gemachte Löschen liegt noch im Wiederholen-Stapel
        check(cnt["m"] == cnt["n"] + 1 and cnt["empty"] == 0 and len(frames()) == 4, f"Jeder Schritt rückgängig/wiederholbar: {cnt}")

        # Speichern und neu laden
        rl = ev("""await app.flushAll(); await app.openProject('Projekt Sonnendeck');
          const d2 = app.state.data; const t = d2.tabs.find(x => x.name === 'Rahmentest'); app.switchTab(t.id);
          return d2.items.filter(i => i.tab === t.id && i.type === 'frame').map(f => ({ name: f.name, color: f.color, rule: f.rule })).sort((a, b) => a.name.localeCompare(b.name));""")
        check(len(rl) == 4 and {r["name"] for r in rl} == {"Shot 010", "Varianten", "Rahmen"} and all(r["rule"] is None for r in rl),
              f"Rahmen gespeichert und neu geladen: {rl}")
        check(page.locator("#world .item.frame").count() == 4, "Rahmen nach Neuladen angezeigt")
        oldf = ev("return M.normalizeData({ version: 1, tabs: [{ id: 't', name: 'Alt' }], activeTab: 't', items: [{ id: 'f', tab: 't', type: 'frame', x: 0, y: 0, w: 100, h: 80 }] }).items[0];")
        check(oldf["name"] == "Rahmen" and oldf["color"] == "standard" and oldf["rule"] is None, "Unvollständige Rahmen-Daten werden ergänzt")

        print("Sicherheitssperre (eigenes Fenster, Sperre aktiv)")
        ctx_csp = browser.new_context()
        page = ctx_csp.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(base + "?nosw")
        page.wait_for_selector("#start:not([hidden])")
        blocked = page.evaluate("""async () => {
          const violations = [];
          document.addEventListener('securitypolicyviolation', e => violations.push(e.violatedDirective));
          let fetched = false;
          try { await fetch('https://example.com/'); fetched = true; } catch {}
          try { const img = new Image(); img.src = 'https://example.com/x.png'; await new Promise(r => setTimeout(r, 300)); } catch {}
          await new Promise(r => setTimeout(r, 200));
          return { fetched, violations };
        }""")
        check(not blocked["fetched"], "fetch nach außen blockiert")
        check(any(v.startswith("connect-src") for v in blocked["violations"]) and
              any(v.startswith("img-src") for v in blocked["violations"]),
              f"CSP meldet Verstöße: {blocked['violations']}")

        print("Service Worker")
        page2 = ctx_csp.new_page()
        page2.on("pageerror", lambda e: errors.append(str(e)))
        page2.goto(base)
        sw_ok = page2.evaluate("""async () => { const r = await navigator.serviceWorker.ready; return !!r.active; }""")
        check(sw_ok, "Service Worker aktiv")
        page2.reload()
        controlled = page2.evaluate("() => navigator.serviceWorker.controller !== null")
        check(controlled, "Seite wird vom Service Worker bedient")
        ctx_csp.set_offline(True)
        page2.reload()
        page2.wait_for_selector("body[data-ready='1']", timeout=5000)
        check(True, "App startet offline (Code aus dem Cache)")
        ctx_csp.set_offline(False)

        browser.close()

    real_errors = [e for e in errors if "example.com" not in e and "Content Security Policy" not in e
                   and "net::ERR_INTERNET_DISCONNECTED" not in e]
    check(not real_errors, f"Keine Fehler in der Konsole: {real_errors}")
    srv.shutdown()
    print()
    print("ALLES OK" if not failures else f"{len(failures)} FEHLER")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
