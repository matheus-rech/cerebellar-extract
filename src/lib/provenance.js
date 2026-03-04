/**
 * Provenance Engine
 *
 * Cross-references LLM extraction output with PDF block coordinates
 * to produce a full audit trail: field -> value -> page -> rect -> quote.
 */

import { verifyQuote, findBestBlock } from './fuzzyMatch.js'

/**
 * @typedef {Object} ProvenanceRecord
 * @property {string} key - Field key
 * @property {string} label - Human-readable label
 * @property {string} category - Field category
 * @property {*} value - Extracted value
 * @property {string} sourceBlock - Block ID (e.g., "B12")
 * @property {string} sourceQuote - Supporting quote
 * @property {number} confidence - LLM confidence (0-1)
 * @property {number} page - 1-indexed page number
 * @property {number[]} rect - [x0, y0, x1, y1] in PDF points
 * @property {number[]} viewport - [pageWidth, pageHeight]
 * @property {boolean} verified - Whether quote was verified in block
 * @property {number} verificationScore - Fuzzy match score (0-100)
 */

/**
 * Cross-reference LLM extraction results with PDF blocks.
 *
 * @param {Object} extraction - Raw LLM output {field_key: {value, source_block, source_quote, confidence}}
 * @param {Object[]} blocks - PDF blocks from pdfEngine.extractPDFBlocks()
 * @param {Object} schema - {field_key: description} or array of SchemaField
 * @returns {ProvenanceRecord[]}
 */
export function crossReference(extraction, blocks, schema) {
  const blockMap = {}
  for (const b of blocks) {
    blockMap[b.blockId] = b
  }

  const results = []

  for (const [key, data] of Object.entries(extraction)) {
    if (!data || data.value === null || data.value === undefined) continue

    // Get schema info
    let label = key
    let category = 'other'
    if (Array.isArray(schema)) {
      const field = schema.find(f => f.key === key)
      if (field) {
        label = field.label || key
        category = field.category || 'other'
      }
    } else if (schema[key]) {
      label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    }

    // Resolve block reference
    const blockRef = (data.source_block || '').replace(/[\[\]]/g, '')
    let block = blockMap[blockRef]

    // Verify quote
    let verified = false
    let verificationScore = 0

    if (block && data.source_quote) {
      const result = verifyQuote(data.source_quote, block.text)
      verified = result.verified
      verificationScore = result.score
    }

    // If verification failed, try to find the correct block
    if (!verified && data.source_quote) {
      const match = findBestBlock(data.source_quote, blocks)
      if (match) {
        block = match.block
        verified = true
        verificationScore = match.score
      }
    }

    results.push({
      key,
      label,
      category,
      value: data.value,
      sourceBlock: block?.blockId || blockRef,
      sourceQuote: data.source_quote || '',
      confidence: data.confidence || 0,
      page: block?.page || 0,
      rect: block?.rect || [0, 0, 0, 0],
      viewport: block?.viewport || [612, 792],
      verified,
      verificationScore,
    })
  }

  // Sort by page, then by Y coordinate
  results.sort((a, b) => a.page - b.page || a.rect[1] - b.rect[1])

  return results
}

/**
 * Group provenance records by category.
 */
export function groupByCategory(records) {
  const groups = {}
  for (const r of records) {
    if (!groups[r.category]) groups[r.category] = []
    groups[r.category].push(r)
  }
  return groups
}

/**
 * Export provenance data as a downloadable JSON file.
 */
export function exportProvenance(records, metadata = {}) {
  const payload = {
    version: '1.0',
    exported: new Date().toISOString(),
    ...metadata,
    extractions: records,
    summary: {
      total_fields: records.length,
      verified: records.filter(r => r.verified).length,
      unverified: records.filter(r => !r.verified).length,
      avg_confidence: records.length > 0
        ? (records.reduce((s, r) => s + r.confidence, 0) / records.length).toFixed(3)
        : 0,
    },
  }

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `extraction_${Date.now()}.json`
  a.click()
  URL.revokeObjectURL(url)
}
