#!/usr/bin/env bash
# Regenerate the PNG icon set from src/icons/icon.svg.
#
# The PNGs are checked in -- the manifest references them and the Web Store
# listing needs the 128 -- so this only needs running when the artwork changes.
#
# Requires ImageMagick (brew install imagemagick).
set -euo pipefail

cd "$(dirname "$0")/.."

src=src/icons/icon.svg
command -v magick >/dev/null || { echo "magick not found; brew install imagemagick" >&2; exit 1; }

for size in 16 32 48 128; do
  magick -background none -density 384 "$src" \
    -resize "${size}x${size}" \
    -strip \
    "src/icons/${size}.png"
  echo "src/icons/${size}.png"
done
