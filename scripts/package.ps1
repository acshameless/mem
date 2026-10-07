#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$OutputDir = ''
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $OutputDir) { $OutputDir = Join-Path $root 'dist' }
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$name = "mem-v$version"
$stage = Join-Path $OutputDir $name

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

$excludeDirs = @(
  (Join-Path $root '.git'),
  (Join-Path $root 'var'),
  (Join-Path $root 'node_modules'),
  (Join-Path $root 'dist')
)
$args = @($root, $stage, '/E', '/XD') + $excludeDirs + @('/XF', '.DS_Store', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
robocopy @args | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with $LASTEXITCODE" }

$commit = 'unknown'
if (Get-Command git -ErrorAction SilentlyContinue) {
  try { $commit = (git -C $root rev-parse --short HEAD).Trim() } catch { }
}
$manifest = [pscustomobject]@{
  name      = 'mem'
  version   = $version
  commit    = $commit
  built_at  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  platforms = @('macos', 'windows')
}
[System.IO.File]::WriteAllText(
  (Join-Path $stage 'PACKAGE.json'),
  ($manifest | ConvertTo-Json -Depth 4),
  (New-Object System.Text.UTF8Encoding($false))
)

$zip = Join-Path $OutputDir "$name.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -Force
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
[System.IO.File]::WriteAllText("$zip.sha256", "$hash  $name.zip", (New-Object System.Text.UTF8Encoding($false)))

Write-Host "package : $zip"
Write-Host "sha256  : $hash"
