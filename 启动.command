#!/bin/bash
# 启动.command —— macOS 双击就能起（终端里也能跑）
#
# 工作台现在是 DSH 插件（@local/workbench），住在引擎进程里：
#   所以这里只需要把引擎起起来，然后打开 DSH 界面，
#   左边侧栏点「工作台」就是工作台本身。
#
# 想单独开一个页面（独立模式）再跑：node server.mjs

cd "$(dirname "$0")" || exit 1

ENGINE_PORT="${DSH_ENGINE_PORT:-3080}"
ENGINE_BASE="http://127.0.0.1:${ENGINE_PORT}"

say() { printf '\033[36m%s\033[0m\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*"; exit 1; }

mkdir -p data

# ── 引擎在不在 ───────────────────────────────────────────────
if curl -s -m 2 -o /dev/null "$ENGINE_BASE/"; then
  say "✓ 引擎已在 $ENGINE_BASE"
else
  say "引擎没在跑，尝试启动…"
  if command -v dsh >/dev/null 2>&1; then
    (dsh web --no-open --port "$ENGINE_PORT" > data/engine.log 2>&1 &)
    for i in $(seq 1 30); do
      sleep 1
      if curl -s -m 2 -o /dev/null "$ENGINE_BASE/"; then
        say "✓ 引擎起来了（日志：data/engine.log）"
        break
      fi
    done
  else
    die "PATH 里没有 dsh 命令。请先装 DSH 引擎，或自己起：dsh web --no-open --port $ENGINE_PORT"
  fi
fi

# ── 工作台插件在不在 ─────────────────────────────────────────
if curl -s -m 3 -o /dev/null "$ENGINE_BASE/workbench/api/state"; then
  say "✓ 工作台已挂在 $ENGINE_BASE/workbench"
  open "$ENGINE_BASE/"
  say "  左边侧栏点「工作台」就是它。"
  exit 0
fi

die "工作台插件没起来。检查：插件管理器里「我的工作台」是不是开着？（或在插件管理器里装一次这个目录）"
