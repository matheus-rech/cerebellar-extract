/**
 * Browser-side Anthropic API client.
 *
 * Calls api.anthropic.com directly via CORS.
 * API key stored in localStorage -- never leaves the browser.
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929'

/**
 * Call Claude and return parsed JSON.
 *
 * @param {string} prompt - The extraction/generation prompt
 * @param {Object} config - {model?: string, apiKey: string, maxTokens?: number}
 * @returns {Promise<Object>} Parsed JSON response
 */
export async function callLLM(prompt, config) {
  const { model = DEFAULT_MODEL, apiKey, maxTokens = 4096 } = config

  if (!apiKey) throw new Error('Anthropic API key is required. Add it in the settings.')

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error?.message || `Anthropic API error: ${res.status}`)
  }

  const data = await res.json()
  const text = data.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')

  return parseJSONResponse(text)
}

function parseJSONResponse(text) {
  let cleaned = text.trim()
  cleaned = cleaned.replace(/^```json\s*/i, '').replace(/\s*```$/i, '')
  cleaned = cleaned.replace(/^```\s*/i, '').replace(/\s*```$/i, '')

  try {
    return JSON.parse(cleaned)
  } catch (e) {
    const match = cleaned.match(/\{[\s\S]*\}|\[[\s\S]*\]/)
    if (match) return JSON.parse(match[0])
    throw new Error(`Failed to parse JSON: ${e.message}\nResponse: ${cleaned.slice(0, 200)}`)
  }
}

/**
 * Build the extraction prompt for a given schema and PDF text.
 */
export function buildExtractionPrompt(textWithIds, schema, context = '') {
  const fieldLines = Object.entries(schema)
    .map(([key, desc]) => `  - "${key}": ${desc}`)
    .join('\n')

  return `You are a medical data extraction assistant.${context ? ' ' + context : ''}

Each paragraph below is prefixed with a block identifier like [B0], [B1], etc.

FOR EACH FIELD:
1. Extract the value
2. Record the source_block ID (the [BX] marker)
3. Copy the exact supporting quote (under 80 characters)
4. Assign confidence (0.0-1.0)

FIELDS TO EXTRACT:
${fieldLines}

OUTPUT FORMAT (JSON only, no markdown):
{
  "field_key": {"value": "...", "source_block": "BX", "source_quote": "...", "confidence": 0.95},
  ...
}

Set value to null if not found. Respond ONLY with valid JSON.

TEXT:
${textWithIds}`
}

/**
 * Build a PICOTT-based schema generation prompt.
 */
export function buildSchemaPrompt(picott) {
  return `You are an expert systematic review methodologist. Generate an extraction schema for this PICOTT:

- Population: ${picott.population}
- Intervention: ${picott.intervention}
- Comparison: ${picott.comparison || 'Not specified'}
- Primary Outcomes: ${picott.outcomes_primary}
- Secondary Outcomes: ${picott.outcomes_secondary || 'Not specified'}
- Time Frame: ${picott.time_frame || 'Not specified'}
- Study Type: ${picott.study_type || 'Any'}
- Domain: ${picott.domain || 'clinical'}

Generate a JSON array of 15-25 extraction fields. Each field:
{
  "key": "snake_case_id",
  "label": "Human Name",
  "description": "What to extract (instruction for the extraction LLM)",
  "category": "study_design|population|intervention|primary_outcome|secondary_outcome|complications|predictors|follow_up|methodology",
  "expected_type": "number|percentage|text|date_range|continuous|categorical|binary",
  "priority": "required|recommended|optional",
  "example_values": ["val1", "val2"]
}

Include fields for meta-analysis (effect sizes, CIs). Prioritize by importance. JSON array only.`
}

/**
 * Build a variable scanning prompt for literature-driven schema generation.
 */
export function buildVariableScanPrompt(text) {
  return `Identify ALL reported variables in this clinical paper. For each:
{
  "variable": "snake_case_name",
  "label": "Human Name",
  "category": "study_design|population|intervention|primary_outcome|secondary_outcome|complications|predictors|methodology",
  "value_found": "actual value from the paper",
  "statistical_type": "count|percentage|mean_sd|median_iqr|odds_ratio|proportion|categorical|binary|other"
}

Be exhaustive. Include every reported measurement, demographic, outcome, and statistical result. JSON array only.

TEXT:
${text}`
}

// API key management (browser localStorage)
export const apiKeyStore = {
  get: () => {
    try { return localStorage.getItem('ce_anthropic_key') || '' } catch { return '' }
  },
  set: (key) => {
    try { localStorage.setItem('ce_anthropic_key', key) } catch {}
  },
  clear: () => {
    try { localStorage.removeItem('ce_anthropic_key') } catch {}
  },
}
