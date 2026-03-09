$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$envFile = Join-Path $root ".env"
$envExampleFile = Join-Path $root ".env.example"
$pidFile = Join-Path $root ".server.pid"
$port = 5173
$healthUrl = "http://127.0.0.1:$port/api/health"
$webUrl = "http://127.0.0.1:$port"

if (-not (Test-Path $envFile) -and (Test-Path $envExampleFile)) {
  Copy-Item $envExampleFile $envFile
}

function Test-Health {
  try {
    $response = Invoke-RestMethod -Method Get -Uri $healthUrl -TimeoutSec 2
    return $response.ok -eq $true
  } catch {
    return $false
  }
}

function Open-WebUrl {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Url
  )

  if ($env:SKIP_OPEN_BROWSER -eq "1") {
    Write-Host "Browser auto-open skipped (SKIP_OPEN_BROWSER=1)."
    return
  }

  try {
    Start-Process $Url | Out-Null
  } catch {
    Write-Host "Browser auto-open failed, but service is running: $Url"
  }
}

if (Test-Path $pidFile) {
  $existingPid = (Get-Content $pidFile -Raw).Trim()
  if ($existingPid) {
    $running = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
    if ($running -and (Test-Health)) {
      Open-WebUrl -Url $webUrl
      Write-Host "Service already running: $webUrl"
      exit 0
    }
  }
}

$process = Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory $root -PassThru
Set-Content -Path $pidFile -Value $process.Id -Encoding UTF8

$ready = $false
for ($index = 0; $index -lt 20; $index++) {
  Start-Sleep -Milliseconds 300
  if (Test-Health) {
    $ready = $true
    break
  }
}

if (-not $ready) {
  Write-Host "Service failed to start. Run npm start for details."
  exit 1
}

Open-WebUrl -Url $webUrl
Write-Host "Service started: $webUrl"
