#!/usr/bin/env bash
# Build site/public/assets/og.png (1200x630) with ImageMagick primitives
set -euo pipefail
FONT="/System/Library/Fonts/Supplemental/Arial.ttf"
BOLD="/System/Library/Fonts/Supplemental/Arial Bold.ttf"
OUT="$(cd "$(dirname "$0")" && pwd)/og.png"

magick -size 1200x630 gradient:'#ffffff-#e9f0fc' \
  -fill '#2f6fed' -draw 'rectangle 0,0 1200,6' \
  -fill '#2f6fed' -draw 'roundrectangle 96,84 142,130 12,12' \
  -fill '#ffffff' -draw 'roundrectangle 114,92 126,106 6,6' \
  -fill none -stroke '#ffffff' -strokewidth 2.2 -draw 'path "M 110 101 A 10 10 0 0 0 130 101"' \
  -stroke none -fill '#ffffff' -draw 'rectangle 118,109 122,117' \
  -fill '#ffffff' -draw 'roundrectangle 114,118 126,121 1.5,1.5' \
  -font "$BOLD" -pointsize 27 -fill '#16181d' -annotate +156+116 'PhoneMic' \
  -pointsize 66 -fill '#16181d' -annotate +96+264 'Your phone is' \
  -fill '#2f6fed' -annotate +96+340 'your microphone.' \
  -font "$FONT" -pointsize 25 -fill '#5b6270' \
  -annotate +96+404 'Scan a QR code on your Mac and start talking.' \
  -annotate +96+442 'Nothing to install on the phone · end-to-end encrypted' \
  -fill '#ffffff' -stroke '#dbe5fb' -strokewidth 1.4 \
  -draw 'roundrectangle 96,492 228,532 20,20' \
  -draw 'roundrectangle 240,492 400,532 20,20' \
  -draw 'roundrectangle 412,492 596,532 20,20' \
  -stroke none -font "$FONT" -pointsize 17 -fill '#3d4657' \
  -annotate +118+518 'Free · MIT' \
  -annotate +262+518 'macOS 12+' \
  -annotate +434+518 'E2E encrypted' \
  -fill '#ffffff' -stroke '#dfe3ea' -strokewidth 1.6 \
  -draw 'roundrectangle 812,216 1024,360 13,13' \
  -fill '#e8ebf0' -stroke none \
  -draw 'roundrectangle 876,366 916,372 3,3' \
  -draw 'roundrectangle 866,372 926,378 3,3' \
  -fill '#f6f8fb' -stroke '#e6e8ec' -strokewidth 1 \
  -draw 'roundrectangle 836,242 896,302 3,3' \
  -fill '#2f6fed' -stroke none \
  -draw 'roundrectangle 840,246 856,262 2,2' \
  -draw 'roundrectangle 876,246 892,262 2,2' \
  -draw 'roundrectangle 840,282 856,298 2,2' \
  -draw 'rectangle 862,270 868,276' \
  -draw 'rectangle 874,264 880,270' \
  -draw 'rectangle 880,276 886,282' \
  -draw 'rectangle 866,252 872,256' \
  -fill '#dbe5fb' \
  -draw 'roundrectangle 910,246 986,255 4.5,4.5' \
  -draw 'roundrectangle 910,266 974,275 4.5,4.5' \
  -draw 'roundrectangle 910,286 972,295 4.5,4.5' \
  -fill '#dde6f8' \
  -draw 'roundrectangle 836,320 988,332 5,5' \
  -fill '#ffffff' -stroke '#dfe3ea' -strokewidth 1.8 \
  -draw 'roundrectangle 940,150 1090,420 30,30' \
  -fill '#e8ebf0' -stroke none \
  -draw 'roundrectangle 1000,162 1030,167 2.5,2.5' \
  -fill '#2f6fed66' -draw 'roundrectangle 993,272 998,298 2.5,2.5' \
  -fill '#2f6feda6' -draw 'roundrectangle 1003,258 1008,312 2.5,2.5' \
  -fill '#2f6fed'   -draw 'roundrectangle 1013,244 1018,326 2.5,2.5' \
  -fill '#2f6fedb3' -draw 'roundrectangle 1023,262 1028,308 2.5,2.5' \
  -fill '#2f6fed73' -draw 'roundrectangle 1033,276 1038,294 2.5,2.5' \
  "$OUT"

magick "$OUT" -strip -define png:color-type=6 -quality 92 "$OUT.tmp.png" && mv "$OUT.tmp.png" "$OUT"
magick identify "$OUT"
