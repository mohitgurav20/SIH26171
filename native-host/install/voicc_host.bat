@echo off
setlocal
set "PYTHONPATH=C:\Users\Public\voicc\native-host"
set PYTHONIOENCODING=utf-8
set PYTHONUNBUFFERED=1
"C:\Program Files\Python313\python.exe" -m voicc_host.main %*
