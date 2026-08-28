@echo off
setlocal
set "SCRIPT_DIR=%~dp0.."
set "PYTHONPATH=%SCRIPT_DIR%"
set PYTHONIOENCODING=utf-8
set PYTHONUNBUFFERED=1
python -m voicc_host.main %*
