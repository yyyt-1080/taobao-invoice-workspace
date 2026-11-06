@echo off
cd /d "%~dp0.."
if not exist node_modules (echo Run Setup.bat first.& pause & exit /b 1)
npm start
