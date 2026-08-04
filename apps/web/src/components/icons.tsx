/**
 * Nav icons: sixteen hand-drawn 16×16 stroke glyphs, one per section.
 *
 * Inline SVG rather than an icon package for the same reason ui.tsx is not a
 * component library: sixteen paths are not a dependency's worth of surface,
 * and these inherit currentColor so the nav states style them for free.
 */

const paths: Record<string, string> = {
  today: 'M2 8.5 8 3l6 5.5M4 7.5V13h3v-3h2v3h3V7.5',
  pos: 'M2 3h2l1.5 7h6L13 5H5M6 12.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z',
  quotes: 'M3.5 2.5h9v11l-2-1.5-2 1.5-2-1.5-2 1.5v-11ZM6 5.5h4M6 8h4M6 10.5h2',
  sales: 'M4 2h8v12l-2-1.4L8 14l-2-1.4L4 14V2ZM6 5.5h4M6 8h4',
  collections: 'M8 2a4 4 0 0 0-4 4v3l-1.5 2.5h11L12 9V6a4 4 0 0 0-4-4ZM6.5 12.5a1.5 1.5 0 0 0 3 0',
  purchases: 'M3 5h10l-1 8H4L3 5Zm2.5 0a2.5 2.5 0 0 1 5 0',
  repairs: 'M9.5 2.5a3.5 3.5 0 0 0-3.7 4.8L2 11l3 3 3.7-3.8a3.5 3.5 0 0 0 4.8-3.7L11 9 9 7l2.5-2.5a3.5 3.5 0 0 0-2-2Z',
  stock: 'M8 2 2 5v6l6 3 6-3V5L8 2ZM2 5l6 3 6-3M8 8v6',
  items: 'M2.5 2.5h5L14 9l-5 5-6.5-6.5v-5ZM5.5 5.5h.01',
  banking: 'M2 6.5 8 3l6 3.5M3 7v5m3.3-5v5m3.4-5v5M13 7v5M2 13.5h12',
  insights: 'M2.5 13.5v-4m3.7 4V6m3.6 7.5V8.5m3.7 5v-9',
  statements: 'M2.5 3.5h11v9h-11v-9ZM2.5 6.5h11M5.5 9h3m2.5 0h.01M5.5 11h5',
  reports: 'M4 2h6l3 3v9H4V2Zm6 0v3h3M6.5 8.5h4m-4 2.5h4',
  approvals: 'M3 8.5 6.5 12 13 4.5',
  team: 'M6 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm-4 6a4 4 0 0 1 8 0M11 7.5a2 2 0 1 0-1.2-3.6M10.5 10a4 4 0 0 1 3.5 4',
  settings: 'M8 5.5A2.5 2.5 0 1 0 8 10.5 2.5 2.5 0 0 0 8 5.5ZM8 1.5v2m0 9v2m6.5-6.5h-2m-9 0h-2m10.6-4.6-1.4 1.4m-6.4 6.4-1.4 1.4m9.2 0-1.4-1.4M4.8 4.8 3.4 3.4',
  journals: 'M4 2.5h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Zm1.5 0v11M8 5.5h3m-3 2.5h3m-3 2.5h2',
  payroll: 'M2.5 4.5h11v7h-11v-7ZM8 6.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3ZM4.5 6.5h.01m7 3h.01',
  audit: 'M8 1.5 13 3.5v4c0 3.2-2.1 5.6-5 7-2.9-1.4-5-3.8-5-7v-4L8 1.5ZM6 8l1.5 1.5L10.5 6',
};

export function Icon({ name, className = '' }: { name: string; className?: string }) {
  const d = paths[name];
  if (!d) return null;
  return (
    <svg viewBox="0 0 16 16" className={`h-4 w-4 shrink-0 ${className}`} aria-hidden="true">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.4"
            strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
