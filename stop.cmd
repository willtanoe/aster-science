@echo off
rem Stop the daemon and the translation proxy for this instance.
setlocal EnableExtensions
cd /d "%~dp0"
if exist "env.local.cmd" call "env.local.cmd"
if not defined ASTER_PROXY_PORT set "ASTER_PROXY_PORT=8787"

"%~dp0aster-science.cmd" stop %*

powershell -NoProfile -ExecutionPolicy Bypass -Command "$c=Get-NetTCPConnection -LocalPort %ASTER_PROXY_PORT% -State Listen -ErrorAction SilentlyContinue; if($c){$c.OwningProcess | Sort-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }; Write-Host '[aster-science] proxy stopped'} else { Write-Host '[aster-science] proxy not running' }"
