# Guide

> **Important for error reports:** switch on the **Diagnostic log** at the bottom of the page *before* you connect to the scooter. Only then is the full connection handshake captured - and those are exactly the lines we need in a [ticket](https://github.com/Laufbursche42/Laufbursche42/issues) to reproduce a problem.

## What you need
- An AUGMENT e-scooter (family ECO/ECA/ECB/ECC, HX or ECD/360).
- A phone or computer with **Chrome**, **Edge**, or on iOS **Bluefy**. Safari and Firefox cannot do Web Bluetooth.

## Connecting
1. Turn on Bluetooth and wake the scooter.
2. Tap **Connect** and pick the scooter from the list.
3. If it is not listed, tick **Show all devices** and try again. The real check is the Bluetooth service found, not the advertised name.
4. On connect the page auto-detects the scheme (ECO/ECA/ECB/ECC, HX or ECD/360) from whichever service is present and shows it in the **GATT scheme** tile.
5. The live-values and speed cards then appear.

## Reading live values
The scooter pushes its status over several characteristics. Each tile appears once its value has arrived; a dash just means that value has not come in yet. Decoded and proven: speed, battery level and voltage, total mileage, and the raw settings word plus the speed region derived from it. Below the tiles, **All received characteristics** lets you follow the raw bytes per UUID, including the ones with no proven decoder (resistance, BMS, ECD frames).

## Speed
AUGMENT has no app-proven write register for speed. The limit is a region inside the settings bitfield (bits 10-11). The app builds the write buffer itself (deviceSettingsToBuf) and fetches a lock/unlock password from its GraphQL backend. Neither is recoverable from the static app. So the card only shows the region read and deliberately writes nothing. Reading works; a write path would need an on-wire sniff on the device.

## Advanced settings (engine level)
**Send raw bytes** writes your hex bytes unchanged to the command characteristic (classic `0000D101`, HX `00006682`). **Build bytes** puts the first byte in front of the rest and sends the sequence, with no checksum, because AUGMENT has none. Both senders ask first via a dialog. An echo only means accepted; only a change in the live values proves anything took effect.

## Shortcuts
Copy the link to your home screen, then one tap opens the page and connects. On iOS via Bluefy, and the scooter must have been connected normally once before. It triggers no write command.

## If something does not work
- Cannot connect? Check that the browser supports Web Bluetooth, Bluetooth is on and the scooter is awake. Retry with **Show all devices**.
- **GATT scheme** tile stays empty? Then none of the three known services was found; use **Diagnostics: list all devices** to see which services your device really exposes.
- **Diagnostics: list all devices** in the log area shows every Bluetooth service of a device without writing anything - useful for support.

## Contribute
Want to find out if and how tuning works on your scooter? Test this tool on your own vehicle and open a ticket on [GitHub](https://github.com/Laufbursche42/Laufbursche42/issues) - with your model and what worked (or did not). That way we figure out together what is possible on which model.
