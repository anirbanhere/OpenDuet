import { expect, test } from "bun:test";
import { syntheticSpeechFixture } from "../src/self-hosted/speech";
import { inspectPcmWav } from "../src/self-hosted/wav";

test("PCM WAV metadata comes from bounded chunk evidence rather than an audio MIME label", () => {
  const { audio } = syntheticSpeechFixture("ta-IN");
  expect(inspectPcmWav(audio)).toEqual({
    sampleRate: 16000,
    channels: 1,
    bitsPerSample: 16,
    frames: 4000,
    durationMs: 250,
    dataBytes: 8000,
  });
  const padded = new Uint8Array(audio.length + 10);
  padded.set(audio.slice(0, 12));
  padded.set(new TextEncoder().encode("JUNK"), 12);
  new DataView(padded.buffer).setUint32(16, 1, true);
  padded[20] = 0;
  padded.set(audio.slice(12), 22);
  new DataView(padded.buffer).setUint32(4, padded.length - 8, true);
  expect(inspectPcmWav(padded).durationMs).toBe(250);
  const container = new Uint8Array(audio.length + 17);
  container.set(audio, 17);
  expect(inspectPcmWav(container.subarray(17)).frames).toBe(4000);
  const stereo = audio.slice(),
    stereoView = new DataView(stereo.buffer);
  stereoView.setUint16(22, 2, true);
  stereoView.setUint32(28, 64000, true);
  stereoView.setUint16(32, 4, true);
  expect(inspectPcmWav(stereo).durationMs).toBe(125);
});

test("malformed/truncated RIFF, forged alignment, codec, duration and oversized bytes fail closed", () => {
  const { audio } = syntheticSpeechFixture("en-IN");
  const variants: Uint8Array[] = [
    new Uint8Array(100),
    audio.slice(0, -1),
    new Uint8Array(2_000_001),
  ];
  const change = (offset: number, value: number, width: 2 | 4) => {
    const bytes = audio.slice(),
      view = new DataView(bytes.buffer);
    if (width === 2) view.setUint16(offset, value, true);
    else view.setUint32(offset, value, true);
    variants.push(bytes);
  };
  change(16, 0xffffffff, 4);
  change(20, 3, 2);
  change(22, 0, 2);
  change(24, 1, 4);
  change(28, 1, 4);
  change(32, 1, 2);
  change(34, 32, 2);
  change(40, 7999, 4);
  for (const bytes of variants)
    expect(() => inspectPcmWav(bytes)).toThrow("WAV");
  const long = new Uint8Array(44 + 16000 * 2 * 61);
  long.set(audio.slice(0, 44));
  const view = new DataView(long.buffer);
  view.setUint32(4, long.length - 8, true);
  view.setUint32(40, long.length - 44, true);
  expect(() => inspectPcmWav(long)).toThrow("WAV");
});
