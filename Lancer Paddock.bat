@echo off
cd /d "%~dp0"
start "" http://localhost:8132
node serve.mjs
