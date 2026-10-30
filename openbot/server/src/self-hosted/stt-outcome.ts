import { createHash } from "node:crypto";
import { z } from "zod";
import { LocalError } from "./errors";
import type { ProviderRoles } from "./roles";
import { validateFixtureTranscript } from "./speech";

const outcomeSchema = z.discriminatedUnion("status", [
  z
    .object({ status: z.literal("completed"), transcript: z.unknown() })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      code: z.enum(["provider_failed", "timeout", "aborted"]),
    })
    .strict(),
]);

/** Typed fixture evidence only. Digest is not executor authentication or an execution receipt. */
export function validateFixtureOutcome(
  input: unknown,
  role: ProviderRoles["stt"],
) {
  if (
    (role.provider !== "fixture-a" && role.provider !== "fixture-b") ||
    role.model !== "synthetic-stt-v1"
  )
    throw new LocalError("Only reviewed fixture outcomes are supported.", 503);
  const parsed = outcomeSchema.safeParse(input);
  if (!parsed.success)
    throw new LocalError(
      "Fixture STT outcome is invalid; raw provider errors and executor credentials are not accepted.",
      502,
    );
  const outcome =
    parsed.data.status === "completed"
      ? {
          status: "completed" as const,
          transcript: validateFixtureTranscript(parsed.data.transcript, role),
        }
      : parsed.data;
  return {
    outcome,
    digest: createHash("sha256").update(JSON.stringify(outcome)).digest("hex"),
  };
}
