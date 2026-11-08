// 派单机制 —— 跨场景派活 + 回执闭环
//
// 唯一判据（派单 vs 公告，看句子就知道）：
//   句子里有「请你改 / 派单 / 做完回一句 / 改完跑 xxx 复验」 ⇒ 派单 ⇒ **必须真唤醒**
//   否则 ⇒ 公告 ⇒ 只落盘，不唤醒（唤醒要花对方一轮）
//
// 状态机：
//   想出派单 → 投递 → 已投递 → 已回执 → 收尾知悉(最多1条) ⇒ 销账
//                          ↘ 超时没有任何回执 ⇒ 未回执（进「我发出没回」清单）
//
// 三条硬上限（防 AI 互相客套烧钱）：
//   同一件事 ≤ 3 条（派单 + 回执 + 收尾知悉）
//   单条 ≤ 200 字 / ≤ 10 行
//   末行 【结束】；纯确认语（收到/好的/谢谢）不许发
//
// 判据：**「活干完了但对方还不知道」= 没干完。**

import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './config.mjs';

export const LEDGER_FILE = path.join(PATHS.data, 'dispatch-ledger.jsonl');
export const BOARD_FILE = path.join(PATHS.memory, '_共享记忆', '_跨场景通知.md');
export const TODO_FILE = path.join(PATHS.memory, '_共享记忆', '_待办.md');
export const ACK_DIR = path.join(PATHS.memory, '_共享记忆', '_回执');

/** 同一件事最多几条（派单 + 回执 + 收尾知悉） */
export const MAX_MESSAGES_PER_TOPIC = 3;
export const MAX_CHARS = 200;
export const MAX_LINES = 10;
/** 多久没回算「未回执」 */
export const ACK_DEADLINE_MS = Number(process.env.WB_ACK_DEADLINE_MS || 30 * 60 * 1000);

/** 四件套缺一件对方就得追问 —— 所以缺了就别发。 */
export const FOUR_PIECES = [
  { key: 'symptom', label: '现象', hint: '现在是什么样子（可观察的，不要形容词）' },
  { key: 'how', label: '照哪做', hint: '哪份文档的哪一节 / 哪个工具（唯一出处）' },
  { key: 'verify', label: '怎么验', hint: '做完跑哪个检查、看到什么算通过' },
  { key: 'reply', label: '回一句', hint: '明确要回执，并写「我在等你的回执」' },
];

/** 动作动词 —— 出现了才算派单，不然只是公告 */
const ACTION_RE = /请你|请改|派单|做完|回一句|复验|跑一下|跑个|检查一下|处理|执行|完成|改完|修一下|重跑/;

/** 纯确认语 —— 不携带信息，只是社交 ⛔ 不许发 */
const PURE_ACK_RE = /^(收到|好的|好|谢谢|谢了|知悉|明白|知道了|ok|okay|👍)+[。.!！~\s]*$/i;

export function hashOf(topic) {
  const s = String(topic || '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8);
}

export function now() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/* ── 台账 ─────────────────────────────────────────────────────── */

export function readLedger() {
  if (!fs.existsSync(LEDGER_FILE)) return [];
  const out = [];
  for (const line of fs.readFileSync(LEDGER_FILE, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch (e) { /* 坏行跳过，不让它拖垮台账 */ }
  }
  return out;
}

export function appendLedger(rec) {
  fs.mkdirSync(path.dirname(LEDGER_FILE), { recursive: true });
  fs.writeFileSync(LEDGER_FILE, JSON.stringify(rec) + '\n', { flag: 'a' });
  return rec;
}

/* ── 通知看板（公告落这里；派单也留一行，便于事后对账） ────────── */

export function readBoard() {
  if (!fs.existsSync(BOARD_FILE)) return '';
  return fs.readFileSync(BOARD_FILE, 'utf8');
}

export function writeBoardLine(from, to, text) {
  fs.mkdirSync(path.dirname(BOARD_FILE), { recursive: true });
  const line = '- [' + now() + '] ' + from + ' → ' + to + '：' + String(text).replace(/\n+/g, ' ').slice(0, 300) + '\n';
  const header = fs.existsSync(BOARD_FILE) && fs.readFileSync(BOARD_FILE, 'utf8').trim()
    ? '' : '# 跨场景通知看板\n\n> 派单与公告都留一行，便于事后对账。\n\n';
  fs.writeFileSync(BOARD_FILE, header + line, { flag: 'a' });
  return line;
}

/* ── 回执落盘路径 ─────────────────────────────────────────────── */

export function ackPath(hash) {
  return path.join(ACK_DIR, hash + '.md');
}

export function readAckFile(hash) {
  const f = ackPath(hash);
  if (!fs.existsSync(f)) return null;
  return { at: fs.statSync(f).mtimeMs, text: fs.readFileSync(f, 'utf8') };
}

/** 从回执正文里抠出「结论 / 证据 / 落盘」三段（认这几个标记）。 */
export function parseAck(text) {
  const t = String(text || '');
  const grab = (re) => { const m = t.match(re); return m ? m[1].trim() : ''; };
  return {
    conclusion: grab(/(?:结论|Conclusion)\s*[:：]\s*(.+)/) || t.split('\n').filter(Boolean)[0] || '',
    evidence: grab(/(?:证据|Evidence)\s*[:：]\s*([\s\S]+?)(?=\n\s*(?:落盘|还差|结论)\s*[:：]|$)/) || '',
    path: grab(/(?:落盘|路径|Path)\s*[:：]\s*(.+)/) || '',
  };
}

/* ── 校验：四件套 + 上限 + 纯确认语 ───────────────────────────── */

export function validateDispatch(d) {
  const errors = [];
  const warnings = [];

  for (const piece of FOUR_PIECES) {
    if (!String(d[piece.key] || '').trim()) {
      errors.push('缺「' + piece.label + '」：' + piece.hint + '（缺一件对方就得追问）');
    }
  }
  if (!String(d.to || '').trim()) errors.push('没指定目标场景');
  if (!String(d.from || '').trim()) errors.push('没指定发起场景');
  if (!String(d.topic || '').trim()) errors.push('没写主题（主题=这件事的编号，同主题共用一条线）');

  const body = composeBody(d);
  if (PURE_ACK_RE.test(body.trim())) {
    errors.push('这是纯确认语（收到/好的/谢谢）—— 不携带信息 ⛔ 不许发');
  }
  const chars = body.length;
  const lines = body.split('\n').length;
  if (chars > MAX_CHARS) errors.push('正文 ' + chars + ' 字，超过 ' + MAX_CHARS + ' 字上限（回执给指针，报告放文件里）');
  if (lines > MAX_LINES) errors.push('正文 ' + lines + ' 行，超过 ' + MAX_LINES + ' 行上限');

  // 同一件事 ≤3 条
  const hash = hashOf(d.topic);
  const sameTopic = readLedger().filter((r) => r.hash === hash);
  if (sameTopic.length >= MAX_MESSAGES_PER_TOPIC) {
    errors.push('这件事已经发了 ' + sameTopic.length + ' 条（上限 ' + MAX_MESSAGES_PER_TOPIC
      + '：派单 + 回执 + 收尾知悉）—— 再发就是互相客套烧钱');
  }

  const isAction = ACTION_RE.test(body);
  if (!isAction) {
    warnings.push('正文里没有动作动词 ⇒ 按「公告」处理：只落盘，不唤醒对方（唤醒要花对方一轮）');
  }

  return { ok: errors.length === 0, errors, warnings, hash, chars, lines, isAction };
}

/** 组装正文：四件套 + 末行【结束】 */
export function composeBody(d) {
  const parts = [];
  parts.push('① 现象：' + String(d.symptom || '').trim());
  parts.push('② 照哪做：' + String(d.how || '').trim());
  parts.push('③ 怎么验：' + String(d.verify || '').trim());
  parts.push('④ 回一句：' + String(d.reply || '').trim());
  parts.push('【结束】');
  return parts.join('\n');
}

/* ── 派单 ─────────────────────────────────────────────────────── */

export async function dispatch(d, opts = {}) {
  const v = validateDispatch(d);
  if (!v.ok) return { ok: false, errors: v.errors, warnings: v.warnings };

  const hash = v.hash;
  const body = composeBody(d);
  const kind = v.isAction ? '派单' : '公告';

  const rec = {
    hash,
    topic: String(d.topic).trim(),
    from: String(d.from).trim(),
    to: String(d.to).trim(),
    at: now(),
    kind,
    delivered: '',
    ack: null,
    body,
    deadline: Date.now() + ACK_DEADLINE_MS,
  };

  // ① 真唤醒（仅派单）—— 公告只落盘
  if (kind === '派单') {
    if (typeof opts.deliver === 'function') {
      const r = await opts.deliver(rec);
      rec.delivered = (r && r.delivered) || '';
      if (r && r.error) rec.delivered = '投递失败：' + r.error;
    } else {
      rec.delivered = '未投递（没有投递通道）';
    }
    if (!rec.delivered || /失败|未投递/.test(rec.delivered)) {
      // ⛔ 投递失败 = 这条消息根本没发出去 ⇒ **不进台账**，
      //    也不占「同一件事 ≤3 条」的额度（额度是给真发出去的消息的）。
      return { ok: false, errors: ['投递失败：' + (rec.delivered || '未知')], warnings: v.warnings, hash, rec };
    }
  } else {
    rec.delivered = '只落盘（公告不唤醒）';
  }

  appendLedger(rec);
  writeBoardLine(rec.from, rec.to, (kind === '派单' ? '【派单】' : '【公告】') + rec.topic + '：' + String(d.symptom).slice(0, 120));

  return { ok: true, hash, rec, warnings: v.warnings, body };
}

/* ── 回执 ─────────────────────────────────────────────────────── */

export function recordAck(hash, ack) {
  const rows = readLedger();
  const rec = rows.filter((r) => r.hash === hash).pop();
  if (!rec) return { ok: false, error: '台账里没有这件事：' + hash };
  rec.ack = {
    at: now(),
    conclusion: String(ack.conclusion || '').trim(),
    evidence: String(ack.evidence || '').trim(),
    path: String(ack.path || '').trim(),
  };
  fs.writeFileSync(LEDGER_FILE, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return { ok: true, rec };
}

/** 收尾知悉（最多 1 条）—— 这条线到这儿了 */
export function closeLine(hash, from) {
  const rows = readLedger();
  const idx = rows.map((r) => r.hash).lastIndexOf(hash);
  if (idx < 0) return { ok: false, error: '台账里没有这件事：' + hash };
  const rec = rows[idx];
  const count = rows.filter((r) => r.hash === hash).length;
  if (count >= MAX_MESSAGES_PER_TOPIC) {
    return { ok: false, error: '这件事已经 ' + count + ' 条了（上限 ' + MAX_MESSAGES_PER_TOPIC + '）' };
  }
  const closed = {
    hash,
    topic: rec.topic,
    from: from || rec.from,
    to: rec.to,
    at: now(),
    kind: '知悉',
    delivered: '只落盘（知悉不唤醒）',
    ack: null,
    body: '【收尾知悉】' + rec.topic + ' 这条线到此结束。\n【结束】',
  };
  appendLedger(closed);
  rec.closed = true;
  rec.closedAt = closed.at;
  fs.writeFileSync(LEDGER_FILE, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return { ok: true, rec: closed };
}

/* ── 状态机 + 两个查询 ────────────────────────────────────────── */

/** 扫描回执文件，把还没记进台账的回执**自动销账**。 */
export function autoAck() {
  const rows = readLedger();
  const byHash = new Map();
  for (const r of rows) if (!r.ack) byHash.set(r.hash, r);
  if (!byHash.size) return 0;
  let n = 0;
  for (const [hash, rec] of byHash) {
    const f = readAckFile(hash);
    if (!f) continue;
    rec.ack = Object.assign({ at: now() }, parseAck(f.text));
    n++;
  }
  if (n) {
    fs.writeFileSync(LEDGER_FILE, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  }
  return n;
}

/** 把台账折成「一条线一个状态」。 */
export function lines() {
  autoAck();          // ★ 先把落盘的回执销掉，再折状态（否则永远显示「已投递」）
  const rows = readLedger();
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.hash)) {
      map.set(r.hash, {
        hash: r.hash, topic: r.topic, from: r.from, to: r.to,
        at: r.at, kind: r.kind, delivered: r.delivered, ack: null,
        deadline: r.deadline || 0, msgs: [], closed: false,
      });
    }
    const line = map.get(r.hash);
    line.msgs.push(r);
    if (r.ack) line.ack = r.ack;
    if (r.closed) { line.closed = true; line.closedAt = r.closedAt; }
  }
  const t = Date.now();
  for (const line of map.values()) {
    if (line.ack) line.state = '已回执';
    else if (line.closed) line.state = '已销账';
    else if (line.kind === '公告') line.state = '已落盘';
    else if (line.deadline && t > line.deadline) line.state = '未回执';
    else line.state = '已投递';
    line.count = line.msgs.length;
  }
  return [...map.values()].sort((a, b) => (a.at < b.at ? 1 : -1));
}

/** 我发出还没人回的 / 别人在等我回的 */
export function openLines(scene) {
  const all = lines();
  return {
    mine: all.filter((l) => l.from === scene && l.state === '已投递'),
    waiting: all.filter((l) => l.to === scene && l.state === '已投递'),
    unacked: all.filter((l) => l.state === '未回执'),
    all,
  };
}

/* ── 待办板：勾掉 / 标归属 ────────────────────────────────────── */

/** 把待办板上某一条勾上/勾掉（认领了就得把这条勾掉，否则它会一直挂在待办里）。 */
export function setTodoDone(text, done) {
  if (!fs.existsSync(TODO_FILE)) return { ok: false, error: '待办板还没建' };
  const lines = fs.readFileSync(TODO_FILE, 'utf8').split('\n');
  const idx = lines.findIndex((l) => l.includes(text));
  if (idx < 0) return { ok: false, error: '待办板上没有这一条：' + text };
  lines[idx] = done
    ? lines[idx].replace('- [ ]', '- [x]')
    : lines[idx].replace('- [x]', '- [ ]');
  fs.writeFileSync(TODO_FILE, lines.join('\n'), 'utf8');
  return { ok: true, line: lines[idx] };
}

/** 给待办板上某一条标归属（@场景）。 */
export function setTodoOwner(text, owner) {
  if (!fs.existsSync(TODO_FILE)) return { ok: false, error: '待办板还没建' };
  const lines = fs.readFileSync(TODO_FILE, 'utf8').split('\n');
  const idx = lines.findIndex((l) => l.includes(text));
  if (idx < 0) return { ok: false, error: '待办板上没有这一条：' + text };
  const t = readTodos().find((x) => x.text === text);
  if (!t) return { ok: false, error: '待办板上没有这一条：' + text };
  const base = lines[idx].replace(/@\s*\S+\s*$/, '').trimEnd();
  lines[idx] = owner ? base + ' @' + owner : base;
  fs.writeFileSync(TODO_FILE, lines.join('\n'), 'utf8');
  return { ok: true, line: lines[idx] };
}

/* ── 分诊：没人认领的活 ───────────────────────────────────────── */

export function readTodos() {
  if (!fs.existsSync(TODO_FILE)) return [];
  const out = [];
  for (const line of fs.readFileSync(TODO_FILE, 'utf8').split('\n')) {
    const m = line.match(/^- \[( |x)\]\s*(.*)$/);
    if (!m) continue;
    const raw = m[2];
    const at = raw.lastIndexOf('@');
    let owner = '';
    let text = raw;
    if (at > 0 && raw.slice(at + 1).trim().length <= 24) {
      owner = raw.slice(at + 1).trim();
      text = raw.slice(0, at).trim();
    }
    out.push({ done: m[1] === 'x', text, owner });
  }
  return out;
}

/** 分诊：挂着待办却没归属 / 写了归属但对方不管 / 两边都说不是我的 ⇒ 不许当没看见。 */
export function triage(scene) {
  const todos = readTodos();
  const unowned = todos.filter((t) => !t.done && !t.owner);
  const l = lines();
  const mineUnacked = l.filter((x) => x.from === scene && x.state === '未回执');
  const waitingMe = l.filter((x) => x.to === scene && x.state === '已投递');
  return {
    unowned,
    mineUnacked,
    waitingMe,
    items: [
      ...unowned.map((t) => ({
        kind: '无主待办', text: t.text,
        options: ['派单（选一个对口场景）', '自己做（台账落一行）', '问机主一句'],
      })),
      ...mineUnacked.map((x) => ({
        kind: '未回执', text: x.topic + ' → ' + x.to,
        options: ['催一次（≤3 条上限内）', '改派别人', '问机主一句'],
      })),
      ...waitingMe.map((x) => ({
        kind: '别人在等我', text: x.from + ' → 我：' + x.topic,
        options: ['回执（结论+证据+落盘）', '回执：干不了（写明原因）'],
      })),
    ],
  };
}
