@echo off
rem Installer: create the local instance, patch the upstream binary, and write
rem the (never committed) environment file used by the launcher and proxy.
setlocal EnableExtensions
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [install] Node.js 18+ is required ^(node not found on PATH^).
  exit /b 1
)

if not exist "aster-science.exe" (
  if not exist "Claude-Science-0.1.72.exe" (
    echo [install] Put Claude-Science-0.1.72.exe in this folder, then run install again.
    exit /b 1
  )
  echo [install] Patching Claude-Science-0.1.72.exe -^> aster-science.exe
  node "tools\patch-aster-science.mjs" "Claude-Science-0.1.72.exe" "aster-science.exe" || exit /b 1
)

set "BASE="
set "KEY="
set "MODEL="
set "MAP="
set /p "BASE=OpenAI-compatible base URL [https://api.openai.com/v1]: "
if "%BASE%"=="" set "BASE=https://api.openai.com/v1"
set /p "KEY=API key: "
if "%KEY%"=="" (
  echo [install] An API key is required.
  exit /b 1
)
set /p "MODEL=Upstream model [gpt-4o]: "
if "%MODEL%"=="" set "MODEL=gpt-4o"
set /p "MAP=Model map JSON, e.g. {\"claude-opus-5\":\"gpt-4o\"} [leave empty for defaults]: "

> "env.local.cmd" echo @echo off
>> "env.local.cmd" echo set "ASTER_OPENAI_BASE_URL=%BASE%"
>> "env.local.cmd" echo set "ASTER_OPENAI_API_KEY=%KEY%"
>> "env.local.cmd" echo set "ASTER_OPENAI_MODEL=%MODEL%"
if not "%MAP%"=="" >> "env.local.cmd" echo set "ASTER_MODEL_MAP=%MAP%"

if not exist "claude-science-data\logs" mkdir "claude-science-data\logs" >nul 2>&1

echo.
echo [install] Wrote env.local.cmd (gitignored).
echo [install] Run: aster-science.cmd serve
