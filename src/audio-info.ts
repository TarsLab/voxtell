/**
 * 音频时长探测(零依赖):mp3 读帧头(CBR 按码率算,有 Xing/Info 头按帧数算),wav 读 RIFF 头。
 * 时长是合成产物的固有属性:drawtell 用它把该步笔画拉伸到讲稿长度,V1 的 align 也要它。
 * 精度:CBR 估算与 afinfo 差 <1%;够用,不追求采样级精确。
 */

const MPEG1_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG1
  2: [22050, 24000, 16000], // MPEG2
  0: [11025, 12000, 8000], // MPEG2.5
};

function id3v2Size(b: Uint8Array): number {
  if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return 0;
  const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
  const footer = b[5] & 0x10 ? 10 : 0;
  return 10 + size + footer;
}

/** mp3(Layer III)时长,毫秒;认不出返回 null */
export function mp3DurationMs(b: Uint8Array): number | null {
  let off = id3v2Size(b);
  // 找第一个帧同步(容忍 tag 与帧之间的垃圾字节,最多扫 64KB)
  const limit = Math.min(b.length - 4, off + 65536);
  for (; off < limit; off++) {
    if (b[off] !== 0xff || (b[off + 1] & 0xe0) !== 0xe0) continue;
    const version = (b[off + 1] >> 3) & 3; // 3=MPEG1 2=MPEG2 0=MPEG2.5
    const layer = (b[off + 1] >> 1) & 3; // 1 = Layer III
    if (version === 1 || layer !== 1) continue;
    const brIdx = (b[off + 2] >> 4) & 0xf;
    const srIdx = (b[off + 2] >> 2) & 3;
    if (brIdx === 0 || brIdx === 15 || srIdx === 3) continue;
    const bitrateKbps = (version === 3 ? MPEG1_BITRATES : MPEG2_BITRATES)[brIdx];
    const sampleRate = SAMPLE_RATES[version][srIdx];
    const channelMode = (b[off + 3] >> 6) & 3; // 3 = mono
    const samplesPerFrame = version === 3 ? 1152 : 576;
    // Xing/Info(VBR 或带帧数的 CBR):在第一帧 side info 之后
    const sideInfo = version === 3 ? (channelMode === 3 ? 17 : 32) : channelMode === 3 ? 9 : 17;
    const x = off + 4 + sideInfo;
    if (x + 16 <= b.length) {
      const tag = String.fromCharCode(b[x], b[x + 1], b[x + 2], b[x + 3]);
      if (tag === 'Xing' || tag === 'Info') {
        const flags = (b[x + 4] << 24) | (b[x + 5] << 16) | (b[x + 6] << 8) | b[x + 7];
        if (flags & 1) {
          const frames = ((b[x + 8] << 24) | (b[x + 9] << 16) | (b[x + 10] << 8) | b[x + 11]) >>> 0;
          if (frames > 0) return Math.round((frames * samplesPerFrame * 1000) / sampleRate);
        }
      }
    }
    // CBR:剩余字节 / 每秒字节
    const bytes = b.length - off;
    return Math.round((bytes * 8) / bitrateKbps);
  }
  return null;
}

/** wav 时长,毫秒;认不出返回 null */
export function wavDurationMs(b: Uint8Array): number | null {
  if (b.length < 44) return null;
  const s = (i: number) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
  if (s(0) !== 'RIFF' || s(8) !== 'WAVE') return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let off = 12;
  let byteRate = 0;
  while (off + 8 <= b.length) {
    const id = s(off);
    const size = dv.getUint32(off + 4, true);
    if (id === 'fmt ') byteRate = dv.getUint32(off + 16, true);
    if (id === 'data') {
      if (!byteRate) return null;
      const dataSize = size === 0xffffffff || off + 8 + size > b.length ? b.length - off - 8 : size;
      return Math.round((dataSize * 1000) / byteRate);
    }
    off += 8 + size + (size & 1);
  }
  return null;
}

export function durationMsOf(bytes: Uint8Array, format: string): number | null {
  if (format === 'mp3') return mp3DurationMs(bytes);
  if (format === 'wav') return wavDurationMs(bytes);
  return null;
}
