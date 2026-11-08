// GPU 优先 —— ★ 判据集中在这一个文件里，别处不许再定义一套
//
// 唯一判据：**「这个活的数据是不是要在这台机器上算？」**
//   不是 ⇒ 别动 GPU 的心思（你调的是远端 API，本地 GPU 完全不参与）
//
// 只有三类活真的能用 GPU：
//   OCR（文字识别）· 视频编码 · 三维渲染
//
// 三条硬规矩：
//   ① 判据只写一处 ⇒ 所有脚本都调 shouldUseGpu()
//   ② 判据拿不到 ⇒ **照 CPU 跑并记 why**（降级不是失败）
//   ③ 退 CPU 是「另一套参数」，不是「直接跑」：单进程 + 线程≤2 + BelowNormal
//
// 验收三条（"能跑通"不算证据）：
//   ① providers 列表里出现 CUDA（不是 CPUExecutionProvider 兜底）
//   ② 有量化指标：秒/页 · fps · 采样速度
//   ③ 显存占用有数字

import { spawn } from 'node:child_process';

export const GPU_KINDS = {
  ocr: { label: 'OCR（文字识别）', why: '纯本地视觉推理，批量大', eligible: true },
  video: { label: '视频编码', why: '硬件编码器是独立单元', eligible: true },
  render: { label: '三维渲染', why: '天生就是 GPU 活', eligible: true },
};

export const REMOTE_KINDS = {
  llm: { label: '大模型推理 / 对话', why: '你调的是远端 API，本地 GPU 完全不参与', eligible: false },
  image: { label: 'AI 生图（云端服务）', why: '同上，远端算的', eligible: false },
  other: { label: '其它 / 说不清', why: '判据：数据是不是要在这台机器上算？说不清就按 CPU 跑并记 why', eligible: false },
};

export const ALL_KINDS = { ...GPU_KINDS, ...REMOTE_KINDS };

/** 从一句任务描述里猜类别（只是给个建议，最终以显式选的 kind 为准）。 */
export function classifyTask(text) {
  const t = String(text || '');
  const rules = [
    ['ocr', /ocr|文字识别|图片转文字|扫版|识别文字|extract text/i],
    ['video', /视频|编码|转码|压制|剪辑|ffmpeg|av1|h\.?26[45]/i],
    ['render', /渲染|建模|blender|comfyui|三维|3d|出图到模型/i],
    ['llm', /大模型|对话|推理|llm|chat|写代码|写文档|翻译|总结/i],
    ['image', /生图|画图|文生图|图像生成|midjourney|stable ?diffusion/i],
  ];
  for (const [kind, re] of rules) {
    if (re.test(t)) {
      const k = ALL_KINDS[kind];
      return { kind, label: k.label, why: k.why, eligible: k.eligible, guessed: true };
    }
  }
  const k = REMOTE_KINDS.other;
  return { kind: 'other', label: k.label, why: k.why, eligible: false, guessed: true };
}

/**
 * ★ 唯一判据函数。
 * @param {string} kind 显式类别（ocr/video/render/llm/image/other）
 * @param {object} probe 探测结果（probeGpu() 的输出）
 * @returns {{useGpu:boolean, kind:string, label:string, why:string, path:string, params:object}}
 */
export function shouldUseGpu(kind, probe) {
  const k = ALL_KINDS[kind] || REMOTE_KINDS.other;
  const base = { kind: ALL_KINDS[kind] ? kind : 'other', label: k.label, why: k.why };

  // ① 类别本身就不该上 GPU
  if (!k.eligible) {
    return {
      ...base,
      useGpu: false,
      path: 'remote-api',
      why: k.why,
      params: {},
    };
  }

  // ② 类别够格，但本机没有可用 GPU ⇒ 照 CPU 跑并记 why（降级不是失败）
  if (!probe || !probe.available) {
    return {
      ...base,
      useGpu: false,
      path: 'cpu',
      why: k.why + '；但本机探测不到可用 GPU ⇒ 照 CPU 跑（降级不是失败）'
        + (probe && probe.why ? '（' + probe.why + '）' : ''),
      params: cpuFallbackParams(),
    };
  }

  // ③ 类别够格 + 有 GPU
  const enc = probe.encoders || [];
  const byKind = {
    ocr: probe.providers && probe.providers.includes('CUDAExecutionProvider'),
    video: enc.includes('h264_nvenc') || enc.includes('hevc_nvenc') || enc.includes('av1_nvenc') || enc.includes('videotoolbox'),
    render: !!probe.renderBackends,
  };
  if (!byKind[kind]) {
    return {
      ...base,
      useGpu: false,
      path: 'cpu',
      why: k.why + '；但本机 GPU 没装对应的加速后端（'
        + (kind === 'ocr' ? 'onnxruntime 无 CUDA provider'
          : kind === 'video' ? 'ffmpeg 无 nvenc/videotoolbox 编码器'
            : '没找到渲染后端') + '）⇒ 照 CPU 跑',
      params: cpuFallbackParams(),
    };
  }

  return {
    ...base,
    useGpu: true,
    path: 'gpu',
    why: k.why + '；本机 GPU 可用（' + (probe.name || 'unknown') + '）',
    params: {},
  };
}

/** 退 CPU 的三条硬约束 —— 不是「直接跑」，是另一套参数。 */
export function cpuFallbackParams() {
  return {
    processes: 1,
    env: { OMP_NUM_THREADS: '2', MKL_NUM_THREADS: '2', OPENBLAS_NUM_THREADS: '2' },
    priority: 'BelowNormal',
    note: '单进程 + 线程≤2 + BelowNormal。不设这三条，退 CPU 比不跑更糟。',
  };
}

/** 验收三条 —— 缺一不算「真的用上 GPU」。 */
export function acceptanceCheck(report = {}) {
  const checks = [
    {
      name: '① providers 里有 CUDA（不是 CPUExecutionProvider 兜底）',
      ok: Array.isArray(report.providers) && report.providers.includes('CUDAExecutionProvider'),
      detail: report.providers ? ('providers = ' + report.providers.join(', ')) : '没报 providers',
    },
    {
      name: '② 有量化指标（秒/页 · fps · 采样速度）',
      ok: typeof report.metric === 'number' && report.metric > 0,
      detail: report.metric ? (report.metric + ' ' + (report.metricUnit || '')) : '没报量化指标',
    },
    {
      name: '③ 显存占用有数字',
      ok: typeof report.vramMB === 'number' && report.vramMB > 0,
      detail: report.vramMB ? (report.vramMB + ' MB') : '没报显存',
    },
  ];
  return { checks, ok: checks.every((c) => c.ok), okCount: checks.filter((c) => c.ok).length };
}

/* ── 探测（只读） ─────────────────────────────────────────────── */

function run(cmd, args, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) { resolve({ ok: false, out: '', err: String(e && e.message || e) }); return; }
    let out = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.stderr.on('data', () => {});
    child.on('error', (e) => finish({ ok: false, out, err: String(e && e.message || e) }));
    child.on('close', (code) => finish({ ok: code === 0, out, err: code === 0 ? '' : ('退出码 ' + code) }));
    setTimeout(() => { try { child.kill(); } catch (e) { /* ignore */ } finish({ ok: false, out, err: '超时' }); }, timeoutMs);
  });
}

let probeCache = null;
let probeAt = 0;

/** 探测本机 GPU 情况（结果缓存 60 秒，避免每次点按钮都跑一遍）。 */
export async function probeGpu(force = false) {
  if (!force && probeCache && Date.now() - probeAt < 60000) return probeCache;
  probeAt = Date.now();

  const notes = [];
  const probe = {
    available: false,
    vendor: '',
    name: '',
    vramMB: 0,
    providers: [],
    encoders: [],
    renderBackends: null,
    why: '',
    notes,
    at: new Date().toISOString(),
  };

  // NVIDIA
  const nv = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
  if (nv.ok && nv.out.trim()) {
    const first = nv.out.trim().split('\n')[0].split(',');
    probe.vendor = 'NVIDIA';
    probe.name = (first[0] || '').trim();
    probe.vramMB = Number((first[1] || '0').trim()) || 0;
    probe.available = true;
    notes.push('nvidia-smi：' + probe.name + ' · 显存 ' + probe.vramMB + ' MB');
  }

  // macOS / 其它：看看有没有独显或集成 GPU
  if (!probe.available) {
    const sp = await run('system_profiler', ['SPDisplaysDataType']);
    if (sp.ok && sp.out) {
      const chip = sp.out.match(/Chipset Model:\s*(.+)/);
      const vram = sp.out.match(/VRAM[^:]*:\s*(\d+)\s*MB/i);
      if (chip) {
        probe.vendor = 'Apple/其他';
        probe.name = chip[1].trim();
        probe.vramMB = vram ? Number(vram[1]) : 0;
        probe.available = true;
        notes.push('system_profiler：' + probe.name);
      }
    }
  }

  // onnxruntime 的 providers（OCR 用）
  const ort = await run('python3', ['-c',
    'import onnxruntime as o;print(",".join(o.get_available_providers()))']);
  if (ort.ok && ort.out.trim()) {
    probe.providers = ort.out.trim().split(/\s*,\s*/).filter(Boolean);
    notes.push('onnxruntime providers：' + probe.providers.join(', '));
  } else {
    notes.push('onnxruntime 没装或不可用 ⇒ OCR 一律照 CPU 跑');
  }

  // ffmpeg 的硬件编码器（视频用）
  const ff = await run('ffmpeg', ['-hide_banner', '-encoders']);
  if (ff.ok && ff.out) {
    const all = ff.out.split('\n').map((l) => l.trim()).filter(Boolean);
    for (const name of ['h264_nvenc', 'hevc_nvenc', 'av1_nvenc', 'videotoolbox', 'qsv']) {
      if (all.some((l) => l.includes(name))) probe.encoders.push(name);
    }
    notes.push('ffmpeg 硬件编码器：' + (probe.encoders.join(', ') || '（没有）'));
  } else {
    notes.push('ffmpeg 不可用 ⇒ 视频编码一律照 CPU 跑');
  }

  if (!probe.available) probe.why = '本机探测不到可用 GPU';
  probeCache = probe;
  return probe;
}
