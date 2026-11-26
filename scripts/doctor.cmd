@echo off
REM Environment diagnostics (read-only).
cd /d "%~dp0\.."
node node_modules	sx\dist\cli.mjs tools\local\src\doctor.ts
