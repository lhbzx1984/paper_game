@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo [PaperQuest] Python was not found. Install Python 3.10+ and enable "Add python.exe to PATH".
  pause
  exit /b 1
)

python -c "import sys; raise SystemExit(0 if sys.version_info >= (3,10) else 1)" >nul 2>nul
if errorlevel 1 (
  echo [PaperQuest] Python 3.10 or newer is required.
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo [PaperQuest] Creating virtual environment...
  python -m venv .venv
  if errorlevel 1 goto :fail
  ".venv\Scripts\python.exe" -m pip install --upgrade pip --quiet
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt --quiet
  if errorlevel 1 goto :fail
) else (
  if not exist ".venv\.deps-ok" (
    echo [PaperQuest] Installing dependencies...
    ".venv\Scripts\python.exe" -m pip install -r requirements.txt --quiet
    if errorlevel 1 goto :fail
  )
)
echo ok> ".venv\.deps-ok"

if not exist ".env" if exist ".env.example" copy /Y ".env.example" ".env" >nul

echo.
echo [PaperQuest] Starting at http://127.0.0.1:5173
echo [PaperQuest] Press Ctrl+C to stop.
echo.
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:5173'"
".venv\Scripts\python.exe" app.py
if errorlevel 1 (
  echo.
  echo [PaperQuest] Server stopped with an error. If port 5173 is already in use, close the other instance.
)
pause
exit /b 0

:fail
echo.
echo [PaperQuest] Setup failed. Check your network / Python installation and try again.
pause
exit /b 1
