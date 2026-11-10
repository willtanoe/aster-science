@echo off
rem Proxy launcher used by aster-science.cmd (own console so logs can go to a file).
setlocal EnableExtensions
cd /d "%~dp0.."
if exist "env.local.cmd" call "env.local.cmd"
if not exist "claude-science-data\logs" mkdir "claude-science-data\logs" >nul 2>&1
node "%~dp0aster-proxy.mjs" >> "%~dp0..\claude-science-data\logs\aster-proxy.log" 2>&1
