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
  accessories: string[];
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
  members?: DemoMember[];
  bankAccounts?: DemoBankAccount[];
  bankLines?: DemoBankLine[];
  bankRules?: DemoBankRule[];
  contacts?: DemoContact[];
  openInvoices?: DemoOpenInvoice[];
  openBills?: DemoOpenBill[];
  reminders?: DemoReminder[];
  extraAccounts?: { id: string; code: string; name: string; type: string }[];
  taxCodes?: DemoTaxCode[];
  manualJournals?: DemoJournalEntry[];
  journalSeq?: number;
  periods?: DemoPeriod[];
  fyClosed?: boolean;
  openingPosted?: boolean;
}

interface DemoJournalEntry {
  entryId: string;
  entryNo: string;
  entryDate: string;
  description: string | null;
  sourceModule: string;
  status: string;
  reversalOfId: string | null;
  lines: { accountCode: string; accountName: string; description: string | null; debit: string; credit: string }[];
  totalDebit: string;
  totalCredit: string;
}

interface DemoPeriod {
  id: string;
  fiscalYearId: string;
  label: string;
  sequence: number;
  startDate: string;
  endDate: string;
  status: 'OPEN' | 'CLOSED' | 'LOCKED';
  lockedBy: string | null;
  lockedAt: string | null;
  entryCount: number;
}

/** Jan–Aug 2026: months before July closed, July/August open. */
function seedPeriods(): DemoPeriod[] {
  return Array.from({ length: 8 }, (_, i) => {
    const month = i + 1;
    const mm = String(month).padStart(2, '0');
    const lastDay = new Date(Date.UTC(2026, month, 0)).getUTCDate();
    return {
      id: `period-2026-${mm}`,
      fiscalYearId: 'fy-2026',
      label: `2026-${mm}`,
      sequence: month,
      startDate: `2026-${mm}-01`,
      endDate: `2026-${mm}-${lastDay}`,
      status: month < 7 ? ('CLOSED' as const) : ('OPEN' as const),
      lockedBy: null,
      lockedAt: null,
      entryCount: month < 7 ? 120 + month * 7 : month === 7 ? 164 : 12,
    };
  });
}

interface DemoContact {
  id: string;
  name: string;
  isCustomer: boolean;
  isSupplier: boolean;
}

interface DemoOpenInvoice {
  id: string;
  invoiceNo: string;
  contactId: string;
  contactName: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  totalCents: number;
  amountDueCents: number;
  status: string;
  highestTierRaised: number;
}

interface DemoOpenBill {
  id: string;
  internalRef: string;
  billNo: string;
  supplierId: string;
  supplierName: string;
  billDate: string;
  dueDate: string;
  currency: string;
  totalCents: number;
  amountDueCents: number;
  status: string;
}

interface DemoReminder {
  id: string;
  invoiceId: string;
  invoiceNo: string;
  contactName: string;
  tier: number;
  tone: string;
  message: string;
  status: string;
  amountDueCents: number;
  daysOverdue: number;
}

interface DemoTaxCode {
  id: string;
  code: string;
  name: string;
  regime: string;
  inputTreatment: string;
  rates: { rateBasisPoints: number; validFrom: string; validTo: string | null; legislationRef: string | null }[];
}

interface DemoBankAccount {
  id: string;
  name: string;
  bankName: string;
  currency: string;
  glAccountId: string;
  accountType: string;
  isActive: boolean;
}

interface DemoBankLine {
  id: string;
  bankAccountId: string;
  txnDate: string;
  description: string;
  reference: string | null;
  amountCents: number;
  status: string;
}

interface SuggestionEntry {
  bankTransactionId: string;
  suggestions: {
    candidateIds: string[];
    kind: string;
    confidence: number;
    reason: string;
    amountDifference: string;
    dayDifference: number;
  }[];
}

interface DemoBankRule {
  id: string;
  name: string;
  contains: string | null;
  matchesDirection: string | null;
  accountId: string;
  accountName: string;
  autoApply: boolean;
  isActive: boolean;
  hitCount: number;
}

interface DemoMember {
  membershipId: string;
  userId: string;
  email: string;
  fullName: string;
  role: string;
  status: string;
}

const DEMO_TEAM: DemoMember[] = [
  { membershipId: 'mem-1', userId: 'demo-user', email: 'boss@shop.my', fullName: 'The Boss', role: 'OWNER', status: 'ACTIVE' },
  { membershipId: 'mem-2', userId: 'u-cashier', email: 'cashier@shop.my', fullName: 'Aina (counter)', role: 'SALES', status: 'ACTIVE' },
  { membershipId: 'mem-3', userId: 'u-tech1', email: 'tech1@shop.my', fullName: 'Farid (bench)', role: 'TECHNICIAN', status: 'ACTIVE' },
  { membershipId: 'mem-4', userId: 'u-tech2', email: 'tech2@shop.my', fullName: 'Wei Jian (bench)', role: 'TECHNICIAN', status: 'ACTIVE' },
  { membershipId: 'mem-5', userId: 'u-acct', email: 'accounts@shop.my', fullName: 'Siti (accounts)', role: 'ACCOUNTANT', status: 'ACTIVE' },
];

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
        invoiceId: null, receivedOn: today(), collectedOn: null,
        accessories: ['Charger', 'Bag / sleeve'], lines: [],
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
  // A liability and an equity account so the opening-balance card has
  // something to net against — a shop with a van usually has both.
  { id: 'acc-2500', code: '2500', name: 'Hire Purchase — van', type: 'LIABILITY' },
  { id: 'acc-3100', code: '3100', name: 'Opening Balances', type: 'EQUITY' },
  { id: 'acc-4000', code: '4000', name: 'Sales Revenue', type: 'INCOME' },
  { id: 'acc-5000', code: '5000', name: 'Cost of Sales', type: 'EXPENSE' },
  { id: 'acc-6000', code: '6000', name: 'Utilities', type: 'EXPENSE' },
  { id: 'acc-6050', code: '6050', name: 'Internet & Phone', type: 'EXPENSE' },
  { id: 'acc-6100', code: '6100', name: 'Bank Charges', type: 'EXPENSE' },
  { id: 'acc-6200', code: '6200', name: 'Rent', type: 'EXPENSE' },
];

const DEMO_BANK: DemoBankAccount[] = [
  { id: 'bank-1', name: 'Maybank Current', bankName: 'Malayan Banking Berhad',
    currency: 'MYR', glAccountId: 'acc-1000', accountType: 'BANK', isActive: true },
];

function seedBankLines(): DemoBankLine[] {
  return [
    { id: 'bl-1', bankAccountId: 'bank-1', txnDate: today(), reference: null,
      description: 'IBG TRANSFER FR NUSANTARA RETAIL SDN BHD INV-00042', amountCents: 108000, status: 'UNRECONCILED' },
    { id: 'bl-2', bankAccountId: 'bank-1', txnDate: today(), reference: null,
      description: 'SERVICE CHARGE', amountCents: -500, status: 'UNRECONCILED' },
    { id: 'bl-3', bankAccountId: 'bank-1', txnDate: today(), reference: null,
      description: 'IBG TRANSFER FR NUSANTARA RETAIL SDN BHD INV-00042 INV-00035', amountCents: 358000, status: 'UNRECONCILED' },
  ];
}

/** DD/MM/YYYY, DD-MM-YYYY or YYYY-MM-DD → ISO, or null when it is not a date. */
function demoParseDate(value: string, format: string): string | null {
  const v = value.trim();
  if (format === 'YYYY-MM-DD') return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
  const sep = format.includes('/') ? '/' : '-';
  const parts = v.split(sep);
  if (parts.length !== 3 || !/^\d{4}$/.test(parts[2] ?? '')) return null;
  const [d, m, y] = parts;
  if (!/^\d{1,2}$/.test(d ?? '') || !/^\d{1,2}$/.test(m ?? '')) return null;
  return `${y}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}`;
}

function demoParseCsv(
  content: string,
  profile: { delimiter: string; dateFormat: string; columns: { txnDate: number; description: number; amount: number } },
): { txnDate: string; description: string; amountCents: number }[] {
  const rows: { txnDate: string; description: string; amountCents: number }[] = [];
  for (const line of content.split(/\r?\n/)) {
    const cells = line.split(profile.delimiter);
    const date = demoParseDate(cells[profile.columns.txnDate] ?? '', profile.dateFormat);
    const amountRaw = (cells[profile.columns.amount] ?? '').replace(/[, ]/g, '');
    if (date === null || !/^-?\d+(\.\d+)?$/.test(amountRaw)) continue;
    // cents() is unsigned; carry the sign separately.
    const negative = amountRaw.startsWith('-');
    const magnitude = cents(negative ? amountRaw.slice(1) : amountRaw);
    rows.push({
      txnDate: date,
      description: (cells[profile.columns.description] ?? '').trim(),
      amountCents: negative ? -magnitude : magnitude,
    });
  }
  return rows;
}

function daysFromToday(days: number): string {
  const d = new Date(`${today()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const DEMO_CONTACTS: DemoContact[] = [
  { id: 'ct-1', name: 'Nusantara Retail Sdn Bhd', isCustomer: true, isSupplier: false },
  { id: 'ct-2', name: 'Delima Networks Enterprise', isCustomer: true, isSupplier: false },
  { id: 'ct-3', name: 'Selangor Supplies Sdn Bhd', isCustomer: false, isSupplier: true },
];

/** RM 7,000 across the two overdue rows — the same story the forecast tells. */
function seedOpenInvoices(): DemoOpenInvoice[] {
  return [
    { id: 'oi-1', invoiceNo: 'INV-00042', contactId: 'ct-1', contactName: 'Nusantara Retail Sdn Bhd',
      issueDate: daysFromToday(-5), dueDate: daysFromToday(10), currency: 'MYR',
      totalCents: 108000, amountDueCents: 108000, status: 'ISSUED', highestTierRaised: 0 },
    { id: 'oi-2', invoiceNo: 'INV-00038', contactId: 'ct-2', contactName: 'Delima Networks Enterprise',
      issueDate: daysFromToday(-42), dueDate: daysFromToday(-12), currency: 'MYR',
      totalCents: 450000, amountDueCents: 450000, status: 'ISSUED', highestTierRaised: 2 },
    { id: 'oi-3', invoiceNo: 'INV-00035', contactId: 'ct-1', contactName: 'Nusantara Retail Sdn Bhd',
      issueDate: daysFromToday(-55), dueDate: daysFromToday(-25), currency: 'MYR',
      totalCents: 250000, amountDueCents: 250000, status: 'PART_PAID', highestTierRaised: 3 },
  ];
}

function seedOpenBills(): DemoOpenBill[] {
  return [
    { id: 'ob-1', internalRef: 'BILL-00017', billNo: 'SS-2291', supplierId: 'ct-3',
      supplierName: 'Selangor Supplies Sdn Bhd', billDate: daysFromToday(-8),
      dueDate: daysFromToday(22), currency: 'MYR', totalCents: 60000,
      amountDueCents: 60000, status: 'ENTERED' },
  ];
}

const DEMO_TAX_CODES: DemoTaxCode[] = [
  { id: 'tax-none', code: 'NONE', name: 'Not in scope for SST', regime: 'NONE',
    inputTreatment: 'COST',
    rates: [{ rateBasisPoints: 0, validFrom: '2018-09-01', validTo: null, legislationRef: null }] },
];

/** Maybank `Label : value` advices — the demo twin of the real parser. */
function demoParseAdvice(
  content: string,
): { txnDate: string; description: string; amountCents: number }[] {
  const rows: { txnDate: string; description: string; amountCents: number }[] = [];
  let fields: Map<string, string> | null = null;

  const flush = () => {
    if (!fields) return;
    const total = fields.get('TOTAL AMOUNT');
    if (total === undefined || !/^\d+(\.\d+)?$/.test(total.replace(/,/g, ''))) return;
    const details = (fields.get('DETAILS OF PAYMENT') ?? '')
      .replace(/^PAYMENT DESCRIPTIONS\s*:\s*/i, '');
    const remitting = fields.get('REMITTING BANK') ?? fields.get('REMITING BANK');
    const description = [fields.get('PAYMENT REFERENCE'), details, remitting ? `FR ${remitting}` : '']
      .filter((s) => s && s.length > 0)
      .join(' ');
    rows.push({ txnDate: today(), description, amountCents: cents(total.replace(/,/g, '')) });
  };

  for (const raw of content.split(/\r?\n/)) {
    const colon = raw.indexOf(':');
    if (colon <= 0) continue;
    const label = raw.slice(0, colon).trim().toUpperCase();
    const value = raw.slice(colon + 1).trim();
    if (label === 'OUR REFERENCE') {
      flush();
      fields = new Map();
    }
    if (fields && !fields.has(label)) fields.set(label, value);
  }
  flush();
  return rows;
}

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
  if (p === '/v1/auth/me') {
    return {
      userId: 'demo-user',
      tenantId: 'demo-tenant',
      role: 'OWNER',
      permissions: [
        'pos.sale', 'repair.read', 'repair.write', 'item.read', 'item.write',
        'stock.read', 'stock.adjust', 'report.read', 'user.read', 'user.manage',
        'invoice.read', 'invoice.create', 'contact.read', 'contact.write',
        'bank.read', 'bank.import', 'bank.reconcile', 'journal.read', 'journal.post',
        'bill.read', 'bill.create', 'bill.approve', 'payment.create', 'receipt.create',
        'collections.chase', 'tax.read', 'tax.write', 'org.manage',
        'audit.read', 'period.lock', 'debitnote.create',
      ],
    };
  }
  if (p === '/v1/auth/members' && method === 'GET') {
    return { members: store.members ?? DEMO_TEAM };
  }
  if (p === '/v1/auth/members' && method === 'POST') {
    const input = b as { email: string; role: string };
    store.members = [
      ...(store.members ?? DEMO_TEAM),
      { membershipId: uid(), userId: uid(), email: input.email,
        fullName: input.email.split('@')[0] ?? input.email, role: input.role,
        status: 'ACTIVE' },
    ];
    return { id: uid() };
  }
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
    store.orgName = org?.name ?? 'Shah G Tech';
    save(store);
    return {
      organisation: { tenantId: 'demo-tenant', name: store.orgName },
      accessToken: 'demo-access',
      refreshToken: 'demo-refresh',
    };
  }

  // Reference data (accounts, tax codes, contacts) is served by the fuller
  // handlers further down — an early stub here once shadowed them, and the
  // Settings screen crashed on the rate-less tax codes it returned.

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

  if (p.startsWith('/v1/reports/daily-takings')) {
    // A plausible fortnight for a RM 50-60k/month shop: quiet Mondays, busy
    // weekends, one closed day. Fixed values so the chart is stable.
    const takingsPattern = [1850, 2400, 2150, 3100, 4200, 4850, 0, 1620, 2300, 2750, 2900, 3800, 5100, 2450];
    const points = takingsPattern.map((ringgit, i) => {
      const d = new Date(`${today()}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - (takingsPattern.length - 1 - i));
      const date = d.toISOString().slice(0, 10);
      return {
        date,
        receipts: dec(ringgit * 100),
        invoiced: dec(ringgit * 100),
        grossProfit: dec(Math.floor(ringgit * 0.32) * 100),
      };
    });
    return { from: points[0]!.date, to: points[points.length - 1]!.date, points };
  }

  if (p.startsWith('/v1/reports/weekly-digests')) {
    // Eight sample weeks, newest first — the latest carries a warning so the
    // Today card shows its teeth, and the trend has a shape worth drawing.
    const weeklySales = [11840, 13650, 12980, 12100, 14400, 11250, 13900, 12600];
    const digests = weeklySales.map((ringgit, i) => {
      const start = new Date(`${today()}T00:00:00Z`);
      start.setUTCDate(start.getUTCDate() - start.getUTCDay() - 6 - 7 * i);
      const weekStart = start.toISOString().slice(0, 10);
      const end = new Date(start);
      end.setUTCDate(end.getUTCDate() + 6);
      return {
        id: `demo-digest-${i + 1}`,
        weekStart,
        weekEnd: end.toISOString().slice(0, 10),
        warnCount: i === 0 ? 1 : 0,
        createdAt: `${weekStart}T00:05:00.000Z`,
        digest: {
          weekStart,
          weekEnd: end.toISOString().slice(0, 10),
          week: { salesNet: dec(ringgit * 100), takings: dec(Math.floor(ringgit * 1.02) * 100),
                  grossProfit: dec(Math.floor(ringgit * 0.3) * 100),
                  expenses: dec(Math.floor(ringgit * 0.18) * 100), daysWithSales: 6 },
          comparedAgainstWeeks: 4,
          flags: i === 0
            ? [{ code: 'OVERDUE_HEAVY', severity: 'WARN',
                 message: 'RM 7,000.00 across 2 overdue invoices — more than half the ' +
                          "week's sales. Collections is where this week's money actually is." }]
            : [],
        },
      };
    });
    const limitMatch = /limit=(\d+)/.exec(p);
    return { digests: digests.slice(0, limitMatch ? Number(limitMatch[1]) : digests.length) };
  }

  // ---- sales, purchases, collections, settings ------------------------------
  if (p === '/v1/contacts' && method === 'GET') {
    return { contacts: store.contacts ?? DEMO_CONTACTS };
  }
  if (p === '/v1/contacts' && method === 'POST') {
    const input = b as { name: string; isCustomer?: boolean; isSupplier?: boolean };
    const contact: DemoContact = {
      id: uid(), name: input.name,
      isCustomer: input.isCustomer ?? false, isSupplier: input.isSupplier ?? false,
    };
    store.contacts = [...(store.contacts ?? DEMO_CONTACTS), contact];
    save(store);
    return { id: contact.id, name: contact.name };
  }

  if (p === '/v1/invoices' && method === 'GET') {
    const rows = (store.openInvoices ?? seedOpenInvoices()).filter((i) => i.amountDueCents > 0);
    return {
      invoices: rows.map((i) => ({
        id: i.id, invoiceNo: i.invoiceNo, contactId: i.contactId, contactName: i.contactName,
        issueDate: i.issueDate, dueDate: i.dueDate, currency: i.currency,
        total: dec(i.totalCents), amountDue: dec(i.amountDueCents), status: i.status,
      })),
    };
  }
  if (p === '/v1/invoices' && method === 'POST') {
    const input = b as {
      contactId: string; issueDate: string; dueDate?: string;
      lines: { description: string; quantity: string; unitPrice: string }[];
    };
    const contact = (store.contacts ?? DEMO_CONTACTS).find((c) => c.id === input.contactId);
    const totalCents = input.lines.reduce(
      (sum, l) => sum + Math.round(Number(l.quantity) * cents(l.unitPrice)), 0,
    );
    const invoice: DemoOpenInvoice = {
      id: uid(), invoiceNo: `INV-${String(store.invoiceSeq++).padStart(5, '0')}`,
      contactId: input.contactId, contactName: contact?.name ?? 'Customer',
      issueDate: input.issueDate, dueDate: input.dueDate ?? daysFromToday(30),
      currency: 'MYR', totalCents, amountDueCents: totalCents,
      status: 'ISSUED', highestTierRaised: 0,
    };
    store.openInvoices = [...(store.openInvoices ?? seedOpenInvoices()), invoice];
    save(store);
    return { id: invoice.id, invoiceNo: invoice.invoiceNo, total: dec(totalCents) };
  }

  if (p === '/v1/receipts' && method === 'POST') {
    const input = b as { allocations?: { invoiceId: string; amount: string }[] };
    const invoices = store.openInvoices ?? seedOpenInvoices();
    for (const alloc of input.allocations ?? []) {
      const inv = invoices.find((i) => i.id === alloc.invoiceId);
      if (inv) {
        inv.amountDueCents = Math.max(0, inv.amountDueCents - cents(alloc.amount));
        inv.status = inv.amountDueCents === 0 ? 'PAID' : 'PART_PAID';
      }
    }
    store.openInvoices = invoices;
    // Paying an invoice cancels its queued reminders — the rule the real
    // follow-up pass enforces first.
    store.reminders = (store.reminders ?? []).map((r) =>
      invoices.find((i) => i.id === r.invoiceId && i.amountDueCents === 0)
        ? { ...r, status: 'CANCELLED' }
        : r,
    );
    save(store);
    return { id: uid() };
  }

  if (p === '/v1/bills' && method === 'GET') {
    const rows = (store.openBills ?? seedOpenBills()).filter((x) => x.amountDueCents > 0);
    return {
      bills: rows.map((x) => ({
        id: x.id, internalRef: x.internalRef, billNo: x.billNo, supplierId: x.supplierId,
        supplierName: x.supplierName, billDate: x.billDate, dueDate: x.dueDate,
        currency: x.currency, total: dec(x.totalCents), amountDue: dec(x.amountDueCents),
        status: x.status,
      })),
    };
  }
  if (p === '/v1/bills' && method === 'POST') {
    const input = b as {
      supplierId: string; billNo: string; billDate: string; dueDate?: string;
      lines: { quantity: string; unitPrice: string }[];
    };
    const supplier = (store.contacts ?? DEMO_CONTACTS).find((c) => c.id === input.supplierId);
    const totalCents = input.lines.reduce(
      (sum, l) => sum + Math.round(Number(l.quantity) * cents(l.unitPrice)), 0,
    );
    const bills = store.openBills ?? seedOpenBills();
    const bill: DemoOpenBill = {
      id: uid(), internalRef: `BILL-${String(18 + bills.length).padStart(5, '0')}`,
      billNo: input.billNo, supplierId: input.supplierId,
      supplierName: supplier?.name ?? 'Supplier', billDate: input.billDate,
      dueDate: input.dueDate ?? daysFromToday(30), currency: 'MYR',
      totalCents, amountDueCents: totalCents, status: 'ENTERED',
    };
    store.openBills = [...bills, bill];
    save(store);
    return { id: bill.id, internalRef: bill.internalRef };
  }

  if (p === '/v1/supplier-payments' && method === 'POST') {
    const input = b as { allocations?: { billId: string; amount: string }[] };
    const bills = store.openBills ?? seedOpenBills();
    for (const alloc of input.allocations ?? []) {
      const bill = bills.find((x) => x.id === alloc.billId);
      if (bill) {
        bill.amountDueCents = Math.max(0, bill.amountDueCents - cents(alloc.amount));
        bill.status = bill.amountDueCents === 0 ? 'PAID' : 'PART_PAID';
      }
    }
    store.openBills = bills;
    save(store);
    return { id: uid() };
  }

  if (p === '/v1/collections/overdue') {
    const t = today();
    const rows = (store.openInvoices ?? seedOpenInvoices())
      .filter((i) => i.amountDueCents > 0 && i.dueDate < t);
    return {
      overdue: rows.map((i) => ({
        invoiceId: i.id, invoiceNo: i.invoiceNo, contactName: i.contactName,
        dueDate: i.dueDate, amountDue: dec(i.amountDueCents), currency: 'MYR',
        daysOverdue: Math.round((Date.parse(t) - Date.parse(i.dueDate)) / 86_400_000),
        highestTierRaised: i.highestTierRaised,
        queuedReminders: (store.reminders ?? []).filter(
          (r) => r.invoiceId === i.id && r.status === 'QUEUED').length,
      })),
    };
  }
  if (p === '/v1/collections/run' && method === 'POST') {
    const t = today();
    const reminders = store.reminders ?? [];
    let queued = 0;
    for (const inv of (store.openInvoices ?? seedOpenInvoices())) {
      if (inv.amountDueCents === 0 || inv.dueDate >= t) continue;
      if (reminders.some((r) => r.invoiceId === inv.id && r.status === 'QUEUED')) continue;
      const daysOverdue = Math.round((Date.parse(t) - Date.parse(inv.dueDate)) / 86_400_000);
      const tier = daysOverdue >= 14 ? 3 : daysOverdue >= 7 ? 2 : daysOverdue >= 3 ? 1 : 0;
      if (tier === 0 || tier <= inv.highestTierRaised) continue;
      const tone = tier === 3 ? 'OWNER_ALERT' : tier === 2 ? 'FIRM' : 'FRIENDLY';
      reminders.push({
        id: uid(), invoiceId: inv.id, invoiceNo: inv.invoiceNo, contactName: inv.contactName,
        tier, tone, status: 'QUEUED', amountDueCents: inv.amountDueCents, daysOverdue,
        message: tone === 'OWNER_ALERT'
          ? `⚠ ${inv.contactName} — invoice ${inv.invoiceNo} for RM ${dec(inv.amountDueCents)} is now ${daysOverdue} days overdue. Decide: call them, agree a payment plan, or hold further credit.`
          : `Hi ${inv.contactName}, this is Shah G Tech following up on invoice ${inv.invoiceNo} for RM ${dec(inv.amountDueCents)}, now ${daysOverdue} days past due. Please arrange payment this week. Terima kasih!`,
      });
      inv.highestTierRaised = tier;
      queued++;
    }
    store.reminders = reminders;
    save(store);
    return { queued, cancelledAsPaid: 0, ownerAlerts: reminders.filter((r) => r.tier === 3 && r.status === 'QUEUED').length };
  }
  if (p === '/v1/collections/reminders') {
    const status = url.searchParams.get('status');
    return {
      reminders: (store.reminders ?? [])
        .filter((r) => status === null || r.status === status)
        .map((r) => ({
          id: r.id, invoiceId: r.invoiceId, invoiceNo: r.invoiceNo,
          contactName: r.contactName, tier: r.tier, tone: r.tone, message: r.message,
          status: r.status, channel: null, queuedOn: today(),
          amountDue: dec(r.amountDueCents), currency: 'MYR', daysOverdue: r.daysOverdue,
        })),
    };
  }
  const reminderAction = /^\/v1\/collections\/reminders\/([^/]+)\/(sent|cancel)$/.exec(p);
  if (reminderAction && method === 'POST') {
    store.reminders = (store.reminders ?? []).map((r) =>
      r.id === reminderAction[1]
        ? { ...r, status: reminderAction[2] === 'sent' ? 'SENT' : 'CANCELLED' }
        : r,
    );
    save(store);
    return { id: reminderAction[1]!, status: reminderAction[2] === 'sent' ? 'SENT' : 'CANCELLED' };
  }

  if (p === '/v1/approvals') return { pending: [] };

  const creditMatch = /^\/v1\/invoices\/([^/]+)\/credit-note$/.exec(p);
  if (creditMatch && method === 'POST') {
    const invoices = store.openInvoices ?? seedOpenInvoices();
    const inv = invoices.find((i) => i.id === creditMatch[1]);
    if (inv) {
      inv.amountDueCents = 0;
      inv.status = 'CREDITED';
    }
    store.openInvoices = invoices;
    save(store);
    return { id: uid(), creditNoteNo: 'CN-00001' };
  }

  const debitMatch = /^\/v1\/bills\/([^/]+)\/debit-note$/.exec(p);
  if (debitMatch && method === 'POST') {
    const bills = store.openBills ?? seedOpenBills();
    const bill = bills.find((x) => x.id === debitMatch[1]);
    if (bill) {
      bill.amountDueCents = 0;
      bill.status = 'CREDITED';
    }
    store.openBills = bills;
    save(store);
    return { id: uid(), debitNoteNo: 'DN-00001' };
  }

  if (p === '/v1/reports/sopl') {
    return {
      lines: [
        { label: 'Revenue', level: 0, lineType: 'HEADER', amount: '0.0000' },
        { label: 'Sales Revenue', level: 1, lineType: 'DETAIL', amount: '54230.0000' },
        { label: 'Total revenue', level: 0, lineType: 'SUBTOTAL', amount: '54230.0000' },
        { label: 'Cost of sales', level: 1, lineType: 'DETAIL', amount: '37960.0000' },
        { label: 'Gross profit', level: 0, lineType: 'SUBTOTAL', amount: '16270.0000' },
        { label: 'Expenses', level: 0, lineType: 'HEADER', amount: '0.0000' },
        { label: 'Rent', level: 1, lineType: 'DETAIL', amount: '3000.0000' },
        { label: 'Utilities', level: 1, lineType: 'DETAIL', amount: '742.0000' },
        { label: 'Internet & Phone', level: 1, lineType: 'DETAIL', amount: '258.0000' },
        { label: 'Profit for the period', level: 0, lineType: 'TOTAL', amount: '12270.0000' },
      ],
    };
  }
  if (p === '/v1/reports/sofp') {
    return {
      lines: [
        { label: 'Assets', level: 0, lineType: 'HEADER', amount: '0.0000' },
        { label: 'Cash and Bank', level: 1, lineType: 'DETAIL', amount: '18540.0000' },
        { label: 'Trade Receivables', level: 1, lineType: 'DETAIL', amount: '8080.0000' },
        { label: 'Inventory on Hand', level: 1, lineType: 'DETAIL', amount: '22740.0000' },
        { label: 'Total assets', level: 0, lineType: 'SUBTOTAL', amount: '49360.0000' },
        { label: 'Liabilities', level: 0, lineType: 'HEADER', amount: '0.0000' },
        { label: 'Trade Payables', level: 1, lineType: 'DETAIL', amount: '600.0000' },
        { label: 'Equity', level: 0, lineType: 'HEADER', amount: '0.0000' },
        { label: 'Retained Earnings', level: 1, lineType: 'DETAIL', amount: '48760.0000' },
        { label: 'Liabilities and equity', level: 0, lineType: 'TOTAL', amount: '49360.0000' },
      ],
    };
  }
  if (p === '/v1/reports/trial-balance') {
    return {
      rows: [
        { accountId: 'acc-1000', code: '1000', name: 'Cash and Bank', type: 'ASSET', debit: '18540.0000', credit: '0.0000' },
        { accountId: 'acc-1100', code: '1100', name: 'Trade Receivables', type: 'ASSET', debit: '8080.0000', credit: '0.0000' },
        { accountId: 'acc-1300', code: '1300', name: 'Inventory on Hand', type: 'ASSET', debit: '22740.0000', credit: '0.0000' },
        { accountId: 'acc-2000', code: '2000', name: 'Trade Payables', type: 'LIABILITY', debit: '0.0000', credit: '600.0000' },
        { accountId: 'acc-4000', code: '4000', name: 'Sales Revenue', type: 'INCOME', debit: '0.0000', credit: '54230.0000' },
        { accountId: 'acc-5000', code: '5000', name: 'Cost of Sales', type: 'EXPENSE', debit: '37960.0000', credit: '0.0000' },
        { accountId: 'acc-3000', code: '3000', name: 'Retained Earnings', type: 'EQUITY', debit: '0.0000', credit: '32490.0000' },
      ],
      totalDebit: '87320.0000',
      totalCredit: '87320.0000',
      balanced: true,
    };
  }

  const reconMatch = /^\/v1\/bank-accounts\/([^/]+)\/reconciliation$/.exec(p);
  if (reconMatch && method === 'GET') {
    const unmatched = (store.bankLines ?? seedBankLines())
      .filter((l) => l.status === 'UNRECONCILED');
    const reconciles = unmatched.length === 0;
    return {
      asOfDate: today(),
      adjustedBankBalance: '18540.0000',
      adjustedBookBalance: reconciles ? '18540.0000' : '17465.0000',
      variance: reconciles ? '0.0000' : '1075.0000',
      reconciles,
      unpresentedPayments: '0.0000',
      depositsInTransit: '0.0000',
      unrecordedBankMovement: reconciles ? '0.0000' : '1075.0000',
      counts: { unpresented: 0, unrecorded: unmatched.length },
      invariantEight: { holds: reconciles, fullyReconciled: reconciles,
                        expected: '18540.0000', actual: '18540.0000' },
    };
  }
  if (reconMatch && method === 'POST') {
    return { id: uid(), status: 'COMPLETED', variance: '0.0000' };
  }

  if (p === '/v1/organisation') {
    return {
      id: 'demo-tenant', name: store.orgName ?? 'Shah G Tech',
      baseCurrency: 'MYR', reportingFramework: 'MPERS',
    };
  }
  if (p === '/v1/tax-codes' && method === 'GET') {
    return { taxCodes: store.taxCodes ?? DEMO_TAX_CODES };
  }
  if (p === '/v1/tax-codes' && method === 'POST') {
    const input = b as DemoTaxCode;
    const taxCode: DemoTaxCode = { ...input, id: uid() };
    store.taxCodes = [...(store.taxCodes ?? DEMO_TAX_CODES), taxCode];
    save(store);
    return { id: taxCode.id };
  }
  if (p === '/v1/accounts' && method === 'POST') {
    const input = b as { code: string; name: string; type: string };
    const account = { id: uid(), code: input.code, name: input.name, type: input.type };
    store.extraAccounts = [...(store.extraAccounts ?? []), account];
    save(store);
    return { id: account.id };
  }

  // ---- banking -------------------------------------------------------------
  if (p === '/v1/accounts') return { accounts: [...ACCOUNTS, ...(store.extraAccounts ?? [])] };

  if (p === '/v1/bank-accounts' && method === 'GET') {
    return { bankAccounts: store.bankAccounts ?? DEMO_BANK };
  }
  if (p === '/v1/bank-accounts' && method === 'POST') {
    const input = b as { name: string; bankName: string; glAccountId: string };
    const account: DemoBankAccount = {
      id: uid(), name: input.name, bankName: input.bankName, currency: 'MYR',
      glAccountId: input.glAccountId, accountType: 'BANK', isActive: true,
    };
    store.bankAccounts = [...(store.bankAccounts ?? DEMO_BANK), account];
    save(store);
    return { id: account.id };
  }

  const bankTxnsMatch = /^\/v1\/bank-accounts\/([^/]+)\/transactions$/.exec(p);
  if (bankTxnsMatch) {
    const lines = (store.bankLines ?? seedBankLines())
      .filter((l) => l.bankAccountId === bankTxnsMatch[1] && l.status === 'UNRECONCILED');
    return {
      asOfDate: today(),
      bookBalance: '18540.0000',
      transactions: lines.map((l) => ({
        id: l.id, bankAccountId: l.bankAccountId, txnDate: l.txnDate,
        description: l.description, reference: l.reference,
        amount: { amount: dec(l.amountCents), currency: 'MYR' }, status: l.status,
      })),
    };
  }

  const previewMatch = /^\/v1\/bank-accounts\/([^/]+)\/statements\/preview$/.exec(p);
  if (previewMatch) {
    const input = b as { content: string; format?: string; profile: Parameters<typeof demoParseCsv>[1] };
    const rows = input.format === 'ADVICE'
      ? demoParseAdvice(input.content)
      : demoParseCsv(input.content, input.profile);
    return {
      rows: rows.map((r) => ({
        txnDate: r.txnDate, description: r.description,
        amount: dec(r.amountCents), duplicate: false,
      })),
      violations: rows.length === 0 ? [{ line: 1, problem: 'No rows could be read' }] : [],
    };
  }

  const importMatch = /^\/v1\/bank-accounts\/([^/]+)\/statements$/.exec(p);
  if (importMatch && method === 'POST') {
    const input = b as { content: string; format?: string; profile: Parameters<typeof demoParseCsv>[1] };
    const rows = input.format === 'ADVICE'
      ? demoParseAdvice(input.content)
      : demoParseCsv(input.content, input.profile);
    if (rows.length === 0) throw { status: 422, body: { message: 'No rows could be read from this file. Check the settings against a preview.' } };

    const lines = store.bankLines ?? seedBankLines();
    const fresh = rows.map((r): DemoBankLine => ({
      id: uid(), bankAccountId: importMatch[1]!, txnDate: r.txnDate,
      description: r.description, reference: null, amountCents: r.amountCents,
      status: 'UNRECONCILED',
    }));
    store.bankLines = [...lines, ...fresh];

    // Auto-apply rules, exactly like the real import response.
    const rules = (store.bankRules ?? []).filter((r) => r.isActive && r.autoApply);
    const applied: { ruleName: string; amount: string }[] = [];
    for (const line of fresh) {
      const hit = rules.find((r) =>
        r.contains !== null && line.description.toUpperCase().includes(r.contains.toUpperCase()),
      );
      if (hit) {
        line.status = 'MATCHED';
        hit.hitCount += 1;
        applied.push({ ruleName: hit.name, amount: dec(line.amountCents) });
      }
    }
    const suggestOnly = (store.bankRules ?? []).filter((r) => r.isActive && !r.autoApply);
    const suggested = fresh.filter((l) =>
      l.status === 'UNRECONCILED' &&
      suggestOnly.some((r) => r.contains !== null &&
        l.description.toUpperCase().includes(r.contains.toUpperCase())),
    ).length;
    save(store);

    return {
      id: uid(), imported: fresh.length, duplicates: 0, violations: [],
      openingBalance: null, closingBalance: null, replayed: false,
      autoCategorised: applied, ruleSuggestions: suggested,
    };
  }

  const suggestMatch = /^\/v1\/bank-accounts\/([^/]+)\/suggestions$/.exec(p);
  if (suggestMatch) {
    const byId = (id: string, suggestions: SuggestionEntry['suggestions']): SuggestionEntry | null => {
      const line = (store.bankLines ?? seedBankLines()).find((l) => l.id === id && l.status === 'UNRECONCILED');
      return line ? { bankTransactionId: id, suggestions } : null;
    };
    const lines = [
      // The plain case: one bank line, one invoice, matched on amount and reference.
      byId('bl-1', [{
        candidateIds: ['oi-1'], kind: 'INVOICE', confidence: 96,
        reason: 'Amount matches exactly and the narrative quotes invoice INV-00042 for Nusantara Retail Sdn Bhd',
        amountDifference: '0.0000', dayDifference: 0,
      }]),
      // The one-to-many case: one transfer, several invoices from the same
      // customer settled together — this is what "Confirm split" is for.
      byId('bl-3', [{
        candidateIds: ['oi-1', 'oi-3'], kind: 'INVOICE', confidence: 82,
        reason: 'Amount matches the sum of two open invoices for Nusantara Retail Sdn Bhd, both quoted in the narrative',
        amountDifference: '0.0000', dayDifference: 0,
      }]),
    ].filter((l): l is SuggestionEntry => l !== null);

    return { lines };
  }

  const matchLineMatch = /^\/v1\/bank-transactions\/([^/]+)\/(match|journal)$/.exec(p);
  if (matchLineMatch && method === 'POST') {
    const lines = store.bankLines ?? seedBankLines();
    const line = lines.find((l) => l.id === matchLineMatch[1]);
    if (line) line.status = 'MATCHED';
    store.bankLines = lines;
    save(store);
    return matchLineMatch[2] === 'match' ? { id: uid() } : { journalEntryId: uid(), matchId: uid() };
  }

  if (p === '/v1/bank-rules' && method === 'GET') {
    return { rules: store.bankRules ?? [] };
  }
  if (p === '/v1/bank-rules' && method === 'POST') {
    const input = b as { name: string; contains: string; accountId: string; autoApply?: boolean };
    if (input.contains.trim().length < 3) {
      throw { status: 422, body: { message: 'The match text must be at least 3 characters — shorter patterns match far too much.' } };
    }
    const account = ACCOUNTS.find((a) => a.id === input.accountId);
    const rule: DemoBankRule = {
      id: uid(), name: input.name, contains: input.contains.trim(),
      matchesDirection: null, accountId: input.accountId,
      accountName: account?.name ?? 'Account', autoApply: input.autoApply ?? false,
      isActive: true, hitCount: 0,
    };
    store.bankRules = [...(store.bankRules ?? []), rule];
    save(store);
    return { id: rule.id };
  }
  if (p === '/v1/bank-rules/run' && method === 'POST') {
    const lines = store.bankLines ?? seedBankLines();
    const rules = (store.bankRules ?? []).filter((r) => r.isActive && r.autoApply);
    const applied: { ruleName: string; amount: string }[] = [];
    for (const line of lines) {
      if (line.status !== 'UNRECONCILED') continue;
      const hit = rules.find((r) =>
        r.contains !== null && line.description.toUpperCase().includes(r.contains.toUpperCase()),
      );
      if (hit) {
        line.status = 'MATCHED';
        hit.hitCount += 1;
        applied.push({ ruleName: hit.name, amount: dec(line.amountCents) });
      }
    }
    store.bankLines = lines;
    save(store);
    return { applied, suggestedOnly: 0 };
  }
  const rulePatchMatch = /^\/v1\/bank-rules\/([^/]+)$/.exec(p);
  if (rulePatchMatch && method === 'POST') {
    const patch = b as { isActive?: boolean; autoApply?: boolean };
    store.bankRules = (store.bankRules ?? []).map((r) =>
      r.id === rulePatchMatch[1]
        ? { ...r, isActive: patch.isActive ?? r.isActive, autoApply: patch.autoApply ?? r.autoApply }
        : r,
    );
    save(store);
    return { updated: true };
  }

  /*
   * Credit notes. The demo store issues none, so the honest answer is an empty
   * list — and the card hides itself on an empty list rather than inventing a
   * credit against an invoice the demo never credited.
   */
  if (p === '/v1/credit-notes' && method === 'GET') return { creditNotes: [] };

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
  /*
   * The promises register. The demo store has no serialised sales, so the
   * honest answer is an empty register — the card hides itself on an empty
   * list rather than showing a fabricated warranty, and a lookup answers
   * "no record", which is what the real route says for an unknown serial.
   */
  if (p === '/v1/stock/warranties') {
    return {
      today: new Date().toISOString().slice(0, 10),
      promises: [], active: 0, expiringSoon: 0, expiringSoonDays: 30,
    };
  }
  const warrantyMatch = /^\/v1\/stock\/warranties\/([^/]+)$/.exec(p);
  if (warrantyMatch) {
    return { serialNo: decodeURIComponent(warrantyMatch[1]!).toUpperCase(), promise: null };
  }

  // ---- the letterhead ------------------------------------------------------
  // The static demo stores no image bytes (see the repair photos above), so it
  // answers "no logo" honestly rather than 404ing the Settings card.
  if (p === '/v1/organisations/logo' && method === 'GET') {
    throw demoError(204, 'This organisation has no logo.');
  }
  if (p === '/v1/organisations/brand') {
    throw demoError(
      501,
      'Logos are stored by the real server; the static demo keeps nothing but the text ' +
        'you can see.',
    );
  }

  // ---- repairs -------------------------------------------------------------
  if (p === '/v1/repairs' && method === 'GET') return { jobs: store.jobs };
  if (p === '/v1/repairs' && method === 'POST') {
    const input = b as { deviceDescription: string; deviceSerial?: string; reportedFault: string; receivedOn: string; contactId: string; accessories?: string[] };
    const job: DemoJob = {
      id: uid(), jobNo: `JOB-${String(store.jobSeq++).padStart(5, '0')}`,
      contactId: input.contactId, deviceDescription: input.deviceDescription,
      deviceSerial: input.deviceSerial ?? null, reportedFault: input.reportedFault,
      diagnosis: null, status: 'RECEIVED', approvalNote: null, closedReason: null,
      invoiceId: null, receivedOn: input.receivedOn, collectedOn: null,
      accessories: input.accessories ?? [], lines: [],
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

    // Photographs are answered as an empty set rather than a 404. The static
    // demo has no way to store image bytes, and an error banner on a tour is
    // worse than a card that honestly shows nothing — the card's own empty
    // state already explains what the feature is for.
    if (action === '/photos' && method === 'GET') return { photos: [] };

    // A signature, like a photograph, is image bytes — and for the same reason
    // the static demo cannot hold one. Said plainly rather than by 404, because
    // the person tapping the pad has just drawn their name on it.
    if (action === '/photos' && method === 'POST') {
      throw demoError(
        501,
        'Photographs and signatures are stored by the real server; the static demo ' +
          'keeps nothing but the text you can see.',
      );
    }

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

  // ---- journals, audit, periods — sample data like the reports -------------

  if (p === '/v1/reports/journal') {
    const manual = store.manualJournals ?? [];
    const entries = [
      ...manual,
      {
        entryId: 'demo-je-2', entryNo: 'JE-000102', entryDate: daysFromToday(-1),
        description: 'Cash sale INV-00087', sourceModule: 'SALES', status: 'POSTED', reversalOfId: null,
        lines: [
          { accountCode: '1000', accountName: 'Cash and Bank', description: null, debit: '450.0000', credit: '0.0000' },
          { accountCode: '4000', accountName: 'Sales Revenue', description: null, debit: '0.0000', credit: '450.0000' },
        ],
        totalDebit: '450.0000', totalCredit: '450.0000',
      },
      {
        entryId: 'demo-je-1', entryNo: 'JE-000101', entryDate: daysFromToday(-2),
        description: 'Stock received from Delima Networks', sourceModule: 'PURCHASES', status: 'POSTED', reversalOfId: null,
        lines: [
          { accountCode: '1300', accountName: 'Inventory', description: null, debit: '2400.0000', credit: '0.0000' },
          { accountCode: '2000', accountName: 'Accounts Payable', description: null, debit: '0.0000', credit: '2400.0000' },
        ],
        totalDebit: '2400.0000', totalCredit: '2400.0000',
      },
    ];
    const module = url.searchParams.get('sourceModule');
    return { entries: module ? entries.filter((e) => e.sourceModule === module) : entries, truncated: false };
  }

  if (p === '/v1/opening-balances/accounts') {
    return {
      statable: [...ACCOUNTS, ...(store.extraAccounts ?? [])]
        .filter((a) => ['ASSET', 'LIABILITY', 'EQUITY'].includes(a.type))
        // 3100 is where the difference LANDS, so it can never be stated as a
        // balance — the real read model drops it for the same reason, and the
        // demo has to agree or it teaches the wrong thing. 1300 Inventory is
        // control-owned and appears in the refused list below instead.
        .filter((a) => a.code !== '3100' && a.code !== '1300'),
      controlled: [
        { code: '1100', name: 'Accounts Receivable', role: 'AR',
          guidance: 'Money customers already owe you is entered as the unpaid invoices themselves, on the Sales screen — otherwise there is no invoice to settle when they pay.' },
        { code: '2000', name: 'Accounts Payable', role: 'AP',
          guidance: 'Money you already owe suppliers is entered as the unpaid bills themselves, on the Purchases screen — otherwise there is no bill to pay.' },
        { code: '1300', name: 'Inventory on Hand', role: 'INVENTORY',
          guidance: 'Stock already on the shelf is entered as a stock adjustment per item, on the Stock screen — that is also what establishes each item’s average cost, which the first sale needs.' },
      ],
      equityCode: '3100',
    };
  }

  if (p === '/v1/opening-balances' && method === 'POST') {
    const input = b as { balances: { accountId: string; amount: string }[] };
    const all = [...ACCOUNTS, ...(store.extraAccounts ?? [])];
    let debits = 0;
    let credits = 0;
    for (const balance of input.balances) {
      const account = all.find((a) => a.id === balance.accountId);
      if (!account) throw demoError(404, `No account ${balance.accountId}`);
      const amount = cents(balance.amount);
      if (account.type === 'ASSET') debits += amount;
      else credits += amount;
    }
    const difference = debits - credits;
    store.openingPosted = true;
    save(store);
    return {
      journalEntryId: uid(),
      entryNo: `JE-${String(store.journalSeq ?? 103).padStart(6, '0')}`,
      balancingFigure: dec(Math.abs(difference)),
      balancingSide: difference < 0 ? 'DEBIT' : 'CREDIT',
      replayed: false,
    };
  }

  if (p === '/v1/opening-balances/gaps') {
    // The seeded demo bank account carries no opening balance, so there is
    // nothing to warn about — which is also the correct steady state.
    return { gaps: [] };
  }

  if (p === '/v1/journals/suggest-pair') {
    // The demo has no real posting history to mine, so it answers with the
    // one pairing the seeded sample data actually shows — Rent paid from
    // Cash and Bank — and nothing for any other account, same honesty as the
    // real endpoint returning null when it has never seen the pair.
    const accountId = url.searchParams.get('accountId');
    const side = url.searchParams.get('side');
    if (accountId === 'acc-6200' && side === 'DEBIT') {
      return { suggestion: { accountId: 'acc-1000', code: '1000', name: 'Cash and Bank', occurrences: 3 } };
    }
    if (accountId === 'acc-1000' && side === 'CREDIT') {
      return { suggestion: { accountId: 'acc-6200', code: '6200', name: 'Rent', occurrences: 3 } };
    }
    return { suggestion: null };
  }

  if (p === '/v1/journals' && method === 'POST') {
    const input = b as {
      entryDate: string; description?: string;
      lines: { accountId: string; side: 'DEBIT' | 'CREDIT'; amount: string }[];
    };
    const debits = input.lines.filter((l) => l.side === 'DEBIT').reduce((s, l) => s + cents(l.amount), 0);
    const credits = input.lines.filter((l) => l.side === 'CREDIT').reduce((s, l) => s + cents(l.amount), 0);
    if (debits !== credits) {
      throw demoError(422, `The journal entry is not valid: debits RM ${dec(debits)} do not equal credits RM ${dec(credits)}`);
    }
    const accountName = (id: string) =>
      [...ACCOUNTS, ...(store.extraAccounts ?? [])].find((a) => a.id === id) ??
      { code: '????', name: 'Account' };
    const entryNo = `JE-${String(store.journalSeq ?? 103).padStart(6, '0')}`;
    store.journalSeq = (store.journalSeq ?? 103) + 1;
    store.manualJournals = [
      {
        entryId: uid(), entryNo, entryDate: input.entryDate,
        description: input.description ?? null, sourceModule: 'MANUAL', status: 'POSTED', reversalOfId: null,
        lines: input.lines.map((l) => ({
          accountCode: accountName(l.accountId).code, accountName: accountName(l.accountId).name,
          description: null,
          debit: l.side === 'DEBIT' ? dec(cents(l.amount)) : '0.0000',
          credit: l.side === 'CREDIT' ? dec(cents(l.amount)) : '0.0000',
        })),
        totalDebit: dec(debits), totalCredit: dec(credits),
      },
      ...(store.manualJournals ?? []),
    ];
    save(store);
    return { entryNo, replayed: false };
  }

  if (p === '/v1/audit-chain/verify') {
    return { intact: true, entries: 214, breaks: [] };
  }

  if (p === '/v1/audit') {
    const entries = [
      { id: '214', action: 'CREATE', entityType: 'payment', entityId: uid(), actorEmail: 'boss@shahgtech.my', actorIp: '175.139.1.20', occurredAt: `${today()}T14:05:00Z`, changed: [] },
      { id: '213', action: 'UPDATE', entityType: 'invoice', entityId: uid(), actorEmail: 'boss@shahgtech.my', actorIp: '175.139.1.20', occurredAt: `${today()}T14:05:00Z`, changed: ['status', 'amount_due'] },
      { id: '212', action: 'CREATE', entityType: 'journal_entry', entityId: uid(), actorEmail: 'cashier@shahgtech.my', actorIp: '175.139.1.21', occurredAt: `${today()}T11:32:00Z`, changed: [] },
      { id: '211', action: 'UPDATE', entityType: 'repair_job', entityId: uid(), actorEmail: 'tech1@shahgtech.my', actorIp: '175.139.1.22', occurredAt: `${daysFromToday(-1)}T16:40:00Z`, changed: ['status'] },
      { id: '210', action: 'UPDATE', entityType: 'item', entityId: uid(), actorEmail: 'boss@shahgtech.my', actorIp: '175.139.1.20', occurredAt: `${daysFromToday(-1)}T10:12:00Z`, changed: ['sale_unit_price'] },
      { id: '209', action: 'CREATE', entityType: 'contact', entityId: uid(), actorEmail: 'cashier@shahgtech.my', actorIp: '175.139.1.21', occurredAt: `${daysFromToday(-2)}T09:03:00Z`, changed: [] },
    ];
    const action = url.searchParams.get('action');
    const entityType = url.searchParams.get('entityType');
    return {
      entries: entries
        .filter((e) => !action || e.action === action)
        .filter((e) => !entityType || e.entityType.includes(entityType.toLowerCase())),
      nextCursor: null,
    };
  }

  if (p === '/v1/periods') {
    return { periods: store.periods ?? seedPeriods() };
  }

  const periodStatus = /^\/v1\/periods\/([^/]+)\/status$/.exec(p);
  if (periodStatus && method === 'POST') {
    const input = b as { status: 'OPEN' | 'CLOSED' | 'LOCKED' };
    const periods = store.periods ?? seedPeriods();
    const period = periods.find((x) => x.id === periodStatus[1]);
    if (!period) throw demoError(404, 'Period not found');
    period.status = input.status;
    store.periods = periods;
    save(store);
    return period as unknown as Record<string, unknown>;
  }

  if (p === '/v1/fiscal-years') {
    const open = (store.periods ?? seedPeriods()).filter((x) => x.status === 'OPEN').length;
    return {
      fiscalYears: [{
        id: 'fy-2026', label: 'FY2026', startDate: '2026-01-01', endDate: '2026-12-31',
        status: store.fyClosed ? 'CLOSED' : 'OPEN', closedAt: null, closingEntryId: null, openPeriods: open,
      }],
    };
  }

  if (/^\/v1\/fiscal-years\/[^/]+\/close$/.test(p) && method === 'POST') {
    store.fyClosed = true;
    store.periods = (store.periods ?? seedPeriods()).map((x) => ({ ...x, status: 'LOCKED' as const }));
    save(store);
    return { closed: true };
  }

  if (/^\/v1\/fiscal-years\/[^/]+\/reopen$/.test(p) && method === 'POST') {
    store.fyClosed = false;
    save(store);
    return { reopened: true };
  }

  if (p === '/v1/reports/cash-flow' && method === 'GET') {
    return {
      periodStart: url.searchParams.get('from'), periodEnd: url.searchParams.get('to'), currency: 'MYR',
      sections: [
        {
          activity: 'OPERATING', subtotal: '8420.0000',
          lines: [
            { accountId: 'a1', code: '4000', name: 'Sales Revenue', amount: '12076.0000', entryCount: 31 },
            { accountId: 'a2', code: '5000', name: 'Cost of Sales', amount: '-2400.0000', entryCount: 6 },
            { accountId: 'a3', code: '6000', name: 'Rent & utilities', amount: '-1256.0000', entryCount: 3 },
          ],
        },
        { activity: 'INVESTING', subtotal: '0.0000', lines: [] },
        { activity: 'FINANCING', subtotal: '0.0000', lines: [] },
        { activity: 'UNCLASSIFIED', subtotal: '0.0000', lines: [] },
      ],
      netCashFlow: '8420.0000', openingCash: '10120.0000', closingCash: '18540.0000',
      entryCount: 40, unclassifiedAccounts: [],
      reconciles: true, difference: '0.0000', violations: [], rollupAgrees: true, rollupClosingCash: '18540.0000',
    };
  }

  if (p === '/v1/reports/changes-in-equity') {
    return {
      periodStart: url.searchParams.get('from'), periodEnd: url.searchParams.get('to'), currency: 'MYR',
      components: [
        { kind: 'ACCOUNT', key: 'sc', code: '3100', label: 'Share capital', opening: '10000.0000', movement: '0.0000', closing: '10000.0000' },
        { kind: 'RETAINED', key: 're', code: '3000', label: 'Retained earnings', opening: '21340.0000', movement: '3552.0000', closing: '24892.0000' },
      ],
      openingEquity: '31340.0000', profitForPeriod: '3552.0000', otherMovements: '0.0000',
      closingEquity: '34892.0000', consistent: true, violations: [],
    };
  }

  // ---- assistant -----------------------------------------------------------
  //
  // Canned and CLEARLY LABELLED as such. The real assistant is a model on the
  // server with tools scoped to the caller's permissions; a static page has
  // neither, and a demo that faked open-ended intelligence would be a lie.

  if (p === '/v1/assistant/status') {
    return { configured: true, provider: 'demo' };
  }

  if (p === '/v1/assistant/chat' && method === 'POST') {
    const { messages } = b as { messages: { role: string; content: string }[] };
    const last = messages.at(-1)?.content ?? '';
    const t = today();
    const daySales = store.sales.filter((s) => s.date === t);
    const takings = daySales.reduce((sum, s) => sum + s.totalCents, 0);
    const overdueRows = (store.openInvoices ?? seedOpenInvoices())
      .filter((i) => i.amountDueCents > 0 && i.dueDate < t);
    const owed = overdueRows.reduce((sum, i) => sum + i.amountDueCents, 0);

    // Two decimals with thousands grouping — chat text, same rules as rm().
    const fmt = (c: number) => {
      const [whole = '0', fraction = ''] = dec(c).split('.');
      return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction.padEnd(2, '0').slice(0, 2)}`;
    };

    const evaluation =
      `Today so far: ${daySales.length} sale(s) for RM ${fmt(takings)}. ` +
      (overdueRows.length > 0
        ? `RM ${fmt(owed)} is overdue across ${overdueRows.length} invoice(s) — ` +
          `${overdueRows.map((i) => i.contactName).join(' and ')}. ` +
          'Worth a WhatsApp from the Collections screen. '
        : 'Nothing is overdue. ') +
      'The bank holds RM 18,540.00 and the 30-day forecast stays positive.';

    const message = /how do i|how to|macam ?mana|guna/i.test(last)
      ? 'The "How to use" guide at the top of this panel covers the open screen, step by step. ' +
        'Ask me about your numbers, or try "add item…" once the real server is connected.\n\n' +
        '(Sample reply — the live assistant runs on the real server with ANTHROPIC_API_KEY set.)'
      : evaluation +
        '\n\n(Sample reply from demo data — the live assistant runs on the real server ' +
        'with ANTHROPIC_API_KEY set, and can also record items and draft sales from ' +
        'plain words.)';

    return { configured: true, message, actions: [], drafts: [] };
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
