'use strict';
/**
 * asmltr-insights — system metrics sampler (plan §B4).
 *
 * In-process interval (no cron sprawl). Writes system_metrics + a 'system-sample'
 * timeline event each tick. For deeper per-core/per-process infra metrics, add
 * Netdata as a separate Authelia-protected service — don't reimplement it here.
 */

const os = require('os');
const { execFile } = require('child_process');

let _prevCpu = null;

/** CPU utilization % since the last sample (busy delta / total delta across cores). */
function cpuPct() {
  const cpus = os.cpus();
  let idle = 0, total = 0;
  for (const c of cpus) {
    for (const t of Object.values(c.times)) total += t;
    idle += c.times.idle;
  }
  if (!_prevCpu) { _prevCpu = { idle, total }; return 0; }
  const dIdle = idle - _prevCpu.idle;
  const dTotal = total - _prevCpu.total;
  _prevCpu = { idle, total };
  if (dTotal <= 0) return 0;
  return Math.round((1 - dIdle / dTotal) * 1000) / 10;
}

/** Root-filesystem usage via df -P / (used% + free GB). */
function diskUsage() {
  return new Promise((resolve) => {
    execFile('df', ['-Pk', '/'], (err, stdout) => {
      if (err) return resolve({ disk_used_pct: null, disk_free_gb: null });
      const line = stdout.trim().split('\n').pop().split(/\s+/);
      // Filesystem 1024-blocks Used Available Capacity Mounted
      const usedPct = parseFloat(line[4]);
      const availKb = parseInt(line[3], 10);
      resolve({
        disk_used_pct: Number.isFinite(usedPct) ? usedPct : null,
        disk_free_gb: Number.isFinite(availKb) ? Math.round((availKb / 1024 / 1024) * 10) / 10 : null,
      });
    });
  });
}

// Swap from /proc/meminfo (Linux). Returns {swap_used_mb, swap_total_mb}; zeros if unavailable.
function swapUsage() {
  try {
    const m = require('fs').readFileSync('/proc/meminfo', 'utf8');
    const kb = (k) => { const r = new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(m); return r ? Number(r[1]) : 0; };
    const total = kb('SwapTotal'), free = kb('SwapFree');
    return { swap_total_mb: Math.round(total / 1024), swap_used_mb: Math.round((total - free) / 1024) };
  } catch { return { swap_total_mb: 0, swap_used_mb: 0 }; }
}

async function sample() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const load = os.loadavg();
  const disk = await diskUsage();
  const swap = swapUsage();
  return {
    ts: Date.now(),
    cpu_pct: cpuPct(),
    load1: Math.round(load[0] * 100) / 100,
    load5: Math.round(load[1] * 100) / 100,
    mem_used_mb: Math.round((totalMem - freeMem) / 1048576),
    mem_total_mb: Math.round(totalMem / 1048576),
    swap_used_mb: swap.swap_used_mb,
    swap_total_mb: swap.swap_total_mb,
    disk_used_pct: disk.disk_used_pct,
    disk_free_gb: disk.disk_free_gb,
  };
}

/** Start periodic sampling. Returns stop(). */
function start(db, intervalMs, onSample) {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const s = await sample();
      db.insertSystemSample(s);
      if (onSample) onSample(s);
    } catch (err) {
      console.error('[sampler] tick failed:', err.message);
    }
  };
  tick();
  const handle = setInterval(tick, intervalMs);
  return () => { stopped = true; clearInterval(handle); };
}

module.exports = { sample, start };
