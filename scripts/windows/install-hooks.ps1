#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$RepoPath = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Get-DocumentsPath {
  try {
    $item = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders' -ErrorAction Stop
    if ($item.Personal) { return [Environment]::ExpandEnvironmentVariables($item.Personal) }
  } catch { }
  return (Join-Path $env:USERPROFILE 'Documents')
}

$hooksDir = Join-Path (Get-DocumentsPath) 'Cline\Hooks'
$node = (Get-Command node -ErrorAction Stop).Source
$runnerSource = Join-Path $RepoPath 'scripts\windows\hook-runner.ps1'
$runnerTarget = Join-Path $hooksDir '_mem-hook-runner.ps1'

New-Item -ItemType Directory -Force -Path $hooksDir | Out-Null
Copy-Item -Path $runnerSource -Destination $runnerTarget -Force

$events = [ordered]@{
  TaskStart        = 'capture.ts'
  TaskResume       = 'capture.ts'
  TaskCancel       = 'capture.ts'
  TaskComplete     = 'capture.ts'
  PreToolUse       = 'capture.ts'
  PostToolUse      = 'capture.ts'
  Notification     = 'capture.ts'
  UserPromptSubmit = 'user_prompt_submit.ts'
  PreCompact       = 'pre_compact.ts'
}

foreach ($event in $events.Keys) {
  $target = Join-Path $hooksDir ($event + '.ps1')
  if ((Test-Path $target) -and (-not $Force)) {
    Write-Host "SKIP  $target (exists; use -Force to replace)"
    continue
  }
  if (Test-Path $target) {
    Copy-Item $target ($target + '.bak.' + (Get-Date -Format 'yyyyMMddHHmmss'))
  }
  $hookFile = Join-Path $RepoPath ('src\hooks\' + $events[$event])
  $content = @"
# mem hook: $event
& "`$PSScriptRoot\_mem-hook-runner.ps1" -EventName "$event" -HookFile "$hookFile" -NodePath "$node"
"@
  [System.IO.File]::WriteAllText($target, $content, (New-Object System.Text.UTF8Encoding($true)))
  Write-Host "OK    $target"
}

Write-Host ''
Write-Host "hooks dir: $hooksDir"
Write-Host "node:      $node"
Write-Host 'Restart VS Code, then check Cline Settings > Hooks.'
