@echo off
REM ============================================================
REM  AIcut 超清增强(SR) 训练素材批量采集启动器
REM  用法：双击本文件即可（自动切到项目根目录 E:\AIcut）
REM  需要联网；建议在独立网段 / 本机运行以避开 Wikimedia 429 限流
REM  已落地的 portrait/landscape 各 8/3 段，重跑会自动跳过(dup)
REM ============================================================

REM 切到脚本所在目录的上级（即 E:\AIcut）
cd /d "%~dp0.."

REM ---- Python 解释器 ----
REM 受管 Python（当前 WorkBuddy 环境）：
set PYTHON_EXE=C:\Users\Administrator\.workbuddy\binaries\python\versions\3.13.12\python.exe
REM 若在本机用系统 Python，改为：  set PYTHON_EXE=python

set SCRIPT=scripts\fetch_public_sr_data.py

REM ---- 可选：API Key（无 key 则只用 Wikimedia Commons）----
set PEXELS_API_KEY=
set PIXABAY_API_KEY=

REM ---- 可选：代理（本机有 Misty 等代理可换出口 IP 解开 429 限流）----
REM 例：  set SR_PROXY=http://127.0.0.1:10809
set SR_PROXY=

REM ---- 采集参数 ----
set LIMIT=150
set DELAY=2
set COOLDOWN=30

echo ============================================
echo  AIcut SR 素材采集
echo  项目目录: %CD%
echo  输出目录: %CD%\data\sr_train
echo  每类上限: %LIMIT% 段
echo  代理:     %SR_PROXY%
echo ============================================

for %%C in (portrait landscape urban text_ui) do (
    echo.
    echo ^>^>^> 采集类别: %%C
    if not "%SR_PROXY%"=="" (
        "%PYTHON_EXE%" %SCRIPT% --category %%C --limit %LIMIT% --delay %DELAY% --cooldown %COOLDOWN% --no-transcode --proxy %SR_PROXY%
    ) else (
        "%PYTHON_EXE%" %SCRIPT% --category %%C --limit %LIMIT% --delay %DELAY% --cooldown %COOLDOWN% --no-transcode
    )
    if errorlevel 1 echo [警告] %%C 因限流提前终止，可稍后重跑本类
)

echo.
echo  采集完成。素材在 data\sr_train\ 各子目录；溯源清单见 ATTRIBUTIONS.csv
echo  提示: text_ui 在 Commons 上 1080p 稀少，可在 run_collect.bat 里
echo        把该行改成 --category text_ui --query "computer screen 4k" 或配置 PEXELS/PIXABAY key
pause
