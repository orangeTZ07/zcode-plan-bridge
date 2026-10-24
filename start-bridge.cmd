@echo off
rem zcode-plan-bridge 启动器：把 ZCode Start Plan 额度暴露为本地 Anthropic API
rem 用法：双击运行，或被其他脚本以 `cmd /c start-bridge.cmd` 调起
rem 提示只走 stderr，stdout 留给服务日志
setlocal
set "HERE=%~dp0"
where node >nul 2>nul || (
  echo [start-bridge] 未找到 node，请先安装 Node.js 1>&2
  exit /b 1
)
echo [start-bridge] 启动 zcode-plan-bridge ... 1>&2
node "%HERE%bridge.mjs"
