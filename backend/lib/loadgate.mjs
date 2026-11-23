// 负载闸 —— ★ 判据只写在这一处，别处不许再定义一套
//
// 机主原话（2026-10-16，原样抄录）：
//   「现在定下一个规矩，系统内存以及cpu大于90的时候不可以再派子代理或者让助理ai干活，
//     不然电脑卡爆了，严格控制cpu占用和内存不超过95」
//
// 判据：
//   CPU  = 采样 3 次、间隔 1.5s、取均值（os.cpus() 累计 tick 差分）
//   内存 = (总量 − 可用) / 总量（即时同步读）
//   · 两项都 < 90%   ⇒ ok    可派单
//   · 任一 ≥ 90%     ⇒ warn  停止派单（不许唤醒别的会话）
//   · 任一 ≥ 95%     ⇒ stop  停重活（体检/批量/构建也别跑）
//   · 量不到         ⇒ unknown 闸门没跑成 —— **不是"可派单"**，按"别派"处理
//
// ⛔ 只读：不写文件、不改设置、不杀进程。

import os from 'node:os';
import { execFileSync } from 'node:child_process';

export const MIN_OK = 90;
export const MIN_WARN = 95;
export const SAMPLE_N = 3;
export const SAMPLE_INTERVAL_MS = 1500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 内存口径 —— ⛔ 这一条必须按平台修过：
 *
 *   `os.freemem()` 在 macOS 上**只算 free pages**，把 inactive / purgeable /
 *   speculative（可回收的）全漏掉 ⇒ 一台 16 GB 的机器明明还有 5 GB 可用，
 *   它会报「用了 99.9%」⇒ 负载闸永远喊停。
 *   （这是从 Windows 版原样搬过来最容易踩的坑。）
 *
 *   所以：darwin 走 vm_stat，按「free + inactive + purgeable + speculative」算可用；
 *   其它平台用 os.freemem()。vm_stat 起不来 ⇒ 退回 os.freemem() 并**标明是保守口径**。
 */
function readRam() {
  const total = os.totalmem();
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('vm_stat', [], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
      const pageSize = Number((out.match(/page size of (\d+) bytes/) || [])[1] || 4096);
      const grab = (key) => Number((out.match(new RegExp('^' + key + ':\\s+(\\d+)', 'm')) || [])[1] || 0);
      const free = grab('Pages free');
      const inactive = grab('Pages inactive');
      const purgeable = grab('Pages purgeable');
      const speculative = grab('Pages speculative');
      const available = (free + inactive + purgeable + speculative) * pageSize;
      if (available > 0 && available < total) {
        return {
          used: total - available,
          total,
          mode: 'vm_stat（free+inactive+purgeable+speculative）',
        };
      }
    } catch (e) { /* vm_stat 起不来 ⇒ 退回下面 */ }
  }
  const free = os.freemem();
  return {
    used: total - free,
    total,
    mode: process.platform === 'darwin'
      ? 'os.freemem()（保守口径：macOS 下可能高估占用）'
      : 'os.freemem()',
  };
}

function snap() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

function loadOf(a, b) {
  const dt = b.total - a.total;
  if (dt <= 0) return null;
  const busy = dt - (b.idle - a.idle);
  return Math.max(0, Math.min(100, (busy / dt) * 100));
}

/**
 * 跑一次闸门。
 * @param {object} opts
 * @param {number} opts.samples 采样次数（默认 3，⛔ 别改成 1 —— 单次太抖）
 * @param {number} opts.intervalMs 采样间隔（默认 1500）
 * @param {boolean} opts.fast 跳过等待（给 UI 用的快速估计，⚠ 只能当参考）
 */
export async function gate(opts = {}) {
  const n = Math.max(1, Number(opts.samples) || SAMPLE_N);
  const interval = Number(opts.intervalMs ?? SAMPLE_INTERVAL_MS);
  const started = Date.now();

  const ramTotal = os.totalmem();
  const ramInfo = readRam();
  const ram = ramInfo.total > 0 ? Math.round((ramInfo.used / ramInfo.total) * 1000) / 10 : null;

  const samples = [];
  let prev = snap();
  for (let i = 0; i < n; i++) {
    if (interval > 0) await sleep(interval);
    const cur = snap();
    const v = loadOf(prev, cur);
    if (v != null) samples.push(Math.round(v * 10) / 10);
    prev = cur;
  }

  if (!samples.length) {
    return verdictOf(null, ram, samples, started, 'os.cpus() 拿不到 tick 差分', ramInfo);
  }
  const cpu = Math.round((samples.reduce((a, b) => a + b, 0) / samples.length) * 10) / 10;
  return verdictOf(cpu, ram, samples, started, '', ramInfo);
}

function verdictOf(cpu, ram, samples, started, err, ramInfo) {
  let verdict = 'unknown';
  let reason = err || '';
  if (cpu != null && ram != null) {
    if (cpu >= MIN_WARN || ram >= MIN_WARN) {
      verdict = 'stop';
      const over = [];
      if (cpu >= MIN_WARN) over.push('CPU ' + cpu + '%');
      if (ram >= MIN_WARN) over.push('内存 ' + ram + '%');
      reason = over.join('、') + ' ≥ ' + MIN_WARN + '%';
    } else if (cpu >= MIN_OK || ram >= MIN_OK) {
      verdict = 'warn';
      const over = [];
      if (cpu >= MIN_OK) over.push('CPU ' + cpu + '%');
      if (ram >= MIN_OK) over.push('内存 ' + ram + '%');
      reason = over.join('、') + ' ≥ ' + MIN_OK + '%';
    } else {
      verdict = 'ok';
      reason = 'CPU ' + cpu + '% · 内存 ' + ram + '%';
    }
  }

  const text = {
    ok: '✓ 可派单',
    warn: '⚠ 停止派单（机器现在接不了活）',
    stop: '⛔ 停重活（机器已经满了）',
    unknown: '⚠ 闸门量不到 ⇒ 按「别派」处理',
  }[verdict];

  return {
    verdict,
    ok: verdict === 'ok',
    /** 只有 ok 才允许唤醒别的会话。warn/stop/unknown 一律不许。 */
    canDispatch: verdict === 'ok',
    canRunHeavy: verdict === 'ok' || verdict === 'warn',
    cpu, ram, samples,
    ramUsedMB: Math.round((ramInfo ? ramInfo.used : 0) / 1048576),
    ramTotalMB: Math.round((ramInfo ? ramInfo.total : 0) / 1048576),
    ramMode: ramInfo ? ramInfo.mode : '',
    cores: os.cpus().length,
    minOk: MIN_OK, minWarn: MIN_WARN,
    reason, text,
    elapsedMs: Date.now() - started,
    at: new Date().toISOString(),
  };
}

/** 一行摘要，给 CLI 用。 */
export function oneLine(g) {
  return `负载闸：CPU ${g.cpu ?? '?'}% · 内存 ${g.ram ?? '?'}% → ${g.text}（${g.reason}）`;
}
