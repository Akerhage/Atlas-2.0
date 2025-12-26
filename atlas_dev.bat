@echo off
setlocal EnableDelayedExpansion
chcp 65001 > nul

echo ===================================================
echo ATLAS HYBRID - STARTAR...
echo ===================================================

REM 1. Rensa gamla processer (viktigt)
taskkill /F /IM ngrok.exe >nul 2>&1
for %%p in (3000 3001) do (
    for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":%%p" ^| findstr "LISTENING"') do (
        taskkill /F /PID %%a >nul 2>&1
    )
)

REM 2. Ngrok licens
set "MY_TOKEN=374S7ccKVQLuh7RH8SqveSlguvP_4nuVFPvM17eSjQJZsq5ac"
ngrok config add-authtoken %MY_TOKEN% >nul 2>&1

REM 3. Starta Ngrok (Här använder vi START för att den inte ska blockera)
echo 🌐 Startar Ngrok...
start "Atlas_Ngrok" /min cmd /c "ngrok http --domain=uncongestive-roberta-unsurely.ngrok-free.dev 3001"

echo ⏳ Väntar på tunnel (6 sekunder)...
timeout /t 6 /nobreak > nul

REM 4. Starta Electron (Utan start för att bat-filen ska vänta här)
echo 🚀 Startar Atlas...
node .\\node_modules\\electron\\cli.js .

REM 5. Hit kommer vi när Atlas stängs
echo 🛑 Atlas stängt - Städar upp...
taskkill /F /IM ngrok.exe >nul 2>&1

echo ✅ Klart.
timeout /t 2 > nul
exit