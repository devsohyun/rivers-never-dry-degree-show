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

Keep the discharge duration in sync across both files. They're independent timers and only stay aligned if updated together.

| File | Constant |
|---|---|
| `server.js` | `DISCHARGE_DURATION_MS` |
| `Rotate_StepperMotor_OSC.ino` | `RETURN_DELAY_MS` |

### Audio

The `BackgroundAudioWAV` decoder (used in `InteractiveMap_AudioPlayer.ino`) is strict about WAV format: it only accepts linear PCM (format tag 1) with an exact canonical 16-byte `fmt` chunk. Files must be clean 16-bit linear PCM, 44100Hz, stereo.

Convert non-conforming files with ffmpeg:
```
ffmpeg -i input.wav -acodec pcm_s16le -ar 44100 -ac 2 output.wav
```

## `server.js`

One process (`node server`, run from `server/`) with three mostly-independent jobs:

1. Poll live water data out to TouchDesigner over OSC
2. Run the timed discharge schedule (stepper motor + audio)
3. Bridge the Arduino's serial output into its own logs

### 1. Live data polling to OSC

Every `POLL_INTERVAL_MS` (15 min), `pollAll()` runs two independent fetches and pushes results to TouchDesigner over OSC (`OSC_CLIENT`, `127.0.0.1:8000`):

- **`pollWaterQuality()`**: queries the Environment Agency hydrology API for station `CADOG2` (dissolved oxygen, temperature, salinity, turbidity, pH, ammonium, conductivity, full list in `MEASURES`). Measure IDs are resolved once via `findMeasureIds()` and cached. Each reading goes to its own OSC address (e.g. `/ea/ph`), plus `/ea/last_updated`.
- **`pollDischargeStatus()`**: queries the Thames Water open data API for the `TWL00400` outfall (South West Storm Relief CSO), and sends its live discharging state (`/thames/discharging`, `/thames/discharge_status`) plus a network-wide count of currently-discharging outfalls.

Both requests are wrapped in try/catch, so a hung or failing API (the EA one is known to occasionally hang with no error) doesn't take down polling for the other, or for future cycles.

### 2. The discharge schedule (motor + audio)

This drives the physical installation, on a separate timeline from the live OSC polling above. It uses historical discharge events only, not live ones.

**Schedule source:** `server/data/discharge-schedule.json` holds real historical `statusChangedDates` for the same outfall (each one a moment recorded discharging in the past). `scheduleMotorTriggers()` remaps their *relative spacing* onto the exhibition's opening hours:

- Exhibition window: `EXHIBIT_START_HOUR` to `EXHIBIT_START_HOUR + EXHIBIT_TIME_HOURS` (currently 11:00-20:00, 9h), anchored to wall-clock time via `getExhibitAnchor()`. A server restart mid-exhibition resumes the remaining schedule instead of starting over from hour zero.
- Earliest historical date maps to t=0 (exhibition open), latest maps to the end of the usable window, everything else falls proportionally in between.
- The window is shortened by `DISCHARGE_DURATION_MS` (`exhibitDurationMs`) so the *last* scheduled event's full cycle (motor out, audio, motor back) finishes at exhibition close rather than only starting there.
- Each mapped time becomes a `setTimeout(..., delay)` calling `triggerMotor()`. A date that maps to a time already in the past (e.g. server restarted partway through the day) is skipped rather than fired immediately.

**On trigger:** `triggerMotor()` writes `ROTATE\n` over serial to the `Rotate_StepperMotor_OSC` Arduino and calls `startDischargeAudioLoop()` on the server, at the same time. These are two independent timers, not a handshake:

- The Arduino moves the stepper out, reaches position, then waits locally for its own `RETURN_DELAY_MS` before moving back.
- The server separately runs its own `DISCHARGE_DURATION_MS` audio loop.
- **The two constants must match** (see Usage → Arduino above), or the motor and audio will drift out of sync.

The audio loop draws tracks from `app/audio/discharge/*.wav` via a shuffled "bag" (`drawNextDischargeAudio()`, no repeats until every track has played once, even across a reshuffle) and plays them back-to-back with `afplay` for `DISCHARGE_DURATION_MS` (10 min). Before each track it checks the track's precomputed duration (`readWavDurationMs()`, read once at startup from each file's WAV header) against the time remaining in the window. If a track wouldn't finish in time, the loop ends early instead of overrunning, so audio never plays past the motor's own return time as long as the two constants match.

**Flags:**

| Flag | Effect |
|---|---|
| `MOTOR_ENABLED = false` | Skips opening the serial port entirely. `triggerMotor()` still starts the audio loop, without sending anything over serial. Useful for testing the audio schedule alone. |
| `DEBUG_MODE = true` | Fires one `triggerMotor()` immediately on startup instead of waiting for a scheduled time, and logs EA/Thames Water requests more verbosely. Turn off for real exhibition runs. |

### 3. Arduino serial bridge

Serial output from the motor Arduino is line-buffered and echoed into the same log stream as `[Arduino] ...`, so no separate serial monitor is needed to see what the board is doing while the server runs.
