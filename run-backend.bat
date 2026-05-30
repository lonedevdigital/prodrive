@echo off
setlocal

if not exist "%~dp0.env" (
  echo [ERROR] Root .env tidak ditemukan.
  echo [INFO] Copy .env.example menjadi .env lalu isi konfigurasi MySQL + R2.
  exit /b 1
)

cd /d %~dp0backend

if not exist node_modules (
  echo [INFO] Installing backend dependencies...
  call npm install
)

npm run prisma:push && npm run dev
