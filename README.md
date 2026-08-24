# Rivers Never Dry Degree Show

Rivers Never Dry installation for MA Computational Arts Degree Show 2026 at Goldsmiths, University of London.

## Project structure

```
app/
  audio/
    discharge/                   Discharge audio cues, played locally via afplay on motor trigger
  controllers/
    InteractiveMap_AudioPlayer/
      sd_card/                   Button-triggered tracks, copied onto the player's SD card
    Rotate_StepperMotor_OSC/      Arduino sketch: stepper motor, triggered over serial
  visuals/
    SPH_Test.toe                 TouchDesigner
    visualisation.toe            TouchDesigner
server/
  data/
    discharge-schedule.json      Historical discharge timestamps mapped onto the exhibition window
  server.js                      Polls EA + Thames Water APIs, drives OSC/serial/audio triggers
```

## Install

Install npm packages in `server/`:
```
cd server
npm install
```

Start the server:
```
node server
```

## Usage

### Arduino

Make sure the discharge duration is set to the same value in both `server.js` and `Rotate_StepperMotor_OSC.ino` — they're independent timers and only stay in sync if updated together.

- `server.js`: `DISCHARGE_DURATION_MS`
- `Rotate_StepperMotor_OSC.ino`: `RETURN_DELAY_MS`

### Audio

The `BackgroundAudioWAV` decoder (used in `InteractiveMap_AudioPlayer.ino`) is strict about WAV format: it only accepts linear PCM (format tag 1) with an exact canonical 16-byte `fmt` chunk. Files must be clean 16-bit linear PCM, 44100Hz, stereo.

If a file isn't in this format, convert it with ffmpeg:
```
ffmpeg -i input.wav -acodec pcm_s16le -ar 44100 -ac 2 output.wav
```

## `server.js`

The server has three mostly-independent jobs: polling live water data out to TouchDesigner over OSC, running the timed discharge schedule (stepper motor + audio), and bridging the Arduino's serial output into its own logs. All of it lives in one process, started with `node server` from `server/`.

### 1. Live data polling → OSC

Every `POLL_INTERVAL_MS` (15 min), `pollAll()` runs two independent fetches and pushes the results out over OSC to TouchDesigner (`OSC_CLIENT`, `127.0.0.1:8000`):

- **`pollWaterQuality()`** — queries the Environment Agency hydrology API for station `CADOG2` (dissolved oxygen, temperature, salinity, turbidity, pH, ammonium, conductivity — the full list is in `MEASURES`). Measure IDs are resolved once via `findMeasureIds()` and cached; each reading is sent to its own OSC address (e.g. `/ea/ph`), plus `/ea/last_updated`.
- **`pollDischargeStatus()`** — queries the Thames Water open data API for the `TWL00400` outfall (South West Storm Relief CSO), and sends its live discharging state (`/thames/discharging`, `/thames/discharge_status`) plus a network-wide count of how many outfalls are currently discharging.

Both requests are wrapped in try/catch so a hung or failing API (the EA one is known to occasionally hang with no error) doesn't take down polling for the other, or for future cycles.

### 2. The discharge schedule (motor + audio)

This is what actually drives the physical installation, and it's on a completely separate timeline from the live OSC polling above — it doesn't use live discharge events, only historical ones.

**Where the schedule comes from:** `server/data/discharge-schedule.json` contains a list of real historical `statusChangedDates` for the same outfall (each date/time is a moment recorded discharging in the past). `scheduleMotorTriggers()` takes those dates and remaps their *relative spacing* onto the exhibition's opening hours:

- The exhibition window is `EXHIBIT_START_HOUR` to `EXHIBIT_START_HOUR + EXHIBIT_TIME_HOURS` (currently 11:00–20:00, 9h), anchored to wall-clock time via `getExhibitAnchor()` — so a server restart mid-exhibition resumes the remaining schedule instead of starting over from hour zero.
- The earliest historical date maps to t=0 (exhibition open), the latest maps to the end of the usable window, and everything else falls proportionally in between.
- That window is deliberately shortened by `DISCHARGE_DURATION_MS` (`exhibitDurationMs`) so the *last* scheduled event's full cycle (motor out + audio + motor back) finishes at exhibition close instead of only starting there.
- Each mapped time becomes a `setTimeout(..., delay)` that calls `triggerMotor()`. Any date that maps to a time already in the past (e.g. server restarted partway through the day) is skipped rather than fired immediately.

**What happens on trigger:** `triggerMotor()` writes `ROTATE\n` over serial to the `Rotate_StepperMotor_OSC` Arduino and, at the same time, calls `startDischargeAudioLoop()` on the server side. These are two independent timers, not a handshake — the Arduino moves the stepper out and, once it reaches position, waits locally for its own `RETURN_DELAY_MS` before moving back, while the server separately runs its own `DISCHARGE_DURATION_MS` audio loop. **The two constants must be kept equal** (see Usage → Arduino above), or the motor and audio will drift out of sync.

The audio loop draws tracks from `app/audio/discharge/*.wav` via a shuffled "bag" (`drawNextDischargeAudio()` — no repeats until every track has played once, even across a reshuffle) and plays them back-to-back with `afplay` for `DISCHARGE_DURATION_MS` (10 min). Before starting each track it checks the track's precomputed duration against the time remaining in the window (`readWavDurationMs()`, read once at startup from each file's WAV header) — if a track wouldn't finish in time, the loop ends early instead of starting it and overrunning, so audio never plays past the motor's own return time as long as the two constants match.

Setting `MOTOR_ENABLED = false` skips opening the serial port entirely — `triggerMotor()` still starts the audio loop, just without sending anything over serial — useful for testing the audio schedule alone without the Arduino connected.

`DEBUG_MODE = true` fires one `triggerMotor()` immediately on startup (instead of waiting for a scheduled time) and logs the EA/Thames Water requests more verbosely — turn it off for real exhibition runs so the schedule isn't jumped.

### 3. Arduino serial bridge

Serial output from the motor Arduino is line-buffered and echoed into the same log stream as `[Arduino] ...`, so a separate serial monitor isn't needed to see what the board is doing while the server runs.
