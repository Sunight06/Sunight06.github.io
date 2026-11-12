// 一次 scrcpy 会话：推送服务端 → 用 app_process 启动 → 依次接上 video / audio / control 三条 localabstract 流
// → 按 v5 协议拆出会话包、媒体包。协议细节对照 scrcpy v5.0.1 的 Streamer / DesktopConnection。

import { utf8d, sleep } from '../bytes.js';
import { buildCommand, randomScid } from './options.js';
import { Control, TYPE } from './control.js';

export const VIDEO_CODECS = { 0x68323634: 'h264', 0x68323635: 'h265', 0x00617631: 'av1', 0x00767038: 'vp8', 0x00767039: 'vp9' };
export const AUDIO_CODECS = { 0x6f707573: 'opus', 0x00616163: 'aac', 0x666c6163: 'flac', 0x00726177: 'raw' };

const PTS_MASK = (1n << 61n) - 1n;

/**
 * 推送服务端。每次启动前都要推：服务端一起来就把自己的 jar 删掉（CleanUp.unlinkSelf），
 * 设备上不会留下任何东西——所以也不能按「已经有了」跳过。
 */
export async function pushServer(adb, server, onLog) {
  onLog?.(`推送 scrcpy-server v${server.version}（${(server.bytes.length / 1024).toFixed(0)} KB）`);
  await adb.push(server.devicePath, server.bytes);
}

/** 只跑一次「列出」命令（编码器、显示屏、摄像头），服务端打印完就退出。 */
export async function listCapabilities(adb, server) {
  await pushServer(adb, server);
  const cmd = `CLASSPATH=${server.devicePath} app_process / com.genymobile.scrcpy.Server ${server.version} ` +
    'list_encoders=true list_displays=true list_cameras=true 2>&1';
  return adb.shell(cmd);
}

/**
 * 手机上装的应用（scrcpy 的 list_apps）：[{ name, pkg, system }]。
 * 服务端按「- 名称   包名」逐行打印，* 开头是系统应用。名称可能含空格，包名是行尾最后一段。
 */
export async function listApps(adb, server) {
  await pushServer(adb, server);
  const out = await adb.shell(`CLASSPATH=${server.devicePath} app_process / com.genymobile.scrcpy.Server ${server.version} list_apps=true 2>&1`);
  const apps = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s+([*-])\s+(.+?)\s+([A-Za-z][\w]*(?:\.[\w]+)+)\s*$/);
    if (m) apps.push({ name: m[2].trim(), pkg: m[3], system: m[1] === '*' });
  }
  return apps;
}

export class ScrcpySession {
  /**
   * @param adb     已连接的 Adb
   * @param server  { version, devicePath }
   * @param options mergeOptions() 的结果
   * @param handlers onLog(line) / onDevice(name) / onVideoSession({codec,width,height,clientResized})
   *                 / onVideo(packet) / onAudioCodec(codec|null) / onAudio(packet) / onClipboard(text) / onClose(error)
   */
  constructor(adb, server, options, handlers = {}) {
    this.adb = adb;
    this.server = server;
    this.options = options;
    this.h = handlers;
    this.scid = randomScid();
    this.video = options.video !== 'false';
    this.audio = options.audio !== 'false';
    this.control = options.control !== 'false';
    this.streams = [];
    this.closed = false;
    this.videoSize = null;
    this.videoCodec = null;
    this.audioCodec = null;
  }

  log(line) { this.h.onLog?.(line); }

  async start() {
    await pushServer(this.adb, this.server, (l) => this.log(l));
    const command = buildCommand(this.server.devicePath, this.server.version, this.scid, this.options);
    this.log(`$ app_process … Server ${this.server.version} ${Object.entries(this.options).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    this.shell = await this.adb.open(`shell:${command} 2>&1`);
    this.streams.push(this.shell);
    this.pumpLogs();

    const socketName = `localabstract:scrcpy_${this.scid}`;
    const wanted = [this.video && 'video', this.audio && 'audio', this.control && 'control'].filter(Boolean);
    const sockets = {};
    // 第一条要等服务端起来开始监听：没在监听时 adbd 直接回 CLSE，隔 100ms 重试（与官方客户端一致）。
    for (let attempt = 0; ; attempt++) {
      try {
        sockets[wanted[0]] = await this.adb.open(socketName);
        break;
      } catch (e) {
        if (this.serverExited || attempt >= 100) throw new Error(this.serverError ?? `scrcpy 服务端没有启动：${e.message}`);
        await sleep(100);
      }
    }
    const first = sockets[wanted[0]];
    this.streams.push(first);
    await first.readExactly(1); // dummy byte：确认对面真的是服务端
    for (const name of wanted.slice(1)) {
      sockets[name] = await this.adb.open(socketName);
      this.streams.push(sockets[name]);
    }
    const meta = await first.readExactly(64);
    const end = meta.indexOf(0);
    this.deviceName = utf8d.decode(meta.subarray(0, end < 0 ? 64 : end));
    this.h.onDevice?.(this.deviceName);

    if (sockets.video) this.readVideo(sockets.video);
    if (sockets.audio) this.readAudio(sockets.audio);
    if (sockets.control) { this.controlStream = sockets.control; this.readDeviceMessages(sockets.control); }
  }

  async pumpLogs() {
    let pending = '';
    for (;;) {
      const chunk = await this.shell.readSome().catch(() => null);
      if (chunk === null) break;
      pending += utf8d.decode(chunk, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        const l = line.replace(/\r$/, '');
        if (/^\[server\] (ERROR|FATAL)/.test(l) || /Exception|Aborted/.test(l)) this.serverError ??= l;
        this.log(l);
      }
    }
    this.serverExited = true;
    this.fail(this.serverError ? new Error(this.serverError) : null);
  }

  async readHeader(stream, kind) {
    const raw = await stream.readExactly(4);
    const id = new DataView(raw.buffer, raw.byteOffset, 4).getUint32(0);
    if (id === 0) return { disabled: true };
    if (id === 1) throw new Error(`${kind} 配置错误，请查看日志`);
    return { id };
  }

  async readVideo(stream) {
    try {
      const { id, disabled } = await this.readHeader(stream, '视频');
      if (disabled) { this.log('视频流被设备关闭'); return; }
      this.videoCodec = VIDEO_CODECS[id] ?? `0x${id.toString(16)}`;
      for (;;) {
        const head = await stream.readExactly(12);
        const v = new DataView(head.buffer, head.byteOffset, 12);
        const hi = v.getUint32(0);
        if (hi & 0x80000000) {
          // 会话包：每次采集会话（旋转、RESET_VIDEO、调整虚拟屏尺寸）开始时发一个。
          this.videoSize = { width: v.getUint32(4), height: v.getUint32(8) };
          this.h.onVideoSession?.({ codec: this.videoCodec, ...this.videoSize, clientResized: !!(hi & 1) });
          continue;
        }
        const flags = v.getBigUint64(0);
        const size = v.getUint32(8);
        const data = await stream.readExactly(size);
        const config = !!(flags & (1n << 62n));
        this.h.onVideo?.({ config, key: !!(flags & (1n << 61n)), pts: config ? null : Number(flags & PTS_MASK), data });
      }
    } catch (e) { this.fail(e); }
  }

  async readAudio(stream) {
    try {
      const { id, disabled } = await this.readHeader(stream, '音频');
      if (disabled) { this.audioCodec = null; this.h.onAudioCodec?.(null); this.log('手机端无法采集音频（系统版本或声源不支持），继续只录画面'); return; }
      this.audioCodec = AUDIO_CODECS[id] ?? `0x${id.toString(16)}`;
      this.h.onAudioCodec?.(this.audioCodec);
      for (;;) {
        const head = await stream.readExactly(12);
        const v = new DataView(head.buffer, head.byteOffset, 12);
        const flags = v.getBigUint64(0);
        const size = v.getUint32(8);
        const data = await stream.readExactly(size);
        const config = !!(flags & (1n << 62n));
        this.h.onAudio?.({ config, key: true, pts: config ? null : Number(flags & PTS_MASK), data });
      }
    } catch (e) { this.fail(e); }
  }

  /** 设备 → 电脑的消息必须读走，否则服务端写满缓冲后会卡住整条控制通道。 */
  async readDeviceMessages(stream) {
    try {
      for (;;) {
        const [type] = await stream.readExactly(1);
        if (type === 0) {
          const len = new DataView((await stream.readExactly(4)).buffer).getUint32(0);
          this.h.onClipboard?.(utf8d.decode(await stream.readExactly(len)));
        } else if (type === 1) {
          await stream.readExactly(8);
        } else if (type === 2) {
          const head = await stream.readExactly(4);
          await stream.readExactly(new DataView(head.buffer).getUint16(2));
        } else {
          throw new Error(`未知的设备消息类型 ${type}`);
        }
      }
    } catch (e) { this.fail(e); }
  }

  async send(bytes) {
    if (!this.controlStream || this.closed) return false;
    await this.controlStream.write(bytes);
    return true;
  }

  /** 让服务端重建编码器：立刻得到新的配置包 + 关键帧（开始录制、继续录制时用）。 */
  resetVideo() { return this.send(Control.empty(TYPE.RESET_VIDEO)); }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const s of this.streams) s.close().catch(() => {});
    this.h.onClose?.(error && error.name !== 'EndOfStream' ? error : null);
  }

  stop() { this.fail(null); }
}
