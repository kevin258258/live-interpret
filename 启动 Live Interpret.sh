#!/usr/bin/env bash
set -euo pipefail
task_project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  if command -v zenity >/dev/null 2>&1; then
    zenity --error --title="Live Interpret" --text="请先安装 Node.js 22 或更新版本，然后重新打开 Live Interpret。"
  fi
  exit 1
fi
exec node "$task_project_dir/scripts/launch.js"
