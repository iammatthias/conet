export interface ReceiverMarkupOptions {
  tuneByAddress: boolean;
}

const receiverBody = `
    <section
        class="frequency-tuner stack gap-s"
        aria-labelledby="frequency-title"
    >
        <header class="split gap-s">
            <label id="frequency-title" for="frequency-dial"
                >Frequency</label
            >
            <output
                id="frequency-readout"
                for="frequency-dial"
                aria-live="polite"
                >Scanning factory events…</output
            >
        </header>
        <div class="dial-window stack gap-xs">
            <input
                id="frequency-dial"
                type="range"
                min="0"
                max="0"
                value="0"
                step="1"
                list="frequency-marks"
                disabled
            />
            <datalist id="frequency-marks"></datalist>
        </div>
        <div class="split gap-s">
            <code
                id="frequency-address"
                >No Station selected</code
            >
            <output id="receiver-state" aria-live="polite"
                >Not tuned</output
            >
        </div>
    </section>

    <div id="station-list" hidden></div>

    <div id="station-panel" class="stack gap-l" hidden>

        <form id="replay-form" class="replay-tune cluster gap-s">
            <label for="block-anchor">Go to block</label>
            <input
                id="block-scrubber"
                aria-label="Replay start block slider"
                type="range"
                min="0"
                max="0"
                value="0"
                step="1"
                disabled
            />
            <input
                id="block-anchor"
                name="block"
                type="number"
                min="0"
                value="0"
                step="1"
                inputmode="numeric"
                aria-label="Exact replay start block"
                disabled
            />
            <button
                id="replay-from-block"
                class="transport-button"
                type="submit"
                disabled
            >
                Load
            </button>
            <button
                id="return-live"
                class="transport-button"
                type="button"
                disabled
            >
                Live
            </button>
            <output id="block-position" for="block-scrubber" hidden
                >Block —</output
            >
        </form>

        <section
            id="transmission-log"
            class="transmission-log stack gap-s"
            aria-labelledby="transmission-log-title"
            aria-busy="false"
        >
            <header class="split gap-s">
                <h2 id="transmission-log-title">
                    Transmission log
                </h2>
                <output id="transmission-count">0</output>
            </header>
            <p id="transmissions" class="transmission-stream">
                Choose a frequency or enter a Station address.
            </p>
            <div id="transmission-staging" hidden></div>
        </section>
    </div>

`;

const tuneByAddressForm = `
    <form id="tune-form" class="direct-tune stack gap-xs">
        <label for="station-address">Tune by address</label>
        <div class="joined-control cluster gap-xs">
            <input
                id="station-address"
                name="station"
                type="text"
                autocomplete="off"
                autocapitalize="none"
                spellcheck="false"
                data-1p-ignore
                data-lpignore="true"
                data-bwignore
                placeholder="0x0000…0000"
                pattern="0x[0-9a-fA-F]{40}"
                minlength="42"
                maxlength="42"
                required
            />
            <button type="submit">Tune</button>
        </div>
    </form>
`;

export function receiverMarkup(options: ReceiverMarkupOptions = { tuneByAddress: true }): string {
  return `<section class="receiver stack gap-l" aria-label="Receiver">${receiverBody}${options.tuneByAddress ? tuneByAddressForm : ""}</section>`;
}
