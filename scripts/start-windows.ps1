$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$Minimum = [version]'22.5.0'
function Get-NodeVersion {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { return $null }
  $raw = (& node --version 2>$null).Trim().TrimStart('v')
  try { return [version]$raw } catch { return $null }
}
$version = Get-NodeVersion
if (-not $version -or $version -lt $Minimum) {
  Write-Host "Node.js >= $Minimum is required. Current: $version" -ForegroundColor Yellow
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) { throw 'Install Node.js 22+ from https://nodejs.org/ and reopen PowerShell.' }
  $answer = Read-Host 'Install/upgrade Node.js LTS using winget now? [y/N]'
  if ($answer -notmatch '^(y|yes)$') { throw 'Cancelled; no changes made.' }
  & winget install --id OpenJS.NodeJS.LTS --exact --source winget --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { throw 'winget install failed. Install Node.js 22+ manually and retry.' }
  $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
  $version = Get-NodeVersion
  if (-not $version -or $version -lt $Minimum) { throw "Node.js version still does not meet $Minimum; restart PowerShell and retry." }
}
Write-Host "Node.js $version validated." -ForegroundColor Green
$envFile = Join-Path $Root '.env'
$port = if ($env:PORT) { $env:PORT } else { '9999' }
if (Test-Path $envFile) {
  foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*PORT\s*=\s*["'']?([0-9]+)') { $port = $Matches[1] }
  }
}
if ([int]$port -lt 1 -or [int]$port -gt 65535) { throw "Invalid PORT=$port in environment/.env" }
Write-Host "Runtime root=$Root port=$port platform=Windows" -ForegroundColor Cyan
& node (Join-Path $Root 'start.js') @args
exit $LASTEXITCODE
