// 分片 MP4（fMP4）→ 普通 MP4。
//
// 电脑端边录边写用的是 fMP4（断线也能播），但手机的媒体库读不出 fMP4 的时长（入库 duration=0，
// 相册里显示 00:00、拖不动进度）。回传前在这里转成普通 MP4：
//   · 只读各个 moof 小盒子建立索引，按索引生成新的 moov（stts/stsz/stsc/stco/stss）；
//   · 码流一个字节不动：输出是 Blob 切片的拼接（ftyp + moov + mdat 头 + 原文件里的各段数据），
//     几 GB 的录像也不会整个读进内存。

import { concat, utf8 } from '../bytes.js';

function u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0); return b; }
function u64(v) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v)); return b; }

function box(type, ...payload) {
  const body = concat(payload.flat());
  return concat([u32(8 + body.length), utf8.encode(type), body]);
}
function full(type, version, flags, ...payload) {
  return box(type, new Uint8Array([version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff]), ...payload);
}

async function read(blob, offset, length) {
  return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
}

/** 列出 [start,end) 范围内的顶层盒子（只读 8/16 字节头）。 */
async function topLevelBoxes(blob) {
  const boxes = [];
  let off = 0;
  while (off + 8 <= blob.size) {
    const head = await read(blob, off, 16);
    const v = new DataView(head.buffer);
    let size = v.getUint32(0);
    const type = String.fromCharCode(...head.subarray(4, 8));
    let headerSize = 8;
    if (size === 1) { size = Number(v.getBigUint64(8)); headerSize = 16; }
    else if (size === 0) size = blob.size - off;
    if (size < headerSize) throw new Error(`MP4 结构损坏（${type} @${off}）`);
    boxes.push({ type, off, size, headerSize });
    off += size;
  }
  return boxes;
}

/** 解析一段内存里的盒子序列。 */
function children(bytes, start = 0, end = bytes.length) {
  const out = [];
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = start;
  while (off + 8 <= end) {
    const size = v.getUint32(off);
    const type = String.fromCharCode(...bytes.subarray(off + 4, off + 8));
    if (size < 8 || off + size > end) break;
    out.push({ type, off, size, body: bytes.subarray(off + 8, off + size) });
    off += size;
  }
  return out;
}

const find = (list, type) => list.find((b) => b.type === type);

function parseTraf(traf, moofOff) {
  const kids = children(traf.body);
  const tfhd = find(kids, 'tfhd').body;
  const tv = new DataView(tfhd.buffer, tfhd.byteOffset, tfhd.byteLength);
  const tfFlags = (tfhd[1] << 16) | (tfhd[2] << 8) | tfhd[3];
  const trackId = tv.getUint32(4);
  let p = 8;
  let base = moofOff; // default-base-is-moof（我们的写入器总是这样）
  if (tfFlags & 0x1) { base = Number(tv.getBigUint64(p)); p += 8; }
  if (tfFlags & 0x2) p += 4;
  let defDuration = 0, defSize = 0, defFlags = 0;
  if (tfFlags & 0x8) { defDuration = tv.getUint32(p); p += 4; }
  if (tfFlags & 0x10) { defSize = tv.getUint32(p); p += 4; }
  if (tfFlags & 0x20) { defFlags = tv.getUint32(p); p += 4; }
  const tfdtBox = find(kids, 'tfdt');
  let decodeTime = 0;
  if (tfdtBox) {
    const b = tfdtBox.body; const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    decodeTime = b[0] === 1 ? Number(dv.getBigUint64(4)) : dv.getUint32(4);
  }
  const runs = [];
  for (const trun of kids.filter((k) => k.type === 'trun')) {
    const b = trun.body; const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const flags = (b[1] << 16) | (b[2] << 8) | b[3];
    const count = dv.getUint32(4);
    let q = 8;
    let dataOffset = 0;
    if (flags & 0x1) { dataOffset = dv.getInt32(q); q += 4; }
    let firstFlags = null;
    if (flags & 0x4) { firstFlags = dv.getUint32(q); q += 4; }
    const samples = [];
    for (let i = 0; i < count; i++) {
      const s = { duration: defDuration, size: defSize, flags: defFlags, cto: 0 };
      if (flags & 0x100) { s.duration = dv.getUint32(q); q += 4; }
      if (flags & 0x200) { s.size = dv.getUint32(q); q += 4; }
      if (flags & 0x400) { s.flags = dv.getUint32(q); q += 4; } else if (i === 0 && firstFlags !== null) s.flags = firstFlags;
      if (flags & 0x800) { s.cto = dv.getInt32(q); q += 4; }
      samples.push(s);
    }
    runs.push({ offset: base + dataOffset, samples });
  }
  return { trackId, decodeTime, runs };
}

function sttsBox(samples) {
  const entries = [];
  for (const s of samples) {
    const last = entries[entries.length - 1];
    if (last && last[1] === s.duration) last[0]++; else entries.push([1, s.duration]);
  }
  return full('stts', 0, 0, u32(entries.length), ...entries.map(([n, d]) => concat([u32(n), u32(d)])));
}

/** 判断一份 Blob 是否 fMP4（有 moov/mvex 和 moof）。 */
export async function isFragmented(blob) {
  const top = await topLevelBoxes(blob);
  return top.some((b) => b.type === 'moof');
}

/** fMP4 → 普通 MP4；不是 fMP4 就原样返回。 */
export async function defragment(blob) {
  const top = await topLevelBoxes(blob);
  if (!top.some((b) => b.type === 'moof')) return blob;
  const moovInfo = find(top, 'moov');
  const ftypInfo = find(top, 'ftyp');
  if (!moovInfo) throw new Error('缺少 moov');
  const moov = await read(blob, moovInfo.off, moovInfo.size);
  const ftyp = ftypInfo ? await read(blob, ftypInfo.off, ftypInfo.size) : box('ftyp', utf8.encode('isom'), u32(0x200), utf8.encode('isomiso2mp41'));

  // 1. 收集每条轨的样本与数据块（原文件里的位置）
  const tracks = new Map(); // trackId → { samples:[], chunks:[{srcOffset,count,bytes}] }
  for (const mf of top.filter((b) => b.type === 'moof')) {
    const bytes = await read(blob, mf.off, mf.size);
    for (const traf of children(bytes, 8).filter((k) => k.type === 'traf')) {
      const t = parseTraf(traf, mf.off);
      const entry = tracks.get(t.trackId) ?? { samples: [], chunks: [] };
      for (const run of t.runs) {
        const bytesLen = run.samples.reduce((n, s) => n + s.size, 0);
        if (run.samples.length) entry.chunks.push({ srcOffset: run.offset, count: run.samples.length, bytes: bytesLen });
        entry.samples.push(...run.samples);
      }
      tracks.set(t.trackId, entry);
    }
  }

  // 2. 新文件里 mdat 按 moof 出现顺序依次放各个数据块
  const allChunks = [];
  for (const [trackId, t] of tracks) for (const c of t.chunks) allChunks.push({ trackId, ...c });
  allChunks.sort((a, b) => a.srcOffset - b.srcOffset);
  const mdatPayload = allChunks.reduce((n, c) => n + c.bytes, 0);
  const large = mdatPayload + 16 > 0xffffffff;

  // 3. 重建 moov：traks 里换掉 stbl 的表，填好时长，去掉 mvex
  const moovKids = children(moov, 8);
  const mvhd = find(moovKids, 'mvhd');
  const mvhdTimescale = new DataView(mvhd.body.buffer, mvhd.body.byteOffset).getUint32(mvhd.body[0] === 1 ? 20 : 12);

  const buildMoov = (chunkOffsets) => {
    let movieDuration = 0;
    const traks = moovKids.filter((k) => k.type === 'trak').map((trak) => {
      const tk = children(trak.body);
      const tkhd = find(tk, 'tkhd');
      const trackId = new DataView(tkhd.body.buffer, tkhd.body.byteOffset).getUint32(tkhd.body[0] === 1 ? 20 : 12);
      const t = tracks.get(trackId) ?? { samples: [], chunks: [] };
      const mdia = find(tk, 'mdia');
      const md = children(mdia.body);
      const mdhd = find(md, 'mdhd');
      const timescale = new DataView(mdhd.body.buffer, mdhd.body.byteOffset).getUint32(mdhd.body[0] === 1 ? 20 : 12);
      const mediaDuration = t.samples.reduce((n, s) => n + s.duration, 0);
      const trackMovieDuration = Math.round(mediaDuration * mvhdTimescale / timescale);
      movieDuration = Math.max(movieDuration, trackMovieDuration);

      const minf = find(md, 'minf');
      const mi = children(minf.body);
      const stbl = find(mi, 'stbl');
      const st = children(stbl.body);
      const stsd = find(st, 'stsd');
      const offsets = chunkOffsets.get(trackId) ?? [];
      const stsc = [];
      t.chunks.forEach((c, i) => { if (!stsc.length || stsc[stsc.length - 1][1] !== c.count) stsc.push([i + 1, c.count]); });
      const keys = [];
      t.samples.forEach((s, i) => { if (!(s.flags & 0x10000)) keys.push(i + 1); });
      const hasCto = t.samples.some((s) => s.cto !== 0);
      const newStbl = box('stbl',
        concat([u32(stsd.size), utf8.encode('stsd'), stsd.body]),
        sttsBox(t.samples),
        hasCto ? full('ctts', 1, 0, u32(t.samples.length), ...t.samples.map((s) => concat([u32(1), u32(s.cto)]))) : new Uint8Array(0),
        full('stsc', 0, 0, u32(stsc.length), ...stsc.map(([first, n]) => concat([u32(first), u32(n), u32(1)]))),
        full('stsz', 0, 0, u32(0), u32(t.samples.length), ...t.samples.map((s) => u32(s.size))),
        large ? full('co64', 0, 0, u32(offsets.length), ...offsets.map(u64)) : full('stco', 0, 0, u32(offsets.length), ...offsets.map(u32)),
        keys.length && keys.length < t.samples.length ? full('stss', 0, 0, u32(keys.length), ...keys.map(u32)) : new Uint8Array(0),
      );
      const raw = (b) => concat([u32(b.size), utf8.encode(b.type), b.body]);
      const newMinf = box('minf', ...mi.map((b) => (b.type === 'stbl' ? newStbl : raw(b))));
      const newMdhd = (() => { const c = raw(mdhd).slice(); const dv = new DataView(c.buffer); if (c[8] === 1) dv.setBigUint64(8 + 4 + 20, BigInt(mediaDuration)); else dv.setUint32(8 + 4 + 12, mediaDuration); return c; })();
      const newMdia = box('mdia', ...md.map((b) => (b.type === 'minf' ? newMinf : b.type === 'mdhd' ? newMdhd : raw(b))));
      const newTkhd = (() => { const c = raw(tkhd).slice(); const dv = new DataView(c.buffer); if (c[8] === 1) dv.setBigUint64(8 + 4 + 24, BigInt(trackMovieDuration)); else dv.setUint32(8 + 4 + 16, trackMovieDuration); return c; })();
      return box('trak', ...tk.map((b) => (b.type === 'mdia' ? newMdia : b.type === 'tkhd' ? newTkhd : b.type === 'edts' ? new Uint8Array(0) : raw(b))));
    });
    const newMvhd = (() => { const c = concat([u32(mvhd.size), utf8.encode('mvhd'), mvhd.body]).slice(); const dv = new DataView(c.buffer); if (c[8] === 1) dv.setBigUint64(8 + 4 + 20, BigInt(movieDuration)); else dv.setUint32(8 + 4 + 12, movieDuration); return c; })();
    const others = moovKids.filter((k) => k.type !== 'mvhd' && k.type !== 'trak' && k.type !== 'mvex').map((b) => concat([u32(b.size), utf8.encode(b.type), b.body]));
    return box('moov', newMvhd, ...traks, ...others);
  };

  // moov 的大小与偏移量的取值无关（stco 条数固定），先用 0 量一次大小，再填真实偏移。
  const placeholder = new Map([...tracks].map(([id, t]) => [id, t.chunks.map(() => 0)]));
  const moovSize = buildMoov(placeholder).length;
  const mdatHeader = large ? concat([u32(1), utf8.encode('mdat'), u64(16 + mdatPayload)]) : concat([u32(8 + mdatPayload), utf8.encode('mdat')]);
  let cursor = ftyp.length + moovSize + mdatHeader.length;
  const offsets = new Map([...tracks].map(([id]) => [id, []]));
  for (const c of allChunks) { offsets.get(c.trackId).push(cursor); cursor += c.bytes; }
  const newMoov = buildMoov(offsets);
  if (newMoov.length !== moovSize) throw new Error('moov 大小不一致');
  return new Blob([ftyp, newMoov, mdatHeader, ...allChunks.map((c) => blob.slice(c.srcOffset, c.srcOffset + c.bytes))], { type: 'video/mp4' });
}
