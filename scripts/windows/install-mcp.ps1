#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$RepoPath = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
)

$ErrorActionPreference = 'Stop'
$settingsDir = Join-Path $env:USERPROFILE '.cline\data\settings'
$settingsPath = Join-Path $settingsDir 'cline_mcp_settings.json'
$node = (Get-Command node -ErrorAction Stop).Source
$server = Join-Path $RepoPath 'src\mcp\server.ts'

New-Item -ItemType Directory -Force -Path $settingsDir | Out-Null
if (Test-Path $settingsPath) {
  Copy-Item $settingsPath ($settingsPath + '.bak.' + (Get-Date -Format 'yyyyMMddHHmmss'))
}
$json = $null
if (Test-Path $settingsPath) {
  try { $json = Get-Content $settingsPath -Raw | ConvertFrom-Json } catch { $json = $null }
}
if (-not $json) { $json = New-Object psobject }
if (-not ($json.PSObject.Properties.Name -contains 'mcpServers')) {
  $json | Add-Member -NotePropertyName mcpServers -NotePropertyValue (New-Object psobject)
}

$entry = [pscustomobject]@{
  command     = $node
  args        = @($server)
  disabled    = $false
  autoApprove = @('mem_recall', 'mem_status')
  timeout     = 60
}
$json.mcpServers | Add-Member -Force -NotePropertyName mem -NotePropertyValue $entry
$text = $json | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText($settingsPath, $text, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "registered mem MCP server in $settingsPath"
Write-Host "node:   $node"
Write-Host "server: $server"
Write-Host 'Restart VS Code or toggle the server in Cline MCP settings.'
