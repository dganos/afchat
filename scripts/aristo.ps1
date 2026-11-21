<#
.SYNOPSIS
  Manage the Aristo background server (Ollama + API + web app on http://localhost:3001).

.EXAMPLE
  powershell -File scripts\aristo.ps1 start     # start hidden in the background
  powershell -File scripts\aristo.ps1 status
  powershell -File scripts\aristo.ps1 open      # open the web app in the browser
  powershell -File scripts\aristo.ps1 admin     # open the admin page
  powershell -File scripts\aristo.ps1 logs      # tail the log file
  powershell -File scripts\aristo.ps1 stop
  powershell -File scripts\aristo.ps1 restart
#>
param([ValidateSet('start', 'stop', 'restart', 'status', 'open', 'admin', 'logs')][string]$Command = 'status')

$ErrorActionPreference = 'Stop'
$Root    = Split-Path -Parent $PSScriptRoot
$DataDir = if ($env:ARISTO_DATA_DIR) { $env:ARISTO_DATA_DIR } else { Join-Path $Root '.data' }
$PidFile = Join-Path $DataDir 'aristo.pid'
$LogDir  = Join-Path $DataDir 'logs'
$Url     = 'http://localhost:3001'

function Get-ServerProcess {
  if (-not (Test-Path $PidFile)) { return $null }
  $id = [int](Get-Content $PidFile -Raw)
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($p -and $p.ProcessName -eq 'node') { return $p }
  return $null
}

function Test-Healthy {
  try { return (Invoke-WebRequest "$Url/health" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { return $false }
}

function Start-Server {
  if (Get-ServerProcess) { Write-Host "Already running (PID $((Get-ServerProcess).Id)) - $Url"; return }
  if (-not (Test-Path (Join-Path $Root 'out\index.html'))) {
    Write-Host 'Web app not built yet - running npm run build:web ...'
    Push-Location $Root; try { npm run build:web; if ($LASTEXITCODE) { throw 'build failed' } } finally { Pop-Location }
  }
  New-Item -ItemType Directory -Force $LogDir | Out-Null
  $p = Start-Process -FilePath 'node' -ArgumentList 'start-server.js' -WorkingDirectory $Root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $LogDir 'stdout.log') -RedirectStandardError (Join-Path $LogDir 'stderr.log')
  Write-Host "Starting (PID $($p.Id)) ..."
  for ($i = 0; $i -lt 30; $i++) {
    if (Test-Healthy) { Write-Host "Running - $Url  (admin: $Url/?view=admin)"; return }
    if ($p.HasExited) { Write-Host "Server exited (code $($p.ExitCode)). See $LogDir\stderr.log"; exit 1 }
    Start-Sleep -Milliseconds 500
  }
  Write-Host "Started, but $Url/health is not answering yet. See $LogDir"
}

function Stop-Server {
  $p = Get-ServerProcess
  if (-not $p) { Write-Host 'Not running.'; return }
  # Graceful: the server stops its Ollama child and removes the PID file.
  try { Invoke-RestMethod "$Url/admin/shutdown" -Method Post -Headers @{ 'X-Aristo-Admin' = '1' } -TimeoutSec 3 | Out-Null } catch {}
  if (-not $p.WaitForExit(10000)) {
    Write-Host 'Graceful stop timed out - killing the process tree.'
    taskkill /PID $p.Id /T /F | Out-Null
  }
  Remove-Item $PidFile -ErrorAction SilentlyContinue
  Write-Host 'Stopped.'
}

switch ($Command) {
  'start'   { Start-Server }
  'stop'    { Stop-Server }
  'restart' { Stop-Server; Start-Server }
  'status'  {
    $p = Get-ServerProcess
    if (-not $p) { Write-Host 'Stopped.'; break }
    $s = $null
    try { $s = Invoke-RestMethod "$Url/admin/status" -Headers @{ 'X-Aristo-Admin' = '1' } -TimeoutSec 3 } catch {}
    if ($s) {
      $model = if ($s.model.ready) { 'ready' } elseif ($s.model.error) { "error: $($s.model.error)" } else { 'loading' }
      Write-Host "Running (PID $($s.pid), up $([int]($s.uptimeSec/60)) min) - $Url"
      Write-Host "  ollama: $(if ($s.ollama.running) { "running (PID $($s.ollama.pid))" } else { 'stopped' })"
      Write-Host "  model:  $($s.model.name) - $model"
    } else { Write-Host "Process $($p.Id) is up but the API is not answering." }
  }
  'open'    { Start-Process $Url }
  'admin'   { Start-Process "$Url/?view=admin" }
  'logs'    { Get-Content (Join-Path $LogDir 'aristo.log') -Tail 50 -Wait }
}
