import { describe, expect, test } from "bun:test";
import {
  cipherFromFiveFigureGroups,
  fiveFigureGroups,
} from "../numbers";

describe("five-figure observer encoding", () => {
  test("preserves leading zero bytes through the authoritative byte count", () => {
    expect(fiveFigureGroups("0000ffff")).toEqual(["65535"]);
    expect(cipherFromFiveFigureGroups(["65535"], 4)).toBe("0000ffff");
    expect(fiveFigureGroups("00000000")).toEqual(["00000"]);
    expect(cipherFromFiveFigureGroups(["00000"], 4)).toBe("00000000");
  });

  test("round trips odd byte counts and uses the full group alphabet", () => {
    const groups = fiveFigureGroups("00ff7f");
    expect(groups).toEqual(["65407"]);
    expect(cipherFromFiveFigureGroups(groups, 3)).toBe("00ff7f");
    expect(cipherFromFiveFigureGroups(["99999"], 3)).toBe("01869f");
  });

  test("round trips the contract maximum", () => {
    const cipher = Array.from({ length: 2_048 }, (_, index) => (index & 0xff).toString(16).padStart(2, "0")).join("");
    const groups = fiveFigureGroups(cipher);
    expect(cipherFromFiveFigureGroups(groups, 2_048)).toBe(cipher);
  });

  test("matches the frozen conet.v0 ciphertext vector", () => {
    expect(fiveFigureGroups("bbd426c5145db56ab32018c9536d3de34312259caeddb9f7")).toEqual([
      "00460", "55467", "29707", "23258", "91446", "08723",
      "04986", "07783", "05245", "51926", "14203", "37655",
    ]);
  });
});
