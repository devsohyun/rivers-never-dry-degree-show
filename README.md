# rivers-never-dry-degree-show
Rivers Never Dry installation for MA Computational Arts Degree Show 2026

## Usage

### Audio

The BackgroundAudioWAV decoder in the library using is very strict — it only accepts linear PCM (format tag 1) with an exact canonical 16-byte fmt chunk. Its check is:

if ((b[4] != 16) || b[5] || b[6] || b[7] || (b[8] != 1) || b[9]) {
    // Length for format not PCM, ignore this
    _errors++;
    ...
}

Cean 16-bit linear PCM, 44100Hz, stereo, exact 16-byte fmt chunk will work.

Use ffmpeg to convert audio into 16-bit linear PCM if it is not in this format.
