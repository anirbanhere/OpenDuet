import { timingSafeEqual } from "node:crypto";
import type { AuthService } from "./guards";

export type DemoGatewayConfig = { token: string; userId: string };

/** Dedicated public-demo identity, authenticated by the server-side Sites bridge. */
export function demoGatewayConfig(
  environment: Record<string, string | undefined>,
): DemoGatewayConfig | undefined {
  const token = environment.SAATHI_DEMO_GATEWAY_TOKEN?.trim();
  const userId = environment.SAATHI_DEMO_USER_ID?.trim();
  const enabled = environment.SAATHI_PUBLIC_DEMO === "true";
  if (!enabled && !token && !userId) return undefined;
  if (
    !enabled ||
    environment.SAATHI_ENABLED !== "true" ||
    !token ||
    !/^[A-Za-z0-9_-]{43,128}$/.test(token) ||
    !userId ||
    !/^saathi-demo-[a-f0-9]{16}$/.test(userId)
  ) {
    throw new Error(
      "Public demo requires SAATHI_ENABLED, SAATHI_PUBLIC_DEMO, a strong gateway token, and a separate saathi-demo user ID.",
    );
  }
  return { token, userId };
}

export function createDemoGatewayAuth(
  config: DemoGatewayConfig,
  loadUser: (id: string) => Promise<{ id: string; email: string } | null>,
): AuthService {
  return {
    handler: () =>
      Response.json(
        { error: "Demo access is provided through the published Site." },
        { status: 401 },
      ),
    api: {
      async getSession({ headers }) {
        const received = headers.get("x-saathi-demo-token") ?? "";
        const receivedBytes = Buffer.from(received);
        const expectedBytes = Buffer.from(config.token);
        if (
          receivedBytes.length !== expectedBytes.length ||
          !timingSafeEqual(receivedBytes, expectedBytes)
        )
          return null;
        const user = await loadUser(config.userId);
        if (!user || user.id !== config.userId) return null;
        // Never inherit an administrator role from forwarded headers or the local developer actor.
        return {
          user: {
            id: user.id,
            email: user.email,
            name: "Demo visitor",
            role: "user",
          },
        };
      },
    },
  };
}
