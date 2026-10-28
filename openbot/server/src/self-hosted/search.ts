import { z } from "zod";
import { LocalError } from "./store";

export function safeSourceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !url.hostname.includes(".") ||
      /[:[\]]/.test(url.hostname) ||
      /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) ||
      /\.(local|localhost|internal|test|invalid)$/.test(url.hostname)
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}
export const evidenceSchema = z
  .object({
    sources: z
      .array(
        z
          .object({
            title: z.string().min(1).max(200),
            kind: z.enum(["search_result", "opened_page"]).optional(),
            url: z
              .string()
              .max(2048)
              .refine((value) => safeSourceUrl(value) !== null),
          })
          .strict(),
      )
      .max(8),
    searchedAt: z.string().datetime({ offset: true }),
    searchCalls: z.number().int().min(0).max(3),
  })
  .strict();
export type SearchEvidence = z.infer<typeof evidenceSchema>;
export type GroundedAnswer = { text: string; evidence: SearchEvidence };
const item = z.object({
  type: z.string(),
  status: z.string().optional(),
  role: z.string().optional(),
  results: z.array(z.unknown()).max(32).nullish(),
  content: z.array(z.unknown()).max(16).optional(),
  action: z
    .object({
      type: z.string(),
      url: z.string().nullish(),
      sources: z
        .array(z.object({ url: z.string() }))
        .max(32)
        .optional(),
    })
    .optional(),
});
const responseSchema = z.object({
  status: z.literal("completed"),
  error: z.unknown().optional(),
  incomplete_details: z.unknown().optional(),
  output: z.array(item).max(32),
});
const hitSchema = z.object({
  url: z.string().max(2048),
  title: z.string().min(1).max(1000),
});
const textSchema = z.object({
  type: z.literal("output_text"),
  text: z.string().max(16000),
  annotations: z.array(z.unknown()).max(32).optional(),
});
const citationSchema = z.object({
  type: z.literal("url_citation"),
  url: z.string().max(2048),
});
const canonical = (url: string) => {
  const parsed = new URL(url);
  parsed.hash = "";
  return parsed.href;
};

export function parseSearchAnswer(
  raw: unknown,
  searchedAt: string,
  required: boolean,
): GroundedAnswer {
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success || parsed.data.error || parsed.data.incomplete_details)
    throw new LocalError(
      "The web lookup did not finish. No current information was verified.",
      502,
    );
  const hits = new Map<string, { title: string; url: string }>(),
    citations: string[] = [],
    texts: string[] = [];
  let calls = 0;
  for (const output of parsed.data.output) {
    if (output.type === "web_search_call") {
      if (output.status !== "completed" || ++calls > 3)
        throw new LocalError(
          "The web lookup exceeded its tool budget or failed.",
          502,
        );
      for (const value of output.results ?? []) {
        const row = hitSchema.safeParse(value);
        if (!row.success) continue;
        const url = safeSourceUrl(row.data.url);
        if (url)
          hits.set(canonical(url), {
            title: row.data.title.slice(0, 200),
            url,
          });
      }
      for (const source of output.action?.sources ?? []) {
        const url = safeSourceUrl(source.url);
        if (url && !hits.has(canonical(url)))
          hits.set(canonical(url), { title: new URL(url).hostname, url });
      }
      if (output.action?.type === "open_page" && output.action.url) {
        const url = safeSourceUrl(output.action.url);
        if (url)
          hits.set(canonical(url), { title: new URL(url).hostname, url });
      }
    } else if (output.type === "message") {
      if (
        output.role !== "assistant" ||
        (output.status && output.status !== "completed")
      )
        throw new LocalError("The web answer is incomplete.", 502);
      for (const content of output.content ?? []) {
        const text = textSchema.safeParse(content);
        if (!text.success) continue;
        texts.push(text.data.text);
        for (const value of text.data.annotations ?? []) {
          const c = citationSchema.safeParse(value);
          if (c.success) {
            const url = safeSourceUrl(c.data.url);
            if (!url)
              throw new LocalError(
                "The lookup returned an unsafe citation.",
                502,
              );
            citations.push(url);
          }
        }
      }
    } else if (output.type !== "reasoning")
      throw new LocalError(
        "The model requested an ungranted action. No action was executed.",
        502,
      );
  }
  const sources: SearchEvidence["sources"] = [];
  for (const url of [...new Set(citations)]) {
    const hit = hits.get(canonical(url));
    if (!hit)
      throw new LocalError(
        "The lookup citation was not present in its search evidence.",
        502,
      );
    if (!sources.some((source) => canonical(source.url) === canonical(hit.url)))
      sources.push(hit);
  }
  // Only the final assistant text is the answer; earlier messages may narrate tool progress.
  let text = texts.at(-1)?.trim() ?? "";
  if (
    !text ||
    text.length > 16000 ||
    (required && calls === 0) ||
    (citations.length && !sources.length)
  )
    throw new LocalError(
      "The lookup returned no usable cited sources. A live forecast or site check was not verified.",
      502,
    );
  if (calls && !sources.length) {
    for (const hit of hits.values()) {
      const opened = parsed.data.output.some(
        (item) =>
          item.type === "web_search_call" &&
          item.action?.type === "open_page" &&
          item.action.url &&
          safeSourceUrl(item.action.url) &&
          canonical(item.action.url) === canonical(hit.url),
      );
      sources.push({ ...hit, kind: opened ? "opened_page" : "search_result" });
    }
    sources.sort(
      (a, b) =>
        Number(b.kind === "opened_page") - Number(a.kind === "opened_page"),
    );
    if (!sources.length)
      text =
        "A web lookup ran, but it returned no usable source evidence. I could not verify the requested current information. Please try a more specific official URL or check the source directly.";
  }
  return {
    text,
    evidence: evidenceSchema.parse({
      sources: sources.slice(0, 8),
      searchedAt,
      searchCalls: calls,
    }),
  };
}

export function requestClock(now: number) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(now));
  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value;
  const today = `${value("year")}-${value("month")}-${value("day")}`;
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86400000)
    .toISOString()
    .slice(0, 10);
  return `Today in Asia/Kolkata: ${today}. Tomorrow: ${tomorrow}. This server clock overrides dates in earlier conversation turns. Resolve relative dates in India unless the user specifies another timezone. State the exact target date for forecasts.`;
}
export const requiresLookup = (text: string) =>
  /weather|forecast|\bimd\b|https?:\/\/|\b(?:web)?site\b|வானிலை|மழை|मौसम|കാലാവസ്ഥ|ಹವಾಮಾನ/i.test(
    text,
  );
