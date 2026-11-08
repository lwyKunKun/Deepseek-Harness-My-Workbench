#!/usr/bin/env node
// 迁移记忆.mjs —— 旧的「四个文件」结构 → 新的「一个项目信息.md + 一张身份卡」
//
// 旧：定位卡.md / 场景画像.md / 场景私有记忆.md / §〇 交接.md
// 新：项目信息.md（§〇 当前交接 / §一 场景清单 / §二 资产路径 / §五 资产索引 / §六 协作）
//     身份卡.md（我是谁 / 地盘 / 专属）
//
// ⛔ 幂等：已经迁移过的场景会跳过（除非 --force）。
// 用法：node dev/迁移记忆.mjs [--force]

import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../lib/config.mjs';
import * as mem from '../lib/memory.mjs';

const force = process.argv.includes('--force');
const scenes = mem.listScenes();
let changed = 0;

for (const sc of scenes) {
  const dir = mem.sceneDir(sc);
  // 旧文件可能已经被挪进 _旧/（上次迁移的备份）⇒ 两处都找
  const oldDir = path.join(dir, '_旧');
  const old = {
    handoff: path.join(dir, '§〇 交接.md'),
    card: path.join(dir, '定位卡.md'),
    portrait: path.join(dir, '场景画像.md'),
    private: path.join(dir, '场景私有记忆.md'),
  };
  for (const k of Object.keys(old)) {
    const backup = path.join(oldDir, path.basename(old[k]));
    if (!fs.existsSync(old[k]) && fs.existsSync(backup)) old[k] = backup;
  }
  const hasOld = Object.values(old).some((f) => fs.existsSync(f));
  if (!hasOld) continue;
  if (fs.existsSync(mem.mainPath(sc)) && !force) {
    console.log('  · ' + sc + '：已经是新结构，跳过（--force 可强制重迁）');
    continue;
  }

  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  // 去掉所有标题（§ 的结构已经给了标题）与引用行、空占位
  const strip = (t) => String(t || '')
    .replace(/^#{1,6}\s+.*$/gm, '')
    .replace(/^>\s.*$/gm, '')
    .replace(/^\s*[-*]?\s*（待写[^）]*）\s*$/gm, '')
    .replace(/^\s*[-*]?\s*TODO\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const main = [
    '# ' + sc + ' · 项目信息',
    '',
    '> 一个场景 = 一个记忆核心文件。开场先读 §〇，其余按需查。',
    '',
    '## §〇 当前交接',
    '',
    strip(read(old.handoff)) || '- 现在干到哪儿：（写具体事实）\n- 下一步：（下一件要做的事）',
    '',
    '## §一 场景清单',
    '',
    '### 这类活的形状',
    '',
    strip(read(old.portrait)) || '- 输入：\n- 输出：\n- 常见坑：',
    '',
    '### 面板',
    '',
    '- （这个场景有哪几个面板）',
    '',
    '## §二 资产路径',
    '',
    '- 项目根：' + path.relative(PATHS.root, dir),
    '- 入口：memory/' + sc + '/' + mem.MAIN_FILE,
    '',
    '## §五 资产索引',
    '',
    '### 踩过的坑（一行一条：症状 / 根因 / 怎么修）',
    '',
    strip(read(old.private)) || '（还没记）',
    '',
    '### 文件台账',
    '',
    '- ' + mem.MAIN_FILE + '（本文件）',
    '- ' + mem.CARD_FILE,
    '',
    '## §六 协作',
    '',
    '- 跟哪个场景搭界：（边界在哪）',
    '- 谁是对口人：（唯一对口）',
    '- 派单怎么发：见全局宪法「三 · 派单机制」',
    '',
  ].join('\n');
  fs.writeFileSync(mem.mainPath(sc), main, 'utf8');

  // 身份卡：直接沿用旧定位卡的内容（别再自己拼一遍「我是谁」，会重复）
  const card = [
    '# ' + sc + ' · 身份卡',
    '',
    '> 每场读的那张卡：我是谁、干什么、能碰什么。',
    '',
    '## 我是谁',
    strip(read(old.card)) || ('- 场景：' + sc + '\n- 职责：（待填）'),
    '',
    '## 我的地盘',
    '- 能写：memory/' + sc + '/',
    '- ⛔ 不写：别的场景的目录（那是别人的地盘，写了会污染对方的判断）',
    '',
    '## 我的专属',
    '- 技能：（这个场景专属的技能）',
    '- 记忆：memory/' + sc + '/' + mem.MAIN_FILE + '（§〇 开场读）',
    '',
  ].join('\n');
  fs.writeFileSync(mem.cardPath(sc), card.replace(/\n{3,}/g, '\n\n'), 'utf8');

  // 旧文件挪进 _旧/，不删（留着可回滚）；已经在 _旧/ 的不动
  fs.mkdirSync(oldDir, { recursive: true });
  for (const [k, f] of Object.entries(old)) {
    if (!fs.existsSync(f)) continue;
    const dest = path.join(oldDir, path.basename(f));
    if (dest === f) continue;
    fs.renameSync(f, dest);
  }
  changed++;
  console.log('  ✓ ' + sc + '：已迁移（旧文件挪进 _旧/）');
}

console.log('\n迁移了 ' + changed + ' 个场景。');
