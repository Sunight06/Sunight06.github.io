// ADB 的两种承载：有线走 WebUSB，无线走手机上「小白录制」开的 WebSocket 中继（中继另一头接 adbd 的 TCP 端口）。
// 两者对上层只暴露 readExactly / write / close，ADB 协议本身完全一样。

import { ByteQueue } from '../bytes.js';

const BUSY_MESSAGE = '手机正被电脑上的另一个软件占用。请先关掉电脑上其它连接手机的软件，拔插一下数据线，再点「连接手机」。';

const ADB_INTERFACE = { classCode: 0xff, subclassCode: 0x42, protocolCode: 0x01 };

export class UsbTransport {
  static supported() { return typeof navigator !== 'undefined' && !!navigator.usb && globalThis.isSecureContext; }

  /** 弹出浏览器的设备选择框（必须在一次点击里调用）。 */
  static async request() {
    const device = await navigator.usb.requestDevice({ filters: [ADB_INTERFACE] });
    return UsbTransport.open(device);
  }

  /** 之前授权过的设备，免点选直接重连。 */
  static async paired() {
    if (!UsbTransport.supported()) return [];
    const devices = await navigator.usb.getDevices();
    return devices.filter((d) => UsbTransport.findInterface(d));
  }

  static findInterface(device) {
    for (const config of device.configurations) {
      for (const intf of config.interfaces) {
        for (const alt of intf.alternates) {
          if (alt.interfaceClass === ADB_INTERFACE.classCode &&
              alt.interfaceSubclass === ADB_INTERFACE.subclassCode &&
              alt.interfaceProtocol === ADB_INTERFACE.protocolCode) {
            return { config, intf, alt };
          }
        }
      }
    }
    return null;
  }

  static async open(device) {
    const found = UsbTransport.findInterface(device);
    if (!found) throw new Error('这台设备没有 ADB 接口：请在手机上打开「USB 调试」');
    try {
      await device.open();
    } catch (e) {
      const err = new Error(BUSY_MESSAGE);
      err.busy = true;
      err.detail = e.message;
      throw err;
    }
    if (device.configuration?.configurationValue !== found.config.configurationValue) {
      await device.selectConfiguration(found.config.configurationValue);
    }
    try {
      await device.claimInterface(found.intf.interfaceNumber);
    } catch (e) {
      const err = new Error(BUSY_MESSAGE);
      err.busy = true;
      err.detail = e.message;
      throw err;
    }
    if (found.intf.alternates.length > 1) {
      await device.selectAlternateInterface(found.intf.interfaceNumber, found.alt.alternateSetting);
    }
    const inEp = found.alt.endpoints.find((e) => e.direction === 'in' && e.type === 'bulk');
    const outEp = found.alt.endpoints.find((e) => e.direction === 'out' && e.type === 'bulk');
    return new UsbTransport(device, found.intf.interfaceNumber, inEp, outEp);
  }

  constructor(device, interfaceNumber, inEp, outEp) {
    this.kind = 'usb';
    this.device = device;
    this.interfaceNumber = interfaceNumber;
    this.inEp = inEp;
    this.outEp = outEp;
    this.label = `${device.manufacturerName ?? ''} ${device.productName ?? ''}`.trim() || 'USB 设备';
    this.serial = device.serialNumber;
    this.closed = false;
    this.pending = new Uint8Array(0);
  }

  async write(data) {
    if (this.closed) throw new Error('USB 已断开');
    await this.device.transferOut(this.outEp.endpointNumber, data);
  }

  async readExactly(n) {
    // 一次 transferIn 可能多给（上一包剩下的）也可能少给，统一按字节攒够。
    while (this.pending.length < n) {
      if (this.closed) throw new Error('USB 已断开');
      const want = Math.max(n - this.pending.length, this.inEp.packetSize);
      const result = await this.device.transferIn(this.inEp.endpointNumber, want);
      if (result.status === 'stall') {
        await this.device.clearHalt('in', this.inEp.endpointNumber);
        continue;
      }
      const chunk = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
      const merged = new Uint8Array(this.pending.length + chunk.length);
      merged.set(this.pending);
      merged.set(chunk, this.pending.length);
      this.pending = merged;
    }
    const out = this.pending.slice(0, n);
    this.pending = this.pending.subarray(n);
    return out;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try { await this.device.releaseInterface(this.interfaceNumber); } catch { /* 已拔掉 */ }
    try { await this.device.close(); } catch { /* 已拔掉 */ }
  }
}

export class WebSocketTransport {
  /** url 形如 ws://192.168.1.5:27184/adb?token=123456（由手机上的小白录制提供）。 */
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      const transport = new WebSocketTransport(ws, url);
      ws.onopen = () => resolve(transport);
      ws.onerror = () => reject(new Error('无法连接手机上的无线中继，请确认手机与电脑在同一局域网，且「远程」页已开启无线'));
      ws.onclose = (ev) => {
        transport.queue.close(new Error(ev.reason || '无线连接已断开'));
        reject(new Error(ev.reason || '无线中继拒绝连接'));
      };
      ws.onmessage = (ev) => transport.queue.push(new Uint8Array(ev.data));
    });
  }

  constructor(ws, url) {
    this.kind = 'wifi';
    this.ws = ws;
    this.label = new URL(url, location.href).host;
    this.queue = new ByteQueue();
  }

  async write(data) {
    if (this.ws.readyState !== WebSocket.OPEN) throw new Error('无线连接已断开');
    this.ws.send(data);
    // 背压：中继那头是 TCP，浏览器的发送缓冲堆太多时稍等，避免录制回传时占满内存。
    while (this.ws.bufferedAmount > 4 * 1024 * 1024) await new Promise((r) => setTimeout(r, 10));
  }

  readExactly(n) { return this.queue.readExactly(n); }

  async close() { try { this.ws.close(); } catch { /* ignore */ } this.queue.close(); }
}
