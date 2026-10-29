import { expect, test } from "bun:test";
import { prepareMedia } from "../src/self-hosted/media-contract";
import { syntheticSpeechFixture } from "../src/self-hosted/speech";

const context = () => ({
  owner: "123e4567-e89b-42d3-a456-426614174000",
  now: 1000,
  sessionExpiresAt: 2_000_000,
});
const input = () => ({
  request_id: "synthetic-upload",
  audio: syntheticSpeechFixture("en-IN").audio,
  mimeType: "audio/wav",
  consentToStore: true,
  languageHint: "en-IN",
});
test("media admission derives bounded metadata and copies bytes without granting processing consent", () => {
  const request = input(),
    result = prepareMedia(context(), request);
  expect(result.owner).toBe(context().owner);
  expect(result.durationMs).toBe(250);
  expect(result.byteLength).toBe(8044);
  expect(result.expiresAt).toBe(901000);
  expect(result.consentToProcess).toBe(false);
  expect(result.audio).not.toBe(request.audio);
  request.audio[0] = 0;
  expect(result.audio[0]).toBe(82);
  expect(result.contentSha256).toHaveLength(64);
  expect(
    prepareMedia({ ...context(), sessionExpiresAt: 1100 }, input()).expiresAt,
  ).toBe(1100);
});
test("stable media identity excludes time but includes reviewed language and processing consent", () => {
  const first = prepareMedia(context(), input());
  expect(prepareMedia({ ...context(), now: 2000 }, input()).requestDigest).toBe(
    first.requestDigest,
  );
  expect(
    prepareMedia(context(), { ...input(), consentToProcess: true })
      .requestDigest,
  ).not.toBe(first.requestDigest);
  expect(
    prepareMedia(context(), { ...input(), languageHint: "ta-IN" })
      .requestDigest,
  ).not.toBe(first.requestDigest);
});
test("missing storage consent, client context, URLs and non-WAV/oversized audio fail closed", () => {
  for (const request of [
    { ...input(), consentToStore: false },
    { ...input(), consentToStore: undefined },
    { ...input(), owner: context().owner },
    { ...input(), expiresAt: 999999999 },
    { ...input(), url: "https://example.com/audio.wav" },
    { ...input(), audio: new Uint8Array(100) },
    { ...input(), audio: new Uint8Array(2_000_001) },
    { ...input(), mimeType: "audio/mpeg" },
  ])
    expect(() => prepareMedia(context(), request)).toThrow();
  expect(() =>
    prepareMedia({ ...context(), owner: "unknown" }, input()),
  ).toThrow();
  expect(() =>
    prepareMedia({ ...context(), now: 2_000_000 }, input()),
  ).toThrow();
  expect(() =>
    prepareMedia({ ...context(), now: Number.NaN }, input()),
  ).toThrow();
});
