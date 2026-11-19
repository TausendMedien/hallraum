# Hallraum

**Ein Zuhause für deinen Podcast: transkribieren, gliedern, veröffentlichen**
*A home for your podcast: transcribe, structure, publish* · [English version](README.md)

Hallraum ist eine selbst gehostete Web-App, um Podcast-Folgen im Team fertigzustellen und zu veröffentlichen – mit durchsuchbarem Transkript, Kapitelmarken und Themen-Playlists, die über alle Folgen hinweg funktionieren.

Das Schneiden bleibt in den gewohnten Werkzeugen. Hallraum übernimmt alles danach: Transkription, Kapitel, Tags, Checkliste, Hörseite und (bald) den Podcast-Feed. Eine Installation kann mehrere Podcasts mit eigenen Teams und eigener Gestaltung verwalten.

> **Wie dieses Projekt entstanden ist**
> Hallraum ist als Spaßprojekt gestartet. Ich bringe 20 Jahre Entwicklungserfahrung mit, aber keine Programmiererfahrung: Der Code ist per *Vibecoding* entstanden, also im Gespräch mit einer KI (Claude Code). Ich habe beschrieben, was die App können soll, und die Ergebnisse getestet. Bitte entsprechend kritisch hinschauen – Hinweise, Fehlerberichte und Verbesserungen sind sehr willkommen.
> – Ulrich Tausend

## Sprachen

Hallraum wird auf Englisch entwickelt. **Deutsch** ist die erste weitere Sprache – und zwar nicht nur in den Menüs:

- **Oberfläche:** Englisch und Deutsch, pro Person wählbar (sonst nach Browsersprache). Die Hörseite spricht die Sprache des Podcasts.
- **Transkription:** Die gesprochene Sprache wird automatisch erkannt; der Transkriptions-Helfer nutzt sprachspezifische Vorgaben, damit Verzögerungslaute wortgetreu mitgeschrieben werden.
- **Füllwörter** werden pro Sprache erkannt. Deutsch hat eine eigene Liste (*äh, ähm, öh, hm …*), und Wörter, die in einer Sprache Füllwort, in einer anderen aber echtes Wort sind, werden richtig behandelt – z. B. ist englisches *um* ein Füllwort, deutsches *um* (wie in *um … zu*) nicht. Eine zweite Liste „weicher“ Füllwörter (*also, halt, sozusagen …*) ist für das geplante Modul „Auto-Schnitt“ vorbereitet.
- **Claude-Vorschläge** (optional) kommen in der Sprache des Podcasts.

Weitere Sprache hinzufügen: Wörterbuch in `app/locales/`, Füllwortlisten in `app/lib/languages.js` und eine Whisper-Vorgabe in `worker/worker.py`.

## Was Hallraum kann (Stufe 1)

**Redaktion**
- Login für das Team, Einladungslinks, Rollen Admin / Redaktion, mehrere Podcasts pro Installation
- Staffeln und Folgen, Upload des fertig geschnittenen Hauptteils (WAV, MP3, M4A); eine MP3 für die Veröffentlichung wird erzeugt
- Transkription über einen **Transkriptions-Helfer** auf einem eigenen Rechner (WhisperX: wortgenaue Zeitstempel, Sprechererkennung). Die Aufnahmen verlassen die eigene Infrastruktur nicht.
- Transkript-Editor: Wörter korrigieren, ohne Zeitstempel zu verlieren; Sprecher*innen benennen; Klick auf ein Wort springt im Player dorthin; Füllwörter werden markiert
- Kapitel und Abschnitte mit Tags – Vorschläge von Claude (optional) übernehmen oder eigene anlegen, indem man im Transkript Text markiert
- Gemeinsame Tag-Liste pro Podcast: umbenennen und zusammenführen
- Checkliste pro Folge (automatisch erkannte und manuelle Schritte), Übersicht mit Fortschritt und nächstem Schritt
- Änderungsprotokoll („zuletzt geändert von …“) und Hinweis bei gleichzeitigem Bearbeiten

**Hörseite** (pro Podcast unter `/<kurzname>`)
- Player mit Tempo, ±15 Sekunden, gemerkter Position und Tastaturbedienung
- Kapitelliste mit Hervorhebung, mitlaufendes Transkript, Klick auf ein Wort springt dorthin
- Suche in der Folge und über alle Folgen
- Themen-Playlists: alle Abschnitte zu einem Tag aus allen Folgen nacheinander hören
- Link auf eine bestimmte Stelle (`?t=Sekunden`), Inhaltshinweise vor dem Abspielen
- Gestaltung pro Podcast (Farben, Muster, Cover), barrierearm (Tastatur, Kontraste, Transkript als echter Text)

**Geplant:** Teaser und Intro-Mischung, RSS-Feed mit Kapiteln und Transkript (Podcasting 2.0), geplantes Veröffentlichen, Gast-Freigabe, Glossar, einbettbarer Player, Social-Media-Clips, Modul „Auto-Schnitt“ (Füllwörter und Pausen mit einstellbarer Stärke entfernen).

## Aufbau

| Teil | Ordner | Läuft wo |
|---|---|---|
| Web-App (Redaktion + Hörseite) | `app/` | Webserver mit Node.js ≥ 22.13 |
| Transkriptions-Helfer | `worker/` | Eigener Rechner, z. B. ein Mac (Python oder Docker) |
| Daten (SQLite + Audio) | `data/` | Neben der App – **nicht** ins Git |

Der Helfer fragt die App nach Aufträgen. Er braucht keine offenen Ports, und die App funktioniert auch, wenn er ausgeschaltet ist – Aufträge warten dann einfach.

## Lokal ausprobieren

Voraussetzungen: Node.js ≥ 22.13, ffmpeg (`brew install ffmpeg`), für den Helfer Python 3.10–3.13.

```bash
cp .env.example .env            # ausfüllen, mindestens WORKER_TOKEN (openssl rand -base64 32)
cd app
npm install
npm run admin -- --name "Anna" --email anna@example.org --podcast "Mein Podcast" --slug mein-podcast --language de
node --env-file=../.env server.js
```

Dann <http://localhost:3000/admin> öffnen und oben rechts die Sprache wählen. In einem zweiten Terminal den Helfer starten:

```bash
cd app
npm run worker
```

(`npm run worker` macht dasselbe.) Beim ersten Start richtet sich der Helfer eine Python-Umgebung ein und lädt die Whisper-Modelle (zusammen einige GB). Er läuft nur, solange das Terminal offen ist – beenden mit Ctrl+C.

Alternativ mit Docker: `docker compose up --build` startet App und Helfer zusammen.

## Transkriptions-Helfer

- Gegen einen Server im Internet: in `.env` `WORKER_APP_URL=https://podcast.example.org` setzen, dann `npm run worker`
- Modell: `WHISPER_MODEL=large-v3-turbo` (Standard, etwa Echtzeit auf einem aktuellen Mac) oder `large-v3` (genauer, deutlich langsamer)
- Sprechererkennung: Hugging-Face-Konto anlegen, die Bedingungen von `pyannote/speaker-diarization-community-1` akzeptieren, Token als `HF_TOKEN` eintragen. Ohne Token wird alles einer Person zugeordnet.

## Claude-Vorschläge (optional)

Mit `ANTHROPIC_API_KEY` in der `.env` schlägt Claude Kapitel sowie Abschnitte mit Tags vor. Dabei wird **nur der Transkript-Text** an die Claude-API geschickt, nie das Audio. Ohne Schlüssel funktioniert alles andere wie gewohnt.

## Auf einem Server installieren

Siehe [README.md](README.md#installing-on-a-server) – kurz: `git clone`, in `app/` `npm ci --omit=dev`, Node-Anwendung mit Startdatei `app/server.js` und den Umgebungsvariablen `WORKER_TOKEN`, optional `ANTHROPIC_API_KEY`, `DATA_DIR` (außerhalb des öffentlichen Web-Verzeichnisses) einrichten, HTTPS aktivieren, einmal `create-admin.js` ausführen, Upload-Limit auf mindestens 1 GB setzen.

## Lizenz

[GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-or-later).

Kurz gesagt: Du darfst Hallraum frei nutzen, verändern und weitergeben. Wenn du eine **veränderte** Version als Web-Dienst für andere betreibst, musst du deren Nutzer*innen den Quellcode deiner Änderungen zugänglich machen. Wer Hallraum unverändert einsetzt und nur über die Einstellungen anpasst, hat keine zusätzlichen Pflichten.
