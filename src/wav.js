import { writeFileSync, openSync, writeSync, closeSync } from 'node:fs';

/**
 * The canonical 44-byte RIFF/WAVE PCM header. `writeWavFile` and the streaming
 * writer share it so their bytes are identical by construction.
 * @param {{ dataSize: number, sampleRate?: number, channels?: number }} opts
 */
export function wavHeaderBytes({ dataSize, sampleRate = 48000, channels = 2 }) {
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const buffer = Buffer.alloc(44);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // PCM fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * blockAlign, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34); // bits
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

/**
 * Write interleaved little-endian PCM as a WAV file.
 * @param {string} path
 * @param {Int16Array} pcm
 * @param {{ sampleRate?: number, channels?: number }} [opts]
 */
export function writeWavFile(path, pcm, opts = {}) {
  const sampleRate = opts.sampleRate ?? 48000;
  const channels = opts.channels ?? 2;
  const dataSize = pcm.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  wavHeaderBytes({ dataSize, sampleRate, channels }).copy(buffer, 0);

  for (let i = 0; i < pcm.length; i++) {
    buffer.writeInt16LE(pcm[i], 44 + i * 2);
  }

  writeFileSync(path, buffer);
}

/**
 * Streaming WAV writer for master-mix finalize: the mix is read from its temp
 * file in bounded chunks and appended here, so neither the mix nor the WAV is
 * ever held whole in memory. Header bytes are byte-identical to `writeWavFile`.
 * @param {string} path
 * @param {{ sampleRate?: number, channels?: number, fs?: { openSync: Function, writeSync: Function, closeSync: Function } }} [opts]
 */
export function openStreamingWavWriter(path, opts = {}) {
  const sampleRate = opts.sampleRate ?? 48000;
  const channels = opts.channels ?? 2;
  /** fs seam: lets a test drive the header-patch/close paths. */
  const io = opts.fs ?? { openSync, writeSync, closeSync };
  const fd = io.openSync(path, 'w');
  io.writeSync(fd, wavHeaderBytes({ dataSize: 0, sampleRate, channels }));

  let dataSize = 0;
  let open = true;

  return {
    /** @param {Int16Array} pcm */
    write(pcm) {
      if (!pcm.length) return;
      // Little-endian host bytes of the int16 samples, shared (no copy).
      io.writeSync(fd, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
      dataSize += pcm.byteLength;
    },
    /** Patch the sizes into the header and close. Returns bytes written. */
    close() {
      if (open) {
        open = false;
        try {
          io.writeSync(fd, wavHeaderBytes({ dataSize, sampleRate, channels }), 0, 44, 0);
        } finally {
          // A failed header patch (EBUSY/EPERM on Windows) must still release
          // the fd: the caller discards this writer, so a skipped close here
          // would leak the handle for the life of the process.
          io.closeSync(fd);
        }
      }
      return dataSize;
    },
    /** Close without patching (error paths); never throws. */
    abort() {
      if (open) {
        open = false;
        try {
          io.closeSync(fd);
        } catch {
          // already closed / never opened
        }
      }
    },
  };
}