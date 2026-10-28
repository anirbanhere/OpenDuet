import { LocalError } from "./store";

export async function inferenceJson(
  call: ProviderFetch,
  url: string,
  key: string,
  body: unknown,
  signal: AbortSignal,
  budget: number,
) {
  const response = await call(url, {
    method: "POST",
    redirect: "error",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    signal,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {}
    if (response.status === 429)
      throw new LocalError(
        "The selected model is busy (429). Your message is saved. No automatic retry or provider fallback.",
        503,
      );
    if (response.status === 401 || response.status === 403)
      throw new LocalError(
        "The model key or account permissions blocked this request. Local storage is still available.",
        503,
      );
    throw new LocalError(
      "The model provider could not answer. Your message is saved; no action was executed.",
      502,
    );
  }
  return boundedJson(response, budget);
}

export type ProviderFetch = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export async function boundedJson(
  response: Response,
  budget: number,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new LocalError("The provider returned no response.", 502);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > budget) {
        try {
          await reader.cancel();
        } catch {}
        throw new LocalError(
          "The provider response exceeded its byte budget.",
          502,
        );
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    reader.releaseLock();
  }
}
