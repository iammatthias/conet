import "./style.css";
import { mountReceiver } from "./receiver";
import { receiverMarkup } from "./receiver-markup";

const main = document.getElementById("receiver");
if (!main) throw new Error("Missing #receiver");
main.innerHTML = receiverMarkup();
mountReceiver(document, {
  origin: "",
  explorerUrl: main.dataset.explorer || undefined,
  station: new URLSearchParams(window.location.search).get("station") ?? undefined,
});

const agentPrompt = document.getElementById("agent-prompt") as HTMLPreElement | null;
const copyAgentPrompt = document.getElementById("copy-agent-prompt") as HTMLButtonElement | null;
if (!agentPrompt || !copyAgentPrompt) throw new Error("Missing hand-off prompt");
agentPrompt.textContent = (agentPrompt.textContent ?? "").replaceAll("{origin}", window.location.origin);
let copyResetTimer: number | undefined;
copyAgentPrompt.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(agentPrompt.textContent ?? "");
    copyAgentPrompt.textContent = "Copied";
  } catch {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(agentPrompt);
    selection?.removeAllRanges();
    selection?.addRange(range);
    copyAgentPrompt.textContent = "Select and copy";
  }
  if (copyResetTimer !== undefined) window.clearTimeout(copyResetTimer);
  copyResetTimer = window.setTimeout(() => {
    copyAgentPrompt.textContent = "Copy";
  }, 2_000);
});
