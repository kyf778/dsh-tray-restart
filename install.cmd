@echo off
rem Wrapper so install.ps1 runs even when the default execution policy
rem blocks unsigned scripts. Arguments are forwarded as-is.
setlocal
where pwsh >nul 2>nul
if %ERRORLEVEL%==0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
)
exit /b %ERRORLEVEL%
