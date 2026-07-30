#include <I2S.h>
#include <BackgroundAudio.h>
#include <SD.h>

#define SD_CS     17
#define I2S_BCLK  26   // LRCK is automatically GP27, one above BCLK
#define I2S_DATA  28

I2S i2s(OUTPUT, I2S_BCLK, I2S_DATA);
BackgroundAudioWAV wav(i2s);

const int NUM_BUTTONS = 5;
const int buttonPins[NUM_BUTTONS] = {2, 3, 4, 5, 6};
const char* trackFiles[NUM_BUTTONS] = {"track1.wav", "track2.wav", "track3.wav", "track4.wav", "track5.wav"};

File currentFile;
unsigned long lastPress[NUM_BUTTONS] = {0, 0, 0, 0, 0};
const unsigned long DEBOUNCE_MS = 200;

// Interrupts whatever is currently streaming and starts a new track from byte 0.
void startTrack(const char* filename) {
  if (currentFile) {
    Serial.print(currentFile);
    currentFile.close();
  }

  // Reset the decoder's own parse state and internal ring buffer. Without this,
  // bytes left over from an interrupted track stay queued behind the new track's
  // header, so the WAV parser gets misaligned and eventually can't find a valid
  // RIFF/fmt/data sequence after repeated retriggers.
  wav.flush();

  currentFile = SD.open(filename);
  if (!currentFile) {
    Serial.print("ERROR: could not open ");
    Serial.println(filename);
  } else {
    Serial.print("Opened ");
    Serial.print(filename);
    Serial.print(", size = ");
    Serial.println(currentFile.size());
  }
}

void setup() {
  for (int i = 0; i < NUM_BUTTONS; i++) pinMode(buttonPins[i], INPUT_PULLUP);
  Serial.begin(9600);
  delay(2000);

  if (!SD.begin(SD_CS, SPI_QUARTER_SPEED)) {
    Serial.println("ERROR: SD.begin() failed - check wiring/CS pin/card format");
  } else {
    Serial.println("SD card OK");
  }

  // wav.begin() also initializes the underlying I2S peripheral, so no separate
  // i2s.begin() call is needed.
  wav.begin();
  Serial.println("wav.begin() done, ready");

  wav.setGain(2.0); // volume multiplier, 1.0 = unity
}

void loop() {
  // Poll buttons and (re)start playback on a debounced press.
  for (int i = 0; i < NUM_BUTTONS; i++) {
    if (digitalRead(buttonPins[i]) == LOW) {
      unsigned long now = millis();
      if (now - lastPress[i] > DEBOUNCE_MS) {
        Serial.print("Button ");
        Serial.print(i + 1);
        Serial.print(" (pin ");
        Serial.print(buttonPins[i]);
        Serial.println(") pressed");
        startTrack(trackFiles[i]);
        lastPress[i] = now;
      }
    }
  }

  // Stream the currently open file into the decoder's buffer in 512-byte chunks,
  // throttled by availableForWrite() so we never write faster than the I2S/IRQ
  // pump can drain it.
  while (currentFile && wav.availableForWrite() > 512) {
    uint8_t buf[512];
    int len = currentFile.read(buf, 512);
    wav.write(buf, len);
    if (len != 512) {
      // Short read means end of file.
      currentFile.close();
      Serial.println("Track finished / closed");
    }
  }
}