// scrcpy 控制消息（电脑 → 手机）的序列化，格式对照 v5.0.1 的 ControlMessageReader。

import { utf8 } from '../bytes.js';

export const TYPE = {
  INJECT_KEYCODE: 0, INJECT_TEXT: 1, INJECT_TOUCH_EVENT: 2, INJECT_SCROLL_EVENT: 3, BACK_OR_SCREEN_ON: 4,
  EXPAND_NOTIFICATION_PANEL: 5, EXPAND_SETTINGS_PANEL: 6, COLLAPSE_PANELS: 7, GET_CLIPBOARD: 8, SET_CLIPBOARD: 9,
  SET_DISPLAY_POWER: 10, ROTATE_DEVICE: 11, OPEN_HARD_KEYBOARD_SETTINGS: 15, START_APP: 16, RESET_VIDEO: 17,
  CAMERA_SET_TORCH: 18, CAMERA_ZOOM_IN: 19, CAMERA_ZOOM_OUT: 20, RESIZE_DISPLAY: 21, SCAN_FILE: 22,
};

export const ACTION = { DOWN: 0, UP: 1, MOVE: 2 };
export const KEY = { HOME: 3, BACK: 4, VOLUME_UP: 24, VOLUME_DOWN: 25, POWER: 26, APP_SWITCH: 187, MENU: 82 };
/** scrcpy 约定的「通用手指」指针 id：鼠标拖动按单指触摸注入。 */
export const POINTER_ID_GENERIC_FINGER = -2n;

function msg(size, type) {
  const b = new Uint8Array(size);
  const v = new DataView(b.buffer);
  v.setUint8(0, type);
  return [b, v];
}

function u16Fixed(f) { return Math.max(0, Math.min(0xffff, Math.round(f * 0x10000))); }
function i16Fixed(f) { return Math.max(-0x8000, Math.min(0x7fff, Math.round(f * 0x8000))); }

export const Control = {
  empty(type) { return msg(1, type)[0]; },

  keycode(action, keycode, repeat = 0, metaState = 0) {
    const [b, v] = msg(14, TYPE.INJECT_KEYCODE);
    v.setUint8(1, action); v.setInt32(2, keycode); v.setInt32(6, repeat); v.setInt32(10, metaState);
    return b;
  },

  text(text) {
    const data = utf8.encode(text).subarray(0, 300);
    const [b, v] = msg(5 + data.length, TYPE.INJECT_TEXT);
    v.setUint32(1, data.length); b.set(data, 5);
    return b;
  },

  /** x/y 是视频帧坐标，screenW/H 必须是当前视频尺寸（服务端据此换算，尺寸对不上会丢弃事件）。 */
  touch(action, x, y, screenW, screenH, pressure = 1, pointerId = POINTER_ID_GENERIC_FINGER, buttons = 0) {
    const [b, v] = msg(32, TYPE.INJECT_TOUCH_EVENT);
    v.setUint8(1, action);
    v.setBigInt64(2, pointerId);
    v.setInt32(10, Math.round(x)); v.setInt32(14, Math.round(y));
    v.setUint16(18, screenW); v.setUint16(20, screenH);
    v.setUint16(22, u16Fixed(pressure));
    v.setInt32(24, 0); v.setInt32(28, buttons);
    return b;
  },

  scroll(x, y, screenW, screenH, hScroll, vScroll) {
    const [b, v] = msg(21, TYPE.INJECT_SCROLL_EVENT);
    v.setInt32(1, Math.round(x)); v.setInt32(5, Math.round(y));
    v.setUint16(9, screenW); v.setUint16(11, screenH);
    v.setInt16(13, i16Fixed(hScroll / 16)); v.setInt16(15, i16Fixed(vScroll / 16));
    v.setInt32(17, 0);
    return b;
  },

  /** copyKey：0 只读取，1 先在手机上「复制」，2 先「剪切」。结果经设备消息回来（onClipboard）。 */
  getClipboard(copyKey = 0) { const [b, v] = msg(2, TYPE.GET_CLIPBOARD); v.setUint8(1, copyKey); return b; },

  backOrScreenOn(action) { const [b, v] = msg(2, TYPE.BACK_OR_SCREEN_ON); v.setUint8(1, action); return b; },
  setDisplayPower(on) { const [b, v] = msg(2, TYPE.SET_DISPLAY_POWER); v.setUint8(1, on ? 1 : 0); return b; },
  cameraTorch(on) { const [b, v] = msg(2, TYPE.CAMERA_SET_TORCH); v.setUint8(1, on ? 1 : 0); return b; },

  setClipboard(text, paste = false, sequence = 0n) {
    const data = utf8.encode(text);
    const [b, v] = msg(14 + data.length, TYPE.SET_CLIPBOARD);
    v.setBigUint64(1, sequence); v.setUint8(9, paste ? 1 : 0); v.setUint32(10, data.length); b.set(data, 14);
    return b;
  },

  /** 包名；前缀 '+' 表示先强停再启动（scrcpy 的约定）。 */
  startApp(name) {
    const data = utf8.encode(name).subarray(0, 255);
    const [b, v] = msg(2 + data.length, TYPE.START_APP);
    v.setUint8(1, data.length); b.set(data, 2);
    return b;
  },

  resizeDisplay(width, height) {
    const [b, v] = msg(5, TYPE.RESIZE_DISPLAY); v.setUint16(1, width); v.setUint16(3, height); return b;
  },

  scanFile(path) {
    const data = utf8.encode(path);
    const [b, v] = msg(5 + data.length, TYPE.SCAN_FILE); v.setUint32(1, data.length); b.set(data, 5);
    return b;
  },
};
