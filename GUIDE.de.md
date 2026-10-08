# Anleitung

> **Wichtig für Fehler-Reports:** Schalte unten auf der Seite den **Diagnose-Log** ein, *bevor* du dich mit dem Scooter verbindest. Nur dann wird der komplette Verbindungsaufbau mitgeschnitten - und genau diese Zeilen brauchen wir in einem [Ticket](https://github.com/Laufbursche42/Laufbursche42/issues), um ein Problem nachzuvollziehen.

## Was du brauchst
- Einen AUGMENT E-Scooter (Familie ECO/ECA/ECB/ECC, HX oder ECD/360).
- Ein Handy oder einen Rechner mit **Chrome**, **Edge** oder auf iOS **Bluefy**. Safari und Firefox können kein Web Bluetooth.

## Verbinden
1. Bluetooth am Gerät einschalten, den Scooter einschalten (wecken).
2. Auf **Verbinden** tippen und den Scooter in der Liste auswählen.
3. Taucht er nicht auf, setze den Haken bei **Alle Geräte zeigen** und verbinde erneut. Der echte Test ist der gefundene Bluetooth-Dienst, nicht der angezeigte Name.
4. Beim Verbinden erkennt die Seite automatisch das Schema (ECO/ECA/ECB/ECC, HX oder ECD/360) aus dem vorhandenen Dienst und zeigt es in der Kachel **GATT-Schema**.
5. Danach erscheinen die Karten für Live-Werte und Geschwindigkeit.

## Live-Werte lesen
Der Scooter pusht seinen Status über mehrere Charakteristiken. Jede Kachel erscheint, sobald ihr Wert angekommen ist; ein Strich heißt nur, dass dieser Wert noch nicht kam. Dekodiert und belegt sind: Tempo, Akku-Stufe und Akkuspannung, Gesamtkilometer sowie die rohe Einstellungs-Zahl und daraus die Tempo-Region. Unter den Kacheln kannst du mit **Alle empfangenen Charakteristiken** die Rohbytes pro UUID mitlesen, auch die, für die es keinen belegten Dekoder gibt (Widerstand, BMS, ECD-Frames).

## Geschwindigkeit
AUGMENT hat kein aus der App belegtes Schreib-Register für das Tempo. Das Limit steckt als Region im Einstellungs-Bitfeld (Bits 10-11). Die App baut den Schreibpuffer selbst (deviceSettingsToBuf) und holt sich für Sperren und Entsperren ein Passwort aus dem GraphQL-Backend. Beides lässt sich aus der statischen App nicht rekonstruieren. Deshalb zeigt die Karte nur die gelesene Region an und schreibt bewusst nichts. Lesen funktioniert, ein Schreibpfad bräuchte einen Mitschnitt am Gerät.

## Erweiterte Einstellungen (Engine-Ebene)
**Rohe Bytes** schreibt deine Hex-Bytes unverändert an die Befehls-Charakteristik (klassisch `0000D101`, HX `00006682`). **Bytes bauen** setzt das erste Byte vor den Rest und sendet die Folge, ohne Prüfsumme, denn AUGMENT hat keine. Beide Sender fragen vorher per Dialog nach. Ein Echo heißt nur: angenommen. Erst eine Änderung in den Live-Werten beweist, dass etwas wirkt.

## Shortcuts
Kopiere den Link auf den Startbildschirm, dann öffnet ein Tipp die Seite und verbindet. Auf iOS über Bluefy, und der Scooter muss vorher einmal normal verbunden gewesen sein. Ein Schreibbefehl wird dabei nicht ausgelöst.

## Wenn etwas nicht geht
- Kein Verbinden? Prüfe, dass der Browser Web Bluetooth kann, Bluetooth an ist und der Scooter wach ist. Mit **Alle Geräte zeigen** erneut versuchen.
- Kachel **GATT-Schema** bleibt leer? Dann wurde keiner der drei bekannten Dienste gefunden; schau mit **Diagnose: alle Geräte auflisten** nach, welche Dienste dein Gerät wirklich hat.
- **Diagnose: alle Geräte auflisten** im Log-Bereich zeigt alle Bluetooth-Dienste eines Geräts, ohne etwas zu schreiben - hilfreich für Support.

## Mithelfen
Willst du herausfinden, ob und wie Tuning bei deinem Scooter geht? Teste dieses Tool an deinem eigenen Fahrzeug und öffne ein Ticket auf [GitHub](https://github.com/Laufbursche42/Laufbursche42/issues) - mit deinem Modell und was funktioniert hat (oder nicht). So finden wir gemeinsam heraus, was bei welchem Modell möglich ist.
