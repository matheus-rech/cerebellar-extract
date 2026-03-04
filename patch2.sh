#!/bin/bash
# Fixes: "The object can not be cloned" error
# Run from cerebellar-extract folder

set -e
echo "Patching pdfEngine.js..."

cat > src/lib/pdfEngine.js << 'EOF'
import * as pdfjsLib from 'pdfjs-dist'

// Disable Web Worker -- avoids "object can not be cloned" error on GitHub Pages.
// Runs on main thread instead. Fine for single-document extraction.
pdfjsLib.GlobalWorkerOptions.workerSrc = ''

let _cachedPdf = null
let _cachedBytes = null

export async function loadPDF(source) {
  // Always work with Uint8Array to avoid ArrayBuffer detachment
  let bytes
  if (source instanceof ArrayBuffer) {
    bytes = new Uint8Array(source)
  } else if (source instanceof Uint8Array) {
    bytes = source
  } else {
    // URL string -- fetch it
    const res = await fetch(source)
    bytes = new Uint8Array(await res.arrayBuffer())
  }

  // Cache to avoid re-parsing
  if (_cachedPdf && _cachedBytes === bytes) return _cachedPdf

  _cachedPdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise
  _cachedBytes = bytes
  return _cachedPdf
}

export async function extractPDFBlocks(source) {
  const pdf = await loadPDF(source)
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
  const pdf = await loadPDF(source)
  const page = await pdf.getPage(pageNum)
  const vp = page.getViewport({ scale })
  canvas.width = vp.width
  canvas.height = vp.height
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise
  return { width: vp.width, height: vp.height, scale }
}
EOF

echo "Building..."
npm run build 2>&1 | grep -E "built in|error"

echo "Committing and pushing..."
git add -A
git commit -m "fix: disable PDF.js worker to fix cloning error"
git push

echo ""
echo "Done. Wait ~1 min for redeploy."
