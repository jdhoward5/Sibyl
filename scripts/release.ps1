#!/usr/bin/env pwsh
# Build and optionally publish a Windows x64 Sibyl release. The build happens in
# a disposable detached worktree with npm ci; custom b9616 binaries are imported
# from this audited GPU host. Platform binaries remain unsigned.
param(
  [switch]$SkipSmoke,
  [switch]$DryRun,
  [switch]$ReplaceOutput
)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

if (-not $DryRun -and -not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw "GitHub CLI (gh) not found. Install it and authenticate, or pass -DryRun."
}

$buildArgs = @('scripts/clean-release-build.mjs')
if ($SkipSmoke) { $buildArgs += '--skip-smoke' }
if ($ReplaceOutput) { $buildArgs += '--replace-output' }
node @buildArgs
if ($LASTEXITCODE -ne 0) { throw "Clean Windows release build failed." }

$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$root = "release/$version"
$assets = @(
  "$root/squirrel/SibylSetup.exe",
  "$root/squirrel/Sibyl-$version-full.nupkg",
  "$root/squirrel/RELEASES",
  "$root/release-manifest-win-x64.json",
  "$root/release-manifest-win-x64.sig",
  "$root/sbom-win-x64.cdx.json",
  "$root/package-inventory-win-x64.json",
  "$root/SHA256SUMS-win-x64"
)
foreach ($asset in $assets) {
  if (-not (Test-Path -LiteralPath $asset)) {
    throw "Expected verified release asset not found: $asset"
  }
}

$publishArgs = @('scripts/publish-release-assets.mjs')
foreach ($asset in $assets) { $publishArgs += @('--asset', $asset) }
if ($DryRun) { $publishArgs += '--dry-run' }
node @publishArgs
if ($LASTEXITCODE -ne 0) { throw "Collision-safe release publishing failed." }

if ($DryRun) {
  Write-Host "Verified unsigned Windows release built; no tag or asset was published." -ForegroundColor Yellow
} else {
  Write-Host "Published verified unsigned Windows release v$version." -ForegroundColor Green
}
