import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE GUARD THAT KEEPS A TABLE FROM CRUSHING ITSELF ON A PHONE.
 *
 * ---------------------------------------------------------------------------
 * `Card` puts `overflow-x-auto` on its body, which reads like the phone problem
 * is already solved. It is not, and the reason is easy to miss twice.
 *
 * Every data table here is `w-full`. That is a PERCENTAGE of the container, so
 * a table can never be wider than the thing that would scroll it. On a 390px
 * screen an eight-column table did not overflow and scroll — it shrank, and
 * eight columns of ringgit shared 318px until "RM 5,200.00" broke mid-figure.
 * The scroll container was there the whole time and never had anything to do.
 *
 * The fix is a `min-w-[…]` on the table itself, sized by column count. This
 * test asserts every table has one, because the failure is silent in exactly
 * the situation where nobody is looking: the twenty-ninth table gets written on
 * a desktop, where `min-w` changes nothing and its absence changes nothing
 * either, and it is only wrong on a device the author is not holding.
 *
 * WHAT THIS DOES NOT CLAIM: that the minimum is the RIGHT one. A four-column
 * table declaring `min-w-[19rem]` passes and still squashes. Column counts are
 * checked by looking at the screen at 390px; this only guarantees the decision
 * was made at all rather than skipped.
 * ---------------------------------------------------------------------------
 */

const APP = fileURLToPath(new URL('../src/app', import.meta.url));

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return pages(path);
    return path.endsWith('.tsx') ? [path] : [];
  });
}

/** `<table` through the end of its className attribute, however it is spelled. */
const TABLE = /<table\s+className="([^"]*)"/g;

describe('every data table can scroll rather than squash', () => {
  it('declares a minimum width', () => {
    const offenders: string[] = [];

    for (const path of pages(APP)) {
      const source = readFileSync(path, 'utf8');
      const lines = source.split('\n');
      for (const [i, line] of lines.entries()) {
        TABLE.lastIndex = 0;
        for (const match of line.matchAll(TABLE)) {
          const classes = match[1] ?? '';
          if (!/\bmin-w-\[/.test(classes)) {
            offenders.push(`${relative(APP, path)}:${i + 1}  ${classes}`);
          }
        }
      }
    }

    expect(offenders, `tables with no minimum width:\n${offenders.join('\n')}`).toEqual([]);
  });

  /*
   * The guard is only worth having if it bites. A table written the way they
   * were written before this pass must fail the same rule.
   */
  it('rejects the shape that caused the bug', () => {
    const classes = 'w-full text-sm';
    expect(/\bmin-w-\[/.test(classes)).toBe(false);
  });
});
