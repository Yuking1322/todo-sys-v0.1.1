@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-local.ps1"
if errorlevel 1 (
  echo.
  echo Start failed. Check terminal output.
  pause
)
