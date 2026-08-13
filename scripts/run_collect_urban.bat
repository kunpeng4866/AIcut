@echo off
echo [%time%] Launching AIcut SR urban (geometric) supplement collector...
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
set "PEXELS_API_KEY=pvFgAVrWRLEIym2f7GUEt9GtShfWSgGWjxj4CYUIeCZQQZvSPVmvCN9M"
set "PIXABAY_API_KEY=57003371-132097cb875674d6591fe41d2"
set "SR_PROXY=http://127.0.0.1:10481"
set "LIMIT=35"
set "DELAY=2"
set "COOLDOWN=30"
set "PYTHONIOENCODING=utf-8"

echo ============================================
echo  AIcut SR urban (geometric) supplement
echo  Project : %CD%
echo  Python  : %PYTHON_EXE%
echo  Output  : %CD%\data\sr_train\urban
echo  Limit   : %LIMIT% (existing 7 kept; url-dedup)
echo  Source  : pexels,pixabay  (commons excluded on purpose)
echo  Proxy   : %SR_PROXY%
echo  Log     : %CD%\data\sr_train\_collect_urban.log
echo ============================================

set "LOG=%CD%\data\sr_train\_collect_urban.log"
echo [%date% %time%] START urban-geometric >> "%LOG%"

REM urban = PRESERVED_SCENES: 纯几何直线/强边缘建筑纹理，避开 commons 的新闻/事件素材
echo ^>^>^> Collecting category: urban (geometric)  ^(see _collect_urban.log^)
"%PYTHON_EXE%" %SCRIPT% --category urban --limit %LIMIT% --delay %DELAY% --cooldown %COOLDOWN% --no-transcode --source pexels,pixabay --proxy %SR_PROXY% --pexels-key %PEXELS_API_KEY% --pixabay-key %PIXABAY_API_KEY% >> "%LOG%" 2>&1
if errorlevel 1 (echo [WARN] urban stopped early ^(rate-limited?^) Rerun later. & echo [%date% %time%] WARN urban stopped early >> "%LOG%") else (echo [%date% %time%] OK urban >> "%LOG%")

echo [%date% %time%] END urban-geometric >> "%LOG%"
echo.
echo  Done. Segments in data\sr_train\urban ; see _collect_urban.log
pause
