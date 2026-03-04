/**
 * Client-side PDF processing using PDF.js.
 * Extracts text blocks with bounding box coordinates.
 */

import * as pdfjsLib from 'pdfjs-dist'

pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`

let _cachedPdf = null
let _cachedSource = null

export async function loadPDF(source) {
  if (_cachedPdf && _cachedSource === source) return _cachedPdf
  const data = source instanceof ArrayBuffer
    ? { data: new Uint8Array(source) }
    : source
  const loadingTask = pdfjsLib.getDocument(data)
  _cachedPdf = await loadingTask.promise
  _cachedSource = source
  return _cachedPdf
}

export async function extractPDFBlocks(source) {
  const pdf = await loadPDF(source)
  const blocks = []
  let globalBlockIdx = 0
  let textForLLM = ''

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum)
    const viewport = page.getViewport({ scale: 1.0 })
    const textContent = await page.getTextContent()
    const pageBlocks = groupTextIntoBlocks(textContent.items, viewport)

    for (const block of pageBlocks) {
      if (!block.text.trim()) continue
      const blockId = `B${globalBlockIdx}`
      blocks.push({
        blockId, page: pageNum,
        rect: [
          Math.round(block.x0 * 10) / 10, Math.round(block.y0 * 10) / 10,
          Math.round(block.x1 * 10) / 10, Math.round(block.y1 * 10) / 10,
        ],
        text: block.text.trim(),
        viewport: [viewport.width, viewport.height],
      })
      textForLLM += `[${blockId}] ${block.text.trim()}\n\n`
      globalBlockIdx++
    }
  }

  return { textForLLM, blocks, pageCount: pdf.numPages }
}

function groupTextIntoBlocks(items, viewport) {
  if (items.length === 0) return []

  const normalized = items
    .filter(item => item.str && item.str.trim())
    .map(item => {
      const tx = item.transform
      const x = tx[4], y = viewport.height - tx[5]
      const width = item.width
      const height = item.height || Math.abs(tx[3]) || 12
      return { text: item.str, x0: x, y0: y - height, x1: x + width, y1: y, height }
    })
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)

  const blocks = []
  let current = null

  for (const item of normalized) {
    if (!current) {
      current = { text: item.text, x0: item.x0, y0: item.y0, x1: item.x1, y1: item.y1, lastY: item.y0, lineHeight: item.height }
      continue
    }
    const verticalGap = item.y0 - current.y1
    if (verticalGap > current.lineHeight * 1.8) {
      blocks.push({ text: current.text, x0: current.x0, y0: current.y0, x1: current.x1, y1: current.y1 })
      current = { text: item.text, x0: item.x0, y0: item.y0, x1: item.x1, y1: item.y1, lastY: item.y0, lineHeight: item.height }
    } else {
      const sameLine = Math.abs(item.y0 - current.lastY) < item.height * 0.5
      current.text += sameLine ? ' ' + item.text : ' ' + item.text
      current.x0 = Math.min(current.x0, item.x0)
      current.x1 = Math.max(current.x1, item.x1)
      current.y1 = Math.max(current.y1, item.y1)
      current.lastY = item.y0
    }
  }
  if (current) blocks.push({ text: current.text, x0: current.x0, y0: current.y0, x1: current.x1, y1: current.y1 })
  return blocks
}

export async function renderPage(source, pageNum, canvas, scale = 1.5) {
  const pdf = await loadPDF(source)
  const page = await pdf.getPage(pageNum)
  const viewport = page.getViewport({ scale })
  canvas.width = viewport.width
  canvas.height = viewport.height
  const ctx = canvas.getContext('2d')
  await page.render({ canvasContext: ctx, viewport }).promise
  return { width: viewport.width, height: viewport.height, scale }
}
