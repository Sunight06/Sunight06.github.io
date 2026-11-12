// 与手机上「小白录制」的应用通道：ADB 打开 localabstract:sunight_remote。
//
// 帧格式：u8 类型 | u32 长度（大端）| 负载
//   类型 1：JSON 消息        类型 2：文件块（录像回传）
//
// 手机 → 电脑：hello / config（录制参数 + 换算好的 scrcpy 参数） · cmd（start/pause/resume/stop） · file_ack
// 电脑 → 手机：hello · state（录制状态，手机主页/悬浮球据此显示） · cmd_result · file_begin / 块 / file_end

import { ByteQueue, concat, utf8, utf8d, sleep } from './bytes.js';

export const APP_PACKAGE = 'com.sunight.screenrecorder';
const SOCKET = 'localabstract:sunight_remote';
const T_JSON = 1;
const T_FILE = 2;
const CHUNK = 256 * 1024;

function frame(type, payload) {
  const head = new Uint8Array(5);
  head[0] = type;
  new DataView(head.buffer).setUint32(1, payload.length);
  return concat([head, payload]);
}

export class AppLink {
  /**
   * 连应用通道；应用没在监听（没打开过、被系统清掉）时用 am start 把它的远程服务拉起来再连。
   * 拉起用的是一个专门的导出 Activity：它只负责启动远程服务然后立刻关闭，不展示界面。
   */
  static async open(adb, { onLog } = {}) {
    try { return new AppLink(await adb.open(SOCKET)); } catch { /* 下面拉起 */ }
    onLog?.('正在唤起手机上的小白录制…');
    const out = await adb.shell(`am start -n ${APP_PACKAGE}/.remote.RemoteActivationActivity 2>&1`);
    if (/Error|does not exist/i.test(out)) throw new Error('手机上没有安装支持远程录制的小白录制（或版本过旧）');
    for (let i = 0; i < 50; i++) {
      await sleep(200);
      try { return new AppLink(await adb.open(SOCKET)); } catch { /* 再等等 */ }
    }
    throw new Error('小白录制没有响应：请在手机上打开小白录制，进入「远程」页');
  }

  constructor(stream) {
    this.stream = stream;
    this.handlers = {};
    this.ackWaiter = null;
    this.closed = false;
    this.readLoop();
  }

  on(name, fn) { this.handlers[name] = fn; return this; }

  async readLoop() {
    try {
      for (;;) {
        const head = await this.stream.readExactly(5);
        const len = new DataView(head.buffer, head.byteOffset, 5).getUint32(1);
        const payload = await this.stream.readExactly(len);
        if (head[0] !== T_JSON) continue;
        const msg = JSON.parse(utf8d.decode(payload));
        if (msg.t === 'file_ack' && this.ackWaiter) { const w = this.ackWaiter; this.ackWaiter = null; w(msg); }
        this.handlers[msg.t]?.(msg);
      }
    } catch (e) {
      this.closed = true;
      this.ackWaiter?.({ ok: false, error: '连接断开' });
      this.handlers.close?.(e);
    }
  }

  send(msg) {
    if (this.closed) return Promise.resolve();
    return this.stream.write(frame(T_JSON, utf8.encode(JSON.stringify(msg)))).catch(() => {});
  }

  /** 把录好的文件（视频或截图）传回手机，手机按自己的保存位置存进相册。onProgress(sent, total)。 */
  async sendFile(name, blob, onProgress, mime = 'video/mp4') {
    await this.send({ t: 'file_begin', name, size: blob.size, mime });
    let sent = 0;
    const reader = blob.stream().getReader();
    const queue = new ByteQueue();
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) { queue.close(); return; }
        queue.push(value);
      }
    })();
    while (sent < blob.size) {
      const n = Math.min(CHUNK, blob.size - sent);
      const chunk = await queue.readExactly(n);
      await this.stream.write(frame(T_FILE, chunk));
      sent += n;
      onProgress?.(sent, blob.size);
    }
    await pump;
    // 手机存进相册要时间（大文件要拷贝），但不能无限等：按大小给一个上限，超时就当失败，
    // 后面排队的文件照常继续。
    const limitMs = 30_000 + Math.ceil(blob.size / (20 * 1024 * 1024)) * 1000;
    let timer;
    const ack = new Promise((resolve) => {
      this.ackWaiter = resolve;
      timer = setTimeout(() => { if (this.ackWaiter === resolve) { this.ackWaiter = null; resolve({ ok: false, error: '手机没有确认收到' }); } }, limitMs);
    });
    await this.send({ t: 'file_end', name });
    const result = await ack;
    clearTimeout(timer);
    if (!result.ok) throw new Error(result.error || '手机保存失败');
    return result;
  }

  close() { this.closed = true; return this.stream.close(); }
}
