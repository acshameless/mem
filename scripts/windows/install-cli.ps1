#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$RepoPath = ''
)

$ErrorActionPreference = 'Stop'
if (-not $RepoPath) { $RepoPath = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
$binDir = Join-Path $env:USERPROFILE '.mem\bin'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$node = (Get-Command node -ErrorAction Stop).Source

foreach ($name in @('memctl', 'memd')) {
  $target = Join-Path $RepoPath "bin\$name.mjs"
  $content = "@echo off`r`n`"$node`" `"$target`" %*`r`n"
  [System.IO.File]::WriteAllText((Join-Path $binDir "$name.cmd"), $content, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "installed $binDir\$name.cmd"
}

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$binDir*") {
  [Environment]::SetEnvironmentVariable('Path', "$binDir;$userPath", 'User')
  Write-Host "added $binDir to user PATH (reopen the terminal)"
} else {
  Write-Host "$binDir already on user PATH"
}
