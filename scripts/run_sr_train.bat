@echo off
REM ============================================================================
REM  AIcut SR training launcher
REM  - Passes all arguments to python/sr/train.py
REM  - Retries non-zero exit codes to avoid transient CUDA/import crashes
REM
REM  Usage:
REM    run_sr_train.bat --config E:\AIcut\python\sr\train_config_v1_x2.json
REM ============================================================================
setlocal EnableDelayedExpansion
set "PY=E:\Python310\python.exe"
set "SCRIPT=E:\AIcut\python\sr\train.py"
set "MAXTRY=5"
set /a TRY=0

if not exist "%PY%" (
  echo [run_sr_train] Python not found: %PY%
  exit /b 2
)
if not exist "%SCRIPT%" (
  echo [run_sr_train] training script not found: %SCRIPT%
  exit /b 2
)

:retry
set /a TRY+=1
echo [run_sr_train] ===== attempt %TRY%/%MAXTRY% =====
echo [run_sr_train] %PY% %SCRIPT% %*
"%PY%" "%SCRIPT%" %*
set RC=%ERRORLEVEL%

if %RC%==0 (
  echo [run_sr_train] training finished successfully.
  exit /b 0
)

echo [run_sr_train] exit code=%RC% (possibly transient CUDA/import crash), retrying...
if %TRY% lss %MAXTRY% (
  timeout /t 3 /nobreak >nul
  goto retry
)

echo [run_sr_train] failed after %MAXTRY% attempts. Check:
echo   1) nvidia-smi
echo   2) E:\Python310 torch CUDA
exit /b 1
