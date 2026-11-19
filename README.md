# ordnu

Lokales Bilder-Board (Miro-artig) für vertrauliche Projektbilder. Läuft in Chrome/Edge.
**Bilder und Daten bleiben im eigenen Ordner – die App sendet nichts ins Internet.**

App: https://gmmanub.github.io/ordnu/

## Kurzanleitung

1. Die Adresse oben in Chrome oder Edge öffnen. Tipp: Im Browser-Menü „App installieren“ wählen, dann startet ordnu wie ein eigenes Programm.
2. **Hauptordner wählen** (z. B. `C:\Projekte`). Jeder Unterordner darin ist ein Projekt.
3. Projekt anklicken. Links erscheinen alle Bilder des Projekts (auch aus Unterordnern).
4. Bild anklicken oder auf die Fläche ziehen, um es aufs Board zu legen.

| Aktion | Bedienung |
|---|---|
| Fläche verschieben | Leertaste + Ziehen, mittlere oder rechte Maustaste |
| Zoomen | Mausrad / Touchpad-Pinch |
| Alles zeigen | `F` |
| Mehrere auswählen | Umschalt + Klick oder Rahmen auf leerer Fläche aufziehen |
| Skalieren | Ecken der Auswahl ziehen |
| Vom Board entfernen | `Entf` oder Mülleimer (die Datei bleibt erhalten) |
| Rückgängig / Wiederholen | `Strg+Z` / `Strg+Umschalt+Z` – je Tab, bleibt auch nach dem Schließen erhalten |
| Ausschnitt / Bildtransform | Doppelklick aufs Bild: Kanten ziehen, Bild verschieben, gelbe Punkte = größer/kleiner, weißer Kreis = drehen (Umschalt: 15°), `Esc` = fertig |
| Tabs | Doppelklick = umbenennen, ziehen = sortieren, × = löschen |

Gespeichert wird automatisch in `<Projekt>/.ordnu/` (Boards, Tags, Vorschaubilder, Verlauf).
Die eigenen Bilder werden nie verändert, verschoben oder gelöscht.

## Sicherheit
- Sicherheitssperre (Content-Security-Policy): Die App kann technisch keine Verbindungen nach außen aufbauen.
- Projektordner außerhalb von OneDrive, Laufwerk verschlüsseln, Backup auf eigenen USB-Stick.

## Entwicklung
- Festlegungen und Roadmap: [PFLICHTENHEFT.md](PFLICHTENHEFT.md)
- Test: `python3 tests/run.py` (Chrome headless, nur Dummy-Bilder)
- Bei jeder Code-Änderung `VERSION` in `sw.js` erhöhen.
- NDA: niemals echte Projektbilder oder -namen ins Repo.
