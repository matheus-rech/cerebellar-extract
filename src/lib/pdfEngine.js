import * as pdfjsLib from 'pdfjs-dist'
import PDFWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker'

pdfjsLib.GlobalWorkerOptions.workerPort = new PDFWorker()

let _pdf = null
let _pdfId = 0

async function getPdf(source, id) {
  if (_pdf && _pdfId === id) return _pdf
  let data
  if (source instanceof ArrayBuffer) data = new Uint8Array(source).slice()
  else if (source instanceof Uint8Array) data = source.slice()
  else { const r = await fetch(source); data = new Uint8Array(await r.arrayBuffer()) }
  _pdf = await pdfjsLib.getDocument({ data }).promise
  _pdfId = id
  return _pdf
}

let _uid = 0

export async function extractPDFBlocks(source) {
  _uid++
  const pdf = await getPdf(source, _uid)
  const blocks = []
  let idx = 0
  let textForLLM = ''
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p)
    const vp = page.getViewport({ scale: 1.0 })
    const tc = await page.getTextContent()
    for (const b of group(tc.items, vp)) {
      if (!b.text.trim()) continue
      const id = 'B' + idx
      blocks.push({ blockId: id, page: p, rect: [rnd(b.x0), rnd(b.y0), rnd(b.x1), rnd(b.y1)], text: b.text.trim(), viewport: [vp.width, vp.height] })
      textForLLM += '[' + id + '] ' + b.text.trim() + '\n\n'
      idx++
    }
  }
  return { textForLLM, blocks, pageCount: pdf.numPages }
}

export async function renderPage(source, pageNum, canvas, scale = 1.5) {
  const pdf = await getPdf(source, _uid)
  const page = await pdf.getPage(pageNum)
  const vp = page.getViewport({ scale })
  canvas.width = vp.width
  canvas.height = vp.height
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise
  return { width: vp.width, height: vp.height, scale }
}

function rnd(n) { return Math.round(n * 10) / 10 }

function group(items, vp) {
  if (!items.length) return []
  const norm = items.filter(i => i.str && i.str.trim()).map(i => {
    const t = i.transform, x = t[4], y = vp.height - t[5], h = i.height || Math.abs(t[3]) || 12
    return { text: i.str, x0: x, y0: y - h, x1: x + i.width, y1: y, h }
  }).sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)
  const out = []; let c = null
  for (const i of norm) {
    if (!c) { c = { ...i, lh: i.h }; continue }
    if (i.y0 - c.y1 > c.lh * 1.8) { out.push(c); c = { ...i, lh: i.h } }
    else { c.text += ' ' + i.text; c.x0 = Math.min(c.x0, i.x0); c.x1 = Math.max(c.x1, i.x1); c.y1 = Math.max(c.y1, i.y1) }
  }
  if (c) out.push(c)
  return out
}
