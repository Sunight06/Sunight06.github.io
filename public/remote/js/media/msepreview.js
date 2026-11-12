// 实时预览的第二条路：MediaSource（MSE）。
//
// 为什么需要：无线模式下网页由手机通过 http://局域网IP 提供，不是安全上下文，浏览器不给 WebCodecs
// （VideoDecoder 只在 https / localhost 下存在）。MSE 没有这个限制。
//
// 做法：把收到的每一帧立刻封成一个只含这一帧的 fMP4 分片喂给隐藏的 <video>，再用
// requestVideoFrameCallback 把画面画到原来那块 canvas 上——鼠标键盘控制、截图都不用改。
// 播放位置始终追着缓冲尾巴走（落后超过 0.25 秒就跳过去），延迟与 WebCodecs 相当。

import { Fmp4Writer } from './fmp4.js';
import { parseVideoConfig, toLengthPrefixed } from './nal.js';

export class MsePreview {
  static supported() { return typeof MediaSource !== 'undefined'; }

  constructor(canvas, { onStatus, onFrame } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onStatus = onStatus;
    this.onFrame = onFrame;
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    // 不能 display:none：浏览器会停掉看不见的视频的解码与出帧。1 像素、几乎透明、不挡点击。
    Object.assign(this.video.style, { position: 'fixed', left: '0', top: '0', width: '1px', height: '1px', opacity: '0.01', pointerEvents: 'none' });
    document.documentElement.appendChild(this.video);
    this.queue = [];
    this.writer = null;
    this.sourceBuffer = null;
    this.mediaSource = null;
    this.needKey = true;
    this.basePts = null;
    this.drawLoop();
  }

  reset() {
    this.writer = null;
    this.sourceBuffer = null;
    this.queue = [];
    this.needKey = true;
    this.basePts = null;
    this.initSent = false;
    if (this.mediaSource) {
      try { URL.revokeObjectURL(this.video.src); } catch { /* ignore */ }
      this.video.removeAttribute('src');
      this.video.load();
      this.mediaSource = null;
    }
  }

  /** 新的配置包（新会话、转屏、RESET_VIDEO）：重建 MediaSource。 */
  configure(codec, size, configPacket) {
    this.reset();
    let cfg;
    try { cfg = parseVideoConfig(codec, configPacket); } catch (e) { this.onStatus?.(`预览不可用：${e.message}`); return; }
    const mime = `video/mp4; codecs="${cfg.codecString}"`;
    if (!MediaSource.isTypeSupported(mime)) {
      this.onStatus?.(`此浏览器无法播放 ${codec.toUpperCase()} 预览（${cfg.codecString}）：录制不受影响；想看预览可在手机上把编码改为 H.264`);
      return;
    }
    this.codec = codec;
    const ms = new MediaSource();
    this.mediaSource = ms;
    this.video.src = URL.createObjectURL(ms);
    // 封装器立刻建好：配置包后面紧跟着的就是关键帧，要是等 sourceopen（异步）再建，
    // 那一帧会被丢掉，预览得干等下一个自然关键帧（可能好几秒）。产出先排队，SourceBuffer 好了再一起喂。
    this.writer = new Fmp4Writer({
      video: { ...cfg, width: size.width, height: size.height, rotation: 0 },
      audio: null,
      sink: async (bytes) => { this.queue.push(bytes); this.pump(); },
    });
    this.writer.start();
    ms.addEventListener('sourceopen', () => {
      if (this.mediaSource !== ms) return;
      const sb = ms.addSourceBuffer(mime);
      sb.mode = 'segments';
      sb.addEventListener('updateend', () => this.pump());
      this.sourceBuffer = sb;
      this.pump();
      this.video.play().catch(() => {});
    }, { once: true });
  }

  push(key, pts, data) {
    if (!this.writer) return;
    if (this.needKey && !key) return;
    this.needKey = false;
    if (this.basePts === null) this.basePts = pts;
    this.writer.addVideo(toLengthPrefixed(data, this.codec), pts - this.basePts, key);
    // 每帧都出一个分片：上一帧（有了时长）立刻可播，只差一帧的延迟。
    this.writer.flush();
  }

  pump() {
    const sb = this.sourceBuffer;
    // SourceBuffer 还没就绪时不必等：先在这里看一眼积压，就绪后再喂。
    if (!sb && this.queue.length > 240) { this.queue.length = this.initSent ? 0 : 1; this.needKey = true; }
    if (!sb || sb.updating || !this.queue.length || this.mediaSource?.readyState !== 'open') return;
    // 积压太多（标签页在后台）：只留开头的初始化段，其余丢掉，等下一个关键帧重新开始，别让内存涨起来。
    if (this.queue.length > 240) { this.queue.length = this.initSent ? 0 : 1; this.needKey = true; }
    const parts = this.queue.splice(0, this.queue.length);
    let total = 0;
    for (const p of parts) total += p.length;
    const merged = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { merged.set(p, off); off += p.length; }
    try {
      sb.appendBuffer(merged);
      this.initSent = true;
    } catch (e) {
      if (e.name === 'QuotaExceededError') this.trim(true);
      else this.onStatus?.(`预览出错：${e.message}`);
    }
  }

  /** 只留最近几秒，避免缓冲越积越大。 */
  trim(force = false) {
    const sb = this.sourceBuffer;
    if (!sb || sb.updating || !sb.buffered.length) return;
    const end = sb.buffered.end(sb.buffered.length - 1);
    const start = sb.buffered.start(0);
    if (force || end - start > 10) {
      try { sb.remove(start, Math.max(start, end - 3)); } catch { /* 下次再收 */ }
    }
  }

  drawLoop() {
    const v = this.video;
    let lastTime = -1;
    // requestVideoFrameCallback 在看不见的 <video> 上不会触发，所以用动画帧轮询：时间前进了才画。
    // 有的环境（嵌入式浏览器、窗口被遮挡）动画帧不来，再挂一个 33ms 的定时器兜底。
    let lastTick = 0;
    const step = () => {
      lastTick = performance.now();
      if (v.readyState >= 2 && v.currentTime !== lastTime && v.videoWidth) {
        lastTime = v.currentTime;
        this.ctx.drawImage(v, 0, 0, this.canvas.width, this.canvas.height);
        this.onFrame?.();
      }
      const b = v.buffered;
      if (b.length) {
        const end = b.end(b.length - 1);
        // 追实时：落后缓冲尾巴太多就跳过去；停住了（缓冲刚续上）就接着播。
        if (end - v.currentTime > 0.25) v.currentTime = Math.max(b.start(b.length - 1), end - 0.05);
        if (v.paused) v.play().catch(() => {});
      }
      this.trim();
    };
    const tick = () => { step(); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    setInterval(() => { if (performance.now() - lastTick > 100) step(); }, 33);
  }

}
