// 分诊 —— 一个「唯一对口」可执行的抓手
//
// 原文的抓手（00-核心机制/一-协作机制.md §6）：
//   「一个『分诊』工具扫一遍（**台账未办结 / 看板 / 体检 ⛔ / 定位卡未办结**）
//     ⇒ 出『**有主 / 无主**』两张单。」
//
// 规则只有一条：
//   看到「挂着待办却没有归属 / 写了归属但对方不管 / 两边都说不是我的」
//   ⇒ **不许当没看见**。
//
// 三种出口（原文）：
//   ① 判「该谁」→ 有对口场景 ⇒ 派单（写清现象 + 照哪节做 + 做完怎么验）
//   ② 谁都不合适 ⇒ 自己做，并在台账落一行
//   ③ 拿不准 ⇒ **问机主一句**（别猜着办）

import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './config.mjs';
import * as authority from './authority.mjs';
import * as dispatch from './dispatch.mjs';

/**
 * 按「唯一对口」表判这个活该谁做。
 * @returns {{scene:string, topic:string, why:string, matched:string[]}|null}
 */
export function suggestOwner(text) {
  const t = authority.loadTerritory();
  const s = String(text || '');
  if (!s.trim()) return null;
  let best = null;
  for (const rule of t.soleResponsibility || []) {
    const hit = (rule.keywords || [rule.topic]).filter((k) => s.includes(k));
    if (!hit.length) continue;
    if (!best || hit.length > best.matched.length) {
      best = {
        scene: authority.resolveSceneId(rule.scene),
        sceneName: (t.scenes && t.scenes[authority.resolveSceneId(rule.scene)] || {}).name || rule.scene,
        topic: rule.topic,
        why: rule.note,
        matched: hit,
      };
    }
  }
  return best;
}

/** 重叠判据：这条活同时像好几种 ⇒ 按判据表听谁的。 */
export function overlapAdvice(text) {
  const t = authority.loadTerritory();
  const s = String(text || '');
  const hits = [];
  for (const rule of t.soleResponsibility || []) {
    const hit = (rule.keywords || [rule.topic]).filter((k) => s.includes(k));
    if (hit.length) hits.push({ rule, hit });
  }
  if (hits.length < 2) return null;
  // 两类都命中 ⇒ 看重叠判据表里有没有对得上的情形
  for (const o of t.overlapRules || []) {
    if (s.includes('既像') || s.includes('又像') || hits.length >= 2) {
      return {
        advice: o.situation + ' ⇒ 听「' + o.winner + '」的（' + o.judgement + '）',
        candidates: hits.map((h) => h.rule.scene),
      };
    }
  }
  return null;
}

/* ── 四个来源 ─────────────────────────────────────────────────── */

/** ① 台账未办结：派了单还没回执的。 */
function ledgerPending() {
  const out = [];
  for (const line of dispatch.lines()) {
    if (line.state === '已投递' || line.state === '未回执') {
      out.push({
        source: '台账未办结',
        text: line.topic + '（' + line.from + ' → ' + line.to + '）',
        owner: line.to,
        hash: line.hash,
        overdue: line.state === '未回执',
        detail: line.state === '未回执'
          ? '超时没有任何回执 —— 对方可能压根没看见，或者干不了'
          : '已投递，还没回执',
      });
    }
  }
  return out;
}

/** ② 看板：通知看板上**还没销账**的行（已办结的别来凑数）。 */
function boardPending() {
  const out = [];
  const board = dispatch.readBoard();
  // 台账里已闭环的主题
  const closed = new Set(
    dispatch.lines()
      .filter((l) => l.state === '已回执' || l.state === '已销账')
      .map((l) => l.topic)
  );
  for (const line of board.split('\n')) {
    const m = line.match(/^\s*-\s*\[[^\]]*\]\s*([^→]+?)\s*→\s*([^：]+)：(.*)$/);
    if (!m) continue;
    const body = m[3].trim();
    // 回执行本身就是「已办结」的标记 ⇒ 不是待办
    if (/^回执/.test(body)) continue;
    // 主题：形如【派单】主题：正文
    const tm = body.match(/^【[^】]*】\s*([^：]+)：/);
    const topic = tm ? tm[1].trim() : '';
    if (topic && closed.has(topic)) continue;   // 已闭环 ⇒ 不是待办
    const from = authority.resolveSceneId(m[1]);
    const to = authority.resolveSceneId(m[2]);
    out.push({
      source: '通知看板',
      text: body,
      owner: to || from,
      topic,
      detail: (from ? from : m[1].trim()) + ' → ' + (to ? to : m[2].trim()),
    });
  }
  return out;
}

/** ③ 体检 ⛔：每个场景自身的不合格项。 */
function healthIssues(scenes, sessionIds) {
  const out = [];
  for (const sc of scenes) {
    const id = authority.resolveSceneId(sc.id);
    for (const p of sc.panels || []) {
      if (p.type !== 'harness') continue;
      if (!p.sessionId) {
        out.push({
          source: '体检⛔',
          text: '场景「' + sc.name + '」的 AI 面板「' + (p.id || '') + '」没绑定会话',
          owner: id,
          detail: '没有 sessionId ⇒ 面板不钉会话（照 02 板块补三字段）',
        });
      } else if (sessionIds && sessionIds.length && !sessionIds.includes(p.sessionId)) {
        out.push({
          source: '体检⛔',
          text: '场景「' + sc.name + '」绑的会话在引擎里找不到了',
          owner: id,
          detail: '会话被归档/换过了 ⇒ 要更新 json 里的 sessionId',
        });
      }
    }
    // 定位卡未办结：还有「（待写）」占位
    const card = path.join(PATHS.memory, id, '定位卡.md');
    try {
      if (fs.existsSync(card)) {
        const txt = fs.readFileSync(card, 'utf8');
        const todo = (txt.match(/TODO[^\n]*/g) || []).length;
        if (todo) {
          out.push({
            source: '定位卡未办结',
            text: '场景「' + sc.name + '」的定位卡还有 ' + todo + ' 处没写完',
            owner: id,
            detail: '定位卡是开场第一份读的东西 —— 留着占位，接不上活',
          });
        }
      }
    } catch (e) { /* ignore */ }
  }
  return out;
}

/** ④ 待办板上没归属的。 */
function todoUnowned() {
  const out = [];
  for (const t of dispatch.readTodos()) {
    if (t.done) continue;
    out.push({
      source: t.owner ? '待办（有归属）' : '待办（无归属）',
      text: t.text,
      owner: t.owner ? authority.resolveSceneId(t.owner) : '',
      detail: t.owner ? '归属：' + t.owner : '⛔ 挂着却没有归属 ⇒ 不许当没看见',
      todoText: t.text,
    });
  }
  return out;
}

/* ── 主入口 ───────────────────────────────────────────────────── */

/**
 * 扫一遍 ⇒ 出「有主 / 无主」两张单。
 * @param {object} opts
 * @param {Array} opts.scenes 场景列表
 * @param {Array} opts.sessionIds 引擎里真实存在的会话 id（用来查「绑的会话没了」）
 */
export function scan(opts = {}) {
  const scenes = opts.scenes || [];
  const sessionIds = opts.sessionIds || [];

  const items = [
    ...todoUnowned(),
    ...ledgerPending(),
    ...healthIssues(scenes, sessionIds),
    ...boardPending(),
  ];

  const owned = [];
  const unowned = [];
  const seen = new Set();
  for (const it of items) {
    // 去重：同一条待办在板上有重复行时，只算一条
    const key = it.source + '|' + it.text;
    if (seen.has(key)) continue;
    seen.add(key);
    if (it.owner) {
      owned.push(it);
    } else {
      // ⚠ 只拿**活本身**去判，别把诊断文案也喂进去
      //   （详情里有「挂着却没有归属」这种字样，会把关键词匹配带偏）
      const sug = suggestOwner(it.text);
      const ov = overlapAdvice(it.text);
      unowned.push({
        ...it,
        suggestion: sug,
        overlap: ov,
        options: sug
          ? ['派单给「' + sug.sceneName + '」（判据：' + sug.topic + '）', '自己做（台账落一行）', '问机主一句']
          : ['自己做（台账落一行）', '问机主一句'],
      });
    }
  }

  return {
    owned,
    unowned,
    counts: {
      total: items.length,
      owned: owned.length,
      unowned: unowned.length,
      overdue: items.filter((i) => i.overdue).length,
    },
    ruleOwner: authority.loadTerritory().ruleOwner,
  };
}

/** 「我自己做」⇒ 在台账落一行（原文要求）。 */
export function claimIt(scene, text, note = '') {
  const rec = {
    hash: authority.hashOf ? authority.hashOf(text) : dispatch.hashOf(text),
    topic: text,
    from: scene,
    to: scene,
    at: dispatch.now(),
    kind: '认领',
    delivered: '自己做（分诊落一行）',
    ack: { at: dispatch.now(), conclusion: '分诊判定：自己接手', evidence: note || '分诊面板选了「自己做」', path: '' },
    body: '【分诊 · 自己做】' + text + (note ? '　' + note : '') + '\n【结束】',
    deadline: 0,
  };
  dispatch.appendLedger(rec);
  // ⚠ 认领了 ⇒ 待办板上那一条要勾掉，否则它会一直挂在「无主活」清单里
  try { dispatch.setTodoDone(text, true); } catch (e) { /* 板上没有就算了 */ }
  return rec;
}
