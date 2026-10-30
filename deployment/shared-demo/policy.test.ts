import { expect, test } from "bun:test";
import { demoPathAllowed, isModelRun } from "./policy";
test("shared demo exposes conversations, streaming, and generated pages", () => {
  expect(
    demoPathAllowed(
      "GET",
      "/api/copilotkit/threads/01234567-0123-0123-0123-0123456789ab/messages?agentId=bot",
    ),
  ).toBe(true);
  for (const [method, path] of [
    ["GET", "/"],
    ["GET", "/assets/app.js"],
    ["GET", "/api/me"],
    ["GET", "/api/channels/events"],
    ["GET", "/api/computers/bot/stream"],
    ["POST", "/api/copilotkit/agent/bot/run"],
    ["POST", "/api/copilotkit/agent/bot/connect"],
    ["POST", "/api/channels"],
    ["PUT", "/api/channels/id/read"],
  ])
    expect(demoPathAllowed(method!, path!)).toBe(true);
});
test("demo refuses administration, credentials, approvals, shell and path escapes", () => {
  for (const [method, path] of [
    ["POST", "/api/saathi/model-key"],
    ["GET", "/api/saathi/status"],
    ["GET", "/api/admin/credentials"],
    ["POST", "/api/approvals/id/decision"],
    ["POST", "/api/computers/bot/exec"],
    ["POST", "/api/agents"],
    ["GET", "/settings/saathi"],
    ["GET", "//evil.test/"],
    ["GET", "/%61pi/admin/credentials"],
    ["GET", "/api/channels/%2e%2e/admin"],
    ["GET", "/api/channels/%252e%252e/admin"],
    ["GET", "/api/channels%2f..%2fadmin"],
    ["GET", "/internal/routines/run"],
  ])
    expect(demoPathAllowed(method!, path!)).toBe(false);
  expect(isModelRun("POST", "/api/copilotkit/agent/bot/run")).toBe(true);
  expect(isModelRun("POST", "/api/copilotkit/agent/bot/connect")).toBe(false);
});
