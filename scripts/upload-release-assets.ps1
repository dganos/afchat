# Streaming uploader for GitHub release assets (handles multi-GB files reliably).
# Uses HttpWebRequest with buffering OFF so the file streams from disk in chunks
# instead of being loaded into memory like Invoke-RestMethod -InFile does.
param(
  [int]    $ReleaseId = 344165213,
  [string] $Repo      = 'dganos/afchat',
  [string] $DistDir   = 'C:\workarea\afchat\dist',
  [string[]] $Assets  = @(
    'Aristo-Windows-models.zip.part00',
    'Aristo-Windows-models.zip.part01',
    'Aristo-Windows-models.zip.part02'
  )
)

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$token = (Get-Content (Join-Path $env:TEMP '.ghtok') -Raw).Trim()
$apiH  = @{ Authorization = "Bearer $token"; 'User-Agent' = 'aristo-release'; Accept = 'application/vnd.github+json' }

function Get-Existing {
  Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/$ReleaseId/assets" -Headers $apiH
}

foreach ($name in $Assets) {
  $path = Join-Path $DistDir $name
  if (-not (Test-Path $path)) { Write-Output "MISSING: $path"; continue }
  $size = (Get-Item $path).Length

  # If a completed asset with this name already exists, skip (or delete to re-upload).
  $existing = Get-Existing | Where-Object { $_.name -eq $name }
  if ($existing -and $existing.size -eq $size -and $existing.state -eq 'uploaded') {
    Write-Output "ALREADY UPLOADED: $name ($([math]::Round($size/1MB)) MB) - skipping"
    continue
  }
  if ($existing) {
    Write-Output "deleting stale asset $name (state=$($existing.state), size=$($existing.size))"
    Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/assets/$($existing.id)" -Headers $apiH -Method Delete | Out-Null
  }

  Write-Output "UPLOADING $name ($([math]::Round($size/1MB)) MB) ..."
  $uri = "https://uploads.github.com/repos/$Repo/releases/$ReleaseId/assets?name=$name"
  $req = [System.Net.HttpWebRequest]::Create($uri)
  $req.Method = 'POST'
  $req.ContentType = 'application/octet-stream'
  $req.Headers.Add('Authorization', "Bearer $token")
  $req.UserAgent = 'aristo-release'
  $req.Accept = 'application/vnd.github+json'
  $req.AllowWriteStreamBuffering = $false
  $req.KeepAlive = $true
  $req.ContentLength = $size
  $req.Timeout = 600000              # 10 min to establish
  $req.ReadWriteTimeout = 300000     # 5 min max stall on any single chunk

  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $rs = $req.GetRequestStream()
    $fs = [IO.File]::OpenRead($path)
    try {
      $buf = New-Object byte[] (4MB)
      $sent = [int64]0
      $lastPct = -5
      while (($read = $fs.Read($buf, 0, $buf.Length)) -gt 0) {
        $rs.Write($buf, 0, $read)
        $sent += $read
        $pct = [int](($sent / $size) * 100)
        if ($pct -ge $lastPct + 5) {
          $mbps = if ($sw.Elapsed.TotalSeconds -gt 0) { ($sent/1MB)/$sw.Elapsed.TotalSeconds } else { 0 }
          Write-Output ("  {0,3}%  {1,6:N0}/{2:N0} MB  {3,5:N1} MB/s  {4:N0}s" -f $pct, ($sent/1MB), ($size/1MB), $mbps, $sw.Elapsed.TotalSeconds)
          $lastPct = $pct
        }
      }
    } finally { $fs.Close(); $rs.Close() }

    $resp = $req.GetResponse()
    $sr = New-Object IO.StreamReader($resp.GetResponseStream())
    $json = $sr.ReadToEnd() | ConvertFrom-Json
    $sr.Close(); $resp.Close()
    Write-Output ("  DONE: {0} state={1} size={2} MB in {3:N0}s" -f $json.name, $json.state, [math]::Round($json.size/1MB), $sw.Elapsed.TotalSeconds)
  } catch {
    $r = $_.Exception.Response
    if ($r) { $sr = New-Object IO.StreamReader($r.GetResponseStream()); Write-Output "  FAILED $name : $($sr.ReadToEnd())" }
    else    { Write-Output "  FAILED $name : $($_.Exception.Message)" }
  }
}

Write-Output "=== final asset list ==="
Get-Existing | ForEach-Object { "{0,-34} {1,5} MB  {2}" -f $_.name, [math]::Round($_.size/1MB), $_.state }
