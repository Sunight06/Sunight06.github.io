// 录制状态机：把 scrcpy 会话的包按「开始 / 暂停 / 继续 / 停止」写进 fMP4。
//
//   idle ──start──▶ arming ──关键帧──▶ recording ──pause──▶ paused ──resume──▶ resuming ──关键帧──▶ recording
//                                         └──────────────────────stop──────────────────────────▶ idle
//
// 时间轴：文件内时间 = PTS − 起点 − 累计暂停。开始与继续都向服务端要一个关键帧（RESET_VIDEO），
// 所以继续录制不必等下一个自然关键帧，衔接处没有空白。
//
// 自动分段（每段都从关键帧开始、各自是完整可播的 MP4，文件名 _2、_3…）：
//   · 手机「定制录制」里的分段时长 / 大小到了；
//   · 画面尺寸或编码参数中途变了（转屏且未锁方向、虚拟屏改尺寸）——一个 MP4 装不下两种样本描述。
//
// 游戏回放（startReplay）：不写完整录像，只在内存里留最近一段（从关键帧开始），saveReplay(秒) 时切片成文件，
// 与手机本机的回放模式一致：悬浮球上选时长、点保存。

import { Fmp4Writer } from './media/fmp4.js';
import { parseVideoConfig, toLengthPrefixed } from './media/nal.js';

function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function audioSpec(codec, config) {
  return codec && config ? { codec, config, sampleRate: 48000, channels: 2 } : null;
}

export class Recorder {
  /**
   * @param createTarget async (fileName) => { write(bytes), finish() → { name, size, file() } }
   * @param requestKeyFrame () => Promise   通常是 session.resetVideo()
   * @param onState (snapshot) => void
   * @param onPart  (file) => void           每写完一个文件回调一次（分段、尺寸变化、停止、回放片段）
   * @param rotation (size) => 0|90|180|270  写进 MP4 的显示旋转（客户端方向）
   */
  constructor({ createTarget, requestKeyFrame, onState, onLog, onPart, onSaveError, rotation = () => 0 }) {
    this.createTarget = createTarget;
    /** 某一段没能存成（磁盘满、权限被收回）：(文件名, 错误)。 */
    this.onSaveError = onSaveError;
    this.requestKeyFrame = requestKeyFrame;
    this.onState = onState;
    this.onLog = onLog;
    this.onPart = onPart;
    /** 每写进文件（或回放内存环）一帧回调一次，参数是录制内的时间（µs，扣掉暂停、跨分段累计）。 */
    this.onFrame = null;
    this.rotation = rotation;
    /** 定时停止 / 定量停止（0 = 不限）。 */
    this.maxDurationMs = 0;
    this.maxBytes = 0;
    /** 分段录制：每段的时长 / 大小上限（0 = 不分段）。 */
    this.segmentMs = 0;
    this.segmentBytes = 0;
    this.state = 'idle';
    this.videoCodec = null;
    this.videoConfig = null;
    this.videoSize = null;
    this.audioCodec = null;
    this.audioConfig = null;
    this.chain = Promise.resolve();
    this.finished = [];
    this.closedBytes = 0;
    this.reset();
  }

  reset() {
    this.writer = null;
    this.target = null;
    this.origin = null;
    this.pausedTotal = 0;
    this.pausedAtPts = null;
    this.lastVideoPts = null;
    this.prevVideoPts = null;
    this.lastVideoPtsBeforePause = null;
    this.audioFloor = null;
    this.part = 1;
    this.elapsedBase = 0;
    this.keyRequested = false;
    this.limitReported = false;
    this.writerConfig = null;
    this.writerSize = null;
    this.baseName = null;
    this.replay = false;
    this.replayMax = 60;
    this.ring = [];
    this.audioRing = [];
    this.ringConfig = null;
    this.ringSize = null;
  }

  snapshot() {
    return {
      state: this.state,
      elapsedMs: this.elapsedMs(),
      bytes: (this.writer?.bytesWritten ?? 0) + this.closedBytes,
      file: this.target?.name ?? null,
      part: this.part,
      replay: this.replay,
      bufferedSeconds: this.bufferedSeconds(),
    };
  }

  emit() { this.onState?.(this.snapshot()); }

  /** 整次录制的时长（跨分段累计）：计时与定时停止按它。 */
  elapsedMs() { return this.elapsedBase + this.partElapsedMs(); }

  /** 当前这一段的时长。 */
  partElapsedMs() {
    if (this.origin === null || this.lastVideoPts === null) return 0;
    const last = this.state === 'paused' || this.state === 'resuming' ? this.pausedAtPts : this.lastVideoPts;
    return Math.max(0, Math.round((last - this.origin - this.pausedTotal) / 1000));
  }

  // ── 来自 scrcpy 会话 ──────────────────────────────────────────────
  onVideoSession({ codec, width, height }) {
    this.videoCodec = codec;
    this.videoSize = { width, height };
  }

  onAudioCodec(codec) {
    this.audioCodec = codec === 'aac' || codec === 'opus' ? codec : null;
    if (codec && !this.audioCodec) this.onLog?.(`音频编码 ${codec} 无法写进 MP4，本次只录画面（请把音频编码改为 AAC 或 Opus）`);
    this.audioConfig = null;
  }

  onVideo(packet) { this.chain = this.chain.then(() => this.handleVideo(packet)).catch((e) => this.fail(e)); }
  onAudio(packet) { this.chain = this.chain.then(() => this.handleAudio(packet)).catch((e) => this.fail(e)); }

  async handleVideo({ config, key, pts, data }) {
    if (config) { this.videoConfig = data; return; }
    if (this.state === 'idle' || this.state === 'paused') return;
    if (this.replay) { this.ringPush(key, pts, data); return; }

    if (key && (this.state === 'arming' || this.state === 'resuming' || this.state === 'recording')) {
      const changed = this.writer && (!sameBytes(this.writerConfig, this.videoConfig) ||
        this.writerSize.width !== this.videoSize.width || this.writerSize.height !== this.videoSize.height);
      if (changed) {
        this.onLog?.(`画面参数变化（${this.writerSize.width}×${this.writerSize.height} → ${this.videoSize.width}×${this.videoSize.height}），自动分段`);
        await this.split(pts);
        if (this.state === 'resuming') { this.state = 'recording'; this.emit(); }
      } else if (this.state === 'recording' && this.segmentDue()) {
        this.onLog?.(`分段：第 ${this.part} 段已满，开始第 ${this.part + 1} 段`);
        await this.split(pts);
      }
      if (this.state === 'arming') {
        await this.openWriter();
        this.origin = pts;
        this.audioFloor = pts;
        this.state = 'recording';
        this.emit();
      } else if (this.state === 'resuming') {
        // 暂停那一刻的最后一帧之后，留一帧的间隔接上。
        const frame = this.lastVideoPtsBeforePause !== null ? Math.max(1, this.pausedAtPts - this.lastVideoPtsBeforePause) : 16_667;
        this.pausedTotal += pts - this.pausedAtPts - frame;
        this.audioFloor = pts;
        this.state = 'recording';
        this.emit();
      }
    }
    if (this.state !== 'recording') return;
    this.prevVideoPts = this.lastVideoPts;
    this.lastVideoPts = pts;
    await this.writer.addVideo(toLengthPrefixed(data, this.videoCodec), pts - this.origin - this.pausedTotal, key);
    this.onFrame?.(this.elapsedBase * 1000 + (pts - this.origin - this.pausedTotal));
    // 分段到点了但下一个自然关键帧还远：要一个，好在整点附近切开。
    if (!this.keyRequested && this.segmentDue()) { this.keyRequested = true; this.requestKeyFrame(); }
    if (!this.limitReported && ((this.maxDurationMs && this.elapsedMs() >= this.maxDurationMs) ||
        (this.maxBytes && this.snapshot().bytes >= this.maxBytes))) {
      this.limitReported = true;
      this.onLog?.('到达定时停止的时长，自动停止');
      this.onLimit?.();
    }
  }

  async handleAudio({ config, pts, data }) {
    if (config) { this.audioConfig = data; return; }
    if (this.state !== 'recording') return;
    if (this.replay) {
      if (this.ring.length && pts >= this.ring[0].pts) this.audioRing.push({ pts, data });
      return;
    }
    if (!this.writer?.audio || pts < this.audioFloor) return;
    this.writer.addAudio(data, pts - this.origin - this.pausedTotal);
  }

  segmentDue() {
    return (this.segmentMs > 0 && this.partElapsedMs() >= this.segmentMs) ||
      (this.segmentBytes > 0 && (this.writer?.bytesWritten ?? 0) >= this.segmentBytes);
  }

  /** 收掉当前文件、从这一帧（关键帧）开新的一段；总计时不清零。 */
  async split(pts) {
    this.elapsedBase += this.partElapsedMs();
    await this.closeWriter();
    this.part++;
    await this.openWriter();
    this.origin = pts;
    this.lastVideoPts = pts;
    this.pausedTotal = 0;
    this.audioFloor = pts;
    this.keyRequested = false;
  }

  // ── 指令：完整录制 ────────────────────────────────────────────────
  async start(baseName) {
    if (this.state !== 'idle') return;
    if (!this.videoConfig || !this.videoSize) throw new Error('还没收到手机画面，请等预览出现后再开始');
    this.reset();
    this.baseName = baseName;
    this.closedBytes = 0;
    this.finished = [];
    this.state = 'arming';
    this.emit();
    await this.requestKeyFrame();
  }

  pause() {
    if (this.state !== 'recording' || this.replay) return;
    this.pausedAtPts = this.lastVideoPts;
    this.lastVideoPtsBeforePause = this.prevVideoPts ?? null;
    this.state = 'paused';
    this.emit();
  }

  async resume() {
    if (this.state !== 'paused') return;
    this.state = 'resuming';
    this.emit();
    await this.requestKeyFrame();
  }

  /** 停止并收尾；返回本次写出的所有文件（分段时不止一个）。回放模式只是清空内存环。 */
  async stop() {
    if (this.state === 'idle') return [];
    if (this.replay) {
      await this.chain;
      this.reset();
      this.state = 'idle';
      this.emit();
      return [];
    }
    const wasArming = this.state === 'arming';
    this.state = 'finishing';
    this.emit();
    await this.chain;
    if (!wasArming) await this.closeWriter();
    const files = this.finished;
    this.reset();
    this.state = 'idle';
    this.emit();
    return files;
  }

  async openWriter() {
    const cfg = parseVideoConfig(this.videoCodec, this.videoConfig);
    const name = this.part === 1 ? `${this.baseName}.mp4` : `${this.baseName}_${this.part}.mp4`;
    const target = await this.createTarget(name);
    this.target = target;
    const audio = audioSpec(this.audioCodec, this.audioConfig);
    this.writer = new Fmp4Writer({
      video: { ...cfg, width: this.videoSize.width, height: this.videoSize.height, rotation: this.rotation(this.videoSize) },
      audio,
      // 绑定到这一段自己的文件：收尾时 this.target 已经清空（或已换成下一段），最后一块数据仍要写进这个文件。
      sink: (bytes) => target.write(bytes),
    });
    this.writerConfig = this.videoConfig;
    this.writerSize = { ...this.videoSize };
    await this.writer.start();
    this.onLog?.(`开始写入 ${name}（${cfg.codecString}${audio ? ' + ' + audio.codec : '，无音频'}）`);
  }

  async closeWriter() {
    if (!this.writer) return;
    const writer = this.writer;
    const target = this.target;
    this.writer = null;
    this.target = null;
    let result;
    try {
      await writer.finish();
      this.closedBytes += writer.bytesWritten;
      result = await target.finish();
    } catch (e) {
      // 存储空间满、文件夹权限被收回……：不能静默丢掉，告诉用户这一段没存成。
      this.onLog?.(`保存 ${target?.name ?? ''} 失败：${e.message}`);
      this.onSaveError?.(target?.name ?? '', e);
      return;
    }
    const file = { ...result, durationMs: this.partElapsedMs() };
    this.finished.push(file);
    this.onPart?.(file);
  }

  // ── 游戏回放：内存环 + 按需切片 ────────────────────────────────────
  /** 进入回放缓存；maxSeconds 与手机悬浮球时间尺的上限一致。 */
  async startReplay(baseName, maxSeconds = 60) {
    if (this.state !== 'idle') return;
    if (!this.videoConfig || !this.videoSize) throw new Error('还没收到手机画面，请等预览出现后再开始');
    this.reset();
    this.replay = true;
    this.replayMax = maxSeconds;
    this.baseName = baseName;
    this.closedBytes = 0;
    this.state = 'recording';
    this.emit();
    await this.requestKeyFrame();
  }

  ringPush(key, pts, data) {
    if (this.state !== 'recording') return;
    // 环必须以关键帧开头，且整环只能有一种样本描述：参数变了就从下一个关键帧重新攒。
    const changed = !sameBytes(this.ringConfig, this.videoConfig) || this.ringSize?.width !== this.videoSize.width ||
      this.ringSize?.height !== this.videoSize.height;
    if (changed) {
      if (!key) return;
      this.ring = [];
      this.audioRing = [];
      this.ringConfig = this.videoConfig;
      this.ringSize = { ...this.videoSize };
    }
    if (!this.ring.length && !key) return;
    if (this.origin === null) this.origin = pts;
    this.prevVideoPts = this.lastVideoPts;
    this.lastVideoPts = pts;
    this.ring.push({ key, pts, data: toLengthPrefixed(data, this.videoCodec) });
    this.onFrame?.(pts - this.origin);
    // 修剪：剩下的仍从关键帧开始，且至少覆盖 replayMax 秒。
    const keepFrom = pts - (this.replayMax + 3) * 1e6;
    for (;;) {
      let next = -1;
      for (let i = 1; i < this.ring.length; i++) if (this.ring[i].key) { next = i; break; }
      if (next <= 0 || this.ring[next].pts > keepFrom) break;
      this.ring.splice(0, next);
    }
    while (this.audioRing.length && this.audioRing[0].pts < this.ring[0].pts) this.audioRing.shift();
  }

  bufferedSeconds() {
    if (!this.replay || this.ring.length < 2) return 0;
    return Math.min(this.replayMax, Math.floor((this.ring[this.ring.length - 1].pts - this.ring[0].pts) / 1e6));
  }

  /** 把最近 seconds 秒写成一个片段；返回 { file, seconds }（环不够长时秒数更短）。 */
  async saveReplay(seconds) {
    if (!this.replay || this.state !== 'recording') throw new Error('请先开始游戏回放');
    await this.chain;
    if (this.ring.length < 2) throw new Error('回放缓存还是空的，请稍候');
    const ring = this.ring.slice();
    const audioRing = this.audioRing.slice();
    const end = ring[ring.length - 1].pts;
    const from = end - seconds * 1e6;
    // 从「不晚于起点的最后一个关键帧」开始：片段可以略长，不能从半个 GOP 开始。
    let start = 0;
    for (let i = 0; i < ring.length; i++) if (ring[i].key && ring[i].pts <= from) start = i;
    const samples = ring.slice(start);
    const base = samples[0].pts;
    const audio = audioRing.filter((a) => a.pts >= base && a.pts <= end);
    const cfg = parseVideoConfig(this.videoCodec, this.ringConfig);
    const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
    const name = `${this.baseName}_${stamp}.mp4`;
    const target = await this.createTarget(name);
    const writer = new Fmp4Writer({
      video: { ...cfg, width: this.ringSize.width, height: this.ringSize.height, rotation: this.rotation(this.ringSize) },
      audio: audioSpec(this.audioCodec, this.audioConfig),
      sink: (bytes) => target.write(bytes),
    });
    await writer.start();
    let ai = 0;
    for (const v of samples) {
      while (ai < audio.length && audio[ai].pts <= v.pts) { writer.addAudio(audio[ai].data, audio[ai].pts - base); ai++; }
      await writer.addVideo(v.data, v.pts - base, v.key);
    }
    for (; ai < audio.length; ai++) writer.addAudio(audio[ai].data, audio[ai].pts - base);
    await writer.finish();
    const result = await target.finish();
    const actual = Math.max(1, Math.round((end - base) / 1e6));
    this.onLog?.(`已保存回放片段 ${name}（${actual} 秒）`);
    const file = { ...result, durationMs: actual * 1000 };
    this.onPart?.(file);
    return { file, seconds: actual };
  }

  fail(e) {
    this.onLog?.(`录制出错：${e.message}`);
    this.onError?.(e);
  }
}
