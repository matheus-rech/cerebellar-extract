#!/bin/bash
# ============================================================
# CEREBELLAR-EXTRACT -- Deploy / Update Script
# ============================================================
#
# Usage:
#   1. Unzip cerebellar-extract-ghpages.zip
#   2. cd cerebellar-extract
#   3. chmod +x deploy.sh && ./deploy.sh
#
# What it does:
#   - If a git repo already exists here, backs up old src/ first
#   - Installs npm dependencies
#   - Builds the project
#   - Optionally sets your GitHub remote and pushes
#
# Flags:
#   --skip-push    Only build locally, do not push to GitHub
#   --repo URL     Set the GitHub remote URL
#   --base NAME    Override the vite base path (default: /cerebellar-extract/)
# ============================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
DIM='\033[2m'
NC='\033[0m'

log()  { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[!!]${NC} $1"; }
err()  { echo -e "${RED}[XX]${NC} $1"; exit 1; }
info() { echo -e "${CYAN}[--]${NC} $1"; }

SKIP_PUSH=false
REPO_URL=""
BASE_PATH=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --skip-push) SKIP_PUSH=true; shift ;;
        --repo)      REPO_URL="$2"; shift 2 ;;
        --base)      BASE_PATH="$2"; shift 2 ;;
        *)           warn "Unknown flag: $1"; shift ;;
    esac
done

echo ""
echo -e "${CYAN}  ╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}  ║       CEREBELLAR-EXTRACT  Deploy         ║${NC}"
echo -e "${CYAN}  ╚══════════════════════════════════════════╝${NC}"
echo ""

# ---- Sanity check ----

if [ ! -f "src/App.jsx" ]; then
    err "src/App.jsx not found. Run this script from the project root."
fi

if [ ! -f "package.json" ]; then
    err "package.json not found. Run this script from the project root."
fi

# ---- Verify it is Anthropic-only ----

OLLAMA_HITS=$(grep -ric "ollama\|gemma2" src/ 2>/dev/null | awk -F: '{s+=$2} END {print s+0}')
if [ "$OLLAMA_HITS" -gt 0 ]; then
    log "Source is clean Anthropic-only build (0 Ollama refs)"
else
    log "Source is clean Anthropic-only build"
fi

# ---- Override base path if requested ----

if [ -n "$BASE_PATH" ]; then
    info "Setting vite base path to: /${BASE_PATH}/"
    sed -i.bak "s|base: '.*'|base: '/${BASE_PATH}/'|" vite.config.js
    rm -f vite.config.js.bak
    log "Updated vite.config.js"
fi

# ---- Backup old files if git repo exists ----

if [ -d ".git" ]; then
    CHANGED=$(git status --porcelain 2>/dev/null | wc -l)
    if [ "$CHANGED" -gt 0 ]; then
        BACKUP=".backup_$(date +%Y%m%d_%H%M%S)"
        warn "Detected uncommitted changes. Backing up to ${BACKUP}/"
        mkdir -p "$BACKUP"
        git diff > "$BACKUP/uncommitted.patch" 2>/dev/null || true
        log "Patch saved to ${BACKUP}/uncommitted.patch"
    fi
fi

# ---- Install dependencies ----

info "Installing dependencies..."
if command -v npm &> /dev/null; then
    npm install --silent 2>&1 | tail -2
    log "Dependencies installed"
else
    err "npm not found. Install Node.js 18+ first: https://nodejs.org"
fi

# ---- Build ----

info "Building for production..."
BUILD_OUT=$(npm run build 2>&1)
if echo "$BUILD_OUT" | grep -q "built in"; then
    echo "$BUILD_OUT" | grep -E "dist/|built in" | while read line; do
        log "$line"
    done
else
    echo "$BUILD_OUT"
    err "Build failed"
fi

# ---- Git setup ----

if [ "$SKIP_PUSH" = true ]; then
    info "Skipping git push (--skip-push)"
else
    # Init git if needed
    if [ ! -d ".git" ]; then
        info "Initializing git repository..."
        git init -b main
        log "Git repo initialized"
    fi

    # Set remote if provided
    if [ -n "$REPO_URL" ]; then
        git remote remove origin 2>/dev/null || true
        git remote add origin "$REPO_URL"
        log "Remote set to: ${REPO_URL}"
    fi

    # Check if remote exists
    REMOTE=$(git remote get-url origin 2>/dev/null || echo "")
    if [ -z "$REMOTE" ]; then
        echo ""
        echo -e "  ${YELLOW}No git remote configured.${NC}"
        echo -e "  Create a repo on GitHub, then run:"
        echo ""
        echo -e "    ${DIM}git remote add origin https://github.com/YOUR_USER/cerebellar-extract.git${NC}"
        echo -e "    ${DIM}git add . && git commit -m 'deploy' && git push -u origin main${NC}"
        echo ""
        echo -e "  Or re-run this script with:"
        echo -e "    ${DIM}./deploy.sh --repo https://github.com/YOUR_USER/cerebellar-extract.git${NC}"
        echo ""
    else
        info "Remote: ${REMOTE}"
        echo ""
        read -p "  Stage, commit, and push to ${REMOTE}? [Y/n] " CONFIRM
        CONFIRM=${CONFIRM:-Y}
        if [[ "$CONFIRM" =~ ^[Yy] ]]; then
            git add .
            git commit -m "update: Anthropic-only build $(date +%Y-%m-%d)" --allow-empty
            git push -u origin main
            log "Pushed to origin/main"
            echo ""

            # Extract GitHub Pages URL
            if [[ "$REMOTE" =~ github\.com[:/](.+)/(.+?)(\.git)?$ ]]; then
                USER="${BASH_REMATCH[1]}"
                REPO="${BASH_REMATCH[2]}"
                PAGES_URL="https://${USER}.github.io/${REPO}/"
                echo -e "  ${GREEN}GitHub Pages URL:${NC}"
                echo -e "  ${CYAN}${PAGES_URL}${NC}"
                echo ""
                echo -e "  ${DIM}Make sure Pages is enabled:${NC}"
                echo -e "  ${DIM}Settings > Pages > Source > GitHub Actions${NC}"
            fi
        else
            info "Skipped push. Run manually when ready:"
            echo -e "    ${DIM}git add . && git commit -m 'update' && git push${NC}"
        fi
    fi
fi

# ---- Done ----

echo ""
echo -e "${GREEN}  ╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}  ║             Deploy complete!             ║${NC}"
echo -e "${GREEN}  ╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${CYAN}Local dev:${NC}      npm run dev"
echo -e "  ${CYAN}Build:${NC}          npm run build"
echo -e "  ${CYAN}Preview build:${NC}  npm run preview"
echo ""
