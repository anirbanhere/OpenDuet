import { expect, test } from "bun:test";
import { selfHostedConfig } from "../src/self-hosted/config";
import { validateFixtureOutcome } from "../src/self-hosted/stt-outcome";

const role = selfHostedConfig({ SAATHI_STT_PROVIDER: "fixture-a" }).roles.stt;
const transcript = () => ({
  text: " தமிழ் synthetic ",
  language: "ta-IN",
  confidence: null,
  alternatives: [],
  warnings: [],
  source: { mode: "fixture", provider: "fixture-a", model: "synthetic-stt-v1" },
});
test("fixture settlement outcomes normalize evidence and derive a stable digest without executor credentials", () => {
  const first = validateFixtureOutcome(
    { status: "completed", transcript: transcript() },
    role,
  );
  expect(first.outcome.status).toBe("completed");
  expect(first.digest).toHaveLength(64);
  if (first.outcome.status === "completed")
    expect(first.outcome.transcript.text).toBe("தமிழ் synthetic");
  expect(
    validateFixtureOutcome(
      {
        transcript: { ...transcript(), text: "தமிழ் synthetic" },
        status: "completed",
      },
      role,
    ).digest,
  ).toBe(first.digest);
  expect(
    validateFixtureOutcome(
      {
        status: "completed",
        transcript: { ...transcript(), text: "Different" },
      },
      role,
    ).digest,
  ).not.toBe(first.digest);
  expect(JSON.stringify(first)).not.toContain("executor");
});
test("failure outcomes accept fixed codes only and cannot persist raw errors, tokens or invented live success", () => {
  for (const code of ["provider_failed", "timeout", "aborted"])
    expect(
      validateFixtureOutcome({ status: "failed", code }, role).outcome,
    ).toEqual({ status: "failed", code });
  for (const input of [
    { status: "failed", code: "synthetic-private-provider-error" },
    { status: "failed", code: "timeout", raw_error: "synthetic-private" },
    {
      status: "completed",
      transcript: transcript(),
      executor_token: "synthetic-token",
    },
    { status: "completed", transcript: { ...transcript(), text: "  " } },
    {
      status: "completed",
      transcript: {
        ...transcript(),
        source: { ...transcript().source, mode: "live" },
      },
    },
  ])
    expect(() => validateFixtureOutcome(input, role)).toThrow();
});
