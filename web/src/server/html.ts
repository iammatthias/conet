import { type Heard, type StationMinted } from "./abi";
import { formatCursor, type Cursor } from "./paging";
import { fiveFigureGroups } from "../numbers";

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function factoryFragment(
  stations: StationMinted[],
  cursor: Cursor,
  head: bigint,
  highestStationId?: bigint,
  explorerUrl?: string,
): string {
  const items = stations.map((station) => {
    const address = escapeHtml(station.station);
    return `<span data-known-frequency data-station-id="${station.stationId}" data-tune-station="${address}"></span>`;
  }).join("");
  const total = highestStationId === undefined ? "" : ` data-station-total="${highestStationId}"`;
  const explorer = explorerUrl === undefined ? "" : ` data-explorer="${escapeHtml(explorerUrl)}"`;
  return `${items}<span hidden data-station-cursor="${escapeHtml(formatCursor(cursor))}" data-chain-head="${head}"${total}${explorer}></span>`;
}

export function transmissionFragment(
  transmissions: Heard[],
  station: string,
  stationId: string,
  cursor: Cursor,
  head: bigint,
  explorerUrl?: string,
): string {
  const explorerLink = (path: string, label: string, aria: string, className: string) =>
    explorerUrl
      ? `<a class="${className}" href="${escapeHtml(explorerUrl)}/${path}" target="_blank" rel="noreferrer noopener" aria-label="${aria}">${label}</a>`
      : label;
  const safeStation = escapeHtml(station);
  const safeStationId = escapeHtml(stationId);
  const entries = transmissions.map((event) => {
    const cipher = escapeHtml(event.cipher);
    const groups = fiveFigureGroups(event.cipher);
    const sequence = event.seq.toString().padStart(6, "0");
    const writer = escapeHtml(event.writer);
    const blockLink = explorerLink(`block/${event.blockNumber}`, String(event.blockNumber), `Block ${event.blockNumber} on the block explorer`, "chain-link");
    const transactionLink = event.transactionHash
      ? ` ${explorerLink(`tx/${escapeHtml(event.transactionHash)}`, "tx", `Transaction for sequence ${event.seq} on the block explorer`, "chain-link meta")}`
      : "";
    const writerLink = ` ${explorerLink(`address/${writer}`, `from ${escapeHtml(shortAddress(event.writer))}`, `Writer ${writer} of sequence ${event.seq} on the block explorer`, "chain-link meta")}`;
    return `<span data-transmission data-station="${safeStation}" data-station-id="${safeStationId}" data-seq="${event.seq}" data-block="${event.blockNumber}" data-nonce="${event.nonce.toString(16).padStart(16, "0")}" data-kind="${event.kind}" data-byte-count="${event.cipher.length / 2}" data-group-count="${groups.length}" data-cipher="${cipher}">` +
      `<b class="seq">${sequence}</b> ${blockLink}${transactionLink}${writerLink} ` +
      `<span class="groups">${groups.join(" ")}</span> ` +
      `</span>`;
  }).join("");
  return `${entries}<span hidden data-transmission-cursor="${escapeHtml(formatCursor(cursor))}" data-chain-head="${head}"></span>`;
}
