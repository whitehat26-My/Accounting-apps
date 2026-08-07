import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE GUARD THAT KEEPS ONE CARD FROM STAYING WHITE AT MIDNIGHT.
 *
 * ---------------------------------------------------------------------------
 * Night mode here is not a `dark:` variant beside each colour — it is a set of
 * SEMANTIC TOKENS (`bg-surface`, `text-ink-muted`, `ring-line`) whose values
 * are declared twice in `globals.css`. That design has exactly one failure
 * mode, and it is not subtle: somebody adds a screen, writes `bg-white` out of
 * habit, and that one card blazes on an otherwise dark page. Nobody notices,
 * because whoever wrote it was working in daylight.
 *
 * 664 utilities were converted by machine and the rest by hand. Eyeballing 29
 * files again on every future change is exactly the review that does not
 * happen, so the rule is enforced here instead — the same discipline as the
 * OpenAPI conformance test and the RLS invariant sweep.
 *
 * WHAT THIS DOES NOT CLAIM: it checks that colours are NAMED semantically, not
 * that the result is legible. A token can still be the wrong token — a
 * `text-ink` on a `bg-ink` passes this test and is invisible. Contrast is
 * checked by looking at both themes, and this test is not a substitute for
 * that; it only guarantees there is nothing left that CANNOT respond to the
 * theme at all.
 * ---------------------------------------------------------------------------
 */

const SRC = fileURLToPath(new URL('../src', import.meta.url));

/** Tailwind's stock palette — every family that ships with a numeric scale. */
const FAMILIES = [
  'slate', 'gray', 'zinc', 'neutral', 'stone',
  'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal',
  'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose',
].join('|');

/** Every utility that takes a colour. */
const PROPERTIES =
  'bg|text|border|ring|fill|stroke|from|via|to|divide|placeholder|outline|accent|shadow|caret|decoration';

/*
 * `(?<![A-Za-z0-9_-])` is not decoration — it is the whole reason this matches
 * what it means to. The string "translate" CONTAINS the letters "slate", so a
 * naive substring search flags `-translate-y-1/2` on sight. Anchoring to a
 * class boundary and requiring the full `<property>-<family>-<number>` shape
 * is what tells a utility apart from a word that happens to contain one.
 */
const PALETTE = new RegExp(
  `(?<![A-Za-z0-9_-])(?:${PROPERTIES})-(?:${FAMILIES})-[0-9]{2,3}(?:/[0-9]{1,3})?(?![A-Za-z0-9_-])`,
  'g',
);

/**
 * `bg-white`, `text-black`, and their alpha forms.
 *
 * `shadow` is deliberately absent from this list. A drop shadow is cast by
 * light and is black in every theme there is — `shadow-black/40` is correct on
 * a dark page and on a light one, and flagging it would train whoever reads
 * this failure to suppress the test rather than to fix a screen. It stays in
 * the palette check above, because `shadow-emerald-500/30` genuinely was a
 * themed colour hiding in a shadow.
 */
const ABSOLUTE = new RegExp(
  `(?<![A-Za-z0-9_-])(?:${PROPERTIES.replace('|shadow', '')})-(?:white|black)(?:/[0-9]{1,3})?(?![A-Za-z0-9_-])`,
  'g',
);

/** Raw hex, which is how the charts became a light-mode island the first time. */
const HEX = /(?<![A-Za-z0-9_-])#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})(?![0-9a-fA-F])/g;

/**
 * The exemptions, each with the reason it is one.
 *
 * Deliberately keyed by FILE AND TOKEN rather than by file alone: exempting a
 * whole file would let the next `bg-white` in it through unnoticed, which is
 * the failure this test exists to prevent.
 *
 * There is exactly one exemption, and it is not a surface the theme owns.
 */
const ALLOWED: { file: string; tokens: string[]; because: string }[] = [
  {
    file: 'components/repair-photos.tsx',
    tokens: ['from-black/70', 'text-white/80', 'text-white', 'bg-black/55', 'text-white/70'],
    because:
      'These sit on the technician’s PHOTOGRAPH, not on a themed surface. A token ' +
      'would follow the page and leave the caption unreadable over half the photos ' +
      'in the shop; a black scrim under white text is legible over every one of them.',
  },
  {
    file: 'components/signature-pad.tsx',
    tokens: ['#ffffff', '#0f172a'],
    because:
      'The canvas is exported as a PNG, stored as evidence, and printed into the ' +
      'intake slip and the repair report. Themed strokes would capture a signature ' +
      'as white-on-dark at night — invisible on the white page it ends up on, which ' +
      'is the only place it matters. The pad is a slip of paper, so it is drawn as one.',
  },
  {
    file: 'app/(app)/settings/page.tsx',
    tokens: ['#1875be'],
    because:
      'Not a UI colour: it is the DEFAULT VALUE of the tenant’s own letterhead brand ' +
      'colour, stored per-organisation and rendered into their PDFs. It describes ' +
      'their paper, not this app’s screen, and it must not follow the reader’s theme.',
  },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(tsx?|css)$/.test(full)) out.push(full);
  }
  return out;
}

interface Stray {
  file: string;
  line: number;
  token: string;
  text: string;
}

function scan(pattern: RegExp): Stray[] {
  const strays: Stray[] = [];
  for (const full of walk(SRC)) {
    const file = relative(SRC, full).replaceAll('\\', '/');
    const exempt = ALLOWED.find((a) => a.file === file);
    readFileSync(full, 'utf8').split('\n').forEach((text, i) => {
      for (const match of text.matchAll(pattern)) {
        const token = match[0];
        if (exempt?.tokens.includes(token)) continue;
        strays.push({ file, line: i + 1, token, text: text.trim() });
      }
    });
  }
  return strays;
}

/** A failure has to say what to do about it, or it gets suppressed instead of fixed. */
const report = (strays: Stray[], advice: string) =>
  strays.length === 0
    ? ''
    : `\n${advice}\n\n` +
      strays.map((s) => `  ${s.file}:${s.line}  ${s.token}\n      ${s.text}`).join('\n');

describe('the palette is semantic, so night mode cannot miss a screen', () => {
  it('has no stock Tailwind palette colours left in apps/web/src', () => {
    const strays = scan(PALETTE);
    expect(
      strays,
      report(
        strays,
        'A raw palette colour cannot change with the theme, so this is a screen that ' +
          'stays light at midnight. Use the role instead:\n' +
          '  slate text  -> text-ink / text-ink-muted / text-ink-faint\n' +
          '  slate fills -> bg-surface / bg-surface-raised / bg-surface-sunken\n' +
          '  slate lines -> border-line / ring-line / border-line-strong\n' +
          '  emerald     -> text-positive / bg-positive-soft\n' +
          '  red         -> text-negative / bg-negative-soft\n' +
          '  amber       -> text-caution / bg-caution-soft\n' +
          'For chrome that is dark in BOTH themes (the rail, the sign-in screen, the ' +
          'assistant header, the photo lightbox) use the rail-* scale.',
      ),
    ).toEqual([]);
  });

  it('has no absolute white or black left in apps/web/src', () => {
    const strays = scan(ABSOLUTE);
    expect(
      strays,
      report(
        strays,
        'White does not stop being white at night. A card is bg-surface-raised; text on ' +
          'an inverting ground (bg-ink) is text-surface; the rail’s brightest text is ' +
          'text-rail-ink-strong; a logo plate that must stay paper-white is bg-plate. ' +
          'If it genuinely sits on a photograph, add it to ALLOWED with the reason.',
      ),
    ).toEqual([]);
  });

  it('has no raw hex colours outside the token declarations', () => {
    // globals.css is where colour is allowed to be a value rather than a name,
    // and it uses oklch() throughout — so even there a hex would be a mistake.
    const strays = scan(HEX);
    expect(
      strays,
      report(
        strays,
        'A hex literal is a colour that cannot be themed. The charts carried five of ' +
          'them and stayed a light-mode island inside a dark card. SVG marks take ' +
          'utilities too: fill-positive, stroke-line, stroke-surface-raised.',
      ),
    ).toEqual([]);
  });
});

describe('the tokens the screens name actually exist', () => {
  /*
   * The other half of the bug. `text-ink-mutedd` is not a compile error, is not
   * a runtime error, and produces no CSS at all — the text simply inherits and
   * nobody can see that anything is wrong. This catches the typo that the
   * scan above would happily accept as "semantic".
   */
  const css = readFileSync(join(SRC, 'app/globals.css'), 'utf8');
  const theme = css.slice(css.indexOf('@theme inline'));
  const declared = new Set(
    [...theme.matchAll(/^\s*--color-([a-z-]+):/gm)].map((m) => m[1]!),
  );

  it('declares every role the screens use', () => {
    expect(declared.size).toBeGreaterThan(10);

    const used = new Map<string, string>();
    for (const full of walk(SRC)) {
      const file = relative(SRC, full).replaceAll('\\', '/');
      if (file === 'app/globals.css') continue;
      for (const match of readFileSync(full, 'utf8').matchAll(
        new RegExp(`(?<![A-Za-z0-9_-])(?:${PROPERTIES})-([a-z]+(?:-[a-z]+)*)(?:/[0-9]{1,3})?(?![A-Za-z0-9_-])`, 'g'),
      )) {
        const role = match[1]!;
        // Only names that look like ours: every token starts with one of these
        // roots, which keeps stock utilities (text-sm, border-t) out of it.
        if (!/^(surface|ink|line|brand|positive|negative|caution|rail|plate)(-|$)/.test(role)) {
          continue;
        }
        if (!declared.has(role)) used.set(role, `${file}`);
      }
    }

    expect(
      [...used],
      '\nThese look like tokens but are not declared in @theme inline, so they compile ' +
        'to nothing at all and the element silently inherits its parent’s colour:\n' +
        [...used].map(([role, file]) => `  --color-${role}  (${file})`).join('\n'),
    ).toEqual([]);
  });
});
