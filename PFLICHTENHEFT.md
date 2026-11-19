# ordnu – Pflichtenheft

Stand: 19.11.2026 · Status: V1 freigegeben, Bau läuft

Lokale Bilder-Board-App (Miro-artig) für vertrauliche Projektbilder. Laptop zuerst (Windows, Chrome/Edge).

---

## 0. Grundregeln (haben Vorrang vor allem anderen)

### 0.1 NDA-Regel
- Niemals echte Projektbilder, Shot-, Projekt- oder Kundennamen in Repo, Code, Tests, Chats oder Projektdokumente.
- Für Tests nur selbst erzeugte Dummy-Bilder und Fantasienamen.
- Keine Dateien über die GitHub-Webseite per Drag & Drop hochladen.
- `.gitignore` sperrt `.ordnu/` sowie alle Bild-, Video- und Projektdateien (siehe dort).

### 0.2 Nichts ins Internet
- Keine Cloud-Dienste, keine KI-Dienste, keine Analyse/Telemetrie, keine externen Schriften/CDNs.
- **Sicherheitssperre (Content-Security-Policy)** in `index.html`: Die App darf nur Dateien vom eigenen Ursprung laden und keine Verbindungen zu anderen Servern aufbauen (`connect-src 'self'`). Jede neue Funktion muss mit dieser Sperre funktionieren – die Sperre wird nie gelockert.
- Spracherkennung nur offline (Whisper lokal). Das Modell liegt im Repo und wird wie der übrige Code geladen und gecacht.

### 0.3 Dateien bleiben Manus Dateien
- Bilder bleiben normale Dateien in Manus Ordnern. Die App liest Bilder nur – sie verschiebt, löscht oder benennt sie nie um.
- Die App schreibt ausschließlich in den versteckten Unterordner `.ordnu/` im jeweiligen Projektordner.

---

## 1. Technik

| Punkt | Festlegung |
|---|---|
| Plattform | Web-App, nur Chrome/Edge (Desktop) – File System Access API |
| Hosting | Öffentliches Repo `gmmanub/ordnu` + GitHub Pages: `https://gmmanub.github.io/ordnu/` |
| Online liegt | nur Code (HTML/CSS/JS, später Whisper-Modell) |
| Offline | Service Worker cacht nur den App-Code (keine Bilder). Nach dem ersten Laden startet die App ohne Internet. |
| Abhängigkeiten | keine Frameworks, keine Build-Tools. Reines HTML/CSS/JS (ES-Module). |
| Browser-Speicher | nur der Ordner-Zugriff (Verweis auf den gewählten Ordner, IndexedDB), damit er nicht jedes Mal neu gewählt werden muss. Keine Bilder, keine Vorschauen, keine Projektdaten im Browser. |

### 1.1 Ordner-Modell
- Manu wählt einmal einen **Hauptordner** (z. B. `C:\Projekte`). Jeder Unterordner darin ist ein **Projekt** (Auswahlliste).
- Innerhalb eines Projekts werden Bilder in allen Unterordnern gefunden (rekursiv), außer in versteckten Ordnern (Name beginnt mit `.`).
- Chrome fragt bei jedem Start einmal nach Erlaubnis für den Ordner (Browser-Vorgabe, nicht abschaltbar).
- **Neue Dateien erkennen:** Knopf „Aktualisieren“, automatisch 1×/Stunde, beim Zurückwechseln in die App (höchstens alle 5 s) und – wenn Chrome es kann (`FileSystemObserver`) – bei Änderungen im Projektordner. Eigene Schreibvorgänge in `.ordnu/` lösen nichts aus. Verschwundene Dateien erscheinen auf dem Board als „Datei fehlt“.
- **„Neu“:** Bilder, die bei einer Aktualisierung (nicht beim allerersten Einlesen) gefunden werden – auch beim Öffnen des Projekts, wenn sie bei geschlossener App dazukamen. Gilt als gesehen, sobald das Bild auf irgendeinem Board liegt oder per „Alle als gesehen markieren“.
- **Ordner/Dateien aus dem Explorer aufs Board ziehen:** nur was im Projekt liegt (ordnu kopiert nie Dateien). Alle Bilder (rekursiv, ohne versteckte Ordner) als Raster um die Ablagestelle, Reihenfolge nach Name. Was im selben Tab schon liegt, wird übersprungen (andere Tabs egal). Hinweis „x neu platziert, y schon auf diesem Board“. Ein Drop = ein Rückgängig-Schritt.

### 1.2 App-Daten pro Projekt
```
<Projekt>/
  .ordnu/
    ordnu.json          Boards, Positionen, Rahmen, Notizen, Tags
    ordnu.backup.json   Kopie des Stands beim Öffnen des Projekts
    verlauf.json        Rückgängig-Verlauf je Tab (nur Unterschiede, 3 s nach Änderung gespeichert)
    vorschau/           Vorschaubilder (von der App erzeugt)
```
- Speichern automatisch, 1 s nach der letzten Änderung. Die Datei wird erst ersetzt, wenn sie vollständig geschrieben ist (kein Halb-Stand bei Absturz).
- `ordnu.json` hat eine `version`-Nummer (aktuell 1) für spätere Umstellungen.
- Bild-Elemente: `x, y, w, h` = sichtbarer Ausschnitt auf dem Board, `ar` = Seitenverhältnis des Originals, `crop = { ox, oy, scale, rot }` = Lage des Bildes im Ausschnitt (relativ zur Ausschnitt-Breite; Drehung in Grad). Ältere Elemente ohne `crop` werden automatisch ergänzt.
- `files` = je Bildpfad `{ eingang, mtime, neu?, ignoreSuggest? }`, `firstScanDone`, `settings.dateSuggestions` (siehe 1.5).
- `verlauf.json` fehlt oder ist defekt → leerer Verlauf, die App läuft normal weiter.
- Bilder werden über ihren **relativen Pfad** im Projekt erkannt. Umbenennen/Verschieben außerhalb der App trennt die Verbindung (Bild erscheint als „fehlt“). Wiederfinden umbenannter Dateien: später (siehe Roadmap).

### 1.3 Vorschaubilder
- Längste Seite 512 px, WebP, Qualität 0,8.
- Name: Hash aus relativem Pfad + Dateigröße + Änderungsdatum → ändert sich das Original, wird eine neue Vorschau erzeugt.
- Erzeugung im Hintergrund, Board bleibt bedienbar.

### 1.5 Datum und Tagessortierung
- Der Browser kennt nur das **Änderungsdatum** einer Datei (kein Erstelldatum).
- **Eingangsdatum** = Zeitpunkt, an dem ordnu die Datei zuerst sieht (in `files`). Beim allerersten Einlesen eines Projekts ersatzweise das Änderungsdatum.
- **Tagesordner** mit Namen exakt `JJ.MM.TT` (z. B. `26.11.19` = 19.11.2026; fest so gelesen, nur gültige Kalenderdaten, Jahr 20JJ) haben Vorrang; der nächstgelegene Ordner im Pfad zählt. Tagesordner sind optional.
- Automatische Werte stehen nicht in den Tags; die Tags `datum`/`uhrzeit` sind **von Hand** gesetzt und haben immer Vorrang (werden nie automatisch überschrieben). Ändern per Rechtsklick auf das Bild in der Bilderliste (Datumsfeld, „Automatisch“ = zurück). Rückgängig-fähig.
- **Tagessortierung:** Bilderliste nach Tag gruppiert, neueste oben (Überschrift z. B. „Do 19.11.2026“), Filter nach Tag und „Nur neue“.
- **Korrekturvorschlag:** Ist das Änderungsdatum mehr als 1 Tag älter als das Eingangsdatum, nicht in der Zukunft und höchstens 2 Jahre alt (und kein Tagesordner/kein Datum von Hand), schlägt die App „Dateidatum TT.MM.JJJJ übernehmen?“ vor (Übernehmen = Datum von Hand, Rückgängig-fähig; Ignorieren wird gemerkt). Abschaltbar pro Projekt (Schalter „Datum-Vorschläge“). Manu will das ausprobieren und ggf. wieder abschalten.

### 1.4 Bildformate
- V1: was Chrome selbst anzeigen kann – JPG, PNG, WebP, AVIF, GIF, BMP.
- Nicht in V1: TIFF, EXR, PSD, DPX, HEIC. Werden ignoriert. Prüfen, ob für TIFF/PSD eine Offline-Bibliothek infrage kommt (Roadmap).

---

## 2. Umfang

### V1 (freigegeben 19.11.2026)
- Projekte (Auswahlliste aus dem Hauptordner)
- Benennbare Board-Tabs pro Projekt (anlegen, umbenennen, löschen mit Rückfrage + 8 s „Rückgängig“, Reihenfolge per Ziehen; letzter Tab nicht löschbar)
- Unendliche Fläche: Verschieben, Zoomen (zum Mauszeiger hin)
- Bilder platzieren, verschieben, skalieren (Eck-Anfasser, Seitenverhältnis bleibt, Gruppe skaliert gemeinsam, Mindestkante 20)
- Auswahl: Klick, Umschalt+Klick, Auswahlrahmen (Umschalt = hinzufügen)
- Vom Board entfernen: `Entf` oder Mülleimer an der Auswahl (Originale werden nie angefasst)
- Neue Dateien erkennen + „Neu“-Markierung + Filter „Nur neue“; Ordner/Dateien aus dem Projekt aufs Board ziehen; Eingangsdatum, Tagessortierung, Korrekturvorschlag (siehe 1.1 und 1.5) – freigegeben 19.11.
- Ausschnitt / Bildtransform (nicht-destruktiv): Doppelklick aufs Bild; Enter/Esc/„Fertig“ beendet; Ausschnitt-Kanten ziehen, Bild im Ausschnitt verschieben, per Anfasser größer/kleiner (kein Mausrad), drehen per rundem Anfasser (Umschalt = 15°-Schritte), Knöpfe „90°“ und „Zurücksetzen“. Kein Drehen des ganzen Bildes auf dem Board. Gezoomte Ausschnitte nutzen das Original.
- Rahmen: Farbe, Name; Inhalt wandert beim Verschieben mit
- Notizzettel / Text
- Tags tippen: Datum (automatisch, siehe 1.5, korrigierbar), Uhrzeit, Absender, Shot, Variante, Version, freie Tags. Mehrere Bilder gleichzeitig taggen, Vorschläge aus vorhandenen Tags.
- Filter nach Tags
- Rückgängig/Wiederholen PRO TAB (freigegeben 19.11.): Strg+Z / Strg+Umschalt+Z (zusätzlich Strg+Y), wirkt nur im aktiven Tab. 200 Schritte je Tab, gilt für Inhalt (Bilder, Ausschnitt, später Rahmen, Notizen, Tags), nicht für Zoom/Ansicht. Tab umbenennen/sortieren/löschen nicht per Strg+Z (Löschen: „Rückgängig“-Hinweis). Verlauf bleibt über Tab-Wechsel und Schließen der App erhalten (`.ordnu/verlauf.json`). Tags hängen am Bild und gelten in allen Tabs; eine Tag-Änderung wird je Feld in dem Tab rückgängig gemacht, in dem sie gemacht wurde – wurde das Feld inzwischen in einem anderen Tab geändert, bleibt die spätere Änderung stehen (mit Hinweis).

#### Bau-Reihenfolge V1
1. Grundgerüst: Ordnerzugriff, Projektliste, `.ordnu/`, Speichern, Tabs, Fläche (Verschieben/Zoomen), Bilderliste mit Vorschauen, Bilder aufs Board legen und verschieben – fertig 19.11.
1b. Rückgängig/Wiederholen – fertig 19.11.
2. Bilder skalieren, Auswahlrahmen, Mülleimer, Tabs löschen/sortieren, Rückgängig pro Tab mit verlauf.json – fertig 19.11.
2b. Ausschnitt / Bildtransform – fertig 19.11.
2c. Neue Dateien erkennen, „Neu“, Ordner reinziehen, Eingangsdatum, Tagessortierung, Korrekturvorschlag – fertig 19.11.
3. Rahmen
4. Notizzettel / Text
5. Tags (Einzel + Mehrfach, Vorschläge; Datum-Datenebene steht schon)
6. Filter

### V1b (Vorschlag, Freigabe offen)
- Spracheingabe für Tags: Whisper offline, Push-to-talk, feste Schlüsselwörter („Datum 18. November, von …, Shot …, Variante B, Version 3“). Tippen geht immer.
- Modellgröße vs. GitHub-Grenzen prüfen (geschätzt 75–150 MB; GitHub-Grenze pro Datei 100 MB).

### V2 (Roadmap, Reihenfolge 19.11. neu festgelegt)
1. V2.0 Dateinamen-Schema pro Projekt einstellbar (Anlieferungen sind anfangs chaotisch benannt; ggf. mehrere Schemata je Absender) → Shot/Version/Variante automatisch als Tags; Rest wird von Hand getaggt
2. V2.1 Rahmen mit Regeln = automatisch einsortieren (z. B. Shot = SH010; neue passende Bilder landen dort, neueste Version vorne) + „neueste Variante je Shot“ – **Top-Priorität**
3. V2.2 Collections (virtuelle, verschachtelbare Sammlungen – Basis für Präsentation)
4. V2.3 Zeitleiste
5. V2.4 Vergleich (nebeneinander / Schieberegler)
6. V2.5 Präsentationsmodus (aus Collections)
7. V2.6 Pfeile
8. V2.7 Sprachbefehle fürs Board (baut auf V1b)

### V3 (Idee, vorgemerkt)
- Nutzung bleibt am Rechner (Laptop/ggf. Workstation), kein volles Board am Handy.
- Zwischenlösung: Präsentationen exportieren und verschicken, stark passwortgeschützt (Idee: eine einzelne verschlüsselte Datei, offline im Browser/Handy zu öffnen; Passwort über anderen Kanal). Achtung NDA: Bilder verlassen dabei bewusst den Rechner – Details in V3 klären.

### Später / ungeplant
- Umbenannte/verschobene Bilder wiederfinden (z. B. über Größe + Änderungsdatum)
- TIFF/PSD-Unterstützung prüfen

### Bewusst nicht
Zeichnen, Formen-Bibliothek, Vorlagen, Zusammenarbeit.

---

## 3. Bedienung V1 (Vorschlag Claude – nach erstem Ausprobieren mit Manu festlegen)

| Aktion | Bedienung |
|---|---|
| Fläche verschieben | Leertaste + Ziehen, mittlere Maustaste, oder Ziehen auf leerer Fläche mit Rechtsklick |
| Zoomen | Mausrad (zum Mauszeiger hin), Touchpad-Pinch |
| Zoom-Grenzen | 5 % – 800 % |
| Alles zeigen | Taste `F` |
| Auswahl | Klick, Umschalt+Klick, Auswahlrahmen auf leerer Fläche ziehen (Umschalt = hinzufügen) |
| Skalieren | Eck-Anfasser der Auswahl ziehen |
| Löschen vom Board | `Entf` oder Mülleimer – entfernt nur vom Board, nie die Datei |
| Rückgängig / Wiederholen | Strg+Z / Strg+Umschalt+Z (oder Strg+Y) – nur im aktiven Tab |
| Ausschnitt | Doppelklick aufs Bild; Kanten ziehen = Ausschnitt, im Bild ziehen = verschieben, runde gelbe Anfasser = größer/kleiner, weißer Kreis = drehen (Umschalt: 15°), Enter/Esc/Klick daneben = fertig |
| Neue Bilder | „Aktualisieren“ (sonst automatisch: beim Zurückwechseln, stündlich); „Nur neue“, „Alle als gesehen markieren“ |
| Ordner aufs Board | Ordner oder Bilder aus dem Projekt im Explorer packen und aufs Board ziehen |
| Datum | Rechtsklick auf ein Bild in der Bilderliste; Vorschläge „Übernehmen/Ignorieren“; Schalter „Datum-Vorschläge“ |
| Tabs | Doppelklick = umbenennen, ziehen = sortieren, × = löschen (mit Rückfrage) |

---

## 4. Sicherheit (organisatorisch)
- Projektordner außerhalb von OneDrive (z. B. `C:\Projekte\…`).
- Laufwerk verschlüsselt (BitLocker/VeraCrypt), Backup auf eigenen USB-Stick.
- Zwei-Faktor-Anmeldung für das GitHub-Konto einschalten, bevor die App mit echten NDA-Bildern genutzt wird (wer das Konto übernimmt, könnte den App-Code ändern).

---

## 5. Tests
- Automatische Tests laufen im Browser (Chrome headless) gegen einen Test-Ordner im Browser-eigenen Speicher (OPFS) mit selbst erzeugten Dummy-Bildern und Fantasienamen.
- Ausführen: `python3 tests/run.py` (siehe dort).
