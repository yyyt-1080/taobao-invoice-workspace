$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $Root
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 22 or newer first: https://nodejs.org/' }
$Version = node -p 'process.versions.node'
$Parts = $Version.Split('.') | ForEach-Object { [int]$_ }
if ($Parts[0] -lt 22 -or ($Parts[0] -eq 22 -and $Parts[1] -lt 13)) { throw "Node.js 22.13+ is required (found $Version)" }
npm ci
npx playwright install chromium
$Config = Join-Path $Root 'engine/invoice-config.json'
if (-not (Test-Path $Config)) { Copy-Item (Join-Path $Root 'engine/invoice-config.example.json') $Config }
Write-Host "Setup complete. Run Start.bat, open http://127.0.0.1:4318, then enter your details under “开票资料”."
Read-Host 'Press Enter to close'
