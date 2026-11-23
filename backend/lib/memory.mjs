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
  { key: '§三', name: '台账', hint: '自动派生：按真实数据算出来的账（只读）' },
  { key: '§五', name: '资产索引', hint: '文件多时 AI 只看索引，不全量读' },
  { key: '§六', name: '协作', hint: '跟别的场景怎么搭界、怎么派单' },
];

/** 节标题行。⚠ 千万别加 \b：「§〇」不是 ASCII 词字符，\b 在它后面不成立
 *  （以前就因为这个，writeSection 一次都匹配不到 §〇 ⇒ 每次保存都往文件末尾
 *    追加一节新的 ⇒ §〇 变成两段，只有最后一段算数）。 */
const SEC_LINE = /^##\s*(§[〇一二三四五六七八九十]+)(?:\s+(.*))?$/;

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

/* ── 身份卡里的「职责」与「技能」 ────────────────────────────────────
 *
 * 为什么要有这个：
 *   身份卡是**每场 AI 开场必读的那张卡**（「我是谁、干什么、能碰什么」），
 *   里面的「职责」「技能」本来就该是这两个信息的**唯一出处**。
 *   可 `scenarios/<id>.json` 里又抄了一份 duty / skills ⇒ 两份数据各写各的，
 *   改了身份卡，界面上的职责行和技能标签纹丝不动。
 *
 *   所以：**身份卡说了算，json 兜底**（卡里没写或是占位符时才用 json）。
 *
 * 卡里的两行长这样（`- **职责**：xxx`、半角冒号也都认）：
 *   - 职责：前端开发
 *   - 技能：前端 / Vue / TypeScript / 代码评审 / 性能优化
 */

/** 占位值 = 「还没写」⇒ 当没写，走 json 兜底。
 *  （`TODO`、`（这个场景专属的技能）`、`（一句话：…）` 这些都是模板留下的坑位。） */
function isPlaceholder(v) {
  const s = String(v || '').trim();
  if (!s) return true;
  if (/^todo$/i.test(s)) return true;
  // 整段被括号包起来的提示语（模板占位），比如「（一句话：这个场景负责什么）」
  if (/^（[^）]*）$/.test(s) || /^\([^)]*\)$/.test(s)) return true;
  return false;
}

/** 从一行 `- 键：值` 里取值（兼容加粗、半角冒号）。 */
function pickField(text, key) {
  const re = new RegExp('^\\s*[-*]\\s*\\**\\s*' + key + '\\s*\\**\\s*[:：]\\s*(.+)$', 'm');
  const m = String(text || '').match(re);
  if (!m) return '';
  return m[1].trim();
}

/** 技能串 ⇒ 数组。分隔符认 `/`、`、`、`,`。 */
function splitSkills(v) {
  return String(v || '')
    .split(/[/、,]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/* 解析结果按「文件 mtime + 大小」缓存 ——
 *   loadScenes() 调用频繁，不能每次都读盘；文件没动就直接用上次的。 */
const cardProfileCache = new Map();

export function readCardProfile(scene) {
  const key = String(scene || '');
  const file = cardPath(key);
  let st = null;
  try { st = fs.statSync(file); } catch (e) { st = null; }
  if (!st) {
    cardProfileCache.delete(key);
    return { duty: '', skills: [] };
  }
  const hit = cardProfileCache.get(key);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.profile;

  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { text = ''; }

  const dutyRaw = pickField(text, '职责');
  const skillsRaw = pickField(text, '技能');
  const profile = {
    duty: isPlaceholder(dutyRaw) ? '' : dutyRaw,
    skills: isPlaceholder(skillsRaw) ? [] : splitSkills(skillsRaw),
  };
  cardProfileCache.set(key, { mtimeMs: st.mtimeMs, size: st.size, profile });
  return profile;
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

/* ── 自动区（派生块） ──────────────────────────────────────────────
 *
 * 「自动区」= 一段**按真实数据算出来**的内容，夹在标记里：
 *
 *     <!-- 自动:reading.summary:start -->
 *     - 正在读：《不被大风吹倒》39/255 页（15%）
 *     <!-- 自动:reading.summary:end -->
 *
 * 规矩：
 *   · 自动区的内容**只有派生器能写**。人在面板里改不了：前端把它渲染成只读块，
 *     服务端写节时也用磁盘上的原自动区覆盖回提交内容里的同名块。
 *   · 自动区永远待在它那一节的**顶部**（§〇 的摘要在最上面 ⇒ 开场先读先看见）。
 *   · 手写内容不受影响，自动区只占位、不吞字。
 */

const AUTO_RE = '<!--\\s*自动:([A-Za-z0-9_.\\-]+):start\\s*-->([\\s\\S]*?)<!--\\s*自动:\\1:end\\s*-->';

/** 文件里所有的自动区（按出现顺序）。 */
export function parseAuto(text) {
  const out = [];
  const re = new RegExp(AUTO_RE, 'g');
  let m;
  while ((m = re.exec(String(text || '')))) {
    out.push({ key: m[1], content: String(m[2] || '').replace(/^\n+/, '').replace(/\s+$/, '') });
  }
  return out;
}

/** 拆成「自动区们 + 手写内容」。 */
export function splitAuto(text) {
  const src = String(text || '');
  const blocks = parseAuto(src);
  const manual = src.replace(new RegExp(AUTO_RE, 'g'), '').replace(/\n{3,}/g, '\n\n').trim();
  return { blocks, manual };
}

/** 去掉所有自动区，只留手写内容。 */
export function stripAuto(text) {
  return splitAuto(text).manual;
}

/** 一个自动区的文本（标记 + 内容）。 */
export function autoBlock(key, content) {
  return '<!-- 自动:' + key + ':start -->\n' + String(content || '').trim() + '\n<!-- 自动:' + key + ':end -->';
}

/** 自动区们 + 手写内容 ⇒ 节正文（自动区一律排在手写内容前面）。 */
function buildBody(blocks, manual) {
  const auto = blocks.map((b) => autoBlock(b.key, b.content)).join('\n\n');
  const hand = String(manual || '').trim();
  if (auto && hand) return auto + '\n\n' + hand;
  return auto || hand;
}

/**
 * 手写内容 + 磁盘上原有的自动区 ⇒ 合并后的节正文。
 * 提交内容里带的自动区**一律忽略**（前端只交手写部分；交带了也不认）。
 */
export function mergeAuto(origBody, newBody) {
  const blocks = parseAuto(origBody);
  const hand = stripAuto(newBody);
  return buildBody(blocks, hand);
}

/* ── 写 ───────────────────────────────────────────────────────── */

/** 某一节在行里的范围。⚠ 找**最后**一段同名节（前面的重复段是死字）。 */
function findSectionRange(lines, sectionKey) {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(SEC_LINE);
    if (m && m[1] === sectionKey) start = i;
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].match(SEC_LINE)) { end = i; break; }
  }
  return { start, end };
}

/** 某一节的手写正文（不含标题行、也不含自动区）。 */
export function sectionHandBody(scene, sectionKey) {
  const lines = readMain(scene).split('\n');
  const r = findSectionRange(lines, sectionKey);
  if (!r) return '';
  return stripAuto(lines.slice(r.start + 1, r.end).join('\n'));
}

/**
 * 写某一节（只替换该节，其余原样）。
 * @param {boolean} opts.raw  true = 原样写入（派生器自己管自动区）；默认 = 保留原自动区
 */
export function writeSection(scene, sectionKey, body, opts = {}) {
  const text = readMain(scene);
  const def = { name: String(opts.name || '').trim() || (SECTIONS.find((s) => s.key === sectionKey) || {}).name || sectionKey };
  // ⚠ 一节的正文里**不能有别的节标题** —— 粘进来一个「## §一」会造出第二段 §一，
  //   而「只有最后一段算数」⇒ 前面那段直接变成死字（还把体检的红线判成重复）。
  const incoming = String(body || '').split('\n')
    .filter((l) => !SEC_LINE.test(l))
    .join('\n').trim();
  const finalBody = opts.raw
    ? incoming
    : mergeAuto(sectionRawBody(text, sectionKey), incoming);
  const block = '## ' + sectionKey + ' ' + def.name + '\n\n' + finalBody + '\n';

  const lines = text.split('\n');
  const range = findSectionRange(lines, sectionKey);
  if (range) {
    const head = lines.slice(0, range.start);
    const tail = lines.slice(range.end);
    const rebuilt = head.join('\n').replace(/\n+$/, '') + '\n\n' + block + '\n' + tail.join('\n');
    fs.writeFileSync(mainPath(scene), rebuilt.replace(/\n{3,}/g, '\n\n'), 'utf8');
    return { ok: true, created: false };
  }
  const sep = text.trim() ? '\n\n' : '';
  fs.writeFileSync(mainPath(scene), (text.trim() ? text.trimEnd() + sep : '') + block, 'utf8');
  return { ok: true, created: true };
}

/** 某一节的原始正文（含自动区，不含标题行）。 */
function sectionRawBody(text, sectionKey) {
  const lines = String(text || '').split('\n');
  const r = findSectionRange(lines, sectionKey);
  if (!r) return '';
  return lines.slice(r.start + 1, r.end).join('\n');
}

/**
 * 确保某节存在（不存在就建一个空的，插在 opts.before 那一节之前）。
 * 找不到 before 就追加到文件末尾。
 */
export function ensureSection(scene, sectionKey, opts = {}) {
  const text = readMain(scene);
  const lines = text.split('\n');
  if (findSectionRange(lines, sectionKey)) return { ok: true, created: false };

  const def = { name: String(opts.name || '').trim() || (SECTIONS.find((s) => s.key === sectionKey) || {}).name || sectionKey };
  const block = ('## ' + sectionKey + ' ' + def.name).trimEnd();

  const before = String(opts.before || '').trim();
  let at = lines.length;
  if (before) {
    const r = findSectionRange(lines, before);
    if (r) at = r.start;
  }
  const head = lines.slice(0, at);
  const tail = lines.slice(at);
  while (head.length && !head[head.length - 1].trim()) head.pop();
  while (tail.length && !tail[0].trim()) tail.shift();
  const parts = [];
  if (head.length) parts.push(head.join('\n'));
  parts.push(block);
  if (tail.length) parts.push(tail.join('\n'));
  fs.writeFileSync(mainPath(scene), parts.join('\n\n') + '\n', 'utf8');
  return { ok: true, created: true };
}

/**
 * 写某一节里的自动区（自动区永远在节顶部；手写内容原样保留）。
 * 内容没变 ⇒ 什么都不写（免得每次刷新都动文件）。
 * @param {string} key 自动区的 key，如 'reading.summary'
 */
export function setAuto(scene, sectionKey, key, content, opts = {}) {
  const body = String(content || '').trim();
  const text = readMain(scene);
  if (!findSectionRange(text.split('\n'), sectionKey)) {
    ensureSection(scene, sectionKey, { before: opts.before || '§五', name: opts.name });
  }
  const raw = sectionRawBody(readMain(scene), sectionKey);
  const { blocks, manual } = splitAuto(raw);
  const hit = blocks.find((b) => b.key === key);
  if (hit && hit.content === body) return { ok: true, changed: false };

  const next = hit
    ? blocks.map((b) => (b.key === key ? { key, content: body } : b))
    : blocks.concat([{ key, content: body }]);
  writeSection(scene, sectionKey, buildBody(next, manual), { raw: true, name: opts.name });
  return { ok: true, changed: true };
}

/** 覆盖写 §〇（最常用：每次收工覆盖）。 */
export function writeHandoff(scene, body) {
  return writeSection(scene, '§〇', body);
}

/* ── 骨架 ─────────────────────────────────────────────────────── */

export function scaffold(scene, opts = {}) {
  const name = opts.name || scene;
  const duty = opts.duty || '（一句话：这个场景负责什么）';
  // ⚠ 技能也要写进卡 —— 卡的「职责」「技能」是这两个信息的**唯一出处**
  //   （界面上的职责行和技能标签就是从这儿派生的），留占位符的话新角色
  //   得靠 json 兜底，卡跟界面就对不上了。
  const skills = Array.isArray(opts.skills) ? opts.skills.filter(Boolean) : [];
  const skillsLine = skills.length ? skills.join(' / ') : '（这个场景专属的技能）';
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
      '- 能写：backend/memory/' + scene + '/',
      '- ⛔ 不写：别的场景的目录',
      '',
      '## 我的专属',
      '- 技能：' + skillsLine,
      '- 记忆：backend/memory/' + scene + '/' + MAIN_FILE + '（§〇 开场读）',
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
  // ⚠ §〇 出现两遍 ⇒ 只有**最后**一段算数，前面那段是死字（面板也不显示它）。
  //   常见于「有人在文件末尾手写了一段 §〇」。修法：node dev/去重交接.mjs
  //   ⚠ 别用 \b：§〇 不是 ASCII 词字符，\b 在它后面不成立（会一个都匹配不到）。
  const dup0 = (main.match(/^##\s*§〇(?![〇一二三四五六七八九十])/gm) || []).length;
  if (dup0 > 1) problems.push('§〇 有 ' + dup0 + ' 段（重复，只有最后一段算数）');
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
