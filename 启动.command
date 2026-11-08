#!/bin/bash
# 启动.command —— macOS 双击就能起（终端里也能跑）
#
# 它做三件事：
#   1. 找引擎（dsh 在 PATH 里就绪绪待命，没起就替你起一个）
#   2. 起工作台
#   3. 打开浏览器

cd "$(dirname "$0")" || exit 1

PORT="${WB_PORT:-3081}"
ENGINE_PORT="${DSH_ENGINE_PORT:-3080}"
ENGINE_BASE="http://127.0.0.1:${ENGINE_PORT}"

say() { printf '\033[36m%s\033[0m\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*"; exit 1; }

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

# ── 起工作台 ─────────────────────────────────────────────────
if curl -s -m 2 -o /dev/null "http://127.0.0.1:$PORT/api/state"; then
  say "✓ 工作台已在跑（http://127.0.0.1:$PORT）"
  open "http://127.0.0.1:$PORT"
  exit 0
fi

mkdir -p data
(node server.mjs > data/server.log 2>&1 &)
sleep 2
if curl -s -m 3 -o /dev/null "http://127.0.0.1:$PORT/api/state"; then
  say "✓ 工作台起来了：http://127.0.0.1:$PORT"
  open "http://127.0.0.1:$PORT"
else
  cat data/server.log
  die "工作台没起来，看上面的日志"
fi
