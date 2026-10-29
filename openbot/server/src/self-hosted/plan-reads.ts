import type { Database } from "bun:sqlite";
import { z } from "zod";
import { LocalError } from "./errors";
import type { TaskPlan } from "./plan-contract";
import { validatePlan } from "./plan-contract";
import type { TaskPlans } from "./plans";

const slots = z
  .object({
    mode: z.literal("mock"),
    timezone: z.literal("Asia/Kolkata"),
    min_date: z.string().length(10),
    max_date: z.string().length(10),
    date: z.string().length(10),
    clinic: z.string().min(1).max(150),
    slots: z
      .array(
        z
          .object({
            id: z.enum(["10:00", "11:00", "15:00"]),
            label: z.string().max(100),
          })
          .strict(),
      )
      .max(3),
  })
  .strict();
type Status =
  | "completed"
  | "unavailable"
  | "requires_user_action"
  | "retryable"
  | "permanently_failed";
type Observation = {
  step: string;
  tool: TaskPlan["steps"][number]["tool"];
  status: Status;
  evidence_mode: "mock" | "draft" | "none";
  skipped: boolean;
  at: number;
  output:
    | z.infer<typeof slots>
    | { instructions: string; verified: false }
    | { reason: string };
};
export type ReadResult = {
  task: string;
  mode: "read_only";
  status: Status;
  at: number;
  results: Observation[];
};
export type ClinicLookup = { options(date: string): unknown };
export function migratePlanReads(db: Database) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS plan_read_runs(task TEXT PRIMARY KEY REFERENCES task_plans(id) ON DELETE CASCADE,payload TEXT NOT NULL)",
  );
}
/** Internal helper. HTTP callers must establish ownership through TaskPlans.get first. */
export function savedPlanRead(db: Database, id: string): ReadResult | null {
  const row = db
    .query<{ payload: string }, [string]>(
      "SELECT payload FROM plan_read_runs WHERE task=?",
    )
    .get(id);
  return row ? (JSON.parse(row.payload) as ReadResult) : null;
}

/** Fixed synchronous local tools only. This transaction is not suitable for remote side effects. */
export class PlanReads {
  constructor(
    private db: Database,
    private plans: TaskPlans,
    private appointments: ClinicLookup,
    private now: () => number = Date.now,
  ) {}
  run(owner: string, id: string) {
    return this.db
      .transaction(() => {
        const task = this.plans.get(owner, id),
          prior = savedPlanRead(this.db, id);
        if (prior) return prior;
        if (task.state !== "DRAFT_READY" || !task.plan)
          throw new LocalError(
            "Only a ready, uncancelled draft can start read-only steps.",
            409,
          );
        const plan = validatePlan(task.input, task.plan),
          results: Observation[] = [];
        for (const step of plan.steps) {
          const at = this.now(),
            base = { step: step.id, tool: step.tool, skipped: false, at };
          if (
            step.prerequisites.some(
              (id) =>
                results.find((row) => row.step === id)?.status !== "completed",
            )
          ) {
            results.push({
              ...base,
              status: "requires_user_action",
              evidence_mode: "none",
              skipped: true,
              output: {
                reason:
                  "A prerequisite was not completed; this step was not run.",
              },
            });
            continue;
          }
          if (step.tool === "handoff.manual") {
            results.push({
              ...base,
              status: "requires_user_action",
              evidence_mode: "draft",
              output: {
                instructions: step.arguments.instructions,
                verified: false,
              },
            });
            continue;
          }
          const started = performance.now();
          try {
            const parsed = slots.safeParse(
              this.appointments.options(step.arguments.date),
            );
            if (performance.now() - started > step.timeout_ms) {
              results.push({
                ...base,
                status: "retryable",
                evidence_mode: "none",
                output: {
                  reason:
                    "Local lookup exceeded its deadline; no automatic retry.",
                },
              });
            } else if (
              !parsed.success ||
              parsed.data.date !== task.input.date
            ) {
              results.push({
                ...base,
                status: "permanently_failed",
                evidence_mode: "none",
                output: {
                  reason: "The local tool returned an invalid observation.",
                },
              });
            } else {
              results.push({
                ...base,
                status: parsed.data.slots.length ? "completed" : "unavailable",
                evidence_mode: "mock",
                output: parsed.data,
              });
            }
          } catch (error) {
            if (!(error instanceof LocalError)) throw error;
            results.push({
              ...base,
              status: "unavailable",
              evidence_mode: "none",
              output: {
                reason:
                  "This demo date is outside the available lookup window. Create and review a new dated plan.",
              },
            });
          }
        }
        const priority: Status[] = [
          "permanently_failed",
          "retryable",
          "unavailable",
          "requires_user_action",
        ];
        const result: ReadResult = {
          task: id,
          mode: "read_only",
          status:
            priority.find((status) =>
              results.some((row) => row.status === status),
            ) ?? "completed",
          at: this.now(),
          results,
        };
        this.db
          .query("INSERT INTO plan_read_runs VALUES(?,?)")
          .run(id, JSON.stringify(result));
        this.db
          .query(
            "INSERT INTO plan_events SELECT ?,COALESCE(MAX(seq),-1)+1,'task.read_steps_saved',? FROM plan_events WHERE task=?",
          )
          .run(id, result.at, id);
        return result;
      })
      .immediate();
  }
}
