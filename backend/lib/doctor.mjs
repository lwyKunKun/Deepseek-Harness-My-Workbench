// doctor.mjs —— 自检（可被界面调用）
//
// ⚠ 判据原则：**看得见的落点才算过**。
//   「我改了配置」不等于「它生效了」—— 这里查的是文件、连接、画面前置条件。
//
// 这份是**模块**：界面上的「自检」按钮调它，不用开命令行。

import fs from 'node:fs';
import path from 'node:path';
import { PATHS, ENGINE, SERVER, MEMORY_SOFT_LIMIT } from './config.mjs';
import { loadScenes } from './scenes.mjs';
import { probe } from './engine.mjs';
import { getCookie, rpc, flattenSessions } from './dsh-cli.mjs';
import * as loadGate from './loadgate.mjs';
import * as gpu from './gpu.mjs';
import * as dispatch from './dispatch.mjs';
import * as authority from './authority.mjs';
import * as triage from './triage.mjs';
import * as writelog from './writelog.mjs';
import * as selftest from './selftest.mjs';
import * as mem from './memory.mjs';
import { ownedPorts } from './panelports.mjs';

export async function doctor() {
  const rows = [];
  const check = (name, ok, detail) => rows.push({ name, ok: !!ok, detail: detail || '' });

  // ① Node
  const major = Number(process.versions.node.split('.')[0]);
  const minor = Number(process.versions.node.split('.')[1]);
  check('Node 版本', major > 22 || (major === 22 && minor >= 9), '当前 ' + process.versions.node + '（需要 >=22.9）');

  // ② 引擎在不在
  const st = await probe();
  check('引擎连通', st.up, ENGINE.base + (st.up ? '  ✓ HTTP ' + st.status : '  ✗ 没连上（先起 dsh web）'));

  // ③ 前端文件齐不齐
  const need = ['web/index.html', 'web/style.css', 'web/app.js', 'web/panels.js', 'web/pin.js', 'server.mjs'];
  const missing = need.filter((f) => !fs.existsSync(path.join(PATHS.root, f)));
  check('前端文件', !missing.length, missing.length ? '缺：' + missing.join(', ') : need.length + ' 个都在');

  // ④ 场景配置能解析吗
  const scenes = loadScenes();
  const badScenes = scenes.filter((s) => (s.errors || []).length);
  check('场景配置', scenes.length > 0 && !badScenes.length,
    scenes.length === 0 ? 'scenarios/ 里没有场景'
      : badScenes.length ? badScenes.map((s) => s.id + ': ' + s.errors.join('; ')).join(' | ')
        : scenes.length + ' 个场景都合法');

  // ⑤ 面板类型都注册了吗
  const regSrc = fs.readFileSync(path.join(PATHS.web, 'panels.js'), 'utf8');
  const registered = new Set([...regSrc.matchAll(/^PANELS\.([A-Za-z0-9_-]+)\s*=/gm)].map((m) => m[1]));
  const usedTypes = new Set();
  for (const s of scenes) for (const p of s.panels || []) usedTypes.add(p.type);
  const unknown = [...usedTypes].filter((t) => !registered.has(t));
  check('面板类型注册', !unknown.length,
    unknown.length ? '没注册：' + unknown.join(', ') + '（面板会显示成灰字，不会报错）'
      : [...usedTypes].join(', ') || '没有面板');

  // ⑥ 端口没被占（⚠ 要分清「被谁占」：插件模式下这些端口是我们自己开的）
  const net = await import('node:net');
  const probePort = (port) => new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(600, () => { s.destroy(); resolve(false); });
  });
  const busy = [];
  for (const p of [SERVER.port, SERVER.port + 1]) if (await probePort(p)) busy.push(p);
  const running = busy.indexOf(SERVER.port) >= 0;
  const mine = ownedPorts();
  const foreign = busy.filter((p) => !mine.includes(p));
  check('工作台端口', running || busy.length === 0 || foreign.length === 0,
    running ? SERVER.port + ' 已被占用 ⇒ 工作台正在跑（正常）'
      : foreign.length ? '面板端口被占：' + foreign.join(', ') + '（换个 WB_PANEL_PORT_BASE）'
        : busy.length ? '面板端口 ' + busy.join(', ') + ' 由工作台自己占着（正常：跑在 DSH 引擎里）'
          : SERVER.port + ' 空着，可以启动');

  // ⑦ 引擎认证 + 会话绑定
  const cookie = await getCookie();
  if (!cookie) {
    check('引擎认证', false, '没认证 —— 打开工作台界面点右上角「引擎」连一次，或设 DSH_TOKEN');
  } else {
    const listRes = await rpc('session/list', { _request: {} }, cookie);
    const sessions = listRes.ok ? flattenSessions(listRes.value) : [];
    const byId = new Map(sessions.map((s) => [s.sessionId, s]));
    check('引擎认证', true, '已认证，引擎里 ' + sessions.length + ' 条会话');

    let miss = 0;
    let bound = 0;
    const details = [];
    for (const sc of scenes) {
      for (const p of sc.panels || []) {
        if (p.type !== 'harness') continue;
        if (!p.sessionId) { miss++; details.push(sc.id + '/' + p.id + ' 没写 sessionId'); continue; }
        const s = byId.get(p.sessionId);
        if (!s) { miss++; details.push(sc.id + '/' + p.id + ' 的 sessionId 在引擎里找不到'); continue; }
        bound++;
        if (p.sessionTitle && s.title && s.title !== p.sessionTitle) {
          miss++; details.push(sc.id + '/' + p.id + ' 标题对不上');
        }
      }
    }
    check('会话绑定', miss === 0, miss === 0 ? bound + ' 个 AI 面板都绑到真实会话了'
      : miss + ' 个面板有问题：' + details.slice(0, 4).join('；'));
  }

  // ⑧ 记忆结构与红线：一个场景 = 一个 项目信息.md + 一张 身份卡
{
  const scenes = loadScenes();
  const missing = [];
  const over = [];
  const warns = [];
  for (const sc of scenes) {
    const h = mem.health(sc.id);
    h.problems.forEach((p) => missing.push(sc.id + ' ' + p));
    if (h.sec0 > MEMORY_SOFT_LIMIT) over.push(sc.id + ' §〇 ' + h.sec0 + 'B');
    h.warns.forEach((w) => warns.push(sc.id + ' ' + w));
  }
  check('记忆结构', missing.length === 0,
    missing.length ? '缺：' + missing.join('；') : scenes.length + ' 个场景都有 项目信息.md + 身份卡.md');
  check('§〇 红线', over.length === 0,
    over.length ? '超 4KB：' + over.join('；') : '所有 §〇 都在 4KB 内' + (warns.length ? '（⚠ ' + warns.join('；') + '）' : ''));
}

// ⑧b 宪法与索引在不在（这两根柱子缺了就等于没规矩、没索引）
{
  const ag = mem.sharedPath(mem.AGENTS_FILE);
  const idx = mem.sharedPath(mem.INDEX_FILE);
  const agOk = fs.existsSync(ag) && fs.statSync(ag).size > 200;
  const idxOk = fs.existsSync(idx) && fs.statSync(idx).size > 100;
  check('宪法在位', agOk, agOk ? 'AGENTS.md ' + Math.round(fs.statSync(ag).size / 1024 * 10) / 10 + 'K' : '缺 memory/_共享记忆/AGENTS.md');
  check('索引在位', idxOk, idxOk ? '索引.md ' + Math.round(fs.statSync(idx).size / 1024 * 10) / 10 + 'K' : '缺 memory/_共享记忆/索引.md（AI 就得全量扫目录）');
}

// ⑨ 负载闸能不能量（量不到 ≠ 可派单）
  {
    const g = await loadGate.gate({ samples: 1, intervalMs: 200 });
    check('负载闸可判定', g.verdict !== 'unknown',
      g.verdict === 'unknown'
        ? '⚠ 量不到 ⇒ 按「别派」处理（不是「可派单」）'
        : g.text + '（CPU ' + g.cpu + '% · 内存 ' + g.ram + '% · ' + g.ramMode + '）');
  }

  // ⑩ 派单台账：有没有「发出没回」或「别人在等」
  {
    const ls = dispatch.lines();
    const mine = ls.filter((l) => l.state === '已投递');
    const waiting = ls.filter((l) => l.state === '已投递');
    const unacked = ls.filter((l) => l.state === '未回执');
    check('派单台账', true,
      ls.length + ' 条线 · 待回 ' + mine.length + ' · 未回执 ' + unacked.length
      + (waiting.length ? ' · 等我回 ' + waiting.length : ''));
  }

  // ⑪ GPU 判据：拿不到也应该是「照 CPU 跑 + 记 why」，不是崩
  {
    const probe = await gpu.probeGpu();
    const v = gpu.shouldUseGpu('ocr', probe);
    const v2 = gpu.shouldUseGpu('llm', probe);
    check('GPU 判据', !!v.why && !!v2.why,
      'OCR → ' + (v.useGpu ? 'GPU' : 'CPU/远端') + '；LLM → ' + (v2.useGpu ? 'GPU' : '远端 API')
      + '（判据只此一处）');
  }

  // ⑫ 机制文件在不在（AI 要读它们当规矩）
  {
    const need = ['派单机制.md', 'GPU优先.md'];
    const dir = path.join(PATHS.memory, '_共享记忆');
    const missing2 = need.filter((f) => !fs.existsSync(path.join(dir, f)));
    check('机制文件', !missing2.length,
      missing2.length ? '缺：' + missing2.join('、') + '（AI 读不到就没法按规矩办事）'
        : need.join('、') + ' 都在');
  }

  // ⑬ 修改权分档：分档判定 + 越界审计
  {
    const t = authority.loadTerritory();
    const terrOk = t && t.ruleOwner && Object.keys(t.scenes || {}).length >= 2 && (t.rules || []).length;
    check('地盘表', !!terrOk,
      terrOk ? t.ruleOwner + ' 是规则负责人 · ' + Object.keys(t.scenes).length + ' 个场景有地盘 · '
        + (t.rules || []).length + ' 份 A 档规矩'
        : 'territory.json 读不到或没填全');

    // 五档各判一次，确认判据真的分得开
    const ownerId = authority.resolveSceneId(t.ruleOwner || 'command');
    const own = authority.check('backend/memory/' + ownerId + '/定位卡.md', ownerId);
    const other = authority.check('backend/memory/research/场景私有记忆.md', t.ruleOwner || 'command');
    const rule = authority.check((t.rules || [])[0] || 'territory.json', 'research');
    const tool = authority.check('lib/authority.mjs', 'research');
    const tiers = new Set([own.tier, other.tier, rule.tier, tool.tier]);
    check('分档判定', own.allowed && !other.allowed && !rule.allowed && !tool.allowed,
      '自己地盘 ' + own.tier + ' 允许 · 别人的 ' + other.tier + ' 拒绝 · 规矩 ' + rule.tier
      + ' 拒绝 · 工具 ' + tool.tier + ' 拒绝');

    // 越界审计
    const sessions = [];
    for (const sc of loadScenes()) {
      for (const p2 of sc.panels || []) {
        if (p2.type === 'harness' && p2.sessionId) sessions.push({ sessionId: p2.sessionId, scene: sc.id });
      }
    }
    const rep = authority.audit({ sessions });
    check('越界审计', rep.violations.length === 0,
      rep.violations.length
        ? rep.violations.length + ' 次越界：' + rep.violations.slice(0, 3).map((v) => v.scene + '→' + v.path).join('；')
        : '扫了 ' + rep.scanned + ' 个会话 / ' + rep.touches.length + ' 次写入，0 次越界');
  }

  // ⑭ 越界审计的负例自测（正例与负例一起跑，才知道它没在瞎报）
  {
    const at = selftest.authoritySelfTest();
    check('越界审计自测', at.ok, at.rows.map((r) => r.detail).join('；'));
  }

  // ⑮ 分诊：唯一对口能不能判出归属
  {
    const t = authority.loadTerritory();
    const rules = (t.soleResponsibility || []).length;
    const hit = triage.suggestOwner('清理一下 data/ 里的旧日志');
    const miss = triage.suggestOwner('随便看看');
    // ⚠ 判据不是「必须判给某个固定角色」（角色会增删），而是
    //   **判出来的那个角色必须真的存在** —— 指向一个被删掉的角色，
    //   分诊就会把活派给空气。
    const alive = new Set(loadScenes().map((s) => s.id));
    const ok = rules > 0 && hit && alive.has(hit.scene) && !miss;
    check('唯一对口判定', ok,
      rules + ' 条规则 · 「清理…」⇒ ' + (hit ? hit.sceneName + (alive.has(hit.scene) ? '' : '（⚠ 角色不存在）') : '?')
      + ' · 「随便看看」⇒ ' + (miss ? miss.sceneName : '没有对口场景（该问机主）'));

    const rep = triage.scan({ scenes: loadScenes(), sessionIds: [] });
    check('分诊扫描', true,
      '扫出 ' + rep.counts.total + ' 条 · 有主 ' + rep.counts.owned
      + ' · 无主 ' + rep.counts.unowned + '（每条无主都带建议或「问机主」）');
  }

  // ⑯ 写痕自测：写盘前重读 / 写入权 / 写后自证 / 撞车检测
  {
    const wt = selftest.writelogSelfTest();
    check('写痕自测', wt.ok, wt.rows.map((r) => r.detail).join('；'));
  }

  // ⑰ 当前有没有真撞车
  {
    const sessions = [];
    for (const sc of loadScenes()) {
      for (const p2 of sc.panels || []) {
        if (p2.type === 'harness' && p2.sessionId) sessions.push({ sessionId: p2.sessionId, scene: sc.id, sceneName: sc.name });
      }
    }
    const hist = writelog.buildHistory({ sessions });
    const lost = hist.collisions.filter((c) => c.lostCount > 0);
    check('写痕与撞车', lost.length === 0,
      hist.collisions.length === 0
        ? hist.writeCount + ' 次写入，没有同路径两个写入者'
        : hist.collisions.length + ' 次撞车（其中 ' + lost.length + ' 次真的丢了行）'
          + '：' + hist.collisions.slice(0, 2).map((c) => c.byName + '→' + c.overName).join('；'));
  }

  const fail = rows.filter((r) => !r.ok).length;
  return { rows, fail, ok: fail === 0 };
}

/** 人读的输出（脚本入口用）。 */
export function format(report) {
  const lines = [''];
  for (const r of report.rows) {
    lines.push((r.ok ? '✓ ' : '✗ ') + r.name + (r.detail ? ' — ' + r.detail : ''));
  }
  lines.push('');
  lines.push(report.ok ? '✅ 全部通过' : '⛔ ' + report.fail + ' 项未通过');
  lines.push('');
  return lines.join('\n');
}
