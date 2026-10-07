@echo off
rem One-click installer for Windows (double-click this file).
setlocal
set REPO=%~dp0.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\install.ps1" -RepoPath "%REPO%" %*
echo.
echo Exit code: %ERRORLEVEL%
pause
