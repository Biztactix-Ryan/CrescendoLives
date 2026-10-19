#!/bin/sh
# Serves The MIDI Lounge at http://localhost:8097 (browsers won't fetch .mid files from file://).
cd "$(dirname "$0")"
[ -f soundfonts/GeneralUser-GS.sf2 ] || echo "Tip: run ./get-soundfont.sh for Wavetable sound (FM synth works without it)."
echo "Open http://localhost:8097/"
exec python3 -m http.server 8097 --bind 127.0.0.1
