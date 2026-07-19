# AIcut Engine Release Build Script
# Usage: powershell -File scripts/release.ps1 [-Version "0.1.0"] [-Napi]

param(
    [string]$Version = "0.1.0",
    [switch]$Napi = $false
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

Write-Host "=== AIcut Engine Release v$Version ===" -ForegroundColor Cyan

# 1. Run tests
Write-Host "[1/4] Running tests..." -ForegroundColor Yellow
Set-Location $Root
cargo test --offline
if ($LASTEXITCODE -ne 0) { throw "Tests failed" }

# 2. Build release
Write-Host "[2/4] Building release..." -ForegroundColor Yellow
if ($Napi) {
    $env:CARGO_HTTP_PROXY = ""
    cargo build --release --features napi
    # Copy .node for npm packaging
    $nodeFile = "$Root\target\release\aicut_engine.dll"
    $destFile = "$Root\packages\engine\aicut_engine.node"
    if (Test-Path $nodeFile) {
        Copy-Item $nodeFile $destFile -Force
        Write-Host "  N-API module: $destFile" -ForegroundColor Green
    }
} else {
    cargo build --release
}

# 3. Copy CLI binary
Write-Host "[3/4] Copying artifacts..." -ForegroundColor Yellow
$distDir = "$Root\dist\v$Version"
New-Item -ItemType Directory -Force -Path $distDir | Out-Null
Copy-Item "$Root\target\release\aicut-engine.exe" $distDir -Force
Write-Host "  Binary: $distDir\aicut-engine.exe" -ForegroundColor Green

# 4. Package
Write-Host "[4/4] Packaging..." -ForegroundColor Yellow
$archivePath = "$Root\dist\aicut-engine-v$Version-windows-x64.zip"
Compress-Archive -Path "$distDir\*" -DestinationPath $archivePath -Force
Write-Host "  Archive: $archivePath" -ForegroundColor Green

Write-Host "=== Release v$Version complete ===" -ForegroundColor Cyan
