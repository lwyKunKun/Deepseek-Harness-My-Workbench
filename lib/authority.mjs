// 修改权分档 —— ★ 判据只写在这一处
//
// A 共享·宪法        全局铁律 / 规范 / 协作规则        只有规则负责人能改
// C 共享·工具与运行时  工具目录 / 插件 / MCP / 技能目录   只有规则负责人能改；别人只能提请求
// B 共享·板与台账     待办板 / 通知看板 / 总索引 / 台账   各场景按规矩写自己那些行
// D 自己的专属        自己的场景配置 / 定位卡 / 记忆      自己改
// E 别人的专属        别人的场景、别人的记忆             ⛔ 一个字都不许写，只能提请求
//
// 判定问句链（原文）：
//   这东西是「规矩/工具」还是「内容」？
//     ├─ 规矩/工具 → 会影响到别人吗？
//     │     ├─ 会  → A 或 C（⛔ 我不能改，只能提请求）
//     │     └─ 不会（只我自己用）→ D
//     └─ 内容 → 是我的还是别人的？
//           ├─ 我的 → D
//           └─ 别人的 → E（⛔ 只许写请求）
//
// ⛔ 这不是文档约定，是**机械闸**：派单提示词带边界 + 越界审计扫会话日志。
//   「活干完了但规矩没人守」= 规矩不存在。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { PATHS } from './config.mjs';

export const TIERS = {
  A: {
    label: 'A 共享·宪法',
    scope: '全局铁律 / 规范 / 协作规则',
    who: '只有规则负责人能改；别人只能提请求',
    breach: '规矩互相打架，每个场景记的都不一样',
  },
  C: {
    label: 'C 共享·工具与运行时',
    scope: '工具目录 / 插件 / MCP / 技能目录 / 计划任务 / 索引（机器自动生成）',
    who: '只有规则负责人能改；别人只能提请求',
    breach: '一个人改了工具，其他人全部静默失效',
  },
  B: {
    label: 'B 共享·板与台账',
    scope: '待办板 / 通知看板 / 回执目录 / 文档台账',
    who: '各场景按规矩写自己那些行',
    breach: '删了别人的行 = 别人的活凭空消失',
  },
  D: {
    label: 'D 自己的专属',
    scope: '自己的场景配置 / 身份卡 / 记忆 / 自己的技能',
    who: '自己改',
    breach: '改「自己的规矩」没告知负责人 ⇒ 规矩悄悄分叉',
  },
  E: {
    label: 'E 别人的专属',
    scope: '别人的场景、别人的记忆',
    who: '⛔ 一个字都不许写，只能提请求',
    breach: '直接污染对方的判断（真实事故：两个场景互写记忆，一周后互相引用错误结论）',
  },
};

export const TERRITORY_FILE = path.join(PATHS.root, 'territory.json');

export function loadTerritory() {
  try {
    return JSON.parse(fs.readFileSync(TERRITORY_FILE, 'utf8'));
  } catch (e) {
    return { version: 0, ruleOwner: '', rules: [], toolPaths: [], boardPaths: [], scenes: {}, assets: {}, soleResponsibility: [] };
  }
}

/** 存回地盘表（原子写：先写临时文件再改名，免得中途断电写坏规矩）。 */
export function saveTerritory(t) {
  const tmp = TERRITORY_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(t, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, TERRITORY_FILE);
  return true;
}

/**
 * 把一个场景登记进地盘表（新增或更新）。
 *
 * ⚠ 为什么必须登记：新角色不登记 ⇒ 它的 `memory/<id>/` 算「未登记」
 *   ⇒ 按规则是 C 档（工具与运行时）⇒ **它连自己的记忆都写不了**
 *   （实测：注册完角色后写身份卡被闸拦下，就是这个原因）。
 *
 * 所以「注册一个新角色」必须同时动两处：场景配置 + 地盘表。
 */
export function registerScene(id, info = {}) {
  const t = loadTerritory();
  const sceneId = String(id || '').trim();
  if (!sceneId) return { ok: false, error: '要场景 id' };
  t.scenes = t.scenes || {};
  t.assets = t.assets || {};
  const old = t.scenes[sceneId] || {};
  const others = Object.keys(t.scenes).filter((k) => k !== sceneId).map((k) => 'memory/' + k + '/');
  const base = (old.territory && old.territory.length)
    ? old.territory.slice()
    : ['scenarios/' + sceneId + '.json', 'memory/' + sceneId + '/', 'skills/' + sceneId + '/'];
  // ★ 项目目录：这个角色在**真实磁盘上的地盘**（绝对路径）——
  //   绑了就归它，别人碰它就是越界（E 档）；解绑就把这条摘掉。
  //   （绝对路径的条目 = 项目目录；相对路径的 = 工作台内的地盘。）
  const projectRoot = Object.prototype.hasOwnProperty.call(info, 'projectRoot')
    ? String(info.projectRoot || '').trim()      // 显式给了就照办（空串 = 解绑）
    : String(old.projectRoot || '').trim();
  const kept = base.filter((p) => !path.isAbsolute(p));
  if (projectRoot) kept.push(path.resolve(projectRoot));
  t.scenes[sceneId] = {
    name: info.name || old.name || sceneId,
    territory: kept,
    notTouch: others.length ? others : old.notTouch || [],
    writeBack: old.writeBack || ('memory/' + sceneId + '/项目信息.md 的 §〇'),
    duty: info.duty || old.duty || '',
    ...(projectRoot ? { projectRoot } : {}),
  };
  t.assets['scenarios/' + sceneId + '.json'] = sceneId;
  saveTerritory(t);
  return { ok: true, scene: t.scenes[sceneId] };
}

/**
 * 所有角色绑定的**真实项目目录**（绝对路径）。
 *
 * 这些目录在工作台之外，但它们是某个角色自己的地盘 ——
 * 该角色能进（读写），别的角色不许进（E 档越界）。
 * 文件浏览与受闸写接口都要看这份清单。
 */
export function projectRoots() {
  const t = loadTerritory();
  const out = [];
  for (const s of Object.values(t.scenes || {})) {
    const abs = String(s.projectRoot || '').trim();
    if (abs) out.push(path.resolve(abs));
  }
  return out;
}

/**
 * 把一个场景从地盘表里**摘掉**（删角色时用）。
 * 只摘这个场景自己的条目；别的不动。
 */
export function unregisterScene(id) {
  const t = loadTerritory();
  const sceneId = String(id || '').trim();
  if (!sceneId) return { ok: false, error: '要场景 id' };
  let removed = false;
  if (t.scenes && t.scenes[sceneId]) { delete t.scenes[sceneId]; removed = true; }
  if (t.assets) {
    for (const [asset, owner] of Object.entries(t.assets)) {
      if (owner === sceneId) { delete t.assets[asset]; removed = true; }
    }
  }
  if (removed) saveTerritory(t);
  return { ok: true, removed };
}

function relOf(absOrRel) {
  const p = String(absOrRel || '');
  if (path.isAbsolute(p)) {
    const r = path.relative(PATHS.root, p);
    return r.startsWith('..') ? p : r.split(path.sep).join('/');
  }
  return p.split(path.sep).join('/');
}

/** 这条路径归哪个场景？（D/E 的分界） */
export function ownerOf(rel) {
  const t = loadTerritory();
  const r = relOf(rel);
  for (const [id, s] of Object.entries(t.scenes || {})) {
    for (const p of s.territory || []) {
      if (p.endsWith('/')) { if (r.startsWith(p)) return id; }
      else if (r === p || r.startsWith(p + '/')) return id;
    }
  }
  if (t.assets && t.assets[r]) return t.assets[r];
  return null;
}

/**
 * ★ 判据：路径 + 身份 ⇒ 档 + 能不能改。
 * @param {string} target 路径（相对或绝对）
 * @param {string} asScene 动手的人是谁（场景 id 或名字）
 */
export function check(target, asScene, opts = {}) {
  const t = loadTerritory();
  const rel = relOf(target);
  const sceneId = resolveSceneId(asScene);
  const me = sceneId || String(asScene || '');

  const base = { path: rel, asScene: me, tier: null, allowed: false, why: '', request: null };

  // ① A 档：规则文件
  if ((t.rules || []).includes(rel)) {
    const owner = t.ruleOwner;
    const ok = me === resolveSceneId(owner);
    return {
      ...base,
      tier: 'A',
      owner,
      allowed: ok,
      why: ok
        ? '你是规则负责人 ⇒ 这份规矩归你改（改完记得同步给其他场景）'
        : '这是「' + TIERS.A.label + '」，归「' + owner + '」管。你不能直接改，只能提请求。',
      request: ok ? null : requestHint(owner, rel),
    };
  }

  // ② B 档：板与台账（比 C 档更具体，先判）
  if ((t.boardPaths || []).some((p) => rel === p || rel.startsWith(p))) {
    const v = checkBoardRow(rel, me, opts);
    return {
      ...base,
      tier: 'B',
      owner: '(共享板)',
      allowed: v.ok,
      why: v.why,
      request: v.ok ? null : requestHint('规则负责人（' + t.ruleOwner + '）', rel),
    };
  }

  // ③ C 档：工具与运行时
  if ((t.toolPaths || []).some((p) => rel === p || rel.startsWith(p))) {
    const owner = t.ruleOwner;
    const ok = me === resolveSceneId(owner);
    return {
      ...base,
      tier: 'C',
      owner,
      allowed: ok,
      why: ok
        ? '你是规则负责人 ⇒ 工具与运行时归你改（⚠ 改了会影响所有人，一次只留一个写入者）'
        : '这是「' + TIERS.C.label + '」，归「' + owner + '」管。⛔ 你不能直接改，只能提请求。',
      request: ok ? null : requestHint(owner, rel),
    };
  }

  // ④ D / E：按场景归属
  const owner = ownerOf(rel);
  if (!owner) {
    return {
      ...base,
      tier: 'C',
      owner: '(未登记)',
      allowed: false,
      why: '这个路径没登记在任何场景的地盘里 ⇒ 按「工具与运行时」处理：⛔ 不要动，要改先提请求。',
      request: requestHint('规则负责人（' + t.ruleOwner + '）', rel),
    };
  }
  const ownerId = resolveSceneId(owner);
  if (ownerId === me) {
    return {
      ...base,
      tier: 'D',
      owner,
      allowed: true,
      why: '这是你自己的地盘 ⇒ 随便改。干完记进「' + (t.scenes[ownerId] && t.scenes[ownerId].writeBack || '自己的 §〇 交接') + '」。',
      request: null,
    };
  }
  return {
    ...base,
    tier: 'E',
    owner,
    allowed: false,
    why: '这是「' + owner + '」的地盘 ⇒ ⛔ 一个字都不许写。直接改会污染对方的判断。只能提请求。',
    request: requestHint(owner, rel),
  };
}

/** 提请求的模板（原文：写清「现象 + 该谁做 + 怎么做 + 做完怎么验」） */
export function requestHint(who, rel) {
  return {
    to: who,
    topic: '请求改动 ' + rel,
    symptom: '现在是什么样子（可观察的，不要形容词）',
    how: '照哪份文档的哪一节做（唯一出处）',
    verify: '做完跑哪个检查、看到什么算通过',
    reply: '我在等你的回执（结论+证据+落盘路径）',
    note: '请求 = 一次派单。到「派单台」面板填四件套发出去。',
  };
}

/** 台账在不在。 */
function ledgerExists() {
  try { return fs.existsSync(path.join(PATHS.data, 'dispatch-ledger.jsonl')); } catch (e) { return false; }
}

/** 从台账里找一条线（回执归属用）。 */
function findLedgerLine(hash) {
  try {
    const file = path.join(PATHS.data, 'dispatch-ledger.jsonl');
    if (!fs.existsSync(file)) return null;
    const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch (e) { return null; }
    }).filter(Boolean);
    return rows.filter((r) => r.hash === hash).pop() || null;
  } catch (e) {
    return null;
  }
}

/** B 档：只许写自己那些行。 */
function checkBoardRow(rel, me, opts) {
  const content = String(opts.content || '');
  const oldString = String(opts.oldString || '');

  // ① 回执目录：**谁派的单，谁写回执** —— 这条可以精确判定，不用猜
  if (rel.indexOf('memory/_共享记忆/_回执/') === 0) {
    const hash = rel.split('/').pop().replace(/\.md$/, '');
    const line = findLedgerLine(hash);
    if (!line) {
      // ⚠ 台账里查不到这条线 ⇒ **无法判定**（可能台账被清过/轮转过），不是越界。
      //   造一条不存在的回执也没用：发单方按编号在台账里查，一样查不到。
      return {
        ok: true,
        warn: true,
        why: '台账里查不到编号「' + hash + '」⇒ 无法判定这条回执该谁写（不算越界，留个警告）',
      };
    }
    const expect = resolveSceneId(line.to);
    if (expect && expect !== me) {
      return {
        ok: false,
        why: '这条回执是派给「' + line.to + '」的 ⇒ ⛔ 只许写自己那条线的回执。',
      };
    }
    return { ok: true, why: '回执目录：这条是派给你的单（' + (line.from || '?') + ' → ' + (line.to || '?') + '）⇒ 回执归你写 ✓' };
  }
  // ② 待办板 / 通知看板：**行归属判定**（跟文件里的现状比，才准）
  //
  //   ⚠ 关键区分：拿别人的行当「锚点」来追加自己那行（编辑工具最常见的写法）
  //     **不算越界** —— 别人的行原封不动还在。
  //     真正越界的是两种：① 把你不拥有的行改掉/删了；② 冒充别人写一条新行。
  const rowAuthor = (row) => {
    // 通知看板：- [时间] 发起方 → 接收方：内容
    const m = row.match(/^\s*-\s*\[[^\]]*\]\s*([^→]+?)\s*→/);
    if (m) {
      const id = resolveSceneId(m[1].trim());
      if (id) return { from: m[1].trim(), id };
    }
    // 待办板：- [ ] 内容 @归属
    const at = row.match(/@\s*(\S+)\s*$/);
    if (at) {
      const id = resolveSceneId(at[1]);
      if (id) return { from: at[1].trim(), id };
    }
    return null;
  };
  const rowsOf = (text) => String(text || '').split('\n').filter((l) => /^\s*-\s*\[/.test(l));

  // 板文件当前的样子
  let fileRows = [];
  try {
    const abs = path.join(PATHS.root, rel);
    if (fs.existsSync(abs)) fileRows = rowsOf(fs.readFileSync(abs, 'utf8'));
  } catch (e) { /* 读不到就当空 */ }

  // ① 你写了一条**不属于你**的行，而且文件里原本没有 ⇒ 冒充
  for (const row of rowsOf(content)) {
    const who = rowAuthor(row);
    if (!who || who.id === me) continue;
    if (!fileRows.some((r) => r.trim() === row.trim())) {
      return { ok: false, why: '你在写一条属于「' + who.from + '」的行 ⇒ ⛔ 只许写自己那些行（别人的行被删 = 别人的活凭空消失）。' };
    }
  }

  // ② 你把**别人那行**改掉或删了（原样还在就不算）
  for (const row of rowsOf(oldString)) {
    const who = rowAuthor(row);
    if (!who || who.id === me) continue;
    const kept = rowsOf(content).some((l) => l.trim() === row.trim());
    if (!kept) {
      return { ok: false, why: '这次改动把「' + who.from + '」的那行改掉或删了 ⇒ ⛔ 只许写自己那些行。' };
    }
  }
  return { ok: true, why: '共享板：你只许写自己那些行 —— 这次没碰别人的行 ✓' };
}

/** 场景 id / 名字互换 */
export function resolveSceneId(nameOrId) {
  const key = String(nameOrId || '').trim();
  if (!key) return '';
  const t = loadTerritory();
  if (t.scenes && t.scenes[key]) return key;
  const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
  for (const [id, s] of Object.entries(t.scenes || {})) {
    if (norm(s.name) === norm(key)) return id;
  }
  return key;
}

/** 唯一对口：这个活该谁做 */
export function soleResponsibility(topic) {
  const t = loadTerritory();
  const key = String(topic || '').trim();
  for (const r of t.soleResponsibility || []) {
    if (key.includes(r.topic) || r.topic.includes(key)) return r;
  }
  return null;
}

/* ── 越界审计：扫会话日志，看谁动了谁的地盘 ─────────────────────── */

const WRITE_TOOLS = new Set(['write', 'edit', 'apply_patch', 'patch']);

/** 命令里所有「像路径」的词。 */
export function pathLikeTokens(text) {
  const s = String(text || '');
  const out = new Set();
  const quoted = s.match(/["']([^"'\n]{2,200})["']/g) || [];
  for (const q of quoted) {
    const v = q.slice(1, -1);
    if (/[\w一-龥]/.test(v) && /[./一-龥]/.test(v) && !/\s/.test(v)) out.add(v);
  }
  const bare = s.match(/[A-Za-z0-9_./一-龥-]*[./][A-Za-z0-9_./一-龥-]+/g) || [];
  for (const b of bare) {
    // 只要有斜杠的（像路径），或带已知扩展名的完整文件名；排除 `.mjs` / `(` 这种碎片
    if (!b.includes('/') && !/\.[A-Za-z][A-Za-z0-9]{1,4}$/.test(b)) continue;
    out.add(b);
  }
  return [...out];
}

// ⚠ 白名单，不能用「凡是 *Sync 都算」—— readFileSync 是**读**，算成写就满屏假警报
const WRITE_API_NAMES = [
  'writeFileSync', 'appendFileSync', 'createWriteStream', 'unlinkSync', 'rmSync',
  'renameSync', 'copyFileSync', 'mkdirSync', 'rmdirSync', 'truncateSync',
  'chmodSync', 'utimesSync', 'symlinkSync', 'linkSync', 'openSync',
];
// ⚠ 要的是「**被调用**」（后面跟左括号），不是「被提到」。
//   `grep -rn "unlinkSync" lib/` 只是提到了它 —— 那是读。
const WRITE_API_RE = new RegExp('\\b(' + WRITE_API_NAMES.join('|') + ')\\s*\\(');

/** 把引号里的内容遮成空格（长度不变）。 */
function maskQuoted(s) {
  const chars = s.split('');
  let inS = false;
  let inD = false;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === '\\') { i++; continue; }
    if (c === "'" && !inD) { inS = !inS; chars[i] = ' '; continue; }
    if (c === '"' && !inS) { inD = !inD; chars[i] = ' '; continue; }
    if (inS || inD) chars[i] = ' ';
  }
  return chars.join('');
}

/**
 * ★ 这条命令**写了哪些路径**（读不算）。
 *
 * ⛔ 为什么必须分读写：会话日志里 bash 只记命令文本，
 *   `tail -1 memory/other/x.md` 是读，`node -e fs.appendFileSync(...)` 是写 ——
 *   不分就会把「看一眼别人的记忆」也报成越界，满屏噪音，机制就废了。
 */
export function writeTargetsOf(cmd) {
  const s = String(cmd || '');
  const out = new Set();

  // ⚠★ 引号里的内容**不是命令**。
  //   `grep -rn "unlink|rm(" lib/ server.mjs` 里那个 `rm(` 是搜索词，不是 rm 命令 ——
  //   不先把引号内容遮住，满屏假警报。
  //   遮罩保持长度不变，所以位置还能对回原文取路径。
  const masked = maskQuoted(s);

  // ① 重定向：> >> &> 2>（⚠ `=>` 箭头函数不算）
  for (const m of masked.matchAll(/(?<![=>\-<>])>{1,2}[ \t]*/g)) {
    const tail = s.slice(m.index + m[0].length);
    const t = tail.match(/^("([^"]*)"|'([^']*)'|[^\s;|&<>]+)/);
    if (!t) continue;
    const v = t[2] ?? t[3] ?? t[1];
    if (v && /^[\w一-龥./-]+$/.test(v)) out.add(v);
  }

  // ② 命令动词：cp/mv 的**目标是最后一个参数**；rm/mkdir/touch/… 全是目标
  const verbs = ['cp', 'mv', 'rm', 'rmdir', 'touch', 'mkdir', 'ln', 'tee', 'truncate', 'patch', 'install'];
  for (const v of verbs) {
    for (const m of masked.matchAll(new RegExp('(^|[;|&\\n]\\s*)\\b' + v + '\\b([^;|&\\n]*)', 'g'))) {
      const raw = s.slice(m.index + m[0].length - (m[2] || '').length, m.index + m[0].length);
      const toks = (raw || '').match(/("([^"]*)"|'([^']*)'|[^\s]+)/g) || [];
      const vals = toks.map((t) => t.replace(/^["']|["']$/g, '')).filter((t) => t && !/^-/.test(t));
      const targets = (v === 'cp' || v === 'mv' || v === 'install') ? vals.slice(-1) : vals;
      for (const t of targets) if (/^[\w一-龥./-]+$/.test(t)) out.add(t);
    }
  }

  // ③ 就地编辑：sed -i / perl -i
  for (const m of masked.matchAll(/\b(sed|perl)\s+(-[a-zA-Z]*i[a-zA-Z]*)\b([^;|&\\n]*)/g)) {
    const raw = s.slice(m.index + m[0].length - (m[3] || '').length, m.index + m[0].length);
    const toks = (raw || '').match(/("([^"]*)"|'([^']*)'|[^\s]+)/g) || [];
    for (const t of toks) {
      const p = t.replace(/^["']|["']$/g, '');
      // 跳过 sed 表达式本身（s/a/b/），那不是路径
      if (p && !/^-/.test(p) && !/^[sy]\//.test(p) && /^[\w一-龥./-]+$/.test(p)) out.add(p);
    }
  }

  // 路径碎片过滤：只认「像路径」的词
  const looksLikePath = (t) => {
    if (!t || /[()<>|;&*]/.test(t)) return false;
    if (t.startsWith('/')) return true;                                  // 绝对路径
    if (/^(memory|scenarios|lib|web|scripts|data|skills)\//.test(t)) return true;  // 已知目录
    if (/^[\w一-龥-]+\.[A-Za-z][A-Za-z0-9]{1,4}$/.test(t)) return true; // 文件名
    return false;
  };

  // ④ 写 API：优先抓调用里的第一个参数（那才是被写的文件）
  let apiHit = false;
  for (const m of s.matchAll(new RegExp('\\b(' + WRITE_API_NAMES.join('|') + ')\\s*\\(\\s*("([^"]*)"|\'([^\']*)\')', 'g'))) {
    apiHit = true;
    const v = m[3] ?? m[4];
    if (v && looksLikePath(v)) out.add(v);
  }
  // ⚠ 兜底只在「内联脚本」时用（node -e / python -c）。
  //   否则 `grep -rn "unlinkSync" lib/` 这种**提到**写 API 的读命令会被当成写 ——
  //   那正是越界审计最大的假警报来源。
  const inlineScript = /\b(node\s+(-e|--eval)|python3?\s+-c|bun\s+-e|deno\s+eval)\b/.test(s);
  if (WRITE_API_RE.test(s) && !apiHit && inlineScript) {
    for (const p of pathLikeTokens(s)) out.add(p);
  }

  // ⑤ python 写模式
  if (/open\s*\([^)]*['"][wa]['"]/.test(s) || /\.write\s*\(/.test(s)) {
    for (const p of pathLikeTokens(s)) out.add(p);
  }

  return [...out];
}

/** 从一段命令/参数里抠出「提到过哪些路径」（不判读写）。 */
export function extractPaths(text, root) {
  const out = new Set();
  const s = String(text || '');
  const abs = s.match(new RegExp((root ? root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '') + '[\\/][^"\'\\s;|&)<>]+', 'g')) || [];
  for (const p of abs) out.add(p);
  const rel = s.match(/[\w./一-龥-]*\b(?:memory|scenarios|lib|web|scripts|data|skills)[\w./一-龥-]*/g) || [];
  for (const p of rel) {
    if (p.length > 2 && !/^(memory|scenarios|lib|web|scripts|data|skills)$/.test(p)) out.add(p);
  }
  return [...out];
}

/**
 * 审计：某个会话（属于某场景）动了哪些路径，哪些越界。
 * @param {object} opts
 * @param {Array}  opts.sessions [{sessionId, scene}]
 * @param {string} opts.dshHome 引擎数据目录
 */
export function audit(opts = {}) {
  const t = loadTerritory();
  const dshHome = opts.dshHome || path.join(process.env.HOME || '', '.dsh');
  const sessionsRoot = path.join(dshHome, 'sessions');
  const violations = [];
  const warnings = [];
  const touches = [];

  if (!fs.existsSync(sessionsRoot)) return { violations, touches, scanned: 0, note: '找不到引擎会话目录' };

  // 建 sessionId → 目录 的索引
  const index = new Map();
  for (const proj of fs.readdirSync(sessionsRoot)) {
    const pdir = path.join(sessionsRoot, proj);
    let st;
    try { st = fs.statSync(pdir); } catch (e) { continue; }
    if (!st.isDirectory()) continue;
    for (const s of fs.readdirSync(pdir)) {
      index.set(s, path.join(pdir, s));
    }
  }

  let scanned = 0;
  for (const s of opts.sessions || []) {
    const dir = index.get(s.sessionId);
    if (!dir) continue;
    const file = fs.readdirSync(dir).find((f) => f.endsWith('.zstd'));
    if (!file) continue;
    let text;
    try {
      text = zlib.zstdDecompressSync(fs.readFileSync(path.join(dir, file))).toString('utf8');
    } catch (e) { continue; }
    scanned++;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch (e) { continue; }
      if (ev.type !== 'tool/call') continue;
      const d = ev.data || {};
      const tool = String(d.name || '');
      let paths = [];
      let content = '';
      let oldString = '';
      if (WRITE_TOOLS.has(tool)) {
        let args = {};
        try { args = JSON.parse(d.arguments || '{}'); } catch (e) { args = {}; }
        paths = args.file_path ? [args.file_path] : [];
        // ⚠ write 用 content；edit 用 new_string（拿错字段会把「锚点」误判成删行）
        content = String(args.new_string || args.content || '');
        oldString = String(args.old_string || args.oldString || '');
      } else if (tool === 'bash') {
        let args = {};
        try { args = JSON.parse(d.arguments || '{}'); } catch (e) { args = {}; }
        const cmd = String(args.command || '');
        paths = writeTargetsOf(cmd);   // ★ 只算「写了」，读不算
        content = cmd;
      } else {
        continue;
      }
      for (const p of paths) {
        if (path.isAbsolute(String(p)) && !String(p).startsWith(PATHS.root + path.sep)) continue;  // 工作台之外（/dev/null 等）
        const rel = relOf(p);
        if (!rel || rel.startsWith('..')) continue;
        if (rel.endsWith('/')) continue;              // 目录本身不算一次改动
        try { if (fs.statSync(path.join(PATHS.root, rel)).isDirectory()) continue; } catch (e) { /* 文件 */ }
        const v = check(rel, s.scene, { content, oldString });
        touches.push({ scene: s.scene, sessionId: s.sessionId, tool, path: rel, tier: v.tier, allowed: v.allowed });
        if (v.allowed && v.warn) {
          warnings.push({ scene: s.scene, path: rel, tier: v.tier, why: v.why });
        }
        if (!v.allowed) {
          violations.push({
            scene: s.scene,
            sessionId: s.sessionId,
            tool,
            path: rel,
            tier: v.tier,
            owner: v.owner,
            why: v.why,
            at: ev.seq,
          });
        }
      }
    }
  }
  return { violations, warnings, touches, scanned, ruleOwner: t.ruleOwner };
}
