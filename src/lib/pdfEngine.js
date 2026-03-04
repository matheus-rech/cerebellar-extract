/**
 * PDF processing engine using PDF.js
 * 
 * Worker strategy: the worker file lives in public/ and is served
 * as a static asset from the same origin. This avoids all CORS,
 * structured clone, and ESM module type issues.
 */
import * as pdfjsLib from 'pdfjs-dist'

// Worker is copied to public/ by scripts/copy-worker.js (runs on npm install).
// Vite serves public/ files at BASE_URL root.
pdfjsLib.GlobalWorkerOptions.workerSrc = `${import.meta.env.BASE_URL}pdf.worker.min.mjs`

// ---- PDF cache ----
let _pdf = null
let _pdfId = 0
let _pdfBytes = null  // Keep bytes for re-rendering

async function getPdf(source) {
  // Convert source to Uint8Array
  let bytes
  if (source instanceof ArrayBuffer) {
    bytes = new Uint8Array(source)
  } else if (source instanceof Uint8Array) {
    bytes = source
  } else {
    const r = await fetch(source)
    bytes = new Uint8Array(await r.arrayBuffer())
  }

  // Return cached if same bytes reference
  if (_pdf && _pdfBytes === bytes) return _pdf

  // Always pass a COPY to getDocument to prevent ArrayBuffer detachment
  const copy = bytes.slice()
  
  try {
    _pdf = await pdfjsLib.getDocument({ data: copy }).promise
  } catch (err) {
    console.error('[CE] getDocument failed, trying without worker:', err)
    // Fallback: disable worker and retry
    pdfjsLib.GlobalWorkerOptions.workerSrc = ''
    _pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise
  }
  
  _pdfBytes = bytes
  _pdfId++
  return _pdf
}

// ---- Public API ----

export async function extractPDFBlocks(source) {
  const pdf = await getPdf(source)
  const blocks = []
  let idx = 0
  let textForLLM = ''

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p)
    const vp = page.getViewport({ scale: 1.0 })
    const tc = await page.getTextContent()
    const grouped = groupIntoBlocks(tc.items, vp)

    for (const b of grouped) {
      const text = b.text.trim()
      if (!text) continue
      const blockId = 'B' + idx
      blocks.push({
        blockId,
        page: p,
        rect: [rnd(b.x0), rnd(b.y0), rnd(b.x1), rnd(b.y1)],
        text,
        viewport: [vp.width, vp.height],
      })
      textForLLM += '[' + blockId + '] ' + text + '\n\n'
      idx++
    }
  }

  return { textForLLM, blocks, pageCount: pdf.numPages }
}

export async function renderPage(source, pageNum, canvas, scale = 1.5) {
  const pdf = await getPdf(source)
  const page = await pdf.getPage(pageNum)
  const vp = page.getViewport({ scale })
  canvas.width = vp.width
  canvas.height = vp.height
  const ctx = canvas.getContext('2d')
  await page.render({ canvasContext: ctx, viewport: vp }).promise
  return { width: vp.width, height: vp.height, scale }
}

// ---- Internal helpers ----

function rnd(n) { return Math.round(n * 10) / 10 }

function groupIntoBlocks(items, viewport) {
  if (!items.length) return []

  // Normalize PDF.js text items to top-left origin
  const normalized = items
    .filter(i => i.str && i.str.trim())
    .map(i => {
      const tx = i.transform
      const x = tx[4]
      const y = viewport.height - tx[5]
      const h = i.height || Math.abs(tx[3]) || 12
      return { text: i.str, x0: x, y0: y - h, x1: x + i.width, y1: y, h }
    })
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)

  // Merge items into paragraph blocks based on vertical gaps
  const blocks = []
  let cur = null

  for (const item of normalized) {
    if (!cur) {
      cur = { text: item.text, x0: item.x0, y0: item.y0, x1: item.x1, y1: item.y1, lineHeight: item.h }
      continue
    }

    const gap = item.y0 - cur.y1
    if (gap > cur.lineHeight * 1.8) {
      // New block
      blocks.push({ text: cur.text, x0: cur.x0, y0: cur.y0, x1: cur.x1, y1: cur.y1 })
      cur = { text: item.text, x0: item.x0, y0: item.y0, x1: item.x1, y1: item.y1, lineHeight: item.h }
    } else {
      // Same block
      cur.text += ' ' + item.text
      cur.x0 = Math.min(cur.x0, item.x0)
      cur.x1 = Math.max(cur.x1, item.x1)
      cur.y1 = Math.max(cur.y1, item.y1)
    }
  }

  if (cur) blocks.push({ text: cur.text, x0: cur.x0, y0: cur.y0, x1: cur.x1, y1: cur.y1 })
  return blocks
}
