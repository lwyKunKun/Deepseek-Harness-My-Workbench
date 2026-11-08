// 写痕与撞车检测 —— 「同一文件两个写入者」这条失效模式的抓手
//
// 原仓库的事故复盘原文：
//   「两个会话改同一个文件，改动神秘消失」
//     根因：没有「同一文件两个写入者」约束
//     修法：**写盘前重读**、**写完自证别人的改动还在**；**同路径的活只留一个写入者**
//
// 怎么做到「写完自证别人的改动还在」：
//   会话日志里 write 工具带**完整内容**，edit 带 old→new（能重放），
//   所以每个文件在每个时刻的内容都能重建 ⇒
//   后一次写的内容里，如果**前一个场景写的行不见了**，那就是「改动神秘消失」被逮到了。
//
// 两个数据源：
//   ① 会话日志（AI 自己用 write/edit 工具写的）
//   ② data/writes.jsonl（经受闸写接口写的）
//
// ⛔ 判据只此一处：analyzeWrites() 是纯函数，来源不同但判定完全一样。

import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './config.mjs';
import { indexSessions, readEvents, toolCalls, writeCalls, applyCall } from './sessionlog.mjs';
import { resolveSceneId } from './authority.mjs';

/** 行指纹（内容哈希，忽略首尾空白与空行）。 */
export function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8);
}

export function lineHashes(text) {
  const set = new Set();
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    set.add(hash(t));
  }
  return set;
}

/** 后一次写的内容里，前一次写的哪些行不见了。 */
export function detectLost(beforeContent, afterContent) {
  const before = lineHashes(beforeContent);
  const after = lineHashes(afterContent);
  const lost = [];
  for (const h of before) if (!after.has(h)) lost.push(h);
  return lost;
}

/** 还原「消失的那几行」的原文（给人看）。 */
export function lostSamples(beforeContent, afterContent, limit = 3) {
  const after = lineHashes(afterContent);
  const out = [];
  for (const line of String(beforeContent || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (!after.has(hash(t))) out.push(t.slice(0, 90));
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * ★ 核心判定（纯函数）：给一串写入记录 ⇒ 找出撞车。
 *
 * @param {Array} writes [{path, scene, sceneName, time, seq, content, tool, source}]
 *   content = 这次写完之后的**完整内容**（推不出来就 null）
 * @returns {{files:Array, collisions:Array}}
 */
export function analyzeWrites(writes) {
  const byPath = new Map();
  const collisions = [];

  const sorted = writes.slice().sort((a, b) => (a.time || 0) - (b.time || 0) || (a.seq || 0) - (b.seq || 0));

  for (const w of sorted) {
    let f = byPath.get(w.path);
    if (!f) {
      f = { path: w.path, writes: [], scenes: new Set(), collisions: [] };
      byPath.set(w.path, f);
    }
    f.writes.push(w);
    f.scenes.add(w.scene);

    const prev = f.writes.length > 1 ? f.writes[f.writes.length - 2] : null;
    if (!prev || prev.scene === w.scene) continue;   // 同一个场景自己连着写 ⇒ 不算撞车

    const gap = (w.time && prev.time) ? w.time - prev.time : -1;
    const lost = (w.content != null && prev.content != null)
      ? detectLost(prev.content, w.content)
      : [];
    const col = {
      path: w.path,
      over: w.scene,
      overName: w.sceneName || w.scene,
      by: prev.scene,
      byName: prev.sceneName || prev.scene,
      gapMs: gap,
      gapMin: gap >= 0 ? Math.round(gap / 60000 * 10) / 10 : null,
      lostCount: lost.length,
      samples: lost.length ? lostSamples(prev.content, w.content) : [],
      at: w.time,
      seq: w.seq,
      source: w.source,
    };
    f.collisions.push(col);
    collisions.push(col);
  }

  collisions.sort((a, b) => (b.lostCount > 0) - (a.lostCount > 0) || (b.gapMin ?? 1e9) - (a.gapMin ?? 1e9));

  const files = [...byPath.values()].map((f) => ({
    path: f.path,
    scenes: [...f.scenes],
    writes: f.writes.map((w) => ({
      scene: w.scene, sceneName: w.sceneName, time: w.time, seq: w.seq, tool: w.tool, source: w.source,
      known: w.content != null,
    })),
    collisions: f.collisions,
  })).sort((a, b) => b.collisions.length - a.collisions.length || b.writes.length - a.writes.length);

  return { files, collisions };
}

/* ── 数据源 ①：会话日志 ───────────────────────────────────────── */

export function writesFromSessions(opts = {}) {
  const dshHome = opts.dshHome || path.join(process.env.HOME || '', '.dsh');
  const index = indexSessions(dshHome);
  const out = [];

  for (const s of opts.sessions || []) {
    const dir = index.get(s.sessionId);
    if (!dir) continue;
    const calls = writeCalls(toolCalls(readEvents(dir)));
    const lastContent = new Map();
    for (const c of calls) {
      if (!c.filePath || !c.filePath.startsWith(PATHS.root)) continue;
      const rel = path.relative(PATHS.root, c.filePath).split(path.sep).join('/');
      const prev = lastContent.get(rel);
      const next = applyCall(prev == null ? null : prev, c);
      out.push({
        path: rel,
        scene: s.scene,
        sceneName: s.sceneName || s.scene,
        sessionId: s.sessionId,
        time: c.time || 0,
        seq: c.seq || 0,
        tool: c.tool,
        content: next,
        source: '会话日志',
      });
      // ⚠ 链要接上：内容推不出来时保留上一次的已知内容
      lastContent.set(rel, next == null ? prev : next);
    }
  }
  return out;
}

/* ── 数据源 ②：受闸写接口 ─────────────────────────────────────── */

export const API_LOG_FILE = path.join(PATHS.data, 'writes.jsonl');

export function appendApiWrite(rec) {
  try {
    fs.mkdirSync(PATHS.data, { recursive: true });
    fs.writeFileSync(API_LOG_FILE, JSON.stringify(rec) + '\n', { flag: 'a' });
  } catch (e) { /* ignore */ }
}

export function writesFromApi() {
  if (!fs.existsSync(API_LOG_FILE)) return [];
  const out = [];
  for (const line of fs.readFileSync(API_LOG_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch (e) { continue; }
    out.push({
      path: r.path,
      scene: r.scene,
      sceneName: r.sceneName || r.scene,
      time: r.at || 0,
      seq: 0,
      tool: 'api:' + (r.op || 'write'),
      content: r.content == null ? null : String(r.content),
      source: '受闸写接口',
    });
  }
  return out;
}

/* ── 汇总 ─────────────────────────────────────────────────────── */

export function buildHistory(opts = {}) {
  const writes = [...writesFromSessions(opts), ...writesFromApi()];
  const res = analyzeWrites(writes);
  return { ...res, scanned: (opts.sessions || []).length, writeCount: writes.length };
}

/** 写后自证要用的行归属表（缓存 30 秒 —— 重扫会话日志不便宜）。 */
let ownersCache = null;
let ownersAt = 0;
export function ownersOf(opts = {}) {
  if (ownersCache && Date.now() - ownersAt < 30000) return ownersCache;
  const writes = [...writesFromSessions(opts), ...writesFromApi()];
  ownersCache = lineOwners(writes);
  ownersAt = Date.now();
  return ownersCache;
}
export function invalidateOwners() { ownersCache = null; }

/* ── 行归属：每行是谁写进去的（写后自证用） ───────────────────── */

/**
 * 从写入记录推出「每行是谁写的」。
 * @returns Map<path, Map<lineHash, scene>>
 */
export function lineOwners(writes) {
  const owners = new Map();
  const sorted = writes.slice().sort((a, b) => (a.time || 0) - (b.time || 0) || (a.seq || 0) - (b.seq || 0));
  for (const w of sorted) {
    if (w.content == null) continue;
    let m = owners.get(w.path);
    if (!m) { m = new Map(); owners.set(w.path, m); }
    for (const h of lineHashes(w.content)) {
      if (!m.has(h)) m.set(h, w.scene);   // 先写进去的人算这一行的主人
    }
  }
  return owners;
}

/**
 * 写完自证：**别人**写的行还在不在？
 * @param {Map} owners lineOwners() 的结果
 * @param {string} path
 * @param {string} oldContent 写之前的内容
 * @param {string} newContent 写之后的内容
 * @param {string} me 我是谁
 * @returns {{lost:string[], samples:string[]}}
 */
export function selfCheck(owners, path, oldContent, newContent, me) {
  const m = owners.get(path);
  if (!m) return { lost: [], samples: [] };
  const after = lineHashes(newContent);
  const lost = [];
  const samples = [];
  for (const line of String(oldContent || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const h = hash(t);
    const owner = m.get(h);
    if (!owner || owner === me) continue;      // 别人的行才要保
    if (after.has(h)) continue;                // 还在 ✓
    lost.push(h);
    if (samples.length < 3) samples.push(t.slice(0, 90));
  }
  return { lost, samples };
}

/* ── 写入权：一个文件同时只留一个写入者 ───────────────────────── */

export const CLAIM_FILE = path.join(PATHS.data, 'claims.json');
/** 写入权有效期：超过就自动失效（写的人可能崩了/走了） */
export const CLAIM_TTL_MS = Number(process.env.WB_CLAIM_TTL_MS || 30 * 60 * 1000);

export function loadClaims() {
  try {
    return JSON.parse(fs.readFileSync(CLAIM_FILE, 'utf8')) || {};
  } catch (e) {
    return {};
  }
}

export function saveClaims(claims) {
  fs.mkdirSync(PATHS.data, { recursive: true });
  fs.writeFileSync(CLAIM_FILE, JSON.stringify(claims, null, 2), 'utf8');
}

export function claimOf(rel, claims) {
  const c = (claims || loadClaims())[rel];
  if (!c) return null;
  if (c.expires && Date.now() > c.expires) return null;   // 过期了算没有
  return c;
}

/** 拿写入权。别人还持着 ⇒ 拿不到。 */
export function takeClaim(rel, scene, ttlMs = CLAIM_TTL_MS) {
  const claims = loadClaims();
  // ⚠ 场景 id 和名字要归一（「调研」和 research 是同一个），
  //   否则同一个场景换个写法就拿不到自己的写入权。
  scene = resolveSceneId(scene);
  const cur = claimOf(rel, claims);
  if (cur && resolveSceneId(cur.scene) !== scene) {
    return {
      ok: false,
      holder: cur,
      reason: '这个文件现在归「' + cur.scene + '」写（' + ago(cur.at) + '拿的，'
        + Math.max(1, Math.round((cur.expires - Date.now()) / 60000)) + ' 分钟内有效）',
    };
  }
  claims[rel] = { scene, at: Date.now(), expires: Date.now() + ttlMs };
  saveClaims(claims);
  return { ok: true, claim: claims[rel] };
}

export function releaseClaim(rel, scene) {
  const claims = loadClaims();
  scene = resolveSceneId(scene);
  const cur = claimOf(rel, claims);
  if (cur && resolveSceneId(cur.scene) === scene) {
    delete claims[rel];
    saveClaims(claims);
    return { ok: true };
  }
  return { ok: false, reason: '这个文件的写入权不在你手上' };
}

export function ago(ts) {
  if (!ts) return '刚才';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return '不到 1 分钟前';
  if (m < 60) return m + ' 分钟前';
  return Math.round(m / 60) + ' 小时前';
}
