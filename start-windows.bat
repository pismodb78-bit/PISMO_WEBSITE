@echo off
chcp 65001 >nul
setlocal

rem Запуск сайта на Windows одним двойным щелчком.
rem
rem Visual Studio для этого не нужна — нужен только Node.js. Скрипт сам
rem доставит зависимости при первом запуске и соберёт фронтенд, если сборки
rem ещё нет, а дальше поднимет сервер, который отдаёт и API, и сам сайт.

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo   Node.js не найден.
    echo   Скачайте LTS-версию с https://nodejs.org и установите,
    echo   затем запустите этот файл снова.
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do set NODEVER=%%v
echo   Node.js %NODEVER%
echo.

if not exist "backend\node_modules" (
    echo   Ставлю зависимости бэкенда...
    call npm --prefix backend install --no-audit --no-fund || goto :fail
)

if not exist "frontend\node_modules" (
    echo   Ставлю зависимости фронтенда...
    call npm --prefix frontend install --no-audit --no-fund || goto :fail
)

if not exist "frontend\dist\index.html" (
    echo   Собираю сайт...
    call npm --prefix frontend run build || goto :fail
)

echo.
echo   Готово. Сайт: http://localhost:5000
echo   Остановить — Ctrl+C в этом окне.
echo.

call npm --prefix backend start
goto :eof

:fail
echo.
echo   Что-то пошло не так — смотрите сообщение выше.
pause
exit /b 1
