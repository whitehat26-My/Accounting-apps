import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { encodeQr } from '@emil/domain';
import type { RenderedReport } from '@emil/domain';
import type {
  CustomerStatement,
  EaDocument,
  InvoiceDocument,
  PayslipDocument,
  ReceiptDocument,
} from '@emil/db';

/**
 * What a document needs to carry its own proof: the digest of its figures and
 * where to check it. Optional at every call site — a renderer with no
 * verification simply prints no block, which is what keeps the statement and
 * payslip renderers unchanged.
 */
export interface DocumentVerification {
  readonly digest: string;
  readonly verifyUrl: string;
}

/**
 * PDF rendering — presentation, nothing else.
 *
 * Display rules live here because this is the display: dates are DD/MM/YYYY
 * (CLAUDE.md rule 8) and amounts are RM with thousands separators, both
 * conversions from the wire formats (ISO dates, plain decimal strings) that
 * every other layer keeps.
 *
 * `compress: false` on purpose: the byte-size cost on a one-page invoice is
 * trivial, and it keeps the text streams greppable — which is what lets the
 * e2e suite assert "the invoice number is IN the document" rather than only
 * "some PDF came back".
 */

const MARGIN = 50;
const LINE = 16;

export function renderInvoicePdf(
  doc: InvoiceDocument,
  verification?: DocumentVerification,
): Promise<Buffer> {
  return build((pdf) => {
    header(pdf, doc.seller, doc.status === 'PAID' ? 'INVOICE (PAID)' : 'INVOICE');

    pair(pdf, 'Invoice no', doc.invoiceNo);
    pair(pdf, 'Invoice date', displayDate(doc.issueDate));
    pair(pdf, 'Due date', displayDate(doc.dueDate));
    if (doc.reference) pair(pdf, 'Reference', doc.reference);

    pdf.moveDown(0.5);
    pair(pdf, 'Bill to', doc.customer.name);
    if (doc.customer.tin) pair(pdf, 'Customer TIN', doc.customer.tin);
    pdf.moveDown(1);

    // ---- Lines table -------------------------------------------------------
    const cols = { description: MARGIN, qty: 300, price: 360, tax: 430, total: 495 };
    const right = 545;

    pdf.font('Helvetica-Bold').fontSize(9);
    pdf.text('Description', cols.description, pdf.y, { continued: false });
    const headerY = pdf.y - LINE + 4;
    pdf.text('Qty', cols.qty, headerY, { width: 50, align: 'right' });
    pdf.text('Unit price', cols.price, headerY, { width: 60, align: 'right' });
    pdf.text('Tax', cols.tax, headerY, { width: 55, align: 'right' });
    pdf.text('Total', cols.total, headerY, { width: right - cols.total, align: 'right' });
    rule(pdf);

    pdf.font('Helvetica').fontSize(9);
    for (const line of doc.lines) {
      const y = pdf.y;
      pdf.text(line.description, cols.description, y, { width: cols.qty - cols.description - 10 });
      const rowBottom = pdf.y;
      pdf.text(trimQty(line.quantity), cols.qty, y, { width: 50, align: 'right' });
      pdf.text(money(line.unitPrice), cols.price, y, { width: 60, align: 'right' });
      pdf.text(money(line.taxAmount), cols.tax, y, { width: 55, align: 'right' });
      pdf.text(money(line.lineTotal), cols.total, y, { width: right - cols.total, align: 'right' });
      pdf.y = Math.max(rowBottom, pdf.y) + 2;
    }
    rule(pdf);

    // ---- Totals ------------------------------------------------------------
    totalRow(pdf, 'Subtotal', doc.currency, doc.subtotal);
    totalRow(pdf, 'SST', doc.currency, doc.taxTotal);
    pdf.font('Helvetica-Bold');
    totalRow(pdf, 'Total', doc.currency, doc.total);
    if (doc.amountDue !== doc.total) {
      totalRow(pdf, 'Amount due', doc.currency, doc.amountDue);
    }
    pdf.font('Helvetica');

    if (verification) verificationBlock(pdf, verification);
    footer(pdf);
  });
}

export function renderReceiptPdf(
  doc: ReceiptDocument,
  verification?: DocumentVerification,
): Promise<Buffer> {
  return build((pdf) => {
    header(pdf, doc.seller, 'OFFICIAL RECEIPT');

    pair(pdf, 'Receipt no', doc.paymentNo);
    pair(pdf, 'Date', displayDate(doc.paymentDate));
    pair(pdf, 'Received from', doc.customer.name);
    pair(pdf, 'Payment method', doc.method);
    if (doc.reference) pair(pdf, 'Reference', doc.reference);
    pdf.moveDown(1);

    pdf.font('Helvetica-Bold').fontSize(12);
    pdf.text(`Amount received: ${doc.currency === 'MYR' ? 'RM ' : `${doc.currency} `}${money(doc.amount)}`, MARGIN, pdf.y);
    pdf.font('Helvetica').fontSize(9);
    pdf.moveDown(1);

    if (doc.allocations.length > 0) {
      pdf.text('Settling:', MARGIN, pdf.y);
      for (const allocation of doc.allocations) {
        pdf.text(
          `  ${allocation.invoiceNo}  —  ${money(allocation.amount)}`,
          MARGIN,
          pdf.y,
        );
      }
    }

    if (verification) verificationBlock(pdf, verification);
    footer(pdf);
  });
}


/**
 * The till receipt, on the paper tills actually use.
 *
 * ---------------------------------------------------------------------------
 * 80mm THERMAL, NOT A4.
 *
 * 80mm of printable width is ~227 PostScript points. The page HEIGHT is
 * computed from the content before drawing, because thermal paper is a roll:
 * the driver cuts where the page ends, and a fixed A4 height would feed half
 * a metre of blank paper after every sale.
 *
 * Same stored data as the A4 receipt — this is a different garment on the
 * same body, never a different document. No logo raster: a 203dpi thermal
 * head turns a scaled PNG into grey mud, so the shop's name is set in text,
 * which such printers render crisply.
 * ---------------------------------------------------------------------------
 */
export function renderThermalReceiptPdf(doc: ReceiptDocument): Promise<Buffer> {
  const WIDTH = 227; // 80mm
  const M = 10; // roll paper has no real margin to give
  const W = WIDTH - M * 2;

  /*
   * Height, estimated line-by-line BEFORE drawing. Generous rather than
   * exact — an extra 20pt of roll is invisible, a clipped total is a defect.
   */
  const lineCount =
    7 + // header block
    (doc.lines?.length ?? 0) * 2 + // description + qty/amount rows
    4 + // totals
    doc.allocations.length +
    6; // method, footer, breathing room
  const height = Math.max(280, 90 + lineCount * 12);

  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: [WIDTH, height], margin: M, compress: false });
    const chunks: Buffer[] = [];
    pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);

    const centre = (text: string) => pdf.text(text, M, pdf.y, { width: W, align: 'center' });
    const row = (label: string, value: string) => {
      const y = pdf.y;
      pdf.text(label, M, y, { width: W - 70 });
      pdf.text(value, WIDTH - M - 70, y, { width: 70, align: 'right' });
    };
    const dashed = () => {
      centre('- '.repeat(22).trim());
    };

    // ---- Shop ---------------------------------------------------------------
    pdf.font('Helvetica-Bold').fontSize(10);
    centre(doc.seller.name);
    pdf.font('Helvetica').fontSize(7);
    if (doc.seller.ssmRegistrationNo) centre(`SSM: ${doc.seller.ssmRegistrationNo}`);
    if (doc.seller.sstNo) centre(`SST No: ${doc.seller.sstNo}`);
    pdf.moveDown(0.4);
    dashed();

    pdf.fontSize(8);
    row(`Receipt ${doc.paymentNo}`, displayDate(doc.paymentDate));
    if (doc.customer.name !== 'Walk-in customer') row('Customer', '');
    if (doc.customer.name !== 'Walk-in customer') {
      pdf.text(doc.customer.name, M, pdf.y, { width: W });
    }
    dashed();

    // ---- What was bought ----------------------------------------------------
    if (doc.lines !== undefined && doc.lines.length > 0) {
      for (const line of doc.lines) {
        pdf.text(line.description, M, pdf.y, { width: W });
        row(`  ${trimQty(line.quantity)} x`, money(line.lineTotal));
      }
      dashed();
      if (doc.subtotal !== undefined) row('Subtotal', money(doc.subtotal));
      if (doc.taxTotal !== undefined) row('SST', money(doc.taxTotal));
    } else {
      // A settlement receipt: name the invoices it pays instead.
      for (const allocation of doc.allocations) {
        row(allocation.invoiceNo, money(allocation.amount));
      }
      dashed();
    }

    pdf.font('Helvetica-Bold').fontSize(10);
    row('TOTAL', `RM ${money(doc.amount)}`);
    pdf.font('Helvetica').fontSize(8);
    row('Paid by', doc.method);
    if (doc.reference) row('Ref', doc.reference);

    pdf.moveDown(0.6);
    dashed();
    pdf.fontSize(7);
    centre('Thank you!');
    centre('Computer-generated receipt.');

    pdf.end();
  });
}

/**
 * The EA data sheet — every figure the C.P.8A needs, from the year's
 * confirmed snapshots, and an honest banner about what it is not.
 *
 * The official form's PDF could not be retrieved in this environment, and
 * guessing an official layout is how forms end up rejected (or worse,
 * accepted with fields transposed). So this document states plainly that it
 * is the PREPARATION SHEET: the numbers, each labelled with where it goes,
 * to be transcribed onto the official C.P.8A / keyed into e-Filing.
 */
export function renderEaPdf(doc: EaDocument): Promise<Buffer> {
  return build((pdf) => drawEa(pdf, doc));
}

/** One employee per page — printed once, handed out with February's payslips. */
export function renderEaBookPdf(docs: readonly EaDocument[]): Promise<Buffer> {
  return build((pdf) => {
    docs.forEach((doc, index) => {
      if (index > 0) pdf.addPage();
      drawEa(pdf, doc);
    });
  });
}

function drawEa(pdf: PDFKit.PDFDocument, doc: EaDocument): void {
  header(pdf, doc.employer, `REMUNERATION ${doc.year}`);

  // ---- The banner: what this is, and is not ------------------------------
  const bannerY = pdf.y;
  pdf.rect(MARGIN, bannerY, 495, 30).fill('#FEF3C7');
  pdf.fillColor('#92400E').font('Helvetica-Bold').fontSize(8);
  pdf.text('PREPARATION SHEET FOR FORM C.P.8A (EA) — NOT THE OFFICIAL LHDN FORM', MARGIN + 10, bannerY + 6, { width: 475 });
  pdf.font('Helvetica').fontSize(7);
  pdf.text('Transcribe these figures onto the official C.P.8A or into MyTax e-Filing. Every amount is summed from this employer\u2019s confirmed pay runs.', MARGIN + 10, pdf.y + 1, { width: 475 });
  pdf.fillColor('#000000').fontSize(9);
  pdf.y = bannerY + 40;

  // ---- Part A-equivalent: who ---------------------------------------------
  sectionHeading(pdf, 'EMPLOYEE');
  const employee = doc.employee;
  pair(pdf, 'Name', employee.fullName);
  if (employee.employeeNo) pair(pdf, 'Staff no', employee.employeeNo);
  if (employee.idValue) pair(pdf, employee.idType === 'PASSPORT' ? 'Passport' : 'NRIC', employee.idValue);
  if (employee.tin) pair(pdf, 'Income tax no (TIN)', employee.tin);
  if (employee.jobTitle) pair(pdf, 'Position', employee.jobTitle);
  pair(
    pdf,
    'Employed (this year)',
    `${displayDate(employee.employedFrom)} \u2013 ${displayDate(employee.employedTo)} (${employee.monthsPaid} month${employee.monthsPaid === 1 ? '' : 's'} paid)`,
  );
  if (doc.lhdnEmployerNo) pair(pdf, 'Employer\u2019s E no', doc.lhdnEmployerNo);

  // ---- Part B-equivalent: gross remuneration ------------------------------
  pdf.moveDown(0.6);
  sectionHeading(pdf, 'GROSS REMUNERATION FROM THIS EMPLOYMENT');
  amountRow(pdf, 'Gross salary / wages', undefined, employee.wage);
  if (employee.bonus !== '0.0000') {
    amountRow(pdf, 'Bonus / additional remuneration', undefined, employee.bonus);
  }
  subtotalRow(pdf, 'Total gross remuneration', employee.grossRemuneration);

  // ---- Part D-equivalent: tax deducted ------------------------------------
  pdf.moveDown(0.6);
  sectionHeading(pdf, 'INCOME TAX DEDUCTED AND REMITTED (PCB / MTD)');
  amountRow(pdf, 'Monthly tax deductions for the year', 'via CP39', employee.pcb);

  // ---- Part E-equivalent: contributions -----------------------------------
  pdf.moveDown(0.6);
  sectionHeading(pdf, 'EMPLOYEE CONTRIBUTIONS DEDUCTED');
  amountRow(pdf, 'EPF (KWSP)', 'Third Schedule', employee.epfEmployee);
  amountRow(pdf, 'SOCSO (PERKESO)', 'incl. SKBBK', employee.socsoEmployee);
  amountRow(pdf, 'EIS', 'Act 800', employee.eisEmployee);

  // ---- What this sheet does not carry -------------------------------------
  if (pdf.y > 690) pdf.addPage();
  pdf.moveDown(0.8);
  pdf.fontSize(7.5).fillColor('#555555');
  for (const note of [
    'Not recorded by this system and therefore NOT included: benefits in kind, value of living accommodation, CP38 instalments, zakat paid through salary, tax-exempt allowances. If any apply, add them on the official form.',
    'Figures cover employment with the employer named above only. A previous employer issues their own statement for their part of the year.',
  ]) {
    pdf.text(note, MARGIN, pdf.y, { width: 495, lineGap: 1.5 });
  }
  pdf.fillColor('#000000');

  footer(pdf);
}

/**
 * A payslip.
 *
 * ---------------------------------------------------------------------------
 * THIS IS A STATEMENT GIVEN TO A PERSON ABOUT THEIR OWN PAY.
 *
 * Which changes what the page owes the reader. Every deduction names the
 * instrument it comes from — "Third Schedule, Part A", "Act 4, Category 1" —
 * so the figure can be checked against the authority's own tables rather than
 * taken on trust. SOCSO appears as two lines because it IS two contributions
 * and PERKESO's statement shows them apart; a combined figure would be
 * impossible to reconcile.
 *
 * The employer's contributions are printed too, under their own heading and
 * explicitly NOT deducted. They are not the employee's money and never touch
 * their pay, but they are part of what the job is worth, and a payslip that
 * hides them understates it by several hundred ringgit a month.
 * ---------------------------------------------------------------------------
 */
export function renderPayslipPdf(doc: PayslipDocument): Promise<Buffer> {
  return build((pdf) => drawPayslip(pdf, doc));
}

/**
 * Every payslip for one confirmed pay run, one per page, in a single file.
 *
 * The shop prints this once and hands out the pages. The alternative — a
 * button per person — is five downloads, five browser tabs and five files the
 * browser names itself, which is how a payslip ends up filed as
 * `download (3).pdf`.
 *
 * Each page is drawn by the same `drawPayslip` as the single-payslip route, so
 * the two can never drift into being two different documents.
 */
export function renderPayslipBookPdf(docs: readonly PayslipDocument[]): Promise<Buffer> {
  return build((pdf) => {
    docs.forEach((doc, index) => {
      if (index > 0) pdf.addPage();
      drawPayslip(pdf, doc);
    });
  });
}

function drawPayslip(pdf: PDFKit.PDFDocument, doc: PayslipDocument): void {
  {
    header(pdf, doc.employer, 'PAYSLIP');

    // ---- Who and when ------------------------------------------------------
    const topY = pdf.y;
    pdf.font('Helvetica-Bold').fontSize(11).text(doc.employee.name, MARGIN, topY);
    pdf.font('Helvetica').fontSize(9).fillColor('#555555');
    if (doc.employee.jobTitle) pdf.text(doc.employee.jobTitle, MARGIN, pdf.y);
    if (doc.employee.staffId) pdf.text(`Staff no: ${doc.employee.staffId}`, MARGIN, pdf.y);
    if (doc.employee.idNumber) pdf.text(`ID: ${doc.employee.idNumber}`, MARGIN, pdf.y);
    const leftBottom = pdf.y;

    pdf.fillColor('#555555').fontSize(8);
    pdf.text('PAY PERIOD', 380, topY, { width: 165, align: 'right', characterSpacing: 0.5 });
    pdf.fillColor('#000000').font('Helvetica-Bold').fontSize(11);
    pdf.text(doc.period, 380, pdf.y, { width: 165, align: 'right' });
    pdf.font('Helvetica').fontSize(8).fillColor('#555555');
    pdf.text(`Dated ${displayDate(doc.payDate)}`, 380, pdf.y + 1, { width: 165, align: 'right' });

    pdf.fillColor('#000000');
    pdf.y = Math.max(leftBottom, pdf.y) + 12;
    rule(pdf);

    // ---- Earnings ----------------------------------------------------------
    sectionHeading(pdf, 'EARNINGS');
    for (const line of doc.earnings) {
      amountRow(pdf, line.label, undefined, line.amount);
    }
    subtotalRow(pdf, 'Gross pay', doc.grossPay);

    // ---- Deductions --------------------------------------------------------
    pdf.moveDown(0.6);
    sectionHeading(pdf, 'DEDUCTIONS');
    for (const line of doc.deductions) {
      amountRow(pdf, line.label, line.note, line.amount);
    }
    subtotalRow(pdf, 'Total deductions', doc.totalDeductions);

    // ---- Net pay -----------------------------------------------------------
    pdf.moveDown(0.8);
    const netY = pdf.y;
    pdf.rect(MARGIN, netY, 495, 30).fill('#f4f4f5');
    pdf.fillColor(BRAND).font('Helvetica-Bold').fontSize(11)
      .text('NET PAY', MARGIN + 12, netY + 10);
    pdf.fillColor('#000000').fontSize(14)
      .text(`RM ${money(doc.netPay)}`, 300, netY + 8, { width: 233, align: 'right' });
    pdf.font('Helvetica').fontSize(9);
    pdf.y = netY + 36;

    // ---- How the money reached them ----------------------------------------
    /*
     * Stated because a payslip without it cannot be checked against anything.
     * The reader compares four digits with their own bank statement and knows
     * whether the money they are holding is this money.
     */
    if (doc.payment !== undefined) {
      pdf.fontSize(8).fillColor('#555555');
      pdf.text(paymentLine(doc.payment), MARGIN, pdf.y, { width: 495 });
      pdf.fillColor('#000000').fontSize(9);
      pdf.y += 4;
    } else {
      pdf.y += 6;
    }

    // ---- What the employer pays on top -------------------------------------
    sectionHeading(pdf, 'EMPLOYER CONTRIBUTIONS — NOT DEDUCTED FROM YOUR PAY');
    for (const line of doc.employerContributions) {
      amountRow(pdf, line.label, undefined, line.amount);
    }
    subtotalRow(pdf, 'Paid by the employer', doc.totalEmployerContributions);

    // ---- The basis, so every figure can be checked --------------------------
    /*
     * The footer is hard-positioned at y=780, and nothing above here paginates.
     * A payslip with several earnings lines would run these notes underneath it
     * silently — so the guard `renderStatementPdf` already uses goes here too,
     * before the last block that can grow.
     */
    if (pdf.y > 690) pdf.addPage();
    pdf.moveDown(0.8);
    pdf.fontSize(7.5).fillColor('#555555');
    const basis = [
      `EPF: Employees Provident Fund Act 1991, Third Schedule, Part ${doc.basis.epfPart}.`,
      `SOCSO: Employees' Social Security Act 1969 (Act 4), Category ${doc.basis.socsoCategory}, including SKBBK.`,
      doc.basis.eisApplies
        ? 'EIS: Employment Insurance System Act 2017 (Act 800).'
        : 'EIS: not applicable to this employee under Act 800.',
      doc.basis.nonResident
        ? 'PCB: non-resident flat rate on gross remuneration.'
        : `PCB: monthly tax deduction, computed on RM ${money(doc.basis.chargeableIncome)} of chargeable income projected for the year.`,
    ];
    for (const note of basis) {
      pdf.text(note, MARGIN, pdf.y, { width: 495, lineGap: 1.5 });
    }
    pdf.fillColor('#000000');

    footer(pdf);
  }
}

/**
 * "Paid by bank transfer to Maybank ••••4471", and it degrades honestly.
 *
 * Bank and last-four are each optional, so a shop that has recorded only the
 * method still gets a true sentence rather than a half-finished one with a
 * dangling "to".
 */
function paymentLine(payment: NonNullable<PayslipDocument['payment']>): string {
  if (payment.method === 'CASH') return 'Paid in cash.';

  const how = payment.method === 'CHEQUE' ? 'Paid by cheque' : 'Paid by bank transfer';
  const account = [payment.bankName, payment.accountLast4 ? `••••${payment.accountLast4}` : null]
    .filter((part): part is string => part !== null && part !== undefined && part !== '')
    .join(' ');

  return account === '' ? `${how}.` : `${how} to ${account}.`;
}

function sectionHeading(pdf: PDFKit.PDFDocument, title: string): void {
  pdf.font('Helvetica-Bold').fontSize(8).fillColor(BRAND)
    .text(title, MARGIN, pdf.y, { characterSpacing: 0.6 });
  pdf.fillColor('#000000').font('Helvetica').fontSize(9);
  pdf.y += 3;
}

/** One label — optionally with the instrument it comes from — and one amount. */
function amountRow(
  pdf: PDFKit.PDFDocument,
  label: string,
  note: string | undefined,
  amount: string,
): void {
  const y = pdf.y;
  pdf.font('Helvetica').fontSize(9).text(label, MARGIN, y, { width: 200 });
  if (note !== undefined) {
    pdf.fontSize(7.5).fillColor('#777777')
      .text(note, MARGIN + 205, y + 1.5, { width: 160 });
    pdf.fillColor('#000000').fontSize(9);
  }
  pdf.text(money(amount), 430, y, { width: 115, align: 'right' });
  pdf.y = y + LINE;
}

function subtotalRow(pdf: PDFKit.PDFDocument, label: string, amount: string): void {
  pdf.strokeColor('#d4d4d8');
  pdf.moveTo(MARGIN, pdf.y).lineTo(545, pdf.y).stroke();
  pdf.strokeColor('#000000');
  pdf.y += 4;
  const y = pdf.y;
  pdf.font('Helvetica-Bold').fontSize(9).text(label, MARGIN, y, { width: 300 });
  pdf.text(`RM ${money(amount)}`, 430, y, { width: 115, align: 'right' });
  pdf.font('Helvetica');
  pdf.y = y + LINE;
}


/**
 * A customer statement.
 *
 * ---------------------------------------------------------------------------
 * THE DOCUMENT A CUSTOMER ARGUES WITH.
 *
 * Which is why it leads with the opening balance rather than the first
 * transaction: a statement that starts mid-story invites "what was this
 * carried-forward figure?", and the answer has to be on the page. Every line
 * carries a document number the customer can quote back, and the running
 * balance is printed on each so a disagreement can be pinned to one row rather
 * than to the total.
 *
 * The two figures at the foot are what they owe and how much of it is already
 * late. Nothing here is stored — it is reconstructed from the invoices,
 * payments and credit notes each time — so a statement reprinted next year for
 * last March still shows last March.
 * ---------------------------------------------------------------------------
 */
export function renderStatementPdf(
  doc: CustomerStatement,
  seller: InvoiceDocument['seller'],
): Promise<Buffer> {
  return build((pdf) => {
    header(pdf, seller, 'STATEMENT OF ACCOUNT');

    const topY = pdf.y;
    pdf.font('Helvetica-Bold').fontSize(11).text(doc.contact.name, MARGIN, topY);
    pdf.font('Helvetica').fontSize(9).fillColor('#555555');
    if (doc.contact.email) pdf.text(doc.contact.email, MARGIN, pdf.y);
    const leftBottom = pdf.y;

    pdf.fillColor('#555555').fontSize(8);
    pdf.text('PERIOD', 380, topY, { width: 165, align: 'right', characterSpacing: 0.5 });
    pdf.fillColor('#000000').font('Helvetica-Bold').fontSize(10);
    pdf.text(`${displayDate(doc.from)} — ${displayDate(doc.to)}`, 380, pdf.y, {
      width: 165,
      align: 'right',
    });

    pdf.fillColor('#000000').font('Helvetica').fontSize(9);
    pdf.y = Math.max(leftBottom, pdf.y) + 12;

    // ---- Column headings ---------------------------------------------------
    const cols = { date: MARGIN, ref: 118, detail: 210, charge: 330, credit: 400, balance: 470 };
    pdf.font('Helvetica-Bold').fontSize(8.5);
    const headY = pdf.y;
    pdf.text('Date', cols.date, headY);
    pdf.text('Document', cols.ref, headY);
    pdf.text('Detail', cols.detail, headY);
    pdf.text('Charge', cols.charge, headY, { width: 62, align: 'right' });
    pdf.text('Paid', cols.credit, headY, { width: 62, align: 'right' });
    pdf.text('Balance', cols.balance, headY, { width: 75, align: 'right' });
    pdf.y = headY + LINE;
    rule(pdf);

    // ---- The carried-forward figure, on the page and labelled ---------------
    pdf.font('Helvetica-Bold').fontSize(9);
    const openY = pdf.y;
    pdf.text('Balance brought forward', cols.date, openY, { width: 300 });
    pdf.text(money(doc.openingBalance), cols.balance, openY, { width: 75, align: 'right' });
    pdf.y = openY + LINE;
    pdf.font('Helvetica');

    // ---- Every movement in the period --------------------------------------
    for (const entry of doc.entries) {
      if (pdf.y > 700) {
        pdf.addPage();
        pdf.font('Helvetica').fontSize(9);
      }
      const y = pdf.y;
      pdf.fontSize(9);
      pdf.text(displayDate(entry.date), cols.date, y, { width: 88 });
      pdf.text(entry.reference, cols.ref, y, { width: 88 });
      if (entry.detail) {
        pdf.fontSize(8).fillColor('#666666');
        pdf.text(entry.detail, cols.detail, y + 0.5, { width: 115, ellipsis: true, height: 11 });
        pdf.fillColor('#000000').fontSize(9);
      }
      if (entry.charge) pdf.text(money(entry.charge), cols.charge, y, { width: 62, align: 'right' });
      if (entry.credit) pdf.text(money(entry.credit), cols.credit, y, { width: 62, align: 'right' });
      pdf.text(money(entry.balance), cols.balance, y, { width: 75, align: 'right' });
      pdf.y = y + LINE;
    }

    rule(pdf);

    // ---- What they owe, and what is late -----------------------------------
    const dueY = pdf.y;
    pdf.rect(MARGIN, dueY, 495, 28).fill('#f4f4f5');
    pdf.fillColor(BRAND).font('Helvetica-Bold').fontSize(10)
      .text('AMOUNT NOW DUE', MARGIN + 12, dueY + 9);
    pdf.fillColor('#000000').fontSize(13)
      .text(`RM ${money(doc.closingBalance)}`, 300, dueY + 7, { width: 233, align: 'right' });
    pdf.font('Helvetica').fontSize(9);
    pdf.y = dueY + 38;

    if (Number(doc.overdue) > 0) {
      /*
       * Stated separately rather than folded into the total, because "you owe
       * RM 4,000" and "RM 1,200 of it was due three weeks ago" prompt
       * different conversations, and the second is the one that gets paid.
       */
      pdf.fillColor('#b45309').font('Helvetica-Bold').fontSize(9.5);
      pdf.text(
        `RM ${money(doc.overdue)} of this is already past its due date.`,
        MARGIN,
        pdf.y,
        { width: 495 },
      );
      pdf.fillColor('#000000').font('Helvetica').fontSize(9);
      pdf.moveDown(0.6);
    }

    pdf.fontSize(7.5).fillColor('#555555');
    pdf.text(
      'Amounts are shown in ' +
        doc.currency +
        '. If this statement disagrees with your records, please quote the document ' +
        'number of the line in question.',
      MARGIN,
      pdf.y,
      { width: 495, lineGap: 1.5 },
    );
    pdf.fillColor('#000000');

    footer(pdf);
  });
}

// ------------------------------------------------------------------ helpers



function build(draw: (pdf: PDFKit.PDFDocument) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: 'A4', margin: MARGIN, compress: false });
    const chunks: Buffer[] = [];
    pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
    draw(pdf);
    pdf.end();
  });
}

/**
 * The shop's brand blue, sampled from the Shah G Tech logo itself, and the
 * logo beside it. A customer's copy carries the shop's real identity —
 * presentation only; every figure below is stored data.
 */
const BRAND = '#1875BE';
const LOGO = fileURLToPath(new URL('./wordmark.png', import.meta.url));

function header(
  pdf: PDFKit.PDFDocument,
  seller: InvoiceDocument['seller'],
  title: string,
): void {
  pdf.rect(0, 0, 595, 6).fill(BRAND);
  pdf.fillColor('#000000');

  // Top-right, transparent background: the wordmark is 1600×478, so a 32pt
  // height keeps it crisp without crowding the seller block.
  pdf.image(LOGO, 545 - 107, MARGIN - 6, { height: 32 });

  pdf.font('Helvetica-Bold').fontSize(16).text(seller.name, MARGIN, MARGIN);
  pdf.font('Helvetica').fontSize(8).fillColor('#555555');
  if (seller.ssmRegistrationNo) pdf.text(`SSM: ${seller.ssmRegistrationNo}`);
  if (seller.tin) pdf.text(`TIN: ${seller.tin}`);
  if (seller.sstRegistered && seller.sstNo) pdf.text(`SST No: ${seller.sstNo}`);
  pdf.fillColor('#000000');

  pdf.font('Helvetica-Bold').fontSize(13).fillColor(BRAND).text(title, MARGIN, pdf.y + 10);
  pdf.fillColor('#000000');
  pdf.font('Helvetica').fontSize(9);
  pdf.moveDown(0.5);
}

function pair(pdf: PDFKit.PDFDocument, label: string, value: string): void {
  pdf.font('Helvetica-Bold').text(`${label}: `, MARGIN, pdf.y, { continued: true });
  pdf.font('Helvetica').text(value);
}

function rule(pdf: PDFKit.PDFDocument): void {
  pdf.strokeColor('#d4d4d8');
  pdf.moveTo(MARGIN, pdf.y + 2).lineTo(545, pdf.y + 2).stroke();
  pdf.strokeColor('#000000');
  pdf.y += 8;
}

function totalRow(pdf: PDFKit.PDFDocument, label: string, currency: string, amount: string): void {
  const y = pdf.y;
  pdf.text(label, 360, y, { width: 100, align: 'right' });
  pdf.text(
    `${currency === 'MYR' ? 'RM ' : `${currency} `}${money(amount)}`,
    460,
    y,
    { width: 85, align: 'right' },
  );
  pdf.y = y + LINE;
}

/**
 * The verification block: a QR, the URL in readable text, and the digest.
 *
 * ---------------------------------------------------------------------------
 * THE QR IS NOT THE ONLY WAY IN, DELIBERATELY.
 *
 * This document is meant to still mean something in fifty years, and a QR code
 * is a bet that a 2076 device will read a 2006 symbology. Probably it will —
 * but the URL and the digest are also printed as text a person can type, and
 * the digest alone is enough to verify with. If every scanner on earth stopped
 * understanding QR tomorrow, the page still works.
 *
 * Drawn as one filled rectangle per dark module. At 3 points a module a
 * version-3 code is about 90 points square — small enough to sit under the
 * totals, large enough for a phone camera at arm's length.
 * ---------------------------------------------------------------------------
 */
function verificationBlock(
  pdf: PDFKit.PDFDocument,
  verification: DocumentVerification,
): void {
  const matrix = encodeQr(`${verification.verifyUrl}#d=${verification.digest}`);
  const MODULE = 3;
  const top = Math.min(pdf.y + 12, 690);

  pdf.fillColor('#000000');
  for (let row = 0; row < matrix.length; row++) {
    for (let col = 0; col < matrix.length; col++) {
      if (matrix[row]![col]) {
        pdf.rect(MARGIN + col * MODULE, top + row * MODULE, MODULE, MODULE).fill();
      }
    }
  }

  const textLeft = MARGIN + matrix.length * MODULE + 14;
  pdf.font('Helvetica-Bold').fontSize(8).fillColor('#000000');
  pdf.text('Check this document is genuine', textLeft, top + 2, { width: 300 });
  pdf.font('Helvetica').fontSize(7).fillColor('#444444');
  pdf.text(
    `Scan the code, or go to ${verification.verifyUrl} and enter the reference below.`,
    textLeft,
    pdf.y + 1,
    { width: 320 },
  );
  pdf.font('Courier').fontSize(6.5).fillColor('#666666');
  // Broken into groups so somebody can read it aloud or type it without
  // losing their place in 64 characters of hex.
  pdf.text(verification.digest.replace(/(.{16})/g, '$1 ').trim(), textLeft, pdf.y + 3, {
    width: 320,
  });
  pdf.font('Helvetica').fillColor('#000000');
  pdf.y = Math.max(pdf.y, top + matrix.length * MODULE);
}

function footer(pdf: PDFKit.PDFDocument): void {
  pdf
    .fontSize(7)
    .fillColor('#666666')
    .text(
      'Computer-generated document. Figures are stated in the document currency.',
      MARGIN,
      780,
      { width: 495, align: 'center' },
    )
    .fillColor('#000000');
}

/** '1234.5000' → '1,234.50'. Wire scale is 4dp; a printed RM amount is 2dp. */
function money(decimal: string): string {
  const [whole = '0', fraction = ''] = decimal.split('.');
  const cents = fraction.padEnd(2, '0').slice(0, 2);
  const negative = whole.startsWith('-');
  const digits = negative ? whole.slice(1) : whole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}.${cents}`;
}

/** '3.0000' → '3'; '2.5000' → '2.5'. A quantity keeps only what it means. */
function trimQty(quantity: string): string {
  return quantity.replace(/\.?0+$/, '');
}

/** ISO on the wire, DD/MM/YYYY on paper — CLAUDE.md rule 8. */
function displayDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/**
 * The year's statements, for the hundred-year archive.
 *
 * Laid out to be READ rather than to be parsed: the CSVs beside it in the
 * archive carry the machine-readable version, so this one can spend its space
 * on white and on the hierarchy of the statement. Each report starts a new
 * page — a balance sheet that begins halfway down a page of profit and loss
 * is harder to hand to somebody than one that does not.
 */
export function renderFinancialStatementsPdf(input: {
  organisationName: string;
  label: string;
  from: string;
  to: string;
  profitOrLoss: RenderedReport;
  financialPosition: RenderedReport;
}): Promise<Buffer> {
  return build((pdf) => {
    const statement = (report: RenderedReport, subtitle: string) => {
      pdf.font('Helvetica-Bold').fontSize(14).fillColor(BRAND);
      pdf.text(input.organisationName, MARGIN, pdf.y);
      pdf.fillColor('#000000').fontSize(11);
      pdf.text(report.name, MARGIN, pdf.y + 2);
      pdf.font('Helvetica').fontSize(9).fillColor('#555555');
      pdf.text(subtitle, MARGIN, pdf.y + 1);
      pdf.fillColor('#000000');
      pdf.moveDown(1);
      rule(pdf);

      for (const line of report.lines) {
        const isTotal = line.lineType === 'TOTAL' || line.lineType === 'SUBTOTAL';
        pdf.font(isTotal || line.lineType === 'HEADER' ? 'Helvetica-Bold' : 'Helvetica');
        pdf.fontSize(line.lineType === 'HEADER' ? 8 : 9);

        const y = pdf.y;
        const indent = MARGIN + line.level * 14;
        if (line.lineType === 'HEADER') {
          pdf.fillColor(BRAND).text(line.label.toUpperCase(), indent, y, { characterSpacing: 0.6 });
          pdf.fillColor('#000000');
        } else {
          pdf.text(line.label, indent, y, { width: 380 - line.level * 14 });
          pdf.text(money(line.amount.toDecimalString()), 430, y, {
            width: 115,
            align: 'right',
          });
          if (isTotal) rule(pdf);
        }
        pdf.y += 2;
      }
    };

    statement(input.profitOrLoss, `Financial year ${input.label} — ${displayDate(input.from)} to ${displayDate(input.to)}`);
    pdf.addPage();
    statement(input.financialPosition, `As at ${displayDate(input.to)}`);

    pdf.font('Helvetica').fontSize(7).fillColor('#666666');
    pdf.text(
      'Prepared from the general ledger. The figures above are reproduced in ' +
        'trial-balance.csv and journal.csv in this archive, and can be recomputed from them.',
      MARGIN,
      760,
      { width: 495, align: 'center' },
    );
    pdf.fillColor('#000000');
  });
}
