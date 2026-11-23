// 操作留痕 —— 场景里发生的每一次操作都记一笔
//
// 为什么要有这块：
//   「我在「阅读」里到底干了什么？」这个问题以前没人能回答 ——
//     · 人在界面上的动作没留痕（点开哪本书、更新到第几页，一关页面就没了）
//     · AI 的动作只散在会话日志里，跟人的动作对不上时间线
//   这里把两边汇成**一条时间线**：谁（人/AI/系统）、做了什么、动了哪一样东西、结果如何。
//
// 判据只此一处：
//   append() 是唯一的写入口（只 append 一行 jsonl，不碰任何业务文件）
//   read()   是唯一的读入口
//
// 记在哪：data/acts/<场景id>.jsonl（data/ 是运行期数据，不进版本库）
// 导出到：memory/<场景id>/操作留痕.md（人看的那份）

import fs from 'node:fs';
import path from 'node:path';
import { PATHS, readJson } from './config.mjs';
import { indexSessions, readEvents } from './sessionlog.mjs';

export const LEDGER_DIR = path.join(PATHS.data, 'acts');

const ACTORS = new Set(['user', 'ai', 'system']);

/* ── 当地时间 ───────────────────────────────────────────────────────
 *
 * ⚠ 踩过的坑：台账里存的是 **ISO UTC**（`2026-11-17T09:09:07.930Z`）——
 *   跨时区排序不会错，但以前给人看时直接切字符串 `ts.slice(11,19)`，
 *   显示出来的是 **UTC**（本地 CST+8 就整整差 8 小时 ⇒ 「留痕的时间全是错的」）。
 *   现在：**存 UTC、显示本地**。凡是给人看的时间，一律走下面这两个函数。
 */

function pad2(n) { return String(n).padStart(2, '0'); }

/** 一条留痕的时刻（epoch ms；没有 at 就从 ts 解析）。 */
function instantOf(e) {
  const at = Number(e && e.at);
  if (at) return new Date(at);
  const t = Date.parse(String((e && e.ts) || ''));
  return isNaN(t) ? null : new Date(t);
}

/** 本地日期 'YYYY-MM-DD'。 */
export function localDay(e) {
  const d = instantOf(e);
  if (!d || isNaN(d.getTime())) return '';
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/** 本地时间 'HH:MM:SS'。 */
export function localTime(e) {
  const d = instantOf(e);
  if (!d || isNaN(d.getTime())) return '';
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

/** 本地日期时间 'YYYY-MM-DD HH:MM:SS'。 */
export function localStamp(e) {
  const day = localDay(e);
  const time = localTime(e);
  return day && time ? (day + ' ' + time) : '';
}

/** 场景 id → 台账文件（文件名只允许字母数字下划线短横，防目录穿越）。 */
export function ledgerFile(scene) {
  const s = String(scene || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown';
  return path.join(LEDGER_DIR, s + '.jsonl');
}

/** 统一字段（谁写进来的都得过这一遍，字段就永远一致）。 */
export function normalize(rec) {
  const now = Date.now();
  const at = Number(rec.at) || now;
  let ts = String(rec.ts || '').trim();
  if (!ts) {
    try { ts = new Date(at).toISOString(); } catch (e) { ts = ''; }
  }
  return {
    ts,
    at,
    scene: String(rec.scene || '').trim() || 'unknown',
    actor: ACTORS.has(rec.actor) ? rec.actor : 'user',
    action: String(rec.action || '').trim() || '操作',
    target: String(rec.target == null ? '' : rec.target).slice(0, 300),
    detail: rec.detail == null ? '' : rec.detail,
    result: rec.result === 'fail' ? 'fail' : 'ok',
  };
}

/**
 * 记一笔（唯一的写入口）。
 * 留痕失败**不许**拖垮正事 ⇒ 写文件出错只吞掉。
 */
export function append(rec) {
  const entry = normalize(rec);
  try {
    fs.mkdirSync(LEDGER_DIR, { recursive: true });
    fs.appendFileSync(ledgerFile(entry.scene), JSON.stringify(entry) + '\n', 'utf8');
  } catch (e) { /* 留痕失败不该让人看见错误 */ }
  return entry;
}

/** 一条留痕 ⇒ 加上给人看的本地时间字段（day / time）。 */
function withDisplay(e) {
  e.day = localDay(e);
  e.time = localTime(e);
  return e;
}

/** 读一个场景的台账（按时间正序；limit = 最近 N 条）。 */
export function read(scene, opts = {}) {
  const limit = Number(opts.limit) || 0;
  const file = ledgerFile(scene);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch (e) { continue; }   // 坏行跳过（不该因为一行坏账就丢整本）
    const e = normalize(r);
    // 给人看的两个字段（本地时间）—— 前端直接用，不用自己再切一遍 UTC 字符串
    out.push(withDisplay(e));
  }
  out.sort((a, b) => (a.at || 0) - (b.at || 0));
  return limit > 0 ? out.slice(-limit) : out;
}

/** 所有场景的台账（工作台那一页看全局用）。 */
export function readAll(opts = {}) {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(LEDGER_DIR); } catch (e) { return []; }
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const scene = f.slice(0, -6);
    for (const e of read(scene, opts)) out.push(e);
  }
  out.sort((a, b) => (a.at || 0) - (b.at || 0));
  return out;
}

/** 统计：总数 / 今天 / 按动作 / 按角色。 */
export function summarize(entries) {
  const todayKey = localDay({ at: Date.now() });      // ⚠ 本地日期（以前用 UTC 的 ⇒ 夜里 8 点前会算错天）
  const byAction = new Map();
  const byActor = { user: 0, ai: 0, system: 0 };
  let today = 0;
  let fail = 0;
  for (const e of entries || []) {
    if (localDay(e) === todayKey) today += 1;
    if (e.result === 'fail') fail += 1;
    byActor[e.actor] = (byActor[e.actor] || 0) + 1;
    byAction.set(e.action, (byAction.get(e.action) || 0) + 1);
  }
  return {
    total: (entries || []).length,
    today,
    fail,
    byActor,
    byAction: [...byAction.entries()].map(([action, n]) => ({ action, n }))
      .sort((a, b) => b.n - a.n),
  };
}

/** 一条留痕 ⇒ 人看的一行。 */
export function lineOf(e) {
  const who = e.actor === 'ai' ? 'AI' : (e.actor === 'system' ? '系统' : '人');
  const t = localTime(e) || String(e.ts || '').slice(11, 19);   // ⚠ 本地时间（不是 UTC）
  let detail = '';
  if (e.detail && typeof e.detail === 'object') {
    detail = Object.entries(e.detail).map(([k, v]) => `${k}=${v}`).join('　');
  } else if (e.detail) {
    detail = String(e.detail);
  }
  const target = e.target ? ` → ${e.target}` : '';
  return `- \`${t}\` **${who}** ${e.action}${target}${detail ? `　（${detail}）` : ''}${e.result === 'fail' ? '　❌失败' : ''}`;
}

/** 导成 Markdown（人看的那份）。 */
export function toMarkdown(scene, entries) {
  const s = summarize(entries);
  const head = [
    `# 操作留痕 · ${scene}`,
    '',
    `> 共 ${s.total} 条；今天 ${s.today} 条；失败 ${s.fail} 条。`,
    `> 由工作台自动记录（人的界面操作 + 服务端变更 + AI 会话动作）。`,
    `> 时间为**本地时间**（台账里存的是 UTC，显示时已换算）。`,
    '',
  ];
  // 跨天就插一个日期头（跟界面上的时间线一样）⇒ 光看 HH:MM:SS 不会认错天
  const body = [];
  let lastDay = '';
  for (const e of (entries || []).slice().reverse()) {
    const day = localDay(e);
    if (day && day !== lastDay) {
      lastDay = day;
      body.push('', `**${day}**`, '');
    }
    body.push(lineOf(e));
  }
  return head.concat(body.length ? body : ['（还没有记录）']).join('\n') + '\n';
}

/**
 * 把台账导出成 Markdown 文件（写进这个场景的记忆目录）。
 * 默认**连会话里的动作一起导出**（AI 的工具调用 + 人自己说的话）——
 * 那半边只存在于会话日志里，漏了就不是「所有操作」了。
 */
export function exportMarkdown(scene, opts = {}) {
  const entries = read(scene);
  const all = opts.withSession === false
    ? entries
    : entries.concat(sessionActions(scene)).sort((a, b) => (a.at || 0) - (b.at || 0));
  const dir = path.join(PATHS.memory, String(scene || 'unknown'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '操作留痕.md');
  fs.writeFileSync(file, toMarkdown(scene, all), 'utf8');
  return { path: file, count: all.length };
}

/* ── 会话里的动作（从会话日志读，只读） ──────────────────────────────
 *
 * 人在界面上的动作走 POST /api/actlog；
 * 但**在这个场景的常驻会话里**发生的事只存在于会话日志：
 *   · AI 的工具调用（bash / read / edit / write…）
 *   · 人自己在这个场景里说的话
 * 这里把它们读出来，并成同一条时间线。
 */

/** 消息正文（content 是 [{type:'text',text}]）。 */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (c && c.text ? String(c.text) : '')).join('\n').trim();
}

export function sceneSessionIds(scene) {
  const raw = readJson(path.join(PATHS.scenarios, String(scene || '') + '.json'), null);
  if (!raw) return [];
  const out = [];
  for (const p of raw.panels || []) {
    if (String(p.type) === 'harness' && p.sessionId) out.push(String(p.sessionId));
  }
  return out;
}

// 扫会话日志不便宜 ⇒ 短缓存（面板 12 秒刷一次，卡片视图还会再读一次）
// ⚠ 缓存挂在 globalThis 上：插件模式里这个模块每次请求都是新的一份（带时间戳 import），
//   挂在模块变量上等于没缓存。
const sessCache = globalThis.__WB_ACTLOG_SESSION_CACHE
  || (globalThis.__WB_ACTLOG_SESSION_CACHE = { key: '', at: 0, out: [] });

/** 这个场景的会话里发生过的动作（AI 的工具调用 + 人说的话）。 */
export function sessionActions(scene, opts = {}) {
  const dshHome = opts.dshHome || path.join(process.env.HOME || '', '.dsh');
  const ids = opts.sessionIds || sceneSessionIds(scene);
  if (!ids.length) return [];
  const key = ids.join('|');
  if (!opts.noCache && sessCache.key === key && Date.now() - sessCache.at < 5000) return sessCache.out;

  let index;
  try { index = indexSessions(dshHome); } catch (e) { return []; }
  const out = [];
  for (const id of ids) {
    const dir = index.get(id);
    if (!dir) continue;
    let events;
    try { events = readEvents(dir); } catch (e) { continue; }
    for (const ev of events) {
      const d = ev.data || {};
      if (ev.type === 'tool/call') {
        let args = {};
        try { args = JSON.parse(d.arguments || '{}'); } catch (e) { args = {}; }
        const tool = String(d.name || '调用');
        const target = args.file_path || args.path
          || (args.command ? String(args.command).slice(0, 120) : '');
        const detail = {};
        if (d.turn != null) detail['回合'] = d.turn;
        if (d.step != null) detail['步骤'] = d.step;
        out.push(withDisplay(normalize({
          ts: isoOf(ev.time), at: ev.time || Date.now(),
          scene, actor: 'ai', action: tool, target, detail,
        })));
        continue;
      }
      if (ev.type === 'user/message') {
        // ⚠ 只有**人自己发的那条**才算操作；系统注入的上下文不算
        if (!d.source || d.source.kind !== 'user') continue;
        const text = textOf(d.content);
        if (!text) continue;
        out.push(withDisplay(normalize({
          ts: isoOf(ev.time), at: ev.time || Date.now(),
          scene, actor: 'user', action: '在场景里说话',
          target: text.slice(0, 120),
          detail: { 字数: text.length },
        })));
      }
    }
  }
  out.sort((a, b) => (a.at || 0) - (b.at || 0));
  sessCache.key = key;
  sessCache.at = Date.now();
  sessCache.out = out;
  return out;
}

/** 旧名（只取 AI 的动作）—— 留着不影响。 */
export function aiActions(scene, opts = {}) {
  return sessionActions(scene, opts).filter((e) => e.actor === 'ai');
}

function isoOf(ms) {
  try { return new Date(Number(ms)).toISOString(); } catch (e) { return ''; }
}
