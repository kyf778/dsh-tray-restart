@echo off
rem Wrapper for uninstall.ps1 (see install.cmd for the policy note).
setlocal
where pwsh >nul 2>nul
if %ERRORLEVEL%==0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
)
exit /b %ERRORLEVEL%
