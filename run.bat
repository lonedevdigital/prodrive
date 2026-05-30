@echo off
setlocal

set ROOT_DIR=%~dp0
set BACKEND_DIR=%ROOT_DIR%backend
set FRONTEND_DIR=%ROOT_DIR%frontend

if not exist "%ROOT_DIR%.env" (
  echo [ERROR] Root .env tidak ditemukan.
  echo [INFO] Copy .env.example menjadi .env lalu isi kredensial R2.
  exit /b 1
)

if not exist "%BACKEND_DIR%\node_modules" (
  echo [INFO] Installing backend dependencies...
  call npm install --prefix "%BACKEND_DIR%"
)

if not exist "%FRONTEND_DIR%\node_modules" (
  echo [INFO] Installing frontend dependencies...
  call npm install --prefix "%FRONTEND_DIR%"
)

echo [INFO] Starting backend and frontend in separate terminal windows...
start "Drive Backend" cmd /k "cd /d %BACKEND_DIR% && npm run prisma:push && npm run dev"
start "Drive Frontend" cmd /k "cd /d %FRONTEND_DIR% && npm run dev"

echo [INFO] Both services launched.
echo Backend: http://localhost:4000
echo Frontend: http://localhost:5173
