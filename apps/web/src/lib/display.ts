/**
 * Display formatting — strings in, strings out, no arithmetic.
 *
 * The wire carries 4dp decimal strings and ISO dates; paper and screens show
 * RM at 2dp and DD/MM/YYYY (CLAUDE.md rule 8). Everything here is string
 * surgery on values the server already computed — the moment this file needs
 * parseFloat, the calculation belongs on the server instead.
 */

export function rm(decimal: string): string {
  const [whole = '0', fraction = ''] = decimal.split('.');
  const cents = fraction.padEnd(2, '0').slice(0, 2);
  const negative = whole.startsWith('-');
  const digits = negative ? whole.slice(1) : whole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}RM ${grouped}.${cents}`;
}

export function qty(decimal: string): string {
  return decimal.replace(/\.?0+$/, '');
}

export function displayDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

export function todayIso(): string {
  // The till's "today" is the shop's wall clock in Asia/Kuala_Lumpur.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kuala_Lumpur',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
