// 转正重编码：「智能自动 / 横屏 / 竖屏」录制时用。
//
// 手机端的采集方向是锁定的（帧尺寸从头到尾不变），转屏后内容在帧里是躺着的。
// 这里在电脑上把每一帧解出来、按当前转向摆正、等比放大铺满一个固定尺寸的画布（多出来的裁掉），
// 再用浏览器的硬件编码器重新编码——录出来的是一个完整文件，转屏前后画面始终是正的、没有黑边。
// 「高性能自动」不走这里：直接写手机原样送来的码流。
//
// 输出仍按 scrcpy 的包格式交给 Recorder：先一个配置包（参数集），之后每帧 Annex-B 数据。

import { parseVideoConfig, splitAnnexB, h264Type, h265Type } from './nal.js';

const CODEC_CANDIDATES = {
  h264: ['avc1.640034', 'avc1.640033', 'avc1.640032', 'avc1.64002A'],
  h265: ['hvc1.1.6.L156.B0', 'hvc1.1.6.L153.B0', 'hvc1.1.6.L150.B0', 'hvc1.1.6.L123.B0'],
};

export class Transcoder {
  /**
   * @param codec   'h264' | 'h265'（编码器不支持 H.265 时自动退到 H.264）
   * @param width/height 输出尺寸（固定）
   * @param rotation () => 0..3：此刻要把内容顺时针转几个 90° 才是正的
   * @param onPacket (packet) => void：与 scrcpy 视频包同形
   */
  constructor({ codec, width, height, bitrate, fps, keyFrameSeconds = 2, constantBitrate = false, rotation, onPacket, onLog }) {
    this.codec = codec;
    /** 手机设置里选了 CBR（恒定码率）时重编码也用恒定码率。 */
    this.constantBitrate = constantBitrate;
    this.width = width & ~1;
    this.height = height & ~1;
    this.bitrate = bitrate;
    this.fps = fps;
    this.keyEvery = Math.max(1, Math.round(keyFrameSeconds * fps));
    this.rotation = rotation;
    this.onPacket = onPacket;
    this.onLog = onLog;
    this.canvas = new OffscreenCanvas(this.width, this.height);
    this.ctx = this.canvas.getContext('2d');
    this.frameCount = 0;
    this.forceKey = true;
    this.sentConfig = false;
    this.closed = false;
    this.ready = new Promise((resolve) => { this.resolveReady = resolve; });
  }

  static supported() { return typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined' && typeof OffscreenCanvas !== 'undefined'; }

  async open() {
    for (const codec of [this.codec, 'h264']) {
      for (const string of CODEC_CANDIDATES[codec]) {
        const config = {
          codec: string, width: this.width, height: this.height, bitrate: this.bitrate, framerate: this.fps,
          latencyMode: 'realtime', bitrateMode: this.constantBitrate ? 'constant' : 'variable', hardwareAcceleration: 'prefer-hardware',
          ...(codec === 'h264' ? { avc: { format: 'annexb' } } : { hevc: { format: 'annexb' } }),
        };
        const { supported } = await VideoEncoder.isConfigSupported(config).catch(() => ({ supported: false }));
        if (!supported) continue;
        this.outCodec = codec;
        this.encoder = new VideoEncoder({
          output: (chunk) => this.onEncoded(chunk),
          error: (e) => this.onLog?.(`重编码出错：${e.message}`),
        });
        this.encoder.configure(config);
        if (codec !== this.codec) this.onLog?.('这台电脑不能硬件编码 H.265，改用 H.264 录制');
        this.onLog?.(`转正重编码：${codec.toUpperCase()} ${this.width}×${this.height}（${string}）`);
        return codec;
      }
    }
    throw new Error('这台电脑的浏览器不能编码这个尺寸的视频，请在手机上把方向改成「高性能自动」');
  }

  /** scrcpy 的原始视频包。 */
  push({ config, key, pts, data }, codec) {
    if (this.closed) return;
    if (config) {
      try { this.decoder?.close(); } catch { /* ignore */ }
      const cfg = parseVideoConfig(codec, data);
      this.inCodec = codec;
      this.decoder = new VideoDecoder({
        output: (frame) => this.onFrame(frame),
        error: (e) => this.onLog?.(`重编码解码出错：${e.message}`),
      });
      this.decoder.configure({ codec: cfg.codecString, description: cfg.record, hardwareAcceleration: 'prefer-hardware' });
      this.needKey = true;
      return;
    }
    if (!this.decoder || this.decoder.state !== 'configured') return;
    if (this.needKey && !key) return;
    this.needKey = false;
    this.decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: pts, data: toLengthPrefixedIn(data, this.inCodec) }));
  }

  requestKeyFrame() { this.forceKey = true; }

  onFrame(frame) {
    if (this.closed || !this.encoder || this.encoder.state !== 'configured') { frame.close(); return; }
    // 编码器跟不上时丢帧（不是关键帧请求的那一帧）：宁可帧率掉一点，也不让延迟和内存越积越多。
    if (this.encoder.encodeQueueSize > 6 && !this.forceKey) { frame.close(); return; }
    const W = this.width;
    const H = this.height;
    const q = this.rotation() || 0;
    const fw = frame.displayWidth;
    const fh = frame.displayHeight;
    const rw = q % 2 ? fh : fw;
    const rh = q % 2 ? fw : fh;
    const scale = Math.max(W / rw, H / rh); // 铺满（cover），多出来的裁掉
    const g = this.ctx;
    g.save();
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    g.translate(W / 2, H / 2);
    g.rotate((q * Math.PI) / 2);
    g.drawImage(frame, (-fw * scale) / 2, (-fh * scale) / 2, fw * scale, fh * scale);
    g.restore();
    const timestamp = frame.timestamp;
    frame.close();
    const out = new VideoFrame(this.canvas, { timestamp });
    const keyFrame = this.forceKey || this.frameCount % this.keyEvery === 0;
    this.forceKey = false;
    this.encoder.encode(out, { keyFrame });
    out.close();
    this.frameCount++;
  }

  onEncoded(chunk) {
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    const key = chunk.type === 'key';
    if (key) {
      // 关键帧自带参数集（Annex-B 模式）：摘出来当配置包，第一次或变化时先发。
      const typeOf = this.outCodec === 'h264' ? h264Type : h265Type;
      const isParam = this.outCodec === 'h264' ? (t) => t === 7 || t === 8 : (t) => t >= 32 && t <= 34;
      const params = splitAnnexB(data).filter((n) => isParam(typeOf(n)));
      if (params.length) {
        const cfg = joinAnnexB(params);
        if (!this.sentConfig || !sameBytes(cfg, this.lastConfig)) {
          this.lastConfig = cfg;
          this.sentConfig = true;
          this.onPacket({ config: true, key: false, pts: null, data: cfg });
          this.resolveReady();
        }
      }
    }
    if (!this.sentConfig) return;
    this.onPacket({ config: false, key, pts: chunk.timestamp, data });
  }

  close() {
    this.closed = true;
    try { this.decoder?.close(); } catch { /* ignore */ }
    try { this.encoder?.close(); } catch { /* ignore */ }
  }
}

function joinAnnexB(nals) {
  const total = nals.reduce((n, x) => n + 4 + x.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const n of nals) { out.set([0, 0, 0, 1], o); out.set(n, o + 4); o += 4 + n.length; }
  return out;
}

function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** 解码器要的是长度前缀格式（带 description 配置时）。 */
function toLengthPrefixedIn(data, codec) {
  const nals = splitAnnexB(data).filter((n) => {
    const t = codec === 'h264' ? h264Type(n) : h265Type(n);
    return codec === 'h264' ? !(t === 7 || t === 8 || t === 9) : !(t >= 32 && t <= 35);
  });
  const total = nals.reduce((n, x) => n + 4 + x.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const n of nals) { new DataView(out.buffer).setUint32(o, n.length); out.set(n, o + 4); o += 4 + n.length; }
  return out;
}
