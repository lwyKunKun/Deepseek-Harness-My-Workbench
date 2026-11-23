#!/usr/bin/env node
// 还原场景.mjs —— 把删掉的角色放回去
//
// 删除场景时，记忆和配置会**移到回收站**（data/trash/<角色>-<时间戳>/），
// 不是真删。这个脚本把回收站里的某个角色拷回原位，并重新登记地盘表。
//
// 用法：
//   node dev/还原场景.mjs                     # 列出回收站里有什么
//   node dev/还原场景.mjs zztrash-20261108090152   # 还原这一个

import fs from 'node:fs';
import path from 'node:path';
import { registerScene } from '../lib/authority.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TRASH = path.join(ROOT, 'data', 'trash');

/* ── 回收站里有什么 ────────────────────────────────────────────── */
if (!fs.existsSync(TRASH)) {
  console.log('回收站是空的（data/trash/ 还不存在）');
  process.exit(0);
}
const items = fs.readdirSync(TRASH).filter((d) => fs.statSync(path.join(TRASH, d)).isDirectory()).sort();
if (!items.length) {
  console.log('回收站是空的');
  process.exit(0);
}
console.log('回收站（data/trash/）：');
for (const dir of items) {
  const cfg = path.join(TRASH, dir, 'scenarios');
  const files = fs.existsSync(cfg) ? fs.readdirSync(cfg) : [];
  const id = files[0] ? files[0].replace(/\.json$/, '') : dir;
  let name = id;
  try { name = JSON.parse(fs.readFileSync(path.join(cfg, files[0]), 'utf8')).name || id; } catch (e) { /* ignore */ }
  const memDir = path.join(TRASH, dir, 'memory', id);
  const count = fs.existsSync(memDir) ? fs.readdirSync(memDir, { recursive: true }).length : 0;
  console.log('  ' + dir + '   → ' + name + '（' + id + '）· ' + count + ' 个文件');
}

const want = process.argv[2];
if (!want) {
  console.log('');
  console.log('用法：node dev/还原场景.mjs <上面某个目录名>');
  process.exit(0);
}

/* ── 还原 ──────────────────────────────────────────────────────── */
const src = path.join(TRASH, want);
if (!fs.existsSync(src)) {
  console.error('回收站里没有：' + want);
  process.exit(1);
}
const cfgDir = path.join(src, 'scenarios');
const cfgFiles = fs.existsSync(cfgDir) ? fs.readdirSync(cfgDir) : [];
if (!cfgFiles.length) {
  console.error('这个回收站条目里没有场景配置，救不回来');
  process.exit(1);
}
const id = cfgFiles[0].replace(/\.json$/, '');
const target = path.join(ROOT, 'scenarios', id + '.json');
if (fs.existsSync(target)) {
  console.error('「' + id + '」已经在场景列表里了 —— 先处理掉同名的那一个');
  process.exit(1);
}

fs.mkdirSync(path.join(ROOT, 'scenarios'), { recursive: true });
fs.copyFileSync(path.join(cfgDir, cfgFiles[0]), target);
const srcMem = path.join(src, 'memory', id);
if (fs.existsSync(srcMem)) {
  fs.cpSync(srcMem, path.join(ROOT, 'memory', id), { recursive: true });
}
let name = id;
let duty = '';
try {
  const j = JSON.parse(fs.readFileSync(target, 'utf8'));
  name = j.name || id;
  duty = j.duty || j.description || '';
} catch (e) { /* ignore */ }
registerScene(id, { name, duty });

console.log('✓ 还原了「' + name + '」（' + id + '）');
console.log('  场景配置：scenarios/' + id + '.json');
console.log('  记忆目录：memory/' + id + '/');
console.log('  地盘表：已重新登记');
console.log('');
console.log('提示：常驻会话当时是**归档**状态（不是删除）⇒ 去 DSH 侧栏那条会话的「…」里取消归档即可。');
