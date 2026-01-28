@echo off
REM Setup script for vscodium-agentic extension
REM Run this after installing Node.js 20+

echo ==========================================
echo  VSCodium Agentic Extension Setup
echo ==========================================

cd /d "%~dp0"

echo.
echo [1/3] Installing dependencies...
call npm install

echo.
echo [2/3] Compiling TypeScript...
call npm run compile

echo.
echo [3/3] Done!
echo.
echo To run the extension in development mode:
echo   1. Open this folder in VSCode/VSCodium
echo   2. Press F5 to launch Extension Development Host
echo.
echo To package as VSIX:
echo   npx vsce package
echo.
pause
