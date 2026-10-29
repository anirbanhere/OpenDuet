import type { Hono } from "hono";
import { z } from "zod";
import { createAnswer } from "./answer";
import type { AppVariables } from "./app";
import type { selfHostedConfig } from "./config";
import { LocalError } from "./errors";
import type { ProviderFetch } from "./http-json";
import { planInput, planningInstructions, validatePlan } from "./plan-contract";
import type { TaskPlans } from "./plans";
import type { ProviderRoles } from "./roles";
import type { SelfHostedStore } from "./store";

export type Planner = (task: ReturnType<TaskPlans["get"]>) => Promise<unknown>;

/** One stateless reasoning request, using the saved role snapshot and current provider policy. */
export async function createPlanner(
  config: ReturnType<typeof selfHostedConfig>,
  transport: { fetch?: ProviderFetch; now?: () => number } = {},
): Promise<Planner> {
  return async (task) => {
    const answer = await createAnswer(
      { ...config, roles: task.roles },
      transport,
    );
    const raw = await answer({
      agent: "saathi",
      purpose: "reasoning",
      directive: planningInstructions,
      runId: task.id,
      threadId: task.id,
      memories: [],
      messages: [
        {
          id: task.id,
          role: "user",
          content: JSON.stringify({
            goal: task.input.goal,
            locale: task.input.locale,
            confirmed_date: task.input.date ?? null,
          }),
        },
      ],
    });
    if (typeof raw !== "string" || raw.length > 16000)
      throw new LocalError(
        "The planner returned an unsupported response. Nothing was executed.",
        502,
      );
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new LocalError(
        "The planner did not return strict JSON. Nothing was executed.",
        502,
      );
    }
    return validatePlan(task.input, json);
  };
}

/** Registered after the parent session/CSRF/JSON middleware; this path never executes plan steps. */
export function attachPlanRoutes(
  app: Hono<{ Variables: AppVariables }>,
  options: { store: SelfHostedStore; roles?: ProviderRoles; planner?: Planner },
) {
  const plans = options.store.plans;
  app.get("/api/task-plans", (c) => c.json(plans.list(c.var.session.owner)));
  app.get("/api/task-plans/:id", (c) =>
    c.json(plans.get(c.var.session.owner, c.req.param("id"))),
  );
  app.post("/api/task-plans/:id/cancel", (c) => {
    if (!z.object({}).strict().safeParse(c.var.body).success)
      throw new LocalError("Unsupported cancellation fields.");
    return c.json(plans.cancel(c.var.session.owner, c.req.param("id")));
  });
  app.post("/api/task-plans", async (c) => {
    if (!planInput.safeParse(c.var.body).success)
      throw new LocalError("Invalid or unsupported task planning fields.");
    if (!options.roles || !options.planner)
      throw new LocalError(
        "Task planning is not configured. Nothing was executed.",
        503,
      );
    const owner = c.var.session.owner,
      task = plans.begin(owner, c.var.body, options.roles);
    if (!task.fresh) return c.json(plans.get(owner, task.id), 200);
    try {
      const proposal = await options.planner(task);
      return c.json(plans.complete(owner, task.id, proposal), 201);
    } catch {
      const saved = plans.fail(owner, task.id);
      if (saved.state === "CANCELLED") return c.json(saved, 200);
      throw new LocalError(
        "Planning failed. Check the saved task before starting another attempt. No step was executed.",
        502,
      );
    }
  });
}
