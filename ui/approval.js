// The approval window: the small window the worker opens when a request needs a yes.
// Closing it denies what is waiting (the worker sees the window go).

import { approvalList, el, fill, send, t, useBrowserLanguage, useLanguage, useTheme } from "./shared.js";

const list = document.getElementById("approvals");
let shown = "";

async function refresh() {
  const state = await send({ type: "get_state" });
  if (!state || !Array.isArray(state.approvals)) {
    await useBrowserLanguage();
    fill(list, el("p", { class: "muted", text: t("common.workerDown") }));
    shown = "";
    return;
  }
  useTheme(state.theme);
  const changed = await useLanguage(state.language);
  const key = JSON.stringify(state.approvals);
  if (!changed && key === shown) return;
  shown = key;
  document.getElementById("title").textContent = t("approval.title");
  fill(list,
    ...(state.approvals.length
      ? approvalList(state.approvals, answer)
      : [el("p", { class: "muted", text: t("approval.nothingWaiting") })]),
  );
}

async function answer(id, decision) {
  await send({ type: "answer", id, decision });
  await refresh();
}

void refresh();
setInterval(() => void refresh(), 1000);
