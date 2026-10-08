<#
.SYNOPSIS
  Remove the dsh-tray-restart patch, restoring the original app.asar.

.DESCRIPTION
  Restores resources/app.asar from the backup that install.ps1 created, so the
  tray menu goes back to Open / Quit. Like install.ps1, this needs DeepSeek
  Harness closed because the file is locked while it runs.

.PARAMETER Asar
  Full path to app.asar. Defaults to the standard per-user install location.

.PARAMETER Force
  Do not ask before closing a running DeepSeek Harness.

.PARAMETER NoLaunch
  Do not start DeepSeek Harness afterwards.

.EXAMPLE
  .\uninstall.ps1
#>
[CmdletBinding()]
param(
  [string]$Asar,
  [switch]$Force,
  [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Find-Asar {
  if ($Asar) {
    if (-not (Test-Path -LiteralPath $Asar)) { throw "No such file: $Asar" }
    return (Resolve-Path -LiteralPath $Asar).Path
  }
  $candidate = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\app.asar'
  if (Test-Path -LiteralPath $candidate) { return (Resolve-Path -LiteralPath $candidate).Path }
  throw "Could not find app.asar. Pass -Asar <path>."
}

function Get-AppProcesses {
  Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
}

function Find-AppExe($asarPath) {
  $install = Split-Path -Parent (Split-Path -Parent $asarPath)
  $exe = Join-Path $install 'DeepSeek Harness.exe'
  if (Test-Path -LiteralPath $exe) { return $exe }
  return $null
}

function Test-Writable($path) {
  try {
    $fs = [System.IO.File]::Open($path, 'Open', 'ReadWrite', 'None')
    $fs.Close()
    return $true
  } catch { return $false }
}

Write-Host 'dsh-tray-restart uninstaller' -ForegroundColor Cyan
Write-Host ''

$asar = Find-Asar
Write-Host "  app.asar : $asar"

$backup = "$asar.dsh-tray-restart.bak"
if (-not (Test-Path -LiteralPath $backup)) {
  throw "No backup found at $backup - nothing to restore. If the patch is applied, reinstall DeepSeek Harness or simply leave it in place."
}

$exe = Find-AppExe $asar
$procs = @(Get-AppProcesses)

if (-not (Test-Writable $asar)) {
  if (-not $procs.Count) {
    throw "app.asar is locked but no DeepSeek Harness process was found. Close any other program using it and retry."
  }
  if (-not $Force) {
    Write-Host ''
    Write-Host "DeepSeek Harness is running; app.asar is locked." -ForegroundColor Yellow
    $answer = Read-Host 'Close DeepSeek Harness now? [y/N]'
    if ($answer -notmatch '^[Yy]') { Write-Host 'Aborted.' -ForegroundColor Yellow; exit 1 }
  }
  Write-Host '  closing DeepSeek Harness...'
  $procs | Stop-Process -Force -ErrorAction SilentlyContinue
  $deadline = (Get-Date).AddSeconds(30)
  while (-not (Test-Writable $asar)) {
    if ((Get-Date) -gt $deadline) { throw 'app.asar is still locked after 30s. Close DeepSeek Harness manually and retry.' }
    Start-Sleep -Milliseconds 300
  }
  Write-Host '  closed.'
}

Write-Host ''
& node (Join-Path $root 'index.js') restore --asar $asar
if ($LASTEXITCODE -ne 0) { throw "Restore failed (exit $LASTEXITCODE)." }

Write-Host ''
if ($NoLaunch -or -not $exe) {
  Write-Host 'Done. The tray menu is back to Open / Quit.' -ForegroundColor Green
  exit 0
}

$answer = 'y'
if (-not $Force) { $answer = Read-Host 'Start DeepSeek Harness now? [Y/n]' }
if ($answer -notmatch '^[Nn]') {
  Start-Process -FilePath $exe | Out-Null
  Write-Host 'Started DeepSeek Harness.' -ForegroundColor Green
} else {
  Write-Host 'Done. The tray menu is back to Open / Quit.' -ForegroundColor Green
}
