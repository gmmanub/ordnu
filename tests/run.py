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
        page.click("#image-list li:nth-child(1)")
        page.click("#image-list li:nth-child(2)")
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

        print("Tabs")
        page.click("#btn-add-tab")
        page.fill("#tabs input", "Moods")
        page.keyboard.press("Enter")
        tabs = page.eval_on_selector_all("#tabs .tab", "b => b.map(x => x.textContent)")
        check(tabs == ["Board", "Moods"], f"Tab angelegt und umbenannt: {tabs}")
        check(page.locator("#world .item").count() == 0, "Neuer Tab ist leer")
        page.click("#image-list li:nth-child(3)")
        page.wait_for_function("document.querySelectorAll('#world .item').length === 1")
        page.click("#tabs .tab >> nth=0")
        check(page.locator("#world .item").count() == 2, "Zurück im ersten Tab: 2 Bilder")
        page.screenshot(path=os.path.join(OUT, "03_board.png"))

        print("Löschen vom Board (Datei bleibt)")
        page.locator("#world .item").nth(1).click()
        page.keyboard.press("Delete")
        check(page.locator("#world .item").count() == 1, "Bild vom Board entfernt")

        print("Rückgängig / Wiederholen")
        page.locator("#viewport").focus()
        page.keyboard.press("Control+z")
        check(page.locator("#world .item").count() == 2, "Strg+Z: Entfernen rückgängig")
        moods = "async () => { const d = (await import('./js/app.js')).state.data; return d.items.filter(i => i.tab !== d.activeTab).length; }"
        page.keyboard.press("Control+z")
        check(page.evaluate(moods) == 0, "Strg+Z: Bild im Tab „Moods“ rückgängig (Schritte in Reihenfolge, auch tabübergreifend)")
        page.keyboard.press("Control+Shift+z")
        check(page.evaluate(moods) == 1, "Strg+Umschalt+Z: wiederholt")
        page.keyboard.press("Control+Shift+z")
        check(page.locator("#world .item").count() == 1, "Strg+Umschalt+Z: Entfernen wiederholt")
        page.keyboard.press("Control+y")
        check(page.locator("#world .item").count() == 1, "Strg+Y bei leerem Verlauf: nichts passiert")
        steps = page.evaluate("""async () => {
          const app = await import('./js/app.js');
          let n = 0; while (app.undo()) n++;
          const empty = document.querySelectorAll('#world .item').length;
          const tabs = document.querySelectorAll('#tabs .tab').length;
          let m = 0; while (app.redo()) m++;
          return { n, m, empty, tabs, after: document.querySelectorAll('#world .item').length,
                   tabsAfter: [...document.querySelectorAll('#tabs .tab')].map(b => b.textContent) };
        }""")
        check(steps["n"] == 7 and steps["empty"] == 0 and steps["tabs"] == 1,
              f"Alle 7 Schritte rückgängig bis zum leeren Board: {steps}")
        check(steps["m"] == 7 and steps["after"] == 1 and steps["tabsAfter"] == ["Board", "Moods"],
              "Alle Schritte wiederholt")
        many = page.evaluate("""async () => {
          const app = await import('./js/app.js');
          for (let i = 0; i < 250; i++) await app.placeImage('test_motiv_a.jpg', i * 5, 0);
          let n = 0; while (app.undo()) n++;
          while (app.redo()) {}
          for (let i = 0; i < 250; i++) app.undo();
          return { n, limit: app.UNDO_STEPS };
        }""")
        check(many["n"] == many["limit"] == 200, f"Verlauf hält {many['limit']} Schritte: {many['n']}")
        check(page.locator("#world .item").count() == 51, "Nach 200× Rückgängig bleiben die 50 ältesten Schritte stehen")
        # aufräumen: zurück auf 1 Bild
        page.evaluate("""async () => {
          const app = await import('./js/app.js');
          const s = app.state; s.data.items = s.data.items.filter(i => i.path !== 'test_motiv_a.jpg' || i.tab !== s.data.activeTab || i === s.data.items.find(x => x.tab === s.data.activeTab));
        }""")

        print("Speichern")
        data = page.evaluate("""async () => {
          const app = await import('./js/app.js');
          await app.flushSave();
          const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('testroot');
          const p = await root.getDirectoryHandle('Projekt Apfelbaum');
          const files = [];
          for await (const [n] of p.entries()) files.push(n);
          const appDir = await p.getDirectoryHandle('.ordnu');
          const thumbs = [];
          for await (const [n] of (await appDir.getDirectoryHandle('vorschau')).entries()) thumbs.push(n);
          const json = JSON.parse(await (await (await appDir.getFileHandle('ordnu.json')).getFile()).text());
          return { files: files.sort(), thumbs: thumbs.length, json };
        }""")
        j = data["json"]
        check(j["version"] == 1, "ordnu.json mit Version 1")
        check([t["name"] for t in j["tabs"]] == ["Board", "Moods"], "Tabs gespeichert")
        check(len(j["items"]) == 2, f"2 Elemente gespeichert (1+1): {len(j['items'])}")
        check(data["thumbs"] == 6, f"3 Vorschaubilder + 3 Maß-Dateien in .ordnu/vorschau: {data['thumbs']}")
        check(data["files"] == [".ordnu", "Anlieferung", "notiz.txt", "render.exr", "test_motiv_a.jpg", "test_motiv_b.png"],
              f"Originaldateien unverändert: {data['files']}")
        c_item = [i for i in j["items"] if i["path"] == "Anlieferung/test_motiv_c_v2.jpg"]
        check(len(c_item) == 1 and abs(c_item[0]["h"] - round(320 * 858 / 2048)) <= 1, "Seitenverhältnis übernommen")

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
