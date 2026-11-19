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

### 1.2 App-Daten pro Projekt
```
<Projekt>/
  .ordnu/
    ordnu.json          Boards, Positionen, Rahmen, Notizen, Tags
    ordnu.backup.json   Kopie des Stands beim Öffnen des Projekts
    vorschau/           Vorschaubilder (von der App erzeugt)
```
- Speichern automatisch, 1 s nach der letzten Änderung. Die Datei wird erst ersetzt, wenn sie vollständig geschrieben ist (kein Halb-Stand bei Absturz).
- `ordnu.json` hat eine `version`-Nummer (aktuell 1) für spätere Umstellungen.
- Bilder werden über ihren **relativen Pfad** im Projekt erkannt. Umbenennen/Verschieben außerhalb der App trennt die Verbindung (Bild erscheint als „fehlt“). Wiederfinden umbenannter Dateien: später (siehe Roadmap).

### 1.3 Vorschaubilder
- Längste Seite 512 px, WebP, Qualität 0,8.
- Name: Hash aus relativem Pfad + Dateigröße + Änderungsdatum → ändert sich das Original, wird eine neue Vorschau erzeugt.
- Erzeugung im Hintergrund, Board bleibt bedienbar.

### 1.4 Bildformate
- V1: was Chrome selbst anzeigen kann – JPG, PNG, WebP, AVIF, GIF, BMP.
- Nicht in V1: TIFF, EXR, PSD, DPX, HEIC. Werden ignoriert. Prüfen, ob für TIFF/PSD eine Offline-Bibliothek infrage kommt (Roadmap).

---

## 2. Umfang

### V1 (freigegeben 19.11.2026)
- Projekte (Auswahlliste aus dem Hauptordner)
- Benennbare Board-Tabs pro Projekt (anlegen, umbenennen, löschen, Reihenfolge)
- Unendliche Fläche: Verschieben, Zoomen (zum Mauszeiger hin)
- Bilder platzieren, verschieben, skalieren (Seitenverhältnis bleibt)
- Rahmen: Farbe, Name; Inhalt wandert beim Verschieben mit
- Notizzettel / Text
- Tags tippen: Datum (automatisch aus Datei, korrigierbar), Uhrzeit, Absender, Shot, Variante, Version, freie Tags. Mehrere Bilder gleichzeitig taggen, Vorschläge aus vorhandenen Tags.
- Filter nach Tags
- Rückgängig/Wiederholen (freigegeben 19.11.): Strg+Z / Strg+Umschalt+Z (zusätzlich Strg+Y). 200 Schritte, gilt für Inhalt (Bilder, Rahmen, Notizen, Tags, Tabs), nicht für Zoom/Ansicht. Verlauf nur für die laufende Sitzung (nicht in ordnu.json).

#### Bau-Reihenfolge V1
1. Grundgerüst: Ordnerzugriff, Projektliste, `.ordnu/`, Speichern, Tabs, Fläche (Verschieben/Zoomen), Bilderliste mit Vorschauen, Bilder aufs Board legen und verschieben – fertig 19.11.
1b. Rückgängig/Wiederholen – fertig 19.11.
2. Bilder skalieren, Mehrfachauswahl, Löschen vom Board
3. Rahmen
4. Notizzettel / Text
5. Tags (Einzel + Mehrfach, Vorschläge, Datum aus Datei)
6. Filter

### V1b (Vorschlag, Freigabe offen)
- Spracheingabe für Tags: Whisper offline, Push-to-talk, feste Schlüsselwörter („Datum 18. November, von …, Shot …, Variante B, Version 3“). Tippen geht immer.
- Modellgröße vs. GitHub-Grenzen prüfen (geschätzt 75–150 MB; GitHub-Grenze pro Datei 100 MB).

### V2 (Roadmap-Vorschlag, Reihenfolge nach Abhängigkeit)
1. V2.0 Collections (virtuelle, verschachtelbare Sammlungen – Basis für Präsentation)
2. V2.1 „Neueste Variante je Shot“ + Zeitleiste
3. V2.2 Vergleich (nebeneinander / Schieberegler)
4. V2.3 Präsentationsmodus (aus Collections)
5. V2.4 Pfeile
6. V2.5 Sprachbefehle fürs Board (baut auf V1b)

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
| Auswahl | Klick, Umschalt+Klick, Rahmen aufziehen auf leerer Fläche |
| Löschen vom Board | `Entf` – entfernt nur vom Board, nie die Datei |
| Rückgängig / Wiederholen | Strg+Z / Strg+Umschalt+Z (oder Strg+Y) |

---

## 4. Sicherheit (organisatorisch)
- Projektordner außerhalb von OneDrive (z. B. `C:\Projekte\…`).
- Laufwerk verschlüsselt (BitLocker/VeraCrypt), Backup auf eigenen USB-Stick.
- Zwei-Faktor-Anmeldung für das GitHub-Konto einschalten, bevor die App mit echten NDA-Bildern genutzt wird (wer das Konto übernimmt, könnte den App-Code ändern).

---

## 5. Tests
- Automatische Tests laufen im Browser (Chrome headless) gegen einen Test-Ordner im Browser-eigenen Speicher (OPFS) mit selbst erzeugten Dummy-Bildern und Fantasienamen.
- Ausführen: `python3 tests/run.py` (siehe dort).
