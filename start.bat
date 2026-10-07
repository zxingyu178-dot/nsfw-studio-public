@echo off
chcp 65001 >nul
title NSFW Studio
rem 复用 ComfyUI 的虚拟环境（含 requests 等依赖）
set "PY=D:\AIHome_2.0_L1_L2\projects\comfyui\venv\Scripts\python.exe"
if not exist "%PY%" (
  echo 未找到 ComfyUI 虚拟环境：%PY%
  echo 请确认 ComfyUI 已安装。
  pause
  exit /b 1
)
"%PY%" "%~dp0server.py"
echo.
echo 服务已停止。
pause
