"use strict";
const $ = (selector) => document.querySelector(selector);
const el = (tag, text) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
};
let csrf = "",
  selected = null,
  busy = false,
  pending = null;
async function api(path, body, method = "POST") {
  const response = await fetch(
    path,
    body === undefined
      ? {}
      : {
          method,
          headers: {
            "Content-Type": "application/json",
            "X-Saathi-CSRF": csrf,
          },
          body: JSON.stringify(body),
        },
  );
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      result.error?.message ||
        "Request failed. Refresh saved state before retrying.",
    );
  return result;
}
async function run(action, focusAfter = null) {
  if (busy) return;
  busy = true;
  document.querySelectorAll("button").forEach((button) => {
    button.disabled = true;
  });
  $("#status").textContent = "Working…";
  let succeeded = false;
  try {
    await action();
    succeeded = true;
    $("#status").textContent = "Saved on this server.";
  } catch (error) {
    $("#status").textContent = error.message;
  } finally {
    busy = false;
    document.querySelectorAll("button").forEach((button) => {
      button.disabled = false;
    });
    $("#send").textContent = pending
      ? "Check previous send ↗"
      : "Send message ↗";
    if (succeeded) focusAfter?.focus();
  }
}
function button(text, action, className = "secondary") {
  const element = el("button", text);
  element.type = "button";
  element.className = className;
  element.addEventListener("click", () => run(action));
  return element;
}
async function threads() {
  const records = await api("/api/threads"),
    list = $("#threads");
  list.replaceChildren();
  for (const record of records) {
    const title = `${record.agent === "saathi" ? "Everyday help" : record.agent} · ${new Date(record.created).toLocaleDateString("en-IN")}`;
    const item = button(
      title,
      async () => {
        pending = null;
        await show(record.id);
        await threads();
      },
      "thread",
    );
    item.setAttribute("aria-current", String(selected === record.id));
    list.append(item);
  }
  if (!records.length) list.append(el("p", "No conversations yet."));
}
async function show(id) {
  const thread = await api(`/api/threads/${id}`);
  selected = id;
  $("#delete-thread").hidden = false;
  const runState = thread.lastRun?.state;
  $("#thread-state").textContent =
    runState === "running"
      ? "An answer is still running. Refresh saved state to check it."
      : ["failed", "interrupted"].includes(runState)
        ? `Last send: ${runState}. It was not replayed. A new send is a new model request.`
        : "";
  $("#thread-title").textContent =
    thread.agent === "saathi"
      ? "Everyday help"
      : thread.agent === "kitchen"
        ? "Saathi Kitchen"
        : "Saathi Stock";
  const list = $("#messages");
  list.replaceChildren();
  for (const message of thread.messages) {
    const card = el("article");
    card.className = `message ${message.role}`;
    const speaker = el("span", message.role === "user" ? "You" : "Saathi");
    speaker.className = "speaker";
    card.append(speaker, el("span", message.content));
    list.append(card);
  }
  if (!thread.messages.length)
    list.append(
      el(
        "p",
        "Start with a question. This conversation will stay here after a server restart.",
      ),
    );
  list.scrollTop = list.scrollHeight;
}
async function memories() {
  const records = await api("/api/memories"),
    list = $("#memories");
  list.replaceChildren();
  for (const record of records) {
    const card = el("article");
    card.className = "memory-item";
    card.append(
      el("p", record.content),
      button(
        "Delete memory",
        async () => {
          await api(`/api/memories/${record.id}`, {}, "DELETE");
          await memories();
          $("#memory-text").focus();
        },
        "text-button",
      ),
    );
    list.append(card);
  }
  if (!records.length) list.append(el("p", "No memories saved."));
}
async function enter(session) {
  csrf = session.csrf;
  $("#welcome").hidden = true;
  $("#workspace").hidden = false;
  $("#model").textContent =
    `Chat model: ${session.model}. Free-provider capacity and language quality may vary.`;
  await threads();
  await memories();
  const records = await api("/api/threads");
  if (records.length) {
    await show(records[0].id);
    await threads();
  }
}
$("#start").addEventListener("click", () =>
  run(async () => enter(await api("/api/session", { consent: true }))),
);
$("#new-thread").addEventListener("click", () =>
  run(async () => {
    pending = null;
    const thread = await api("/api/threads", { agent: $("#agent").value });
    await show(thread.id);
    await threads();
    $("#message").focus();
  }),
);
$("#refresh").addEventListener("click", () =>
  run(async () => {
    if (selected) await show(selected);
    await threads();
    await memories();
  }),
);
$("#chat").addEventListener("submit", (event) => {
  event.preventDefault();
  run(async () => {
    const text = $("#message").value.trim();
    if (!text) return;
    if (!selected) {
      const thread = await api("/api/threads", { agent: $("#agent").value });
      await show(thread.id);
      await threads();
    }
    if (!pending || pending.text !== text || pending.thread !== selected)
      pending = { id: crypto.randomUUID(), text, thread: selected };
    let result;
    try {
      result = await api(`/api/threads/${selected}/messages`, {
        request_id: pending.id,
        text,
      });
    } finally {
      await show(selected);
      await threads();
    }
    if (result.state === "running")
      throw new Error(
        "This answer is still running. Refresh saved state; sending again uses the same request ID.",
      );
    if (result.state !== "completed") {
      pending = null;
      throw new Error(
        `Saved run is ${result.state}. It was not replayed. A new send is a new model request.`,
      );
    }
    pending = null;
    $("#message").value = "";
    $("#message").focus();
  });
});
$("#memory-form").addEventListener("submit", (event) => {
  event.preventDefault();
  run(async () => {
    await api("/api/memories", {
      content: $("#memory-text").value,
      reviewed: $("#reviewed").checked,
    });
    $("#memory-form").reset();
    await memories();
    $("#memory-text").focus();
  });
});
$("#delete-thread").addEventListener("click", () =>
  run(async () => {
    if (!selected) return;
    await api(`/api/threads/${selected}`, {}, "DELETE");
    selected = null;
    pending = null;
    $("#delete-thread").hidden = true;
    $("#messages").replaceChildren();
    $("#thread-state").textContent = "";
    $("#thread-title").textContent = "How can I help?";
    await threads();
  }, $("#new-thread")),
);
api("/api/session")
  .then(enter)
  .catch((error) => {
    if (!error.message.includes("Start a private"))
      $("#status").textContent = error.message;
  });
