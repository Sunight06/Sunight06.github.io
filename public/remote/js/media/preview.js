// 实时预览：WebCodecs 解码到 canvas；可选地把鼠标/键盘转成 scrcpy 控制消息，在电脑上直接操作手机。
// 预览只是看的，与录制互不影响：录制直接写编码后的码流，从不经过解码。

import { parseVideoConfig, toLengthPrefixed } from './nal.js';
import { Control, ACTION, KEY } from '../scrcpy/control.js';
import { MsePreview } from './msepreview.js';

const KEYMAP = {
  Enter: 66, Backspace: 67, Delete: 112, Tab: 61, Escape: KEY.BACK, ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22,
  Home: KEY.HOME, PageUp: 92, PageDown: 93,
};

export class Preview {
  /** WebCodecs（https / localhost）优先；不是安全上下文时（手机托管的无线页面）退到 MSE。 */
  static webCodecs() { return typeof VideoDecoder !== 'undefined'; }
  static supported() { return Preview.webCodecs() || MsePreview.supported(); }

  constructor(canvas, { onStatus } = {}) {
    this.canvas = canvas;
    // 用默认的 2D 上下文：desynchronized / alpha:false 在部分手机自带浏览器（国产内核）上会让整块画布一直是黑的。
    this.ctx = canvas.getContext('2d');
    /** 解出来还没画的最新一帧；每次刷新屏幕只画这一帧（见 queueFrame）。 */
    this.pending = null;
    this.paintScheduled = false;
    this.onStatus = onStatus;
    this.decoder = null;
    this.codec = null;
    this.size = null;
    this.needKey = true;
    this.session = null;
    this.controlEnabled = false;
    this.frames = 0;
    this.mse = Preview.webCodecs() || !MsePreview.supported()
      ? null
      : new MsePreview(canvas, { onStatus, onFrame: () => this.frameDrawn() });
    this.bindInput();
  }

  attach(session) { this.session = session; this.reset(); }

  reset() {
    try { if (this.decoder?.state !== 'closed') this.decoder?.close(); } catch { /* 已关闭 */ }
    this.decoder = null;
    this.needKey = true;
  }

  /**
   * 新会话（开始录制、改参数、转屏都会重开一次）。
   *
   * 画面在第一帧新画面解出来之前**不清空**：以前这里无条件重设 canvas 尺寸，浏览器会把画布清成全黑，
   * 要等下一个关键帧才有图——开始录制、转屏时就会黑一下。现在尺寸没变就什么都不动；变了就先把最后一帧
   * 留一份（lastFrame，转屏动画也用它），换好尺寸后按比例画回去。
   */
  onSession({ codec, width, height }) {
    const resized = this.size?.width !== width || this.size?.height !== height;
    if (this.codec !== codec || resized) this.hwPreference = null;
    this.codec = codec;
    const c = this.canvas;
    if (resized && c.width && c.height && this.frames > 0) {
      const keep = document.createElement('canvas');
      keep.width = c.width; keep.height = c.height;
      keep.getContext('2d').drawImage(c, 0, 0);
      this.lastFrame = keep;
      this.lastFrameRotation = this.rotation || 0;
    }
    this.size = { width, height };
    if (resized) {
      c.width = width;
      c.height = height;
      if (this.lastFrame) {
        const f = this.lastFrame;
        const k = Math.min(width / f.width, height / f.height);
        this.ctx.fillStyle = '#000';
        this.ctx.fillRect(0, 0, width, height);
        this.ctx.drawImage(f, (width - f.width * k) / 2, (height - f.height * k) / 2, f.width * k, f.height * k);
      }
    }
    this.awaitingFrame = true;
    this.sessionAt = performance.now();
  }

  /** 新会话的第一帧画好了：转屏动画据此把实时画面换上来。 */
  frameDrawn() {
    this.frames++;
    if (this.awaitingFrame) { this.awaitingFrame = false; this.onFirstFrame?.(); }
  }

  onVideo({ config, key, pts, data }) {
    if (!this.size) return;
    // 预览关掉时不解码（省电脑的 CPU / GPU）；配置包照收，重新打开时从下一个关键帧接上。
    if (this.enabled === false && !config) { this.needKey = true; if (this.mse) this.mse.needKey = true; return; }
    if (this.mse) {
      if (config) this.mse.configure(this.codec, this.size, data);
      else if (!(this.mse.needKey && !key)) { this.mse.needKey = false; this.mse.push(key, pts, data); }
      return;
    }
    if (!Preview.webCodecs()) return;
    if (config) {
      this.configPacket = data;
      this.configure(this.hwPreference ?? 'prefer-hardware');
      return;
    }
    if (!this.decoder || this.decoder.state !== 'configured') return;
    if (this.needKey && !key) return;
    // 不能在解码前丢普通帧：后面的帧都参照它，丢了会花屏、卡到下一个关键帧。真的严重积压（解码器
    // 远远跟不上）时，清空重来并请手机立刻发一个关键帧；平时的追赶靠「每次刷新只画最新一帧」完成。
    if (this.decoder.decodeQueueSize > 24 && !key) {
      this.onStatus?.('预览解码积压，跳到最新画面');
      this.configure(this.hwPreference ?? 'prefer-hardware');
      this.needKey = true;
      this.session?.resetVideo?.(); // 请手机立即发关键帧
      return;
    }
    this.needKey = false;
    this.decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: pts, data: toLengthPrefixed(data, this.codec) }));
  }

  configure(hardwareAcceleration) {
    try {
      const cfg = parseVideoConfig(this.codec, this.configPacket);
      this.reset();
      this.hwPreference = hardwareAcceleration;
      this.mismatchLogged = false;
      this.decoder = new VideoDecoder({
        output: (frame) => this.queueFrame(frame),
        error: (e) => { this.onStatus?.(`预览解码出错：${e.message}`); this.reset(); },
      });
      this.decoder.configure({ codec: cfg.codecString, description: cfg.record, optimizeForLatency: true, hardwareAcceleration });
    } catch (e) {
      this.onStatus?.(`预览不可用：${e.message}`);
    }
  }

  /**
   * 画一帧。
   *
   * 有的硬件解码器（实测出现在高分辨率 H.265 上）报出的可见区域与码流不符：只报了画面上面一截，
   * 直接画就会把那一截拉满整块画布——看起来像竖向拉伸、底部被裁掉。这里拿会话尺寸核对：
   *   1. 编码尺寸装得下会话尺寸 → 按会话尺寸重新指定可见区域再画；
   *   2. 装不下（解码器真的只解了一部分）→ 改用软件解码重来一次；
   *   3. 仍然不对 → 按帧自己的比例画，宁可留黑边也不拉伸。
   */
  /**
   * 解码器每吐出一帧就放进「待画」：上一帧还没来得及画就直接丢掉（只丢已经解好的画面，不影响后续解码）。
   * 真正的绘制放在下一次屏幕刷新里做，120 fps 的流在 60 Hz 屏幕上也只画 60 次，不白费 CPU，也不抢主线程。
   */
  queueFrame(frame) {
    this.pending?.close();
    this.pending = frame;
    if (this.paintScheduled) return;
    this.paintScheduled = true;
    const paint = () => {
      this.paintScheduled = false;
      const f = this.pending;
      this.pending = null;
      if (f) this.draw(f);
    };
    // 页面在后台时 requestAnimationFrame 不跑：那时直接画（反正看不见，只为保住最后一帧）。
    if (document.hidden) setTimeout(paint, 0); else requestAnimationFrame(paint);
  }

  draw(frame) {
    const { width: sw, height: sh } = this.size;
    let src = frame;
    const fw = frame.displayWidth;
    const fh = frame.displayHeight;
    const off = Math.abs(fw / fh - sw / sh) > 0.02;
    if (off) {
      if (!this.mismatchLogged) {
        this.mismatchLogged = true;
        this.onStatus?.(`预览：解码器给出 ${fw}×${fh}（编码 ${frame.codedWidth}×${frame.codedHeight}），与画面 ${sw}×${sh} 不符，已自动校正`);
      }
      if (frame.codedWidth >= sw && frame.codedHeight >= sh) {
        try {
          src = new VideoFrame(frame, { visibleRect: { x: 0, y: 0, width: sw, height: sh }, displayWidth: sw, displayHeight: sh });
        } catch { src = frame; }
      } else if (this.hwPreference !== 'prefer-software') {
        frame.close();
        this.configure('prefer-software');
        return;
      }
    }
    const c = this.canvas;
    if (src === frame && off) {
      // 按帧自身比例居中画，不拉伸。
      const scale = Math.min(c.width / fw, c.height / fh);
      const w = fw * scale;
      const h = fh * scale;
      this.ctx.fillStyle = '#000';
      this.ctx.fillRect(0, 0, c.width, c.height);
      this.ctx.drawImage(src, (c.width - w) / 2, (c.height - h) / 2, w, h);
    } else {
      this.ctx.drawImage(src, 0, 0, c.width, c.height);
    }
    if (src !== frame) src.close();
    frame.close();
    this.frameDrawn();
  }

  // ── 操作手机 ───────────────────────────────────────────────────────
  point(ev) {
    // canvas 可能被 CSS 转了 rotation×90°（预览跟手机转向）：先把指针相对中心的位移转回去，
    // 再按未旋转的 canvas（offsetWidth/Height 不受 transform 影响）和 object-fit: contain 换算。
    const rect = this.canvas.getBoundingClientRect();
    let dx = ev.clientX - (rect.left + rect.width / 2);
    let dy = ev.clientY - (rect.top + rect.height / 2);
    const r = this.rotation || 0;
    if (r === 1) [dx, dy] = [dy, -dx];
    else if (r === 2) [dx, dy] = [-dx, -dy];
    else if (r === 3) [dx, dy] = [-dy, dx];
    const cw = this.canvas.offsetWidth;
    const ch = this.canvas.offsetHeight;
    const scale = Math.min(cw / this.size.width, ch / this.size.height);
    const x = dx / scale + this.size.width / 2;
    const y = dy / scale + this.size.height / 2;
    return { x: Math.max(0, Math.min(this.size.width, x)), y: Math.max(0, Math.min(this.size.height, y)) };
  }


  send(bytes) { if (this.controlEnabled && this.session && this.size) this.session.send(bytes).catch(() => {}); }

  bindInput() {
    const c = this.canvas;
    let down = false;
    c.addEventListener('pointerdown', (ev) => {
      if (!this.controlEnabled || !this.size || ev.button !== 0) return;
      down = true; c.setPointerCapture(ev.pointerId); c.focus();
      const p = this.point(ev);
      this.send(Control.touch(ACTION.DOWN, p.x, p.y, this.size.width, this.size.height));
      ev.preventDefault();
    });
    c.addEventListener('pointermove', (ev) => {
      if (!down) return;
      const p = this.point(ev);
      this.send(Control.touch(ACTION.MOVE, p.x, p.y, this.size.width, this.size.height));
    });
    const up = (ev) => {
      if (!down) return;
      down = false;
      const p = this.point(ev);
      this.send(Control.touch(ACTION.UP, p.x, p.y, this.size.width, this.size.height, 0));
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('contextmenu', (ev) => {
      if (!this.controlEnabled) return;
      ev.preventDefault();
      this.send(Control.backOrScreenOn(ACTION.DOWN));
      this.send(Control.backOrScreenOn(ACTION.UP));
    });
    c.addEventListener('wheel', (ev) => {
      if (!this.controlEnabled || !this.size) return;
      ev.preventDefault();
      const p = this.point(ev);
      this.send(Control.scroll(p.x, p.y, this.size.width, this.size.height, -Math.sign(ev.deltaX), -Math.sign(ev.deltaY)));
    }, { passive: false });
    c.addEventListener('keydown', (ev) => {
      if (!this.controlEnabled) return;
      const code = KEYMAP[ev.key];
      if (code !== undefined) {
        this.send(Control.keycode(ACTION.DOWN, code));
        this.send(Control.keycode(ACTION.UP, code));
      } else if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey) {
        this.send(Control.text(ev.key));
      } else if (ev.key === 'v' && (ev.ctrlKey || ev.metaKey)) {
        navigator.clipboard?.readText().then((t) => this.send(Control.setClipboard(t, true))).catch(() => {});
      } else return;
      ev.preventDefault();
    });
  }

  key(code) {
    this.send(Control.keycode(ACTION.DOWN, code));
    this.send(Control.keycode(ACTION.UP, code));
  }
}
