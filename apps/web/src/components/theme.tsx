'use client';

import { useEffect, useState } from 'react';

/**
 * System / Light / Dark, for a shop that is open after dark.
 *
 * ---------------------------------------------------------------------------
 * THREE STATES, NOT A SWITCH — AND "SYSTEM" IS THE DEFAULT.
 *
 * A two-way toggle has to pick a side on first load, and whichever it picks is
 * wrong for half the shops. `system` follows the counter PC's own setting,
 * which is already correct far more often than a guess, and it is the state
 * nobody has to discover. Light and Dark exist for the case the operating
 * system gets it wrong — a bright shopfront on a machine still set to dark,
 * which is a real configuration and not a hypothetical one.
 *
 * The class on <html> is applied by the blocking script in the root layout, so
 * the page never paints light and then flips. This component only has to keep
 * the class in step with a CHANGE, and the two must agree about the storage
 * key and the meaning of a missing value.
 * ---------------------------------------------------------------------------
 */

export type Theme = 'system' | 'light' | 'dark';

/** Shared with the bootstrap script in `app/layout.tsx` — change both or none. */
const KEY = 'emil.theme';

function prefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function apply(theme: Theme): void {
  const dark = theme === 'dark' || (theme === 'system' && prefersDark());
  document.documentElement.classList.toggle('dark', dark);
}

function read(): Theme {
  try {
    const stored = localStorage.getItem(KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    // A browser with storage blocked still gets a working app on the system
    // preference; it just cannot remember an override between visits.
    return 'system';
  }
}

const OPTIONS: { value: Theme; label: string; title: string }[] = [
  { value: 'system', label: 'Auto', title: 'Follow this computer’s setting' },
  { value: 'light', label: 'Day', title: 'Always light' },
  { value: 'dark', label: 'Night', title: 'Always dark' },
];

export function ThemeToggle() {
  /*
   * Starts at `system` on BOTH server and client and corrects in an effect.
   * Reading localStorage during render would make the first client render
   * disagree with the server's HTML, and React discards the whole subtree on
   * that mismatch — the rail would flicker on every navigation. The visible
   * theme is already right by then; only which pill looks selected is
   * catching up, and that is a one-frame difference nobody can see.
   */
  const [theme, setTheme] = useState<Theme>('system');

  useEffect(() => {
    setTheme(read());
  }, []);

  /*
   * While on `system`, follow the OS if it changes underneath us — a machine
   * on an automatic day/night schedule flips at dusk, and the shop should flip
   * with it rather than at the next full page load.
   */
  useEffect(() => {
    if (theme !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => apply('system');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [theme]);

  const choose = (next: Theme) => {
    setTheme(next);
    apply(next);
    try {
      // `system` REMOVES the key rather than storing the word: the bootstrap
      // script treats "no stored value" as system, so an absent key and the
      // string 'system' must not be two different things.
      if (next === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {
      // Storage refused; the choice still applies for this session.
    }
  };

  return (
    <div
      role="group"
      aria-label="Screen brightness"
      className="flex rounded-lg bg-rail-ink/10 p-0.5"
    >
      {OPTIONS.map((option) => {
        const selected = theme === option.value;
        return (
          <button
            key={option.value}
            type="button"
            title={option.title}
            aria-pressed={selected}
            onClick={() => choose(option.value)}
            className={`flex-1 rounded-md px-2 py-1 text-[11px] transition-colors ${
              selected
                ? 'bg-rail-ink/15 font-medium text-rail-ink-strong'
                : 'text-rail-ink-dim hover:text-rail-ink'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
