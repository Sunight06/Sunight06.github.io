// 分片 MP4（fMP4）封装：边录边写，不需要回头改文件头，所以可以直接流式写进磁盘，
// 录多久都不占内存；中途断电/拔线，已写入的分片照样能播。

import { concat, utf8 } from '../bytes.js';

function box(type, ...payload) {
  const body = concat(payload.flat());
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(utf8.encode(type), 4);
  out.set(body, 8);
  return out;
}

function full(type, version, flags, ...payload) {
  return box(type, new Uint8Array([version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff]), ...payload);
}

function bytes(...numbers) { return new Uint8Array(numbers); }
function u8(v) { return bytes(v & 0xff); }
function u16(v) { return bytes((v >> 8) & 0xff, v & 0xff); }
function u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0); return b; }
function i32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v); return b; }
function u64(v) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(Math.max(0, Math.round(v)))); return b; }
function zeros(n) { return new Uint8Array(n); }

const MATRIX = {
  0: [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000],
  90: [0, 0x10000, 0, -0x10000, 0, 0, 0, 0, 0x40000000],
  180: [-0x10000, 0, 0, 0, -0x10000, 0, 0, 0, 0x40000000],
  270: [0, -0x10000, 0, 0x10000, 0, 0, 0, 0, 0x40000000],
};
function matrix(rotation) { return concat((MATRIX[rotation] ?? MATRIX[0]).map(i32)); }

const VIDEO_TIMESCALE = 1_000_000; // 微秒：scrcpy 的 PTS 本来就是微秒，换算零误差
const FLAG_KEY = 0x02000000;
const FLAG_DELTA = 0x01010000;

function esds(asc) {
  const desc = (tag, ...content) => { const body = concat(content); return concat([u8(tag), u8(body.length), body]); };
  const dsi = desc(5, asc);
  const dcd = desc(4, u8(0x40), u8(0x15), bytes(0, 0, 0), u32(0), u32(0), dsi);
  const es = desc(3, u16(1), u8(0), dcd, desc(6, u8(2)));
  return full('esds', 0, 0, es);
}

function dOps(opusHead) {
  // OpusHead 是小端，dOps 是大端：逐字段换过来。
  const v = new DataView(opusHead.buffer, opusHead.byteOffset, opusHead.byteLength);
  const channels = opusHead[9];
  return box('dOps', u8(0), u8(channels), u16(v.getUint16(10, true)), u32(v.getUint32(12, true)), u16(v.getInt16(16, true)), u8(opusHead[18] ?? 0));
}

export class Fmp4Writer {
  /**
   * @param video { sampleEntry:'avc1'|'hvc1', box:'avcC'|'hvcC', record, width, height, rotation }
   * @param audio { codec:'aac'|'opus', config, sampleRate, channels } 或 null
   * @param sink  async (Uint8Array) => void：按顺序写出
   */
  constructor({ video, audio, sink }) {
    this.video = video;
    this.audio = audio;
    this.sink = sink;
    this.seq = 0;
    this.tracks = [{ id: 1, kind: 'video', samples: [], pending: null, timescale: VIDEO_TIMESCALE, lastDuration: 16_667 }];
    if (audio) this.tracks.push({ id: 2, kind: 'audio', samples: [], pending: null, timescale: audio.sampleRate, lastDuration: 1024 });
    this.fragmentStartUs = null;
    this.bytesWritten = 0;
    this.lastVideoUs = -1;
    this.lastAudioTicks = -1;
  }

  async write(data) { this.bytesWritten += data.length; await this.sink(data); }

  async start() {
    const brand = this.video.sampleEntry === 'hvc1' ? 'hvc1' : 'avc1';
    const ftyp = box('ftyp', utf8.encode('isom'), u32(0x200), ...['isom', 'iso6', 'iso2', brand, 'mp41'].map((b) => utf8.encode(b)));
    await this.write(concat([ftyp, this.moov()]));
  }

  moov() {
    // 创建 / 修改时间：1904 年起的秒数（不写的话 QuickTime 等会显示 1970 年）。
    const macTime = Math.floor(Date.now() / 1000) + 2082844800;
    const mvhd = full('mvhd', 0, 0, u32(macTime), u32(macTime), u32(1000), u32(0), u32(0x00010000), u16(0x0100), zeros(10),
      matrix(0), zeros(24), u32(this.tracks.length + 1));
    const traks = this.tracks.map((t) => (t.kind === 'video' ? this.videoTrak(t) : this.audioTrak(t)));
    const mvex = box('mvex', ...this.tracks.map((t) => full('trex', 0, 0, u32(t.id), u32(1), u32(0), u32(0), u32(0))));
    return box('moov', mvhd, ...traks, mvex);
  }

  trak(t, { handler, name, header, entry, width = 0, height = 0, rotation = 0, volume = 0 }) {
    const tkhd = full('tkhd', 0, 3, u32(0), u32(0), u32(t.id), u32(0), u32(0), zeros(8), u16(0), u16(0), u16(volume), u16(0),
      matrix(rotation), u32(width << 16), u32(height << 16));
    const mdhd = full('mdhd', 0, 0, u32(0), u32(0), u32(t.timescale), u32(0), u16(0x55c4), u16(0));
    const hdlr = full('hdlr', 0, 0, u32(0), utf8.encode(handler), zeros(12), utf8.encode(name + '\0'));
    const dinf = box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1)));
    const stbl = box('stbl', full('stsd', 0, 0, u32(1), entry), full('stts', 0, 0, u32(0)), full('stsc', 0, 0, u32(0)),
      full('stsz', 0, 0, u32(0), u32(0)), full('stco', 0, 0, u32(0)));
    return box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', header, dinf, stbl)));
  }

  videoTrak(t) {
    const v = this.video;
    const compressor = zeros(32);
    const entry = box(v.sampleEntry, zeros(6), u16(1), u16(0), u16(0), zeros(12), u16(v.width), u16(v.height),
      u32(0x00480000), u32(0x00480000), u32(0), u16(1), compressor, u16(0x18), u16(0xffff), box(v.box, v.record));
    return this.trak(t, { handler: 'vide', name: 'VideoHandler', header: full('vmhd', 0, 1, zeros(8)), entry,
      width: v.width, height: v.height, rotation: v.rotation ?? 0 });
  }

  audioTrak(t) {
    const a = this.audio;
    const child = a.codec === 'opus' ? dOps(a.config) : esds(a.config);
    const entry = box(a.codec === 'opus' ? 'Opus' : 'mp4a', zeros(6), u16(1), zeros(8), u16(a.channels), u16(16), u16(0), u16(0),
      u32(a.sampleRate << 16), child);
    return this.trak(t, { handler: 'soun', name: 'SoundHandler', header: full('smhd', 0, 0, u16(0), u16(0)), entry, volume: 0x0100 });
  }

  /** timeUs 已经是「文件内时间」（录制起点为 0、扣掉了暂停）。 */
  async addVideo(data, timeUs, key) {
    if (timeUs <= this.lastVideoUs) timeUs = this.lastVideoUs + 1;
    this.lastVideoUs = timeUs;
    // 关键帧处切分片：每个分片都从关键帧开始、能独立解码，播放器拖动也更快。
    // 先 push：上一帧要拿到这一帧的时间才能定时长，它属于旧分片；关键帧本身留作 pending 进新分片。
    const cut = key && this.fragmentStartUs !== null && timeUs - this.fragmentStartUs >= 1_000_000;
    this.push(this.tracks[0], { data, time: timeUs, flags: key ? FLAG_KEY : FLAG_DELTA });
    if (cut) await this.flush();
    if (this.fragmentStartUs === null) this.fragmentStartUs = timeUs;
  }

  addAudio(data, timeUs) {
    const t = this.tracks[1];
    if (!t) return;
    let ticks = Math.round((timeUs * t.timescale) / 1_000_000);
    if (ticks <= this.lastAudioTicks) ticks = this.lastAudioTicks + 1;
    this.lastAudioTicks = ticks;
    this.push(t, { data, time: ticks, flags: FLAG_KEY });
  }

  push(t, sample) {
    if (t.pending) {
      t.pending.duration = sample.time - t.pending.time;
      t.lastDuration = t.pending.duration;
      t.samples.push(t.pending);
    }
    t.pending = sample;
  }

  async flush(final = false) {
    if (final) {
      for (const t of this.tracks) {
        if (t.pending) { t.pending.duration = t.lastDuration; t.samples.push(t.pending); t.pending = null; }
      }
    }
    if (!this.tracks.some((t) => t.samples.length)) return;
    const active = this.tracks.filter((t) => t.samples.length);
    const build = (offsets) => box('moof', full('mfhd', 0, 0, u32(this.seq + 1)), ...active.map((t, i) => box('traf',
      full('tfhd', 0, 0x020000, u32(t.id)),
      full('tfdt', 1, 0, u64(t.samples[0].time)),
      full('trun', 0, 0x000701, u32(t.samples.length), i32(offsets[i]),
        ...t.samples.map((s) => concat([u32(s.duration), u32(s.data.length), u32(s.flags)]))))));
    const size = build(active.map(() => 0)).length;
    const offsets = [];
    let offset = size + 8;
    for (const t of active) { offsets.push(offset); offset += t.samples.reduce((n, s) => n + s.data.length, 0); }
    const payload = active.flatMap((t) => t.samples.map((s) => s.data));
    const mdatSize = 8 + payload.reduce((n, d) => n + d.length, 0);
    const mdatHead = concat([u32(mdatSize), utf8.encode('mdat')]);
    const moof = build(offsets);
    this.seq++;
    for (const t of active) t.samples = [];
    this.fragmentStartUs = null;
    await this.write(concat([moof, mdatHead, ...payload]));
  }

  async finish() { await this.flush(true); }
}
