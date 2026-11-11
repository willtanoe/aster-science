@echo off
rem aster-science — self-contained Claude Science instance + Anthropic→OpenAI proxy.
rem Usage: aster-science.cmd <command> [flags]   (e.g. serve, status, url, stop)
setlocal EnableExtensions
cd /d "%~dp0"

if exist "env.local.cmd" call "env.local.cmd"

if not exist "config.toml" (
  where node >nul 2>&1
  if errorlevel 1 (
    echo [aster-science] Node.js 18+ is required ^(node not found on PATH^).
    exit /b 1
  )
  node "%~dp0tools\make-config.mjs" || exit /b 1
)

if not defined ASTER_PROXY_PORT set "ASTER_PROXY_PORT=8787"
if not defined ASTER_PROXY_HOST set "ASTER_PROXY_HOST=127.0.0.1"
set "PROXY_URL=http://%ASTER_PROXY_HOST%:%ASTER_PROXY_PORT%"

rem Start the proxy if its health endpoint is not already answering.
powershell -NoProfile -ExecutionPolicy Bypass -Command "try{Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 '%PROXY_URL%/health' | Out-Null; exit 0}catch{exit 1}" >nul 2>&1
if errorlevel 1 (
  if not exist "claude-science-data\logs" mkdir "claude-science-data\logs" >nul 2>&1
  start "aster-proxy" /min "%~dp0proxy\run-proxy.cmd"
  powershell -NoProfile -ExecutionPolicy Bypass -Command "for($i=0;$i -lt 40;$i++){try{Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 '%PROXY_URL%/health' | Out-Null; exit 0}catch{Start-Sleep -Milliseconds 250}}; exit 1" >nul 2>&1
  if errorlevel 1 echo [aster-science] WARNING: proxy not answering on %PROXY_URL%
)

set "ANTHROPIC_BASE_URL=%PROXY_URL%"
set "ANTHROPIC_API_KEY=sk-ant-aster"

rem The daemon unpacks an unbranded web-dist on the first run of a version.
rem The rebrand tool exits immediately when the tree already says "Aster
rem Science", and waits for extraction otherwise. It is version-agnostic.
if /i "%~1"=="serve" (
  start "aster-rebrand" /min node "%~dp0tools\rebrand-web-dist.mjs" --watch --timeout 120 --quiet
)

"%~dp0bin\aster-science.exe" %* --config "%~dp0config.toml" --here
