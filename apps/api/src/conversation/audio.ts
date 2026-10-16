import { parseWav, resampleTo16k } from "../telephony/announce.js";

/** Speech models and the segmenter work on 16 kHz mono PCM; phone audio is 8 kHz. */
export const STT_RATE = 16000;
export const PHONE_RATE = 8000;

export const pcmFromBuffer = (buffer: Buffer): Int16Array => {
  const even = buffer.length - (buffer.length % 2);
  const out = new Int16Array(even / 2);
  for (let i = 0; i < out.length; i++) out[i] = buffer.readInt16LE(i * 2);
  return out;
};

export const bufferFromPcm = (samples: Int16Array): Buffer => {
  const out = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(samples[i]!, i * 2);
  return out;
};

/** Linear resampling between any two rates (phone 8 kHz <-> 16 kHz and TTS rates). */
export function resample(
  samples: Int16Array,
  from: number,
  to: number,
): Int16Array {
  if (from === to || samples.length === 0) return samples;
  if (to === STT_RATE) return resampleTo16k(samples, from);
  const ratio = from / to;
  const length = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    // Averaging over the source span acts as a crude low-pass when going down.
    const start = i * ratio;
    const end = Math.min(samples.length, Math.max(start + 1, (i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = Math.floor(start); j < Math.ceil(end); j++) {
      sum += samples[j]!;
      count++;
    }
    out[i] = Math.round(sum / Math.max(1, count));
  }
  return out;
}

export function rms(samples: Int16Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / samples.length);
}

export function encodeWav(samples: Int16Array, rate: number): Buffer {
  const data = bufferFromPcm(samples);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** 16 kHz mono WAV (what decodeToPhoneWav produces) to samples. */
export function wavToPcm16k(wav: Buffer): Int16Array {
  const { samples, rate } = parseWav(wav);
  return rate === STT_RATE ? samples : resample(samples, rate, STT_RATE);
}

/** A sine tone, for tests and the greeting beep. */
export function tone(
  rate: number,
  ms: number,
  hz = 440,
  amplitude = 8000,
): Int16Array {
  const out = new Int16Array(Math.round((rate * ms) / 1000));
  for (let i = 0; i < out.length; i++)
    out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * hz * i) / rate));
  return out;
}
