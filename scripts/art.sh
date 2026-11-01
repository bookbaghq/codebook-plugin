#!/bin/sh
# Rebuilds hooks/art.ts from a folder of the CodeBook illustrations (480 px PNGs with transparency).
# Usage: scripts/art.sh <folder with factory.png plan.png ...>
# Needs cwebp (brew install webp).
set -eu
src=${1:?folder of PNGs}
here=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
names="factory plan build approve test ship here cloud templates"
for n in $names; do
  cwebp -quiet -q 82 -resize 192 0 "$src/$n.png" -o "$tmp/$n.webp"
done
{
  echo "// The CodeBook illustrations (MadeBook's clay style in CodeBook teal), 192 px WebP."
  echo "// Written by scripts/art.sh from the 480 px web copies; the pane draws them inside an Svg."
  echo
  echo "export const ART = {"
  for n in $names; do
    printf "  %s: 'data:image/webp;base64,%s',\n" "$n" "$(base64 -i "$tmp/$n.webp" | tr -d '\n')"
  done
  echo "} as const"
  echo
  echo "export type ArtName = keyof typeof ART"
} > "$here/hooks/art.ts"
rm -r "$tmp"
echo "wrote hooks/art.ts"
