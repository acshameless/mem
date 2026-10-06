# mem hook runner: byte-safe UTF-8 stdin/stdout bridge to the Node hooks.
param(
  [Parameter(Mandatory = $true)][string]$EventName,
  [Parameter(Mandatory = $true)][string]$HookFile,
  [string]$NodePath = ''
)

$ErrorActionPreference = 'Stop'
$noop = '{"cancel":false,"contextModification":"","errorMessage":""}'

function Write-Stdout([string]$text) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
  $stream = [Console]::OpenStandardOutput()
  $stream.Write($bytes, 0, $bytes.Length)
  $stream.Flush()
}

if (-not $NodePath) {
  $command = Get-Command node -ErrorAction SilentlyContinue
  if ($command) { $NodePath = $command.Source }
}
if ((-not $NodePath) -or (-not (Test-Path $NodePath))) {
  Write-Stdout $noop
  exit 0
}

$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), (New-Object System.Text.UTF8Encoding($false)))
$json = $reader.ReadToEnd()

$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = $NodePath
$startInfo.Arguments = '"' + $HookFile + '" "' + $EventName + '"'
$startInfo.UseShellExecute = $false
$startInfo.RedirectStandardInput = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$startInfo.StandardInputEncoding = New-Object System.Text.UTF8Encoding($false)
$startInfo.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)

$process = [System.Diagnostics.Process]::Start($startInfo)
$process.StandardInput.Write($json)
$process.StandardInput.Close()
$stderrTask = $process.StandardError.ReadToEndAsync()
$output = $process.StandardOutput.ReadToEnd()
$process.WaitForExit()
[void]$stderrTask.Result

if (-not $output) { $output = $noop }
Write-Stdout $output
exit 0
