#!/usr/bin/env pwsh
# Cut an Oracle release locally, by hand, on the GPU dev box.
#
# We deliberately do NOT use a self-hosted GitHub Actions runner: that would
# leave a GitHub-triggered build daemon running on a machine that holds your
# SSH key + HF token. Releases are infrequent, so we cut them manually instead.
# This script verifies, builds the installer (with the custom CUDA backend),
# and publishes a GitHub pre-release with the .exe attached.
#
# Prereqs on this machine: the CUDA Toolkit + VS Build Tools (for rebuild:llama),
# node_modules installed, and an authenticated `gh` CLI.
#
#   pwsh -File scripts/release.ps1             # tests + GPU smoke + dist + publish
#   pwsh -File scripts/release.ps1 -SkipSmoke  # skip the GPU smoke gate
#   pwsh -File scripts/release.ps1 -DryRun     # build only; no tag, no publish
param(
  [switch]$SkipSmoke,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

if (-not $DryRun -and -not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw "GitHub CLI (gh) not found on PATH. Install it (and 'gh auth login') or pass -DryRun."
}

$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$tag = "v$version"
Write-Host "==> Releasing $tag" -ForegroundColor Cyan

# The published binary must correspond to the commit we tag, so refuse a dirty tree.
if (git status --porcelain) {
  throw "Working tree is dirty. Commit or stash changes before releasing."
}

Write-Host "==> Typecheck + unit tests"
npm run typecheck
npm test

if ($SkipSmoke) {
  Write-Warning "Skipping GPU smoke (-SkipSmoke). The installer will not be verified on a real GPU."
} else {
  Write-Host "==> GPU smoke (downloads a tiny model, loads on GPU, streams a reply)"
  npm run smoke
}

Write-Host "==> Building installer (electron-builder NSIS)"
npm run dist

$installer = "release/$version/Oracle-$version-setup.exe"
if (-not (Test-Path $installer)) {
  throw "Expected installer not found at $installer"
}
Write-Host "==> Built $installer" -ForegroundColor Green

if ($DryRun) {
  Write-Host "==> -DryRun: built but not tagging or publishing." -ForegroundColor Yellow
  return
}

# Tag this commit (idempotent) and publish a pre-release with the installer attached.
if (-not (git tag --list $tag)) {
  git tag -a $tag -m "Oracle $tag"
}
git push origin $tag

gh release create $tag $installer --prerelease --generate-notes --title "Oracle $tag"
Write-Host "==> Published pre-release $tag" -ForegroundColor Green
