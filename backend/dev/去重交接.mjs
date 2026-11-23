#!/usr/bin/env node
// 去重交接.mjs —— 修「项目信息.md 里有两段 §〇 当前交接」
//
// 症状：文件里出现两个 `## §〇 当前交接` 段（常见于「有人在文件末尾手写了一段 §〇」）。
// 根因：§〇 是靠 `## §〇` 这行标题认出来的；同一个标题出现两次，
//       `lib/memory.mjs` 的 splitSections / writeSection 都只认**最后一段**
//       ⇒ 前面那段成了死字（面板不显示、AI 读到的也是后面那段）。
//
// 修法：只留**一段** §〇，放在文件最前面（开场先读的位置），内容取「最有信息量的那段」
//       （占位符多的那段让位）；其余段落原样保留、顺序不动。
//
// 用法：
//   node dev/去重交接.mjs            # 只查不动（报告哪些文件有重复）
//   node dev/去重交接.mjs --apply    # 真改（原文件先备份到 data/去重备份/）
//   node dev/去重交接.mjs --apply --scene reading   # 只处理某个场景
//
// ⚠ 只动这个场景自己的 memory/<场景>/项目信息.md，不碰别的场景的记忆。

import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../lib/config.mjs';

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const APPLY = has('--apply');
const ONLY = val('--scene', '');
const BACKUP_DIR = path.join(PATHS.data, '去重备份');

/** 占位符行：括号里是「写具体事实 / 待写 / 写清楚… / 等谁」这类空话 ⇒ 不算信息量。 */
const PLACEHOLDER_RE = /（[^）]*(写具体事实|待写|写清楚|没有就写|等谁|等什么|具体事实)[^）]*）/;
const HEAD_RE = /^##\s*(§[〇一二三四五六七八九十]+)\s*(.*)$/;

/** 一段正文的「信息量」= 去掉括号空话后剩下的字数（占位行记 0）。 */
function score(body) {
  let n = 0;
  for (const line of String(body || '').split('\n')) {
    if (!line.trim()) continue;
    if (PLACEHOLDER_RE.test(line)) continue;
    const clean = line.replace(/（[^）]*）/g, '').replace(/^[-*]\s*/, '').trim();
    n += clean.length;
  }
  return n;
}

/** 把文件拆成：前言 + 若干原始块（块 = 一整节，含标题行）。 */
function splitBlocks(text) {
  const lines = String(text || '').split('\n');
  const blocks = [];
  let pre = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(HEAD_RE);
    if (m) {
      if (cur) blocks.push(cur);
      cur = { key: m[1], title: m[2] || '', lines: [line] };
    } else if (cur) {
      cur.lines.push(line);
    } else {
      pre.push(line);
    }
  }
  if (cur) blocks.push(cur);
  return { pre, blocks };
}

const bodyOf = (b) => b.lines.slice(1).join('\n');

function dedupe(text) {
  const { pre, blocks } = splitBlocks(text);
  const zeros = blocks.filter((b) => b.key === '§〇');
  if (zeros.length <= 1) return { changed: false, text };

  // 选信息量最大的那段（并列时取靠前的那段）
  let best = zeros[0];
  for (const b of zeros) if (score(bodyOf(b)) > score(bodyOf(best))) best = b;

  const kept = [];
  let placed = false;
  for (const b of blocks) {
    if (b.key === '§〇') {
      if (placed) continue;           // 其余 §〇 段全丢
      kept.push(best);                // 用最好的那段，放在第一次出现的位置
      placed = true;
      continue;
    }
    kept.push(b);
  }
  const out = pre.join('\n').replace(/\n+$/, '') + '\n\n'
    + kept.map((b) => b.lines.join('\n').replace(/\n+$/, '')).join('\n\n') + '\n';
  return { changed: true, text: out, dropped: zeros.length - 1, keptScore: score(bodyOf(best)) };
}

/* ── 跑 ─────────────────────────────────────────────────────────── */

const dirs = fs.existsSync(PATHS.memory) ? fs.readdirSync(PATHS.memory) : [];
let touched = 0;
for (const scene of dirs) {
  if (scene.startsWith('_')) continue;   // _共享记忆 不动
  if (ONLY && scene !== ONLY) continue;
  const file = path.join(PATHS.memory, scene, '项目信息.md');
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  const r = dedupe(text);
  if (!r.changed) {
    console.log('  · ' + scene + '：§〇 只有一段，不用动');
    continue;
  }
  touched++;
  console.log('  ✓ ' + scene + '：§〇 有 ' + (r.dropped + 1) + ' 段 ⇒ 留信息量最大的那段（' + r.keptScore + ' 分），丢 ' + r.dropped + ' 段');
  if (!APPLY) { console.log('      （只是报告；要真改加 --apply）'); continue; }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const bak = path.join(BACKUP_DIR, scene + '-项目信息-' + stamp + '.md');
  fs.writeFileSync(bak, text, 'utf8');
  fs.writeFileSync(file, r.text, 'utf8');
  console.log('      备份：' + path.relative(PATHS.root, bak));
}
console.log('');
console.log(APPLY ? ('处理完：' + touched + ' 个场景（备份在 ' + path.relative(PATHS.root, BACKUP_DIR) + '/）') : ('查出 ' + touched + ' 个场景有重复 §〇' + (APPLY ? '' : '（加 --apply 才真改）')));
