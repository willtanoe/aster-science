@echo off
rem Installer: create the local instance, patch the upstream binary, and write
rem the (never committed) environment file used by the launcher and proxy.
rem
rem Usage:
rem   install.cmd
rem   install.cmd <base_url> <api_key> [model] [model_map_json]
rem
rem Arguments skip the corresponding prompts, so the installer can be scripted.
setlocal EnableExtensions
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [install] Node.js 18+ is required ^(node not found on PATH^).
  exit /b 1
)

if not exist "config.toml" node "tools\make-config.mjs" || exit /b 1

if not exist "bin" mkdir "bin" >nul 2>&1

if not exist "bin\aster-science.exe" (
  if not exist "bin\Claude-Science-0.1.72.exe" (
    echo [install] Put Claude-Science-0.1.72.exe in bin\, then run install again.
    exit /b 1
  )
  echo [install] Patching bin\Claude-Science-0.1.72.exe -^> bin\aster-science.exe
  node "tools\patch-aster-science.mjs" "bin\Claude-Science-0.1.72.exe" "bin\aster-science.exe" || exit /b 1
  if exist "assets\aster.ico" node "tools\patch-icon.mjs" "bin\aster-science.exe" "assets" || exit /b 1
)

set "BASE=%~1"
set "KEY=%~2"
set "MODEL=%~3"
set "MAP=%~4"

if "%BASE%"=="" set /p "BASE=OpenAI-compatible base URL [https://api.openai.com/v1]: "
if "%BASE%"=="" set "BASE=https://api.openai.com/v1"
if "%KEY%"=="" set /p "KEY=API key: "
if "%KEY%"=="" (
  echo [install] An API key is required.
  exit /b 1
)
if "%MODEL%"=="" set /p "MODEL=Upstream model [gpt-4o]: "
if "%MODEL%"=="" set "MODEL=gpt-4o"
if "%MAP%"=="" set /p "MAP=Model map JSON (optional; leave empty for default aliases): "

> "env.local.cmd" echo @echo off
>> "env.local.cmd" echo set "ASTER_OPENAI_BASE_URL=%BASE%"
>> "env.local.cmd" echo set "ASTER_OPENAI_API_KEY=%KEY%"
>> "env.local.cmd" echo set "ASTER_OPENAI_MODEL=%MODEL%"
if not "%MAP%"=="" >> "env.local.cmd" echo set "ASTER_MODEL_MAP=%MAP%"

if not exist "claude-science-data\logs" mkdir "claude-science-data\logs" >nul 2>&1

echo.
echo [install] Wrote env.local.cmd (gitignored).
echo [install] Run: aster-science.cmd serve
