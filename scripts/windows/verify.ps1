#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$RepoPath = '',
  [switch]$ExpectTasks
)

if (-not $RepoPath) { $RepoPath = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }

$ok = $true
function Check([string]$name, [bool]$condition, [string]$detail = '') {
  if ($condition) {
    Write-Host "OK   $name $detail"
  } else {
    Write-Host "FAIL $name $detail"
    $script:ok = $false
  }
}

function Get-DocumentsPath {
  try {
    $item = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders' -ErrorAction Stop
    if ($item.Personal) { return [Environment]::ExpandEnvironmentVariables($item.Personal) }
  } catch { }
  return (Join-Path $env:USERPROFILE 'Documents')
}

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodeOk = $false
if ($nodeCommand) {
  $version = (& node -v).TrimStart('v')
  $nodeOk = [int]($version.Split('.')[0]) -ge 24
}
Check 'node>=24' $nodeOk

foreach ($file in @('src\cli\memctl.ts', 'src\hooks\user_prompt_submit.ts', 'src\mcp\server.ts')) {
  Check "file $file" (Test-Path (Join-Path $RepoPath $file))
}

$hooksDir = Join-Path (Get-DocumentsPath) 'Cline\Hooks'
$events = @('TaskStart', 'TaskResume', 'TaskCancel', 'TaskComplete', 'PreToolUse', 'PostToolUse', 'Notification', 'UserPromptSubmit', 'PreCompact')
$missing = @($events | Where-Object { -not (Test-Path (Join-Path $hooksDir ($_ + '.ps1'))) })
Check 'hooks installed' ($missing.Count -eq 0) ("($($events.Count - $missing.Count)/$($events.Count))")
Check 'hook runner' (Test-Path (Join-Path $hooksDir '_mem-hook-runner.ps1'))

$configPath = Join-Path $env:USERPROFILE '.llm-memory\config.json'
Check 'config.json' (Test-Path $configPath)
if (Test-Path $configPath) {
  $bytes = [System.IO.File]::ReadAllBytes($configPath)
  $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  Check 'config without BOM' (-not $hasBom)
}

$mcpPath = Join-Path $env:USERPROFILE '.cline\data\settings\cline_mcp_settings.json'
$mcpOk = $false
if (Test-Path $mcpPath) {
  try {
    $json = Get-Content $mcpPath -Raw | ConvertFrom-Json
    $mcpOk = ($json.mcpServers.PSObject.Properties.Name -contains 'mem')
  } catch { }
}
Check 'mcp registered' $mcpOk

if ($ExpectTasks) {
  $daemon = Get-ScheduledTask -TaskName 'mem-daemon' -ErrorAction SilentlyContinue
  Check 'task mem-daemon' ($null -ne $daemon)
}

Write-Host ''
Write-Host 'memctl status:'
& node (Join-Path $RepoPath 'src\cli\memctl.ts') status

if (-not $ok) { exit 1 }
Write-Host ''
Write-Host 'all checks passed'
