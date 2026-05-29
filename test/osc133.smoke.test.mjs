// osc133.smoke.test.mjs — DATA-INTEGRITY check for the OSC 133 seed entry.
// Runs in plain Node, no terminal required:  node --test test/osc133.smoke.test.mjs
//
// This is NOT a conformance test. We are a reference, not a conformance harness:
// we do not drive a real terminal and assert its behavior. This only proves the
// bytes we SERVE are internally correct — the stored sequences are syntactically
// well-formed OSC 133 strings, both terminator forms (ST and BEL) are recorded
// (the ECMA-48-vs-practice divergence), and D's exit-code variant parses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ESC = '\x1b', ST = '\x1b\\', BEL = '\x07';
// OSC 133 ; <A|B|C|D> [ ; args ] <ST|BEL>
const OSC133 = /^\x1b\](133);([ABCD])((?:;[^\x07\x1b]*)*)(?:\x1b\\|\x07)$/;

function parseOsc133(seq) {
  const m = OSC133.exec(seq);
  if (!m) return null;
  const termsBEL = seq.endsWith(BEL);
  return { cmd: m[1], sub: m[2], args: m[3].split(';').filter(Boolean), terminator: termsBEL ? 'BEL' : 'ST' };
}

const entryPath = new URL('../data/terminal-osc/133.json', import.meta.url);
const entry = JSON.parse(readFileSync(entryPath, 'utf8'));
const ext = entry.ext;

test('frame: 7-bit OSC introducer is ESC ]', () => {
  assert.equal(ext.frame.introducer_7bit, ESC + ']');
});

test('terminator: both ST and BEL recorded (ECMA-48 vs practice)', () => {
  assert.equal(ext.terminator, 'ST|BEL');
  assert.equal(ext.terminator_detail.canonical_ST_7bit, ST);
  assert.equal(ext.terminator_detail.alt_BEL, BEL);
});

for (const p of ext.params) {
  test(`subcommand ${p.id}: ST form is well-formed`, () => {
    const r = parseOsc133(p.byte_sequence_ST);
    assert.ok(r, `unparseable: ${JSON.stringify(p.byte_sequence_ST)}`);
    assert.equal(r.cmd, '133');
    assert.equal(r.sub, p.id);
    assert.equal(r.terminator, 'ST');
  });
  test(`subcommand ${p.id}: BEL form is well-formed`, () => {
    const r = parseOsc133(p.byte_sequence_BEL);
    assert.ok(r);
    assert.equal(r.terminator, 'BEL');
    assert.equal(r.sub, p.id);
  });
}

test('D exit-code variants parse and carry the code', () => {
  const d = ext.params.find(p => p.id === 'D');
  const sp = d.subparams[0];
  const ok = parseOsc133(sp.example_byte_sequence_ST);
  const err = parseOsc133(sp.example_byte_sequence_nonzero_ST);
  assert.deepEqual(ok.args, ['0']);
  assert.deepEqual(err.args, ['1']);
});

test('canonical full cycle is byte-exact', () => {
  const cycle = ext.params.find(p => p.id === 'A').byte_sequence_ST
    + 'user@host:~$ '
    + ext.params.find(p => p.id === 'B').byte_sequence_ST
    + 'ls -la '
    + ext.params.find(p => p.id === 'C').byte_sequence_ST
    + 'total 0\n'
    + ext.params.find(p => p.id === 'D').subparams[0].example_byte_sequence_ST;
  const marks = cycle.match(/\x1b\]133;[ABCD](?:;\d+)?\x1b\\/g);
  assert.equal(marks.length, 4);
  assert.equal(marks[0], '\x1b]133;A\x1b\\');
  assert.equal(marks[3], '\x1b]133;D;0\x1b\\');
});
