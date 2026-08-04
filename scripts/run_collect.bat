@echo off
echo [%time%] Launching AIcut SR data collector...
setlocal
set "SCRIPT_DIR=%~dp0"
set "ROOT=%SCRIPT_DIR%.."
cd /d "%ROOT%" 2>nul || (echo [ERROR] Cannot cd to %ROOT% & pause & exit /b 1)

REM ---- Python: prefer the managed interpreter that always exists on this machine ----
set "PYTHON_EXE="
if exist "C:\Users\Administrator\.workbuddy\binaries\python\versions\3.13.12\python.exe" (
    set "PYTHON_EXE=C:\Users\Administrator\.workbuddy\binaries\python\versions\3.13.12\python.exe"
) else (
    set "PYTHON_EXE=python"
)
"%PYTHON_EXE%" --version >nul 2>&1 || (echo [ERROR] Python not found: %PYTHON_EXE% & pause & exit /b 1)
if not exist "scripts\fetch_public_sr_data.py" (echo [ERROR] script missing: scripts\fetch_public_sr_data.py & pause & exit /b 1)

set "SCRIPT=scripts\fetch_public_sr_data.py"
set "PEXELS_API_KEY="
set "PIXABAY_API_KEY="
set "SR_PROXY=http://127.0.0.1:10809"
set "LIMIT=150"
set "DELAY=2"
set "COOLDOWN=30"

echo ============================================
echo  AIcut SR data collector
echo  Project : %CD%
echo  Python  : %PYTHON_EXE%
echo  Output  : %CD%\data\sr_train
echo  Limit   : %LIMIT% per category
echo  Proxy   : %SR_PROXY%
echo ============================================

for %%C in (portrait landscape urban text_ui) do (
    echo.
    echo ^>^>^> Collecting category: %%C
    if not "%SR_PROXY%"=="" (
        "%PYTHON_EXE%" %SCRIPT% --category %%C --limit %LIMIT% --delay %DELAY% --cooldown %COOLDOWN% --no-transcode --proxy %SR_PROXY%
    ) else (
        "%PYTHON_EXE%" %SCRIPT% --category %%C --limit %LIMIT% --delay %DELAY% --cooldown %COOLDOWN% --no-transcode
    )
    if errorlevel 1 echo [WARN] %%C stopped early (rate-limited). Rerun this category later.
)

echo.
echo  Done. Segments in data\sr_train\ subfolders; see ATTRIBUTIONS.csv
echo  Tip: for text_ui, change its line to --category text_ui --query "computer screen 4k"
pause
