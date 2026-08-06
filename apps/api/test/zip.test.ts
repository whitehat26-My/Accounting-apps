import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildZip } from '../src/archive/zip.js';

/**
 * The archive container.
 *
 * Checked against a reader this code did not write — `unzip -p`, which is on
 * every Unix box and knows nothing about the intentions here. A round trip
 * through a reader written in this file would only prove the writer agrees
 * with itself, and the point of the format is that OTHER software can open it
 * in fifty years.
 */

const WHEN = new Date('2026-08-06T09:30:00Z');

function inTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'emil-zip-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('buildZip', () => {
  const entries = [
    { name: 'README.txt', data: Buffer.from('What each file is.\n', 'utf8') },
    { name: 'journal.csv', data: Buffer.from('Entry,Date\nJE-00001,2026-03-01\n', 'utf8') },
    { name: 'nested/trial-balance.csv', data: Buffer.from('Code,Debit\n1000,100.00\n', 'utf8') },
  ];

  it('is readable by a tool that knows nothing about this codebase', () => {
    inTempDir((dir) => {
      const path = join(dir, 'archive.zip');
      writeFileSync(path, buildZip(entries, WHEN));

      const listing = execFileSync('unzip', ['-Z1', path], { encoding: 'utf8' });
      expect(listing.trim().split('\n').sort()).toEqual([
        'README.txt',
        'journal.csv',
        'nested/trial-balance.csv',
      ]);

      for (const entry of entries) {
        const contents = execFileSync('unzip', ['-p', path, entry.name]);
        expect(contents.equals(entry.data)).toBe(true);
      }
    });
  });

  it('passes the reader’s own CRC check', () => {
    inTempDir((dir) => {
      const path = join(dir, 'archive.zip');
      writeFileSync(path, buildZip(entries, WHEN));
      // `unzip -t` recomputes every CRC-32. A wrong table or a wrong
      // polynomial passes a self-round-trip and fails here.
      const output = execFileSync('unzip', ['-t', path], { encoding: 'utf8' });
      expect(output).toContain('No errors detected');
    });
  });

  it('stores rather than compresses, so the rows survive the container', () => {
    const zip = buildZip(entries, WHEN);
    // The whole argument for store-only: the text is IN there, findable by
    // anything that can read bytes, with nothing to decompress first.
    expect(zip.includes(Buffer.from('JE-00001,2026-03-01'))).toBe(true);
    expect(zip.readUInt16LE(8)).toBe(0); // method 0 in the first local header
  });

  it('is byte-identical when built twice from the same instant', () => {
    // So two copies of a year can be compared with `cmp` and shown to be the
    // same file, rather than differing only in a timestamp.
    expect(buildZip(entries, WHEN).equals(buildZip(entries, WHEN))).toBe(true);
  });

  it('handles an empty file and a non-ASCII name', () => {
    inTempDir((dir) => {
      const path = join(dir, 'odd.zip');
      writeFileSync(
        path,
        buildZip(
          [
            { name: 'empty.txt', data: Buffer.alloc(0) },
            { name: 'senarai-akaun-±.csv', data: Buffer.from('Kod,Nama\n', 'utf8') },
          ],
          WHEN,
        ),
      );
      expect(execFileSync('unzip', ['-t', path], { encoding: 'utf8' })).toContain(
        'No errors detected',
      );
      expect(execFileSync('unzip', ['-p', path, 'empty.txt']).length).toBe(0);
    });
  });

  it('writes a file a reader can extract to disk intact', () => {
    inTempDir((dir) => {
      const path = join(dir, 'archive.zip');
      writeFileSync(path, buildZip(entries, WHEN));
      execFileSync('unzip', ['-q', path, '-d', join(dir, 'out')]);
      expect(readFileSync(join(dir, 'out', 'nested', 'trial-balance.csv'), 'utf8')).toBe(
        'Code,Debit\n1000,100.00\n',
      );
    });
  });
});
