#include <I2S.h>

// Same I2S pins as interactive_map.ino - keep in sync with that project.
#define I2S_BCLK  26   // LRCK is automatically GP27, one above BCLK
#define I2S_DATA  28

I2S i2s(OUTPUT, I2S_BCLK, I2S_DATA);

const int SAMPLE_RATE = 44100;
const float TONE_HZ = 440.0;  // A4, easy to recognize by ear
const int16_t AMPLITUDE = 8000;

float phase = 0.0;
const float phaseIncrement = 2.0 * PI * TONE_HZ / SAMPLE_RATE;

void setup() {
  Serial.begin(9600);
  delay(2000);

  i2s.setBitsPerSample(16);
  if (!i2s.begin(SAMPLE_RATE)) {
    Serial.println("ERROR: i2s.begin() failed");
    while (1) delay(1000);
  }
  Serial.println("I2S started - you should hear a steady 440Hz tone now");
}

void loop() {
  while (i2s.availableForWrite() > 0) {
    int16_t sample = (int16_t)(AMPLITUDE * sin(phase));
    i2s.write(sample);  // left channel
    i2s.write(sample);  // right channel

    phase += phaseIncrement;
    if (phase > 2.0 * PI) phase -= 2.0 * PI;
  }
}
