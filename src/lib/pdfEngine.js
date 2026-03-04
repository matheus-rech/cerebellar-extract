/**
 * Client-side PDF processing engine using PDF.js
 * Replaces PyMuPDF for browser deployment.
 *
 * Extracts text blocks with bounding box coordinates from PDF pages,
 * enabling the same block-aware provenance pipeline that runs server-side.
 */

import * as pdfjsLib from 'pdfjs-dist'

// Configure worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`

/**
 * @typedef {Object} PDFBlock
 * @property {string} blockId - Unique block identifier (e.g., "B0", "B1")
 * @property {number} page - 1-indexed page number
 * @property {number[]} rect - Bounding box [x0, y0, x1, y1] in PDF points
 * @property {string} text - The text content of this block
 * @property {number[]} viewport - Page dimensions [width, height]
 */

/**
 * Load a PDF from an ArrayBuffer or URL.
 */
export async function loadPDF(source) {
  const loadingTask = pdfjsLib.getDocument(
    source instanceof ArrayBuffer ? { data: source } : source
  )
  return await loadingTask.promise
}

/**
 * Extract all text blocks from a PDF with their coordinates.
 *
 * Groups text items into logical blocks by detecting paragraph breaks
 * (vertical gaps > 1.5x line height).
 *
 * @param {ArrayBuffer|string} source - PDF data or URL
 * @returns {Promise<{textForLLM: string, blocks: PDFBlock[], pageCount: number}>}
 */
export async function extractPDFBlocks(source) {
  const pdf = await loadPDF(source)
  const blocks = []
  let globalBlockIdx = 0
  let textForLLM = ''

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum)
    const viewport = page.getViewport({ scale: 1.0 })
    const textContent = await page.getTextContent()

    // Group text items into blocks (paragraphs)
    const pageBlocks = groupTextIntoBlocks(textContent.items, viewport)

    for (const block of pageBlocks) {
      if (!block.text.trim()) continue

      const blockId = `B${globalBlockIdx}`
      blocks.push({
        blockId,
        page: pageNum,
        rect: [
          Math.round(block.x0 * 10) / 10,
          Math.round(block.y0 * 10) / 10,
          Math.round(block.x1 * 10) / 10,
          Math.round(block.y1 * 10) / 10,
        ],
        text: block.text.trim(),
        viewport: [viewport.width, viewport.height],
      })

      textForLLM += `[${blockId}] ${block.text.trim()}\n\n`
      globalBlockIdx++
    }
  }

  return {
    textForLLM,
    blocks,
    pageCount: pdf.numPages,
  }
}

/**
 * Group individual text items into logical blocks (paragraphs).
 *
 * PDF.js returns individual text spans. This function merges them into
 * paragraph-level blocks by detecting vertical gaps.
 */
function groupTextIntoBlocks(items, viewport) {
  if (items.length === 0) return []

  // Convert PDF.js items to a normalized format
  // PDF.js uses bottom-left origin; we convert to top-left
  const normalized = items
    .filter(item => item.str && item.str.trim())
    .map(item => {
      const tx = item.transform
      const x = tx[4]
      const y = viewport.height - tx[5] // Flip Y axis
      const width = item.width
      const height = item.height || Math.abs(tx[3]) || 12

      return {
        text: item.str,
        x0: x,
        y0: y - height,
        x1: x + width,
        y1: y,
        height,
        fontName: item.fontName || '',
      }
    })
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)

  // Merge into blocks
  const blocks = []
  let current = null

  for (const item of normalized) {
    if (!current) {
      current = {
        text: item.text,
        x0: item.x0,
        y0: item.y0,
        x1: item.x1,
        y1: item.y1,
        lastY: item.y0,
        lineHeight: item.height,
      }
      continue
    }

    // Check if this item belongs to the same block
    const verticalGap = item.y0 - current.y1
    const threshold = current.lineHeight * 1.8

    if (verticalGap > threshold) {
      // New block
      blocks.push({
        text: current.text,
        x0: current.x0,
        y0: current.y0,
        x1: current.x1,
        y1: current.y1,
      })
      current = {
        text: item.text,
        x0: item.x0,
        y0: item.y0,
        x1: item.x1,
        y1: item.y1,
        lastY: item.y0,
        lineHeight: item.height,
      }
    } else {
      // Same block - merge
      const sameLine = Math.abs(item.y0 - current.lastY) < item.height * 0.5
      current.text += sameLine ? ' ' + item.text : ' ' + item.text
      current.x0 = Math.min(current.x0, item.x0)
      current.x1 = Math.max(current.x1, item.x1)
      current.y1 = Math.max(current.y1, item.y1)
      current.lastY = item.y0
    }
  }

  if (current) {
    blocks.push({
      text: current.text,
      x0: current.x0,
      y0: current.y0,
      x1: current.x1,
      y1: current.y1,
    })
  }

  return blocks
}

/**
 * Search for a text string on a specific page and return its coordinates.
 * Used for provenance verification - finding where a source_quote appears.
 *
 * @param {ArrayBuffer|string} source - PDF data
 * @param {number} pageNum - 1-indexed page number
 * @param {string} searchText - Text to find
 * @returns {Promise<{x0: number, y0: number, x1: number, y1: number}|null>}
 */
export async function findTextOnPage(source, pageNum, searchText) {
  const pdf = await loadPDF(source)
  const page = await pdf.getPage(pageNum)
  const viewport = page.getViewport({ scale: 1.0 })
  const textContent = await page.getTextContent()

  // Build full page text with positions
  const searchLower = searchText.toLowerCase()
  let fullText = ''
  const charPositions = [] // Map each character index to its position

  for (const item of textContent.items) {
    if (!item.str) continue
    const tx = item.transform
    const x = tx[4]
    const y = viewport.height - tx[5]
    const charWidth = item.width / Math.max(1, item.str.length)
    const height = item.height || Math.abs(tx[3]) || 12

    for (let i = 0; i < item.str.length; i++) {
      charPositions.push({
        x: x + i * charWidth,
        y: y - height,
        w: charWidth,
        h: height,
      })
    }
    fullText += item.str
    // Add space between items
    charPositions.push({ x: 0, y: 0, w: 0, h: 0 })
    fullText += ' '
  }

  const idx = fullText.toLowerCase().indexOf(searchLower)
  if (idx === -1) return null

  // Get bounding box of matched range
  const matchChars = charPositions.slice(idx, idx + searchText.length)
  const validChars = matchChars.filter(c => c.w > 0)
  if (validChars.length === 0) return null

  return {
    x0: Math.min(...validChars.map(c => c.x)),
    y0: Math.min(...validChars.map(c => c.y)),
    x1: Math.max(...validChars.map(c => c.x + c.w)),
    y1: Math.max(...validChars.map(c => c.y + c.h)),
  }
}

/**
 * Render a PDF page to a canvas element.
 *
 * @param {ArrayBuffer|string} source - PDF data
 * @param {number} pageNum - 1-indexed page number
 * @param {HTMLCanvasElement} canvas - Target canvas
 * @param {number} scale - Render scale (default 1.5)
 */
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
