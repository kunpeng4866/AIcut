@echo off
setlocal EnableDelayedExpansion
echo [%time%] Launching AIcut SR supplement collector...
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
set "DELAY=2"
set "COOLDOWN=30"
set "PYTHONIOENCODING=utf-8"

set "LOG=%CD%\data\sr_train\_collect_supplements.log"

echo ============================================
echo  AIcut SR supplement collector
echo  Project : %CD%
echo  Python  : %PYTHON_EXE%
echo  Output  : %CD%\data\sr_train
echo  Log     : !LOG!
echo  Proxy   : %SR_PROXY%
echo ============================================
echo.
echo  Categories to download:
echo    food              target 60
echo    animal            target 60
echo    art               target 60
echo    screen_recording  target 50 -^> text_ui\screen_recording
echo    urban             target 35 -^> urban
echo.

echo [%date% %time%] START run_collect supplements >> "%LOG%"

call :collect food 60 pexels,pixabay
call :collect animal 60 pexels,pixabay
call :collect art 60 pexels,pixabay
call :collect screen_recording 50 pexels,pixabay
call :collect urban 35 pexels,pixabay
goto :done

:collect
set "CAT=%~1"
set "CAT_LIMIT=%~2"
set "CAT_SOURCE=%~3"
echo.
echo ^>^>^> Collecting !CAT! ^(limit !CAT_LIMIT!, source !CAT_SOURCE!^)
echo [%date% %time%] ---- category !CAT! ---- >> "%LOG%"
if not "%SR_PROXY%"=="" (
    "%PYTHON_EXE%" %SCRIPT% --category !CAT! --limit !CAT_LIMIT! --delay %DELAY% --cooldown %COOLDOWN% --no-transcode --source !CAT_SOURCE! --proxy %SR_PROXY% --pexels-key %PEXELS_API_KEY% --pixabay-key %PIXABAY_API_KEY%
) else (
    "%PYTHON_EXE%" %SCRIPT% --category !CAT! --limit !CAT_LIMIT! --delay %DELAY% --cooldown %COOLDOWN% --no-transcode --source !CAT_SOURCE! --pexels-key %PEXELS_API_KEY% --pixabay-key %PIXABAY_API_KEY%
)
if errorlevel 1 (echo [WARN] !CAT! stopped early, rate-limited. Rerun this category later. & echo [%date% %time%] WARN !CAT! stopped early >> "%LOG%") else (echo [%date% %time%] OK !CAT! >> "%LOG%")
exit /b

:done
echo [%date% %time%] END run_collect supplements >> "%LOG%"
echo.
echo  Done. Segments in data\sr_train\ subfolders; see ATTRIBUTIONS.csv
echo  screen_recording is under data\sr_train\text_ui\screen_recording
echo  Log detail: !LOG!
pause
