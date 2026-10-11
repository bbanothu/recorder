/**
 * Minimal Ogg Opus muxer for raw Opus packets (RFC 7845).
 * No native deps — CRC32 implemented in JS.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) {
      r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    }
    table[i] = r >>> 0;
  }
  return table;
})();

function oggCrc(buf) {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) & 0xff) ^ buf[i]]) >>> 0;
  }
  return crc;
}

function writeU32LE(buf, offset, value) {
  buf.writeUInt32LE(value >>> 0, offset);
}

function writeU64LE(buf, offset, value) {
  const lo = value % 0x100000000;
  const hi = Math.floor(value / 0x100000000);
  buf.writeUInt32LE(lo >>> 0, offset);
  buf.writeUInt32LE(hi >>> 0, offset + 4);
}

function buildOpusHead({ channels = 2, sampleRate = 48000, preSkip = 0 } = {}) {
  const buf = Buffer.alloc(19);
  buf.write('OpusHead', 0);
  buf[8] = 1; // version
  buf[9] = channels;
  buf.writeUInt16LE(preSkip, 10);
  buf.writeUInt32LE(sampleRate, 12);
  buf.writeInt16LE(0, 16); // output gain
  buf[18] = 0; // channel mapping family
  return buf;
}

function buildOpusTags(vendor = 'spike-voice') {
  const vendorBuf = Buffer.from(vendor, 'utf8');
  const buf = Buffer.alloc(8 + 4 + vendorBuf.length + 4);
  buf.write('OpusTags', 0);
  buf.writeUInt32LE(vendorBuf.length, 8);
  vendorBuf.copy(buf, 12);
  buf.writeUInt32LE(0, 12 + vendorBuf.length); // user comment list length
  return buf;
}

/**
 * Pack packets into one Ogg page.
 * @param {number} headerType bit0=continued, bit1=bos, bit2=eos
 */
function makePage({ packets, headerType, granulePos, serial, pageSeq }) {
  const segs = [];
  for (const pkt of packets) {
    let left = pkt.length;
    while (left >= 255) {
      segs.push(255);
      left -= 255;
    }
    segs.push(left);
  }
  if (segs.length > 255) {
    throw new Error('too many segments for one Ogg page');
  }

  const bodyLen = packets.reduce((n, p) => n + p.length, 0);
  const headerLen = 27 + segs.length;
  const page = Buffer.alloc(headerLen + bodyLen);
  page.write('OggS', 0);
  page[4] = 0; // version
  page[5] = headerType;
  writeU64LE(page, 6, granulePos);
  writeU32LE(page, 14, serial);
  writeU32LE(page, 18, pageSeq);
  writeU32LE(page, 22, 0); // checksum placeholder
  page[26] = segs.length;
  for (let i = 0; i < segs.length; i++) page[27 + i] = segs[i];

  let off = headerLen;
  for (const pkt of packets) {
    pkt.copy(page, off);
    off += pkt.length;
  }

  const crc = oggCrc(page);
  writeU32LE(page, 22, crc);
  return page;
}

/**
 * @param {Buffer[]} opusPackets raw Opus packets (one Discord frame each)
 * @param {{ channels?: number, sampleRate?: number, samplesPerFrame?: number, serial?: number }} opts
 */
export function muxOpusToOgg(opusPackets, opts = {}) {
  const channels = opts.channels ?? 2;
  const sampleRate = opts.sampleRate ?? 48000;
  const samplesPerFrame = opts.samplesPerFrame ?? 960; // 20 ms @ 48 kHz
  const serial = opts.serial ?? (Math.floor(Math.random() * 0xffffffff) >>> 0);

  const pages = [];
  let pageSeq = 0;

  pages.push(
    makePage({
      packets: [buildOpusHead({ channels, sampleRate })],
      headerType: 0x02, // bos
      granulePos: 0,
      serial,
      pageSeq: pageSeq++,
    }),
  );
  pages.push(
    makePage({
      packets: [buildOpusTags()],
      headerType: 0x00,
      granulePos: 0,
      serial,
      pageSeq: pageSeq++,
    }),
  );

  let granule = 0;
  for (let i = 0; i < opusPackets.length; i++) {
    granule += samplesPerFrame;
    const isLast = i === opusPackets.length - 1;
    pages.push(
      makePage({
        packets: [opusPackets[i]],
        headerType: isLast ? 0x04 : 0x00, // eos on last
        granulePos: granule,
        serial,
        pageSeq: pageSeq++,
      }),
    );
  }

  // Empty session: still emit EOS after tags so file is structurally valid
  if (opusPackets.length === 0) {
    pages.push(
      makePage({
        packets: [Buffer.alloc(0)],
        headerType: 0x04,
        granulePos: 0,
        serial,
        pageSeq: pageSeq++,
      }),
    );
  }

  return Buffer.concat(pages);
}
