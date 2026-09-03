const HEX_BYTES = /^(?:[0-9a-fA-F]{2})+$/;
const FIVE_FIGURES = /^\d{5}$/;

function cipherHex(value: string): string {
  const normalized = value.replace(/^0x/i, "");
  if (!HEX_BYTES.test(normalized)) throw new Error("ciphertext must contain one or more whole bytes");
  return normalized.toLowerCase();
}

export function fiveFigureGroups(cipher: string): string[] {
  const hex = cipherHex(cipher);
  let value = BigInt(`0x${hex}`);
  if (value === 0n) return ["00000"];
  const groups: string[] = [];
  while (value > 0n) {
    groups.push((value % 100_000n).toString(10).padStart(5, "0"));
    value /= 100_000n;
  }
  groups.reverse();
  return groups;
}

export function cipherFromFiveFigureGroups(groups: readonly string[], byteLength: number): string {
  if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > 2_048) {
    throw new Error("ciphertext byte length must be between 1 and 2048");
  }
  if (groups.length < 1) throw new Error("at least one five-figure group is required");
  if (groups.length > 1 && groups[0] === "00000") throw new Error("leading zero group is not canonical");
  let value = 0n;
  for (const group of groups) {
    if (!FIVE_FIGURES.test(group)) throw new Error("number group must contain exactly five digits");
    const part = Number.parseInt(group, 10);
    if (part > 99_999) throw new Error("number group exceeds base-100000 digit");
    value = value * 100_000n + BigInt(part);
  }
  const hex = value.toString(16);
  if (hex.length > byteLength * 2) throw new Error("number groups overflow the declared byte length");
  const cipher = hex.padStart(byteLength * 2, "0");
  if (fiveFigureGroups(cipher).join(" ") !== groups.join(" ")) {
    throw new Error("number groups are not canonical for the declared byte length");
  }
  return cipher;
}
