import express from 'express';
import { createServer } from 'http';
import { Server as SocketIO } from 'socket.io';
import * as osc from 'node-osc';

const app = express();
const http = createServer(app);
const io = new SocketIO(http);

const SOCKETIO_PORT = 8888;
const OSC_CLIENT_PORT = 8000;
const OSC_SERVER_PORT = 8001;

const EA_BASE = 'https://environment.data.gov.uk/hydrology';
const STATION_ID = 'CADOG2';
const POLL_INTERVAL_MS = 15 * 60 * 1000;

http.listen(SOCKETIO_PORT, '0.0.0.0', function () {
  console.log('SocketIO listening on :', SOCKETIO_PORT);
});

const OSC_SERVER = new osc.Server(OSC_SERVER_PORT, '127.0.0.1', () => {
  console.log('OSC Server is listening on :', OSC_SERVER_PORT);
});
const OSC_CLIENT = new osc.Client('0.0.0.0', OSC_CLIENT_PORT);

let doMeasureId = null;

async function findDOMeasureId() {
  const res = await fetch(`${EA_BASE}/id/stations/${STATION_ID}/measures.json`);
  const data = await res.json();
  const measures = data.items || [];
  const doMeasure = measures.find(m => {
    const prop = m.observedProperty;
    const label = typeof prop === 'object' ? prop.label : String(prop);
    return label && label.toLowerCase().includes('dissolved oxygen');
  });
  if (!doMeasure) throw new Error('Dissolved oxygen measure not found at station');
  return doMeasure['@id'].split('/').pop();
}

async function pollDissolvedOxygen() {
  try {
    if (!doMeasureId) {
      doMeasureId = await findDOMeasureId();
      console.log(`Found DO measure: ${doMeasureId}`);
    }
    const res = await fetch(`${EA_BASE}/id/measures/${doMeasureId}/readings.json?latest=true`);
    const data = await res.json();
    const readings = data.items || [];
    if (!readings.length) {
      console.log('EA: no dissolved oxygen reading available');
      return;
    }
    const { value, dateTime } = readings[0];
    console.log(`EA DO: ${value} mg/L at ${dateTime}`);
    OSC_CLIENT.send('/ea/dissolved_oxygen', value, () => {});
  } catch (err) {
    console.error('EA poll error:', err.message);
    doMeasureId = null;
  }
}

pollDissolvedOxygen();
setInterval(pollDissolvedOxygen, POLL_INTERVAL_MS);

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
