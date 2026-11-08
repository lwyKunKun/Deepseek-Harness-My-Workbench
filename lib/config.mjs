// 配置与路径 —— 全部相对本工作台目录，不写死任何盘符
//
// 设计原则（来自原仓库的事故复盘）：
//   ① 程序目录要能整体替换 ⇒ 运行期数据一律放 data/，不放仓库根
//   ② 路径用 path.join 拼，绝不用反斜杠字面量
//   ③ 引擎地址、端口、记忆根都从环境变量兜底，换机器不用改代码

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = process.env.WB_ROOT
  ? path.resolve(process.env.WB_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PATHS = {
  root: ROOT,
  web: path.join(ROOT, 'web'),
  scenarios: path.join(ROOT, 'scenarios'),
  memory: path.join(ROOT, 'memory'),
  data: path.join(ROOT, 'data'),
  scripts: path.join(ROOT, 'scripts'),   // 面向人的命令行（保留但不是主入口）
  tools: path.join(ROOT, 'tools'),       // ★ 给 AI 用的工具（场景里的 AI 会调它们）
};

/** DSH 引擎（本地 HTTP 服务）。host/port 从 base 推导，别写死。 */
const ENGINE_BASE = (process.env.DSH_ENGINE_BASE || 'http://127.0.0.1:3080').replace(/\/+$/, '');
const ENGINE_URL = new URL(ENGINE_BASE);

export const ENGINE = {
  base: ENGINE_BASE,
  host: process.env.DSH_ENGINE_HOST || ENGINE_URL.hostname,
  port: Number(process.env.DSH_ENGINE_PORT || ENGINE_URL.port
    || (ENGINE_URL.protocol === 'https:' ? 443 : 80)),
};

/** 工作台自身的 HTTP 服务。 */
export const SERVER = {
  host: process.env.WB_HOST || '127.0.0.1',
  port: Number(process.env.WB_PORT || 3081),
};

/** 面板代理端口池：每个 AI 面板一个独立端口 ⇒ 独立 localStorage ⇒ 互不抢会话。 */
export const PANEL_PORT = {
  base: Number(process.env.WB_PANEL_PORT_BASE || 0), // 0 ⇒ 自动从 SERVER.port+1 起
  count: Number(process.env.WB_PANEL_PORTS || 6),
};

/** 记忆三层：定位卡 / 场景画像 / 场景私有记忆 + 项目记忆。 */
export const MEMORY_FILES = {
  card: '定位卡.md',
  profile: '场景画像.md',
  private: '场景私有记忆.md',
  index: '_文件索引.md',
  handoff: '§〇 交接.md',
};

/** 4KB 红线：单个记忆文件超过这个大小就该拆分了。 */
export const MEMORY_SOFT_LIMIT = 4 * 1024;

export function ensureDirs() {
  for (const dir of [PATHS.web, PATHS.scenarios, PATHS.memory, PATHS.data, PATHS.scripts, PATHS.tools]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}
