// ---- Imports ----
import express from 'express';
import { createServer } from 'http';
import { Server as SocketIO } from 'socket.io';
import * as osc from 'node-osc';
import { SerialPort } from 'serialport';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- Config ----
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
const MOTOR_SERIAL_PATH = process.env.MOTOR_SERIAL_PATH || '/dev/tty.usbmodem1101';
const MOTOR_SERIAL_BAUD = 9600;

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

async function pollMeasure({ notationSuffix, address, label, unit }) {
  const measureId = measureIds[notationSuffix];
  if (!measureId) {
    console.log(`EA: no measure found for ${label} (${notationSuffix})`);
    return;
  }
  const res = await fetch(`${EA_BASE}/id/measures/${measureId}/readings.json?latest=true`);
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
}

async function pollWaterQuality() {
  try {
    if (!measureIds) {
      measureIds = await findMeasureIds();
      console.log('Found EA measures:', measureIds);
    }
    for (const measure of MEASURES) {
      await pollMeasure(measure);
    }
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
  } catch (err) {
    console.error('Thames Water request failed:', err.message);
  }
}

async function pollAll() {
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
const motorSerial = new SerialPort({ path: MOTOR_SERIAL_PATH, baudRate: MOTOR_SERIAL_BAUD }, (err) => {
  if (err) console.error('Motor serial port error:', err.message);
});
motorSerial.on('error', (err) => {
  console.error('Motor serial error:', err.message);
});

SerialPort.list().then(ports => {
  console.log('Available serial ports:', ports.map(p => p.path));
});

function triggerMotor() {
  motorSerial.write('ROTATE\n', (err) => {
    if (err) console.error('Motor serial write failed:', err.message);
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
