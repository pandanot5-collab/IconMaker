@echo off
cd /d "%~dp0app"
if not exist node_modules call npm install
set ELECTRON_RUN_AS_NODE=
npx electron .
