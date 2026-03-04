#!/bin/bash
set -e

G='\033[0;32m'
C='\033[0;36m'
R='\033[0;31m'
N='\033[0m'

echo ""
echo -e "${C}  CEREBELLAR-EXTRACT v2 -- Full Rebuild${N}"
echo ""

if [ ! -d ".git" ]; then
  echo -e "${R}Run this from inside your cerebellar-extract git folder${N}"
  exit 1
fi

ZIP=""
for loc in \
  "cerebellar-extract-v2.zip" \
  "$HOME/Downloads/cerebellar-extract-v2.zip" \
  "../cerebellar-extract-v2.zip"; do
  [ -f "$loc" ] && ZIP="$loc" && break
done

if [ -z "$ZIP" ]; then
  echo -e "${R}Put cerebellar-extract-v2.zip in ~/Downloads or current dir${N}"
  exit 1
fi

echo -e "${G}[1/6]${N} Cleaning..."
rm -f patch.sh patch2.sh patch3.sh deploy.sh
rm -rf public/ scripts/ __MACOSX/ cerebellar-extract-v2/

echo -e "${G}[2/6]${N} Extracting v2..."
TMPEXTRACT=$(mktemp -d)
unzip -o "$ZIP" -d "$TMPEXTRACT" > /dev/null 2>&1

# Kill macOS junk
find "$TMPEXTRACT" -name "__MACOSX" -exec rm -rf {} + 2>/dev/null || true
find "$TMPEXTRACT" -name ".DS_Store" -delete 2>/dev/null || true

# Find where package.json actually is (handles any nesting)
PKG=$(find "$TMPEXTRACT" -name "package.json" -not -path "*/node_modules/*" | head -1)
if [ -z "$PKG" ]; then
  echo -e "${R}package.json not found in zip${N}"
  rm -rf "$TMPEXTRACT"
  exit 1
fi
SRCDIR=$(dirname "$PKG")

# Copy everything into current project
cp -f "$SRCDIR/package.json" ./
cp -f "$SRCDIR/vite.config.js" ./
cp -f "$SRCDIR/index.html" ./
cp -f "$SRCDIR/.gitignore" ./
cp -f "$SRCDIR/README.md" ./ 2>/dev/null || true

rm -rf src/ && cp -r "$SRCDIR/src" ./src
rm -rf scripts/ && cp -r "$SRCDIR/scripts" ./scripts
rm -rf public/ && cp -r "$SRCDIR/public" ./public

mkdir -p .github/workflows
cp -f "$SRCDIR/.github/workflows/deploy.yml" ./.github/workflows/

rm -rf "$TMPEXTRACT" cerebellar-extract-v2/ __MACOSX/

echo "  Files copied"

echo -e "${G}[3/6]${N} Installing..."
npm install 2>&1 | tail -3

echo -e "${G}[4/6]${N} Building..."
npm run build 2>&1 | grep -E "built in|error|copy-worker"

echo -e "${G}[5/6]${N} Verifying..."
if [ -f "dist/pdf.worker.min.mjs" ]; then
  SIZE=$(wc -c < dist/pdf.worker.min.mjs | tr -d ' ')
  echo -e "  ${G}Worker: YES (${SIZE} bytes)${N}"
else
  echo -e "  ${R}Worker: MISSING${N}"
  ls dist/ 2>/dev/null
  exit 1
fi

echo -e "${G}[6/6]${N} Pushing..."
git add -A
git commit -m "v2: bulletproof PDF.js worker via public/ static file"
git push --force

echo ""
echo -e "${G}Done!${N} Test at:"
echo -e "${C}  https://matheus-rech.github.io/cerebellar-extract/${N}"
echo ""
