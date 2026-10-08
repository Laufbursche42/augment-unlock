# Laufbursche AUGMENT unlock

A static web page that talks to AUGMENT e-scooters over Web Bluetooth. Connect, let the app detect which GATT scheme your scooter speaks (ECO/ECA/ECB/ECC, HX or ECD/360) and read the live telemetry straight from the browser. Nothing to install: no app store, no signing, no developer account. It runs in **Bluefy** on iOS and in **Chrome** or **Edge** on Android or desktop.

> **This is a feasibility study - and an honest one: reading works, every write is gated.** AUGMENT is a React Native app (`eco.augment.production`, `react-native-ble-plx`). The per-model BLE map does not live in native Java - it is in the Hermes bundle, and it was read out there byte by byte. **Reading is proven and implemented:** the service and characteristic UUIDs per scheme, and the little-endian decoders for speed (`readUInt16LE/10`), total mileage (`readUInt32LE/10`) and battery (`readUInt16LE`, level + voltage), plus the speed-limit region in the settings bitfield (bits 10-11). **Writing is not offered:** the settings-write buffer (`deviceSettingsToBuf`) byte layout is not in the bundle, the individual settings-flag bit positions (other than the region) are not pinned, and lock/unlock needs a password string fetched from AUGMENT's GraphQL backend that an offline page does not have. The one lock opcode in the bundle (`abc7010100`) is simulator mock data, not a real wire payload. So this page decodes and shows telemetry; the only write path is a confirm-gated expert raw-byte sender for anyone who has sniffed their own frames. Error-free operation is not promised and there is no warranty of any kind. Whatever you do with it, you do at your own risk - read the [Legal](#legal) section before you connect a scooter.

**Open the web app: [laufbursche42.github.io/augment-unlock](https://laufbursche42.github.io/augment-unlock/)**

Or run it yourself, no build step and no dependencies: clone the repo and serve the folder over a local HTTP server. Opening `index.html` directly as a `file://` URL will not work, the page fetches its own documents and browsers block that over `file://`.

```
git clone https://github.com/Laufbursche42/augment-unlock.git
cd augment-unlock
python -m http.server 8000
```

Any static server works. With Node installed, this does the same job:

```
npx serve .
```

Then open the printed address in a browser that supports Web Bluetooth.

**Guide: [Deutsch](GUIDE.de.md) | [English](GUIDE.en.md)** covers everything step by step, from connecting to reading the live values.

## What it does

- **Auto-detect** - on connect it probes the three AUGMENT GATT schemes and uses whichever your scooter exposes: classic (service `58336680`), HX short-form (`00006680`) or ECD/360 (`58337000`).
- **Live values** - GATT scheme, speed, speed region, battery level and voltage, total mileage, and the raw settings word. Each tile appears only once its value actually arrives.
- **All characteristics** - a running raw-bytes view per characteristic UUID, so nothing is hidden behind a decoder.
- **Speed** - an honest state card. It reads and shows the speed region; it does **not** write, because no write path is proven from the app.
- **Expert** - a confirm-gated raw-byte sender to the command characteristic (and a convenience "first byte + rest" builder), for people who have their own sniff. AUGMENT has no frame checksum, so bytes go out as typed.
- **Shortcut** - a home-screen link that opens the page and connects in one tap.

## Protocol (proven)

- Three GATT schemes. Classic (ECO/ECA/ECB/ECC): notify on service `58336680` chars `00006880` battery / `00006881` settings / `00006882` resistance / `00006883` speed / `00006884` lock / `00006885` mileage / `00006887` BMS; command write `0000D101` on service `5833D100`; OTA on `5833FF01`-`FF04`. HX: the same roles on the short-form service `00006680` (chars `0000668x`). ECD/360: a distinct ack-framed scheme on service `58337000`.
- No wire checksum: each characteristic value is one decoded field, pushed via notify. Little-endian throughout.
- Decoders: speed `readUInt16LE/10`, mileage `readUInt32LE/10`, battery `readUInt16LE` (`level=floor(v/4096)`, `voltage=floor((v%4096)/10)`), settings region = bits 10-11 of the settings word.

## Honesty

Device-untested by design - you read on your own scooter, which is the point of a public tool. The decoders are proven from the app and self-tested at load. Everything **not** proven is gated and named: the settings-write buffer, the non-region settings bits, the BMS/resistance decoders, the ECD/360 frame format, and lock/unlock (backend-authenticated). An echo in the log after an expert write means the scooter **accepted** the bytes; only a change in the live telemetry proves it took effect.

## Legal

License: PolyForm Noncommercial, see [License](LICENSE.md). Privacy: nothing leaves your device, see [Privacy](PRIVACY.md). Trademarks: AUGMENT is a trademark of its respective owner, this project is independent, see [Trademarks](TRADEMARKS.md).

Source: https://github.com/Laufbursche42/augment-unlock
