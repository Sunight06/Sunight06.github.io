// 引擎：网页里「不画界面」的那一半。界面由 Kotlin/Wasm + Miuix（remote-web-ui）绘制，
// 通过 window.SunightRemote 与这里交互：
//
//   subscribe(cb)          每次状态变化回调一份完整状态（JSON 字符串）
//   call(name, argJson)    执行一个动作（连接、开始录制……），结果体现在下一份状态里
//   placeVideo(x,y,w,h,v)  Compose 量出预览卡片的位置（CSS 像素），实时画面的 <canvas> 盖在那里
//
// 实时画面不进 Compose：它是一块独立的 HTML canvas，WebCodecs 直接往上画，零拷贝、零额外延迟。

import { Adb } from './adb/adb.js';
import { AdbKey } from './adb/auth.js';
import { UsbTransport, WebSocketTransport } from './adb/transport.js';
import { ScrcpySession, listCapabilities, listApps } from './scrcpy/session.js';
import { mergeOptions, parseLists } from './scrcpy/options.js';
import { Control, ACTION } from './scrcpy/control.js';
import { Recorder } from './recorder.js';
import { Transcoder } from './media/transcode.js';
import { Preview } from './media/preview.js';
import { AppLink } from './link.js';
import { Storage, timestampName } from './storage.js';
import { utf8d } from './bytes.js';
import { defragment } from './media/defrag.js';
import { Library } from './library.js';
import { pinyinInitials } from './pinyin.js';

const EXT_KEY = 'sunight.remote.ext.v2';
const RELAY_PORT = 27184;
const FALLBACK_ARGS = { video_codec: 'h264', video_bit_rate: '12000000', audio_codec: 'aac', capture_orientation: '@' };

/** scrcpy 扩展参数的默认值（网页侧，按浏览器记住）。 */
const RECENT_APPS_KEY = 'sunight.remote.recentApps.v1';
// 应用图标（base64 PNG）：由手机端小白录制画好送来，按包名缓存在内存和 localStorage；'' 表示手机上也取不到。
const ICON_PREFIX = 'sunight.remote.icon.v1.';
const appIcons = new Map();
const iconRequested = new Set();
const iconWaiters = new Map();
let iconReqId = 0;

/**
 * 一次把这些应用的图标要齐（每批 80 个，等手机回完再要下一批）。
 * 应用列表在图标到齐之后才算「就绪」：搜索结果、最近打开出来时图标就在，不会先空着再一个个冒出来。
 * 手机端小白录制没连上时直接返回（界面用首字头像）。
 */
async function fetchIcons(pkgs) {
  const want = [...new Set(pkgs)].filter((p) => p && !appIcons.has(p) && !localStorage.getItem(ICON_PREFIX + p));
  for (let i = 0; i < want.length && rt.link; i += 80) {
    const id = ++iconReqId;
    const done = new Promise((resolve) => { iconWaiters.set(id, resolve); setTimeout(resolve, 6000); });
    rt.link.send({ t: 'icons_req', id, pkgs: want.slice(i, i + 80) });
    await done;
    iconWaiters.delete(id);
  }
}

function appIcon(pkg) {
  if (!appIcons.has(pkg)) { const v = localStorage.getItem(ICON_PREFIX + pkg); if (v) appIcons.set(pkg, v); }
  return appIcons.get(pkg) ?? '';
}
const appsCacheKey = () => `sunight.remote.apps.v1.${rt.adb?.model ?? ''}`;

export const DEFAULT_EXT = {
  source: 'display', displayId: '', vdSize: '', vdDpi: '', vdApp: '', vdDecor: true, vdDestroy: true,
  camId: '', camFacing: 'back', camSize: '', camFps: '', camAr: '', camZoom: '', camHighSpeed: false,
  videoEncoder: '', audioEncoder: '', audioSource: '', audioCodec: '', captureOrientation: '', angle: '', crop: '',
  maxSize: '', maxFps: '', videoCodecOptions: '', stayAwake: true, screenOff: false, powerOffOnClose: false,
  showTouches: false, ignoreConstraints: false, fileRotation: 'auto', limitMinutes: '',
};

const s = {
  usb: { supported: UsbTransport.supported(), paired: false, secure: globalThis.isSecureContext },
  relay: null,
  transport: { connected: false, connecting: false, kind: null, label: '' },
  authPrompt: false,
  device: null,
  app: { connected: false, info: null },
  scrcpy: { version: '', status: 'idle', codec: '', width: 0, height: 0, error: '' },
  rec: { state: 'idle', elapsedMs: 0, bytes: 0, file: null },
  upload: { active: false, progress: 0, file: '' },
  folder: { supported: Storage.folderSupported(), name: '' },
  caps: { displays: [], cameras: [], videoEncoders: [], audioEncoders: [] },
  ext: { ...DEFAULT_EXT },
  /** 在电脑上用鼠标键盘操作手机：默认开启。 */
  control: true,
  /** 实时预览（关掉只是电脑不解码、不显示，录制和操作照常）。 */
  preview: localStorage.getItem('sunight.remote.preview') !== 'off',
  /** 手机屏幕是不是被这边关掉了（熄屏 / 亮屏共用一个按钮，图标按它切换）。 */
  phoneScreenOff: false,
  previewSupported: Preview.supported(),
  logs: [],
  /** 视频列表（最新在前）：本次录的 + 保存文件夹里已有的。缩略图另经 SunightRemote.thumb(id) 取。 */
  library: [],
  /** 正在往手机送的那一批：剩几个、当前第几个。 */
  sending: { active: false, total: 0, done: 0, current: '' },
  toast: null,
  wirelessUrl: '',
  /** 手机端小白录制的 Miuix 主题（上次连接时记下的，没连过就是 null = 跟随系统）。 */
  theme: (() => { try { return JSON.parse(localStorage.getItem('sunight.remote.theme') ?? 'null'); } catch { return null; } })(),
  /** 「开启无线」对话框的进度：idle / enabling / ready / failed。 */
  wireless: { status: 'idle', error: '' },
  /** 手机上的应用（「操控」页的搜索用）：status = idle / loading / ready / failed；recent 是最近从这里打开过的包名。 */
  apps: { status: 'idle', list: [], recent: (() => { try { return JSON.parse(localStorage.getItem(RECENT_APPS_KEY) ?? '[]'); } catch { return []; } })() },
  /** 往手机传文件 / 装 APK 的进度。 */
  transfer: { active: false, name: '', progress: 0, index: 0, total: 0 },
  /** 最近一次从手机剪贴板取回的文字。 */
  phoneClipboard: '',
};

const rt = {
  adb: null, server: null, session: null, link: null, recorder: null, preview: null, folder: null,
  targetFactory: null, restartPending: false, busy: false, toastId: 0, uploadChain: Promise.resolve(),
};

// ── 状态广播 ─────────────────────────────────────────────────────────
const listeners = new Set();
let scheduled = false;
/**
 * 发给界面的状态。两样大东西不随每次状态一起发：应用列表（几百项）和日志（几百行）——录制中每半秒一次
 * 状态更新，带着它们序列化、再在界面那边整份解析，白白占主线程，预览就跟着卡。界面看到版本号变了，
 * 再经 SunightRemote.appList() / logs() 单独取。
 */
function snapshotJson() {
  return JSON.stringify(s, (key, value) => {
    if (key === 'logs') return undefined;
    if (key === 'list' && Array.isArray(value) && value === s.apps.list) return undefined;
    return value;
  });
}

function emit() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    const json = snapshotJson();
    for (const cb of listeners) { try { cb(json); } catch (e) { console.error(e); } }
  });
}

function log(line) {
  console.log('[remote]', line);
  s.logs.push(line);
  if (s.logs.length > 300) s.logs.splice(0, s.logs.length - 300);
  s.logsVersion = (s.logsVersion ?? 0) + 1;
  emit();
}

function toast(text) { s.toast = { id: ++rt.toastId, text }; log(`⚠ ${text}`); }

// ── scrcpy 服务端 ────────────────────────────────────────────────────
async function loadServer() {
  if (rt.server) return rt.server;
  const meta = await (await fetch('scrcpy/server.json')).json();
  const bytes = new Uint8Array(await (await fetch(`scrcpy/${meta.file}`)).arrayBuffer());
  rt.server = { ...meta, bytes };
  s.scrcpy.version = meta.version;
  emit();
  return rt.server;
}

// ── 连接 ────────────────────────────────────────────────────────────
/**
 * 把连接时的底层异常翻译成用户看得懂的一句话。
 * 首次连接最常见的是 USB「transferIn / transferOut」出错：手机上刚点了「允许 USB 调试」，ADB 服务随之重启，
 * 原来那条连接就断了——这不是故障，重连一次就好（connect 里会自动重试一次）。
 */
function friendlyError(e) {
  const m = `${e?.message ?? e}`;
  if (e?.busy) return m;
  if (/transfer(In|Out)|transfer error|disconnected|device unavailable|NetworkError|The device was disconnected/i.test(m)) {
    return '和手机的连接中断了。请确认手机上已点「允许 USB 调试」，再点一次「连接手机」；仍不行就拔插一下数据线。';
  }
  if (/auth|授权|Unauthorized/i.test(m)) return '手机还没有允许这台电脑调试：请在手机弹出的窗口里点「允许」，再点「连接手机」。';
  if (/没有 ADB 接口|USB 调试/.test(m)) return m;
  if (/timeout|超时/i.test(m)) return '手机没有响应：请解锁手机、确认已打开「USB 调试」，再点「连接手机」。';
  return `连接没有成功：${m}`;
}

function isTransferGlitch(e) {
  return !e?.busy && /transfer(In|Out)|transfer error|disconnected|device unavailable/i.test(`${e?.message ?? e}`);
}

async function connect(transportPromise, { quiet = false, retried = false } = {}) {
  if (s.transport.connected || s.transport.connecting) return;
  s.transport.connecting = true; emit();
  let transport = null;
  try {
    transport = await transportPromise;
    s.transport.kind = transport.kind;
    s.transport.label = transport.label;
    emit();
    const key = AdbKey.loadOrCreate();
    const adb = await Adb.connect(transport, key, { onAuthPrompt: () => { s.authPrompt = true; emit(); } });
    s.authPrompt = false;
    rt.adb = adb;
    adb.onclose = (e) => onDisconnected(e);
    s.transport = { connected: true, connecting: false, kind: transport.kind, label: adb.model };
    s.reconnecting = false;
    rt.manualDisconnect = false;
    log(`已连接 ${adb.model}`);
    await readDevice();

    const server = await loadServer();
    s.scrcpy.status = 'starting'; emit();
    const caps = parseLists(await listCapabilities(adb, server));
    s.caps = {
      displays: caps.displays,
      cameras: caps.cameras,
      videoEncoders: caps.encoders.video.filter((e) => e.codec === 'h264' || e.codec === 'h265'),
      audioEncoders: caps.encoders.audio.filter((e) => e.codec === 'aac' || e.codec === 'opus'),
    };
    emit();

    rt.reconnectDelay = 0;
    pollRotation(adb);
    const rot = await readRotation(adb);
    if (rot !== null) rt.deviceRotation = rot;
    await openAppLink(adb);
    // 有应用通道时等它的 hello（带参数）起会话；等不到就按默认参数起。
    setTimeout(() => { if (!rt.session && rt.adb === adb) restartSession(); }, rt.link ? 1500 : 0);
  } catch (e) {
    s.transport.connecting = false;
    s.authPrompt = false;
    if (e?.name === 'NotFoundError') { emit(); return; } // 选择框里点了取消
    log(`连接失败（原始信息）：${e?.message ?? e}`);
    await disconnect();
    // 握手阶段就失败时 adb 还没建起来，disconnect 管不到这条 USB：先放掉接口，重试才能重新占用。
    try { await transport?.close(); } catch { /* 已经断了 */ }
    // 首次连接（刚点了允许、ADB 重启）常见的 USB 传输中断：等手机缓一下，悄悄重连一次。
    const device = transport?.device;
    if (!retried && device && isTransferGlitch(e)) {
      s.transport.connecting = true; emit();
      await new Promise((r) => setTimeout(r, 1500));
      s.transport.connecting = false;
      return connect(UsbTransport.open(device), { quiet, retried: true });
    }
    if (quiet) log(`重连失败：${friendlyError(e)}`); else toast(friendlyError(e));
    emit();
  }
}

async function readDevice() {
  const out = (await rt.adb.shell('getprop ro.build.version.release; getprop ro.build.version.sdk; getprop ro.product.manufacturer')).trim().split(/\s+/);
  const ip = (await rt.adb.shell('ip -4 -o addr show wlan0 2>/dev/null')).match(/inet (\d+\.\d+\.\d+\.\d+)/)?.[1] ?? '';
  s.device = { model: rt.adb.model, manufacturer: out[2] ?? '', android: out[0] ?? '', sdk: +out[1] || 0, ip };
  emit();
}

/**
 * 打开与手机应用的通道。打不开、或之后断了（应用被系统清掉、远程服务重启），只要 ADB 还连着就每 3 秒
 * 重试一次：手机那边「电脑已连接」与电脑这边的参数、指令同步都靠它，不能断了就不管。
 */
async function openAppLink(adb) {
  clearTimeout(rt.linkRetry);
  if (rt.adb !== adb || rt.link) return;
  try {
    const link = await AppLink.open(adb, { onLog: log });
    if (rt.adb !== adb) { link.close(); return; }
    rt.link = link;
    bindLink(link);
    s.app.connected = true; emit();
    await link.send({ t: 'hello', v: 1, client: 'web', scrcpy: rt.server?.version, transport: s.transport.kind });
    sendState();
    sendListToPhone();
  } catch (e) {
    if (!rt.linkFailLogged) log(`应用通道不可用：${e.message}；先用网页默认参数，稍后自动重试`);
    rt.linkFailLogged = true;
    rt.linkRetry = setTimeout(() => openAppLink(adb), 3000);
  }
}

function onDisconnected(error) {
  if (!rt.adb) return;
  // 刚开启无线：手机的调试服务按预期重启了一下，USB 稍后自动重连，不当成意外断开。
  if (rt.tcpipRestart && s.transport.kind === 'usb') {
    rt.tcpipRestart = false;
    log('手机调试服务已切到无线模式，正在重新连接 USB…');
    disconnect().then(() => setTimeout(() => actions.reconnectUsb().catch(() => {}), 2500));
    return;
  }
  log(`连接断开${error?.message ? '：' + error.message : ''}`);
  // 无线断开（手机切了网络、锁屏后 Wi-Fi 休眠、中继重启）：自动重连，不用用户再点一次。
  if (s.transport.kind === 'wifi' && !rt.manualDisconnect) scheduleWifiReconnect();
  if (rt.recorder.state !== 'idle') {
    // 拔线：已写入的分片都在文件里，收个尾就是能播的文件。
    rt.recorder.stop().then((files) => files.forEach((f) => log(`已保存（连接中断）${f.name}`)));
  }
  disconnect();
}

function wifiToken() {
  return new URLSearchParams(location.search).get('token') || rt.wifiToken || '';
}

function scheduleWifiReconnect() {
  clearTimeout(rt.wifiRetry);
  rt.reconnectDelay = Math.min(10_000, (rt.reconnectDelay || 1000) * 1.5);
  s.reconnecting = true;
  log(`${Math.round(rt.reconnectDelay / 1000)} 秒后自动重连无线…`);
  rt.wifiRetry = setTimeout(async () => {
    if (s.transport.connected || s.transport.connecting || rt.manualDisconnect) return;
    await connect(WebSocketTransport.connect(`ws://${location.host}/adb?token=${encodeURIComponent(wifiToken())}`), { quiet: true });
    if (!s.transport.connected && !rt.manualDisconnect) scheduleWifiReconnect();
  }, rt.reconnectDelay);
}

async function disconnect() {
  clearTimeout(rt.linkRetry);
  clearInterval(rt.rotationPoll);
  rt.session?.stop();
  rt.session = null;
  await rt.link?.close().catch(() => {});
  rt.link = null;
  const adb = rt.adb;
  rt.adb = null;
  rt.idlePaused = false; clearTimeout(rt.idleTimer);
  await adb?.close().catch(() => {});
  s.transport = { connected: false, connecting: false, kind: null, label: '' };
  s.app = { connected: false, info: null };
  s.device = null;
  s.scrcpy = { ...s.scrcpy, status: 'idle', codec: '', width: 0, height: 0 };
  emit();
}

// ── 应用通道 ────────────────────────────────────────────────────────
function bindLink(link) {
  link.on('rotation', (msg) => onDeviceRotation(msg.value));
  const onInfo = (msg) => {
    const before = JSON.stringify(s.app.info?.scrcpy?.args ?? null);
    s.app.info = msg;
    if (Number.isInteger(msg.rotation)) onDeviceRotation(msg.rotation);
    if (msg.theme) { s.theme = msg.theme; localStorage.setItem('sunight.remote.theme', JSON.stringify(msg.theme)); }
    if (msg.wireless?.enabled && s.device?.ip) {
      s.wirelessUrl = `http://${s.device.ip}:${msg.wireless.port ?? RELAY_PORT}/?token=${msg.wireless.token}`;
    }
    emit();
    if (JSON.stringify(msg.scrcpy?.args ?? null) !== before) requestRestart('手机端录制参数已更新');
  };
  link.on('hello', onInfo).on('config', onInfo);
  link.on('list_req', () => sendListToPhone());
  if (s.apps.list.length) fetchIcons([...s.apps.recent, ...s.apps.list.map((a) => a.pkg)]).then(emit);
  link.on('icons', (msg) => {
    for (const [pkg, b64] of Object.entries(msg.icons ?? {})) {
      appIcons.set(pkg, b64 || '');
      if (b64) try { localStorage.setItem(ICON_PREFIX + pkg, b64); } catch { /* 存满了就只留在内存里 */ }
    }
    s.apps.iconsVersion = (s.apps.iconsVersion ?? 0) + 1;
    iconWaiters.get(msg.id)?.();
    iconWaiters.delete(msg.id);
    emit();
  });
  link.on('pull', (msg) => sendToPhone((msg.ids ?? []).map(String)));
  link.on('cmd', async (msg) => {
    let ok = true; let error = null; let result = {};
    try { result = (await command(msg.op, 'phone', msg)) ?? {}; } catch (e) { ok = false; error = e.message; if (msg.op === 'start') toast(e.message); }
    link.send({ t: 'cmd_result', id: msg.id, op: msg.op, ok, error, ...result });
  });
  link.on('close', () => {
    if (rt.link !== link) return;
    rt.link = null;
    s.app.connected = false;
    emit();
    log('与手机应用的通道断开，正在重连…');
    rt.linkFailLogged = false;
    const adb = rt.adb;
    if (adb) rt.linkRetry = setTimeout(() => openAppLink(adb), 1000);
  });
}

function sendState(extra = {}) {
  // 待机省电（页面在后台时暂停了画面）也算「随时能录」：手机上点开始时这边会先把画面接回来。
  rt.link?.send({ t: 'state', ...rt.recorder.snapshot(), previewing: !!rt.session || !!rt.idlePaused, ...extra });
}

// ── 待机省电 ─────────────────────────────────────────────────────────
//
// 页面不在前台、也没在录（含游戏回放）时，手机仍在按录制参数满帧编码（比如 120 fps、24 Mbps）——
// 没人看、也没人录，纯属发热。页面转到后台满 60 秒就先停掉视频会话（USB / 无线连接和应用通道都保留）；
// 回到页面立刻接回，手机上点开始录制时也会先接回再开始（多等不到一秒）。
const IDLE_PAUSE_MS = 60_000;

function scheduleIdlePause() {
  clearTimeout(rt.idleTimer);
  if (!document.hidden) { if (rt.idlePaused) wakeSession(); return; }
  rt.idleTimer = setTimeout(() => {
    if (!document.hidden || !rt.session || rt.recorder.state !== 'idle' || rt.busy || rt.transcoder) return;
    rt.idlePaused = true;
    log('页面在后台：已暂停手机画面以省电，回到页面或开始录制时自动恢复');
    const session = rt.session;
    rt.session = null;
    session.stop();
    s.scrcpy.status = 'standby';
    emit(); sendState();
  }, IDLE_PAUSE_MS);
}

async function wakeSession() {
  if (!rt.idlePaused) return;
  rt.idlePaused = false;
  log('恢复手机画面');
  await restartSession();
}

// ── 参数 ────────────────────────────────────────────────────────────
function extOptions(base) {
  const x = s.ext;
  const o = {};
  if (x.source === 'camera') {
    o.video_source = 'camera';
    if (x.camId) o.camera_id = x.camId; else o.camera_facing = x.camFacing;
    o.camera_size = x.camSize; o.camera_fps = x.camFps; o.camera_ar = x.camAr; o.camera_zoom = x.camZoom;
    if (x.camHighSpeed) o.camera_high_speed = 'true';
  } else if (x.source === 'new_display') {
    const main = s.caps.displays[0];
    const size = x.vdSize || (main ? `${main.width}x${main.height}` : '1920x1080');
    o.new_display = `${size}${x.vdDpi ? '/' + x.vdDpi : ''}`;
    o.vd_system_decorations = String(!!x.vdDecor);
    o.vd_destroy_content = String(!!x.vdDestroy);
  } else if (x.displayId) {
    o.display_id = x.displayId;
  }
  if (x.videoEncoder) { const [codec, name] = x.videoEncoder.split('|'); o.video_codec = codec; o.video_encoder = name; }
  if (x.audioCodec) o.audio_codec = x.audioCodec;
  if (x.audioEncoder) { const [codec, name] = x.audioEncoder.split('|'); o.audio_codec = codec; o.audio_encoder = name; }
  if (x.audioSource === 'none') o.audio = 'false';
  else if (x.audioSource) { o.audio = 'true'; o.audio_source = x.audioSource; o.audio_dup = x.audioSource === 'playback' ? 'true' : ''; }
  if (x.captureOrientation) o.capture_orientation = x.captureOrientation;
  if (x.angle) o.angle = x.angle;
  if (x.crop) o.crop = x.crop;
  if (x.maxSize) o.max_size = x.maxSize;
  if (x.maxFps) o.max_fps = x.maxFps;
  if (x.videoCodecOptions) o.video_codec_options = [base.video_codec_options, x.videoCodecOptions].filter(Boolean).join(',');
  if (x.stayAwake) o.stay_awake = 'true';
  if (x.powerOffOnClose) o.power_off_on_close = 'true';
  if (x.showTouches) o.show_touches = 'true';
  if (x.ignoreConstraints) o.ignore_video_encoder_constraints = 'true';
  return o;
}

// ── 会话 ────────────────────────────────────────────────────────────
function requestRestart(reason) {
  if (!rt.adb) return;
  if (rt.recorder.state !== 'idle') {
    rt.restartPending = true;
    log(`${reason}：本次录制结束后生效`);
    return;
  }
  log(`${reason}，重启画面`);
  restartSession();
}

/**
 * 预览跟着手机转：录制锁定了采集方向（文件只有一种尺寸，不会因转屏分段），
 * 手机转成横屏时画面在竖着的帧里是侧躺的。这里按「当前方向 − 开始时的方向」把预览转正，
 * 和 scrcpy 窗口的观感一致；录出来的文件不受影响。
 *
 * 只在采集被锁定在开始方向（'@'）或自然方向（'@0'）时转：跟随旋转时帧本身就是正的。
 */
function updateViewRotation() {
  const lock = rt.sessionOptions?.capture_orientation ?? '';
  let base = null;
  if (lock === '@') base = rt.rotationAtStart ?? 0;
  else if (lock === '@0') base = 0;
  const view = base === null || rt.deviceRotation == null ? 0 : (((rt.deviceRotation - base) % 4) + 4) % 4;
  if (view !== s.scrcpy.viewRotation) {
    startRotationAnim(((view - s.scrcpy.viewRotation) % 4 + 4) % 4, false);
    s.scrcpy.viewRotation = view;
    // 实测（OnePlus / Android 16）：手机转到 ROTATION_90 时，锁定方向的帧里内容是顺时针躺倒的，
    // 所以预览要逆时针转回来。preview.rotation 记的是「顺时针转了几个 90°」。
    rt.preview.rotation = (4 - view) % 4;
    applyVideoPlacement();
    emit();
  }
}

function onDeviceRotation(r) {
  if (!Number.isInteger(r)) return;
  const before = rt.deviceRotation;
  rt.deviceRotation = r;
  // 不锁方向时，转屏后 scrcpy 会按新尺寸重开视频：动画要等新会话的第一帧再换上实时画面。
  const lock = rt.sessionOptions?.capture_orientation ?? '';
  if (before != null && before !== r && lock !== '@' && lock !== '@0') startRotationAnim(((r - before) % 4 + 4) % 4, true);
  updateViewRotation();
}

/**
 * 当前屏幕方向（0–3，即 ROTATION_0…270）。Android 16 起 `dumpsys input` 不再打印 SurfaceOrientation，
 * 先读 `dumpsys window displays` 的 mDisplayRotation，读不到再退回旧写法。
 */
async function readRotation(adb) {
  const out = await adb.shell('dumpsys window displays | grep -m1 -o "mDisplayRotation=ROTATION_[0-9]*"; dumpsys input | grep -m1 SurfaceOrientation').catch(() => '');
  const m = out.match(/ROTATION_(\d+)/);
  if (m) return Math.round(+m[1] / 90) % 4;
  const old = out.match(/SurfaceOrientation:\s*(\d)/);
  return old ? +old[1] : null;
}

/**
 * 方向平时由手机上的小白录制经应用通道主动推送（转屏的同一刻就到）。
 * 只有应用通道没连上时，才每秒用 ADB 问一次兜底。
 */
function pollRotation(adb) {
  clearInterval(rt.rotationPoll);
  rt.rotationPoll = setInterval(async () => {
    if (rt.adb !== adb) { clearInterval(rt.rotationPoll); return; }
    if (rt.link) return;
    const r = await readRotation(adb);
    if (r !== null) onDeviceRotation(r);
  }, 1000);
}

async function restartSession() {
  if (!rt.adb || !rt.server) return;
  rt.session?.stop();
  const base = s.app.info?.scrcpy?.args ?? FALLBACK_ARGS;
  const options = mergeOptions(base, extOptions(base));
  rt.sessionOptions = options;
  rt.rotationAtStart = rt.deviceRotation ?? 0;
  s.scrcpy.viewRotation = 0;
  rt.preview.rotation = 0;
  const session = new ScrcpySession(rt.adb, rt.server, options, {
    onLog: log,
    onVideoSession: (v) => {
      if (rt.rot) rt.rot.liveReady = false;
      setTimeout(updateViewRotation, 0);
      // 转正重编码时，录制看到的是编码器输出的固定尺寸，不是手机原始帧。
      if (!rt.transcoder) rt.recorder.onVideoSession(v);
      rt.preview.onSession(v);
      Object.assign(s.scrcpy, { codec: v.codec, width: v.width, height: v.height });
      emit();
    },
    onVideo: (p) => {
      if (p.config) rt.rawConfig = p.data;
      if (rt.transcoder) rt.transcoder.push(p, s.scrcpy.codec); else rt.recorder.onVideo(p);
      rt.preview.onVideo(p);
    },
    onAudioCodec: (c) => rt.recorder.onAudioCodec(c),
    onAudio: (p) => rt.recorder.onAudio(p),
    onClipboard: (text) => {
      s.phoneClipboard = text;
      navigator.clipboard?.writeText(text).then(() => toast('已复制手机剪贴板到电脑'), () => toast('已取回手机剪贴板'));
      emit();
    },
    onClose: (e) => {
      if (rt.session !== session) return;
      rt.session = null;
      s.scrcpy.status = e ? 'failed' : 'idle';
      s.scrcpy.error = e?.message ?? '';
      if (e) log(`手机画面同步中断：${e.message}`);
      if (rt.recorder.state !== 'idle') command('stop', 'session-end');
      emit(); sendState();
    },
  });
  rt.session = session;
  rt.preview.attach(session);
  s.scrcpy.status = 'starting'; s.scrcpy.error = ''; emit();
  try {
    await session.start();
    if (rt.session !== session) return;
    s.scrcpy.status = 'running';
    if (options.new_display !== undefined && s.ext.vdApp) await session.send(Control.startApp(s.ext.vdApp));
  } catch (e) {
    if (rt.session !== session) return;
    log(`手机画面同步失败：${e.message}`);
    s.scrcpy.status = 'failed'; s.scrcpy.error = e.message;
    rt.session = null;
  }
  emit(); sendState();
}

// ── 录制 ────────────────────────────────────────────────────────────
function fileRotation(size) {
  const x = s.ext.fileRotation;
  if (x && x !== 'auto') return +x;
  const o = s.app.info?.orientation; // 手机方向设置：1 横屏、2 竖屏
  if (o === 1 && size.height > size.width) return 90;
  if (o === 2 && size.width > size.height) return 270;
  return 0;
}

async function prepareTarget(fromUserGesture) {
  let folder = rt.folder;
  if (folder) {
    let granted = (await folder.queryPermission({ mode: 'readwrite' })) === 'granted';
    if (!granted && fromUserGesture) granted = await Storage.ensurePermission(folder);
    if (!granted) { log('保存文件夹需要重新授权（由手机发起的录制无法弹授权框）：本次先存在浏览器里'); folder = null; }
  }
  rt.targetFactory = Storage.targetFactory(folder);
}

/**
 * 方向跟手机上的设置走（文案与 App 一致）：
 *   智能自动 / 横屏 / 竖屏 —— 画面始终是正的、铺满整个画面：电脑上解码 → 摆正 → 铺满 → 重新编码；
 *   高性能自动           —— 按开始时的方向录，不处理旋转：直接写手机送来的码流。
 * 浏览器不支持重编码时退回直写，并说明原因。
 */
async function startTranscoderIfNeeded(info) {
  stopTranscoder();
  const orientation = info.orientation ?? 3;
  if (orientation === 3) return;
  if (!Transcoder.supported()) { log('这个浏览器不能重新编码，本次按开始时的方向录制'); return; }
  const rw = s.scrcpy.width;
  const rh = s.scrcpy.height;
  if (!rw || !rh || !rt.rawConfig) return;
  const long = Math.max(rw, rh);
  const short = Math.min(rw, rh);
  const [width, height] = orientation === 1 ? [long, short] : orientation === 2 ? [short, long] : [rw, rh];
  const args = info.scrcpy?.args ?? {};
  const keyFrameSeconds = +(/i-frame-interval=(\d+)/.exec(args.video_codec_options ?? '')?.[1] ?? 2);
  const tc = new Transcoder({
    codec: s.scrcpy.codec === 'h265' ? 'h265' : 'h264',
    width, height,
    bitrate: +(args.video_bit_rate ?? 12_000_000),
    fps: Math.min(+(args.max_fps ?? 60) || 60, 120),
    keyFrameSeconds,
    rotation: () => rt.preview.rotation || 0,
    onPacket: (p) => rt.recorder.onVideo(p),
    onLog: log,
  });
  const outCodec = await tc.open();
  rt.transcoder = tc;
  rt.recorder.onVideoSession({ codec: outCodec, width: width & ~1, height: height & ~1 });
  rt.recorder.videoConfig = null;
  tc.push({ config: true, data: rt.rawConfig }, s.scrcpy.codec);
  await rt.session?.resetVideo(); // 解码要从关键帧开始
  const ok = await Promise.race([tc.ready.then(() => true), new Promise((r) => setTimeout(() => r(false), 6000))]);
  if (!ok) {
    stopTranscoder();
    throw new Error('重新编码没有启动起来，请在手机上把方向改成「高性能自动」后再试');
  }
}

function stopTranscoder() {
  if (!rt.transcoder) return;
  rt.transcoder.close();
  rt.transcoder = null;
  // 录制回到直写手机码流的状态，下次开始时不必等新的配置包。
  rt.recorder.onVideoSession({ codec: s.scrcpy.codec, width: s.scrcpy.width, height: s.scrcpy.height });
  rt.recorder.videoConfig = rt.rawConfig ?? null;
}

/**
 * 执行一条录制指令（来自网页按钮或手机）。返回值会并进给手机的 cmd_result（回放实际存了几秒等）。
 * 手机上的录制方式、游戏回放、定时、分段都按手机那一份设置来，用户在手机上怎么用，这里就怎么做。
 */
async function command(op, from, msg = {}) {
  const r = rt.recorder;
  const info = s.app.info ?? {};
  if (op === 'start') {
    if (rt.busy || r.state !== 'idle') return;
    if (!rt.session && rt.idlePaused) await wakeSession();
    if (!rt.session) throw new Error('电脑端还没有手机画面');
    rt.busy = true;
    try {
      await prepareTarget(from === 'web');
      const limits = info.limits ?? {};
      r.maxDurationMs = (+s.ext.limitMinutes || 0) * 60_000 || (limits.maxDurationSeconds ?? 0) * 1000;
      r.segmentMs = (limits.segmentSeconds ?? 0) * 1000;
      r.segmentBytes = limits.segmentBytes ?? 0;
      fpsMeter.start = -1;
      await startTranscoderIfNeeded(info);
      if (info.replay) {
        await r.startReplay(timestampName('Replay'), 60);
        log(`游戏回放缓存已开始（${from === 'phone' ? '手机发起' : '电脑发起'}）：在手机悬浮球上保存最近几秒`);
      } else {
        await r.start(timestampName(info.filePrefix || 'Remote'));
        log(`开始录制（${from === 'phone' ? '手机发起' : '电脑发起'}）`);
      }
      if (s.ext.screenOff) { s.phoneScreenOff = true; await rt.session.send(Control.setDisplayPower(false)); }
    } finally { rt.busy = false; }
  } else if (op === 'pause') {
    r.pause();
  } else if (op === 'resume') {
    await r.resume();
  } else if (op === 'stop') {
    if (r.state === 'idle' || r.state === 'finishing') return;
    const files = await r.stop();
    stopTranscoder();
    if (s.ext.screenOff) { s.phoneScreenOff = false; await rt.session?.send(Control.setDisplayPower(true)).catch(() => {}); }
    if (files.length) sendState({ state: 'saved', files: files.map((f) => ({ name: f.name, size: f.size })) });
    if (rt.restartPending) { rt.restartPending = false; restartSession(); }
  } else if (op === 'replay_save') {
    const { seconds } = await r.saveReplay(+msg.seconds || 30);
    return { seconds };
  } else if (op === 'screenshot') {
    return await screenshotForPhone();
  }
  return {};
}

/**
 * 帧率曲线：数「真正写进文件的帧」，一秒结算一次，把点发给手机。
 * 规则与 App 的 FpsCollector 相同：时间轴倒退（分段、暂停衔接）就丢掉这一窗重开；
 * 超过 240 fps 的点一定是时间轴算错了，不发。手机端放进同一条曲线，界面和本机录制时一样。
 */
const fpsMeter = { start: -1, frames: 0 };

function onFrameWritten(tUs) {
  const atMs = Math.round(tUs / 1000);
  if (fpsMeter.start < 0) { fpsMeter.start = atMs; fpsMeter.frames = 0; return; }
  const span = atMs - fpsMeter.start;
  if (span <= 0) { fpsMeter.start = atMs; fpsMeter.frames = 0; return; }
  fpsMeter.frames++;
  if (span < 1000) return;
  const fps = (fpsMeter.frames * 1000) / span;
  if (fps > 0 && fps <= 240) rt.link?.send({ t: 'fps', atMs, fps: Math.round(fps * 10) / 10 });
  fpsMeter.start = atMs;
  fpsMeter.frames = 0;
}

/** 每写完一个文件（分段、回放片段、停止时的最后一段）：进视频列表，等用户（或手机）挑了再送。 */
function onPartFinished(f) {
  log(`已保存 ${f.name}（${(f.size / 1048576).toFixed(1)} MB，${f.where}）`);
  rt.library.add({ name: f.name, size: f.size, durationMs: f.durationMs ?? 0, where: f.where ?? '', file: f.file, remove: f.remove });
  if (f.durationMs) Storage.rememberDuration(f.name, f.durationMs);
}

/** 列表变了：网页刷新，手机那边的列表也跟着更新（攒 300ms 一起发，缩略图陆续生成时不刷屏）。 */
function onLibraryChange() {
  s.library = rt.library.view();
  emit();
  clearTimeout(rt.listTimer);
  rt.listTimer = setTimeout(sendListToPhone, 300);
}

function sendListToPhone() {
  rt.link?.send({ t: 'list', items: rt.library.listForPhone(), sending: s.sending });
}

/**
 * 把列表里的几个视频送到手机（网页上「回传」、手机上「拉取」都走这里）。
 * 串行：一个传完再传下一个；电脑上留的 fMP4 先转成普通 MP4（手机媒体库读不出 fMP4 的时长）。
 */
function sendToPhone(ids) {
  const items = ids.map((id) => rt.library.get(id)).filter(Boolean);
  if (!items.length) return;
  if (!rt.link) { toast('手机上的小白录制未连接，无法回传'); return; }
  s.sending.total += items.length;
  s.sending.active = true;
  emit();
  for (const item of items) {
    rt.uploadChain = rt.uploadChain
      .then(() => uploadOne(item.name, async () => defragment(await item.getFile()), 'video/mp4'))
      .then(() => rt.library.markSent(item.name))
      .catch(() => {})
      .finally(() => {
        s.sending.done++;
        if (s.sending.done >= s.sending.total) s.sending = { active: false, total: 0, done: 0, current: '' };
        emit(); sendListToPhone();
      });
  }
}

async function uploadOne(name, getBlob, mime) {
  if (!rt.link) throw new Error('手机应用未连接');
  s.upload = { active: true, progress: 0, file: name };
  s.sending.current = name;
  emit(); sendListToPhone();
  if (rt.recorder.state === 'idle') sendState({ state: 'uploading', file: name });
  try {
    const blob = await getBlob();
    let last = 0;
    const result = await rt.link.sendFile(name, blob, (sent, total) => {
      s.upload.progress = sent / total; emit();
      // 手机列表里的进度条：每 5% 报一次。
      if (sent / total - last >= 0.05 || sent === total) { last = sent / total; rt.link?.send({ t: 'progress', name, progress: last }); }
    }, mime);
    log(`手机已保存：${result.path ?? name}`);
    return result;
  } catch (e) {
    toast(`回传失败：${e.message}（电脑上的文件不受影响）`);
    throw e;
  } finally {
    s.upload = { active: false, progress: 0, file: '' };
    emit(); sendState();
  }
}

/**
 * 录制中截图：取预览当前这一帧，按手机此刻的方向摆正，编码后直接放进给手机的回执里。
 *
 * 不走文件通道：那条通道是排队的，前面要是正在回传一个几百 MB 的视频，截图就得一直等，
 * 悬浮球那边看起来就是「卡住了」。截图只有几 MB，一条消息就带过去了。
 */
async function screenshotForPhone() {
  if (!s.scrcpy.width || !rt.preview.frames) throw new Error('电脑端还没有可截取的画面');
  const src = rt.preview.canvas;
  const q = rt.preview.rotation || 0;
  const out = document.createElement('canvas');
  out.width = q % 2 ? src.height : src.width;
  out.height = q % 2 ? src.width : src.height;
  const g = out.getContext('2d');
  g.translate(out.width / 2, out.height / 2);
  g.rotate((q * Math.PI) / 2);
  g.drawImage(src, -src.width / 2, -src.height / 2);
  const toBlob = (type, quality) => new Promise((resolve) => out.toBlob(resolve, type, quality));
  let blob = await toBlob('image/png');
  if (!blob || blob.size > 3 * 1024 * 1024) blob = await toBlob('image/jpeg', 0.95);
  if (!blob) throw new Error('截图编码失败');
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
  return { image: String(dataUrl).split(',')[1], mime: blob.type };
}

// ── 无线 ────────────────────────────────────────────────────────────
async function enableTcpip() {
  if (!rt.adb || s.wireless.status === 'enabling') return;
  s.wireless = { status: 'enabling', error: '' };
  emit();
  try {
    // 先让手机上的小白录制把中继打开（WebSocket ↔ adbd:5555），它会回一份带地址和口令的配置。
    if (!rt.link) throw new Error('手机上的小白录制未连接：请先在手机上打开小白录制');
    await rt.link.send({ t: 'set', wireless: true });
    for (let i = 0; i < 20 && !s.wirelessUrl; i++) await new Promise((r) => setTimeout(r, 150));
    // 再把手机的调试服务切到网络模式：它会重启一下，USB 连接随之断开，稍后自动重连。
    rt.tcpipRestart = true;
    const stream = await rt.adb.open('tcpip:5555');
    const reply = utf8d.decode(await stream.readAll().catch(() => new Uint8Array(0)));
    log(`adbd：${reply.trim() || '已切换到 TCP 模式'}`);
    s.wireless = { status: 'ready', error: '' };
  } catch (e) {
    rt.tcpipRestart = false;
    s.wireless = { status: 'failed', error: e.message };
  }
  emit();
}

async function detectRelay() {
  // 只有手机中继（http://手机IP:27184/）提供的页面才去问，公网站点上不发这个请求。
  if (location.protocol !== 'http:' || location.port !== String(RELAY_PORT)) return null;
  try {
    const info = await (await fetch('/info', { cache: 'no-store' })).json();
    return info?.relay === 'sunight' ? info : null;
  } catch { return null; }
}

// ── 对外接口 ────────────────────────────────────────────────────────
const actions = {
  connectUsb: () => connect(UsbTransport.request()),
  reconnectUsb: async () => { const [d] = await UsbTransport.paired(); if (d) await connect(UsbTransport.open(d)); },
  connectWifi: (token) => {
    const t = token || wifiToken();
    if (!t) { toast('请输入手机「远程」页显示的无线口令'); return; }
    rt.wifiToken = t;
    rt.manualDisconnect = false;
    return connect(WebSocketTransport.connect(`ws://${location.host}/adb?token=${encodeURIComponent(t)}`));
  },
  disconnect: () => { rt.manualDisconnect = true; clearTimeout(rt.wifiRetry); s.reconnecting = false; return disconnect(); },
  enableTcpip: () => enableTcpip(),
  resetWireless: () => { s.wireless = { status: 'idle', error: '' }; },
  copy: async (text) => {
    try { await navigator.clipboard.writeText(text); toast('已复制'); } catch { toast('复制失败，请手动选中地址'); }
  },
  start: () => command('start', 'web'),
  pauseResume: () => command(rt.recorder.state === 'paused' ? 'resume' : 'pause', 'web'),
  stop: () => command('stop', 'web'),
  /** 游戏回放：在网页上直接存最近 N 秒（与手机悬浮球同一条路）。 */
  replaySave: async (seconds) => { const r = await command('replay_save', 'web', { seconds }); toast(`已保存最近 ${r.seconds} 秒`); },
  chooseFolder: async () => {
    try { rt.folder = await Storage.chooseFolder(); s.folder.name = rt.folder.name; await rt.library.scanFolder(rt.folder); } catch (e) { if (e.name !== 'AbortError') throw e; }
  },
  sendToPhone: (ids) => sendToPhone(Array.isArray(ids) ? ids : [ids]),
  sendAllUnsent: () => sendToPhone(rt.library.items.filter((x) => !x.sent).map((x) => x.id)),
  /** 把选中的视频导出到电脑（浏览器下载）。只有用户点了才下载。 */
  exportVideos: async (ids) => {
    for (const id of Array.isArray(ids) ? ids : [ids]) {
      const item = rt.library.get(id);
      if (item) Storage.download(item.name, await item.getFile());
    }
  },
  deleteVideos: async (ids) => {
    const list = Array.isArray(ids) ? ids : [ids];
    const busy = rt.library.items.filter((x) => list.includes(x.id) && x.name === s.upload.file);
    if (busy.length) { toast('正在回传的视频不能删除'); return; }
    const { removed, failed } = await rt.library.delete(list);
    if (failed.length) toast(`有 ${failed.length} 个删除失败：${failed[0]}`);
    else if (removed) log(`已删除 ${removed} 个视频`);
  },
  setControl: (on) => { s.control = !!on; rt.preview.controlEnabled = s.control; if (on) rt.preview.canvas.focus(); },
  key: (code) => { rt.session?.send(Control.keycode(ACTION.DOWN, +code)); rt.session?.send(Control.keycode(ACTION.UP, +code)); },
  ctl: (name) => {
    const m = {
      notifications: () => Control.empty(5), quickSettings: () => Control.empty(6), collapse: () => Control.empty(7),
      rotate: () => Control.empty(11), keyboardSettings: () => Control.empty(15),
      back: () => Control.backOrScreenOn(ACTION.DOWN), backUp: () => Control.backOrScreenOn(ACTION.UP),
      screenOff: () => { s.phoneScreenOff = true; emit(); return Control.setDisplayPower(false); },
      screenOn: () => { s.phoneScreenOff = false; emit(); return Control.setDisplayPower(true); },
      torchOn: () => Control.cameraTorch(true), torchOff: () => Control.cameraTorch(false),
      zoomIn: () => Control.empty(19), zoomOut: () => Control.empty(20),
    }[name];
    if (m) rt.session?.send(m());
  },
  /** 预览开关：关掉时电脑不再解码画面；打开时请手机立刻发一个关键帧，画面马上回来。 */
  setPreview: (on) => {
    s.preview = !!on;
    rt.preview.enabled = s.preview;
    localStorage.setItem('sunight.remote.preview', s.preview ? 'on' : 'off');
    if (s.preview) rt.session?.send(Control.empty(17));
    applyVideoPlacement();
    emit();
  },
  /** 熄屏 / 亮屏共用一个按钮。 */
  toggleScreen: () => actions.ctl(s.phoneScreenOff ? 'screenOn' : 'screenOff'),
  startApp: (arg) => {
    // arg：包名，或 { pkg, restart }；restart = 先强停再打开（scrcpy 的 '+' 前缀）。
    const pkg = typeof arg === 'string' ? arg.trim() : arg?.pkg;
    if (!pkg || !rt.session) { if (!rt.session) toast('画面还没开始，稍后再试'); return; }
    rt.session.send(Control.startApp((arg?.restart ? '+' : '') + pkg));
    s.apps.recent = [pkg, ...s.apps.recent.filter((p) => p !== pkg)].slice(0, 8);
    localStorage.setItem(RECENT_APPS_KEY, JSON.stringify(s.apps.recent));
    const name = s.apps.list.find((a) => a.pkg === pkg)?.name ?? pkg;
    log(`在手机上打开 ${name}`);
    emit();
  },
  /** 读手机上的应用列表；先给缓存，再在后台刷新（列一次要几秒）。 */
  listApps: async (force) => {
    if (!rt.adb || !rt.server || s.apps.status === 'loading') return;
    if (!force && s.apps.status === 'ready') return;
    if (!s.apps.list.length) {
      try { const cached = JSON.parse(localStorage.getItem(appsCacheKey()) ?? 'null'); if (cached?.length) { s.apps.list = cached; s.apps.status = 'ready'; s.apps.listVersion = (s.apps.listVersion ?? 0) + 1; } } catch {}
    }
    const hadCache = s.apps.list.length > 0;
    if (!hadCache) s.apps.status = 'loading';
    emit();
    try {
      const list = await listApps(rt.adb, rt.server);
      if (!list.length) throw new Error('没有读到应用');
      for (const a of list) a.py = pinyinInitials(a.name);
      list.sort((a, b) => (a.system - b.system) || a.name.localeCompare(b.name, 'zh-CN'));
      await fetchIcons([...s.apps.recent, ...list.map((a) => a.pkg)]);
      s.apps.list = list; s.apps.status = 'ready'; s.apps.listVersion = (s.apps.listVersion ?? 0) + 1;
      localStorage.setItem(appsCacheKey(), JSON.stringify(list));
    } catch (e) {
      if (!hadCache) s.apps.status = 'failed';
      log(`读取应用列表失败：${e.message}`);
    }
    emit();
  },
  /** 界面要显示这些应用时来要图标：没缓存、没要过的才发给手机（手机端小白录制没连上就只能显示首字）。 */
  requestIcons: (pkgs) => {
    const want = (pkgs ?? []).filter((p) => p && !appIcon(p) && !iconRequested.has(p));
    if (!want.length || !rt.link) return;
    want.forEach((p) => iconRequested.add(p));
    rt.link.send({ t: 'icons_req', pkgs: want.slice(0, 40) });
  },
  /** 往手机输入文字（光标处）。 */
  typeText: (text) => { if (text && rt.session) { rt.session.send(Control.text(text)); toast('已输入到手机'); } },
  /** 把文字放进手机剪贴板；paste = 顺便粘贴到当前输入框。 */
  sendClipboard: (arg) => {
    const text = typeof arg === 'string' ? arg : arg?.text;
    if (!text || !rt.session) return;
    rt.session.send(Control.setClipboard(text, !!arg?.paste));
    toast(arg?.paste ? '已粘贴到手机' : '已放进手机剪贴板');
  },
  getClipboard: () => { rt.session?.send(Control.getClipboard(0)); },
  /** 选文件传到手机：APK 直接安装，其它放进「下载」文件夹并让相册 / 文件管理立即看到。 */
  pushFiles: async (kind) => {
    if (!rt.adb || s.transfer.active) return;
    const files = await pickFiles(kind === 'apk' ? '.apk' : '');
    if (!files.length) return;
    s.transfer = { active: true, name: '', progress: 0, index: 0, total: files.length };
    let ok = 0;
    for (const [i, f] of files.entries()) {
      s.transfer.index = i + 1; s.transfer.name = f.name; s.transfer.progress = 0; emit();
      const apk = /\.apk$/i.test(f.name);
      const safe = f.name.replace(/[\\/:*?"<>|'`$]/g, '_');
      const path = apk ? `/data/local/tmp/sunight-install-${Date.now()}.apk` : `/sdcard/Download/${safe}`;
      try {
        const bytes = new Uint8Array(await f.arrayBuffer());
        await rt.adb.push(path, bytes, 0o644, (done) => { s.transfer.progress = done / bytes.length; emit(); });
        if (apk) {
          s.transfer.name = `正在安装 ${f.name}`; emit();
          const out = (await rt.adb.shell(`pm install -r -t '${path}' 2>&1; rm -f '${path}'`)).trim();
          if (!/Success/.test(out)) throw new Error(out.split('\n').pop() || '安装失败');
          log(`已安装 ${f.name}`);
        } else {
          rt.session?.send(Control.scanFile(path));
          log(`已传到手机：${path}`);
        }
        ok++;
      } catch (e) {
        toast(`${f.name}：${e.message}`);
      }
    }
    s.transfer = { active: false, name: '', progress: 0, index: 0, total: 0 };
    if (ok) toast(files.length === 1 ? (/\.apk$/i.test(files[0].name) ? '安装完成' : '已传到手机的「下载」文件夹') : `完成 ${ok}/${files.length} 个`);
    emit();
  },
  applyExt: (ext) => {
    s.ext = { ...DEFAULT_EXT, ...ext };
    localStorage.setItem(EXT_KEY, JSON.stringify(s.ext));
    requestRestart('扩展参数已更新');
  },
  resetExt: () => { s.ext = { ...DEFAULT_EXT }; localStorage.removeItem(EXT_KEY); requestRestart('扩展参数已恢复默认'); },
  dismissToast: () => { s.toast = null; },
  clearLogs: () => { s.logs = []; },
};

/** 选文件（不需要安全上下文以外的权限）；取消时给空数组。 */
function pickFiles(accept = '') {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file'; input.multiple = true;
    if (accept) input.accept = accept;
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.oncancel = () => resolve([]);
    input.click();
  });
}

let videoRect = null;
function placeVideo(x, y, w, h, visible) {
  videoRect = { x, y, w, h, visible };
  applyVideoPlacement();
}

// ── 转屏动画 ─────────────────────────────────────────────────────────
//
// 像手机自己转屏那样：把转之前的最后一帧截下来盖在上面（ghost），让它转过去、同时缩放挪到新画面框的位置；
// 底下实时画面先藏着，等新画面真的出来了（锁方向时立刻就有；不锁方向时要等 scrcpy 重开后的第一帧），
// 再把它淡入、ghost 淡出。这样转屏时既不黑屏，也不会「啪」一下跳过去。
const ROT_MS = 420;

function startRotationAnim(delta, expectSession) {
  if (!delta || rt.rot || !videoRect?.visible || !s.scrcpy.width || !rt.preview?.frames) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const p = rt.preview;
  // 新画面已经先到并画出来了（转屏消息比视频晚到）：没有可过渡的旧画面，不做动画。
  if (expectSession && !p.awaitingFrame && performance.now() - (p.sessionAt ?? 0) < 1500) return;
  const useLast = p.awaitingFrame && p.lastFrame;
  const src = useLast ? p.lastFrame : p.canvas;
  const r = useLast ? p.lastFrameRotation ?? 0 : p.rotation || 0;
  // 截图按「当时显示的样子」转正。
  const g = document.createElement('canvas');
  g.width = r % 2 ? src.height : src.width; g.height = r % 2 ? src.width : src.height;
  const gx = g.getContext('2d');
  gx.translate(g.width / 2, g.height / 2); gx.rotate((r * Math.PI) / 2); gx.drawImage(src, -src.width / 2, -src.height / 2);
  const old = { ...videoRect };
  Object.assign(g.style, {
    position: 'fixed', zIndex: 11, left: `${old.x}px`, top: `${old.y}px`, width: `${old.w}px`, height: `${old.h}px`,
    objectFit: 'contain', background: '#000', borderRadius: '24px', clipPath: 'inset(0 round 24px)', pointerEvents: 'none',
    transformOrigin: 'center center', willChange: 'transform, opacity',
    transition: 'opacity 200ms ease',
  });
  document.documentElement.appendChild(g);
  p.canvas.style.transition = 'opacity 200ms ease';
  p.canvas.style.opacity = '0';
  // 手机转到 ROTATION_90（逆时针转了 90°）时，原来的画面在实物上是逆时针躺倒的。
  const angle = delta === 1 ? -90 : delta === 3 ? 90 : 180;
  rt.rot = { ghost: g, old, angle, liveReady: !expectSession, animDone: false, t0: performance.now() };
  const tick = () => {
    if (rt.rot?.ghost !== g) return;
    retargetRotation();
    if (performance.now() - rt.rot.t0 < ROT_MS) requestAnimationFrame(tick);
    else { rt.rot.animDone = true; finishRotation(); }
  };
  requestAnimationFrame(tick);
  setTimeout(() => { if (rt.rot?.ghost === g) { rt.rot.liveReady = true; rt.rot.animDone = true; finishRotation(); } }, 2500);
}

/** 与界面里设备框变形同一条曲线（cubic-bezier .2,.75,.2,1），两者同步走完。 */
function easeRot(t) {
  // 牛顿迭代解 cubic-bezier 的 x(t)=t，再取 y。
  const x1 = 0.2, y1 = 0.75, x2 = 0.2, y2 = 1;
  const bx = (u) => 3 * x1 * u * (1 - u) ** 2 + 3 * x2 * u * u * (1 - u) + u ** 3;
  const by = (u) => 3 * y1 * u * (1 - u) ** 2 + 3 * y2 * u * u * (1 - u) + u ** 3;
  let u = t;
  for (let i = 0; i < 8; i++) {
    const d = (bx(u + 1e-4) - bx(u)) / 1e-4 || 1;
    u = Math.min(1, Math.max(0, u - (bx(u) - t) / d));
  }
  return by(u);
}

/**
 * 每一帧：按进度转到中间角度，并让转着的截图恰好放进设备框此刻的位置和大小
 * （设备框在 Compose 那边以同样的曲线变形，这里每帧读它的最新位置）。
 */
function retargetRotation() {
  const rot = rt.rot;
  if (!rot || !videoRect) return;
  const t = Math.min(1, (performance.now() - rot.t0) / ROT_MS);
  const theta = rot.angle * easeRot(t);
  const o = rot.old, n = videoRect;
  const rad = (Math.abs(theta) * Math.PI) / 180;
  const bw = o.w * Math.abs(Math.cos(rad)) + o.h * Math.abs(Math.sin(rad));
  const bh = o.w * Math.abs(Math.sin(rad)) + o.h * Math.abs(Math.cos(rad));
  const k = Math.min(n.w / bw, n.h / bh);
  const dx = n.x + n.w / 2 - (o.x + o.w / 2);
  const dy = n.y + n.h / 2 - (o.y + o.h / 2);
  rot.ghost.style.transform = `translate(${dx}px, ${dy}px) rotate(${theta}deg) scale(${k})`;
}

function finishRotation() {
  const rot = rt.rot;
  if (!rot || !rot.animDone || !rot.liveReady) return;
  rt.rot = null;
  rt.preview.canvas.style.opacity = '1';
  rot.ghost.style.opacity = '0';
  setTimeout(() => rot.ghost.remove(), 260);
}

function applyVideoPlacement() {
  if (!videoRect) return;
  if (rt.rot) retargetRotation();
  const { x, y, w, h, visible } = videoRect;
  const c = rt.preview.canvas;
  const r = rt.preview.rotation || 0;
  // 转 90°/270° 时，画面框是横的，canvas 本身仍是竖的：宽高对调，绕中心转。
  const cw = r % 2 ? h : w;
  const ch = r % 2 ? w : h;
  Object.assign(c.style, {
    left: `${x + (w - cw) / 2}px`, top: `${y + (h - ch) / 2}px`, width: `${cw}px`, height: `${ch}px`,
    transform: r ? `rotate(${r * 90}deg)` : '', transformOrigin: 'center center',
  });
  c.style.visibility = visible && s.scrcpy.width && s.preview ? 'visible' : 'hidden';
}

/**
 * 预览此刻的一帧（base64 JPEG，已按预览的方向转正）。
 * 菜单、对话框打开时实时画面的 canvas 要藏起来（它盖在 Compose 之上，会挡住弹层）——
 * 界面就把这一帧画在原位，弹层的遮罩自然压在上面，不会出现一块黑屏。
 */
function stillFrame() {
  const c = rt.preview?.canvas;
  if (!c?.width || !s.scrcpy.width) return '';
  const r = rt.preview.rotation || 0;
  const k = Math.min(1, 1100 / Math.max(c.width, c.height));
  const w = Math.round(c.width * k), h = Math.round(c.height * k);
  const o = document.createElement('canvas');
  o.width = r % 2 ? h : w; o.height = r % 2 ? w : h;
  const g = o.getContext('2d');
  g.translate(o.width / 2, o.height / 2);
  g.rotate((r * Math.PI) / 2);
  g.drawImage(c, -w / 2, -h / 2, w, h);
  try { return o.toDataURL('image/jpeg', 0.86).split(',')[1] ?? ''; } catch { return ''; }
}

async function init() {
  // 实时画面的 canvas 挂在 <html> 下而不是 <body>：Compose 的 ComposeViewport(document.body) 会接管 body。
  const canvas = document.createElement('canvas');
  canvas.id = 'screen';
  canvas.tabIndex = 0;
  document.documentElement.appendChild(canvas);
  rt.preview = new Preview(canvas, { onStatus: log });
  rt.preview.controlEnabled = s.control;
  rt.preview.enabled = s.preview;
  rt.preview.onFirstFrame = () => { if (rt.rot) { rt.rot.liveReady = true; finishRotation(); } };
  rt.recorder = new Recorder({
    createTarget: (name) => rt.targetFactory(name),
    requestKeyFrame: () => (rt.transcoder ? rt.transcoder.requestKeyFrame() : rt.session?.resetVideo()),
    onLog: log,
    onPart: onPartFinished,
    rotation: fileRotation,
    onState: (snap) => { s.rec = snap; emit(); sendState(); },
  });
  rt.recorder.onLimit = () => command('stop', 'limit');
  rt.recorder.onFrame = onFrameWritten;
  rt.recorder.onError = () => command('stop', 'error');
  rt.targetFactory = Storage.targetFactory(null);
  rt.library = new Library({ onChange: onLibraryChange, onLog: log });
  try { s.ext = { ...DEFAULT_EXT, ...JSON.parse(localStorage.getItem(EXT_KEY) ?? '{}') }; } catch { /* 用默认 */ }
  loadServer().catch((e) => log(`读取 scrcpy 服务端失败：${e.message}`));
  rt.folder = await Storage.savedFolder();
  s.folder.name = rt.folder?.name ?? '';
  rt.library.scanFolder(rt.folder);
  Storage.privateDir().then((dir) => {
    if (dir) return rt.library.scanFolder(dir, '浏览器内');
    // 无线页面（http）拿不到私有目录：录像在 IndexedDB 里，逐个放回列表。
    return Storage.idbVideos().then((items) => { for (const it of items.reverse()) rt.library.add(it); });
  });
  s.usb.paired = (await UsbTransport.paired()).length > 0;
  if (new URLSearchParams(location.search).has('demo')) { demo(canvas); return; }
  s.relay = await detectRelay();
  emit();
  // 手机托管的无线页面：地址里带着口令，打开就直接连，不用再点「无线连接」。
  if (s.relay && wifiToken()) actions.connectWifi();

  setInterval(() => {
    if (rt.recorder.state === 'recording' || rt.recorder.state === 'paused') { s.rec = rt.recorder.snapshot(); emit(); sendState(); }
    if (videoRect) canvas.style.visibility = videoRect.visible && s.scrcpy.width && s.preview ? 'visible' : 'hidden';
  }, 500);
  document.addEventListener('visibilitychange', scheduleIdlePause);
  window.addEventListener('beforeunload', (e) => { if (rt.recorder.state !== 'idle') { e.preventDefault(); e.returnValue = ''; } });
  navigator.usb?.addEventListener('disconnect', (ev) => { if (rt.adb?.transport.device === ev.device) onDisconnected(new Error('USB 已拔出')); });
}

/**
 * 设计走查模式（地址加 ?demo）：不连手机，填一份「已连接、录制中」的样例状态，并在画面区画一张示意图。
 * 只改界面状态，不碰 ADB / scrcpy。
 */
function demo(canvas) {
  canvas.width = 1264; canvas.height = 2780;
  const g = canvas.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 1264, 2780);
  grad.addColorStop(0, '#3b6cf6'); grad.addColorStop(1, '#a855f7');
  g.fillStyle = grad; g.fillRect(0, 0, 1264, 2780);
  g.fillStyle = 'rgba(255,255,255,.92)'; g.font = '600 120px sans-serif'; g.fillText('12:30', 90, 420);
  for (let i = 0; i < 16; i++) { g.fillStyle = 'rgba(255,255,255,.85)'; g.beginPath(); g.roundRect(110 + (i % 4) * 270, 900 + Math.floor(i / 4) * 300, 180, 180, 46); g.fill(); }
  Object.assign(s, {
    transport: { connected: true, connecting: false, kind: 'usb', label: 'OnePlus PJX110' },
    device: { model: 'PJX110', manufacturer: 'OnePlus', android: '16', sdk: 36, ip: '192.168.0.102' },
    app: { connected: true, info: { summary: [['分辨率', '1264×2780'], ['帧率', '120 fps'], ['码率', '24 Mbps · CBR'], ['编码', 'H.264'], ['声音', '系统声音（手机照常出声）']], scrcpy: { notes: [] } } },
    scrcpy: { version: '5.0.1', status: 'running', codec: 'h264', width: 1264, height: 2780, error: '' },
    rec: { state: 'recording', elapsedMs: 754000, bytes: 1.9e9, part: 1, replay: false },
    folder: { supported: true, name: '小白录制' },
    sending: { active: true, total: 2, done: 1, current: 'Remote_20261112_051901.mp4' },
    upload: { active: true, progress: 0.62, file: 'Remote_20261112_051901.mp4' },
    apps: {
      status: 'ready', listVersion: 1, recent: ['com.tencent.mm', 'tv.danmaku.bili', 'com.tencent.tmgp.sgame'],
      list: [['微信', 'com.tencent.mm'], ['哔哩哔哩', 'tv.danmaku.bili'], ['王者荣耀', 'com.tencent.tmgp.sgame'], ['原神', 'com.miHoYo.Yuanshen'],
        ['抖音', 'com.ss.android.ugc.aweme'], ['QQ音乐', 'com.tencent.qqmusic'], ['支付宝', 'com.eg.android.AlipayGphone'], ['和平精英', 'com.tencent.tmgp.pubgmhd'],
        ['小白录制', 'com.sunight.screenrecorder'], ['设置', 'com.android.settings', true], ['相册', 'com.miui.gallery', true]]
        .map(([name, pkg, system]) => ({ name, pkg, system: !!system, py: pinyinInitials(name) })),
    },
    transfer: { active: false, name: '', progress: 0, index: 0, total: 0 },
    phoneClipboard: '',
    caps: { displays: [{ id: 0, width: 1264, height: 2780 }], cameras: [], videoEncoders: [{ codec: 'h264', name: 'c2.qti.avc.encoder', hw: true }], audioEncoders: [] },
  });
  const demoThumb = () => { const c = document.createElement('canvas'); c.width = 240; c.height = 528; const x = c.getContext('2d'); x.drawImage(canvas, 0, 0, 240, 528); return c.toDataURL('image/jpeg', 0.7).split(',')[1]; };
  const thumb = demoThumb();
  [['Remote_20261112_051901.mp4', 1.9e6, 3500, false], ['Replay_20261112_050912.mp4', 4.2e7, 30000, true], ['Remote_20261112_050438.mp4', 1.6e8, 754000, true]]
    .forEach(([name, size, durationMs, sent], i) => rt.library.items.push({ id: `d${i}`, name, size, durationMs, where: '小白录制', at: Date.now() - i * 6e5, thumb, sent, getFile: async () => new Blob() }));
  s.library = rt.library.view();
  emit();
}

window.SunightRemote = {
  subscribe(cb) { listeners.add(cb); cb(snapshotJson()); },
  appList: () => JSON.stringify(s.apps.list),
  logs: () => JSON.stringify(s.logs.slice(-200)),
  call(name, argJson) {
    const fn = actions[name];
    if (!fn) { console.warn('unknown action', name); return; }
    let arg;
    try { arg = argJson ? JSON.parse(argJson) : undefined; } catch { arg = argJson; }
    Promise.resolve().then(() => fn(arg)).catch((e) => toast(e.message)).finally(emit);
  },
  placeVideo,
  /** 列表缩略图（JPEG base64，没有时为空串）。 */
  thumb: (id) => rt.library?.thumbOf(id) ?? '',
  still: () => stillFrame(),
  icon: (pkg) => appIcon(pkg),
};

init();
