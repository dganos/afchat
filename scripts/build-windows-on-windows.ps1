<#
.SYNOPSIS
  Build a Windows x64 air-gapped bundle of Aristo, natively ON Windows.

.DESCRIPTION
  Produces (under dist\):
    Aristo-Windows-app.zip      code + Electron + ollama runtime (NO models)
    Aristo-Windows-models.zip   resources\models only
  ...and, when the models zip exceeds GitHub Releases' 2 GB/file limit, splits
  it into Aristo-Windows-models.zip.partNN for upload.

  Why this exists (vs scripts\build-windows.sh): that script is a macOS
  cross-build. On macOS `npm install` only fetches the macOS @napi-rs/canvas
  native binary, so the Windows .exe shipped a Mac binary that Windows can't
  load -> pdf-parse threw at startup -> the API server died -> no window.
  Building natively on Windows makes `npm install` pull
  @napi-rs/canvas-win32-x64-msvc, so PDF support (and the app) actually work.
  No VC++ Redistributable is required on the target: ollama + canvas import
  only the Universal CRT, which ships with Windows 10/11.

  On the TARGET (air-gapped) machine:
    1. extract Aristo-Windows-app.zip into a folder
    2. if the models zip was split: reassemble the parts (see final output),
       then extract Aristo-Windows-models.zip into the SAME folder
    3. run win-unpacked\Aristo.exe

.PARAMETER Force
  Re-zip even if dist\*.zip already exist.

.PARAMETER RefreshOllama
  Re-download the Windows ollama runtime even if it is cached.

.PARAMETER SplitSizeMB
  Max size of each models-zip part. Default 1900 (under GitHub's 2 GB limit).
  Set to 0 to disable splitting.

.PARAMETER OllamaUrl
  Override the ollama Windows runtime URL (pin a version for reproducibility).

.EXAMPLE
  pwsh -File scripts\build-windows-on-windows.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\build-windows-on-windows.ps1 -Force
#>
[CmdletBinding()]
param(
  [switch]$Force,
  [switch]$RefreshOllama,
  [int]$SplitSizeMB = 1900,
  [string]$OllamaUrl = 'https://github.com/ollama/ollama/releases/latest/download/ollama-windows-amd64.zip'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # IWR's progress bar cripples download speed on PS 5.1

# ── Paths ─────────────────────────────────────────────────────────────────────
$Root      = Split-Path -Parent $PSScriptRoot
$Dist      = Join-Path $Root 'dist'
$Unpacked  = Join-Path $Dist 'win-unpacked'
$CacheDir  = Join-Path $Root '.build-cache'
$Resources = Join-Path $Root 'resources'
$ModelsDir = Join-Path $Resources 'models'
$DocsDir   = Join-Path $Resources 'documents'
$OllamaDir = Join-Path $Resources 'ollama'
$PkgDir    = Join-Path $Root 'packages\gemma4-qa'
$AppZip    = Join-Path $Dist 'Aristo-Windows-app.zip'
$ModelsZip = Join-Path $Dist 'Aristo-Windows-models.zip'
$OllamaZip = Join-Path $CacheDir 'ollama-windows-amd64.zip'

function Info($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Ok  ($m) { Write-Host "    $m" -ForegroundColor Green }
function Warn($m) { Write-Host "WARNING: $m" -ForegroundColor Yellow }
function Die ($m) { Write-Host "ERROR: $m" -ForegroundColor Red; exit 1 }

# ── Helpers ───────────────────────────────────────────────────────────────────

# Create a STORED (uncompressed) zip. Store, not deflate: model blobs are
# incompressible gguf, so deflate just burns CPU. Uses .NET ZipArchive directly
# (not Compress-Archive, which throws "Stream was too long" on >2 GB entries);
# ZipArchive enables Zip64 automatically for the multi-GB model blob.
function New-StoredZip {
  param(
    [Parameter(Mandatory)] [string]   $OutFile,
    [Parameter(Mandatory)] [string]   $SourceDir,   # directory to walk
    [string]                          $ArcPrefix,   # path prefix inside the zip
    [string[]]                        $ExcludeDirs = @()  # absolute paths to skip
  )
  Add-Type -AssemblyName System.IO.Compression | Out-Null
  if (Test-Path $OutFile) { Remove-Item $OutFile -Force }
  $src = (Resolve-Path $SourceDir).Path.TrimEnd('\')
  $fs  = [System.IO.File]::Open($OutFile, [System.IO.FileMode]::Create)
  $zip = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    Get-ChildItem -LiteralPath $src -Recurse -File | ForEach-Object {
      $full = $_.FullName
      foreach ($ex in $ExcludeDirs) {
        if ($full.StartsWith($ex, [System.StringComparison]::OrdinalIgnoreCase)) { return }
      }
      $rel   = $full.Substring($src.Length).TrimStart('\', '/') -replace '\\', '/'
      $entry = if ($ArcPrefix) { "$ArcPrefix/$rel" } else { $rel }
      $e   = $zip.CreateEntry($entry, [System.IO.Compression.CompressionLevel]::NoCompression)
      $out = $e.Open()
      $in  = [System.IO.File]::OpenRead($full)
      try { $in.CopyTo($out, 1MB) } finally { $in.Dispose(); $out.Dispose() }
    }
  } finally { $zip.Dispose(); $fs.Dispose() }
}

# Split a file into zero-padded .partNN chunks for GitHub's 2 GB/file limit.
function Split-IntoParts {
  param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][int]$ChunkMB)
  $chunk = [int64]$ChunkMB * 1MB
  $parts = @()
  $in = [System.IO.File]::OpenRead($Path)
  try {
    $buf = New-Object byte[] (4MB)
    $idx = 0
    while ($true) {
      $partPath = "{0}.part{1:D2}" -f $Path, $idx
      $out = [System.IO.File]::Open($partPath, [System.IO.FileMode]::Create)
      $written = [int64]0
      try {
        while ($written -lt $chunk) {
          $want = [int][math]::Min($buf.Length, $chunk - $written)
          $read = $in.Read($buf, 0, $want)
          if ($read -le 0) { break }
          $out.Write($buf, 0, $read)
          $written += $read
        }
      } finally { $out.Dispose() }
      if ($written -eq 0) { Remove-Item $partPath -Force; break }
      $parts += $partPath
      $idx++
      if ($in.Position -ge $in.Length) { break }
    }
  } finally { $in.Dispose() }
  return $parts
}

function Get-SizeStr($path) {
  if (-not (Test-Path $path)) { return 'missing' }
  $mb = (Get-Item $path).Length / 1MB
  if ($mb -ge 1024) { '{0:N2} GB' -f ($mb / 1024) } else { '{0:N0} MB' -f $mb }
}

# electron-builder downloads a "winCodeSign" helper and extracts it; that archive
# contains macOS symlinks whose extraction on Windows needs admin / Developer Mode
# (else: "Cannot create symbolic link: A required privilege is not held"). We don't
# sign and don't need the darwin/linux parts, so pre-seed the cache WITHOUT them so
# electron-builder finds a complete dir and skips its own (failing) extraction.
# Idempotent and best-effort. Version is pinned by electron-builder; bump if it changes.
function Initialize-WinCodeSignCache {
  param([string]$Version = '2.6.0')
  $cacheRoot = Join-Path $env:LOCALAPPDATA 'electron-builder\Cache\winCodeSign'
  $dst = Join-Path $cacheRoot "winCodeSign-$Version"
  if (Test-Path (Join-Path $dst 'windows-10')) { Ok 'winCodeSign cache already present'; return }
  $z = Join-Path $Root 'node_modules\7zip-bin\win\x64\7za.exe'
  if (-not (Test-Path $z)) { Warn 'bundled 7za not found; skipping winCodeSign pre-seed'; return }
  $arc = Join-Path $cacheRoot "winCodeSign-$Version.7z"
  $url = "https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-$Version/winCodeSign-$Version.7z"
  try {
    New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null
    if (-not (Test-Path $arc)) { Ok 'fetching winCodeSign helper'; Invoke-WebRequest -Uri $url -OutFile $arc }
    if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
    & $z x $arc "-o$dst" '-x!darwin' '-x!linux' -y | Out-Null
    if ($LASTEXITCODE -eq 0 -and (Test-Path (Join-Path $dst 'windows-10'))) {
      Ok 'winCodeSign cache seeded (no symlinks)'
    } else {
      Warn 'winCodeSign pre-seed failed; electron-builder will extract it itself (may need admin/Developer Mode).'
    }
  } catch {
    Warn "winCodeSign pre-seed error: $($_.Exception.Message)"
  }
}

# ── Pre-flight ────────────────────────────────────────────────────────────────
if ($env:OS -ne 'Windows_NT') { Die 'This script must run on Windows. For a macOS cross-build use scripts/build-windows.sh.' }
foreach ($exe in 'node', 'npm', 'npx') {
  if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { Die "$exe was not found on PATH." }
}
New-Item -ItemType Directory -Force -Path $CacheDir, $Dist | Out-Null

if (-not $Force -and (Test-Path $AppZip) -and (Test-Path $ModelsZip)) {
  Info 'Bundles already exist (use -Force to rebuild):'
  Ok ("{0}  ({1})" -f $AppZip,    (Get-SizeStr $AppZip))
  Ok ("{0}  ({1})" -f $ModelsZip, (Get-SizeStr $ModelsZip))
  exit 0
}

# Free space (build needs ~15 GB headroom for node_modules + dist + zips).
$drive = (Get-Item $Root).PSDrive
$freeGB = [math]::Floor($drive.Free / 1GB)
if ($freeGB -lt 15) { Warn "only ${freeGB} GB free on $($drive.Name): — build needs ~15 GB headroom." }

# Agent package must exist and be wired into electron-builder "files", or the
# app will boot but every question returns 503 (no fallback by design).
if (-not (Test-Path (Join-Path $PkgDir 'package.json'))) { Die "agent package missing: $PkgDir" }
$buildCfg = (Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json).build
if (-not ($buildCfg.files -contains 'packages/**/*')) {
  Die 'package.json build.files is missing "packages/**/*" — the agent package would not be bundled. Add it and re-run.'
}
$modelId = (Get-Content (Join-Path $PkgDir 'package.json') -Raw | ConvertFrom-Json).model.id

# Staged runtime resources (gitignored — must be present locally before building).
if (-not (Test-Path $DocsDir) -or -not (Get-ChildItem $DocsDir -File -Recurse -ErrorAction SilentlyContinue)) {
  Warn "resources\documents is empty — the bundle will ship with NO documents to answer from."
}
if (-not (Test-Path (Join-Path $ModelsDir 'blobs'))) { Die "no model store at $ModelsDir (need blobs\ + manifests\)." }
# Confirm the model the agent package expects is actually staged.
$name, $tag = $modelId -split ':', 2
if (-not $tag) { $tag = 'latest' }
$manifest = Join-Path $ModelsDir ("manifests\registry.ollama.ai\library\{0}\{1}" -f $name, $tag)
if (-not (Test-Path $manifest)) {
  Warn "agent package model '$modelId' not found in resources\models (looked for $manifest)."
  Warn "The app will load the package but find no matching model installed. Stage it with: ollama pull $modelId (with OLLAMA_MODELS=$ModelsDir)."
}

Info "Build plan: model='$modelId', docs='$DocsDir', out='$Dist'"

# ── 1. Windows ollama runtime (CPU-only) ──────────────────────────────────────
Info '[1/5] Preparing Windows ollama runtime'
if ($RefreshOllama -or -not (Test-Path $OllamaZip)) {
  Ok "downloading $OllamaUrl"
  Invoke-WebRequest -Uri $OllamaUrl -OutFile $OllamaZip
} else {
  Ok "using cached $OllamaZip"
}
# Extract ollama.exe, vc_redist, and the whole lib\ollama EXCEPT GPU runtimes
# (cuda/rocm/hip) — the air-gapped target is CPU-only, and GPU blobs are huge.
New-Item -ItemType Directory -Force -Path $OllamaDir | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
$zip = [System.IO.Compression.ZipFile]::OpenRead($OllamaZip)
try {
  $gpu = @('*cuda*', '*cublas*', '*cudart*', '*rocm*', '*hip*', '*roc*')
  foreach ($e in $zip.Entries) {
    if ($e.FullName.EndsWith('/')) { continue }
    $n = $e.FullName
    $keep = ($n -eq 'ollama.exe') -or ($n -eq 'vc_redist.x64.exe') -or ($n -like 'lib/ollama/*')
    if (-not $keep) { continue }
    $isGpu = $false; foreach ($g in $gpu) { if ($n -like $g) { $isGpu = $true; break } }
    if ($isGpu) { continue }
    $dest = Join-Path $OllamaDir ($n -replace '/', '\')
    New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, $dest, $true)
  }
} finally { $zip.Dispose() }
if (-not (Test-Path (Join-Path $OllamaDir 'ollama.exe'))) { Die 'ollama.exe was not extracted — check the runtime URL.' }
Ok ("ollama runtime: {0}" -f (Get-SizeStr (Join-Path $OllamaDir 'ollama.exe')))

# ── 2. Install dependencies (pulls the Windows canvas binary) ──────────────────
Info '[2/5] npm install (fetches @napi-rs/canvas-win32-x64-msvc)'
Push-Location $Root
try {
  npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Die 'npm install failed.' }

  # ── 3. Next.js static export + electron-builder (unpacked) ─────────────────
  Info '[3/5] next build'
  npx next build
  if ($LASTEXITCODE -ne 0) { Die 'next build failed.' }

  Info '[4/5] electron-builder --win --x64 --dir'
  Initialize-WinCodeSignCache   # avoid the symlink-privilege failure on locked-down Windows
  if (Test-Path $Unpacked) { Remove-Item $Unpacked -Recurse -Force }
  npx electron-builder --win --x64 --dir
  if ($LASTEXITCODE -ne 0) { Die 'electron-builder failed.' }
} finally { Pop-Location }

if (-not (Test-Path $Unpacked)) { Die "dist\win-unpacked was not produced." }

# ── 3b. Regression guards (the two bugs this script exists to prevent) ─────────
Info 'Verifying the bundle'
$canvas = Get-ChildItem -Path (Join-Path $Unpacked 'resources\app.asar.unpacked') -Recurse -Filter 'skia.win32-x64-msvc.node' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $canvas) { Die 'canvas Windows binary (skia.win32-x64-msvc.node) is NOT in the bundle — PDF support and startup would break. Was this built on Windows?' }
Ok "canvas win32 binary present: $($canvas.FullName.Substring($Unpacked.Length+1))"
# Agent package travels inside app.asar; confirm the asar exists and is non-trivial.
$asar = Join-Path $Unpacked 'resources\app.asar'
if (-not (Test-Path $asar)) { Die 'resources\app.asar missing from the bundle.' }
Ok ("app.asar present: {0}" -f (Get-SizeStr $asar))

# ── 4. Zip: app (no models) + models, split models for GitHub ─────────────────
Info '[5/5] Creating zip(s)'
$modelsPath = (Join-Path $Unpacked 'resources\models')

Ok 'app zip (excluding models)...'
New-StoredZip -OutFile $AppZip -SourceDir $Dist -ArcPrefix '' -ExcludeDirs @($modelsPath)
Ok ("{0}  ({1})" -f (Split-Path $AppZip -Leaf), (Get-SizeStr $AppZip))

Ok 'models zip...'
# Prefix so it merges with the app zip on extract: win-unpacked\resources\models\...
New-StoredZip -OutFile $ModelsZip -SourceDir $modelsPath -ArcPrefix 'win-unpacked/resources/models'
Ok ("{0}  ({1})" -f (Split-Path $ModelsZip -Leaf), (Get-SizeStr $ModelsZip))

$parts = @()
if ($SplitSizeMB -gt 0 -and (Get-Item $ModelsZip).Length -gt ([int64]$SplitSizeMB * 1MB)) {
  Ok "models zip exceeds ${SplitSizeMB} MB — splitting for GitHub Releases..."
  Get-ChildItem -Path $Dist -Filter 'Aristo-Windows-models.zip.part*' -ErrorAction SilentlyContinue | Remove-Item -Force
  $parts = Split-IntoParts -Path $ModelsZip -ChunkMB $SplitSizeMB
  foreach ($p in $parts) { Ok ("  {0}  ({1})" -f (Split-Path $p -Leaf), (Get-SizeStr $p)) }
}

# ── Done ──────────────────────────────────────────────────────────────────────
Write-Host ''
Write-Host 'Build complete' -ForegroundColor Green
Ok ("{0}  ({1})" -f $AppZip,    (Get-SizeStr $AppZip))
Ok ("{0}  ({1})" -f $ModelsZip, (Get-SizeStr $ModelsZip))
Write-Host ''
Write-Host 'On the target (air-gapped) Windows machine:' -ForegroundColor Cyan
Write-Host '  1. Extract Aristo-Windows-app.zip into a folder.'
if ($parts.Count -gt 0) {
  Write-Host '  2. Reassemble the model zip from its parts, e.g. in cmd.exe:'
  Write-Host '         copy /b Aristo-Windows-models.zip.part?? Aristo-Windows-models.zip'
  Write-Host '     then extract Aristo-Windows-models.zip into the SAME folder.'
} else {
  Write-Host '  2. Extract Aristo-Windows-models.zip into the SAME folder.'
}
Write-Host '  3. Run win-unpacked\Aristo.exe'
