@echo off
REM Social Spy Automation - stop (Windows). Stops only this project's processes/containers. Data is kept.
setlocal
cd /d "%~dp0"
if /I "%~1"=="--docker" (
  docker compose stop
  exit /b %errorlevel%
)
node node_modules\tsx\dist\cli.mjs tools\local\src\stop.ts
exit /b %errorlevel%
