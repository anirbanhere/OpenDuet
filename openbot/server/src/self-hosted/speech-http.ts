import { LocalError } from "./errors";
import type { ProviderFetch } from "./http-json";

const byteLimit = 128000;
async function jsonBody(response: Response, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader)
    throw new LocalError("Speech provider returned no JSON body.", 502);
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
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

/** One request, bounded body and cooperative cancellation. Never logs provider errors or keys. */
export async function speechJson(
  call: ProviderFetch,
  url: string,
  init: RequestInit,
  parent: AbortSignal,
  timeoutMs: number,
) {
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
          contentType = response.headers.get("content-type") || "";
        if (
          !contentType.toLowerCase().startsWith("application/json") ||
          (length !== null &&
            (!/^\d+$/.test(length) || Number(length) > byteLimit))
        ) {
          await response.body?.cancel().catch(() => {});
          throw new LocalError(
            "Speech provider returned unsupported or oversized JSON.",
            502,
          );
        }
        return jsonBody(response, controller.signal);
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
