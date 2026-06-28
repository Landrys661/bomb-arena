@echo off
REM ===== Bomb Arena - play online with friends =====
REM Double-click this file. It opens two windows:
REM   1) the game server   2) the Cloudflare tunnel (shows your shareable link)
cd /d "%~dp0"

echo Starting the game server...
start "Bomb Arena - SERVER (leave open)" cmd /k "npm start"

REM give the server a moment to boot
timeout /t 3 >nul

echo Starting the public tunnel...
start "Bomb Arena - LINK (leave open)" "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:3000 --no-autoupdate

echo.
echo ============================================================
echo  Two windows just opened. Look in the "LINK" window for a
echo  line like:  https://something-random.trycloudflare.com
echo  Open that link on your phone and send it to your friends.
echo.
echo  Keep BOTH windows open while playing. Close them to stop.
echo  (The link changes every time you run this.)
echo ============================================================
echo.
pause
