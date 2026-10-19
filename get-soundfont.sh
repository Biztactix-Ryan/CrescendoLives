#!/bin/sh
# Downloads the GeneralUser GS SoundFont (~31 MB) used for Wavetable mode.
# GeneralUser GS by S. Christian Collins — free to use and redistribute.
# https://github.com/mrbumpy409/GeneralUser-GS
set -e
cd "$(dirname "$0")"
mkdir -p soundfonts
curl -fL --progress-bar -o soundfonts/GeneralUser-GS.sf2 \
  https://raw.githubusercontent.com/mrbumpy409/GeneralUser-GS/main/GeneralUser-GS.sf2
echo "Saved soundfonts/GeneralUser-GS.sf2"
