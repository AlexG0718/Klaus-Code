#!/usr/bin/env bash
# ============================================================
# AI Agent Setup Script
# ============================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info() { echo -e "${BLUE}ℹ ${NC}$1"; }
success() { echo -e "${GREEN}✓ ${NC}$1"; }
warn() { echo -e "${YELLOW}⚠ ${NC}$1"; }
error() { echo -e "${RED}✗ ${NC}$1"; exit 1; }

echo ""
echo -e "${BLUE}╔═══════════════════════════════════╗${NC}"
echo -e "${BLUE}║       AI Dev Agent Setup          ║${NC}"
echo -e "${BLUE}╚═══════════════════════════════════╝${NC}"
echo ""

# Check Node.js
if ! command -v node &>/dev/null; then
  error "Node.js is required. Install from https://nodejs.org"
fi
NODE_VERSION=$(node -v | cut -d. -f1 | tr -d 'v')
if [ "$NODE_VERSION" -lt 18 ]; then
  error "Node.js 18+ required. Found: $(node -v)"
fi
success "Node.js $(node -v) ✓"

# Check npm
if ! command -v npm &>/dev/null; then
  error "npm is required"
fi
success "npm $(npm -v) ✓"

# Check Git
if ! command -v git &>/dev/null; then
  warn "Git not found - git checkpointing will be unavailable"
else
  success "Git $(git --version | awk '{print $3}') ✓"
fi

# Create config directories
AGENT_DIR="$HOME/.klaus-code"
mkdir -p "$AGENT_DIR/logs"
success "Created ~/.klaus-code directory"

# Setup .env
if [ ! -f .env ]; then
  cp .env.example .env
  warn ".env file created from template. Please fill in your ANTHROPIC_API_KEY"
else
  info ".env already exists, skipping"
fi

# Install dependencies
info "Installing dependencies..."
npm install
success "Dependencies installed"

# Build agent
info "Building agent..."
npm run build -w packages/agent
success "Agent built"

# Run tests
info "Running tests..."
if ANTHROPIC_API_KEY=test npm run test -w packages/agent 2>/dev/null; then
  success "All tests passed"
else
  warn "Some tests failed - check logs above"
fi

echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  Setup complete! Next steps:                      ║${NC}"
echo -e "${GREEN}║                                                   ║${NC}"
echo -e "${GREEN}║  1. Edit .env and add your ANTHROPIC_API_KEY      ║${NC}"
echo -e "${GREEN}║  2. Start the agent server:                       ║${NC}"
echo -e "${GREEN}║     npm run dev                                   ║${NC}"
echo -e "${GREEN}║  3. Open http://localhost:5173 in your browser    ║${NC}"
echo -e "${GREEN}║                                                   ║${NC}"
echo -e "${GREEN}║  Or use CLI mode:                                 ║${NC}"
echo -e "${GREEN}║     npm run dev -w packages/agent -- prompt       ║${NC}"
echo -e "${GREEN}║       --workspace /path/to/project                ║${NC}"
echo -e "${GREEN}║       "Build a React login form"                  ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════╝${NC}"
echo ""
