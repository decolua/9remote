# Run all Windows lock-screen probes, tee everything to lockscreen-all.log.
# Each step's stdout/stderr is captured into its own section with a header + timing.
#
#   powershell -ExecutionPolicy Bypass -File runAll.ps1            # Quick mode (~1-2 min)
#   powershell -ExecutionPolicy Bypass -File runAll.ps1 -Full      # + robotjs capture + blind unlock
#   powershell -ExecutionPolicy Bypass -File runAll.ps1 -Filter capture   # run only steps matching name
#
# Password for blindUnlock (Full mode only): pass via env LOCKPW, else prompted securely.
# Logs: lockscreen-all.log (all steps) + per-script logs written by the .mjs probes.

param(
    [switch]$Full,
    [string]$Filter = ""   # substring match on step name; "" = all selected by mode
)

$ErrorActionPreference = "Continue"
$here  = Split-Path -Parent $MyInvocation.MyCommand.Path
$agent = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $here))  # .../agent
$logfile = Join-Path $here "lockscreen-all.log"

# Reset log
"" | Set-Content $logfile

function Write-Section($title) {
    $bar = "=" * 72
    $stamp = Get-Date -Format "o"
    $hdr = "$bar`r`n[$stamp] STEP: $title`r`n$bar"
    Write-Host ""
    Write-Host $hdr -ForegroundColor Cyan
    Add-Content $logfile $hdr
}

function Invoke-Step($name, $scriptBlock) {
    if ($Filter -and ($name -notlike "*$Filter*")) {
        Write-Host "[skip] $name (filtered)" -ForegroundColor DarkGray
        Add-Content $logfile "[skip] $name (filtered)"
        return
    }
    Write-Section $name
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        & $scriptBlock | Tee-Object -FilePath $logfile -Append
    } catch {
        $msg = "STEP ERROR: $($_.Exception.Message)"
        Write-Host $msg -ForegroundColor Red
        Add-Content $logfile $msg
    }
    $sw.Stop()
    $dur = "[done] $name in $([math]::Round($sw.Elapsed.TotalSeconds,1))s"
    Write-Host $dur -ForegroundColor Green
    Add-Content $logfile $dur
}

function Count-Down($seconds, $msg) {
    Write-Host ">>> $msg" -ForegroundColor Yellow
    Add-Content $logfile ">>> $msg"
    for ($i = $seconds; $i -gt 0; $i--) {
        $line = "    lock in $i s ..."
        Write-Host $line -ForegroundColor Yellow
        Add-Content $logfile $line
        Start-Sleep -Seconds 1
    }
}

# --- resolve node + node_modules -----------------------------------------------
$nodeExe = "node"
$hasNs = Test-Path (Join-Path $agent "node_modules\node-screenshots")
$hasRj = Test-Path (Join-Path $agent "node_modules\@hurdlegroup\robotjs")
Write-Host "agent dir : $agent"
Write-Host "node-screenshots installed : $hasNs"
Write-Host "robotjs installed          : $hasRj"
Add-Content $logfile "agent=$agent node-screenshots=$hasNs robotjs=$hasRj mode=$(if($Full){'Full'}else{'Quick'}) filter='$Filter'"
if (-not ($hasNs -or $hasRj)) {
    Write-Host "WARNING: agent deps missing. Run: cd $agent ; npm install" -ForegroundColor Red
}

# --- Step 1: desktop probe (no lock needed) ------------------------------------
Invoke-Step "probeDesktop.ps1" {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here "probeDesktop.ps1")
}

# --- Step 2: session state (no lock needed) ------------------------------------
Invoke-Step "sessionState.ps1" {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here "sessionState.ps1")
}

# --- Step 3: try attach Winlogon + capture one frame (current desktop) ---------
Invoke-Step "tryAttachWinlogon.ps1" {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here "tryAttachWinlogon.ps1")
}

# --- Step 4: DXGI capture probe — LOCK MID-RUN ---------------------------------
if ($hasNs) {
    Invoke-Step "captureProbe.mjs (DXGI) — LOCK MID-RUN" {
        Count-Down 5 "Lock the machine (Win+L) when capture starts — watch for BLACK/FROZEN frames."
        & $nodeExe (Join-Path $here "captureProbe.mjs") 20 1000
    }
}

# --- Step 5: robotjs capture probe (Full only) ----------------------------------
if ($Full -and $hasRj) {
    Invoke-Step "captureRobotjsProbe.mjs (BitBlt) — LOCK MID-RUN" {
        Count-Down 5 "Lock the machine (Win+L) when capture starts."
        & $nodeExe (Join-Path $here "captureRobotjsProbe.mjs") 20 1000
    }
}

# --- Step 6: SendInput probe (Scroll Lock LED) — LOCK MID-RUN ------------------
if ($hasRj) {
    Invoke-Step "sendInputProbe.mjs — LOCK MID-RUN" {
        Count-Down 5 "Lock the machine (Win+L). Watch physical Scroll Lock LED."
        & $nodeExe (Join-Path $here "sendInputProbe.mjs")
    }
}

# --- Step 7: blind unlock (Full only, needs password) --------------------------
if ($Full -and $hasRj) {
    $pw = $env:LOCKPW
    if (-not $pw) {
        $sec = Read-Host "Enter Windows password for blindUnlock (input hidden)" -AsSecureString
        $pw = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
              [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
    }
    if ($pw) {
        Invoke-Step "blindUnlock.mjs" {
            Count-Down 5 "Do NOT lock yet — script will type after countdown; lock right after it starts."
            & $nodeExe (Join-Path $here "blindUnlock.mjs") 5 $pw
        }
        # Best-effort scrub from shell history (PowerShell 7+)
        if (Get-Command -Name Get-History -ErrorAction SilentlyContinue) {
            try { Clear-History -ErrorAction SilentlyContinue } catch {}
        }
    } else {
        Write-Host "[skip] blindUnlock — no password provided" -ForegroundColor DarkGray
        Add-Content $logfile "[skip] blindUnlock — no password"
    }
}

# --- Summary -------------------------------------------------------------------
Write-Section "SUMMARY"
$lines = @(
    "Log file     : $logfile",
    "Also see     : lockscreen-capture.log, lockscreen-robotjs.log, blindUnlock.log, sendInputProbe.log, winlogon-capture.png",
    "",
    "Decision matrix:",
    "  tryAttachWinlogon desktop=Winlogon + avgByte>8  => capture lock OK via SetThreadDesktop (user privilege)",
    "  OpenInputDesktop/SetThreadDesktop FAIL          => need agent as Windows service (SYSTEM)",
    "  captureProbe shows BLACK/FROZEN when locked     => confirms DXGI cannot see Winlogon",
    "  sendInputProbe Scroll Lock LED toggles when lock => SendInput reaches Winlogon => blind unlock viable"
)
$lines | ForEach-Object { Write-Host $_; Add-Content $logfile $_ }

Write-Host ""
Write-Host "Full log written to: $logfile" -ForegroundColor Green
