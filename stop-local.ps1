$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $root ".server.pid"

if (-not (Test-Path $pidFile)) {
  Write-Host "No running service found (PID file missing)."
  exit 0
}

$pidText = (Get-Content $pidFile -Raw).Trim()
if (-not $pidText) {
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  Write-Host "PID file was empty and has been cleaned."
  exit 0
}

$process = Get-Process -Id $pidText -ErrorAction SilentlyContinue
if ($process) {
  Stop-Process -Id $pidText -Force
  Write-Host "Service stopped. PID: $pidText"
} else {
  Write-Host "Process not found. Cleaned stale PID file."
}

Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
