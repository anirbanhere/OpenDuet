import { LocalError } from "./store";

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
