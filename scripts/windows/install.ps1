#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$RepoPath = '',
  [switch]$SkipModel,
  [switch]$SkipService,
  [switch]$WithReviewReminder,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
if (-not $RepoPath) { $RepoPath = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) { throw 'Node.js not found. Install Node.js 24+ first.' }
$nodeVersion = (& node -v).TrimStart('v')
$major = [int]($nodeVersion.Split('.')[0])
if ($major -lt 24) { throw "Node.js 24+ required, found $nodeVersion" }

Write-Host "== mem installer (node $nodeVersion) =="

$hookArgs = @{ RepoPath = $RepoPath }
if ($Force) { $hookArgs.Force = $true }
& (Join-Path $PSScriptRoot 'install-hooks.ps1') @hookArgs

& (Join-Path $PSScriptRoot 'install-mcp.ps1') -RepoPath $RepoPath

if (-not $SkipModel) {
  & (Join-Path $PSScriptRoot 'configure-model.ps1')
}

if (-not $SkipService) {
  & (Join-Path $PSScriptRoot 'install-service.ps1') -RepoPath $RepoPath -WithReviewReminder:$WithReviewReminder
}

& (Join-Path $PSScriptRoot 'verify.ps1') -RepoPath $RepoPath -ExpectTasks:(-not $SkipService)
Write-Host ''
Write-Host 'Next: restart VS Code, then check Cline Settings > Hooks and MCP Servers.'
