import { useState, useRef, useCallback, useEffect } from 'react'
import { extractPDFBlocks, renderPage } from './lib/pdfEngine.js'
import { callLLM, buildExtractionPrompt, buildSchemaPrompt, buildVariableScanPrompt, apiKeyStore } from './lib/llmClient.js'
import { crossReference, groupByCategory, exportProvenance } from './lib/provenance.js'

// ───────────── Constants ─────────────

const VIEWS = { HOME: 'home', SCHEMA: 'schema', EXTRACT: 'extract', RESULTS: 'results' }

const CATEGORIES = {
  study_design:      { color: '#4da3e8', label: 'Study Design' },
  population:        { color: '#4dd868', label: 'Population' },
  intervention:      { color: '#d84dd8', label: 'Intervention' },
  comparison:        { color: '#e88a4d', label: 'Comparison' },
  primary_outcome:   { color: '#d8c84d', label: 'Primary Outcome' },
  secondary_outcome: { color: '#c8a84d', label: 'Secondary Outcome' },
  complications:     { color: '#d84d4d', label: 'Complications' },
  predictors:        { color: '#4dd8d8', label: 'Predictors' },
  follow_up:         { color: '#8a8ad8', label: 'Follow-up' },
  methodology:       { color: '#7a9a7a', label: 'Methodology' },
  other:             { color: '#5a6578', label: 'Other' },
}

const PRIORITY_COLORS = {
  required:    '#d84d4d',
  recommended: '#d8c84d',
  optional:    '#5a6578',
}

const DOMAIN_PRESETS = {
  'Cerebellar Stroke / SDC': {
    population: 'Adults (>=18y) with space-occupying cerebellar infarction confirmed by CT or MRI',
    intervention: 'Suboccipital decompressive craniectomy (SDC) with or without duraplasty',
    comparison: 'Conservative management, EVD alone, or no surgery',
    outcomes_primary: 'In-hospital mortality, functional outcome (mRS at 6 months)',
    outcomes_secondary: 'Complications (hydrocephalus, CSF leak, infection), GCS improvement, ICU LOS',
    time_frame: 'Index admission through 6-12 month follow-up',
    study_type: 'Retrospective cohort, prospective cohort, case series (>=5 patients)',
    domain: 'neurosurgery',
  },
  'Malignant MCA / DHC': {
    population: 'Adults with malignant middle cerebral artery infarction',
    intervention: 'Decompressive hemicraniectomy (DHC)',
    comparison: 'Best medical therapy without surgery',
    outcomes_primary: 'Mortality at 12 months, mRS at 12 months',
    outcomes_secondary: 'Quality of life, caregiver burden, surgical complications',
    time_frame: 'Up to 12 months post-stroke',
    study_type: 'RCT, prospective cohort, retrospective cohort',
    domain: 'neurosurgery',
  },
  'Custom': {
    population: '', intervention: '', comparison: '',
    outcomes_primary: '', outcomes_secondary: '',
    time_frame: '', study_type: '', domain: '',
  },
}

// ───────────── Styles ─────────────

const S = {
  root: {
    fontFamily: "'IBM Plex Mono', monospace",
    background: '#0a0e14', color: '#c5cdd9',
    height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden',
  },
  header: {
    background: '#0f1520', borderBottom: '1px solid #1a2030',
    padding: '8px 20px', display: 'flex', alignItems: 'center',
    justifyContent: 'space-between', flexShrink: 0,
  },
  logo: {
    width: 28, height: 28,
    background: 'linear-gradient(135deg, #4da3e8, #2d6a9f)',
    borderRadius: 5, display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 12, fontWeight: 600, color: '#fff',
  },
  btn: (accent = '#4da3e8') => ({
    background: 'transparent', border: `1px solid ${accent}40`,
    borderRadius: 6, color: accent, padding: '5px 14px',
    fontSize: 11, cursor: 'pointer', fontFamily: 'inherit',
    transition: 'all 0.2s',
  }),
  btnFill: (accent = '#4da3e8') => ({
    background: `linear-gradient(135deg, ${accent}cc, ${accent})`,
    border: 'none', borderRadius: 6, color: '#fff', padding: '6px 16px',
    fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500,
  }),
  panel: {
    background: '#0c1018', borderRight: '1px solid #1a2030',
    overflow: 'auto', padding: 20,
  },
  input: {
    width: '100%', padding: '8px 12px',
    background: '#0f1520', border: '1px solid #1a2535',
    borderRadius: 6, color: '#c5cdd9',
    fontSize: 12, fontFamily: "'IBM Plex Mono', monospace",
    boxSizing: 'border-box',
  },
  label: (color = '#4da3e8') => ({
    fontSize: 10, color, letterSpacing: '1px',
    textTransform: 'uppercase', display: 'block',
    marginBottom: 4, fontWeight: 500,
  }),
  card: (active = false) => ({
    background: '#0f1520',
    border: `1px solid ${active ? '#4da3e8' : '#1a2535'}`,
    borderRadius: 8, padding: '14px 16px',
    transition: 'all 0.25s', cursor: 'pointer',
  }),
}

// ───────────── App ─────────────

export default function App() {
  const [view, setView] = useState(VIEWS.HOME)
  const [schema, setSchema] = useState(null)         // Generated or loaded schema
  const [schemaFields, setSchemaFields] = useState([]) // Editable fields list

  // LLM config
  const [model, setModel] = useState('claude-sonnet-4-5-20250929')
  const [apiKey, setApiKey] = useState(apiKeyStore.get())

  // PDF state
  const [pdfData, setPdfData] = useState(null)        // ArrayBuffer
  const [pdfName, setPdfName] = useState('')
  const [blocks, setBlocks] = useState([])
  const [textForLLM, setTextForLLM] = useState('')

  // Extraction state
  const [extracting, setExtracting] = useState(false)
  const [extractionLog, setExtractionLog] = useState([])
  const [results, setResults] = useState([])           // ProvenanceRecord[]

  // UI state
  const [activeRecord, setActiveRecord] = useState(null)
  const [activeCategoryFilter, setActiveCategoryFilter] = useState('all')
  const [currentPage, setCurrentPage] = useState(1)
  const [pageCount, setPageCount] = useState(0)
  const canvasRef = useRef(null)
  const overlayRef = useRef(null)
  const renderScale = useRef(1.5)

  // ---- Save API key ----
  useEffect(() => { apiKeyStore.set(apiKey) }, [apiKey])

  // ---- PDF Loading ----
  const handlePDFUpload = useCallback(async (file) => {
    const buffer = await file.arrayBuffer()
    setPdfData(buffer)
    setPdfName(file.name)
    log(`Loaded: ${file.name} (${(file.size / 1024).toFixed(0)} KB)`)

    log('Extracting text blocks with coordinates...')
    try {
      const result = await extractPDFBlocks(buffer)
      setBlocks(result.blocks)
      setTextForLLM(result.textForLLM)
      setPageCount(result.pageCount)
      setCurrentPage(1)
      log(`Found ${result.blocks.length} blocks across ${result.pageCount} pages`)
    } catch (e) {
      log(`Error extracting blocks: ${e.message}`, 'error')
    }
  }, [])

  // ---- PDF Rendering ----
  useEffect(() => {
    if (!pdfData || !canvasRef.current) return
    renderPage(pdfData, currentPage, canvasRef.current, renderScale.current)
      .then(({ scale }) => { renderScale.current = scale })
      .catch(e => console.error('Render error:', e))
  }, [pdfData, currentPage])

  // ---- Draw highlight overlay ----
  useEffect(() => {
    if (!overlayRef.current || !canvasRef.current) return
    const ctx = overlayRef.current.getContext('2d')
    overlayRef.current.width = canvasRef.current.width
    overlayRef.current.height = canvasRef.current.height
    ctx.clearRect(0, 0, overlayRef.current.width, overlayRef.current.height)

    if (!activeRecord || activeRecord.page !== currentPage) return

    const scale = renderScale.current
    const [x0, y0, x1, y1] = activeRecord.rect
    const cat = CATEGORIES[activeRecord.category] || CATEGORIES.other
    const color = cat.color

    // Highlight rectangle
    ctx.strokeStyle = color
    ctx.lineWidth = 2
    ctx.setLineDash([4, 3])
    ctx.strokeRect(x0 * scale - 4, y0 * scale - 4, (x1 - x0) * scale + 8, (y1 - y0) * scale + 8)

    // Fill with transparent color
    ctx.fillStyle = color + '18'
    ctx.fillRect(x0 * scale - 4, y0 * scale - 4, (x1 - x0) * scale + 8, (y1 - y0) * scale + 8)

    // Label
    ctx.setLineDash([])
    ctx.fillStyle = color
    ctx.font = `bold ${11 * scale / 1.5}px "IBM Plex Mono"`
    ctx.fillText(activeRecord.label, x0 * scale - 4, y0 * scale - 10)
  }, [activeRecord, currentPage])

  // ---- Navigate to record's page ----
  const navigateToRecord = useCallback((record) => {
    setActiveRecord(record)
    if (record.page > 0 && record.page !== currentPage) {
      setCurrentPage(record.page)
    }
  }, [currentPage])

  // ---- Logging ----
  const log = useCallback((msg, level = 'info') => {
    setExtractionLog(prev => [...prev, { msg, level, time: new Date().toLocaleTimeString() }])
  }, [])

  // ---- Run Extraction ----
  const runExtraction = useCallback(async () => {
    if (!textForLLM || schemaFields.length === 0) return

    setExtracting(true)
    setResults([])
    log('Starting extraction...')

    // Build schema dict from included fields
    const schemaDict = {}
    const includedFields = schemaFields.filter(f => f.included !== false)
    for (const f of includedFields) {
      schemaDict[f.key] = f.description
    }

    const prompt = buildExtractionPrompt(textForLLM, schemaDict)
    log(`Prompt: ${prompt.length} chars, ${includedFields.length} fields`)
    log(`Calling Claude (${model})...`)

    try {
      const extraction = await callLLM(prompt, { model, apiKey })
      log('LLM response received. Cross-referencing provenance...')

      const provenance = crossReference(extraction, blocks, includedFields)
      const verified = provenance.filter(r => r.verified).length
      log(`Done: ${provenance.length} fields extracted, ${verified} verified`)
      setResults(provenance)
      setView(VIEWS.RESULTS)
    } catch (e) {
      log(`Extraction error: ${e.message}`, 'error')
    } finally {
      setExtracting(false)
    }
  }, [textForLLM, schemaFields, blocks, model, apiKey, log])

  // ---- Schema Generation ----
  const generateSchema = useCallback(async (picott) => {
    log('Generating schema from PICOTT...')
    try {
      const prompt = buildSchemaPrompt(picott)
      const fields = await callLLM(prompt, { model, apiKey })
      const fieldArray = Array.isArray(fields) ? fields : (fields.fields || [])
      const withInclude = fieldArray.map(f => ({ ...f, included: true }))
      setSchemaFields(withInclude)
      log(`Schema generated: ${withInclude.length} fields`)
      return withInclude
    } catch (e) {
      log(`Schema generation error: ${e.message}`, 'error')
      return []
    }
  }, [model, apiKey, log])

  // ---- Filtered results ----
  const filteredResults = activeCategoryFilter === 'all'
    ? results
    : results.filter(r => r.category === activeCategoryFilter)

  // ───────────── HOME VIEW ─────────────

  if (view === VIEWS.HOME) {
    return (
      <div style={S.root}>
        <Fonts />
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center', maxWidth: 680 }}>
            <div style={{ ...S.logo, width: 56, height: 56, fontSize: 22, margin: '0 auto 24px', borderRadius: 12 }}>CE</div>
            <h1 style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 30, fontWeight: 300, color: '#e8ecf1', margin: '0 0 8px', letterSpacing: 1 }}>
              CEREBELLAR-EXTRACT
            </h1>
            <p style={{ fontSize: 12, color: '#5a6578', lineHeight: 1.8, marginBottom: 40 }}>
              AI-powered data extraction with coordinate-level provenance tracking.<br/>
              Click a value, see exactly where it came from in the PDF.
            </p>

            <div style={{ display: 'flex', gap: 20, justifyContent: 'center', marginBottom: 40 }}>
              <HomeCard
                accent="#4da3e8" label="Mode A" title="PICOTT-Driven"
                desc="Define your research question. The AI generates a tailored extraction schema."
                onClick={() => setView(VIEWS.SCHEMA)}
              />
              <HomeCard
                accent="#4dd868" label="Mode B" title="Quick Extract"
                desc="Upload a PDF and use a preset or custom schema. Skip the schema generator."
                onClick={() => setView(VIEWS.EXTRACT)}
              />
            </div>

            {/* Settings row */}
            <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
              <select value={model} onChange={e => setModel(e.target.value)}
                style={{ ...S.input, width: 260, fontSize: 11 }}>
                <option value="claude-sonnet-4-5-20250929">Claude Sonnet 4.5</option>
                <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5 (faster, cheaper)</option>
              </select>
              <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)}
                placeholder="sk-ant-..." style={{ ...S.input, width: 280, fontSize: 11 }} />
            </div>
            <p style={{ fontSize: 10, color: '#2a3545', marginTop: 8 }}>
              API key is stored in your browser only. Calls go directly to api.anthropic.com.
            </p>
          </div>
        </div>
      </div>
    )
  }

  // ───────────── SCHEMA VIEW ─────────────

  if (view === VIEWS.SCHEMA) {
    return (
      <div style={S.root}>
        <Fonts />
        <Header
          view={view} setView={setView}
          right={schemaFields.length > 0 && (
            <button style={S.btnFill()} onClick={() => setView(VIEWS.EXTRACT)}>
              Use Schema ({schemaFields.filter(f => f.included !== false).length} fields) &#8594;
            </button>
          )}
        />
        <SchemaView
          schemaFields={schemaFields}
          setSchemaFields={setSchemaFields}
          generateSchema={generateSchema}
          model={model}
        />
      </div>
    )
  }

  // ───────────── EXTRACT VIEW ─────────────

  if (view === VIEWS.EXTRACT) {
    return (
      <div style={S.root}>
        <Fonts />
        <Header
          view={view} setView={setView}
          right={
            <div style={{ display: 'flex', gap: 8 }}>
              {schemaFields.length === 0 && (
                <button style={S.btn()} onClick={() => setView(VIEWS.SCHEMA)}>
                  &#8592; Generate Schema First
                </button>
              )}
              {pdfData && schemaFields.length > 0 && (
                <button style={S.btnFill('#4dd868')} onClick={runExtraction} disabled={extracting}>
                  {extracting ? 'Extracting...' : `Extract (${schemaFields.filter(f=>f.included!==false).length} fields)`}
                </button>
              )}
            </div>
          }
        />
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          {/* Left: Controls */}
          <div style={{ ...S.panel, width: 360, minWidth: 360 }}>
            {/* PDF Upload */}
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
            </div>

            {/* Quick schema if none loaded */}
            {schemaFields.length === 0 && (
              <div style={{ marginBottom: 20 }}>
                <label style={S.label('#d8c84d')}>Quick Schema (paste JSON)</label>
                <textarea rows={6} placeholder='{"total_patients": "Total N", "mortality": "In-hospital mortality %"}'
                  style={{ ...S.input, resize: 'vertical', lineHeight: 1.5 }}
                  onBlur={e => {
                    try {
                      const obj = JSON.parse(e.target.value)
                      const fields = Object.entries(obj).map(([key, desc]) => ({
                        key, label: key.replace(/_/g, ' '), description: desc,
                        category: 'other', expected_type: 'text', priority: 'recommended', included: true,
                      }))
                      setSchemaFields(fields)
                      log(`Loaded ${fields.length} fields from JSON`)
                    } catch {}
                  }}
                />
              </div>
            )}

            {/* Schema summary */}
            {schemaFields.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <label style={S.label('#4dd868')}>
                  Active Schema ({schemaFields.filter(f => f.included !== false).length} fields)
                </label>
                <div style={{ maxHeight: 200, overflow: 'auto' }}>
                  {schemaFields.filter(f => f.included !== false).map(f => (
                    <div key={f.key} style={{
                      fontSize: 10, padding: '3px 0', color: '#7a8a9f',
                      borderBottom: '1px solid #12161e',
                      display: 'flex', justifyContent: 'space-between',
                    }}>
                      <span>{f.key}</span>
                      <span style={{ color: PRIORITY_COLORS[f.priority] || '#5a6578', fontSize: 9 }}>
                        {f.priority}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Blocks info */}
            {blocks.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <label style={S.label('#8a8ad8')}>PDF Blocks</label>
                <div style={{ fontSize: 11, color: '#5a6578' }}>
                  {blocks.length} blocks, {pageCount} pages
                </div>
              </div>
            )}

            {/* Log */}
            <div>
              <label style={S.label('#5a6578')}>Log</label>
              <div style={{
                background: '#080b10', borderRadius: 6, padding: 10,
                maxHeight: 300, overflow: 'auto', fontSize: 10, lineHeight: 1.8,
              }}>
                {extractionLog.map((l, i) => (
                  <div key={i} style={{ color: l.level === 'error' ? '#d84d4d' : '#5a6578' }}>
                    <span style={{ color: '#2a3545' }}>{l.time}</span> {l.msg}
                  </div>
                ))}
                {extractionLog.length === 0 && (
                  <div style={{ color: '#2a3545' }}>Waiting for input...</div>
                )}
              </div>
            </div>
          </div>

          {/* Right: PDF Preview */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {pdfData ? (
              <>
                <div style={{
                  padding: '6px 16px', borderBottom: '1px solid #1a2030',
                  display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0,
                }}>
                  <button disabled={currentPage <= 1} onClick={() => setCurrentPage(p => p - 1)}
                    style={S.btn()}>&#8592;</button>
                  <span style={{ fontSize: 11, color: '#7a8a9f' }}>
                    Page {currentPage} / {pageCount}
                  </span>
                  <button disabled={currentPage >= pageCount} onClick={() => setCurrentPage(p => p + 1)}
                    style={S.btn()}>&#8594;</button>
                </div>
                <div style={{ flex: 1, overflow: 'auto', display: 'flex', justifyContent: 'center', padding: 16 }}>
                  <div style={{ position: 'relative' }}>
                    <canvas ref={canvasRef} style={{ borderRadius: 4, boxShadow: '0 4px 24px #00000060' }} />
                    <canvas ref={overlayRef} style={{
                      position: 'absolute', top: 0, left: 0, pointerEvents: 'none',
                    }} />
                  </div>
                </div>
              </>
            ) : (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <p style={{ fontSize: 13, color: '#2a3545' }}>Upload a PDF to preview</p>
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  // ───────────── RESULTS VIEW ─────────────

  if (view === VIEWS.RESULTS) {
    const grouped = groupByCategory(results)
    const verifiedCount = results.filter(r => r.verified).length

    return (
      <div style={S.root}>
        <Fonts />
        <Header
          view={view} setView={setView}
          right={
            <div style={{ display: 'flex', gap: 8 }}>
              <button style={S.btn()} onClick={() => exportProvenance(results, { pdf: pdfName })}>
                Export JSON
              </button>
              <button style={S.btn('#d8c84d')} onClick={() => setView(VIEWS.EXTRACT)}>
                &#8592; Back to Extract
              </button>
            </div>
          }
        />
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          {/* Left: Results list */}
          <div style={{ ...S.panel, width: 440, minWidth: 440 }}>
            {/* Summary bar */}
            <div style={{
              display: 'flex', gap: 16, marginBottom: 16, padding: '10px 0',
              borderBottom: '1px solid #1a2030',
            }}>
              <Stat label="Extracted" value={results.length} />
              <Stat label="Verified" value={verifiedCount} color="#4dd868" />
              <Stat label="Unverified" value={results.length - verifiedCount} color="#d84d4d" />
              <Stat label="Avg Conf."
                value={results.length > 0 ? (results.reduce((s, r) => s + r.confidence, 0) / results.length * 100).toFixed(0) + '%' : '--'}
                color="#d8c84d" />
            </div>

            {/* Category filters */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 12 }}>
              <FilterChip label={`All (${results.length})`} active={activeCategoryFilter === 'all'}
                color="#4da3e8" onClick={() => setActiveCategoryFilter('all')} />
              {Object.entries(CATEGORIES).map(([key, cat]) => {
                const count = results.filter(r => r.category === key).length
                if (count === 0) return null
                return (
                  <FilterChip key={key} label={`${cat.label} (${count})`}
                    active={activeCategoryFilter === key}
                    color={cat.color}
                    onClick={() => setActiveCategoryFilter(key)} />
                )
              })}
            </div>

            {/* Results cards */}
            <div style={{ display: 'grid', gap: 6 }}>
              {filteredResults.map((r, i) => {
                const cat = CATEGORIES[r.category] || CATEGORIES.other
                const isActive = activeRecord?.key === r.key
                return (
                  <div key={r.key + i} onClick={() => navigateToRecord(r)}
                    style={{
                      background: isActive ? '#111825' : '#0f1520',
                      border: `1px solid ${isActive ? cat.color + '60' : '#1a2535'}`,
                      borderLeft: `3px solid ${cat.color}`,
                      borderRadius: 6, padding: '10px 14px', cursor: 'pointer',
                      transition: 'all 0.2s',
                    }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                      <span style={{ fontSize: 12, fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 500, color: '#e8ecf1' }}>
                        {r.label}
                      </span>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <span style={{
                          fontSize: 9, padding: '1px 6px', borderRadius: 3,
                          background: r.verified ? '#1a2b1a' : '#2b1a1a',
                          color: r.verified ? '#4dd868' : '#d84d4d',
                        }}>
                          {r.verified ? `Verified ${r.verificationScore}%` : 'Unverified'}
                        </span>
                        <span style={{
                          fontSize: 9, padding: '1px 6px', borderRadius: 3,
                          background: '#1a1e24', color: '#7a8a9f',
                        }}>
                          p.{r.page}
                        </span>
                      </div>
                    </div>
                    <div style={{ fontSize: 13, color: '#e8ecf1', fontWeight: 500, marginBottom: 4 }}>
                      {String(r.value)}
                    </div>
                    {r.sourceQuote && (
                      <div style={{ fontSize: 10, color: '#5a6578', fontStyle: 'italic' }}>
                        "{r.sourceQuote.slice(0, 80)}"
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {/* Right: PDF viewer */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{
              padding: '6px 16px', borderBottom: '1px solid #1a2030',
              display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0,
            }}>
              <button disabled={currentPage <= 1} onClick={() => setCurrentPage(p => p - 1)}
                style={S.btn()}>&#8592;</button>
              <span style={{ fontSize: 11, color: '#7a8a9f' }}>
                Page {currentPage} / {pageCount}
              </span>
              <button disabled={currentPage >= pageCount} onClick={() => setCurrentPage(p => p + 1)}
                style={S.btn()}>&#8594;</button>
              {activeRecord && (
                <span style={{ fontSize: 10, color: CATEGORIES[activeRecord.category]?.color || '#5a6578', marginLeft: 'auto' }}>
                  Highlighting: {activeRecord.label} [{activeRecord.sourceBlock}]
                </span>
              )}
            </div>
            <div style={{ flex: 1, overflow: 'auto', display: 'flex', justifyContent: 'center', padding: 16 }}>
              <div style={{ position: 'relative' }}>
                <canvas ref={canvasRef} style={{ borderRadius: 4, boxShadow: '0 4px 24px #00000060' }} />
                <canvas ref={overlayRef} style={{
                  position: 'absolute', top: 0, left: 0, pointerEvents: 'none',
                }} />
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return null
}

// ───────────── Sub-Components ─────────────

function Fonts() {
  return <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600&family=IBM+Plex+Sans:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
}

function Header({ view, setView, right }) {
  return (
    <div style={S.header}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button onClick={() => setView(VIEWS.HOME)}
          style={{ background: 'none', border: 'none', color: '#5a6578', cursor: 'pointer', fontSize: 14, fontFamily: 'inherit', padding: '2px 6px' }}>
          &#8592;
        </button>
        <div style={S.logo}>CE</div>
        <span style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600, fontSize: 13, color: '#e8ecf1' }}>
          CEREBELLAR-EXTRACT
        </span>
        <span style={{ fontSize: 10, color: '#3a4558', letterSpacing: 1 }}>
          {view.toUpperCase()}
        </span>
      </div>
      <div>{right}</div>
    </div>
  )
}

function HomeCard({ accent, label, title, desc, onClick }) {
  return (
    <div onClick={onClick} style={{
      width: 280, padding: '28px 24px', background: '#0f1520',
      border: '1px solid #1a2535', borderRadius: 12, cursor: 'pointer',
      transition: 'all 0.3s', position: 'relative', overflow: 'hidden', textAlign: 'left',
    }}
    onMouseEnter={e => { e.currentTarget.style.borderColor = accent; e.currentTarget.style.transform = 'translateY(-2px)' }}
    onMouseLeave={e => { e.currentTarget.style.borderColor = '#1a2535'; e.currentTarget.style.transform = 'translateY(0)' }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: accent }} />
      <div style={{ fontSize: 10, color: accent, letterSpacing: 2, textTransform: 'uppercase', marginBottom: 10, fontWeight: 500 }}>
        {label}
      </div>
      <h3 style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 18, fontWeight: 500, color: '#e8ecf1', margin: '0 0 8px' }}>
        {title}
      </h3>
      <p style={{ fontSize: 11, color: '#7a8a9f', lineHeight: 1.7, margin: 0 }}>{desc}</p>
    </div>
  )
}

function Stat({ label, value, color = '#e8ecf1' }) {
  return (
    <div>
      <div style={{ fontSize: 16, fontWeight: 600, color, fontFamily: "'IBM Plex Sans', sans-serif" }}>{value}</div>
      <div style={{ fontSize: 9, color: '#3a4558', textTransform: 'uppercase', letterSpacing: 1 }}>{label}</div>
    </div>
  )
}

function FilterChip({ label, active, color, onClick }) {
  return (
    <button onClick={onClick} style={{
      background: active ? '#1a2535' : 'transparent',
      border: `1px solid ${active ? color + '60' : '#1a2535'}`,
      borderRadius: 4, padding: '3px 10px', cursor: 'pointer',
      color: active ? color : '#3a4558',
      fontSize: 10, fontFamily: "'IBM Plex Mono', monospace",
      transition: 'all 0.2s',
    }}>
      {label}
    </button>
  )
}

// ───────────── Schema View (PICOTT) ─────────────

function SchemaView({ schemaFields, setSchemaFields, generateSchema }) {
  const [picott, setPicott] = useState(DOMAIN_PRESETS['Custom'])
  const [selectedPreset, setSelectedPreset] = useState('')
  const [generating, setGenerating] = useState(false)
  const [activeCategory, setActiveCategory] = useState('all')

  const handlePreset = (name) => {
    setSelectedPreset(name)
    if (DOMAIN_PRESETS[name]) setPicott({ ...DOMAIN_PRESETS[name] })
  }

  const handleGenerate = async () => {
    setGenerating(true)
    await generateSchema(picott)
    setGenerating(false)
  }

  const toggleField = (idx) => {
    setSchemaFields(prev => prev.map((f, i) => i === idx ? { ...f, included: f.included === false ? true : false } : f))
  }

  const setPriority = (idx, p) => {
    setSchemaFields(prev => prev.map((f, i) => i === idx ? { ...f, priority: p } : f))
  }

  const filtered = activeCategory === 'all'
    ? schemaFields
    : schemaFields.filter(f => f.category === activeCategory)

  return (
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      {/* Left: PICOTT form */}
      <div style={{ ...S.panel, width: 380, minWidth: 380 }}>
        <div style={{ marginBottom: 16 }}>
          <label style={S.label()}>Domain Preset</label>
          <select value={selectedPreset} onChange={e => handlePreset(e.target.value)}
            style={{ ...S.input }}>
            <option value="">Select...</option>
            {Object.keys(DOMAIN_PRESETS).map(k => <option key={k} value={k}>{k}</option>)}
          </select>
        </div>

        {[
          { key: 'population', label: 'P - Population' },
          { key: 'intervention', label: 'I - Intervention' },
          { key: 'comparison', label: 'C - Comparison' },
          { key: 'outcomes_primary', label: 'O - Primary Outcomes' },
          { key: 'outcomes_secondary', label: 'O - Secondary Outcomes' },
          { key: 'time_frame', label: 'T - Time Frame' },
          { key: 'study_type', label: 'T - Study Type' },
          { key: 'domain', label: 'Domain' },
        ].map(({ key, label }) => (
          <div key={key} style={{ marginBottom: 12 }}>
            <label style={S.label('#4da3e8')}>{label}</label>
            <textarea value={picott[key] || ''} onChange={e => setPicott(p => ({ ...p, [key]: e.target.value }))}
              rows={2} style={{ ...S.input, resize: 'vertical', lineHeight: 1.5 }} />
          </div>
        ))}

        <button onClick={handleGenerate} disabled={generating || !picott.population}
          style={{
            ...S.btnFill(), width: '100%', padding: 12, marginTop: 8,
            opacity: generating || !picott.population ? 0.5 : 1,
          }}>
          {generating ? 'Generating...' : 'Generate Schema'}
        </button>
      </div>

      {/* Right: Schema fields */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {schemaFields.length > 0 && (
          <div style={{ padding: '8px 16px', borderBottom: '1px solid #1a2030', display: 'flex', gap: 4, flexWrap: 'wrap', flexShrink: 0 }}>
            <FilterChip label={`All (${schemaFields.length})`} active={activeCategory === 'all'}
              color="#4da3e8" onClick={() => setActiveCategory('all')} />
            {Object.entries(CATEGORIES).map(([key, cat]) => {
              const count = schemaFields.filter(f => f.category === key).length
              return count > 0 ? (
                <FilterChip key={key} label={`${cat.label} (${count})`}
                  active={activeCategory === key} color={cat.color}
                  onClick={() => setActiveCategory(key)} />
              ) : null
            })}
          </div>
        )}

        <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
          {schemaFields.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 60 }}>
              <div style={{ fontSize: 40, opacity: 0.15, marginBottom: 12 }}>&#9881;</div>
              <p style={{ fontSize: 13, color: '#3a4558' }}>Fill PICOTT and click Generate</p>
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 6 }}>
              {filtered.map((f, idx) => {
                const globalIdx = schemaFields.indexOf(f)
                const cat = CATEGORIES[f.category] || CATEGORIES.other
                const off = f.included === false
                return (
                  <div key={f.key} style={{
                    background: off ? '#0a0e14' : '#0f1520',
                    border: `1px solid ${off ? '#12161e' : '#1a2535'}`,
                    borderLeft: `3px solid ${off ? '#12161e' : cat.color}`,
                    borderRadius: 6, padding: '10px 14px',
                    opacity: off ? 0.4 : 1, transition: 'all 0.2s',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div onClick={() => toggleField(globalIdx)} style={{
                        width: 16, height: 16, flexShrink: 0,
                        border: `2px solid ${off ? '#2a3545' : cat.color}`,
                        borderRadius: 3, cursor: 'pointer',
                        background: off ? 'transparent' : cat.color + '20',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 10, color: cat.color,
                      }}>
                        {!off && '\u2713'}
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                          <span style={{ fontSize: 12, fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 500, color: '#e8ecf1' }}>
                            {f.label}
                          </span>
                          <span style={{ fontSize: 9, color: cat.color }}>{cat.label}</span>
                        </div>
                        <div style={{ fontSize: 10, color: '#7a8a9f', marginBottom: 4 }}>{f.description}</div>
                        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                          <span style={{ fontSize: 9, color: '#3a4558' }}>{f.key}</span>
                          <span style={{ fontSize: 9, color: '#2a3545' }}>|</span>
                          <span style={{ fontSize: 9, color: '#3a4558' }}>{f.expected_type}</span>
                          {['required', 'recommended', 'optional'].map(p => (
                            <button key={p} onClick={() => setPriority(globalIdx, p)} style={{
                              fontSize: 9, padding: '1px 6px', borderRadius: 3, fontFamily: 'inherit',
                              background: f.priority === p ? (PRIORITY_COLORS[p] + '20') : 'transparent',
                              border: `1px solid ${f.priority === p ? PRIORITY_COLORS[p] + '50' : 'transparent'}`,
                              color: f.priority === p ? PRIORITY_COLORS[p] : '#2a3545',
                              cursor: 'pointer', marginLeft: p === 'required' ? 8 : 0,
                            }}>{p}</button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {schemaFields.length > 0 && (
          <div style={{
            padding: '8px 16px', borderTop: '1px solid #1a2030',
            fontSize: 10, color: '#3a4558', flexShrink: 0,
          }}>
            {schemaFields.filter(f => f.included !== false).length} fields active
            ({schemaFields.filter(f => f.included !== false && f.priority === 'required').length} required,{' '}
            {schemaFields.filter(f => f.included !== false && f.priority === 'recommended').length} recommended,{' '}
            {schemaFields.filter(f => f.included !== false && f.priority === 'optional').length} optional)
          </div>
        )}
      </div>
    </div>
  )
}
