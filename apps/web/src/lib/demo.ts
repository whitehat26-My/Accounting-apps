/**
 * The in-browser demo backend — GitHub Pages cannot run the real one.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS, AND WHAT IT IS NOT.
 *
 * GitHub Pages serves static files. The real system is a NestJS API over
 * PostgreSQL with row-level security, an append-only ledger and a tax engine —
 * none of which can exist on a static host. This file lets the SCREENS be
 * toured anyway: it implements just enough of the API's surface, in the
 * browser, over localStorage, seeded with sample data.
 *
 * It is compiled in ONLY when NEXT_PUBLIC_DEMO=1. In the real build this
 * module is never imported, and the client talks to the real API.
 *
 * Yes, it does arithmetic in JavaScript numbers (integer sen). That is
 * acceptable HERE for the same reason it is banned everywhere else: this file
 * is playing the SERVER's role for a demo, and the real server plays it with
 * Money. Nothing in this file ships in the production build.
 * ---------------------------------------------------------------------------
 */

interface DemoItem {
  id: string;
  code: string;
  name: string;
  itemType: string;
  isTracked: boolean;
  isSerialised: boolean;
  sale: { unitPrice: string | null };
  priceCents: number;
}

interface DemoMovement {
  id: string;
  itemId: string;
  movementType: string;
  quantity: string;
  valueDelta: string;
  sourceDocumentType: string;
  movedOn: string;
  reason: string | null;
}

interface DemoStock {
  itemId: string;
  qty: number;
  valueCents: number;
}

interface DemoSale {
  date: string;
  method: string;
  totalCents: number;
  cogsCents: number;
}

interface DemoJob {
  id: string;
  jobNo: string;
  contactId: string;
  deviceDescription: string;
  deviceSerial: string | null;
  reportedFault: string;
  diagnosis: string | null;
  status: string;
  approvalNote: string | null;
  closedReason: string | null;
  invoiceId: string | null;
  receivedOn: string;
  collectedOn: string | null;
  lines: { lineNo: number; description: string; quantity: string; unitPrice: string; itemId: string | null; serialNumbers: string[] | null }[];
}

interface DemoStore {
  orgName: string | null;
  items: DemoItem[];
  stock: DemoStock[];
  movements: DemoMovement[];
  sales: DemoSale[];
  jobs: DemoJob[];
  invoiceSeq: number;
  jobSeq: number;
}

const STORE_KEY = 'emil.demo.store';

function cents(decimal: string): number {
  const [whole = '0', fraction = ''] = decimal.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0').slice(0, 2));
}

function dec(centsValue: number): string {
  const sign = centsValue < 0 ? '-' : '';
  const abs = Math.abs(centsValue);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}00`;
}

function today(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function seed(): DemoStore {
  const ssd = { id: 'item-ssd', code: 'SSD-1TB', name: '1TB NVMe SSD', itemType: 'GOODS', isTracked: true, isSerialised: false, sale: { unitPrice: '400.0000' }, priceCents: 40000 };
  const hdmi = { id: 'item-hdmi', code: 'HDMI-2M', name: 'HDMI cable 2m', itemType: 'GOODS', isTracked: true, isSerialised: false, sale: { unitPrice: '35.0000' }, priceCents: 3500 };
  const setup = { id: 'item-setup', code: 'SETUP', name: 'PC setup service', itemType: 'SERVICE', isTracked: false, isSerialised: false, sale: { unitPrice: '150.0000' }, priceCents: 15000 };

  return {
    orgName: null,
    items: [ssd, hdmi, setup],
    stock: [
      { itemId: ssd.id, qty: 8, valueCents: 8 * 28000 },
      { itemId: hdmi.id, qty: 42, valueCents: 42 * 1200 },
    ],
    movements: [
      { id: 'm1', itemId: ssd.id, movementType: 'RECEIPT', quantity: '10.0000', valueDelta: '2800.0000', sourceDocumentType: 'BILL', movedOn: today(), reason: null },
      { id: 'm2', itemId: ssd.id, movementType: 'ISSUE', quantity: '-2.0000', valueDelta: '-560.0000', sourceDocumentType: 'INVOICE', movedOn: today(), reason: null },
      { id: 'm3', itemId: hdmi.id, movementType: 'RECEIPT', quantity: '42.0000', valueDelta: '504.0000', sourceDocumentType: 'BILL', movedOn: today(), reason: null },
    ],
    sales: [
      { date: today(), method: 'CASH', totalCents: 80000, cogsCents: 56000 },
      { date: today(), method: 'DUITNOW', totalCents: 15000, cogsCents: 0 },
    ],
    jobs: [
      {
        id: 'job-1', jobNo: 'JOB-00001', contactId: 'walk-in',
        deviceDescription: 'Acer Aspire 5, silver', deviceSerial: 'NXHS8SM00123',
        reportedFault: 'Does not boot; clicking noise from the drive bay',
        diagnosis: null, status: 'RECEIVED', approvalNote: null, closedReason: null,
        invoiceId: null, receivedOn: today(), collectedOn: null, lines: [],
      },
    ],
    invoiceSeq: 3,
    jobSeq: 2,
  };
}

function load(): DemoStore {
  const raw = window.localStorage.getItem(STORE_KEY);
  if (raw) {
    try { return JSON.parse(raw) as DemoStore; } catch { /* reseed */ }
  }
  const fresh = seed();
  window.localStorage.setItem(STORE_KEY, JSON.stringify(fresh));
  return fresh;
}

function save(store: DemoStore): void {
  window.localStorage.setItem(STORE_KEY, JSON.stringify(store));
}

function uid(): string {
  return crypto.randomUUID();
}

const ACCOUNTS = [
  { id: 'acc-1000', code: '1000', name: 'Cash and Bank', type: 'ASSET' },
  { id: 'acc-1200', code: '1200', name: 'Undeposited Funds', type: 'ASSET' },
  { id: 'acc-4000', code: '4000', name: 'Sales Revenue', type: 'INCOME' },
  { id: 'acc-5000', code: '5000', name: 'Cost of Sales', type: 'EXPENSE' },
];

/** The demo router. Same contract shape the screens already speak. */
export function demoApi(
  path: string,
  method: string,
  body: unknown,
): Record<string, unknown> {
  const store = load();
  const b: unknown = body ?? {};
  const url = new URL(path, 'http://demo.local');
  const p = url.pathname;

  // ---- auth & onboarding ---------------------------------------------------
  if (p === '/v1/auth/register') return {};
  if (p === '/v1/auth/login') {
    return {
      refreshToken: 'demo-refresh',
      organisations: store.orgName
        ? [{ tenantId: 'demo-tenant', name: store.orgName, role: 'OWNER' }]
        : [],
    };
  }
  if (p === '/v1/auth/switch') {
    return { accessToken: 'demo-access', refreshToken: 'demo-refresh' };
  }
  if (p === '/v1/organisations') {
    const org = (b as { organisation?: { name?: string } }).organisation;
    store.orgName = org?.name ?? 'Demo Computer Shop';
    save(store);
    return {
      organisation: { tenantId: 'demo-tenant', name: store.orgName },
      accessToken: 'demo-access',
      refreshToken: 'demo-refresh',
    };
  }

  // ---- reference data ------------------------------------------------------
  if (p === '/v1/accounts') return { accounts: ACCOUNTS };
  if (p === '/v1/tax-codes') return { taxCodes: [{ id: 'tax-none', code: 'NONE', name: 'Out of scope' }] };
  if (p === '/v1/contacts' && method === 'POST') return { id: uid() };

  // ---- items ---------------------------------------------------------------
  if (p === '/v1/items' && method === 'GET') {
    return store.items as unknown as Record<string, unknown>;
  }
  if (p === '/v1/items' && method === 'POST') {
    const input = b as { code: string; name: string; itemType?: string; isTracked?: boolean; isSerialised?: boolean; sale?: { unitPrice?: string } };
    const priceCents = cents(input.sale?.unitPrice ?? '0');
    const item: DemoItem = {
      id: uid(), code: input.code.toUpperCase(), name: input.name,
      itemType: input.itemType ?? 'SERVICE',
      isTracked: input.isTracked ?? false, isSerialised: input.isSerialised ?? false,
      sale: { unitPrice: dec(priceCents) }, priceCents,
    };
    store.items.push(item);
    save(store);
    return item as unknown as Record<string, unknown>;
  }

  // ---- POS -----------------------------------------------------------------
  if (p === '/v1/pos/sales') {
    const input = b as { lines: { itemId: string; quantity: string }[]; method: string; tenderedAmount?: string };
    let totalCents = 0;
    let cogsCents = 0;

    for (const line of input.lines) {
      const item = store.items.find((i) => i.id === line.itemId);
      if (!item) throw demoError(404, 'Item not found');
      const quantity = Number(line.quantity);
      totalCents += item.priceCents * quantity;

      if (item.isTracked) {
        const stock = store.stock.find((s) => s.itemId === item.id);
        if (!stock || stock.qty < quantity) {
          throw demoError(422, `Cannot issue ${line.quantity} of ${item.code} — ${stock?.qty ?? 0}.0000 on hand.`);
        }
        const cost = Math.round((stock.valueCents * quantity) / stock.qty);
        stock.qty -= quantity;
        stock.valueCents -= cost;
        cogsCents += cost;
        store.movements.push({
          id: uid(), itemId: item.id, movementType: 'ISSUE',
          quantity: `-${quantity}.0000`, valueDelta: dec(-cost),
          sourceDocumentType: 'INVOICE', movedOn: today(), reason: null,
        });
      }
    }

    let changeDue: string | null = null;
    if (input.method === 'CASH' && input.tenderedAmount) {
      const tendered = cents(input.tenderedAmount);
      if (tendered < totalCents) {
        throw demoError(422, `Tendered ${dec(tendered)} against a total of ${dec(totalCents)}.`);
      }
      changeDue = tendered === totalCents ? null : dec(tendered - totalCents);
    }

    const invoiceNo = `INV-${String(store.invoiceSeq++).padStart(5, '0')}`;
    store.sales.push({ date: today(), method: input.method, totalCents, cogsCents });
    save(store);

    return {
      invoiceId: uid(), invoiceNo, receiptId: 'demo-receipt', receiptNo: 'PAY-DEMO',
      subtotal: dec(totalCents), taxTotal: '0.0000', total: dec(totalCents),
      changeDue, replayed: false,
    };
  }

  if (p === '/v1/pos/takings') {
    const date = url.searchParams.get('date') ?? today();
    const daySales = store.sales.filter((s) => s.date === date);
    const byMethod = new Map<string, { total: number; count: number }>();
    for (const sale of daySales) {
      const entry = byMethod.get(sale.method) ?? { total: 0, count: 0 };
      entry.total += sale.totalCents;
      entry.count += 1;
      byMethod.set(sale.method, entry);
    }
    const receipts = daySales.reduce((sum, s) => sum + s.totalCents, 0);
    const cogs = daySales.reduce((sum, s) => sum + s.cogsCents, 0);
    return {
      date,
      byMethod: [...byMethod.entries()].map(([m, e]) => ({
        method: m,
        depositAccount: m === 'CASH' ? 'Cash and Bank' : 'Undeposited Funds',
        total: dec(e.total), count: e.count,
      })),
      receiptsTotal: dec(receipts),
      invoicedTotal: dec(receipts),
      invoiceCount: daySales.length,
      costOfGoodsSold: dec(cogs),
      grossProfit: dec(receipts - cogs),
    };
  }

  if (p === '/v1/reports/cash-forecast') {
    // Sample figures, like everything else here. The real route computes from
    // the ledger and the open documents' due dates.
    return {
      asOf: today(),
      openingCash: '18540.0000',
      horizons: [
        { days: 30, until: today(), inflows: '25300.0000', outflows: '9800.0000', net: '15500.0000', closing: '34040.0000' },
        { days: 60, until: today(), inflows: '31200.0000', outflows: '21500.0000', net: '9700.0000', closing: '28240.0000' },
        { days: 90, until: today(), inflows: '44800.0000', outflows: '24100.0000', net: '20700.0000', closing: '39240.0000' },
      ],
      overdueReceivables: { total: '7000.0000', count: 2 },
      overduePayables: { total: '0.0000', count: 0 },
    };
  }

  if (p.startsWith('/v1/reports/weekly-digests')) {
    // One sample week with a warning, so the card shows its teeth.
    return {
      digests: [{
        id: 'demo-digest-1',
        weekStart: '2026-07-20',
        weekEnd: '2026-07-26',
        warnCount: 1,
        createdAt: '2026-07-27T00:05:00.000Z',
        digest: {
          weekStart: '2026-07-20',
          weekEnd: '2026-07-26',
          week: { salesNet: '11840.0000', takings: '12210.0000', grossProfit: '3552.0000',
                  expenses: '2140.0000', daysWithSales: 6 },
          comparedAgainstWeeks: 4,
          flags: [
            { code: 'OVERDUE_HEAVY', severity: 'WARN',
              message: 'RM 7,000.00 across 2 overdue invoices — more than half the ' +
                       "week's sales. Collections is where this week's money actually is." },
          ],
        },
      }],
    };
  }

  // ---- stock ---------------------------------------------------------------
  if (p === '/v1/stock') {
    return {
      stock: store.stock.map((s) => {
        const item = store.items.find((i) => i.id === s.itemId)!;
        return {
          itemId: s.itemId, code: item.code, name: item.name,
          quantityOnHand: `${s.qty}.0000`, stockValue: dec(s.valueCents),
          weightedAverageCost: s.qty > 0 ? dec(Math.round(s.valueCents / s.qty)) : '0.0000',
        };
      }),
    };
  }
  const movementMatch = /^\/v1\/stock\/items\/([^/]+)\/movements$/.exec(p);
  if (movementMatch) {
    return { movements: store.movements.filter((m) => m.itemId === movementMatch[1]) };
  }

  // ---- repairs -------------------------------------------------------------
  if (p === '/v1/repairs' && method === 'GET') return { jobs: store.jobs };
  if (p === '/v1/repairs' && method === 'POST') {
    const input = b as { deviceDescription: string; deviceSerial?: string; reportedFault: string; receivedOn: string; contactId: string };
    const job: DemoJob = {
      id: uid(), jobNo: `JOB-${String(store.jobSeq++).padStart(5, '0')}`,
      contactId: input.contactId, deviceDescription: input.deviceDescription,
      deviceSerial: input.deviceSerial ?? null, reportedFault: input.reportedFault,
      diagnosis: null, status: 'RECEIVED', approvalNote: null, closedReason: null,
      invoiceId: null, receivedOn: input.receivedOn, collectedOn: null, lines: [],
    };
    store.jobs.unshift(job);
    save(store);
    return { id: job.id, jobNo: job.jobNo, replayed: false };
  }

  const jobMatch = /^\/v1\/repairs\/([^/]+)(\/.*)?$/.exec(p);
  if (jobMatch) {
    const job = store.jobs.find((j) => j.id === jobMatch[1]);
    if (!job) throw demoError(404, 'Repair job not found');
    const action = jobMatch[2] ?? '';

    if (action === '' && method === 'GET') return job as unknown as Record<string, unknown>;

    if (action === '/quote') {
      const input = b as { diagnosis: string; lines: { description: string; quantity: string; unitPrice: string }[] };
      job.diagnosis = input.diagnosis;
      job.lines = input.lines.map((l, i) => ({
        lineNo: i + 1, description: l.description, quantity: l.quantity,
        unitPrice: dec(cents(l.unitPrice)), itemId: null, serialNumbers: null,
      }));
      job.status = 'QUOTED';
      save(store);
      return job as unknown as Record<string, unknown>;
    }

    if (action === '/status') {
      const input = b as { to: string; reason?: string; approvalNote?: string };
      if (input.to === 'COLLECTED') throw demoError(422, 'A job is collected by invoicing it, not by setting the status');
      job.status = input.to;
      if (input.to === 'APPROVED') job.approvalNote = input.approvalNote ?? null;
      if (input.to === 'DECLINED' || input.to === 'CANCELLED') job.closedReason = input.reason ?? null;
      save(store);
      return job as unknown as Record<string, unknown>;
    }

    if (action === '/collect') {
      if (job.status !== 'READY') throw demoError(422, `Job ${job.jobNo} is ${job.status}; only READY jobs can be collected`);
      const totalCents = job.lines.reduce((sum, l) => sum + cents(l.unitPrice) * Number(l.quantity), 0);
      const input = b as { payment?: { tenderedAmount?: string } };
      let changeDue: string | null = null;
      if (input.payment?.tenderedAmount) {
        const tendered = cents(input.payment.tenderedAmount);
        if (tendered < totalCents) throw demoError(422, `Tendered ${dec(tendered)} against a total of ${dec(totalCents)}.`);
        changeDue = tendered === totalCents ? null : dec(tendered - totalCents);
      }
      const invoiceNo = `INV-${String(store.invoiceSeq++).padStart(5, '0')}`;
      job.status = 'COLLECTED';
      job.invoiceId = uid();
      job.collectedOn = today();
      store.sales.push({ date: today(), method: 'CASH', totalCents, cogsCents: 0 });
      save(store);
      return { jobId: job.id, jobNo: job.jobNo, invoiceId: job.invoiceId, invoiceNo, total: dec(totalCents), changeDue, paid: true };
    }
  }

  throw demoError(404, `The static demo does not implement ${method} ${p}`);
}

export function demoError(status: number, message: string): Error & { status: number; body: Record<string, unknown> } {
  const error = new Error(message) as Error & { status: number; body: Record<string, unknown> };
  error.name = 'ApiError';
  error.status = status;
  error.body = { message };
  return error;
}

export const DEMO_PDF_MESSAGE =
  'PDF documents are rendered by the real server, which the static demo does not include.';
