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

/**
 * Trim a server quantity for display: `"3.0000"` → `"3"`, `"1.5000"` → `"1.5"`.
 *
 * ---------------------------------------------------------------------------
 * ONLY THE FRACTION MAY BE TRIMMED. `"10"` IS NOT `"1"`.
 *
 * This was `decimal.replace(/\.?0+$/, '')`, which is right for everything the
 * server sends — quantities arrive at four decimal places, so there is always
 * a point to anchor the trim. The POS cart passes `String(line.quantity)`, a
 * JavaScript integer with no point at all, and the regex then ate the zeros
 * that carry the value: ten items scanned displayed as `1 × RM 12.00` beside a
 * total for ten. The sale posted correctly; only the line the cashier reads
 * was wrong, which is the worst place for it.
 * ---------------------------------------------------------------------------
 */
export function qty(decimal: string): string {
  if (!decimal.includes('.')) return decimal;
  return decimal.replace(/\.?0+$/, '');
}

/**
 * The difference between two 4dp decimal strings, as a trimmed decimal string.
 *
 * ---------------------------------------------------------------------------
 * THE ONE SUBTRACTION IN THIS APP, AND IT IS NOT A FLOAT.
 *
 * The stock count screen shows the variance before anything is posted — "you
 * are about to write off 3" is a sentence someone should read while still
 * holding the clipboard — and it computed that with
 * `Number(counted) - Number(level.quantityOnHand)`, interpolated raw. A book
 * quantity of 1.0000 against a count of 1.1 printed
 *
 *     Book says 1 — this count +0.10000000000000009 found.
 *
 * on the very line meant to make somebody stop and check. A round trip per
 * keystroke is the wrong shape for a field that has not been submitted yet, so
 * the subtraction stays here — done on scaled integers via BigInt, exactly,
 * with no parseFloat anywhere near it. It is a WARNING, not a posting: the
 * server still recomputes everything from the count it is sent.
 * ---------------------------------------------------------------------------
 */
export function quantityDelta(a: string, b: string): string {
  const scaled = (value: string): bigint => {
    const negative = value.startsWith('-');
    const [whole = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');
    const units = BigInt(whole || '0') * 10_000n + BigInt(fraction.padEnd(4, '0').slice(0, 4));
    return negative ? -units : units;
  };

  const difference = scaled(a) - scaled(b);
  const sign = difference < 0n ? '-' : '';
  const magnitude = difference < 0n ? -difference : difference;
  return qty(`${magnitude / 10_000n}.${String(magnitude % 10_000n).padStart(4, '0')}`).replace(
    /^/,
    sign,
  );
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
