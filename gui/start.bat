@echo off
cd /d E:\AIcut\gui
echo === AIcut Video Editor ===
echo Starting server...
start "" http://localhost:3456
node server.js
pause
