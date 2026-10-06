#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$Model = 'deepseek-chat',
  [string]$BaseUrl = 'https://api.deepseek.com'
)

$ErrorActionPreference = 'Stop'
$store = Join-Path $env:USERPROFILE '.llm-memory'
$configPath = Join-Path $store 'config.json'
New-Item -ItemType Directory -Force -Path $store | Out-Null

$modelInput = Read-Host "Model [$Model]"
if ($modelInput) { $Model = $modelInput }
$baseInput = Read-Host "Base URL [$BaseUrl]"
if ($baseInput) { $BaseUrl = $baseInput }

$secure = Read-Host 'API key (hidden)' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$apiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
if (-not $apiKey) { throw 'no API key provided' }

$config = $null
if (Test-Path $configPath) {
  try { $config = Get-Content $configPath -Raw | ConvertFrom-Json } catch { $config = $null }
}
if (-not $config) { $config = New-Object psobject }

$distill = [pscustomobject]@{
  provider            = 'deepseek'
  baseUrl             = $BaseUrl
  model               = $Model
  apiKey              = $apiKey
  maxSessionsPerRun   = 20
  maxCharsPerSession  = 8000
  temperature         = 0.2
}
$config | Add-Member -Force -NotePropertyName distill -NotePropertyValue $distill
if (-not $config.autoDistill) {
  $config | Add-Member -Force -NotePropertyName autoDistill -NotePropertyValue ([pscustomobject]@{
    enabled             = $false
    quietMinutes        = 15
    scanMinutes         = 5
    maxSessionsPerCycle = 3
    reDistillOnChange   = $true
  })
}

$json = $config | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($configPath, $json, (New-Object System.Text.UTF8Encoding($false)))
try { icacls $configPath /inheritance:r /grant:r "$env:USERNAME:(R,W)" | Out-Null } catch { }
Write-Host "wrote $configPath (no BOM)"
