<#
.SYNOPSIS
  Install the dsh-tray-restart patch into a DeepSeek Harness installation.

.DESCRIPTION
  Windows locks resources/app.asar while DeepSeek Harness is running, so the
  patch cannot be applied to a live app. This script handles that: it detects a
  running instance, asks before closing it, applies the patch, and offers to
  start the app again.

  Everything it does is reversible with `node index.js restore`.

.PARAMETER Asar
  Full path to app.asar. Defaults to the standard per-user install location.

.PARAMETER Force
  Do not ask before closing a running DeepSeek Harness.

.PARAMETER NoLaunch
  Do not start DeepSeek Harness after patching.

.EXAMPLE
  .\install.ps1
.EXAMPLE
  .\install.ps1 -Asar "D:\apps\DeepSeek Harness\resources\app.asar" -NoLaunch
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
  # <install>\resources\app.asar -> <install>\DeepSeek Harness.exe
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

Write-Host 'dsh-tray-restart installer' -ForegroundColor Cyan
Write-Host ''

$asar = Find-Asar
Write-Host "  app.asar : $asar"

$exe = Find-AppExe $asar
$procs = @(Get-AppProcesses)

if (-not (Test-Writable $asar)) {
  if (-not $procs.Count) {
    throw "app.asar is locked but no DeepSeek Harness process was found. Close any other program using it and retry."
  }
  if (-not $Force) {
    Write-Host ''
    Write-Host "DeepSeek Harness is running ($($procs.Count) process(es)); app.asar is locked." -ForegroundColor Yellow
    Write-Host 'It must be closed to apply the patch. Your sessions are saved and will be there when it restarts.'
    $answer = Read-Host 'Close DeepSeek Harness now? [y/N]'
    if ($answer -notmatch '^[Yy]') { Write-Host 'Aborted.' -ForegroundColor Yellow; exit 1 }
  }
  Write-Host '  closing DeepSeek Harness...'
  $procs | Stop-Process -Force -ErrorAction SilentlyContinue
  # wait for the file lock to clear
  $deadline = (Get-Date).AddSeconds(30)
  while (-not (Test-Writable $asar)) {
    if ((Get-Date) -gt $deadline) { throw 'app.asar is still locked after 30s. Close DeepSeek Harness manually and retry.' }
    Start-Sleep -Milliseconds 300
  }
  Write-Host '  closed.'
}

Write-Host ''
& node (Join-Path $root 'index.js') apply --asar $asar
if ($LASTEXITCODE -ne 0) { throw "Patching failed (exit $LASTEXITCODE). Nothing was changed." }

Write-Host ''
if ($NoLaunch) {
  Write-Host 'Done. Start DeepSeek Harness to see the new tray entry.' -ForegroundColor Green
  exit 0
}

if ($exe) {
  $answer = 'y'
  if (-not $Force) { $answer = Read-Host 'Start DeepSeek Harness now? [Y/n]' }
  if ($answer -notmatch '^[Nn]') {
    Start-Process -FilePath $exe | Out-Null
    Write-Host 'Started DeepSeek Harness.' -ForegroundColor Green
  } else {
    Write-Host 'Done. Start DeepSeek Harness when ready.' -ForegroundColor Green
  }
} else {
  Write-Host 'Done. Start DeepSeek Harness to see the new tray entry.' -ForegroundColor Green
}
