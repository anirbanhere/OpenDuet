export function createPlanConsole({ api, run, el, button }) {
  const $ = (selector) => document.querySelector(selector);
  let pending = null,
    sending = false,
    globallyBusy = false;
  const states = {
    PLANNING: "Preparing a proposal… refresh to check or cancel",
    DRAFT_READY: "Draft ready · no steps executed",
    NEEDS_CLARIFICATION:
      "Needs your clarification · create a new plan with those details",
    UNAVAILABLE: "Requested capability unavailable",
    FAILED:
      "Planning failed · no steps executed; another attempt uses the model allowance",
    INTERRUPTED: "Interrupted on restart · not replayed",
    CANCELLED: "Cancelled · late proposals are discarded",
  };
  function controls() {
    $("#plan-fields").disabled = globallyBusy || sending;
    for (const id of ["plan-goal", "plan-date", "plan-locale"])
      $(`#${id}`).disabled = globallyBusy || sending || Boolean(pending);
    $("#plan-create").textContent = pending
      ? "Check previous request"
      : "Draft a plan";
  }
  async function refresh() {
    const records = await api("/api/task-plans"),
      list = $("#plan-tasks");
    if (
      pending &&
      records.some(
        (task) =>
          task.input.request_id === pending.request_id &&
          task.state !== "PLANNING",
      )
    )
      pending = null;
    list.replaceChildren();
    for (const task of records) {
      const card = el("article");
      card.className = "appointment-task";
      card.append(
        el("h3", task.input.goal),
        el("p", states[task.state] || "Saved draft state"),
        el("p", `Reasoning: ${task.roles.reasoning.id} · ${task.input.locale}`),
      );
      if (task.input.date)
        card.append(el("p", `User-confirmed date: ${task.input.date} (India)`));
      if (task.plan?.question) card.append(el("p", task.plan.question));
      if (task.plan?.unavailable_reason)
        card.append(el("p", task.plan.unavailable_reason));
      if (task.plan?.steps.length) {
        const steps = el("ol");
        for (const step of task.plan.steps) {
          const item = el("li");
          item.append(
            el("p", step.description),
            el(
              "p",
              step.tool === "demo.clinic.options"
                ? "Demo clinic availability · read only · proposed"
                : "Manual guidance · unverified draft",
            ),
            el(
              "p",
              step.tool === "demo.clinic.options"
                ? `Date: ${step.arguments.date}`
                : step.arguments.instructions,
            ),
            el("p", `Expected: ${step.expected_output}`),
          );
          steps.append(item);
        }
        card.append(steps);
      }
      if (!["CANCELLED", "FAILED", "INTERRUPTED"].includes(task.state))
        card.append(
          button("Cancel this draft", async () => {
            await api(`/api/task-plans/${task.id}/cancel`, {});
            $("#plan-status").textContent = states.CANCELLED;
            await refresh();
            list.focus();
          }),
        );
      const history = el("details"),
        summary = el("summary", "Plan activity");
      history.append(summary);
      for (const event of task.events)
        history.append(
          el(
            "p",
            `${event.event} · ${new Date(event.at).toLocaleString("en-IN")}`,
          ),
        );
      card.append(history);
      list.append(card);
    }
    if (!records.length)
      list.append(
        el(
          "p",
          "No saved plans yet. Try a demo dental-slot goal or ask for manual guidance.",
        ),
      );
    controls();
  }
  $("#plan-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (globallyBusy || sending) return;
    if (!pending)
      pending = {
        request_id: crypto.randomUUID(),
        goal: $("#plan-goal").value.trim(),
        locale: $("#plan-locale").value,
        ...($("#plan-date").value ? { date: $("#plan-date").value } : {}),
      };
    sending = true;
    controls();
    $("#plan-status").textContent =
      "Preparing a saved proposal. You can refresh saved plans and cancel while it runs.";
    try {
      const task = await api("/api/task-plans", pending);
      if (task.state !== "PLANNING") pending = null;
      $("#plan-status").textContent = states[task.state] || "Saved draft state";
    } catch (error) {
      if (error.status >= 400 && error.status < 500 && error.status !== 408)
        pending = null;
      $("#plan-status").textContent = error.message;
    } finally {
      sending = false;
      try {
        await refresh();
      } catch {
        $("#plan-status").textContent +=
          " Could not refresh saved state. Check the previous request before a new attempt.";
      }
      controls();
      $("#plan-tasks").focus();
    }
  });
  $("#plan-refresh").addEventListener("click", () =>
    run(refresh, $("#plan-tasks")),
  );
  return {
    refresh,
    setBusy(value) {
      globallyBusy = value;
      controls();
    },
    async initialize() {
      const roles = await api("/api/provider-roles");
      $("#plan-model").textContent = roles.reasoning
        ? `Planner: ${roles.reasoning.id}. One attempt per new goal, shared with the chat allowance. Changing the reply picker does not change saved plans.`
        : "Planner not configured.";
      await refresh();
    },
  };
}
