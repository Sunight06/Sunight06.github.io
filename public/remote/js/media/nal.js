// H.264 / H.265 码流工具：Annex-B 拆分、SPS 解析、avcC / hvcC 生成、WebCodecs 的 codec 字符串。

import { concat } from '../bytes.js';

export function splitAnnexB(data) {
  const nals = [];
  let i = 0;
  let start = -1;
  const n = data.length;
  while (i + 2 < n) {
    if (data[i] === 0 && data[i + 1] === 0 && (data[i + 2] === 1 || (data[i + 2] === 0 && i + 3 < n && data[i + 3] === 1))) {
      const scLen = data[i + 2] === 1 ? 3 : 4;
      if (start >= 0) nals.push(trimTrailingZeros(data.subarray(start, i)));
      i += scLen;
      start = i;
    } else {
      i++;
    }
  }
  if (start >= 0 && start < n) nals.push(data.subarray(start));
  else if (start < 0 && n) nals.push(data); // 已经不是 Annex-B（防御）
  return nals.filter((x) => x.length);
}

function trimTrailingZeros(nal) {
  let end = nal.length;
  while (end > 0 && nal[end - 1] === 0) end--;
  return nal.subarray(0, end);
}

export function h264Type(nal) { return nal[0] & 0x1f; }
export function h265Type(nal) { return (nal[0] >> 1) & 0x3f; }

/** 去掉防竞争字节（00 00 03 → 00 00），解析 SPS 前必须做。 */
export function unescapeRbsp(nal) {
  const out = new Uint8Array(nal.length);
  let o = 0;
  let zeros = 0;
  for (const b of nal) {
    if (zeros >= 2 && b === 3) { zeros = 0; continue; }
    out[o++] = b;
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, o);
}

class BitReader {
  constructor(bytes) { this.bytes = bytes; this.pos = 0; }
  bit() { const b = (this.bytes[this.pos >> 3] >> (7 - (this.pos & 7))) & 1; this.pos++; return b; }
  bits(n) { let v = 0; for (let i = 0; i < n; i++) v = v * 2 + this.bit(); return v; }
  skip(n) { this.pos += n; }
  ue() { let z = 0; while (this.bit() === 0 && z < 32) z++; return z === 0 ? 0 : (2 ** z - 1) + this.bits(z); }
}

const hex2 = (v) => v.toString(16).padStart(2, '0');
function u16(v) { return [(v >> 8) & 0xff, v & 0xff]; }

/** 把 Annex-B 的一帧转成 MP4 样本（每个 NAL 前加 4 字节长度），并剔除参数集（它们在 avcC/hvcC 里）。 */
export function toLengthPrefixed(data, codec) {
  const parts = [];
  for (const nal of splitAnnexB(data)) {
    const t = codec === 'h264' ? h264Type(nal) : h265Type(nal);
    if (codec === 'h264' ? (t === 7 || t === 8 || t === 9) : (t >= 32 && t <= 35)) continue;
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, nal.length);
    parts.push(len, nal);
  }
  return concat(parts);
}

/** 由配置包（SPS/PPS[/VPS]）得出：MP4 的样本描述盒内容、WebCodecs codec 字符串、宽高。 */
export function parseVideoConfig(codec, configPacket) {
  const nals = splitAnnexB(configPacket);
  if (codec === 'h264') {
    const sps = nals.find((n) => h264Type(n) === 7);
    const pps = nals.find((n) => h264Type(n) === 8);
    if (!sps || !pps) throw new Error('配置包里缺少 SPS/PPS');
    const avcC = new Uint8Array([1, sps[1], sps[2], sps[3], 0xff, 0xe1, ...u16(sps.length), ...sps, 1, ...u16(pps.length), ...pps]);
    return { box: 'avcC', sampleEntry: 'avc1', record: avcC, codecString: `avc1.${hex2(sps[1])}${hex2(sps[2])}${hex2(sps[3])}` };
  }
  if (codec === 'h265') {
    const vps = nals.find((n) => h265Type(n) === 32);
    const sps = nals.find((n) => h265Type(n) === 33);
    const pps = nals.find((n) => h265Type(n) === 34);
    if (!vps || !sps || !pps) throw new Error('配置包里缺少 VPS/SPS/PPS');
    const info = parseHevcSps(sps);
    const rec = [
      1,
      (info.profileSpace << 6) | (info.tier << 5) | info.profileIdc,
      ...info.compat, ...info.constraint, info.levelIdc,
      0xf0, 0x00, 0xfc, 0xfc | info.chromaFormat, 0xf8 | info.bitDepthLuma, 0xf8 | info.bitDepthChroma,
      0x00, 0x00,
      (info.maxSubLayers << 3) | (info.temporalIdNested << 2) | 3,
      3,
    ];
    for (const [type, nal] of [[32, vps], [33, sps], [34, pps]]) rec.push(0x80 | type, 0, 1, ...u16(nal.length), ...nal);
    return { box: 'hvcC', sampleEntry: 'hvc1', record: new Uint8Array(rec), codecString: hevcCodecString(info) };
  }
  throw new Error(`MP4 录制暂不支持 ${codec} 视频，请改用 H.264 或 H.265`);
}

function parseHevcSps(sps) {
  const r = new BitReader(unescapeRbsp(sps.subarray(2)));
  r.skip(4);
  const maxSubLayersMinus1 = r.bits(3);
  const temporalIdNested = r.bit();
  // profile_tier_level 的 general 部分整段原样带进 hvcC：12 字节。
  const ptlStart = r.pos / 8;
  const raw = unescapeRbsp(sps.subarray(2));
  const profileSpace = r.bits(2);
  const tier = r.bit();
  const profileIdc = r.bits(5);
  const compat = Array.from(raw.subarray(ptlStart + 1, ptlStart + 5));
  r.skip(32);
  const constraint = Array.from(raw.subarray(ptlStart + 5, ptlStart + 11));
  r.skip(48);
  const levelIdc = r.bits(8);
  const subProfile = [];
  const subLevel = [];
  for (let i = 0; i < maxSubLayersMinus1; i++) { subProfile.push(r.bit()); subLevel.push(r.bit()); }
  if (maxSubLayersMinus1 > 0) for (let i = maxSubLayersMinus1; i < 8; i++) r.skip(2);
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    if (subProfile[i]) r.skip(88);
    if (subLevel[i]) r.skip(8);
  }
  r.ue(); // sps_seq_parameter_set_id
  const chromaFormat = r.ue();
  if (chromaFormat === 3) r.skip(1);
  r.ue(); r.ue(); // 宽高（以会话包为准）
  if (r.bit()) { r.ue(); r.ue(); r.ue(); r.ue(); }
  const bitDepthLuma = r.ue();
  const bitDepthChroma = r.ue();
  return {
    profileSpace, tier, profileIdc, compat, constraint, levelIdc, chromaFormat,
    bitDepthLuma, bitDepthChroma, maxSubLayers: maxSubLayersMinus1 + 1, temporalIdNested,
  };
}

function hevcCodecString(info) {
  // ISO/IEC 14496-15 附录 E：hvc1.<space><profile>.<compat 反转位序>.<tier><level>.<constraint…>
  const space = ['', 'A', 'B', 'C'][info.profileSpace];
  let compat = 0;
  const c = (info.compat[0] << 24) | (info.compat[1] << 16) | (info.compat[2] << 8) | info.compat[3];
  for (let i = 0; i < 32; i++) if ((c >>> i) & 1) compat |= 1 << (31 - i);
  const constraint = [...info.constraint];
  while (constraint.length && constraint[constraint.length - 1] === 0) constraint.pop();
  const tail = constraint.length ? '.' + constraint.map((b) => b.toString(16).toUpperCase()).join('.') : '';
  return `hvc1.${space}${info.profileIdc}.${(compat >>> 0).toString(16).toUpperCase()}.${info.tier ? 'H' : 'L'}${info.levelIdc}${tail}`;
}

export function isKeyFrame(codec, data) {
  for (const nal of splitAnnexB(data)) {
    if (codec === 'h264' && h264Type(nal) === 5) return true;
    if (codec === 'h265') { const t = h265Type(nal); if (t >= 16 && t <= 21) return true; }
  }
  return false;
}
