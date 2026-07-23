@echo off
cd /d E:\AIcut\gui
set ELECTRON_RUN_AS_NODE=
echo === AIcut Video Editor ===
echo Starting Electron app...
".\node_modules\electron\dist\electron.exe" .
pause
