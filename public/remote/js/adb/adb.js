// ADB 协议（host 端）：连接/认证、多路流、shell、sync push。
// 不依赖任何第三方库；协议定义见 AOSP packages/modules/adb/protocol.txt。

import { ByteQueue, EndOfStream, concat, utf8, utf8d } from '../bytes.js';

const A_SYNC = 0x434e5953;
const A_CNXN = 0x4e584e43;
const A_AUTH = 0x48545541;
const A_OPEN = 0x4e45504f;
const A_OKAY = 0x59414b4f;
const A_CLSE = 0x45534c43;
const A_WRTE = 0x45545257;
const A_STLS = 0x534c5453;

const AUTH_TOKEN = 1;
const AUTH_SIGNATURE = 2;
const AUTH_RSAPUBLICKEY = 3;

const VERSION = 0x01000001;
const MAX_PAYLOAD = 1024 * 1024;
// 不声明 shell_v2：带命令的 shell: 于是走 raw（无 pty、无分包协议），输出原样就是程序的 stdout+stderr。
const FEATURES = ['cmd', 'stat_v2', 'ls_v2', 'fixed_push_mkdir'];

function checksum(data) {
  let sum = 0;
  for (const b of data) sum = (sum + b) >>> 0;
  return sum;
}

export class AdbStream {
  constructor(adb, localId, service) {
    this.adb = adb;
    this.localId = localId;
    this.remoteId = 0;
    this.service = service;
    this.queue = new ByteQueue();
    this.closed = false;
    this.okayWaiter = null;
    /** 写入队列：上一次写完（收到 OKAY）才开始下一次。 */
    this.writeChain = Promise.resolve();
    this.onclose = null;
  }

  readExactly(n) { return this.queue.readExactly(n); }
  readSome() { return this.queue.readSome(); }
  readAll() { return this.queue.readAll(); }

  /**
   * 写入（排队执行）。同一条流上同时有两次写——比如传视频的大块和每半秒一次的状态消息——以前会互相覆盖
   * 「等对端 OKAY」的那一个槽位，先写的那次就永远等不到 OKAY，传文件随之卡死。现在一条流上的写入串行进行。
   */
  write(data) {
    const run = this.writeChain.then(() => this.writeNow(data));
    this.writeChain = run.catch(() => {});
    return run;
  }

  async writeNow(data) {
    if (typeof data === 'string') data = utf8.encode(data);
    let offset = 0;
    while (offset < data.length || data.length === 0) {
      if (this.closed) throw new EndOfStream('流已关闭');
      const chunk = data.subarray(offset, offset + this.adb.maxPayload);
      // 没有声明 delayed_ack：每个 WRTE 必须等到对端 OKAY 才能发下一个，这同时就是流控。
      const okay = new Promise((resolve, reject) => { this.okayWaiter = { resolve, reject }; });
      await this.adb.send(A_WRTE, this.localId, this.remoteId, chunk);
      await okay;
      offset += chunk.length;
      if (data.length === 0) break;
    }
  }

  handleClose(error) {
    if (this.closed) return;
    this.closed = true;
    this.queue.close(error);
    this.okayWaiter?.reject(error ?? new EndOfStream('流已关闭'));
    this.okayWaiter = null;
    this.onclose?.();
  }

  async close() {
    if (this.closed) return;
    this.adb.streams.delete(this.localId);
    this.handleClose(null);
    try { await this.adb.send(A_CLSE, this.localId, this.remoteId); } catch { /* 连接已断 */ }
  }
}

export class Adb {
  /**
   * @param transport UsbTransport / WebSocketTransport
   * @param key AdbKey
   * @param onAuthPrompt 设备没认出这把钥匙、正在手机上弹「允许 USB 调试吗」时回调，界面提示去手机上点允许。
   */
  static async connect(transport, key, { onAuthPrompt } = {}) {
    const adb = new Adb(transport);
    await adb.handshake(key, onAuthPrompt);
    adb.loop();
    return adb;
  }

  constructor(transport) {
    this.transport = transport;
    this.maxPayload = 4096;
    this.streams = new Map();
    this.nextLocalId = 1;
    this.banner = '';
    this.props = {};
    this.features = new Set();
    this.closed = false;
    this.onclose = null;
    this.sendChain = Promise.resolve();
  }

  /** 串行发送：header 与 payload 之间不能插进另一条消息。 */
  send(command, arg0, arg1, data = new Uint8Array(0)) {
    const header = new Uint8Array(24);
    const v = new DataView(header.buffer);
    v.setUint32(0, command, true);
    v.setUint32(4, arg0, true);
    v.setUint32(8, arg1, true);
    v.setUint32(12, data.length, true);
    v.setUint32(16, checksum(data), true);
    v.setUint32(20, (command ^ 0xffffffff) >>> 0, true);
    const run = async () => {
      await this.transport.write(header);
      if (data.length) await this.transport.write(data);
    };
    const p = this.sendChain.then(run, run);
    this.sendChain = p.catch(() => {});
    return p;
  }

  async receive() {
    const header = await this.transport.readExactly(24);
    const v = new DataView(header.buffer, header.byteOffset, 24);
    const command = v.getUint32(0, true);
    const arg0 = v.getUint32(4, true);
    const arg1 = v.getUint32(8, true);
    const length = v.getUint32(12, true);
    const data = length ? await this.transport.readExactly(length) : new Uint8Array(0);
    return { command, arg0, arg1, data };
  }

  async handshake(key, onAuthPrompt) {
    await this.send(A_CNXN, VERSION, MAX_PAYLOAD, utf8.encode(`host::features=${FEATURES.join(',')}`));
    let signed = false;
    for (;;) {
      const msg = await this.receive();
      if (msg.command === A_CNXN) {
        this.maxPayload = Math.min(msg.arg1, MAX_PAYLOAD);
        this.parseBanner(utf8d.decode(msg.data));
        return;
      }
      if (msg.command === A_STLS) {
        throw new Error('手机要求 TLS 加密连接（Android 11+ 的「无线调试」）。网页端请改用 USB，或在「远程」页通过 USB 开启无线端口后再连');
      }
      if (msg.command !== A_AUTH || msg.arg0 !== AUTH_TOKEN) continue;
      if (!signed) {
        signed = true;
        await this.send(A_AUTH, AUTH_SIGNATURE, 0, key.sign(msg.data));
      } else {
        // 签名没被认：把公钥发过去，手机上会弹出授权框。用户点允许之后设备直接回 CNXN。
        onAuthPrompt?.();
        await this.send(A_AUTH, AUTH_RSAPUBLICKEY, 0, utf8.encode(key.publicKey()));
      }
    }
  }

  parseBanner(banner) {
    this.banner = banner;
    const [, rest = ''] = banner.split('::');
    for (const part of rest.split(';')) {
      const [k, value] = part.split('=');
      if (!k) continue;
      if (k === 'features') value.split(',').forEach((f) => this.features.add(f));
      else this.props[k] = value;
    }
  }

  get model() { return this.props['ro.product.model'] ?? this.transport.label; }

  async loop() {
    try {
      for (;;) {
        const msg = await this.receive();
        const stream = this.streams.get(msg.arg1);
        switch (msg.command) {
          case A_OKAY:
            if (!stream) break;
            if (stream.openWaiter) { stream.remoteId = msg.arg0; stream.openWaiter.resolve(); stream.openWaiter = null; }
            else if (stream.okayWaiter) { const w = stream.okayWaiter; stream.okayWaiter = null; w.resolve(); }
            break;
          case A_WRTE:
            if (!stream) { await this.send(A_CLSE, 0, msg.arg0); break; }
            stream.queue.push(msg.data);
            await this.send(A_OKAY, stream.localId, stream.remoteId);
            break;
          case A_CLSE:
            if (!stream) break;
            this.streams.delete(stream.localId);
            if (stream.openWaiter) { stream.openWaiter.reject(new Error(`设备拒绝打开 ${stream.service}`)); stream.openWaiter = null; }
            stream.handleClose(null);
            break;
          default:
            break;
        }
      }
    } catch (e) {
      this.shutdown(e);
    }
  }

  shutdown(error) {
    if (this.closed) return;
    this.closed = true;
    for (const s of this.streams.values()) s.handleClose(error instanceof EndOfStream ? null : error);
    this.streams.clear();
    this.onclose?.(error);
  }

  async open(service) {
    if (this.closed) throw new Error('ADB 已断开');
    const localId = this.nextLocalId++;
    const stream = new AdbStream(this, localId, service);
    const opened = new Promise((resolve, reject) => { stream.openWaiter = { resolve, reject }; });
    this.streams.set(localId, stream);
    await this.send(A_OPEN, localId, 0, utf8.encode(service + '\0'));
    await opened;
    return stream;
  }

  /** 跑一条命令，等它结束，返回全部输出（stdout+stderr）。 */
  async shell(command) {
    const stream = await this.open(`shell:${command}`);
    return utf8d.decode(await stream.readAll());
  }

  /** 推一个文件到设备（sync 协议的 SEND）。 */
  async push(path, data, mode = 0o644, onProgress) {
    const stream = await this.open('sync:');
    const request = (id, payload) => {
      const head = new Uint8Array(8);
      const v = new DataView(head.buffer);
      v.setUint32(0, id, true);
      v.setUint32(4, payload.length, true);
      return concat([head, payload]);
    };
    const SEND = 0x444e4553, DATA = 0x41544144, DONE = 0x454e4f44, QUIT = 0x54495551, FAIL = 0x4c494146;
    await stream.write(request(SEND, utf8.encode(`${path},${0o100000 | mode}`)));
    const CHUNK = 64 * 1024;
    for (let off = 0; off < data.length; off += CHUNK) {
      await stream.write(request(DATA, data.subarray(off, off + CHUNK)));
      onProgress?.(Math.min(off + CHUNK, data.length), data.length);
    }
    const done = new Uint8Array(8);
    const dv = new DataView(done.buffer);
    dv.setUint32(0, DONE, true);
    dv.setUint32(4, Math.floor(Date.now() / 1000), true);
    await stream.write(done);
    const reply = await stream.readExactly(8);
    const rv = new DataView(reply.buffer, reply.byteOffset, 8);
    if (rv.getUint32(0, true) === FAIL) {
      const msg = utf8d.decode(await stream.readExactly(rv.getUint32(4, true)));
      await stream.close();
      throw new Error(`推送失败：${msg}`);
    }
    const quit = new Uint8Array(8);
    new DataView(quit.buffer).setUint32(0, QUIT, true);
    try { await stream.write(quit); } catch { /* 设备可能已关流 */ }
    await stream.close();
  }

  async close() {
    for (const s of [...this.streams.values()]) await s.close();
    this.shutdown(null);
    await this.transport.close();
  }
}

export { A_SYNC };
