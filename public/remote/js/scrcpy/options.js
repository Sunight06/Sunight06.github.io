// scrcpy-server 的启动参数。
//
// 参数分两层合并：
//   1. 手机端「小白录制」按自己的录制参数算出的一份（码率、帧率、编码、声源……），经应用通道发过来；
//   2. 网页上「scrcpy 扩展」面板里用户额外打开的特色功能（虚拟显示、摄像头、角度、关屏录制……）。
// 后者覆盖前者。所有键都过白名单、所有值都单引号转义——它们最终是拼进 shell 命令里的。

export const ALLOWED_KEYS = new Set([
  'video', 'audio', 'video_codec', 'audio_codec', 'video_source', 'audio_source', 'audio_dup',
  'max_size', 'min_size_alignment', 'video_bit_rate', 'audio_bit_rate', 'max_fps', 'angle', 'crop', 'control',
  'display_id', 'show_touches', 'stay_awake', 'screen_off_timeout', 'video_codec_options', 'audio_codec_options',
  'video_encoder', 'audio_encoder', 'power_off_on_close', 'clipboard_autosync', 'downsize_on_error', 'power_on',
  'camera_id', 'camera_size', 'camera_facing', 'camera_ar', 'camera_zoom', 'camera_fps', 'camera_high_speed',
  'camera_torch', 'new_display', 'vd_destroy_content', 'vd_system_decorations', 'capture_orientation',
  'display_ime_policy', 'keep_active', 'ignore_video_encoder_constraints',
]);

/** 网页端自己决定、不让任何一层覆盖的参数：连接方式与协议元数据必须和本客户端的解析一致。 */
function fixedArgs(scid) {
  return {
    scid,
    log_level: 'info',
    tunnel_forward: 'true',
    cleanup: 'true',
    send_device_meta: 'true',
    send_frame_meta: 'true',
    send_dummy_byte: 'true',
    send_stream_meta: 'true',
  };
}

export function quote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function randomScid() {
  const v = new Uint32Array(1);
  crypto.getRandomValues(v);
  return (v[0] & 0x7fffffff).toString(16).padStart(8, '0');
}

/**
 * @param base   手机端给的参数（键值对）
 * @param extras 网页扩展面板的参数（键值对；值为 '' / null 表示不设置）
 */
export function mergeOptions(base = {}, extras = {}) {
  const merged = {};
  for (const layer of [base, extras]) {
    for (const [k, v] of Object.entries(layer)) {
      if (!ALLOWED_KEYS.has(k)) continue;
      if (v === null || v === undefined || v === '') { delete merged[k]; continue; }
      merged[k] = String(v);
    }
  }
  // 摄像头与虚拟显示与 display_id 互斥（服务端会断言失败）：以更具体的那个为准。
  if (merged.video_source === 'camera') {
    delete merged.display_id; delete merged.new_display; delete merged.crop; delete merged.show_touches;
    delete merged.capture_orientation;
  } else {
    for (const k of Object.keys(merged)) if (k.startsWith('camera_')) delete merged[k];
  }
  if (merged.new_display !== undefined) delete merged.display_id;
  return merged;
}

export function buildCommand(serverPath, version, scid, options) {
  const args = { ...options, ...fixedArgs(scid) };
  const parts = Object.entries(args).map(([k, v]) => quote(`${k}=${v}`));
  return `CLASSPATH=${quote(serverPath)} app_process / com.genymobile.scrcpy.Server ${quote(version)} ${parts.join(' ')}`;
}

/** 解析 list_encoders / list_displays / list_cameras 的输出，供扩展面板做下拉。 */
export function parseLists(output) {
  const encoders = { video: [], audio: [] };
  const displays = [];
  const cameras = [];
  // adb shell 的输出可能带 \r（pty 或 Windows 管道）：`.` 不匹配 \r，行尾的 `$` 会因此对不上。
  for (const line of output.split(/\r?\n/)) {
    let m = line.match(/--(video|audio)-codec=(\S+)\s+--\1-encoder=(\S+)\s*(.*)$/);
    if (m) {
      const extra = m[4].trim();
      if (!/alias for/.test(extra)) encoders[m[1]].push({ codec: m[2], name: m[3], hw: /\(hw\)/.test(extra), note: extra });
      continue;
    }
    m = line.match(/--display-id=(\d+)\s+\((\d+)x(\d+)\)/);
    if (m) { displays.push({ id: +m[1], width: +m[2], height: +m[3] }); continue; }
    m = line.match(/--camera-id=(\S+)\s+\((\w+),\s*(\d+)x(\d+),\s*fps=\{([^}]*)\}/);
    if (m) cameras.push({ id: m[1], facing: m[2], width: +m[3], height: +m[4], fps: m[5].split(',').map((s) => +s.trim()) });
  }
  return { encoders, displays, cameras };
}
