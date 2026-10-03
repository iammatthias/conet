import "./style.css";
import { mountReceiver } from "./receiver";
import { chainId, receiverSearch, tunerChains } from "./receiver-location";
import { receiverMarkup } from "./receiver-markup";

const main = document.getElementById("receiver");
if (!main) throw new Error("Missing #receiver");
main.innerHTML = receiverMarkup();
const query = new URLSearchParams(window.location.search);
const chains = tunerChains(main.dataset.chains);
const primaryChain = chainId(main.dataset.chain);
const requestedChain = chainId(query.get("chain"));
mountReceiver(document, {
  origin: "",
  explorerUrl: main.dataset.explorer || undefined,
  station: query.get("station") ?? undefined,
  chain: chains.some((chain) => chain.chainId === requestedChain) ? requestedChain : primaryChain,
  chains,
  onPosition(position) {
    const search = receiverSearch(window.location.search, { ...position, primaryChain });
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${search}${window.location.hash}`);
  },
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
