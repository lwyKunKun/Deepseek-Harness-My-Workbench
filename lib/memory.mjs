// 场景记忆 —— 改成「一个项目信息.md + 一张身份卡」
//
// 为什么改（对齐视频里的做法）：
//   博主的核心问题是「**每次开场要读的量**」—— 他那个项目信息.md 已经 99.2K，
//   所以才需要 25K 红线 + 压缩 + 索引。
//   他的解法：**一个场景只有一个记忆核心文件**（项目信息.md），分节写：
//     §〇 当前交接   ← 开场必读，≤4K
//     §一 场景清单   ← 有几个场景/面板
//     §二 资产路径   ← 东西在哪
//     §五 资产索引   ← 文件多了时，AI 只看索引不全量读
//     §六 协作       ← 与别的场景怎么搭界
//   再加一张**身份卡**（每场读）和一份全局**宪法**（AGENTS）。
//
// ⛔ 红线（跟视频一致）：
//   §〇 区段 ≤ 4KB（阻断）　主文件 ≤ 25KB（告警）
//   —— 规矩文档（宪法/索引）不受这两条约束，它们是给「人」和「索引器」看的。

import fs from 'node:fs';
import path from 'node:path';
import { PATHS, MEMORY_SOFT_LIMIT } from './config.mjs';

export const MAIN_FILE = '项目信息.md';
export const CARD_FILE = '身份卡.md';
export const INDEX_FILE = '索引.md';
export const AGENTS_FILE = 'AGENTS.md';

export const SECTIONS = [
  { key: '§〇', name: '当前交接', hint: '开场先读这一节，≤4K' },
  { key: '§一', name: '场景清单', hint: '这个项目有几个场景 / 几个面板' },
  { key: '§二', name: '资产路径', hint: '东西在哪：目录、入口、脚本' },
  { key: '§五', name: '资产索引', hint: '文件多时 AI 只看索引，不全量读' },
  { key: '§六', name: '协作', hint: '跟别的场景怎么搭界、怎么派单' },
];

export function sceneDir(scene) {
  return path.join(PATHS.memory, String(scene));
}
export function mainPath(scene) {
  return path.join(sceneDir(scene), MAIN_FILE);
}
export function cardPath(scene) {
  return path.join(sceneDir(scene), CARD_FILE);
}
export function sharedPath(...p) {
  return path.join(PATHS.memory, '_共享记忆', ...p);
}

export function listScenes() {
  if (!fs.existsSync(PATHS.memory)) return [];
  return fs.readdirSync(PATHS.memory, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
    .map((e) => e.name)
    .sort();
}

/* ── 读 ───────────────────────────────────────────────────────── */

export function readMain(scene) {
  const f = mainPath(scene);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
}
export function readCard(scene) {
  const f = cardPath(scene);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
}

/** 按 § 拆节。 */
export function splitSections(text) {
  const out = {};
  let cur = null;
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^##\s*(§[〇一二三四五六七八九十]+)\s*(.*)$/);
    if (m) {
      cur = m[1];
      out[cur] = { title: m[2] || '', body: '' };
    } else if (cur) {
      out[cur].body += line + '\n';
    }
  }
  for (const k of Object.keys(out)) out[k].body = out[k].body.replace(/^\n+/, '').replace(/\n+$/, '');
  return out;
}

/** §〇 区段的字节数（红线判定用）。 */
export function sec0Bytes(text) {
  const s = splitSections(text)['§〇'];
  if (!s) return 0;
  return Buffer.byteLength(s.title + '\n' + s.body);
}

/** 这个场景的「开场要读的量」= §〇 + 身份卡。 */
export function openCost(scene) {
  return sec0Bytes(readMain(scene)) + Buffer.byteLength(readCard(scene));
}

/* ── 写 ───────────────────────────────────────────────────────── */

/** 写某一节（只替换该节，其余原样）。 */
export function writeSection(scene, sectionKey, body) {
  const text = readMain(scene);
  const secs = splitSections(text);
  const def = SECTIONS.find((s) => s.key === sectionKey) || { name: sectionKey };
  const title = '## ' + sectionKey + ' ' + def.name;
  const block = title + '\n\n' + String(body || '').trim() + '\n';

  if (secs[sectionKey]) {
    const lines = text.split('\n');
    let start = -1;
    let end = lines.length;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^##\s*(§[〇一二三四五六七八九十]+)\b/);
      if (!m) continue;
      if (m[1] === sectionKey) { start = i; continue; }
      if (start >= 0) { end = i; break; }
    }
    if (start >= 0) {
      const next = lines.slice(start, end).join('\n').replace(/^##\s*\S+\s*.*$/, '');
      const rebuilt = lines.slice(0, start).join('\n') + '\n' + block + '\n' + next + lines.slice(end).join('\n');
      fs.writeFileSync(mainPath(scene), rebuilt.replace(/\n{3,}/g, '\n\n'), 'utf8');
      return { ok: true };
    }
  }
  const sep = text.trim() ? '\n\n' : '';
  fs.writeFileSync(mainPath(scene), (text.trim() ? text.trimEnd() + sep : '') + block, 'utf8');
  return { ok: true };
}

/** 覆盖写 §〇（最常用：每次收工覆盖）。 */
export function writeHandoff(scene, body) {
  return writeSection(scene, '§〇', body);
}

/* ── 骨架 ─────────────────────────────────────────────────────── */

export function scaffold(scene, opts = {}) {
  const name = opts.name || scene;
  const duty = opts.duty || '（一句话：这个场景负责什么）';
  const dir = sceneDir(scene);
  fs.mkdirSync(dir, { recursive: true });

  const main = mainPath(scene);
  if (!fs.existsSync(main)) {
    fs.writeFileSync(main, [
      '# ' + name + ' · 项目信息',
      '',
      '> 一个场景 = 一个记忆核心文件。开场先读 §〇，其余按需查。',
      '',
      '## §〇 当前交接',
      '',
      '- 现在干到哪儿：（写具体事实，不写形容词）',
      '- 下一步：（下一件要做的事）',
      '- 卡点：（等谁 / 等什么）',
      '',
      '## §一 场景清单',
      '',
      '- 场景：' + name,
      '- 面板：（这个场景有几个面板，分别是什么）',
      '',
      '## §二 资产路径',
      '',
      '- 项目根：（这个项目的东西在哪）',
      '- 入口：（从哪进）',
      '',
      '## §五 资产索引',
      '',
      '- （文件多的时候列索引，AI 只看索引不全量读）',
      '',
      '## §六 协作',
      '',
      '- 跟哪个场景搭界：（边界在哪）',
      '- 谁是对口人：（唯一对口）',
      '',
    ].join('\n'), 'utf8');
  }

  const card = cardPath(scene);
  if (!fs.existsSync(card)) {
    fs.writeFileSync(card, [
      '# ' + name + ' · 身份卡',
      '',
      '> 每场读的那张卡：我是谁、干什么、能碰什么。',
      '',
      '## 我是谁',
      '- 场景：' + name,
      '- 职责：' + duty,
      '',
      '## 我的地盘',
      '- 能写：memory/' + scene + '/',
      '- ⛔ 不写：别的场景的目录',
      '',
      '## 我的专属',
      '- 技能：（这个场景专属的技能）',
      '- 记忆：memory/' + scene + '/' + MAIN_FILE + '（§〇 开场读）',
      '',
    ].join('\n'), 'utf8');
  }

  const idx = path.join(dir, '_文件索引.md');
  if (!fs.existsSync(idx)) {
    fs.writeFileSync(idx, '# ' + name + ' · 文件索引\n\n| 文件 | 状态 | 说明 |\n|---|---|---|\n', 'utf8');
  }
  return { ok: true, dir, main: mainPath(scene), card: cardPath(scene) };
}

/* ── 红线体检 ─────────────────────────────────────────────────── */

export function health(scene) {
  const main = readMain(scene);
  const bytes = Buffer.byteLength(main);
  const s0 = sec0Bytes(main);
  const problems = [];
  const warns = [];
  if (!main) problems.push('缺 ' + MAIN_FILE);
  if (s0 > MEMORY_SOFT_LIMIT) problems.push('§〇 ' + s0 + ' B 超 4 KB（红线 4096）');
  if (bytes > 25 * 1024) warns.push('主文件 ' + (bytes / 1024).toFixed(1) + ' KB 超 25 KB（红线）');
  if (!fs.existsSync(cardPath(scene))) problems.push('缺 ' + CARD_FILE);
  return { bytes, sec0: s0, problems, warns, ok: problems.length === 0 };
}

export function healthAll() {
  const out = [];
  for (const s of listScenes()) {
    const h = health(s);
    if (!h.ok || h.warns.length) out.push({ scene: s, ...h });
  }
  return out;
}
