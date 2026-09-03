import css from "./style.css?inline";
import { mountReceiver, type Receiver } from "./receiver";
import { receiverMarkup } from "./receiver-markup";

const CONET_ORIGIN = "https://conet.fm";

class ConetTuner extends HTMLElement {
  private receiver?: Receiver;

  connectedCallback(): void {
    if (this.receiver) return;
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${css}</style><main class="receiver-embed">${receiverMarkup({ tuneByAddress: false })}</main>`;
    this.receiver = mountReceiver(root, {
      origin: (this.getAttribute("origin") ?? CONET_ORIGIN).replace(/\/+$/, ""),
    });
  }

  disconnectedCallback(): void {
    this.receiver?.destroy();
    this.receiver = undefined;
  }
}

if (!customElements.get("conet-tuner")) customElements.define("conet-tuner", ConetTuner);
