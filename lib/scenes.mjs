// 场景配置 —— 一份 JSON 描述一个场景
//
// 场景 = 一块独立的界面（网格面板 + 一条常驻 AI 会话）。
// 文件名 = 场景 id（这是原仓库踩过的坑：改名就不出现）。
//
// 字段说明见 scenarios/*.json 的注释，或 README 的「场景配置格式」一节。

import fs from 'node:fs';
import path from 'node:path';
import { PATHS, readJson } from './config.mjs';
import { readCardProfile } from './memory.mjs';

const DEFAULTS = {
  layout: 'grid',
  theme: 'dark',
  cols: 4,
};

/** 面板坐标兜底：没写 col/row 就自动排。 */
function autoPlace(panel, index) {
  const p = { ...panel };
  if (!Number.isFinite(p.col)) p.col = (index % 4) + 1;
  if (!Number.isFinite(p.row)) p.row = Math.floor(index / 4) + 1;
  if (!Number.isFinite(p.w)) p.w = 1;
  if (!Number.isFinite(p.h)) p.h = 1;
  return p;
}

export function normalizeScene(raw, file = '') {
  const errors = [];
  const id = String(raw.id || path.basename(file, '.json') || '').trim();
  if (!id) errors.push('缺少 id');
  if (!/^[A-Za-z0-9_-]+$/.test(id)) errors.push(`id「${id}」只允许字母数字下划线短横（会用于面板分区名）`);

  const panels = Array.isArray(raw.panels) ? raw.panels : [];
  if (!panels.length) errors.push('没有任何面板');

  const seen = new Set();
  const normPanels = panels.map((rawPanel, i) => {
    const p = autoPlace(rawPanel || {}, i);
    p.id = String(p.id || `p${i + 1}`).replace(/[^A-Za-z0-9_-]/g, '') || `p${i + 1}`;
    if (seen.has(p.id)) errors.push(`面板 id 重复：${p.id}`);
    seen.add(p.id);
    p.type = String(p.type || 'reserved');
    p.title = String(p.title ?? p.sub ?? p.id);
    p.sub = String(p.sub ?? '');
    if (p.w < 1) p.w = 1;
    if (p.h < 1) p.h = 1;
    // 会话绑定三字段
    if (p.sessionId != null) p.sessionId = String(p.sessionId).trim();
    if (p.sessionTitle != null) p.sessionTitle = String(p.sessionTitle).trim();
    if (p.pinTarget != null) {
      p.pinTarget = (Array.isArray(p.pinTarget) ? p.pinTarget : [p.pinTarget])
        .map((t) => String(t).trim())
        .filter(Boolean);
    } else {
      p.pinTarget = [];
    }
    return p;
  });

  // 列数：至少能放下最右边的面板
  const cols = Math.max(
    Number(raw.cols) || DEFAULTS.cols,
    ...normPanels.map((p) => (Number(p.col) || 0) + (Number(p.w) || 1) - 1),
    1,
  );

  return {
    id,
    name: String(raw.name ?? raw.title ?? id),
    description: String(raw.description ?? ''),
    // 卡片字段（首页卡片目录用）
    icon: String(raw.icon ?? '●'),
    category: String(raw.category ?? '其它'),
    duty: String(raw.duty ?? raw.description ?? ''),
    skills: Array.isArray(raw.skills) ? raw.skills.map(String) : [],
    // ★ 项目目录：这个角色挂在**真实磁盘上的一个文件夹**（公司项目/代码库）。
    //   绑了它 ⇒ 这个角色的 AI 会话就在那儿干活（cwd = 它），文件面板也能浏览它。
    projectRoot: String(raw.projectRoot ?? '').trim(),
    // ★ 仓库里要挂哪几个面板（如「书架」「概念卡」「运动记录」）
    vaultDirs: Array.isArray(raw.vaultDirs) ? raw.vaultDirs : [],
    layout: raw.layout ?? DEFAULTS.layout,
    theme: raw.theme ?? DEFAULTS.theme,
    cols,
    first: !!raw.first,
    panels: normPanels,
    errors,
  };
}

export function loadScenes() {
  const dir = PATHS.scenarios;
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith('.json')) continue;
    if (file.startsWith('_')) continue; // _ 前缀 = 模板，不进场景列表
    const full = path.join(dir, file);
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (e) {
      out.push({ id: path.basename(file, '.json'), name: file, panels: [], errors: [`JSON 解析失败：${e.message}`] });
      continue;
    }
    out.push(withCardProfile(normalizeScene(raw, file)));
  }
  // first:true 固定最前，其余按名字排序
  out.sort((a, b) => (b.first ? 1 : 0) - (a.first ? 1 : 0) || a.name.localeCompare(b.name, 'zh'));
  return applySavedOrder(out);
}

/**
 * 职责与技能**以身份卡为准**，json 里那份降级成兜底。
 *
 * 为什么：身份卡是每场 AI 开场必读的那张卡，它写着「职责」「技能」；
 * 而 `scenarios/<id>.json` 里又抄了一份 duty / skills ⇒ 两份数据各写各的，
 * 改了身份卡，界面上的职责行和技能标签纹丝不动。
 *
 * 放在 loadScenes() 里（而不是 HTTP 层）⇒ 界面、注册页名单、派单、体检
 * 看到的是同一份，不会出现「界面改了、派单还是旧的」。
 */
function withCardProfile(scene) {
  if (!scene || !scene.id) return scene;
  const card = readCardProfile(scene.id);
  if (card.duty) scene.duty = card.duty;
  if (card.skills.length) scene.skills = card.skills;
  return scene;
}

/** 标签栏拖拽换位后的顺序（data/scene-order.json）覆盖默认顺序。 */
function applySavedOrder(scenes) {
  const saved = readJson(path.join(PATHS.data, 'scene-order.json'), null);
  if (!saved || !Array.isArray(saved.ids) || !saved.ids.length) return scenes;
  const rank = new Map(saved.ids.map((id, i) => [String(id), i]));
  const known = new Set(scenes.map((s) => s.id));
  // 已删掉的场景丢掉，新场景追加在后
  const kept = saved.ids.filter((id) => known.has(String(id)));
  const rest = scenes.filter((s) => !rank.has(s.id));
  const byId = new Map(scenes.map((s) => [s.id, s]));
  const ordered = kept.map((id) => byId.get(String(id)));
  return ordered.concat(rest);
}

export function getScene(id) {
  return loadScenes().find((s) => s.id === id) || null;
}

/**
 * 按 id **或名字**找场景。
 * 派单里人说的是场景名（「调研」），场景 json 里是 id（`research`）——
 * 两个都得认，否则派单发不出去。
 */
export function resolveScene(nameOrId) {
  const key = String(nameOrId || '').trim();
  if (!key) return null;
  const all = loadScenes();
  const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
  return all.find((s) => s.id === key)
    || all.find((s) => norm(s.name) === norm(key))
    || all.find((s) => norm(s.title) === norm(key))
    || null;
}
