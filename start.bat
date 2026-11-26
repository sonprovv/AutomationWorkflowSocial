@echo off
REM Social Spy Automation - start (Windows). Native mode by default (no Docker needed).
REM Usage: start.bat            (native: embedded PostgreSQL + Redis/Memurai if installed)
REM        start.bat --docker   (Docker Compose, if Docker Desktop is installed)
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [start] Node.js 22 LTS is required: https://nodejs.org
  pause
  exit /b 1
)

if /I "%~1"=="--docker" goto docker

if not exist node_modules (
  echo [start] Installing dependencies ^(first run^)...
  call npm ci
  if errorlevel 1 (
    echo [start] npm ci failed.
    pause
    exit /b 1
  )
)

node node_modules\tsx\dist\cli.mjs tools\local\src\start.ts
if errorlevel 1 pause
exit /b %errorlevel%

:docker
where docker >nul 2>nul
if errorlevel 1 (
  echo [start] Docker is not installed. Run start.bat without --docker for native mode.
  pause
  exit /b 1
)
if not exist .env copy .env.example .env >nul
docker compose up -d --build
if errorlevel 1 (
  pause
  exit /b 1
)
for /f "tokens=2 delims==" %%p in ('findstr /b "APP_PORT=" .env 2^>nul') do set APP_PORT=%%p
if "%APP_PORT%"=="" set APP_PORT=18966
echo [start] Running at http://127.0.0.1:%APP_PORT%
start "" "http://127.0.0.1:%APP_PORT%"
exit /b 0
