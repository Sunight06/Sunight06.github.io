// 字节工具与按需读取的字节流。整个网页端（ADB、scrcpy、MP4 封装）都只靠这一份。

export const utf8 = new TextEncoder();
export const utf8d = new TextDecoder();

export function concat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

export function u32be(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0); return b; }
export function u16be(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v & 0xffff); return b; }

/** 结束（对端关闭）时抛出的错误：读者据此区分「正常收尾」和「真的出错」。 */
export class EndOfStream extends Error {
  constructor(message = '连接已关闭') { super(message); this.name = 'EndOfStream'; }
}

/**
 * 把一块块到达的数据变成「要多少读多少」的流。
 *
 * ADB 的 WRTE、WebSocket 的消息、USB 的批量传输，到达的边界都和协议的字段边界无关：
 * scrcpy 的 12 字节帧头可能被切成两半。所有解析都通过 readExactly 读，就不必关心切法。
 */
export class ByteQueue {
  constructor() {
    this.chunks = [];
    this.length = 0;
    this.closed = false;
    this.error = null;
    this.waiter = null;
  }

  push(chunk) {
    if (this.closed || chunk.length === 0) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
    this.wake();
  }

  close(error = null) {
    if (this.closed) return;
    this.closed = true;
    this.error = error;
    this.wake();
  }

  wake() {
    const w = this.waiter;
    this.waiter = null;
    if (w) w();
  }

  async waitFor(n) {
    while (this.length < n) {
      if (this.closed) throw this.error ?? new EndOfStream();
      await new Promise((resolve) => { this.waiter = resolve; });
    }
  }

  take(n) {
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const head = this.chunks[0];
      const need = n - filled;
      if (head.length <= need) {
        out.set(head, filled);
        filled += head.length;
        this.chunks.shift();
      } else {
        out.set(head.subarray(0, need), filled);
        this.chunks[0] = head.subarray(need);
        filled += need;
      }
    }
    this.length -= n;
    return out;
  }

  async readExactly(n) {
    if (n === 0) return new Uint8Array(0);
    await this.waitFor(n);
    return this.take(n);
  }

  /** 读到对端关闭为止（shell 命令的输出）。 */
  async readAll() {
    const parts = [];
    for (;;) {
      try { await this.waitFor(1); } catch (e) { if (e instanceof EndOfStream) break; throw e; }
      parts.push(this.take(this.length));
    }
    return concat(parts);
  }

  /** 有多少读多少，至少一个字节；关闭后返回 null。 */
  async readSome() {
    try { await this.waitFor(1); } catch (e) { if (e instanceof EndOfStream) return null; throw e; }
    return this.take(this.length);
  }
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export function hex(bytes) { return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''); }
