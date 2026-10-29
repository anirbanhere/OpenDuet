import { LocalError } from "./errors";
import type { ProviderFetch } from "./http-json";

const maxByteLimit = 2_700_000;
async function boundedBody(
  response: Response,
  signal: AbortSignal,
  byteLimit: number,
) {
  const reader = response.body?.getReader();
  if (!reader) throw new LocalError("Speech provider returned no body.", 502);
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      if (signal.aborted)
        throw new LocalError("Speech request was aborted.", 408);
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > byteLimit) {
        await reader.cancel();
        throw new LocalError(
          "Speech provider response exceeded its byte budget.",
          502,
        );
      }
      chunks.push(value);
    }
    if (signal.aborted)
      throw new LocalError("Speech request was aborted.", 408);
    return new Uint8Array(Buffer.concat(chunks));
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

/** One request, bounded body and cooperative cancellation. Never logs provider errors or keys. */
export async function speechBytes(
  call: ProviderFetch,
  url: string,
  init: RequestInit,
  parent: AbortSignal,
  timeoutMs: number,
  byteLimit: number,
  contentTypes: readonly string[],
) {
  if (!Number.isInteger(byteLimit) || byteLimit < 1 || byteLimit > maxByteLimit)
    throw new LocalError("Unsupported speech response byte budget.");
  if (parent.aborted) throw new LocalError("Speech request was aborted.", 408);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: (error: LocalError) => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    stop = reject;
  });
  const abort = (status: 408 | 504) => {
    stop(
      new LocalError(
        status === 504
          ? "Speech provider timed out; no retry or fallback."
          : "Speech request was aborted.",
        status,
      ),
    );
    controller.abort();
  };
  const parentAbort = () => abort(408);
  parent.addEventListener("abort", parentAbort, { once: true });
  timer = setTimeout(() => abort(504), timeoutMs);
  try {
    return await Promise.race([
      stopped,
      Promise.resolve().then(async () => {
        if (controller.signal.aborted)
          throw new LocalError("Speech request was aborted.", 408);
        const response = await call(url, {
          ...init,
          redirect: "error",
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          await response.body?.cancel().catch(() => {});
          throw new LocalError("Speech request was aborted.", 408);
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new LocalError(
            response.status === 401 || response.status === 403
              ? "Speech provider authorization unavailable; check access and retention eligibility."
              : response.status === 429
                ? "Speech provider is busy; no automatic retry."
                : "Speech provider request failed; no retry or fallback.",
            [401, 403, 429].includes(response.status) ? 503 : 502,
          );
        }
        const length = response.headers.get("content-length"),
          contentType = (
            (response.headers.get("content-type") || "").split(";", 1)[0] ?? ""
          )
            .trim()
            .toLowerCase();
        if (
          !contentTypes.includes(contentType) ||
          (length !== null &&
            (!/^\d+$/.test(length) || Number(length) > byteLimit))
        ) {
          await response.body?.cancel().catch(() => {});
          throw new LocalError(
            "Speech provider returned an unsupported or oversized body.",
            502,
          );
        }
        return boundedBody(response, controller.signal, byteLimit);
      }),
    ]);
  } catch (error) {
    if (error instanceof LocalError) throw error;
    throw new LocalError(
      "Speech provider request failed; no retry or fallback.",
      502,
    );
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", parentAbort);
  }
}

/** STT retains its smaller default; only TTS opts into a bounded base64 envelope. */
export async function speechJson(
  call: ProviderFetch,
  url: string,
  init: RequestInit,
  parent: AbortSignal,
  timeoutMs: number,
  byteLimit = 128000,
): Promise<unknown> {
  const bytes = await speechBytes(
    call,
    url,
    init,
    parent,
    timeoutMs,
    byteLimit,
    ["application/json"],
  );
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new LocalError("Speech provider returned invalid JSON.", 502);
  }
}
