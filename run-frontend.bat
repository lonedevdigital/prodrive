@echo off
setlocal

if not exist "%~dp0.env" (
  echo [ERROR] Root .env tidak ditemukan.
  echo [INFO] Copy .env.example menjadi .env terlebih dahulu.
  exit /b 1
)

cd /d %~dp0frontend

if not exist node_modules (
  echo [INFO] Installing frontend dependencies...
  call npm install
)

npm run dev
