import { expect, test } from "bun:test";
import { createAnswer } from "../src/self-hosted/answer";
import { selfHostedConfig } from "../src/self-hosted/config";
import { parseSearchAnswer, safeSourceUrl } from "../src/self-hosted/search";

const source = "https://mausam.imd.gov.in/chennai/";
const response = () => ({
  status: "completed",
  output: [
    {
      type: "web_search_call",
      status: "completed",
      results: [
        {
          type: "text_result",
          title: "IMD Chennai",
          url: source,
          snippet: "Synthetic public forecast evidence",
        },
      ],
    },
    {
      type: "message",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: "Synthetic sourced answer.",
          annotations: [
            {
              type: "url_citation",
              url: source,
              title: "IMD Chennai",
              start_index: 0,
              end_index: 9,
            },
          ],
        },
      ],
    },
  ],
});
test("search records only returned/cited safe sources and actual completed search", () => {
  const result = parseSearchAnswer(
    response(),
    "2026-10-29T01:00:00+05:30",
    true,
  );
  expect(result.text).toBe("Synthetic sourced answer.");
  expect(result.evidence.sources).toEqual([
    { title: "IMD Chennai", url: source },
  ]);
  expect(result.evidence.searchCalls).toBe(1);
});
test("fabricated citation, missing search, failed/incomplete or action output fails closed", () => {
  const fake = response();
  fake.output[1]!.content![0]!.annotations[0]!.url =
    "https://unreturned.example.com/";
  expect(() => parseSearchAnswer(fake, "2026-10-29T00:00:00Z", true)).toThrow(
    "not present",
  );
  for (const value of [
    { status: "incomplete", output: [] },
    {
      status: "completed",
      output: [{ type: "function_call", name: "pay_bill" }],
    },
    {
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "Invented forecast", annotations: [] },
          ],
        },
      ],
    },
  ])
    expect(() =>
      parseSearchAnswer(value, "2026-10-29T00:00:00Z", true),
    ).toThrow();
});
test("source links reject credentials, local/IP hosts and non-HTTPS schemes", () => {
  for (const url of [
    "javascript:alert(1)",
    "http://example.com/",
    "https://user:pass@example.com/",
    "https://127.0.0.1/",
    "https://[::1]/",
    "https://localhost/",
    "https://test.local/",
    "https://example.com:8000/",
  ])
    expect(safeSourceUrl(url)).toBeNull();
  expect(safeSourceUrl(source)).toBe(source);
});

test("page-open evidence works without citation annotations; empty evidence cannot preserve a fabricated forecast", () => {
  const result = parseSearchAnswer(
    {
      status: "completed",
      output: [
        {
          type: "web_search_call",
          status: "completed",
          action: { type: "open_page", url: source },
          results: [],
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Synthetic page summary" }],
        },
      ],
    },
    "2026-10-29T00:00:00Z",
    true,
  );
  expect(result.evidence.sources).toEqual([
    { title: "mausam.imd.gov.in", url: source, kind: "opened_page" },
  ]);
  const empty = parseSearchAnswer(
    {
      status: "completed",
      output: [
        {
          type: "web_search_call",
          status: "completed",
          action: { type: "search", query: "synthetic" },
          results: [],
        },
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "Invented verified forecast" },
          ],
        },
      ],
    },
    "2026-10-29T00:00:00Z",
    true,
  );
  expect(empty.text).not.toContain("Invented");
  expect(empty.text).toContain("no usable source evidence");
  expect(empty.evidence.sources).toHaveLength(0);
});

test("native Meta lookup is stateless, bounded and single-attempt with no cross-provider fallback", async () => {
  let calls = 0;
  let body: Record<string, unknown> = {};
  const config = selfHostedConfig({
    META_API_KEY: "synthetic-meta",
    OPENROUTER_API_KEY: "synthetic-router",
    SAATHI_ENABLE_META: "true",
    SAATHI_META_WEB_SEARCH: "true",
  });
  const answer = await createAnswer(config, {
    now: () => Date.parse("2026-10-28T20:00:00Z"),
    fetch: async (url, init) => {
      calls++;
      expect(url).toBe("https://api.meta.ai/v1/responses");
      expect(new Headers(init.headers).get("Authorization")).toBe(
        "Bearer synthetic-meta",
      );
      body = JSON.parse(String(init.body));
      return Response.json(response());
    },
  });
  const result = await answer({
    agent: "saathi",
    threadId: "synthetic",
    runId: "synthetic",
    memories: [],
    messages: [
      {
        id: "synthetic",
        role: "user",
        content: "Check Chennai weather tomorrow",
      },
    ],
    model: {
      id: "meta:muse-spark-1.3",
      model: "muse-spark-1.3",
      provider: "meta",
      name: "Synthetic",
      inputPerMillion: null,
      outputPerMillion: null,
    },
  });
  expect(calls).toBe(1);
  expect(typeof result).toBe("object");
  expect(body.store).toBe(false);
  expect(body.background).toBe(false);
  expect(body.stream).toBe(false);
  expect(body.max_tool_calls).toBe(3);
  expect(body.tool_choice).toBe("auto");
  expect(body.tools).toEqual([{ type: "web_search" }]);
  expect(body.include).toEqual([
    "web_search_call.results",
    "web_search_call.action.sources",
  ]);
  expect(body.previous_response_id).toBeUndefined();
  expect(body.conversation).toBeUndefined();
  expect(body.instructions).toContain("Tomorrow: 2026-10-30");
});

test("tool-budget excess and partially invented citations are refused", () => {
  const fake = response();
  fake.output.push(
    { type: "web_search_call", status: "completed", results: [] },
    { type: "web_search_call", status: "completed", results: [] },
    { type: "web_search_call", status: "completed", results: [] },
  );
  expect(() => parseSearchAnswer(fake, "2026-10-29T00:00:00Z", true)).toThrow(
    "budget",
  );
  const partial = response();
  partial.output[1]!.content![0]!.annotations.push({
    type: "url_citation",
    url: "https://unreturned.example.com/",
    title: "Unreturned",
    start_index: 0,
    end_index: 9,
  });
  expect(() =>
    parseSearchAnswer(partial, "2026-10-29T00:00:00Z", true),
  ).toThrow("not present");
});
