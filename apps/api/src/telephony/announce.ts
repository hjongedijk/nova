import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const PHONE_RATE = 16000;

/** Mono Int16 PCM at an arbitrary rate to 16 kHz (linear interpolation; plenty for telephone speech). */
export function resampleTo16k(samples: Int16Array, rate: number): Int16Array {
  if (rate === PHONE_RATE) return samples;
  const length = Math.max(1, Math.floor((samples.length * PHONE_RATE) / rate));
  const out = new Int16Array(length);
  const ratio = rate / PHONE_RATE;
  for (let i = 0; i < length; i++) {
    const position = i * ratio;
    const index = Math.floor(position);
    const fraction = position - index;
    const a = samples[Math.min(index, samples.length - 1)] ?? 0;
    const b = samples[Math.min(index + 1, samples.length - 1)] ?? a;
    out[i] = Math.round(a + (b - a) * fraction);
  }
  return out;
}

export function floatToInt16(channels: Float32Array[]): Int16Array {
  const length = channels[0]?.length ?? 0;
  const out = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (const channel of channels) sum += channel[i] ?? 0;
    const value = Math.max(-1, Math.min(1, sum / channels.length));
    out[i] = Math.round(value * 32767);
  }
  return out;
}

/** Reads 16-bit PCM WAV (any rate, mono or stereo) into mono samples. */
export function parseWav(buffer: Buffer): {
  samples: Int16Array;
  rate: number;
} {
  if (
    buffer.length < 44 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WAVE"
  )
    throw new Error("Not a WAV file");
  let offset = 12;
  let rate = 0;
  let channels = 1;
  let bits = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      if (buffer.readUInt16LE(body) !== 1) throw new Error("WAV is not PCM");
      channels = buffer.readUInt16LE(body + 2);
      rate = buffer.readUInt32LE(body + 4);
      bits = buffer.readUInt16LE(body + 14);
    } else if (id === "data") {
      if (bits !== 16 || !rate || channels < 1 || channels > 2)
        throw new Error("Unsupported WAV format");
      const end = Math.min(buffer.length, body + size);
      const frames = Math.floor((end - body) / (2 * channels));
      const mono = new Int16Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++)
          sum += buffer.readInt16LE(body + (i * channels + c) * 2);
        mono[i] = Math.round(sum / channels);
      }
      return { samples: mono, rate };
    }
    offset = body + size + (size % 2);
  }
  throw new Error("WAV has no audio data");
}

export function encodeWav16k(samples: Int16Array): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++)
    data.writeInt16LE(samples[i]!, i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(PHONE_RATE, 24);
  header.writeUInt32LE(PHONE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export type AudioDecoder = (
  audio: Buffer,
  contentType: string,
) => Promise<Buffer>;

/** TTS output (WAV from Piper, MP3 from edge-tts) to a 16 kHz mono WAV that Asterisk plays natively. */
export const decodeToPhoneWav: AudioDecoder = async (audio, contentType) => {
  if (contentType.includes("wav")) {
    const { samples, rate } = parseWav(audio);
    return encodeWav16k(resampleTo16k(samples, rate));
  }
  const { MPEGDecoder } = await import("mpg123-decoder");
  const decoder = new MPEGDecoder();
  try {
    await decoder.ready;
    const decoded = decoder.decode(new Uint8Array(audio));
    if (!decoded.samplesDecoded)
      throw new Error("MP3 decoding produced no audio");
    return encodeWav16k(
      resampleTo16k(
        floatToInt16(decoded.channelData as Float32Array[]),
        decoded.sampleRate,
      ),
    );
  } finally {
    decoder.free();
  }
};

/** Writes announcement audio where Asterisk can play it as `recording:nova/<id>`. */
export class AnnouncementFiles {
  constructor(private readonly dir: string) {}

  write(wav: Buffer): { media: string; file: string } {
    const sub = path.join(this.dir, "nova");
    fs.mkdirSync(sub, { recursive: true, mode: 0o755 });
    this.prune(sub);
    const id = crypto.randomBytes(8).toString("hex");
    // ".wav16" is Asterisk's name for 16 kHz WAV; plain ".wav" must be 8 kHz.
    const file = path.join(sub, `${id}.wav16`);
    fs.writeFileSync(file, wav, { mode: 0o644 });
    return { media: `recording:nova/${id}`, file };
  }

  remove(file: string): void {
    fs.rmSync(file, { force: true });
  }

  private prune(dir: string): void {
    const cutoff = Date.now() - 60 * 60_000;
    try {
      for (const name of fs.readdirSync(dir)) {
        const target = path.join(dir, name);
        if (/\.wav(16)?$/.test(name) && fs.statSync(target).mtimeMs < cutoff)
          fs.rmSync(target, { force: true });
      }
    } catch {
      /* best effort */
    }
  }
}
