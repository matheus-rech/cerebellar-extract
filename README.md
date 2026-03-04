# CEREBELLAR-EXTRACT

AI-powered data extraction from clinical PDFs with coordinate-level provenance tracking.
Click a value, see exactly where it came from in the source document.

## Features

- **PICOTT-driven schema generation** -- define your review question, get a tailored extraction schema
- **Block-aware extraction** -- PDF text blocks carry spatial coordinates through the entire pipeline
- **Provenance tracking** -- every extracted value links to page, bounding box, and source quote
- **Click-to-navigate** -- click any field to scroll the PDF viewer to the exact source location
- **Fuzzy verification** -- source quotes are verified against block text with fuzzy matching
- **Browser-native** -- no backend needed. PDF.js for parsing, Anthropic API for Claude

## Deploy to GitHub Pages

### Option 1: Automatic (GitHub Actions)

1. Create a repo called `cerebellar-extract` on GitHub
2. Push the code:
```bash
git init && git add . && git commit -m "initial"
git remote add origin https://github.com/YOUR_USERNAME/cerebellar-extract.git
git push -u origin main
```
3. Go to **Settings > Pages > Source** and select **GitHub Actions**
4. Your site will be live at `https://YOUR_USERNAME.github.io/cerebellar-extract/`

> If your repo has a different name, update `base` in `vite.config.js` to match.

### Option 2: Local Development

```bash
npm install
npm run dev
# Open http://localhost:5173
```

## How It Works

The app calls the Anthropic API directly from the browser (via CORS). Your API key is stored in `localStorage` and goes straight to `api.anthropic.com`. No intermediary server.

You can choose between:
- **Claude Sonnet 4.5** -- best accuracy for extraction
- **Claude Haiku 4.5** -- faster and cheaper for iterating

## Architecture

```
PDF File
  |
  v
PDF.js (browser)
  |-- extracts text blocks with [x0, y0, x1, y1] coordinates
  |-- assigns block IDs: [B0], [B1], [B2]...
  v
Claude (Anthropic API)
  |-- receives text prefixed with block markers
  |-- extracts structured data citing source blocks
  |-- returns {value, source_block, source_quote, confidence}
  v
Provenance Engine
  |-- maps source_block back to coordinates via block ID
  |-- fuzzy-verifies source_quote exists in cited block
  |-- if verification fails, searches all blocks for best match
  v
React UI
  |-- renders extracted data with category colors
  |-- click any field to highlight its source in PDF viewer
  |-- export full provenance chain as JSON
```

## Project Structure

```
src/
  App.jsx              -- Main app: Home, Schema, Extract, Results views
  main.jsx             -- React entry point
  lib/
    pdfEngine.js       -- PDF.js wrapper: block extraction, rendering, text search
    llmClient.js       -- Anthropic API client, prompt builders
    provenance.js      -- Cross-reference engine, category grouping, JSON export
    fuzzyMatch.js      -- Lightweight fuzzy string matching (zero dependencies)
```

## Customization

### Add domain presets

Edit `DOMAIN_PRESETS` in `App.jsx` to add presets for your specialty (cardiology, oncology, etc.).

### Change the model

The model selector in the home screen lets you switch between Sonnet and Haiku. You can also type any valid Anthropic model ID.

## License

MIT
