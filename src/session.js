'use strict';
// A worker thread per open file (worker.js), with a memory cap and a watchdog per request. A request that does
// not answer in time kills the worker and is rejected with code 'TIMEOUT'; running out of memory gives 'MEMORY'.
// The extension host keeps running either way, and the next request starts a fresh worker that reads the file again.
const path = require('path');
const { Worker } = require('worker_threads');

const WORKER = path.join(__dirname, 'worker.js');
const MEMORY_MB = 2048;
const TIMEOUTS = { open: 90000, export: 120000, codebook: 90000, crosstab: 60000, view: 30000, summary: 30000, copy: 30000, page: 20000, crosstabText: 20000 };

class Session {
  constructor({ file, buffer, name, limits, memoryMb = MEMORY_MB, timeouts = {} } = {}) {
    this.src = { file, buffer, name, limits };
    this.memoryMb = memoryMb;
    this.timeouts = { ...TIMEOUTS, ...timeouts };
    this.w = null; this.pending = new Map(); this.seq = 0; this.meta = null; this.dead = null;
  }

  start() {
    const w = new Worker(WORKER, { resourceLimits: { maxOldGenerationSizeMb: this.memoryMb, maxYoungGenerationSizeMb: 64 } });
    this.w = w;
    w.on('message', (m) => {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id); clearTimeout(p.timer);
      if (m.ok) p.resolve(m.result); else { const e = new Error(m.error); e.code = m.code; p.reject(e); }
    });
    w.on('error', (err) => {
      const mem = err && err.code === 'ERR_WORKER_OUT_OF_MEMORY';
      const e = new Error(mem ? `Reading needed more than ${this.memoryMb} MB of memory and was stopped.` : String((err && err.message) || err));
      e.code = mem ? 'MEMORY' : 'WORKER';
      this.fail(e);
    });
    w.on('exit', (code) => { if (this.w === w) { const e = new Error(`The reader stopped (exit code ${code}).`); e.code = 'WORKER'; this.fail(e); } });
    return w;
  }

  fail(e) {
    const w = this.w; this.w = null; this.dead = e;
    if (w) w.terminate().catch(() => {});
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(e); }
    this.pending.clear();
  }

  request(job, transfer) {
    if (!this.w) this.start();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const ms = this.timeouts[job.op] || 30000;
      const timer = setTimeout(() => {
        const e = new Error(job.op === 'open' ? `Reading took longer than ${Math.round(ms / 1000)} seconds and was stopped.` : `This took longer than ${Math.round(ms / 1000)} seconds and was stopped.`);
        e.code = 'TIMEOUT';
        this.fail(e);
      }, ms);
      this.pending.set(id, { resolve, reject, timer });
      this.w.postMessage({ id, job }, transfer || []);
    });
  }

  /** Read the file (again, after a failure). Returns the dataset description. */
  async open() {
    this.dead = null;
    let buffer = this.src.buffer, transfer;
    if (buffer) { buffer = buffer.slice(0); transfer = [buffer]; }
    this.meta = await this.request({ op: 'open', file: this.src.file, buffer, name: this.src.name, limits: this.src.limits }, transfer);
    return this.meta;
  }

  /** A request on the loaded file; when the worker died, it reads the file again first. */
  async call(job) {
    if (!this.w || this.dead) {
      await this.open();
      if (this.viewJob && job.op !== 'view') await this.request(this.viewJob); // the sort and filter come back too
    }
    if (job.op === 'view') this.viewJob = job;
    return this.request(job);
  }

  dispose() { const w = this.w; this.w = null; if (w) w.terminate().catch(() => {}); for (const p of this.pending.values()) { clearTimeout(p.timer); } this.pending.clear(); }
}

module.exports = { Session, WORKER, TIMEOUTS };
