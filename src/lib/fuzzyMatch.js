/**
 * Lightweight fuzzy string matching for provenance verification.
 * No external dependencies - replaces thefuzz/python-Levenshtein.
 */

/**
 * Compute the ratio of matching characters between two strings (0-100).
 * Uses a simplified partial ratio approach.
 */
export function partialRatio(query, target) {
  if (!query || !target) return 0
  const q = query.toLowerCase()
  const t = target.toLowerCase()

  if (t.includes(q)) return 100
  if (q.includes(t)) return 100

  // Sliding window approach
  const shorter = q.length <= t.length ? q : t
  const longer = q.length <= t.length ? t : q

  let bestRatio = 0
  for (let i = 0; i <= longer.length - shorter.length; i++) {
    const window = longer.slice(i, i + shorter.length)
    const ratio = simpleRatio(shorter, window)
    if (ratio > bestRatio) bestRatio = ratio
  }

  return bestRatio
}

function simpleRatio(a, b) {
  if (a === b) return 100
  if (!a || !b) return 0

  let matches = 0
  const bChars = b.split('')
  for (const ch of a) {
    const idx = bChars.indexOf(ch)
    if (idx !== -1) {
      matches++
      bChars[idx] = null // Used
    }
  }

  return Math.round((2 * matches / (a.length + b.length)) * 100)
}

/**
 * Verify that a source_quote exists in a block's text.
 * Returns { verified: boolean, score: number }
 */
export function verifyQuote(quote, blockText, threshold = 80) {
  const score = partialRatio(quote, blockText)
  return { verified: score >= threshold, score }
}

/**
 * Find the best matching block for a quote across all blocks.
 */
export function findBestBlock(quote, blocks, threshold = 80) {
  let bestBlock = null
  let bestScore = 0

  for (const block of blocks) {
    const score = partialRatio(quote, block.text)
    if (score > bestScore) {
      bestScore = score
      bestBlock = block
    }
  }

  return bestScore >= threshold ? { block: bestBlock, score: bestScore } : null
}
