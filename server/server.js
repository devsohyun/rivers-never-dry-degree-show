// ---- Imports ----
import express from 'express';
import { createServer } from 'http';
import { Server as SocketIO } from 'socket.io';
import * as osc from 'node-osc';

// ---- Config ----
const SOCKETIO_PORT = 8888;
const OSC_CLIENT_PORT = 8000;
const OSC_SERVER_PORT = 8001;

const EA_BASE = 'https://environment.data.gov.uk/hydrology';
const STATION_ID = 'CADOG2';
const POLL_INTERVAL_MS = 15 * 60 * 1000;

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

// Fire once on startup so success/failure is logged immediately, then keep polling.
pollWaterQuality();
setInterval(pollWaterQuality, POLL_INTERVAL_MS);

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
