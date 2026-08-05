#!/usr/bin/env node
/**
 * Verify an Emil proof pack — with no access to the system that made it.
 *
 *   node verify-proof-pack.mjs march.json
 *   node verify-proof-pack.mjs march.json september.json
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AND HAS NO DEPENDENCIES.
 *
 * A proof is only worth something to someone who does not have to trust you.
 * An accountant, a bank's credit officer, or a grant assessor can run this
 * with a stock Node install, read all ninety lines of it in one sitting, and
 * satisfy themselves — without an account on the shop's system, without this
 * repository, and without taking anybody's word for the algorithm.
 *
 * ONE pack: checks it is internally consistent — its own hash fits its
 * contents, and its anchors chain into one another.
 *
 * TWO packs from the same organisation: the real test. Every anchor present
 * in BOTH must be byte-identical. Accounting history is append-only, so a
 * later pack may contain more anchors — it must never contain a DIFFERENT
 * version of one the earlier pack already recorded. If it does, the audit
 * trail behind it was rewritten between the two dates, and this prints the
 * exact anchor where.
 * ---------------------------------------------------------------------------
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const files = process.argv.slice(2);
if (files.length === 0 || files.length > 2) {
  console.error('usage: verify-proof-pack.mjs <pack.json> [later-pack.json]');
  process.exit(2);
}

/** Keys sorted at every level, so the bytes do not depend on writing order. */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

function load(path) {
  const pack = JSON.parse(readFileSync(path, 'utf8'));
  if (pack.format !== 'emil-proof-pack/1') {
    console.error(`${path}: not an Emil proof pack (format/1)`);
    process.exit(2);
  }
  return pack;
}

let failures = 0;
const fail = (message) => {
  failures++;
  console.log(`  FAIL  ${message}`);
};
const pass = (message) => console.log(`  ok    ${message}`);

for (const path of files) {
  const pack = load(path);
  console.log(`\n${path} — ${pack.organisation.name}, issued ${pack.issuedAt}`);

  const { packHash, ...body } = pack;
  sha256(canonical(body)) === packHash
    ? pass('pack hash fits its contents — the file has not been edited')
    : fail('pack hash does NOT fit its contents — this file was altered after issue');

  // The anchors must chain: each one's `prev` is the one before it.
  let previous = null;
  let chained = true;
  for (const anchor of pack.chain.anchors) {
    if ((anchor.prevAnchorHash ?? null) !== previous) {
      fail(`anchor ${anchor.seq} does not follow anchor ${anchor.seq - 1}`);
      chained = false;
      break;
    }
    previous = anchor.anchorHash;
  }
  if (chained) pass(`${pack.chain.anchors.length} anchors chain cleanly`);

  pack.trialBalance.balanced
    ? pass(`trial balance balances (debits ${pack.trialBalance.totalDebit})`)
    : fail('the trial balance in this pack does NOT balance');
}

if (files.length === 2) {
  const [earlier, later] = files.map(load);
  console.log(`\nComparing ${files[0]} against ${files[1]}`);

  if (earlier.organisation.id !== later.organisation.id) {
    fail('these packs are from different organisations');
  } else {
    const laterBySeq = new Map(later.chain.anchors.map((a) => [a.seq, a]));
    let diverged = null;
    for (const anchor of earlier.chain.anchors) {
      const match = laterBySeq.get(anchor.seq);
      if (match === undefined) {
        diverged = `anchor ${anchor.seq} was in the earlier pack and is GONE from the later one`;
        break;
      }
      if (match.anchorHash !== anchor.anchorHash) {
        diverged = `anchor ${anchor.seq} CHANGED between the two packs — history was rewritten`;
        break;
      }
    }
    diverged === null
      ? pass(`every one of the earlier pack's ${earlier.chain.anchors.length} anchors is unchanged`)
      : fail(diverged);
  }
}

console.log(
  failures === 0
    ? '\nVERIFIED — nothing in these books was rewritten after the fact.'
    : `\nFAILED — ${failures} check(s) did not pass. Do not rely on these figures.`,
);
process.exit(failures === 0 ? 0 : 1);
