import { describe, expect, test } from "bun:test";
import { createSaathiModels, type ModelKeyStore } from "../src/saathi/models";

function memoryStore(): ModelKeyStore {
  const keys = new Map<string, { encryptedKey: string; model: string }>();
  const selected = new Map<string, "openai" | "anthropic">();
  return {
    async save(owner, provider, value) {
      keys.set(`${owner}:${provider}`, value);
      selected.set(owner, provider);
    },
    async select(owner, provider, model) {
      const value = keys.get(`${owner}:${provider}`);
      if (!value) return false;
      keys.set(`${owner}:${provider}`, { ...value, model });
      selected.set(owner, provider);
      return true;
    },
    async read(owner) {
      const provider = selected.get(owner);
      const value = provider && keys.get(`${owner}:${provider}`);
      return value && provider ? { ...value, provider } : null;
    },
    async list(owner) {
      return (["openai", "anthropic"] as const).flatMap((provider) => {
        const value = keys.get(`${owner}:${provider}`);
        return value
          ? [
              {
                provider,
                model: value.model,
                selected: selected.get(owner) === provider,
              },
            ]
          : [];
      });
    },
    async revoke(owner, provider) {
      keys.delete(`${owner}:${provider}`);
      if (selected.get(owner) === provider) selected.delete(owner);
    },
  };
}

const encryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
describe("Saathi owner model configuration", () => {
  test("concurrent owners resolve their own encrypted keys and selected models", async () => {
    const store = memoryStore();
    const models = createSaathiModels(store, encryptionKey);
    await Promise.all([
      models.save("alice", {
        provider: "openai",
        model: "alice-model",
        apiKey: "alice-secret",
      }),
      models.save("bob", {
        provider: "anthropic",
        model: "bob-model",
        apiKey: "bob-secret",
      }),
    ]);
    expect((await store.read("alice"))?.encryptedKey).not.toContain(
      "alice-secret",
    );
    const [alice, bob] = await Promise.all([
      models.resolve("alice"),
      models.resolve("bob"),
    ]);
    expect(alice).toEqual({
      model: { provider: "openai", defaultModel: "alice-model" },
      apiKey: "alice-secret",
    });
    expect(bob).toEqual({
      model: { provider: "anthropic", defaultModel: "bob-model" },
      apiKey: "bob-secret",
    });
    expect(JSON.stringify(await models.status("alice"))).not.toContain(
      "secret",
    );
  });
  test("switching models affects only future resolutions and cannot use another owner's key", async () => {
    const models = createSaathiModels(memoryStore(), encryptionKey);
    await models.save("alice", {
      provider: "openai",
      model: "first",
      apiKey: "alice-key",
    });
    const first = await models.resolve("alice");
    await models.select("alice", "openai", "second");
    expect(first.model.defaultModel).toBe("first");
    expect((await models.resolve("alice")).model.defaultModel).toBe("second");
    await expect(models.select("bob", "openai", "stolen")).rejects.toThrow(
      "Add your own",
    );
    await expect(models.resolve("bob")).rejects.toThrow("Add your own");
  });
  test("revocation prevents new calls without falling back to deployment credentials", async () => {
    const models = createSaathiModels(memoryStore(), encryptionKey);
    await models.save("alice", {
      provider: "openai",
      model: "first",
      apiKey: "alice-key",
    });
    await models.revoke("alice", "openai");
    await expect(models.resolve("alice")).rejects.toThrow("Add your own");
  });
  test("refuses malformed models, unsupported providers, and injected credential fields", async () => {
    const models = createSaathiModels(memoryStore(), encryptionKey);
    for (const input of [
      { provider: "openai", model: "https://evil.invalid", apiKey: "secret" },
      { provider: "unknown", model: "some-model", apiKey: "secret" },
      { provider: "openai", model: "model", apiKey: "secret", owner: "bob" },
    ])
      await expect(models.save("alice", input)).rejects.toThrow();
    expect(await models.status("alice")).toEqual([]);
  });
});
