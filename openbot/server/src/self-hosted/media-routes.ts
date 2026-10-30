import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppVariables } from "./app";
import { LocalError } from "./errors";
import type { OwnedMedia } from "./media-store";

type LocalContext = Context<{ Variables: AppVariables }>;
const empty = z.object({}).strict();
function mediaId(c: LocalContext, mutation = false) {
  const parsed = z.uuid().safeParse(c.req.param("id"));
  if (!parsed.success || new URL(c.req.url).search)
    throw new LocalError("Use a valid media ID without query fields.");
  if (mutation && !empty.safeParse(c.var.body).success)
    throw new LocalError("Media controls accept an empty JSON object only.");
  return parsed.data;
}

/** Register only after the parent's owner/session/CSRF/body/security middleware. */
export function attachLocalMediaControls(
  app: Hono<{ Variables: AppVariables }>,
  options: {
    media: OwnedMedia;
    enabled?: boolean;
    publicOrigin?: string | null;
  },
) {
  // Independent of config parsing: a programmatic caller cannot enable public media.
  if (options.enabled !== true || options.publicOrigin) return false;
  const media = options.media;
  app.get("/api/media/:id", (c) =>
    c.json(media.metadata(c.var.session.owner, mediaId(c))),
  );
  app.post("/api/media/:id/revoke-processing", (c) =>
    c.json(media.revokeProcessing(c.var.session.owner, mediaId(c, true))),
  );
  app.delete("/api/media/:id", (c) =>
    c.json(media.remove(c.var.session.owner, mediaId(c, true))),
  );
  return true;
}
