#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$RepoPath = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [switch]$WithReviewReminder
)

$ErrorActionPreference = 'Stop'
$node = (Get-Command node -ErrorAction Stop).Source
$daemon = Join-Path $RepoPath 'src\daemon\memd.ts'

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

$daemonAction = New-ScheduledTaskAction -Execute $node -Argument ('"' + $daemon + '"') -WorkingDirectory $RepoPath
$daemonTrigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName 'mem-daemon' -Action $daemonAction -Trigger $daemonTrigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName 'mem-daemon'

if ($WithReviewReminder) {
  $reviewAction = New-ScheduledTaskAction -Execute $node -Argument ('"' + (Join-Path $RepoPath 'src\cli\memctl.ts') + '" review --notify') -WorkingDirectory $RepoPath
  $reviewTrigger = New-ScheduledTaskTrigger -Daily -At '10:00'
  Register-ScheduledTask -TaskName 'mem-review' -Action $reviewAction -Trigger $reviewTrigger -Settings $settings -Force | Out-Null
  Write-Host 'installed mem-review task (daily 10:00)'
}

Write-Host 'installed mem-daemon task (at logon)'
