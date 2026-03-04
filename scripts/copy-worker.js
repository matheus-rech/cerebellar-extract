import { copyFileSync, mkdirSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const pubDir = join(root, 'public')
const require = createRequire(import.meta.url)

mkdirSync(pubDir, { recursive: true })

try {
  const workerPath = require.resolve('pdfjs-dist/build/pdf.worker.min.mjs')
  const dest = join(pubDir, 'pdf.worker.min.mjs')
  copyFileSync(workerPath, dest)
  console.log('[copy-worker] Copied pdf.worker.min.mjs to public/')
} catch (e) {
  console.warn('[copy-worker] Warning:', e.message)
}
