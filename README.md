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
