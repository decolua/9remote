@echo off
REM ═══════════════════════════════════════════════════════════
REM  9remote Benchmark - Windows 1-click runner
REM  Copy this folder to any Windows machine and double-click
REM ═══════════════════════════════════════════════════════════

setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo ========================================================
echo   9REMOTE BENCHMARK - WINDOWS
echo ========================================================
echo.

REM ─── Check Node.js ───
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found on PATH.
    echo.
    echo Please install Node.js 18+ from:
    echo   https://nodejs.org/en/download
    echo.
    echo Or download portable version:
    echo   https://nodejs.org/dist/latest-v20.x/node-v20.18.0-win-x64.zip
    echo   Extract, then add to PATH or place node.exe next to this .bat
    echo.
    pause
    exit /b 1
)

echo [OK] Node.js detected:
node --version
echo.

REM ─── Install dependencies if missing ───
if not exist "node_modules" (
    echo [INFO] Installing dependencies... (first run only, takes 1-2 min)
    echo.
    call npm install --no-audit --no-fund --loglevel=error
    if errorlevel 1 (
        echo.
        echo [ERROR] npm install failed.
        echo Try running manually: npm install
        pause
        exit /b 1
    )
    echo.
    echo [OK] Dependencies installed.
    echo.
) else (
    echo [OK] Dependencies already installed.
    echo.
)

REM ─── Run benchmark ───
echo ========================================================
echo   Running benchmark...
echo ========================================================
echo.
node screenCapture.win.js

echo.
echo ========================================================
echo   Results saved to: results\win32-x64\latest.md
echo   Images saved to:  output\win32-x64\
echo ========================================================
echo.
pause
