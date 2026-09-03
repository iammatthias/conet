type Transmission = {
  station: string;
  stationId: string;
  seq: bigint;
  block: number;
  nonce: string;
  kind: number;
  cipher: string;
  byteCount: number;
};

type KnownFrequency = {
  stationId: string;
  station: string;
};

export interface ReceiverOptions {
  origin: string;
  explorerUrl?: string;
  station?: string;
}

export interface Receiver {
  tune(station: string): void;
  destroy(): void;
}

const MAX_DOM_TRANSMISSIONS = 80;
const DIAL_MARK_LIMIT = 64;
const FACTORY_PAGE_SIZE = 1_000;
const EXPLORER_ORIGIN = /^https:\/\/[a-z0-9.-]+(?:\/[\w./-]*)?$/i;

class FragmentError extends Error {
  constructor(readonly status: number) {
    super(`fragment request failed with ${status}`);
  }
}

export function mountReceiver(root: ParentNode, options: ReceiverOptions): Receiver {
  const element = <T extends HTMLElement>(id: string): T => {
    const found = root.querySelector<T>(`#${id}`);
    if (!found) throw new Error(`Missing #${id}`);
    return found;
  };

  const frequencyDial = element<HTMLInputElement>("frequency-dial");
  const frequencyMarks = element<HTMLDataListElement>("frequency-marks");
  const frequencyReadout = element<HTMLOutputElement>("frequency-readout");
  const frequencyAddress = element<HTMLElement>("frequency-address");
  const stationInput = root.querySelector<HTMLInputElement>("#station-address") ?? undefined;
  const tuneForm = root.querySelector<HTMLFormElement>("#tune-form") ?? undefined;
  const receiverState = element<HTMLOutputElement>("receiver-state");
  const stationPanel = element<HTMLDivElement>("station-panel");
  const transmissionBody = element<HTMLTableSectionElement>("transmissions");
  const transmissionStaging = element<HTMLTableSectionElement>("transmission-staging");
  const transmissionLog = element<HTMLElement>("transmission-log");
  const transmissionCount = element<HTMLOutputElement>("transmission-count");
  const stationList = element<HTMLDivElement>("station-list");
  const replayForm = element<HTMLFormElement>("replay-form");
  const blockScrubber = element<HTMLInputElement>("block-scrubber");
  const blockAnchor = element<HTMLInputElement>("block-anchor");
  const blockPosition = element<HTMLOutputElement>("block-position");
  const replayFromBlock = element<HTMLButtonElement>("replay-from-block");
  const returnLive = element<HTMLButtonElement>("return-live");

  let explorerUrl = options.explorerUrl;
  let tunedStation = "";
  let baselineEstablished = false;
  let highestSeenSequence = 0n;
  let latestTransmission: Transmission | undefined;
  const knownFrequencyMap = new Map<string, KnownFrequency>();
  let factoryCaughtUp = false;
  let highestStationId = 0;
  let transmissionAbort: AbortController | undefined;
  let factoryAbort: AbortController | undefined;
  let transmissionCursor = "";
  let pollTimer: number | undefined;
  let requestMode: "catchup" | "live" | "replay" = "catchup";
  let replayAnchor = 0;
  let receiverEpoch = 0;
  let factoryCursor = "";
  let factoryPollTimer: number | undefined;
  let factoryRequestActive = false;
  let receiverSuspended = false;
  let dialPointerActive = false;
  let pendingDialRefresh = false;
  let pendingDialAddress: string | undefined;
  let dialRefreshTimer: number | undefined;

  if (stationInput && tuneForm) {
    stationInput.addEventListener("focus", () => stationInput.select());
    tuneForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const station = normaliseAddress(stationInput.value);
      if (!station) {
        setReceiverState("Enter a valid Station address", "error");
        stationInput.focus();
        return;
      }
      tune(station);
    });
  }

  frequencyDial.addEventListener("input", updateFrequencyReadout);
  frequencyDial.addEventListener("change", commitDialTune);
  frequencyDial.addEventListener("pointerdown", () => {
    dialPointerActive = true;
  });

  blockScrubber.addEventListener("input", () => {
    blockAnchor.value = blockScrubber.value;
    blockPosition.value = `Block ${blockScrubber.value}`;
  });

  blockAnchor.addEventListener("input", () => {
    const block = Number.parseInt(blockAnchor.value, 10);
    if (!Number.isSafeInteger(block)) return;
    const minimum = Number.parseInt(blockScrubber.min, 10);
    const maximum = Number.parseInt(blockScrubber.max, 10);
    if (block >= minimum && block <= maximum) blockScrubber.value = String(block);
    blockPosition.value = `Block ${blockAnchor.value || "—"}`;
  });

  replayForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!tunedStation || blockScrubber.disabled) return;
    const block = Number.parseInt(blockAnchor.value, 10);
    if (!Number.isSafeInteger(block) || block < 0) return;
    replayFrom(block);
  });

  returnLive.addEventListener("click", () => {
    if (tunedStation) tune(tunedStation);
  });

  const onPageShow = (event: Event) => {
    if (!(event as PageTransitionEvent).persisted) return;
    receiverSuspended = false;
    requestKnownFrequencies();
    if (tunedStation) tune(tunedStation);
  };
  window.addEventListener("pointerup", finishDialInteraction);
  window.addEventListener("pointercancel", finishDialInteraction);
  window.addEventListener("pagehide", suspendReceiver);
  window.addEventListener("pageshow", onPageShow);

  requestKnownFrequencies();
  const initial = options.station ? normaliseAddress(options.station) : undefined;
  if (initial) tune(initial);

  return {
    tune,
    destroy() {
      suspendReceiver();
      window.removeEventListener("pointerup", finishDialInteraction);
      window.removeEventListener("pointercancel", finishDialInteraction);
      window.removeEventListener("pagehide", suspendReceiver);
      window.removeEventListener("pageshow", onPageShow);
    },
  };

  async function fragment(path: string, signal: AbortSignal): Promise<string> {
    const response = await fetch(`${options.origin}${path}`, { signal, headers: { accept: "text/html" } });
    if (!response.ok) throw new FragmentError(response.status);
    return response.text();
  }

  function tune(station: string): void {
    abortTransmissionRequest();
    receiverEpoch += 1;
    tunedStation = station;
    baselineEstablished = false;
    highestSeenSequence = 0n;
    latestTransmission = undefined;
    transmissionCursor = "";
    requestMode = "catchup";
    if (pollTimer !== undefined) window.clearTimeout(pollTimer);
    pollTimer = undefined;
    if (stationInput) stationInput.value = station;
    stationPanel.hidden = false;
    transmissionStaging.replaceChildren();
    if (transmissionBody.querySelector("tr[data-transmission]")) setLogBusy(true);
    else showTransmissionPlaceholder("Tuning…");
    transmissionCount.value = "…";
    blockScrubber.disabled = true;
    blockAnchor.disabled = true;
    replayFromBlock.disabled = true;
    returnLive.disabled = true;
    blockPosition.value = "Block —";
    setReceiverState("Tuning…");
    updateFrequencyDial();
    requestTransmissions();
  }

  function ingestKnownFrequencies(): void {
    const selectedAddress = selectedFrequency()?.station.toLowerCase();
    for (const marker of stationList.querySelectorAll<HTMLElement>("[data-known-frequency]")) {
      const station = normaliseAddress(marker.dataset.tuneStation ?? "");
      const stationId = marker.dataset.stationId ?? "";
      if (!station || !/^[1-9]\d*$/.test(stationId)) continue;
      knownFrequencyMap.set(station.toLowerCase(), { station, stationId });
    }

    const cursorMarker = stationList.querySelector<HTMLElement>("[data-station-cursor]");
    const explorer = cursorMarker?.dataset.explorer;
    if (explorer && EXPLORER_ORIGIN.test(explorer)) explorerUrl = explorer;
    const total = cursorMarker?.dataset.stationTotal;
    if (total && /^\d+$/.test(total)) highestStationId = Math.max(highestStationId, Number(total));
    const cursor = cursorMarker?.dataset.stationCursor;
    const head = cursorMarker?.dataset.chainHead;
    if (cursor && head && /^\d+:-?\d+$/.test(cursor) && /^\d+$/.test(head)) {
      factoryCursor = cursor;
      const cursorBlock = BigInt(cursor.split(":", 1)[0]);
      const chainHead = BigInt(head);
      factoryCaughtUp = cursorBlock > chainHead;
      scheduleFactoryScan(factoryCaughtUp ? 12_000 : 0);
    } else {
      scheduleFactoryScan(4_000);
    }
    updateFrequencyDial(selectedAddress);
  }

  function requestKnownFrequencies(): void {
    if (receiverSuspended || factoryRequestActive) return;
    if (factoryPollTimer !== undefined) window.clearTimeout(factoryPollTimer);
    factoryPollTimer = undefined;
    factoryRequestActive = true;
    factoryAbort = new AbortController();
    const cursor = factoryCursor ? `&cursor=${encodeURIComponent(factoryCursor)}` : "";
    fragment(`/_tuner/factory/stations?limit=${FACTORY_PAGE_SIZE}${cursor}`, factoryAbort.signal)
      .then((html) => {
        stationList.innerHTML = html;
        ingestKnownFrequencies();
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        frequencyReadout.value = "Factory signal unavailable · retrying";
        scheduleFactoryScan(4_000);
      })
      .finally(() => {
        factoryRequestActive = false;
      });
  }

  function scheduleFactoryScan(delay: number): void {
    if (receiverSuspended) return;
    if (factoryPollTimer !== undefined) window.clearTimeout(factoryPollTimer);
    factoryPollTimer = window.setTimeout(requestKnownFrequencies, delay);
  }

  function sortedFrequencies(): KnownFrequency[] {
    return Array.from(knownFrequencyMap.values()).sort((a, b) => {
      const left = BigInt(a.stationId);
      const right = BigInt(b.stationId);
      return left < right ? -1 : left > right ? 1 : 0;
    });
  }

  function updateFrequencyDial(preferredAddress?: string): void {
    if (!factoryCaughtUp && knownFrequencyMap.size === 0) {
      frequencyDial.disabled = true;
      if (!tunedStation) {
        frequencyReadout.value = "Scanning factory events…";
        frequencyAddress.textContent = "No Station selected";
      }
      return;
    }
    if (dialPointerActive) {
      pendingDialRefresh = true;
      pendingDialAddress = selectedFrequency()?.station.toLowerCase() || preferredAddress;
      return;
    }

    const frequencies = sortedFrequencies();
    const identity = preferredAddress || tunedStation.toLowerCase();
    const selected = identity
      ? frequencies.find((frequency) => frequency.station.toLowerCase() === identity)
      : undefined;

    const highestKnown = frequencies.reduce(
      (highest, frequency) => Math.max(highest, Number(frequency.stationId)),
      0,
    );
    const span = Math.max(highestStationId, highestKnown);

    const stride = Math.ceil(frequencies.length / DIAL_MARK_LIMIT);
    const marks: HTMLOptionElement[] = [];
    for (let index = 0; index < frequencies.length; index += stride) {
      const option = document.createElement("option");
      option.value = String(frequencies[index].stationId);
      option.label = `Station ${frequencies[index].stationId}`;
      marks.push(option);
    }
    frequencyMarks.replaceChildren(...marks);
    frequencyDial.min = "0";
    frequencyDial.max = String(span);
    frequencyDial.disabled = span === 0;
    frequencyDial.value = selected ? String(selected.stationId) : frequencyDial.value || "0";
    updateFrequencyReadout();
  }

  function finishDialInteraction(): void {
    if (!dialPointerActive) return;
    dialPointerActive = false;
    if (!pendingDialRefresh) return;
    const preferredAddress = pendingDialAddress;
    pendingDialRefresh = false;
    pendingDialAddress = undefined;
    if (dialRefreshTimer !== undefined) window.clearTimeout(dialRefreshTimer);
    dialRefreshTimer = window.setTimeout(() => {
      dialRefreshTimer = undefined;
      updateFrequencyDial(preferredAddress);
    }, 0);
  }

  function selectedFrequency(): KnownFrequency | undefined {
    const stationId = Number.parseInt(frequencyDial.value, 10);
    if (!Number.isSafeInteger(stationId) || stationId < 1) return undefined;
    return sortedFrequencies().find((frequency) => Number(frequency.stationId) === stationId);
  }

  function renderStationAddress(station: string): void {
    if (!explorerUrl) {
      frequencyAddress.textContent = station;
      return;
    }
    const link = document.createElement("a");
    link.className = "chain-link";
    link.href = `${explorerUrl}/address/${station}`;
    link.target = "_blank";
    link.rel = "noreferrer noopener";
    link.textContent = station;
    frequencyAddress.replaceChildren(link);
  }

  function updateFrequencyReadout(): void {
    const frequency = selectedFrequency();
    if (frequency) {
      frequencyReadout.value = `Station ${frequency.stationId}`;
      renderStationAddress(frequency.station);
      return;
    }
    const dialled = Number.parseInt(frequencyDial.value, 10);
    if (Number.isSafeInteger(dialled) && dialled >= 1 && !factoryCaughtUp) {
      frequencyReadout.value = `Station ${dialled} · not yet received`;
      frequencyAddress.textContent = "No Station selected";
      return;
    }
    frequencyReadout.value = knownFrequencyMap.size === 0
      ? factoryCaughtUp ? "No frequencies issued" : "Scanning factory events…"
      : factoryCaughtUp ? "Off band" : `Off band · ${knownFrequencyMap.size} found`;
    frequencyAddress.textContent = "No Station selected";
  }

  function commitDialTune(): void {
    const frequency = selectedFrequency();
    cancelPendingDialRefresh();
    if (!frequency) {
      leaveBand();
      return;
    }
    if (stationInput) stationInput.value = frequency.station;
    if (frequency.station.toLowerCase() === tunedStation.toLowerCase()) return;
    tune(frequency.station);
  }

  function leaveBand(): void {
    receiverEpoch += 1;
    abortTransmissionRequest();
    if (pollTimer !== undefined) window.clearTimeout(pollTimer);
    pollTimer = undefined;

    tunedStation = "";
    baselineEstablished = false;
    highestSeenSequence = 0n;
    latestTransmission = undefined;
    replayAnchor = 0;
    transmissionCursor = "";
    requestMode = "catchup";

    if (stationInput) stationInput.value = "";
    stationPanel.hidden = true;
    transmissionStaging.replaceChildren();
    setLogBusy(false);
    transmissionCount.value = "0";
    showTransmissionPlaceholder("Choose a frequency or enter a Station address.");

    blockScrubber.min = "0";
    blockScrubber.max = "0";
    blockScrubber.value = "0";
    blockScrubber.disabled = true;
    blockAnchor.min = "0";
    blockAnchor.removeAttribute("max");
    blockAnchor.value = "0";
    blockAnchor.disabled = true;
    replayFromBlock.disabled = true;
    returnLive.disabled = true;
    blockPosition.value = "Block —";

    setReceiverState("Not tuned");
    updateFrequencyReadout();
  }

  function cancelPendingDialRefresh(): void {
    pendingDialRefresh = false;
    pendingDialAddress = undefined;
    if (dialRefreshTimer !== undefined) window.clearTimeout(dialRefreshTimer);
    dialRefreshTimer = undefined;
  }

  function showTransmissionPlaceholder(message: string): void {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 3;
    cell.textContent = message;
    row.append(cell);
    transmissionBody.replaceChildren(row);
  }

  function ingestTransmissionRows(target: HTMLTableSectionElement, html: string, replace: boolean): void {
    const template = document.createElement("template");
    template.innerHTML = html;
    const cursorMarker = Array.from(
      template.content.querySelectorAll<HTMLTableRowElement>("tr[data-transmission-cursor]"),
    ).at(-1);
    const cursor = cursorMarker?.dataset.transmissionCursor;
    const chainHead = cursorMarker?.dataset.chainHead;
    const scanFloor = cursorMarker?.dataset.scanFloor;

    if (requestMode !== "replay" && cursor) transmissionCursor = cursor;

    const incoming = Array.from(template.content.querySelectorAll<HTMLTableRowElement>("tr[data-transmission]"))
      .map((row) => ({ row, item: readTransmission(row) }))
      .filter((entry): entry is { row: HTMLTableRowElement; item: Transmission } => entry.item !== undefined)
      .sort((a, b) => bySequence(a.item, b.item));

    if (replace) target.replaceChildren();
    else if (incoming.length > 0 && !target.querySelector("tr[data-transmission]")) target.replaceChildren();
    const shown = new Map(
      Array.from(target.querySelectorAll<HTMLTableRowElement>("tr[data-transmission]")).map((row) => [row.dataset.seq ?? "", row] as const),
    );
    const fresh: { row: HTMLTableRowElement; item: Transmission }[] = [];
    for (const entry of incoming) {
      const seq = entry.item.seq.toString();
      if (shown.has(seq)) continue;
      const successor = Array.from(target.querySelectorAll<HTMLTableRowElement>("tr[data-transmission]"))
        .find((row) => BigInt(row.dataset.seq ?? "0") > entry.item.seq);
      if (successor) target.insertBefore(entry.row, successor);
      else target.append(entry.row);
      shown.set(seq, entry.row);
      fresh.push(entry);
    }
    while (target.querySelectorAll("tr[data-transmission]").length > MAX_DOM_TRANSMISSIONS) {
      target.querySelector("tr[data-transmission]")?.remove();
    }

    const parsed = Array.from(target.querySelectorAll<HTMLTableRowElement>("tr[data-transmission]"))
      .map(readTransmission)
      .filter((item): item is Transmission => item !== undefined)
      .sort(bySequence);
    latestTransmission = parsed.at(-1);

    const head = chainHead && /^\d+$/.test(chainHead) ? Number.parseInt(chainHead, 10) : undefined;
    const floor = scanFloor && /^\d+$/.test(scanFloor) ? Number.parseInt(scanFloor, 10) : undefined;
    if (head !== undefined && floor !== undefined && Number.isSafeInteger(head) && Number.isSafeInteger(floor)) {
      blockScrubber.min = String(floor);
      blockScrubber.max = String(head);
      blockAnchor.min = String(floor);
      blockAnchor.max = String(head);
      if (requestMode !== "replay") {
        blockScrubber.value = String(head);
        blockAnchor.value = String(head);
        blockPosition.value = `Block ${head}`;
      }
    }

    if (requestMode === "replay") {
      if (parsed.length === 0 && cursor && head !== undefined) {
        const nextBlock = Number.parseInt(cursor.split(":", 1)[0], 10);
        if (Number.isSafeInteger(nextBlock) && nextBlock <= head) {
          requestReplayPage(cursor);
          return;
        }
      }
      if (parsed.length === 0) showTransmissionPlaceholder(`No transmission at or after block ${replayAnchor}`);
      transmissionCount.value = String(parsed.length);
      setLogBusy(false);
      setReceiverState(
        parsed.length > 0
          ? `Replay · block ${replayAnchor} · seq ${parsed[0].seq}`
          : `No transmission at or after block ${replayAnchor}`,
        "ready",
      );
      return;
    }

    if (!baselineEstablished) {
      const cursorBlock = cursor ? BigInt(cursor.split(":", 1)[0]) : 0n;
      const headBigInt = chainHead && /^\d+$/.test(chainHead) ? BigInt(chainHead) : undefined;
      const caughtUp = headBigInt !== undefined && cursorBlock > headBigInt;
      if (!caughtUp) {
        setReceiverState(`Tuning · scanned through seq ${latestTransmission?.seq ?? 0n}`);
        schedulePoll(0);
        return;
      }
      baselineEstablished = true;
      highestSeenSequence = latestTransmission?.seq ?? 0n;
      presentStagedRows();
      blockScrubber.disabled = false;
      blockAnchor.disabled = false;
      replayFromBlock.disabled = false;
      setReceiverState(latestTransmission ? "Tuned" : "Tuned · carrier quiet", "ready");
      schedulePoll(4_000);
      return;
    }

    for (const entry of fresh) {
      if (entry.item.seq > highestSeenSequence) entry.row.classList.add("arrived");
    }
    if (latestTransmission && latestTransmission.seq > highestSeenSequence) {
      highestSeenSequence = latestTransmission.seq;
      setReceiverState("Tuned", "ready");
    }
    transmissionCount.value = String(parsed.length);
    schedulePoll(4_000);
  }

  function presentStagedRows(): void {
    const staged = Array.from(transmissionStaging.querySelectorAll<HTMLTableRowElement>("tr[data-transmission]"));
    if (staged.length > 0) transmissionBody.replaceChildren(...staged);
    else showTransmissionPlaceholder("Carrier quiet");
    transmissionStaging.replaceChildren();
    transmissionCount.value = String(staged.length);
    setLogBusy(false);
  }

  function setLogBusy(busy: boolean): void {
    transmissionLog.setAttribute("aria-busy", String(busy));
  }

  function requestTransmissionPage(path: string, target: HTMLTableSectionElement, replace: boolean): void {
    abortTransmissionRequest();
    const epoch = receiverEpoch;
    const controller = new AbortController();
    transmissionAbort = controller;
    fragment(path, controller.signal)
      .then((html) => {
        if (epoch !== receiverEpoch) return;
        ingestTransmissionRows(target, html, replace);
      })
      .catch((error: unknown) => {
        if (epoch !== receiverEpoch) return;
        if (error instanceof DOMException && error.name === "AbortError") return;
        setLogBusy(false);
        if (error instanceof FragmentError && error.status === 404) {
          showTransmissionPlaceholder("Frequency not found in this factory");
          transmissionCount.value = "0";
          setReceiverState("Frequency not found in this factory", "error");
          return;
        }
        setReceiverState("Carrier unavailable · retrying", "error");
        schedulePoll(4_000);
      })
      .finally(() => {
        if (transmissionAbort === controller) transmissionAbort = undefined;
      });
  }

  function requestTransmissions(): void {
    if (!tunedStation) return;
    requestMode = baselineEstablished ? "live" : "catchup";
    const cursor = transmissionCursor ? `&cursor=${encodeURIComponent(transmissionCursor)}` : "";
    requestTransmissionPage(
      `/_tuner/stations/${encodeURIComponent(tunedStation)}/transmissions?limit=${MAX_DOM_TRANSMISSIONS}${cursor}`,
      baselineEstablished ? transmissionBody : transmissionStaging,
      false,
    );
  }

  function replayFrom(block: number): void {
    if (pollTimer !== undefined) window.clearTimeout(pollTimer);
    pollTimer = undefined;
    abortTransmissionRequest();
    receiverEpoch += 1;
    replayAnchor = block;
    returnLive.disabled = false;
    setLogBusy(true);
    setReceiverState(`Finding transmissions from block ${block}…`);
    requestReplayPage(`${block}:-1`);
  }

  function requestReplayPage(cursor: string): void {
    requestMode = "replay";
    requestTransmissionPage(
      `/_tuner/stations/${encodeURIComponent(tunedStation)}/transmissions?limit=${MAX_DOM_TRANSMISSIONS}&cursor=${encodeURIComponent(cursor)}`,
      transmissionBody,
      true,
    );
  }

  function schedulePoll(delay: number): void {
    if (pollTimer !== undefined) window.clearTimeout(pollTimer);
    pollTimer = window.setTimeout(requestTransmissions, delay);
  }

  function readTransmission(row: HTMLTableRowElement): Transmission | undefined {
    const station = normaliseAddress(row.dataset.station ?? tunedStation);
    const stationId = row.dataset.stationId ?? "";
    const rawSeq = row.dataset.seq ?? "";
    const block = Number.parseInt(row.dataset.block ?? "", 10);
    const nonce = row.dataset.nonce ?? "";
    const kind = Number.parseInt(row.dataset.kind ?? "", 10);
    const cipher = (row.dataset.cipher ?? "").replace(/^0x/i, "");
    const byteCount = cipher.length / 2;
    if (
      !station ||
      !/^[1-9]\d*$/.test(stationId) ||
      !/^[1-9]\d*$/.test(rawSeq) ||
      !Number.isSafeInteger(block) ||
      block < 0 ||
      !/^[0-9a-f]{16}$/.test(nonce) ||
      !Number.isSafeInteger(kind) ||
      kind < 0 ||
      kind > 255 ||
      !/^[0-9a-f]+$/i.test(cipher) ||
      !Number.isSafeInteger(byteCount) ||
      byteCount < 1
    ) return;
    return { station, stationId, seq: BigInt(rawSeq), block, nonce, kind, cipher, byteCount };
  }

  function suspendReceiver(): void {
    receiverSuspended = true;
    dialPointerActive = false;
    cancelPendingDialRefresh();
    receiverEpoch += 1;
    abortTransmissionRequest();
    factoryAbort?.abort();
    factoryAbort = undefined;
    factoryRequestActive = false;
    if (factoryPollTimer !== undefined) window.clearTimeout(factoryPollTimer);
    factoryPollTimer = undefined;
    if (pollTimer !== undefined) window.clearTimeout(pollTimer);
    pollTimer = undefined;
  }

  function abortTransmissionRequest(): void {
    transmissionAbort?.abort();
    transmissionAbort = undefined;
  }

  function setReceiverState(message: string, state?: "ready" | "error"): void {
    receiverState.textContent = message;
    receiverState.dataset.state = state ?? "working";
  }
}

function bySequence(a: Transmission, b: Transmission): number {
  return a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0;
}

function normaliseAddress(value: string): string | undefined {
  const candidate = value.trim();
  return /^0x[0-9a-f]{40}$/i.test(candidate) ? candidate : undefined;
}
