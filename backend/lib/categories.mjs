// 分类注册表 —— 分类的「定义 + 顺序」单独存一份
//
// 为什么单独存：
//   分类以前是从场景的 category 字段**派生**出来的 ⇒ 空分类（一个成员都没有）
//   存不下也看不见。有了这份注册表，分类就成了独立的东西：
//   · 可以先建一个空分类，再把角色拖进去
//   · 顺序写在这个文件里 ⇒ 能进版本库，换机器/清 data 也不丢
//
// 文件放 scenarios/_categories.json：
//   _ 前缀 ⇒ loadScenes() 会跳过它（它不是场景）。
//
// ⚠ 单独成文件还有一个缘故：插件热重载只给 server.mjs 加时间戳破缓存，
//   lib/ 下的模块走 Node 的模块缓存 —— 改这里的代码要重启 dsh web 才生效。

import path from 'node:path';
import { PATHS, readJson, writeJson } from './config.mjs';

const CATEGORIES_FILE = '_categories.json';

const file = () => path.join(PATHS.scenarios, CATEGORIES_FILE);

/** 注册表里的分类名（有序、去重）。文件不存在 = 空。 */
export function loadCategories() {
  const raw = readJson(file(), null);
  if (!raw || !Array.isArray(raw.categories)) return [];
  const out = [];
  raw.categories.forEach((c) => {
    const s = String(c || '').trim();
    if (s && out.indexOf(s) < 0) out.push(s);
  });
  return out;
}

/** 写注册表。 */
export function saveCategories(names) {
  const out = [];
  (names || []).forEach((c) => {
    const s = String(c || '').trim();
    if (s && out.indexOf(s) < 0) out.push(s);
  });
  writeJson(file(), { categories: out });
  return out;
}

/** 注册表 + 场景里出现过的分类（后者是兜底：手改过 json 也不会丢）。 */
export function allCategories(scenes) {
  const out = loadCategories();
  (scenes || []).forEach((s) => {
    const c = s.category || '未分类';
    if (out.indexOf(c) < 0) out.push(c);
  });
  return out;
}
