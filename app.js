'use strict';
/*
 * AUGMENT Tuning - Web Bluetooth. Implements the BLE transport proven from eco.augment.production.
 * Augment is a react-native app (react-native-ble-plx). There is no checksummed wire frame: each
 * characteristic carries one decoded value, pushed via notify. 9 adapters collapse onto 3 GATT schemes:
 * CLASSIC (ECO/ECA/ECB/ECC, service 58336680), HX short-form (00006680), 360/ECD (58337000, ack-framed).
 * This page auto-detects which scheme a connected scooter speaks.
 *
 * Read path (proven): service/char UUIDs per scheme; LE decoders speed=readUInt16LE/10,
 * mileage=readUInt32LE/10, battery readUInt16LE (level=floor(v/4096), voltage=floor((v%4096)/10)). The
 * 2-byte SETTINGS word is fully decoded by bufToDeviceSettings (decompiled.js:799674): unit, cruise,
 * zero-start, driving mode, light, eABS strength, locked, stepped speed-limit (bits 10-12), sound - each
 * with its proven bit offset + enum map (decompiled.js:801790). Firmware revision is read from the
 * standard DIS (0x180A/0x2A26, decompiled.js:799518-799520). Lock/resistance/BMS bytes are surfaced raw.
 * Write path: raw write frames go to the command characteristic of the detected scheme and are
 * confirm-gated (engine level). Nothing beyond the decoders is interpreted.
 */

// Pre-commit cache-buster auto-bumps BUILD and every ?v= on any web-asset change.
const BUILD = 'v3';

// --------------------------- UUIDs (proven from the app; Web Bluetooth wants lowercase) ---------------------------
const U = {
  // CLASSIC scheme (ECO/ECA/ECB/ECC) - telemetry/notify on service 58336680
  CLASSIC_SVC:  '58336680-9b8b-5191-6142-22a4536ef123',
  C_BATTERY:    '00006880-0000-1000-8000-00805f9b34fb',
  C_SETTINGS:   '00006881-0000-1000-8000-00805f9b34fb',
  C_RESISTANCE: '00006882-0000-1000-8000-00805f9b34fb',
  C_SPEED:      '00006883-0000-1000-8000-00805f9b34fb',
  C_LOCK:       '00006884-0000-1000-8000-00805f9b34fb',
  C_MILEAGE:    '00006885-0000-1000-8000-00805f9b34fb',
  C_BMS:        '00006887-0000-1000-8000-00805f9b34fb',
  // command / settings write on a separate service 5833d100
  CLASSIC_CMD_SVC: '5833d100-9b8b-5191-6142-22a4536ef123',
  CLASSIC_CMD:     '0000d101-0000-1000-8000-00805f9b34fb',
  // OTA (proven from the app, not wired - ships no firmware) on service 5833ff01
  OTA_SVC:      '5833ff01-9b8b-5191-6142-22a4536ef123',
  OTA_WRITE:    '5833ff02-9b8b-5191-6142-22a4536ef123',
  OTA_INDICATE: '5833ff03-9b8b-5191-6142-22a4536ef123',
  OTA_WNR:      '5833ff04-9b8b-5191-6142-22a4536ef123',
  // HX short-form - everything on service 00006680
  HX_SVC:       '00006680-0000-1000-8000-00805f9b34fb',
  H_BATTERY:    '00006681-0000-1000-8000-00805f9b34fb',
  H_SETTINGS:   '00006682-0000-1000-8000-00805f9b34fb',  // also the write char
  H_RESISTANCE: '00006683-0000-1000-8000-00805f9b34fb',
  H_SPEED:      '00006684-0000-1000-8000-00805f9b34fb',
  H_LOCK:       '00006687-0000-1000-8000-00805f9b34fb',
  H_MILEAGE:    '00006688-0000-1000-8000-00805f9b34fb',
  // 360 / ECD - distinct ack-framed scheme on service 58337000 (frame format not dumped -> raw only)
  ECD_SVC:      '58337000-0000-5191-6142-22a4536ef123',
  ECD_CMD:      '58337000-0001-5191-6142-22a4536ef123',
  ECD_READ:     '58337000-0006-5191-6142-22a4536ef123',
  // standard Device Information Service - firmware revision string (read by the app, decompiled.js:799518-799520)
  DIS_SVC:      '0000180a-0000-1000-8000-00805f9b34fb',
  DIS_FWREV:    '00002a26-0000-1000-8000-00805f9b34fb'
};

// the 3 GATT schemes; auto-detected at connect by which discovery service the device exposes
const SCHEMES = {
  classic: {
    name: 'ECO/ECA/ECB/ECC',
    service: U.CLASSIC_SVC,
    notify: { battery: U.C_BATTERY, settings: U.C_SETTINGS, resistance: U.C_RESISTANCE, speed: U.C_SPEED, lock: U.C_LOCK, mileage: U.C_MILEAGE, bms: U.C_BMS },
    writeService: U.CLASSIC_CMD_SVC, writeChar: U.CLASSIC_CMD
  },
  hx: {
    name: 'HX',
    service: U.HX_SVC,
    notify: { battery: U.H_BATTERY, settings: U.H_SETTINGS, resistance: U.H_RESISTANCE, speed: U.H_SPEED, lock: U.H_LOCK, mileage: U.H_MILEAGE },
    writeService: U.HX_SVC, writeChar: U.H_SETTINGS
  },
  ecd: {
    name: '360/ECD',
    service: U.ECD_SVC,
    notify: { cmd: U.ECD_CMD },
    writeService: U.ECD_SVC, writeChar: U.ECD_CMD, raw: true
  }
};
// kept as a list so the connect probe stays fleet-shaped (discovery + command + OTA services)
const CANDIDATE_SERVICES = [U.CLASSIC_SVC, U.HX_SVC, U.ECD_SVC, U.CLASSIC_CMD_SVC, U.OTA_SVC, U.DIS_SVC];

// model list is a label only - no protocol branching by model (the scheme is auto-detected on connect).
const MODELS = [
  ['es210', 'Augment ES210'],
  ['hx',    'Augment HX'],
  ['eca',   'Augment ECA'],
  ['alturo','Augment Alturo (ECB)'],
  ['ecc',   'Augment ECC'],
  ['360',   'Augment 360 (ECD)']
];
const DEFAULT_MODEL = 'auto';

// --------------------------- helpers ---------------------------
const $ = (id) => document.getElementById(id);
const hex = (arr) => Array.from(arr, b => (b & 0xff).toString(16).padStart(2, '0').toUpperCase()).join(' ');
const short = (u) => String(u).slice(0, 8).toUpperCase();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const LS = { THEME: 'augment_theme', PUBLOG: 'augment_publog', MODEL: 'augment_model' };

let dev = null, server = null, ch = null, busy = false;
let connected = false;
let scheme = null;              // detected scheme key once linked

// live device state, rebuilt from the push characteristics (tiles read from this)
const S = {
  scheme: null, speed: null, mileage: null, battLevel: null, battVolt: null, firmware: null,
  // SETTINGS word, fully decoded (bufToDeviceSettings, decompiled.js:799674)
  settingsRaw: null, unit: null, cruise: null, zeroStart: null, drivingMode: null, light: null,
  eabs: null, locked: null, speedStep: null, speedKmh: null, sound: null,
  lockRaw: null, resistanceRaw: null, bmsRaw: null
};
function resetState() { for (const k of Object.keys(S)) S[k] = null; }

// --------------------------- log (eg-unlock redaction pipeline: scrub secrets + anonymize PII) ---------------------------
let logBuffer = [];   // { raw, cls }
let publicLog = true; // anonymize device name/id/MAC on display/copy/save (default on)
let diag = false;     // verbose diagnostics (default off)
function redact(text) {
  let s = String(text);
  if (dev && dev.id) s = s.split(dev.id).join('[redacted-id]');
  s = s.replace(/\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g, '[redacted-mac]');
  s = s.replace(/\b(secret|token|key|aes|pwd|password|pin|mac|serial|vin|uid|imei)\b(\s*[:=]\s*)("?)([^\s",]+)\3/gi,
    (m, k, sep) => k + sep + '[redacted]');
  s = s.replace(/\b[0-9A-Fa-f]{16,}\b/g, '[redacted-hex]');
  return s;
}
// Unconditional secret scrubber, runs at the source before the buffer (independent of the Public Log toggle).
function maskSecrets(text) {
  let s = String(text);
  s = s.replace(/eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, '[redacted-jwt]');
  s = s.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***');
  s = s.replace(/\b(access[_-]?token|refresh[_-]?token|token|jwt|password|passwd|pwd|secret|code|otp)\b(\s*[:=]\s*)("?)([^\s",}]+)\3/gi,
    (m, k, sep) => k + sep + '***');
  return s;
}
function anonymize(s) {
  if (!publicLog) return String(s).replace(/\x01/g, '');
  return redact(String(s).replace(/\x01[^\x01]*\x01/g, 'XX').replace(/\x01/g, ''));
}
function logLine(cls, text) {
  const safe = '[' + new Date().toTimeString().slice(0, 8) + '] ' + maskSecrets(text);
  logBuffer.push({ raw: safe, cls: cls });
  const el = $('log'); if (!el) return;
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = anonymize(safe) + '\n';
  el.appendChild(span); el.scrollTop = el.scrollHeight;
}
function renderLog() {
  const el = $('log'); if (!el) return;
  el.textContent = '';
  for (const e of logBuffer) { const span = document.createElement('span'); if (e.cls) span.className = e.cls; span.textContent = anonymize(e.raw) + '\n'; el.appendChild(span); }
  el.scrollTop = el.scrollHeight;
}
function logText() { return logBuffer.map(e => anonymize(e.raw)).join('\n'); }
const logTx = (uuid, b) => logLine('log-tx', '>>> ' + short(uuid) + ' | ' + hex(b));
const logRx = (role, uuid, b) => logLine('log-rx', '<<< ' + short(uuid) + ' [' + role + '] | ' + hex(b));
const logSys = (t) => logLine('', '--- ' + t);
const logErr = (t) => logLine('log-err', '!!! ' + t);
const logDiag = (t) => { if (diag) logLine('', '... ' + t); };
// CRLF on Windows so the copied log pastes cleanly into Notepad.
function osNewline() { return (navigator.platform || '').toLowerCase().indexOf('win') === 0 ? '\r\n' : '\n'; }
function saveLog() {
  try {
    const blob = new Blob([logText().split('\n').join(osNewline())], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'laufbursche42-augment-log.txt';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    logSys('log saved');
  } catch (e) { logErr('save failed: ' + (e && e.message ? e.message : e)); }
}
function logDiagnosticHeader() {
  logLine('', '=== augment-unlock diagnostic ===');
  logLine('', 'build: ' + BUILD);
  logLine('', 'time: ' + new Date().toISOString());
  logLine('', 'userAgent: ' + (navigator.userAgent || '?'));
  logLine('', 'platform: ' + (navigator.platform || '?'));
  logLine('', 'webBluetooth: ' + (navigator.bluetooth ? 'yes' : 'no'));
  logLine('', 'protocol self-test: ' + (FRAME_OK ? 'OK' : 'FAILED'));
  logLine('', '================================');
}

// =========================================================================================
//  VERIFIED PROTOCOL CORE (code-proven from eco.augment.production; self-test below runs at load)
// =========================================================================================
// No checksummed frame - each characteristic value IS the decoded field (little-endian). The decoders
// below are proven; the 2-byte settings word is fully decoded by bufToSettings (bufToDeviceSettings,
// decompiled.js:799674) - unit, cruise, zero-start, driving mode, eABS, light, sound, lock and the
// stepped speed limit. Fields whose decode is not proven stay out of the UI (see the gated list).
const le16 = (b, i) => (b[(i || 0)] & 0xff) | ((b[(i || 0) + 1] & 0xff) << 8);
const le32 = (b, i) => (((b[(i || 0)] & 0xff)) + ((b[(i || 0) + 1] & 0xff) << 8) + ((b[(i || 0) + 2] & 0xff) << 16) + ((b[(i || 0) + 3] & 0xff) * 0x1000000)) >>> 0;
const getBits = (v, off, len) => (v >> off) & ((1 << len) - 1);
// SETTINGS enum maps - all proven at decompiled.js:801790 (numToUnit/numToDrivingMode/numToEABSStrength)
const DRIVEMODE_MAP = { 1: 'slow', 2: 'medium', 3: 'high', 4: 'custom' };
const EABS_MAP = { 0: 'off', 1: 'weak', 2: 'medium', 3: 'strong' };
// stepped speed-limit inverse of the encoder (bufToDeviceSettings, decompiled.js:799674): 0->10 1->15 2->20 3->25 4->-1 (uncapped)
const SPEEDLIMIT_MAP = { 0: 10, 1: 15, 2: 20, 3: 25, 4: -1 };
function bufToSpeed(b) { return b.length >= 2 ? le16(b, 0) / 10 : null; }            // km/h
function bufToMileage(b) { return b.length >= 4 ? le32(b, 0) / 10 : null; }          // km
function bufToBattery(b) { if (b.length < 2) return null; const v = le16(b, 0); return { level: Math.floor(v / 4096), voltage: Math.floor((v % 4096) / 10) }; }
// full 2-byte SETTINGS decode (bufToDeviceSettings, decompiled.js:799674; zero-start and sound are inverted in the app)
function bufToSettings(b) {
  if (b.length < 2) return null;
  const v = le16(b, 0);
  const step = getBits(v, 10, 3);                                  // bits 10-12
  return {
    raw: v,
    unit: getBits(v, 0, 1),                                        // bit 0: 0 kmh / 1 mph
    cruise: getBits(v, 1, 1) === 1,                                // bit 1
    zeroStart: getBits(v, 2, 1) === 0,                             // bit 2 (on when 0)
    drivingMode: getBits(v, 3, 2),                                 // bits 3-4: 1 slow..4 custom
    light: getBits(v, 5, 1) === 1,                                 // bit 5
    eabs: getBits(v, 6, 2),                                        // bits 6-7: 0 off..3 strong
    locked: getBits(v, 8, 1) === 1,                                // bit 8
    speedStep: step,
    speedKmh: Object.prototype.hasOwnProperty.call(SPEEDLIMIT_MAP, step) ? SPEEDLIMIT_MAP[step] : null,
    sound: getBits(v, 14, 1) === 0                                 // bit 14 (inverted)
  };
}

// decode a notified characteristic by its role, fold into S
function decodeChar(role, b) {
  if (role === 'speed') { S.speed = bufToSpeed(b); }
  else if (role === 'mileage') { S.mileage = bufToMileage(b); }
  else if (role === 'battery') { const r = bufToBattery(b); if (r) { S.battLevel = r.level; S.battVolt = r.voltage; } }
  else if (role === 'settings') {
    const r = bufToSettings(b);
    if (r) {
      S.settingsRaw = r.raw; S.unit = r.unit; S.cruise = r.cruise; S.zeroStart = r.zeroStart;
      S.drivingMode = r.drivingMode; S.light = r.light; S.eabs = r.eabs; S.locked = r.locked;
      S.speedStep = r.speedStep; S.speedKmh = r.speedKmh; S.sound = r.sound;
    }
  }
  else if (role === 'lock') { S.lockRaw = hex(b); }
  else if (role === 'resistance') { S.resistanceRaw = hex(b); }
  else if (role === 'bms') { S.bmsRaw = hex(b); }
  // lock/resistance/bms bytes are surfaced raw; the ecd cmd char is ack-framed and only logged.
}

// load-time self-test: the proven decoders must match hand-computed vectors (there is no frame checksum)
const FRAME_OK = (function () {
  const bat = bufToBattery([0x34, 0x12]);                 // 0x1234 = 4660 -> level floor(4660/4096)=1, voltage floor(564/10)=56
  const set = bufToSettings([0x00, 0x04]);                // 0x0400: bits10-12 = 1 -> 15 km/h; all other fields 0
  const set2 = bufToSettings([0x98, 0x01]);               // 0x0198: drivingMode=3(high), eabs=2(medium), locked=1, step0 -> 10 km/h
  return bufToSpeed([0xC8, 0x00]) === 20                  // 0x00C8 = 200 /10 = 20.0 km/h
      && bufToMileage([0x10, 0x27, 0x00, 0x00]) === 1000  // 0x00002710 = 10000 /10 = 1000.0 km
      && bat && bat.level === 1 && bat.voltage === 56
      && set && set.speedStep === 1 && set.speedKmh === 15 && set.unit === 0
      && set.zeroStart === true && set.sound === true && set.cruise === false
      && set2 && set2.drivingMode === 3 && set2.eabs === 2 && set2.locked === true && set2.speedKmh === 10;
})();

// --------------------------- tiles ---------------------------
const TILE_IDS = ['t-scheme', 't-speed', 't-speedlimit', 't-firmware', 't-battlevel', 't-battvolt', 't-mileage',
  't-settings', 't-lock', 't-resistance', 't-bms',
  't-unit', 't-drivemode', 't-eabs', 't-cruise', 't-zerostart', 't-light', 't-sound', 't-locked'];
function setTile(id, val) { const el = $(id); if (el) el.textContent = (val == null ? '-' : val); }
function resetTiles() { TILE_IDS.forEach(id => setTile(id, null)); }
// decoded-field display helpers (i18n value labels; raw/unknown values fall back to the number)
const boolLabel = (v) => v == null ? null : t(v ? 'valOn' : 'valOff');
const yesNoLabel = (v) => v == null ? null : t(v ? 'valYes' : 'valNo');
const unitLabel = (n) => n == null ? null : (n === 1 ? 'mph' : 'km/h');
function driveModeLabel(n) { if (n == null) return null; const k = DRIVEMODE_MAP[n]; return k ? t('valDm_' + k) : String(n); }
function eabsLabel(n) { if (n == null) return null; const k = EABS_MAP[n]; return k ? t('valEabs_' + k) : String(n); }
function speedLimitLabel() {
  if (S.speedStep == null) return null;
  if (S.speedKmh == null) return t('valStepPrefix') + ' ' + S.speedStep;   // steps 5-7 are undefined in the source
  if (S.speedKmh === -1) return t('valUncapped');
  return S.speedKmh + ' km/h';
}
function refreshTiles() {
  setTile('t-scheme', S.scheme == null ? null : SCHEMES[S.scheme].name);
  setTile('t-speed', S.speed == null ? null : S.speed.toFixed(1) + ' km/h');
  setTile('t-speedlimit', speedLimitLabel());
  setTile('t-firmware', S.firmware == null ? null : S.firmware);
  setTile('t-battlevel', S.battLevel == null ? null : String(S.battLevel));
  setTile('t-battvolt', S.battVolt == null ? null : S.battVolt + ' V');
  setTile('t-mileage', S.mileage == null ? null : S.mileage.toFixed(1) + ' km');
  setTile('t-settings', S.settingsRaw == null ? null : '0x' + S.settingsRaw.toString(16).padStart(4, '0').toUpperCase());
  setTile('t-lock', S.lockRaw == null ? null : S.lockRaw);
  setTile('t-resistance', S.resistanceRaw == null ? null : S.resistanceRaw);
  setTile('t-bms', S.bmsRaw == null ? null : S.bmsRaw);
  // decoded SETTINGS fields
  setTile('t-unit', unitLabel(S.unit));
  setTile('t-drivemode', driveModeLabel(S.drivingMode));
  setTile('t-eabs', eabsLabel(S.eabs));
  setTile('t-cruise', boolLabel(S.cruise));
  setTile('t-zerostart', boolLabel(S.zeroStart));
  setTile('t-light', boolLabel(S.light));
  setTile('t-sound', boolLabel(S.sound));
  setTile('t-locked', yesNoLabel(S.locked));
}

// --------------------------- i18n ---------------------------
let lang = 'de';
function table() { return (window.I18N && window.I18N[lang]) || {}; }
function t(key) { const v = table()[key]; return (typeof v === 'string') ? v : ''; }
function applyLang() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-t]').forEach(n => { const v = t(n.getAttribute('data-t')); if (/[<&]/.test(v)) n.innerHTML = v; else n.textContent = v; }); // scan-ok: curated i18n values with markup (banner/disclaimer links); own table, not user input
  document.querySelectorAll('[data-t-ph]').forEach(n => { const v = t(n.getAttribute('data-t-ph')); if (v) n.setAttribute('placeholder', v); });
  ['GUIDE', 'README', 'LICENSE', 'PRIVACY', 'TRADEMARKS'].forEach(name => { const el = $('link-' + name.toLowerCase()); if (el) el.href = docFile(name); });
  { const el = $('langs'); if (el) el.setAttribute('aria-label', t('langGroup')); }
  { const el = $('build-ver'); if (el) el.textContent = t('buildLabel') + ' ' + BUILD; }
  document.querySelectorAll('#langs button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
  refreshTiles();
  { const el = $('status'); setStatus(el ? el.dataset.state : 'disconnected'); }
  { const dark = document.documentElement.getAttribute('data-theme') !== 'light'; const el = $('btn-theme'); if (el) { el.setAttribute('aria-label', t(dark ? 'themeToLight' : 'themeToDark')); el.title = el.getAttribute('aria-label'); } }
}
function initLangSwitch() { document.querySelectorAll('#langs button').forEach(b => b.addEventListener('click', () => { lang = b.dataset.lang; applyLang(); })); }

// --------------------------- model dropdown (label only, no protocol branching) ---------------------------
function buildModelDropdown() {
  const sel = $('model-in'); if (!sel) return;
  sel.textContent = '';
  const auto = document.createElement('option'); auto.value = 'auto'; auto.setAttribute('data-t', 'modelAuto'); auto.textContent = t('modelAuto');
  sel.appendChild(auto);
  MODELS.forEach(([key, label]) => { const opt = document.createElement('option'); opt.value = key; opt.textContent = label; sel.appendChild(opt); });
  let saved = null; try { saved = localStorage.getItem(LS.MODEL); } catch (e) {}
  sel.value = (saved && (saved === 'auto' || MODELS.some(m => m[0] === saved))) ? saved : DEFAULT_MODEL;
}

// --------------------------- theme ---------------------------
function applyTheme(dark) {
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  const b = $('btn-theme');
  if (b) { b.textContent = dark ? '\u2600' : '\u263E'; b.setAttribute('aria-label', t(dark ? 'themeToLight' : 'themeToDark')); b.title = b.getAttribute('aria-label'); }
  try { localStorage.setItem(LS.THEME, dark ? 'dark' : 'light'); } catch (e) {}
}
function initTheme() {
  let saved = null; try { saved = localStorage.getItem(LS.THEME); } catch (e) {}
  applyTheme(saved !== 'light');
  const b = $('btn-theme'); if (b) b.addEventListener('click', () => applyTheme(document.documentElement.getAttribute('data-theme') === 'light'));
}

// --------------------------- status ---------------------------
function statusLabel(s) {
  const map = { disconnected: 'stDisconnected', connecting: 'stConnecting', linking: 'stLinking', connected: 'stConnected', 'no-service': 'stNoService' };
  return t(map[s] || 'stDisconnected') || s;
}
function setStatus(s) {
  const el = $('status'); if (el) { el.dataset.state = s; el.textContent = statusLabel(s); }
  const cb = $('btn-conn');
  if (cb) { const on = (s === 'connecting' || s === 'linking' || s === 'connected'); cb.textContent = on ? t('btnDisconnect') : t('btnConnect'); cb.dataset.act = on ? 'disconnect' : 'connect'; }
}
function setControlsEnabled(on) {
  // cards hidden until connected (header/intro/connect/log stay visible)
  ['live-card', 'batt-card', 'more-card', 'raw-card'].forEach(id => { const el = $(id); if (el) el.hidden = !on; });
  document.querySelectorAll('[data-conn]').forEach(e => { e.disabled = !on; });
}

// --------------------------- connect (acceptAll + GATT service is the real gate; 4x retry) ---------------------------
async function connect() {
  if (!navigator.bluetooth) { logErr(t('errNoWebBt')); return; }
  try {
    setStatus('connecting');
    const showAll = ($('showall') || {}).checked;
    const opts = showAll
      ? { acceptAllDevices: true, optionalServices: CANDIDATE_SERVICES }
      : { filters: [{ services: [U.CLASSIC_SVC] }, { services: [U.HX_SVC] }, { services: [U.ECD_SVC] }], optionalServices: CANDIDATE_SERVICES };
    dev = await navigator.bluetooth.requestDevice(opts);
    dev.addEventListener('gattserverdisconnected', onDisconnected);
    logSys('device: \x01' + (dev.name || '(no name)') + '\x01');
    setStatus('linking');
    await connectGatt();
    setStatus('connected'); connected = true;
    setControlsEnabled(true);
    { const el = $('devinfo'); if (el) el.textContent = t('devPrefix') + ' \x01' + (dev.name || 'AUGMENT') + '\x01' + ' (' + SCHEMES[scheme].name + ')'; }
    logSys('connected, scheme ' + scheme + ' (' + SCHEMES[scheme].name + ')');
  } catch (e) {
    logErr('connect failed: ' + (e && e.message ? e.message : e));
    connected = false; setStatus('disconnected'); setControlsEnabled(false);
  }
}
// tolerate the Android discovery race (4x retry): service can be briefly absent right after link.
async function connectGatt() {
  let lastErr = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      server = await dev.gatt.connect();
      const found = await resolveScheme(server);
      if (!found) { setStatus('no-service'); throw new Error('no known AUGMENT service found'); }
      scheme = found.key; S.scheme = found.key;
      const sc = SCHEMES[scheme];
      // subscribe to every notify/read characteristic this scheme exposes, routed by role
      for (const role of Object.keys(sc.notify)) {
        const uuid = sc.notify[role];
        try {
          const c = await found.svc.getCharacteristic(uuid);
          c.addEventListener('characteristicvaluechanged', (ev) => onCharValue(role, uuid, ev));
          if (c.properties.notify || c.properties.indicate) await c.startNotifications();
          if (c.properties.read) { try { const v = await c.readValue(); onCharValue(role, uuid, { target: { value: v } }); } catch (_) {} }
        } catch (e) { logDiag('char ' + short(uuid) + ' (' + role + ') unavailable: ' + (e && e.message ? e.message : e)); }
      }
      // resolve the write characteristic (may be on a separate command service)
      ch = null;
      try {
        const ws = (sc.writeService === sc.service) ? found.svc : await server.getPrimaryService(sc.writeService);
        ch = await ws.getCharacteristic(sc.writeChar);
      } catch (e) { logDiag('write char ' + short(sc.writeChar) + ' unavailable: ' + (e && e.message ? e.message : e)); }
      // firmware revision from the standard DIS (0x180A/0x2A26, read by the app; best-effort, absent on some devices)
      try {
        const dis = await server.getPrimaryService(U.DIS_SVC);
        const fc = await dis.getCharacteristic(U.DIS_FWREV);
        const v = await fc.readValue();
        const bytes = Array.from(new Uint8Array(v.buffer));
        logRx('firmware', U.DIS_FWREV, bytes);
        const s = String.fromCharCode.apply(null, bytes).replace(/\u0000+$/, '').trim();
        S.firmware = s || null; refreshTiles();
      } catch (e) { logDiag('DIS firmware revision unavailable: ' + (e && e.message ? e.message : e)); }
      return;
    } catch (e) {
      lastErr = e; logDiag('connect attempt ' + attempt + ' failed: ' + (e && e.message ? e.message : e));
      try { if (dev.gatt.connected) dev.gatt.disconnect(); } catch (_) {}
      await sleep(400);
    }
  }
  throw lastErr || new Error('gatt connect failed');
}
async function resolveScheme(srv) {
  for (const key of Object.keys(SCHEMES)) {
    try { const svc = await srv.getPrimaryService(SCHEMES[key].service); if (svc) return { key, svc }; } catch (_) {}
  }
  return null;
}
function onDisconnected() {
  connected = false; ch = null; scheme = null; setStatus('disconnected'); setControlsEnabled(false);
  resetState(); resetTiles(); clearAcks();
  const el = $('devinfo'); if (el) el.textContent = '';
  logSys('disconnected');
}
function disconnect() { if (dev && dev.gatt.connected) dev.gatt.disconnect(); }

// --------------------------- notify + ACK ---------------------------
function onCharValue(role, uuid, ev) {
  const b = Array.from(new Uint8Array(ev.target.value.buffer));
  logRx(role, uuid, b);
  decodeChar(role, b);
  resolveAck('rx');
  refreshTiles();
}
const pendingAcks = new Map();
const ACK_TIMEOUT_MS = 3000;
function armAck(key, label) {
  clearAckTimer(key);
  const timer = setTimeout(() => { pendingAcks.delete(key); logSys(label + ': ' + t('ackNone')); }, ACK_TIMEOUT_MS);
  pendingAcks.set(key, { timer, label });
}
function resolveAck(key) { const a = pendingAcks.get(key); if (a) { clearTimeout(a.timer); pendingAcks.delete(key); logSys(a.label + ': ' + t('ackOk')); } }
function clearAckTimer(key) { const a = pendingAcks.get(key); if (a) { clearTimeout(a.timer); pendingAcks.delete(key); } }
function clearAcks() { for (const a of pendingAcks.values()) clearTimeout(a.timer); pendingAcks.clear(); }

// --------------------------- transmit (single funnel: log TX, arm ack, write) ---------------------------
async function writeFrame(bytes) {
  const arr = Uint8Array.from(bytes);
  if (!ch) throw new Error('no writable characteristic on this scheme');
  if (ch.properties.writeWithoutResponse && !ch.properties.write) return ch.writeValueWithoutResponse(arr);
  if (ch.properties.write) return ch.writeValueWithResponse(arr);
  return ch.writeValue(arr);
}
async function transmit(bytes, label, ackKey) {
  if (!connected || !ch) { logErr(t('errNotConnected')); return; }
  logTx(ch.uuid, bytes);
  if (ackKey) armAck(ackKey, label);
  try { await writeFrame(bytes); logSys(label + ': ' + t('txSent')); }
  catch (e) { clearAckTimer(ackKey); logErr(label + ' ' + t('txFailed') + ': ' + (e && e.message ? e.message : e)); }
}
// serialize writes on the single characteristic
async function guard(fn) { if (busy) return; busy = true; try { await fn(); } catch (e) { logErr(e && e.message ? e.message : String(e)); } finally { busy = false; } }

// --------------------------- engine-level writes (raw verbatim + byte builder; confirm-gated) ---------------------------
function hexToBytes(s) {
  const clean = String(s).replace(/[^0-9a-fA-F]/g, '');   // strip spaces/punctuation
  const out = []; for (let i = 0; i + 2 <= clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));   // pairs; drop a dangling nibble
  return out;
}
async function cmdRaw() {
  const bytes = hexToBytes(($('raw-in') || {}).value || '');
  if (!bytes.length) { logErr(t('errNoBytes')); return; }
  if (!await confirmRisky(t('warnRaw'))) return;
  await transmit(bytes, t('rawLabel'), 'rx');   // sent verbatim to the command characteristic
}
async function cmdFree() {
  const op = parseInt(($('free-op') || {}).value, 16);
  if (isNaN(op)) { logErr(t('errBadOp')); return; }
  const payload = hexToBytes(($('free-payload') || {}).value || '');
  if (!await confirmRisky(t('warnRaw'))) return;
  await transmit([op & 0xff, ...payload], t('freeLabel') + ' 0x' + (op & 0xff).toString(16), 'rx');   // [op, payload...] - Augment has no frame checksum
}

// --------------------------- confirm dialog (themed; window.confirm fallback) ---------------------------
function confirmRisky(msg) {
  return new Promise(resolve => {
    const dlg = $('confirm'); const body = $('confirm-body');
    if (!dlg || !dlg.showModal) { resolve(window.confirm(msg)); return; }
    if (body) body.textContent = msg;
    const ok = $('confirm-ok'), cancel = $('confirm-x'), no = $('confirm-no');
    const done = (v) => { dlg.close(); ok.removeEventListener('click', onOk); if (no) no.removeEventListener('click', onNo); if (cancel) cancel.removeEventListener('click', onNo); resolve(v); };
    const onOk = () => done(true), onNo = () => done(false);
    ok.addEventListener('click', onOk); if (no) no.addEventListener('click', onNo); if (cancel) cancel.addEventListener('click', onNo);
    dlg.showModal();
  });
}

// --------------------------- doc viewer (markdown of our own docs) ---------------------------
const DOC_TITLES = { 'GUIDE.de.md': 'footGuide', 'GUIDE.en.md': 'footGuide', 'README.md': 'footReadme', 'LICENSE.de.md': 'footLicense', 'LICENSE.md': 'footLicense', 'PRIVACY.de.md': 'footPrivacy', 'PRIVACY.md': 'footPrivacy', 'TRADEMARKS.de.md': 'footTrademarks', 'TRADEMARKS.md': 'footTrademarks' };
const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const slug = s => s.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
function docFile(name) { if (name === 'README') return 'README.md'; if (name === 'GUIDE') return 'GUIDE.' + lang + '.md'; return name + (lang === 'de' ? '.de.md' : '.md'); }
function mdToHtml(src) {
  const inline = s => escHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (all, text, href) => DOC_TITLES[href] ? '<a href="' + href + '" data-docfile="' + href + '">' + text + '</a>' : '<a href="' + href + '" target="_blank" rel="noopener">' + text + '</a>');
  const lines = String(src).split(/\r?\n/); let html = '', inList = false, inCode = false;
  for (const ln of lines) {
    if (/^```/.test(ln)) { if (inCode) { html += '</pre>'; inCode = false; } else { if (inList) { html += '</ul>'; inList = false; } html += '<pre class="doc-code">'; inCode = true; } continue; }
    if (inCode) { html += escHtml(ln) + '\n'; continue; }
    const h = ln.match(/^(#{1,4})\s+(.*)$/);
    if (h) { if (inList) { html += '</ul>'; inList = false; } const lvl = h[1].length + 1; html += '<h' + lvl + ' id="' + slug(h[2]) + '">' + inline(h[2]) + '</h' + lvl + '>'; continue; }
    const li = ln.match(/^\s*[-*]\s+(.*)$/);
    if (li) { if (!inList) { html += '<ul>'; inList = true; } html += '<li>' + inline(li[1]) + '</li>'; continue; }
    if (/^\s*$/.test(ln)) { if (inList) { html += '</ul>'; inList = false; } continue; }
    if (inList) { html += '</ul>'; inList = false; }
    html += '<p>' + inline(ln) + '</p>';
  }
  if (inList) html += '</ul>'; if (inCode) html += '</pre>';
  return html;
}
const docCache = {};
async function openDocFile(file) {
  const dlg = $('doc'); const titleEl = $('doc-title'); const bodyEl = $('doc-body');
  titleEl.textContent = t(DOC_TITLES[file] || 'footReadme');
  if (lang === 'de' && /\.md$/.test(file) && !/\.de\.md$/.test(file) && file !== 'README.md') titleEl.textContent += ' (englisch)';
  try { if (!docCache[file]) { const r = await fetch(file); docCache[file] = await r.text(); } bodyEl.innerHTML = mdToHtml(docCache[file]); } // scan-ok: own in-repo markdown rendered via mdToHtml; not user input
  catch (e) { bodyEl.textContent = 'Could not load ' + file; }
  if (dlg.showModal) dlg.showModal();
}
function wireDocViewer() {
  // delegated: footer doc links, the intro guide link (injected by i18n at runtime), in-doc links, disclaimer
  document.addEventListener('click', e => {
    const d = e.target.closest('a[data-doc]'); if (d) { e.preventDefault(); openDocFile(docFile(d.getAttribute('data-doc'))); return; }
    const df = e.target.closest('a[data-docfile]'); if (df) { e.preventDefault(); openDocFile(df.getAttribute('data-docfile')); return; }
    const disc = e.target.closest('[data-open-disclaimer]'); if (disc) { e.preventDefault(); openHelpText(t('footDisclaimer'), t('disclaimerText')); return; }
  });
  ['doc-x', 'doc-close'].forEach(id => { const b = $(id); if (b) b.addEventListener('click', () => $('doc').close()); });
}

// --------------------------- help modal ---------------------------
function openHelp(key) { openHelpText(t('help_' + key + '_t'), t('help_' + key + '_b')); }
function openHelpText(title, body) {
  const dlg = $('help'); $('help-title').textContent = title || ''; const b = $('help-body'); if (/[<&]/.test(body || '')) b.innerHTML = body; else b.textContent = body || ''; // scan-ok: curated i18n help text; own table, not user input
  if (dlg.showModal) dlg.showModal();
}
function closeHelp() { const d = $('help'); if (d) d.close(); }

// --------------------------- init ---------------------------
window.addEventListener('DOMContentLoaded', () => {
  initLangSwitch(); initTheme(); wireDocViewer(); buildModelDropdown();
  applyLang(); setStatus('disconnected'); resetTiles();
  logDiagnosticHeader();
  if (!FRAME_OK) logErr('protocol self-test FAILED - decoders do not match known vectors; do not trust readouts');

  $('btn-conn').addEventListener('click', () => { if ($('btn-conn').dataset.act === 'disconnect') disconnect(); else guard(connect); });
  { const sel = $('model-in'); if (sel) sel.addEventListener('change', () => { try { localStorage.setItem(LS.MODEL, sel.value); } catch (e) {} }); }

  { const b = $('btn-raw'); if (b) b.addEventListener('click', () => guard(cmdRaw)); }
  { const b = $('btn-free'); if (b) b.addEventListener('click', () => guard(cmdFree)); }

  document.querySelectorAll('.help-btn[data-help]').forEach(btn => btn.addEventListener('click', () => openHelp(btn.getAttribute('data-help'))));
  ['help-x', 'help-close'].forEach(id => { const b = $(id); if (b) b.addEventListener('click', closeHelp); });
  { const b = $('link-disclaimer'); if (b) b.addEventListener('click', e => { e.preventDefault(); openHelpText(t('footDisclaimer'), t('disclaimerText')); }); }

  { const cb = $('public-log'); if (cb) { let saved = null; try { saved = localStorage.getItem(LS.PUBLOG); } catch (e) {} publicLog = saved !== '0'; cb.checked = publicLog; cb.addEventListener('change', () => { publicLog = cb.checked; try { localStorage.setItem(LS.PUBLOG, cb.checked ? '1' : '0'); } catch (e) {} renderLog(); }); } }
  { const cb = $('diag-log'); if (cb) { cb.addEventListener('change', () => { diag = cb.checked; logSys(diag ? 'diagnostic log on' : 'diagnostic log off'); }); } }
  { const b = $('btn-clear-log'); if (b) b.addEventListener('click', () => { logBuffer = []; $('log').textContent = ''; logDiagnosticHeader(); }); }
  { const b = $('btn-copy-log'); if (b) b.addEventListener('click', () => navigator.clipboard.writeText(logText()).then(() => logSys('log copied')).catch(() => {})); }
  { const b = $('btn-save-log'); if (b) b.addEventListener('click', saveLog); }
});
