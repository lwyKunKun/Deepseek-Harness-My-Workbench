// 会话日志解析 —— 越界审计与写痕检测的共同底座
//
// 引擎把每个场景会话的完整事件流写在：
//   <DSH_HOME>/sessions/<cwd转义>/<sessionId>/session.v4.jsonl.zstd
//
// 里面有 tool/call 事件，带工具名和参数：
//   write  { file_path, content }              ← 完整内容
//   edit   { file_path, old_string, new_string }  ← 可重放
//   bash   { command }                        ← 只知道命令
//
// ⛔ 只读工具：不写任何文件、不改任何设置、不杀进程。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const WRITE_TOOLS = new Set(['write', 'edit', 'apply_patch', 'patch']);

/** 建 sessionId → 目录 的索引。 */
export function indexSessions(dshHome) {
  const root = path.join(dshHome, 'sessions');
  const index = new Map();
  if (!fs.existsSync(root)) return index;
  for (const proj of fs.readdirSync(root)) {
    const pdir = path.join(root, proj);
    let st;
    try { st = fs.statSync(pdir); } catch (e) { continue; }
    if (!st.isDirectory()) continue;
    for (const s of fs.readdirSync(pdir)) {
      index.set(s, path.join(pdir, s));
    }
  }
  return index;
}

/** 读一个会话的全部事件。 */
export function readEvents(sessionDir) {
  let file;
  try { file = fs.readdirSync(sessionDir).find((f) => f.endsWith('.zstd')); } catch (e) { return []; }
  if (!file) return [];
  let text;
  try {
    text = zlib.zstdDecompressSync(fs.readFileSync(path.join(sessionDir, file))).toString('utf8');
  } catch (e) {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (e) { /* 坏行跳过 */ }
  }
  return out;
}

/** 事件流 → 工具调用列表。 */
export function toolCalls(events) {
  const out = [];
  for (const ev of events) {
    if (ev.type !== 'tool/call') continue;
    const d = ev.data || {};
    let args = {};
    try { args = JSON.parse(d.arguments || '{}'); } catch (e) { args = {}; }
    out.push({
      seq: ev.seq,
      time: ev.time || 0,      // ⚠ 事件顶层才有 time（data 里没有）
      turn: d.turn,
      step: d.step,
      tool: String(d.name || ''),
      args,
      filePath: args.file_path || args.path || '',
      content: typeof args.content === 'string' ? args.content : '',
      newString: typeof args.new_string === 'string' ? args.new_string : '',
      oldString: typeof args.old_string === 'string' ? args.old_string : '',
      command: typeof args.command === 'string' ? args.command : '',
    });
  }
  return out;
}

/**
 * 一个文件在某场景手里的**内容快照**。
 * write  ⇒ 直接就是 content
 * edit   ⇒ 在上一版基础上重放 old→new
 * bash   ⇒ 不知道（返回 null）
 */
export function applyCall(prevContent, call) {
  if (call.tool === 'write' || call.tool === 'apply_patch') return call.content;
  if (call.tool === 'edit' || call.tool === 'patch') {
    if (prevContent == null) return null;
    if (!prevContent.includes(call.oldString)) return null;  // 对不上 ⇒ 不知道
    return prevContent.replace(call.oldString, call.newString);
  }
  return null;
}

/** 写工具调用（能定位到文件的）。 */
export function writeCalls(calls) {
  return calls.filter((c) => WRITE_TOOLS.has(c.tool) && c.filePath);
}
