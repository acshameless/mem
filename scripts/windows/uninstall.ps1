#Requires -Version 5.1
[CmdletBinding()]
param()

$ErrorActionPreference = 'Continue'
foreach ($task in @('mem-daemon', 'mem-review')) {
  try {
    Unregister-ScheduledTask -TaskName $task -Confirm:$false
    Write-Host "removed task $task"
  } catch {
    Write-Host "task $task not found"
  }
}

function Get-DocumentsPath {
  try {
    $item = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders' -ErrorAction Stop
    if ($item.Personal) { return [Environment]::ExpandEnvironmentVariables($item.Personal) }
  } catch { }
  return (Join-Path $env:USERPROFILE 'Documents')
}

$hooksDir = Join-Path (Get-DocumentsPath) 'Cline\Hooks'
if (Test-Path $hooksDir) {
  Get-ChildItem $hooksDir -Filter '*.ps1' | Where-Object {
    (Get-Content $_.FullName -TotalCount 1) -like '# mem hook:*'
  } | ForEach-Object {
    Remove-Item $_.FullName -Force
    Write-Host "removed $($_.FullName)"
  }
  $runner = Join-Path $hooksDir '_mem-hook-runner.ps1'
  if (Test-Path $runner) { Remove-Item $runner -Force; Write-Host "removed $runner" }
}

Write-Host 'kept ~/.llm-memory data and config'
