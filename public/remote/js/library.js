// 视频列表：电脑端录好的每一个文件（完整录像、分段、回放片段）都进这里。
//
// 来源两处：本次打开页面以来写完的文件；以及保存文件夹里已有的 .mp4（刷新页面后列表不丢）。
// 每条带一张小缩略图（JPEG base64），网页列表与手机端列表共用。
// 「已回传」按文件名记在 localStorage，换个时间打开页面也知道哪些已经到过手机。

const SENT_KEY = 'sunight.remote.sent.v1';
const THUMB_WIDTH = 240;

function loadSent() {
  try { return new Set(JSON.parse(localStorage.getItem(SENT_KEY) ?? '[]')); } catch { return new Set(); }
}

export class Library {
  constructor({ onChange, onLog } = {}) {
    this.items = []; // { id, name, size, durationMs, where, at, thumb, sent, getFile }
    this.sent = loadSent();
    this.onChange = onChange;
    this.onLog = onLog;
    this.seq = 0;
    this.thumbQueue = Promise.resolve();
  }

  changed() { this.onChange?.(); }

  /** 给界面 / 手机的精简视图（不含缩略图：缩略图另取，免得每次状态广播都带几百 KB）。 */
  view() {
    return this.items.map(({ id, name, size, durationMs, where, at, sent }) => ({ id, name, size, durationMs, where, at, sent, hasThumb: !!this.thumbOf(id), inBrowser: where === '浏览器内' || where === '本次打开的页面' }));
  }

  /** 给手机的完整列表（含缩略图）。 */
  listForPhone() {
    return this.items.map(({ id, name, size, durationMs, at, sent, thumb }) => ({ id, name, size, durationMs, at, sent, thumb: thumb ?? '' }));
  }

  thumbOf(id) { return this.items.find((x) => x.id === id)?.thumb ?? ''; }
  get(id) { return this.items.find((x) => x.id === id); }

  /** 刚录完的一个文件。 */
  add({ name, size, durationMs = 0, where = '', file, remove }) {
    const existing = this.items.find((x) => x.name === name);
    if (existing) this.items.splice(this.items.indexOf(existing), 1);
    const item = { id: `v${++this.seq}`, name, size, durationMs, where, at: Date.now(), thumb: '', sent: this.sent.has(name), getFile: file, remove };
    this.items.unshift(item);
    this.changed();
    this.makeThumb(item);
    return item;
  }

  /** 扫一遍保存文件夹里的 .mp4（按修改时间倒序），补进列表。没有读权限时什么都不做。 */
  async scanFolder(folder, where = folder?.name) {
    if (!folder) return;
    try {
      if (folder.queryPermission && (await folder.queryPermission({ mode: 'readwrite' })) !== 'granted') return;
      const found = [];
      for await (const [name, handle] of folder.entries()) {
        if (handle.kind !== 'file' || !/\.mp4$/i.test(name) || this.items.some((x) => x.name === name)) continue;
        const file = await handle.getFile();
        if (file.size < 1024) continue;
        found.push({ name, size: file.size, at: file.lastModified, handle });
      }
      found.sort((a, b) => b.at - a.at);
      for (const f of found.slice(0, 100)) {
        const item = { id: `v${++this.seq}`, name: f.name, size: f.size, durationMs: 0, where, at: f.at, thumb: '', sent: this.sent.has(f.name), getFile: () => f.handle.getFile(), remove: () => folder.removeEntry(f.name) };
        this.items.push(item);
        this.makeThumb(item);
      }
      this.items.sort((a, b) => b.at - a.at);
      if (found.length) this.changed();
    } catch (e) {
      this.onLog?.(`读取保存文件夹失败：${e.message}`);
    }
  }

  /**
   * 删除：保存文件夹里的文件真的删掉；浏览器下载的那种（文件在下载目录里，网页够不着）只从列表移除。
   * 返回 { removed, failed }。
   */
  async delete(ids) {
    let removed = 0;
    const failed = [];
    for (const id of ids) {
      const item = this.get(id);
      if (!item) continue;
      try {
        await item.remove?.();
        this.items.splice(this.items.indexOf(item), 1);
        removed++;
      } catch (e) {
        failed.push(`${item.name}：${e.message}`);
      }
    }
    if (removed) this.changed();
    return { removed, failed };
  }

  markSent(name) {
    this.sent.add(name);
    localStorage.setItem(SENT_KEY, JSON.stringify([...this.sent].slice(-500)));
    const item = this.items.find((x) => x.name === name);
    if (item) item.sent = true;
    this.changed();
  }

  /** 缩略图：用一个看不见的 <video> 打开文件，取第 0.5 秒左右的一帧缩到 240 宽。串行做，避免同时开一堆解码器。 */
  makeThumb(item) {
    this.thumbQueue = this.thumbQueue.then(() => this.grab(item)).catch(() => {});
  }

  async grab(item) {
    const blob = await item.getFile();
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.playsInline = true;
    Object.assign(video.style, { position: 'fixed', left: '0', top: '0', width: '1px', height: '1px', opacity: '0.01', pointerEvents: 'none' });
    document.documentElement.appendChild(video);
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 8000);
        video.onloadeddata = () => { clearTimeout(timer); resolve(); };
        video.onerror = () => { clearTimeout(timer); reject(new Error('无法解码')); };
        video.src = url;
      });
      if (Number.isFinite(video.duration) && video.duration > 0) {
        if (!item.durationMs) item.durationMs = Math.round(video.duration * 1000);
        const at = Math.min(0.5, video.duration / 3);
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 3000);
          video.onseeked = () => { clearTimeout(timer); resolve(); };
          video.currentTime = at;
        });
      }
      const w = THUMB_WIDTH;
      const h = Math.max(1, Math.round((video.videoHeight / video.videoWidth) * w));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(video, 0, 0, w, h);
      item.thumb = canvas.toDataURL('image/jpeg', 0.72).split(',')[1] ?? '';
      this.changed();
    } catch {
      // 浏览器解不了这个编码（例如 H.265）：列表里显示占位图标即可。
    } finally {
      video.remove();
      URL.revokeObjectURL(url);
    }
  }
}
