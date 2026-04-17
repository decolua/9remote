#!/bin/bash
# ═══════════════════════════════════════════════════════════
#  9remote Benchmark - macOS/Linux 1-click runner
# ═══════════════════════════════════════════════════════════

cd "$(dirname "$0")"

echo ""
echo "========================================================"
echo "  9REMOTE BENCHMARK - $(uname -s)"
echo "========================================================"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js not found."
    echo "Install from: https://nodejs.org/en/download"
    exit 1
fi

echo "[OK] Node.js: $(node --version)"
echo ""

# Install deps if missing
if [ ! -d "node_modules" ]; then
    echo "[INFO] Installing dependencies..."
    npm install --no-audit --no-fund --loglevel=error
    echo ""
fi

# Run
echo "========================================================"
echo "  Running benchmark..."
echo "========================================================"
echo ""
node screenCapture.mac.js

echo ""
echo "========================================================"
echo "  Results: results/$(node -e 'console.log(process.platform+\"-\"+process.arch)')/latest.md"
echo "========================================================"
