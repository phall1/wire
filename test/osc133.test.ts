// Data-integrity check for the OSC 133 seed entry. Run with: bun test
// NOT a conformance test — proves the bytes we SERVE are internally correct
// (sequences parse, both ST and BEL forms recorded, D's exit-code variant works).
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const ESC = "\x1b", ST = "\x1b\\", BEL = "\x07";
const OSC133 = /^\x1b\](133);([ABCD])((?:;[^\x07\x1b]*)*)(?:\x1b\\|\x07)$/;

function parse(seq: string) {
  const m = OSC133.exec(seq);
  if (!m) return null;
  return { cmd: m[1], sub: m[2], args: m[3]!.split(";").filter(Boolean), terminator: seq.endsWith(BEL) ? "BEL" : "ST" };
}

const entry = JSON.parse(readFileSync(new URL("../data/terminal-osc/133.json", import.meta.url), "utf8"));
const ext = entry.ext;

test("frame: 7-bit OSC introducer is ESC ]", () => {
  expect(ext.frame.introducer_7bit).toBe(ESC + "]");
});

test("terminator: both ST and BEL recorded (ECMA-48 vs practice)", () => {
  expect(ext.terminator).toBe("ST|BEL");
  expect(ext.terminator_detail.canonical_ST_7bit).toBe(ST);
  expect(ext.terminator_detail.alt_BEL).toBe(BEL);
});

for (const p of ext.params as any[]) {
  test(`subcommand ${p.id}: ST form well-formed`, () => {
    const r = parse(p.byte_sequence_ST);
    expect(r).not.toBeNull();
    expect(r!.cmd).toBe("133");
    expect(r!.sub).toBe(p.id);
    expect(r!.terminator).toBe("ST");
  });
  test(`subcommand ${p.id}: BEL form well-formed`, () => {
    const r = parse(p.byte_sequence_BEL);
    expect(r).not.toBeNull();
    expect(r!.terminator).toBe("BEL");
    expect(r!.sub).toBe(p.id);
  });
}

test("D exit-code variants parse and carry the code", () => {
  const d = (ext.params as any[]).find((p) => p.id === "D");
  const sp = d.subparams[0];
  expect(parse(sp.example_byte_sequence_ST)!.args).toEqual(["0"]);
  expect(parse(sp.example_byte_sequence_nonzero_ST)!.args).toEqual(["1"]);
});

test("canonical full cycle is byte-exact", () => {
  const find = (id: string) => (ext.params as any[]).find((p) => p.id === id);
  const cycle = find("A").byte_sequence_ST + "user@host:~$ " + find("B").byte_sequence_ST + "ls -la " + find("C").byte_sequence_ST + "total 0\n" + find("D").subparams[0].example_byte_sequence_ST;
  const marks = cycle.match(/\x1b\]133;[ABCD](?:;\d+)?\x1b\\/g)!;
  expect(marks.length).toBe(4);
  expect(marks[0]).toBe("\x1b]133;A\x1b\\");
  expect(marks[3]).toBe("\x1b]133;D;0\x1b\\");
});
