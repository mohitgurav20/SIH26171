@echo off
setlocal
set "PYTHONPATH=C:\Users\Asus\Desktop\secondroundSIH\native-host"
set PYTHONIOENCODING=utf-8
set PYTHONUNBUFFERED=1
"C:\Users\Asus\AppData\Local\Programs\Python\Python311\python.exe" -m voicc_host.main %*
