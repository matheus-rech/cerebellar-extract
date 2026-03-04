#!/bin/bash
# Quick patch: fixes PDF upload (ArrayBuffer detachment + file input click)
# Run from inside your cerebellar-extract folder:
#   chmod +x patch.sh && ./patch.sh

set -e

GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

echo ""
echo -e "${CYAN}Patching PDF upload...${NC}"
echo ""

if [ ! -f "src/App.jsx" ]; then
  echo "Run this from inside the cerebellar-extract folder."
  exit 1
fi

# ---- Fix 1: pdfEngine.js (ArrayBuffer detachment + worker URL) ----

cat > src/lib/pdfEngine.js << 'PDFEOF'
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
PDFEOF

echo -e "${GREEN}[+]${NC} Fixed src/lib/pdfEngine.js"

# ---- Fix 2: App.jsx file input (replace label wrapper with ref click) ----

# Use sed to fix the file input section
# Replace the label-wrapped input with div + ref click
python3 << 'PYEOF'
import re

with open("src/App.jsx", "r") as f:
    content = f.read()

# Add fileInputRef
content = content.replace(
    "const canvasRef = useRef(null)\n  const overlayRef = useRef(null)",
    "const canvasRef = useRef(null)\n  const overlayRef = useRef(null)\n  const fileInputRef = useRef(null)"
)

# Only fix if the old label pattern exists
if '<label style={{' in content and "display: 'block', border: '2px dashed" in content:
    old_upload = '''            {/* PDF Upload */}
            <div style={{ marginBottom: 20 }}>
              <label style={S.label()}>Upload PDF</label>
              <label style={{
                display: 'block', border: '2px dashed #1a2535', borderRadius: 8,
                padding: 24, textAlign: 'center', cursor: 'pointer',
                transition: 'border-color 0.2s',
              }}>
                <input type="file" accept=".pdf" style={{ display: 'none' }}
                  onChange={e => e.target.files[0] && handlePDFUpload(e.target.files[0])} />
                {pdfData ? (
                  <span style={{ fontSize: 12, color: '#4dd868' }}>{pdfName}</span>
                ) : (
                  <span style={{ fontSize: 12, color: '#5a6578' }}>Drop or click to upload PDF</span>
                )}
              </label>
            </div>'''

    new_upload = '''            {/* PDF Upload */}
            <div style={{ marginBottom: 20 }}>
              <label style={S.label()}>Upload PDF</label>
              <input ref={fileInputRef} type="file" accept=".pdf"
                style={{ display: 'none' }}
                onChange={e => {
                  const file = e.target.files?.[0]
                  if (file) handlePDFUpload(file)
                }} />
              <div
                onClick={() => fileInputRef.current?.click()}
                style={{
                  border: '2px dashed #1a2535', borderRadius: 8,
                  padding: 24, textAlign: 'center', cursor: 'pointer',
                  transition: 'border-color 0.2s',
                }}
                onMouseEnter={e => e.currentTarget.style.borderColor = '#4da3e8'}
                onMouseLeave={e => e.currentTarget.style.borderColor = '#1a2535'}
              >
                {pdfData ? (
                  <span style={{ fontSize: 12, color: '#4dd868' }}>{pdfName}</span>
                ) : (
                  <span style={{ fontSize: 12, color: '#5a6578' }}>Click to upload PDF</span>
                )}
              </div>
            </div>'''

    content = content.replace(old_upload, new_upload)

with open("src/App.jsx", "w") as f:
    f.write(content)

print("done")
PYEOF

echo -e "${GREEN}[+]${NC} Fixed src/App.jsx file input"

# ---- Build ----

echo ""
echo -e "${CYAN}Building...${NC}"
npm run build 2>&1 | grep -E "built in|error"

# ---- Push ----

echo ""
git add -A
git commit -m "fix: PDF upload (ArrayBuffer detachment + file input click)"
git push

echo ""
echo -e "${GREEN}Pushed! Wait ~1 min for GitHub Pages to redeploy.${NC}"
echo ""
