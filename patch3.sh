#!/bin/bash
set -e
echo "Patching pdfEngine.js (worker via Vite URL import)..."

cat > src/lib/pdfEngine.js << 'EOF'
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

// Vite resolves the worker file as a static asset served from same origin.
// This avoids both CORS issues and structured clone errors.
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

let _cachedPdf = null
let _cachedId = 0

export async function loadPDF(source, id) {
  if (_cachedPdf && _cachedId === id) return _cachedPdf

  let data
  if (source instanceof ArrayBuffer) {
    data = new Uint8Array(source).slice()
  } else if (source instanceof Uint8Array) {
    data = source.slice()
  } else {
    const res = await fetch(source)
    data = new Uint8Array(await res.arrayBuffer())
  }

  _cachedPdf = await pdfjsLib.getDocument({ data }).promise
  _cachedId = id
  return _cachedPdf
}

// Unique ID per upload so cache invalidates on new file
let _uploadId = 0
let _currentSource = null

export async function extractPDFBlocks(source) {
  _uploadId++
  _currentSource = source
  const pdf = await loadPDF(source, _uploadId)
  const blocks = []
  let idx = 0
  let textForLLM = ''

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p)
    const vp = page.getViewport({ scale: 1.0 })
    const tc = await page.getTextContent()
    const pageBlocks = groupTextIntoBlocks(tc.items, vp)

    for (const b of pageBlocks) {
      if (!b.text.trim()) continue
      const blockId = `B${idx}`
      blocks.push({
        blockId, page: p,
        rect: [r(b.x0), r(b.y0), r(b.x1), r(b.y1)],
        text: b.text.trim(),
        viewport: [vp.width, vp.height],
      })
      textForLLM += `[${blockId}] ${b.text.trim()}\n\n`
      idx++
    }
  }
  return { textForLLM, blocks, pageCount: pdf.numPages }
}

function r(n) { return Math.round(n * 10) / 10 }

function groupTextIntoBlocks(items, viewport) {
  if (!items.length) return []

  const norm = items
    .filter(i => i.str && i.str.trim())
    .map(i => {
      const tx = i.transform
      const x = tx[4], y = viewport.height - tx[5]
      const h = i.height || Math.abs(tx[3]) || 12
      return { text: i.str, x0: x, y0: y - h, x1: x + i.width, y1: y, h }
    })
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)

  const blocks = []
  let cur = null

  for (const item of norm) {
    if (!cur) {
      cur = { text: item.text, x0: item.x0, y0: item.y0, x1: item.x1, y1: item.y1, lastY: item.y0, lh: item.h }
      continue
    }
    if (item.y0 - cur.y1 > cur.lh * 1.8) {
      blocks.push({ text: cur.text, x0: cur.x0, y0: cur.y0, x1: cur.x1, y1: cur.y1 })
      cur = { text: item.text, x0: item.x0, y0: item.y0, x1: item.x1, y1: item.y1, lastY: item.y0, lh: item.h }
    } else {
      cur.text += ' ' + item.text
      cur.x0 = Math.min(cur.x0, item.x0)
      cur.x1 = Math.max(cur.x1, item.x1)
      cur.y1 = Math.max(cur.y1, item.y1)
      cur.lastY = item.y0
    }
  }
  if (cur) blocks.push({ text: cur.text, x0: cur.x0, y0: cur.y0, x1: cur.x1, y1: cur.y1 })
  return blocks
}

export async function renderPage(source, pageNum, canvas, scale = 1.5) {
  const pdf = await loadPDF(source, _uploadId)
  const page = await pdf.getPage(pageNum)
  const vp = page.getViewport({ scale })
  canvas.width = vp.width
  canvas.height = vp.height
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise
  return { width: vp.width, height: vp.height, scale }
}
EOF

echo "Building..."

# Also update vite.config.js to use pdf-lib chunk name
cat > vite.config.js << 'VCEOF'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/cerebellar-extract/',
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          'pdf-lib': ['pdfjs-dist'],
        },
      },
    },
  },
  optimizeDeps: {
    include: ['pdfjs-dist'],
  },
})
VCEOF

BUILD=$(npm run build 2>&1)
if echo "$BUILD" | grep -q "built in"; then
  echo "$BUILD" | grep "built in"
  echo "Pushing..."
  git add -A
  git commit -m "fix: proper PDF.js worker via Vite URL import"
  git push
  echo "Done. Wait ~1 min for redeploy."
else
  echo "$BUILD"
  echo "Build failed."
fi
