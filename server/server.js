// ---- Imports ----
import express from 'express';
import { createServer } from 'http';
import { Server as SocketIO } from 'socket.io';
import * as osc from 'node-osc';
import { SerialPort } from 'serialport';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- Config ----
// Set to true before starting the server to run a one-off self-test at
// startup: fires the motor + local audio immediately (instead of waiting for
// a scheduled discharge time) and logs the EA / Thames Water API requests
// clearly as debug output. Leave false for real exhibition runs.
const DEBUG_MODE = true;

const SOCKETIO_PORT = 8888;
const OSC_CLIENT_PORT = 8000;
const OSC_SERVER_PORT = 8001;

const EA_BASE = 'https://environment.data.gov.uk/hydrology';
const STATION_ID = 'CADOG2';
const POLL_INTERVAL_MS = 15 * 60 * 1000;

const THAMES_WATER_BASE = 'https://api.thameswater.co.uk/opendata/v2';
const DISCHARGE_OUTFALL_ID = 'TWL00400'; // South West Storm Relief CSO

// Exhibition runs the same clock hours every day (11am-8pm). Change these
// whenever the exhibition hours change and the discharge schedule below is
// remapped to fit the new window. Because the anchor is wall-clock time (not
// "time since server started"), restarting the server mid-exhibition resumes
// the correct schedule instead of restarting the 9 hours from zero.
const EXHIBIT_START_HOUR = 11; // 24h clock, local time
const EXHIBIT_TIME_HOURS = 9; // 11am - 8pm
const DISCHARGE_SCHEDULE_PATH = path.join(__dirname, 'data', 'discharge-schedule.json');

// Serial connection to the stepper-motor Arduino (separate from the OSC link
// to TouchDesigner above). Update MOTOR_SERIAL_PATH to match the board's
// actual port - available ports are logged at startup below.
const MOTOR_SERIAL_PATH = process.env.MOTOR_SERIAL_PATH || '/dev/cu.usbmodem141301';
const MOTOR_SERIAL_BAUD = 9600;

// Set to false when the motor Arduino isn't connected (e.g. debugging other
// parts of the server) - skips opening the serial port entirely, so there's
// no port-not-found error and no [Arduino] log spam.
const MOTOR_ENABLED = false;

// Discharge audio cue, played locally on this machine (via afplay, macOS)
// each time the motor triggers. Plays straight through the folder in order,
// looping back to the first file after the last, for as long as the
// discharge state lasts - this should match the Arduino's RETURN_DELAY_MS
// (app/controllers/Rotate_StepperMotor_OSC), since that's how long the motor
// stays in its rotated/"discharging" position before returning.
const DISCHARGE_AUDIO_DIR = path.join(__dirname, '..', 'app', 'audio', 'discharge');
const DISCHARGE_DURATION_MS = 10 * 60 * 1000; // 10 minutes, matching the Arduino's RETURN_DELAY_MS

// ---- Server setup (Express + Socket.IO) ----
// Socket.IO is not used by TouchDesigner (which talks OSC only). It's kept
// here for a future browser-based maintenance interface.
const app = express();
const http = createServer(app);
const io = new SocketIO(http);

http.listen(SOCKETIO_PORT, '0.0.0.0', function () {
  console.log('SocketIO listening on :', SOCKETIO_PORT);
});

// ---- OSC setup ----
// OSC_CLIENT sends data out to TouchDesigner (one-way).
// OSC_SERVER is reserved for receiving messages back from TD, if ever needed.
const OSC_SERVER = new osc.Server(OSC_SERVER_PORT, '127.0.0.1', () => {
  console.log('OSC Server is listening on :', OSC_SERVER_PORT);
});
OSC_SERVER.on('error', (err) => {
  console.error('OSC Server error:', err.message);
});

const OSC_CLIENT = new osc.Client('127.0.0.1', OSC_CLIENT_PORT);
OSC_CLIENT.on('error', (err) => {
  console.error('OSC Client error:', err.message);
});

// ---- Environment Agency water quality polling ----
// Each entry matches a measure by its notation suffix (stable per-station
// identifier) and maps it to an OSC address and log label.
const MEASURES = [
  { notationSuffix: 'do-i-subdaily-mgL', address: '/ea/dissolved_oxygen_mgl', label: 'DO', unit: 'mg/L' },
  { notationSuffix: 'do-i-subdaily-pct', address: '/ea/dissolved_oxygen_pct', label: 'DO', unit: '%' },
  { notationSuffix: 'temp-i-subdaily-C', address: '/ea/temperature', label: 'Temperature', unit: '°C' },
  { notationSuffix: 'sal-i-subdaily-psu', address: '/ea/salinity', label: 'Salinity', unit: 'PSU' },
  { notationSuffix: 'turb-i-subdaily-ntu', address: '/ea/turbidity', label: 'Turbidity', unit: 'NTU' },
  { notationSuffix: 'ph-i-subdaily', address: '/ea/ph', label: 'pH', unit: '' },
  { notationSuffix: 'amm-i-subdaily-mgL', address: '/ea/ammonium', label: 'Ammonium', unit: 'mg/L' },
  { notationSuffix: 'cond-i-subdaily-uS', address: '/ea/conductivity', label: 'Conductivity', unit: 'µS/cm' },
];

// Populated on first poll: notationSuffix -> measure id (last path segment of @id).
let measureIds = null;

async function findMeasureIds() {
  const res = await fetch(`${EA_BASE}/id/stations/${STATION_ID}/measures.json`);
  const data = await res.json();
  const measures = data.items || [];
  const found = {};
  for (const { notationSuffix } of MEASURES) {
    const match = measures.find(m => m.notation && m.notation.endsWith(notationSuffix));
    if (match) found[notationSuffix] = match['@id'].split('/').pop();
  }
  return found;
}

// The EA API occasionally stops responding on a connection entirely (no
// error, just hangs) rather than returning slowly or erroring out. A timeout
// plus a per-measure try/catch stops one hung request from blocking the rest
// of the batch indefinitely or from failing every other measure via
// Promise.all's fail-fast rejection.
const EA_REQUEST_TIMEOUT_MS = 180 * 1000; // wait up to 3 minutes for a slow EA response before aborting the request

async function pollMeasure({ notationSuffix, address, label, unit }) {
  const measureId = measureIds[notationSuffix];
  if (!measureId) {
    console.log(`EA: no measure found for ${label} (${notationSuffix})`);
    return;
  }
  try {
    const res = await fetch(`${EA_BASE}/id/measures/${measureId}/readings.json?latest=true`, {
      signal: AbortSignal.timeout(EA_REQUEST_TIMEOUT_MS),
    });
    const data = await res.json();
    const readings = data.items || [];
    if (!readings.length) {
      console.log(`EA: no ${label} reading available`);
      return;
    }
    const { value, dateTime } = readings[0];
    const numValue = parseFloat(value);
    console.log(`EA request succeeded: ${label} ${numValue} ${unit} at ${dateTime}`);
    OSC_CLIENT.send(address, numValue, () => {});
    OSC_CLIENT.send('/ea/last_updated', dateTime, () => {}); // send the last-updated timestamp for any measure.
  } catch (err) {
    console.error(`EA request failed for ${label}:`, err.message);
  }
}

async function pollWaterQuality() {
  try {
    if (!measureIds) {
      measureIds = await findMeasureIds();
      console.log('Found EA measures:', measureIds);
    }
    await Promise.all(MEASURES.map(pollMeasure));
  } catch (err) {
    console.error('EA request failed:', err.message);
    measureIds = null;
  }
}

// ---- Thames Water storm discharge polling ----
async function pollDischargeStatus() {
  try {
    const res = await fetch(`${THAMES_WATER_BASE}/discharge/status`);
    const data = await res.json();
    const items = data.items || [];
    const outfall = items.find(item => item.uniqueId === DISCHARGE_OUTFALL_ID);
    if (!outfall) {
      console.log(`Thames Water: outfall ${DISCHARGE_OUTFALL_ID} not found`);
      return;
    }
    const { locationName, alertStatus, statusChanged } = outfall;
    const isDischarging = alertStatus === 'Discharging' ? 1 : 0;
    const totalCount = items.length;
    const dischargingCount = items.filter(item => item.alertStatus === 'Discharging').length;
    console.log(`Thames Water request succeeded: ${locationName} - ${alertStatus} at ${statusChanged}`);
    console.log(`Thames Water network: ${dischargingCount}/${totalCount} outfalls discharging`);
    OSC_CLIENT.send('/thames/discharging', isDischarging, () => {});
    OSC_CLIENT.send('/thames/discharge_status', alertStatus, () => {});
    OSC_CLIENT.send('/thames/network_discharging_count', dischargingCount, () => {});
    OSC_CLIENT.send('/thames/network_total_count', totalCount, () => {});
    OSC_CLIENT.send('/thames/location_name', locationName, () => {});
    OSC_CLIENT.send('/thames/last_changed', statusChanged, () => {});
  } catch (err) {
    console.error('Thames Water request failed:', err.message);
  }
}

async function pollAll() {
  if (DEBUG_MODE) console.log('DEBUG_MODE: running startup API requests (EA + Thames Water)');
  await pollWaterQuality();
  await pollDischargeStatus();
}

// Fire once on startup so success/failure is logged immediately, then keep polling.
pollAll();
setInterval(pollAll, POLL_INTERVAL_MS);

// ---- Stepper motor exhibition schedule ----
// Separate from the OSC link above: this talks to the Rotate_StepperMotor_OSC
// Arduino over USB serial. On trigger, the motor rotates a small amount and
// returns to its initial position after 10 minutes - that timing lives on the
// Arduino itself (see app/controllers/Rotate_StepperMotor_OSC), so Node only
// has to send the one-word trigger.
let motorSerial = null;
let motorSerialReady = false;

if (MOTOR_ENABLED) {
  motorSerial = new SerialPort({ path: MOTOR_SERIAL_PATH, baudRate: MOTOR_SERIAL_BAUD }, (err) => {
    if (err) console.error('Motor serial port error:', err.message);
  });
  motorSerial.on('error', (err) => {
    console.error('Motor serial error:', err.message);
  });

  // Echo whatever the Arduino prints (Serial.println debug lines from the
  // motor sketch) into this same log stream, so serial output and server logs
  // interleave in one terminal instead of needing a separate serial monitor.
  // Bytes can arrive split across multiple 'data' events, so buffer until a
  // newline instead of printing each raw chunk.
  let motorSerialLineBuffer = '';
  motorSerial.on('data', (data) => {
    motorSerialLineBuffer += data.toString();
    const lines = motorSerialLineBuffer.split('\n');
    motorSerialLineBuffer = lines.pop();
    lines.filter(Boolean).forEach(line => {
      console.log(`[Arduino] ${line.trim()}`);
    });
  });

  // Opening the port resets most Arduino boards (DTR toggles on connect), and
  // setup() takes a couple of seconds to finish running. Writing before that
  // completes silently drops the byte - the board isn't reading serial yet.
  // So track readiness separately from the 'open' event and hold writes until
  // the reset/boot window has passed.
  motorSerial.on('open', () => {
    console.log('Motor serial port open, waiting for board to finish resetting...');
    setTimeout(() => {
      motorSerialReady = true;
      console.log('Motor serial port ready');
    }, 2000);
  });

  SerialPort.list().then(ports => {
    console.log('Available serial ports:', ports.map(p => p.path));
  });
} else {
  console.log('MOTOR_ENABLED is false - skipping motor serial connection');
}

function triggerMotor() {
  if (!MOTOR_ENABLED) {
    startDischargeAudioLoop();
    return;
  }
  if (!motorSerialReady) {
    console.log('Motor serial port not ready yet, waiting to send ROTATE...');
    setTimeout(triggerMotor, 500);
    return;
  }
  motorSerial.write('ROTATE\n', (err) => {
    if (err) console.error('Motor serial write failed:', err.message);
  });
  startDischargeAudioLoop();
}

// Filenames are kept as-is and read directly from DISCHARGE_AUDIO_DIR (no
// hardcoded track list), sorted so playback order is stable across runs.
const dischargeAudioFiles = fs.readdirSync(DISCHARGE_AUDIO_DIR)
  .filter(f => f.toLowerCase().endsWith('.wav'))
  .sort();

if (!dischargeAudioFiles.length) {
  console.log(`Discharge audio: no .wav files found in ${DISCHARGE_AUDIO_DIR}`);
}

// Reads just the `fmt ` and `data` chunk sizes from a canonical PCM WAV
// header to compute duration, without decoding the whole file.
function readWavDurationMs(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(44);
    fs.readSync(fd, header, 0, 44, 0);
    const sampleRate = header.readUInt32LE(24);
    const blockAlign = header.readUInt16LE(32);
    const dataSize = header.readUInt32LE(40);
    return (dataSize / (sampleRate * blockAlign)) * 1000;
  } finally {
    fs.closeSync(fd);
  }
}

// Computed once at startup so per-play duration lookups are just an O(1)
// map read, not a file read.
const dischargeAudioDurationsMs = new Map(
  dischargeAudioFiles.map(f => [f, readWavDurationMs(path.join(DISCHARGE_AUDIO_DIR, f))])
);

let dischargeAudioActive = false;
let dischargeAudioBag = [];
let lastDischargeAudioFile = null;

function shuffle(array) {
  const result = array.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Draws the next track from a shuffled "bag". When the bag empties, it's
// refilled with a fresh shuffle of all tracks - if that new shuffle would
// start with the same track that just finished, swap it so the same file
// never plays twice in a row across the reshuffle boundary either. This
// guarantees no repeats until every other track has played once, no matter
// how long DISCHARGE_DURATION_MS is.
function drawNextDischargeAudio() {
  if (dischargeAudioBag.length === 0) {
    dischargeAudioBag = shuffle(dischargeAudioFiles);
    if (dischargeAudioBag.length > 1 && dischargeAudioBag[0] === lastDischargeAudioFile) {
      const swapAt = 1 + Math.floor(Math.random() * (dischargeAudioBag.length - 1));
      [dischargeAudioBag[0], dischargeAudioBag[swapAt]] = [dischargeAudioBag[swapAt], dischargeAudioBag[0]];
    }
  }
  const file = dischargeAudioBag.shift();
  lastDischargeAudioFile = file;
  return file;
}

// Plays tracks back-to-back in random (non-repeating) order until
// DISCHARGE_DURATION_MS has elapsed since the trigger. If a trigger arrives
// while a loop is already running, it's ignored - the current loop keeps
// going rather than restarting the window or overlapping playback.
function startDischargeAudioLoop() {
  if (!dischargeAudioFiles.length) return;
  if (dischargeAudioActive) {
    console.log('Discharge audio: loop already running, ignoring overlapping trigger');
    return;
  }

  dischargeAudioActive = true;
  const endAt = Date.now() + DISCHARGE_DURATION_MS;
  console.log(`Discharge audio: starting ${(DISCHARGE_DURATION_MS / 60000).toFixed(1)} min loop`);
  playNextDischargeAudio(endAt);
}

function playNextDischargeAudio(endAt) {
  const remainingMs = endAt - Date.now();
  if (remainingMs <= 0) {
    dischargeAudioActive = false;
    console.log('Discharge audio: loop finished');
    return;
  }

  const file = drawNextDischargeAudio();
  const duration = dischargeAudioDurationsMs.get(file);

  // Don't start a track that would run past endAt - stop the loop early
  // instead, rather than overshooting the motor's return time.
  if (duration > remainingMs) {
    dischargeAudioActive = false;
    console.log(`Discharge audio: next track (${file}, ${(duration / 1000).toFixed(1)}s) doesn't fit remaining ${(remainingMs / 1000).toFixed(1)}s - stopping loop early`);
    return;
  }

  const filePath = path.join(DISCHARGE_AUDIO_DIR, file);

  console.log(`Discharge audio: playing ${file}`);
  execFile('afplay', [filePath], (err) => {
    if (err) console.error('Discharge audio playback failed:', err.message);
    playNextDischargeAudio(endAt);
  });
}

// Today's exhibition start (EXHIBIT_START_HOUR:00 local time). If it's
// already past today's exhibition end, anchors to tomorrow's start instead -
// so a server left running (or restarted) after closing rolls over cleanly
// to the next day rather than replaying today's schedule.
function getExhibitAnchor(now) {
  const start = new Date(now);
  start.setHours(EXHIBIT_START_HOUR, 0, 0, 0);
  const end = new Date(start.getTime() + EXHIBIT_TIME_HOURS * 60 * 60 * 1000);
  if (now >= end) {
    start.setDate(start.getDate() + 1);
  }
  return start;
}

// Reads discharge-schedule.json's historical statusChangedDates and maps
// their relative spacing onto the EXHIBIT_TIME_HOURS window: the earliest
// date becomes t=0 (exhibition start), the latest becomes t=EXHIBIT_TIME_HOURS
// (exhibition end), everything else falls proportionally in between.
//
// Each mapped time is scheduled against the wall-clock exhibition anchor, not
// "time since server started" - so if the server is restarted mid-exhibition,
// triggers that already would have fired are skipped and only the remaining
// ones are scheduled, instead of the whole 9 hours restarting from zero.
function scheduleMotorTriggers() {
  const schedule = JSON.parse(fs.readFileSync(DISCHARGE_SCHEDULE_PATH, 'utf-8'));
  const dates = (schedule.statusChangedDates || [])
    .map(d => new Date(d))
    .sort((a, b) => a - b);

  if (!dates.length) {
    console.log('Motor schedule: no dates found in discharge-schedule.json');
    return;
  }

  const now = new Date();
  const exhibitAnchor = getExhibitAnchor(now);
  const exhibitDurationMs = EXHIBIT_TIME_HOURS * 60 * 60 * 1000;
  const rangeStart = dates[0].getTime();
  const rangeEnd = dates[dates.length - 1].getTime();
  const rangeMs = rangeEnd - rangeStart || 1; // avoid divide-by-zero if only one date

  console.log(`Motor schedule anchored to ${exhibitAnchor.toISOString()} (exhibition ${EXHIBIT_START_HOUR}:00, ${EXHIBIT_TIME_HOURS}h)`);

  let skipped = 0;
  dates.forEach((date, i) => {
    const proportion = (date.getTime() - rangeStart) / rangeMs;
    const offsetMs = proportion * exhibitDurationMs;
    const triggerAt = exhibitAnchor.getTime() + offsetMs;
    const delay = triggerAt - now.getTime();

    if (delay <= 0) {
      skipped++;
      console.log(`Motor trigger ${i + 1}/${dates.length} skipped, already past (was +${(offsetMs / 60000).toFixed(1)} min)`);
      return;
    }

    setTimeout(() => {
      console.log(`Motor trigger ${i + 1}/${dates.length} firing (mapped from ${date.toISOString()})`);
      triggerMotor();
    }, delay);

    console.log(`Motor trigger ${i + 1}/${dates.length} scheduled at +${(offsetMs / 60000).toFixed(1)} min (in ${(delay / 60000).toFixed(1)} min from now)`);
  });

  console.log(`Scheduled ${dates.length - skipped}/${dates.length} motor triggers (${skipped} already past) across a ${EXHIBIT_TIME_HOURS}h exhibition window`);
}

scheduleMotorTriggers();

if (DEBUG_MODE) {
  console.log('DEBUG_MODE: triggering motor + local audio immediately for testing');
  triggerMotor();
}

// ---- Socket.IO <-> OSC bridge ----
// Not wired up to anything yet; scaffolding for the future browser interface.
io.on('connection', function (socket) {
  console.log(`client connected: ${socket.id}`);

  socket.on('disconnect', function () {
    console.log(`client disconnected: ${socket.id}`);
  });

  socket.on('server:send-data', function (data) {
    console.log("Sending data to OSC client:", data.cmd);
    OSC_CLIENT.send('/server/osc_listener', data.cmd, function () {});
  });

  OSC_SERVER.on('message', function (msg) {
    console.log('new message from TD:');
    console.log(msg);
    socket.emit('server:get-data', { cmd: msg[0], value: msg[1] });
  });
});
