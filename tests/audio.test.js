import test from "node:test";
import assert from "node:assert/strict";
import {
  SpeechSegmenter,
  encodeWav,
  resample,
} from "../extension/lib/audio.js";
import { validateWav } from "../server/providers.js";
import { profiles } from "../server/config.js";

test("silence never uploads audio, and the pre-roll stays bounded", () => {
  const output = [];
  const segmenter = new SpeechSegmenter(profiles.balanced, (item) =>
    output.push(item),
  );
  for (let i = 0; i < 10000; i++) segmenter.push(new Float32Array(320));
  assert.equal(output.length, 0);
  assert.equal(segmenter.frames.length, 0);
  assert.equal(segmenter.preRoll.length, 10);
});
test("a phrase includes its onset and is emitted after a pause", () => {
  const output = [];
  const segmenter = new SpeechSegmenter(profiles.balanced, (item) =>
    output.push(item),
  );
  for (let i = 0; i < 12; i++) segmenter.push(new Float32Array(320));
  for (let i = 0; i < 50; i++) segmenter.push(new Float32Array(320).fill(0.1));
  for (let i = 0; i < 34; i++) segmenter.push(new Float32Array(320));
  assert.equal(output.length, 1);
  assert.ok(validateWav(Buffer.from(output[0])) > 1.8);
  const wav = Buffer.from(output[0]);
  assert.equal(wav.readInt16LE(44), 0);
  assert.ok(wav.readInt16LE(44 + 3200 * 2) > 0);
});
test("continuous audio is split at the chosen duration and clicks are discarded", () => {
  const output = [];
  const segmenter = new SpeechSegmenter(profiles.fast, (item) =>
    output.push(item),
  );
  for (let i = 0; i < 350; i++) segmenter.push(new Float32Array(320).fill(0.2));
  assert.equal(output.length, 2);
  assert.equal(validateWav(Buffer.from(output[0])), 3.5);
  const click = new SpeechSegmenter(profiles.fast, (item) =>
    assert.fail("A click should not be uploaded"),
  );
  click.push(new Float32Array(320).fill(0.5));
  for (let i = 0; i < 30; i++) click.push(new Float32Array(320));
});
test("48kHz and 44.1kHz frames become correctly timed 16kHz WAV, with sample clipping", () => {
  for (const rate of [48000, 44100, 16000]) {
    const input = new Float32Array(rate / 50).fill(0.5);
    assert.equal(resample(input, rate).length, 320);
  }
  const wav = Buffer.from(encodeWav(new Float32Array(16000).fill(2)));
  assert.equal(validateWav(wav), 1);
  assert.equal(wav.readInt16LE(44), 32767);
  assert.throws(() => validateWav(Buffer.from("not audio")), /WAV/);
  const wrongRate = Buffer.from(wav);
  wrongRate.writeUInt32LE(48000, 24);
  assert.throws(() => validateWav(wrongRate), /WAV/);
});
