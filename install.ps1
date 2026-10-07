#Requires -Version 5.1
# mem one-command installer for Windows.
# Local:   powershell -ExecutionPolicy Bypass -File install.ps1
# Remote:  $env:MEM_PACKAGE_URL='https://.../mem-v0.3.0.zip'; irm <raw-install.ps1> | iex
[CmdletBinding()]
param(
  [string]$RepoPath = '',
  [string]$RepoUrl = $env:MEM_REPO_URL,
  [string]$PackageUrl = $env:MEM_PACKAGE_URL,
  [switch]$SkipModel,
  [switch]$SkipEmbedding,
  [switch]$SkipService,
  [switch]$WithReviewReminder,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

if (-not $RepoPath) {
  if ($PSScriptRoot) { $RepoPath = $PSScriptRoot }
  else { $RepoPath = Join-Path $env:USERPROFILE 'Github\mem' }
}

function Test-Repo([string]$path) {
  return (Test-Path (Join-Path $path 'package.json')) -and (Test-Path (Join-Path $path 'src'))
}

if (-not (Test-Repo $RepoPath)) {
  New-Item -ItemType Directory -Force -Path (Split-Path $RepoPath -Parent) | Out-Null
  if (Test-Repo $RepoPath) {
    Write-Host "using existing checkout $RepoPath"
  } elseif ($PackageUrl) {
    Write-Host "downloading package..."
    $zip = Join-Path $env:TEMP ("mem-" + [Guid]::NewGuid().ToString('N') + ".zip")
    Invoke-WebRequest -Uri $PackageUrl -OutFile $zip -UseBasicParsing
    $tmp = Join-Path $env:TEMP ("mem-extract-" + [Guid]::NewGuid().ToString('N'))
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $root = Get-ChildItem $tmp -Recurse -Filter package.json | Select-Object -First 1
    if (-not $root) { throw 'package does not contain package.json' }
    New-Item -ItemType Directory -Force -Path $RepoPath | Out-Null
    Copy-Item (Join-Path $root.DirectoryName '*') $RepoPath -Recurse -Force
    Remove-Item $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "installed to $RepoPath"
  } elseif ($RepoUrl) {
    Write-Host "cloning $RepoUrl"
    git clone --depth 1 $RepoUrl $RepoPath
  } else {
    throw "not inside the repo. Set MEM_PACKAGE_URL or MEM_REPO_URL, or clone manually to $RepoPath"
  }
}

$node = Get-Command node -ErrorAction SilentlyContinue
$needNode = $true
if ($node) {
  $version = (& node -v).TrimStart('v')
  if ([int]($version.Split('.')[0]) -ge 24) { $needNode = $false }
}
if ($needNode) {
  Write-Host "Node.js 24+ not found; trying winget..."
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements | Out-Null
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    $node = Get-Command node -ErrorAction SilentlyContinue
  }
  if (-not $node) {
    throw 'Node.js 24+ is required. Install it from https://nodejs.org and rerun the installer.'
  }
}

$args = @{ RepoPath = $RepoPath }
if ($SkipModel) { $args.SkipModel = $true }
if ($SkipService) { $args.SkipService = $true }
if ($WithReviewReminder) { $args.WithReviewReminder = $true }
if ($Force) { $args.Force = $true }
& (Join-Path $RepoPath 'scripts\windows\install.ps1') @args

if (-not $SkipEmbedding) {
  Write-Host 'preparing local EmbeddingGemma 2 (skip with -SkipEmbedding)...'
  & node (Join-Path $RepoPath 'src\cli\memctl.ts') embedding-install
}

Write-Host ''
Write-Host 'Done. Restart VS Code and check Cline Settings > Hooks / MCP Servers.'
