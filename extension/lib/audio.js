export function resample(input, sampleRate, targetRate = 16000) {
  if (sampleRate === targetRate) return new Float32Array(input);
  const output = new Float32Array(
    Math.round((input.length * targetRate) / sampleRate),
  );
  const ratio = sampleRate / targetRate;
  for (let i = 0; i < output.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(
      input.length,
      Math.max(start + 1, Math.floor((i + 1) * ratio)),
    );
    let sum = 0;
    for (let k = start; k < end; k++) sum += input[k];
    output[i] = sum / (end - start);
  }
  return output;
}

export function encodeWav(samples) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset, value) => {
    for (let i = 0; i < value.length; i++)
      view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(
      44 + i * 2,
      Math.round(sample * (sample < 0 ? 32768 : 32767)),
      true,
    );
  }
  return buffer;
}

// Energy-based segmentation, not a speech classifier. A short pre-roll preserves word onsets.
export class SpeechSegmenter {
  constructor(profile, onSegment) {
    this.profile = profile;
    this.onSegment = onSegment;
    this.preRoll = [];
    this.frames = [];
    this.samples = 0;
    this.speechSamples = 0;
    this.quietSamples = 0;
  }
  push(frame) {
    const rms = Math.sqrt(
      frame.reduce((sum, n) => sum + n * n, 0) / frame.length,
    );
    const voiced = rms > 0.012;
    if (!this.frames.length && !voiced) {
      this.preRoll.push(frame);
      if (this.preRoll.length > 10) this.preRoll.shift();
      return rms;
    }
    if (!this.frames.length) {
      this.frames = this.preRoll;
      this.preRoll = [];
      this.samples = this.frames.reduce((sum, item) => sum + item.length, 0);
    }
    this.frames.push(frame);
    this.samples += frame.length;
    if (voiced) {
      this.speechSamples += frame.length;
      this.quietSamples = 0;
    } else this.quietSamples += frame.length;
    if (
      this.samples >= this.profile.maxSeconds * 16000 ||
      this.quietSamples >= this.profile.silenceMs * 16
    )
      this.flush();
    return rms;
  }
  flush() {
    if (this.speechSamples >= this.profile.minSpeechMs * 16) {
      const samples = new Float32Array(this.samples);
      let offset = 0;
      for (const frame of this.frames) {
        samples.set(frame, offset);
        offset += frame.length;
      }
      this.onSegment(encodeWav(samples));
    }
    this.frames = [];
    this.samples = 0;
    this.speechSamples = 0;
    this.quietSamples = 0;
    this.preRoll = [];
  }
}
