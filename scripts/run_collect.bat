@echo off
REM ============================================================
REM  AIcut Super-Resolution (SR) training data collector
REM  Double-click to run. Auto-cd to project root E:\AIcut
REM  Requires internet. Run on local machine to avoid Wikimedia 429.
REM  Existing portrait/landscape segments are auto-skipped (dup).
REM ============================================================

REM cd to parent of this script dir (i.e. E:\AIcut)
cd /d "%~dp0.."

REM ---- Python interpreter ----
REM Managed Python (WorkBuddy env):
REM set PYTHON_EXE=C:\Users\Administrator\.workbuddy\binaries\python\versions\3.13.12\python.exe
REM System Python on local machine:
set PYTHON_EXE=python

set SCRIPT=scripts\fetch_public_sr_data.py

REM ---- Optional API keys (Wikimedia only if empty) ----
set PEXELS_API_KEY=
set PIXABAY_API_KEY=

REM ---- Optional proxy (local Misty etc. to bypass 429) ----
REM Leave empty to use direct connection. Script auto-falls-back to
REM direct if the proxy is unreachable, so this is safe either way.
set SR_PROXY=http://127.0.0.1:10809

REM ---- Collection params ----
set LIMIT=150
set DELAY=2
set COOLDOWN=30

echo ============================================
echo  AIcut SR data collector
echo  Project : %CD%
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
echo  Tip: text_ui has few 1080p clips on Commons. Change its line to
echo       --category text_ui --query "computer screen 4k" or set PEXELS/PIXABAY key.
pause
