@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0sr_train_status.ps1" %*
