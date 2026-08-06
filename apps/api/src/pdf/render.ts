import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { encodeQr } from '@emil/domain';
import type { RenderedReport } from '@emil/domain';
import type {
  CreditNoteDocument,
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

    });
}

// ------------------------------------------------------------------ helpers



/**
 * Every document is built here, and every page is finished here.
 *
 * ---------------------------------------------------------------------------
 * THE FOOTER IS STAMPED ON EVERY PAGE, NOT DRAWN ONCE.
 *
 * It used to be a single `footer(pdf)` call at the end of each renderer,
 * writing at absolute y=780. On a one-page invoice that is the same thing; on
 * anything that paginates it silently footed ONE page and left the rest bare —
 * and a page of somebody's ledger with no shop name on it is a loose sheet.
 *
 * `bufferPages` keeps every page open until the document closes, which is also
 * the only way to know the page COUNT while there is still a page to write it
 * on. "Page 2 of 5" is what tells a reader whether the copy they were handed
 * is complete, and it cannot be written on page 2 until page 5 exists.
 * ---------------------------------------------------------------------------
 */
function build(
  draw: (pdf: PDFKit.PDFDocument) => void,
  options: { readonly footNote?: string } = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: 'A4', margin: MARGIN, compress: false, bufferPages: true });
    const chunks: Buffer[] = [];
    pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);

    try {
      draw(pdf);
      stampPages(pdf, options.footNote);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    pdf.end();
  });
}

/** The note under the rule on every page, and the page number beside it. */
function stampPages(pdf: PDFKit.PDFDocument, footNote?: string): void {
  const range = pdf.bufferedPageRange();
  const note = footNote ?? 'Computer-generated document. Figures are stated in the document currency.';

  for (let i = 0; i < range.count; i++) {
    pdf.switchToPage(range.start + i);

    /*
     * Writing this close to the paper's edge would otherwise trip pdfkit's own
     * bottom margin and append a page — inside a loop over pages, which never
     * terminates. Dropping the margin for the stamp is the documented way out.
     */
    const bottom = pdf.page.margins.bottom;
    pdf.page.margins.bottom = 0;

    pdf.strokeColor('#e4e4e7');
    pdf.moveTo(MARGIN, 772).lineTo(545, 772).stroke();
    pdf.strokeColor('#000000');

    pdf.font('Helvetica').fontSize(7).fillColor('#71717a');
    pdf.text(note, MARGIN, 778, { width: 400, align: 'left', lineBreak: false });
    if (range.count > 1) {
      pdf.text(`Page ${i + 1} of ${range.count}`, 445, 778, {
        width: 100,
        align: 'right',
        lineBreak: false,
      });
    }
    pdf.fillColor('#000000');

    pdf.page.margins.bottom = bottom;
  }

  pdf.flushPages();
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

/**
 * The same letterhead, plus the document's own identity set right.
 *
 * Invoices and receipts print their reference as `Label: value` pairs down the
 * left, which reads fine on a page whose whole subject is one document. The
 * REPORTS — a day sheet, a day book — are about a period rather than a
 * document, and want the period stated once, prominently, where a reader
 * checks first: top right, beside the title.
 */
function reportHeader(
  pdf: PDFKit.PDFDocument,
  seller: InvoiceDocument['seller'],
  title: string,
  meta: readonly [string, string][],
): void {
  const top = pdf.y;
  header(pdf, seller, title);
  const afterTitle = pdf.y;

  pdf.font('Helvetica').fontSize(8.5);
  let y = top + MARGIN - 4;
  for (const [label, value] of meta) {
    pdf.fillColor('#71717a').text(label, 330, y, { width: 100, align: 'right', lineBreak: false });
    pdf.fillColor('#18181b').font('Helvetica-Bold')
      .text(value, 435, y, { width: 110, align: 'right', lineBreak: false });
    pdf.font('Helvetica');
    y += 13;
  }
  pdf.fillColor('#000000');
  pdf.y = Math.max(afterTitle, y + 4);
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

/**
 * A place for two people to sign, with a printed name under each rule.
 *
 * On a day sheet this is the whole point of printing it: the drawer was
 * counted by one person and the sheet accepted by another, and the signatures
 * are what make that a control rather than a note. Kept off the page bottom so
 * the stamped footer never collides with it.
 */
function signatureBlock(
  pdf: PDFKit.PDFDocument,
  left: { role: string; name?: string },
  right: { role: string; name?: string },
): void {
  if (pdf.y > 660) pdf.addPage();
  pdf.moveDown(2);
  const y = Math.max(pdf.y, 640);

  pdf.strokeColor('#a1a1aa');
  pdf.moveTo(MARGIN, y).lineTo(MARGIN + 200, y).stroke();
  pdf.moveTo(320, y).lineTo(520, y).stroke();
  pdf.strokeColor('#000000');

  /*
   * Both captions are placed at the SAME absolute y. Written relative to
   * `pdf.y` they drifted apart by a line, because the left column advanced the
   * cursor and the right one then measured from wherever that left it — two
   * labels under two rules, sitting at different heights.
   */
  pdf.font('Helvetica').fontSize(8).fillColor('#52525b');
  pdf.text(left.role, MARGIN, y + 5, { width: 200, lineBreak: false });
  pdf.text(right.role, 320, y + 5, { width: 200, lineBreak: false });
  if (left.name) pdf.text(left.name, MARGIN, y + 16, { width: 200, lineBreak: false });
  if (right.name) pdf.text(right.name, 320, y + 16, { width: 200, lineBreak: false });
  pdf.fillColor('#000000');
  pdf.y = y + 34;
}

/**
 * A table that survives a page break.
 *
 * The column headings are redrawn at the top of each new page, because a
 * continuation sheet of bare numbers is unreadable and — on a sales day book
 * an accountant is checking — genuinely dangerous: the second page's third
 * column is not obviously the tax column.
 */
interface Column {
  readonly label: string;
  readonly x: number;
  readonly width: number;
  readonly align?: 'left' | 'right';
}

function tableHeader(pdf: PDFKit.PDFDocument, columns: readonly Column[]): void {
  pdf.font('Helvetica-Bold').fontSize(8).fillColor('#3f3f46');
  const y = pdf.y;
  for (const column of columns) {
    pdf.text(column.label, column.x, y, {
      width: column.width,
      align: column.align ?? 'left',
      lineBreak: false,
    });
  }
  pdf.fillColor('#000000');
  pdf.y = y + 12;
  rule(pdf);
  pdf.font('Helvetica').fontSize(8.5);
}

function tableRow(
  pdf: PDFKit.PDFDocument,
  columns: readonly Column[],
  cells: readonly string[],
): void {
  // 730 leaves room for the stamped footer; break BEFORE the row, never
  // through it.
  if (pdf.y > 730) {
    pdf.addPage();
    tableHeader(pdf, columns);
  }
  const y = pdf.y;
  let bottom = y;
  columns.forEach((column, i) => {
    pdf.text(cells[i] ?? '', column.x, y, {
      width: column.width,
      align: column.align ?? 'left',
    });
    bottom = Math.max(bottom, pdf.y);
  });
  pdf.y = bottom + 3;
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
  /** Where this pack will live — it changes what the provenance line can
      truthfully claim. Defaults to a standalone download. */
  context?: 'ARCHIVE' | 'STANDALONE';
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

    /*
     * The provenance line differs by where the pack came from, and saying the
     * wrong one is saying something false. Inside the archive the CSVs are
     * literally alongside it; downloaded on its own there is no archive, and
     * pointing at files that are not there would send a reader looking.
     */
    pdf.font('Helvetica').fontSize(7).fillColor('#666666');
    pdf.text(
      input.context === 'ARCHIVE'
        ? 'Prepared from the general ledger. The figures above are reproduced in ' +
          'trial-balance.csv and journal.csv in this archive, and can be recomputed from them.'
        : 'Prepared from the general ledger. Every figure above can be recomputed from the ' +
          'trial balance and journal for the same period, exported from Reports.',
      MARGIN,
      760,
      { width: 495, align: 'center' },
    );
    pdf.fillColor('#000000');
  });
}

// ---------------------------------------------------------------------------
// The day sheet
// ---------------------------------------------------------------------------

export interface DaySheetDocument {
  readonly seller: InvoiceDocument['seller'];
  readonly date: string;
  readonly byMethod: readonly {
    readonly method: string;
    readonly depositAccount: string;
    readonly total: string;
    readonly count: number;
  }[];
  readonly receiptsTotal: string;
  readonly invoicedTotal: string;
  readonly invoiceCount: number;
  readonly costOfGoodsSold: string;
  readonly grossProfit: string;
}

/**
 * What the shop prints at closing time, signs, and puts in the folder.
 *
 * ---------------------------------------------------------------------------
 * TWO NUMBERS THAT ARE NOT THE SAME NUMBER, SAID SO PLAINLY.
 *
 * "Takings" is what came IN today — the drawer and the settlements. "Invoiced"
 * is what was SOLD today, whether or not anybody paid. A shop that invoices on
 * account will see them diverge every single day, and the most common
 * bookkeeping argument in a small business is two people each quoting one of
 * them as "today's sales". They are printed in separate blocks, each labelled
 * with what it answers, rather than adjacent in a way that invites the reader
 * to think one is a check on the other.
 *
 * The counting box is left BLANK on purpose. Its whole value is that a person
 * physically counts the drawer and writes the figure next to what the system
 * expected — printing our own number into it would turn a control into a
 * formality.
 * ---------------------------------------------------------------------------
 */
export function renderDaySheetPdf(doc: DaySheetDocument): Promise<Buffer> {
  return build(
    (pdf) => {
      reportHeader(pdf, doc.seller, 'DAY SHEET', [
        ['Trading day', displayDate(doc.date)],
        ['Printed', displayDate(new Date().toISOString().slice(0, 10))],
      ]);

      // ---- Money in ----------------------------------------------------------
      sectionHeading(pdf, 'MONEY IN TODAY — COUNT THE DRAWER AGAINST THIS');
      const methodCols: Column[] = [
        { label: 'Payment method', x: MARGIN, width: 150 },
        { label: 'Lands in', x: 200, width: 180 },
        { label: 'Count', x: 390, width: 55, align: 'right' },
        { label: 'Amount (RM)', x: 455, width: 90, align: 'right' },
      ];
      tableHeader(pdf, methodCols);

      if (doc.byMethod.length === 0) {
        pdf.fillColor('#71717a').text('Nothing was taken today.', MARGIN, pdf.y);
        pdf.fillColor('#000000');
        pdf.y += 14;
      } else {
        for (const row of doc.byMethod) {
          tableRow(pdf, methodCols, [
            row.method.replace(/_/g, ' '),
            row.depositAccount,
            String(row.count),
            money(row.total),
          ]);
        }
      }
      rule(pdf);
      pdf.font('Helvetica-Bold').fontSize(10);
      const takingsY = pdf.y;
      pdf.text('Total taken', MARGIN, takingsY, { width: 340 });
      pdf.text(`RM ${money(doc.receiptsTotal)}`, 400, takingsY, { width: 145, align: 'right' });
      pdf.font('Helvetica').fontSize(9);
      pdf.y = takingsY + 20;

      // ---- The count ---------------------------------------------------------
      const boxY = pdf.y;
      pdf.rect(MARGIN, boxY, 495, 54).lineWidth(0.8).strokeColor('#a1a1aa').stroke();
      pdf.strokeColor('#000000').lineWidth(1);
      pdf.font('Helvetica-Bold').fontSize(8.5).fillColor('#3f3f46');
      pdf.text('COUNTED BY HAND', MARGIN + 12, boxY + 9, { width: 200 });
      pdf.font('Helvetica').fontSize(8).fillColor('#71717a');
      pdf.text('Cash counted', MARGIN + 12, boxY + 26, { width: 90 });
      pdf.text('Difference', 280, boxY + 26, { width: 80 });
      pdf.strokeColor('#a1a1aa');
      pdf.moveTo(MARGIN + 105, boxY + 36).lineTo(MARGIN + 215, boxY + 36).stroke();
      pdf.moveTo(360, boxY + 36).lineTo(520, boxY + 36).stroke();
      pdf.strokeColor('#000000').fillColor('#000000');
      pdf.y = boxY + 66;

      // ---- What the day made -------------------------------------------------
      sectionHeading(pdf, 'WHAT THE DAY SOLD — NOT THE SAME AS WHAT CAME IN');
      amountRow(pdf, 'Invoiced today', `${doc.invoiceCount} invoice${doc.invoiceCount === 1 ? '' : 's'}`, doc.invoicedTotal);
      amountRow(pdf, 'Cost of the goods sold', 'weighted average', doc.costOfGoodsSold);
      subtotalRow(pdf, 'Gross profit', doc.grossProfit);

      pdf.moveDown(0.6);
      pdf.fontSize(7.5).fillColor('#71717a');
      pdf.text(
        'Takings are money RECEIVED today, including settlements of older invoices. ' +
          'Invoiced is what was SOLD today, whether or not it has been paid. On any day ' +
          'the shop sells on account the two differ, and neither is wrong.',
        MARGIN,
        pdf.y,
        { width: 495, lineGap: 1.5 },
      );
      pdf.fillColor('#000000').fontSize(9);

      signatureBlock(pdf, { role: 'Counted by' }, { role: 'Checked by' });
    },
    { footNote: 'Day sheet — file with the day’s receipts.' },
  );
}

// ---------------------------------------------------------------------------
// The quote
// ---------------------------------------------------------------------------

export interface QuoteDocument {
  readonly seller: InvoiceDocument['seller'];
  readonly quoteNo: string;
  readonly quoteDate: string;
  readonly validUntil: string | null;
  readonly lapsed: boolean;
  readonly status: string;
  readonly currency: string;
  readonly reference: string | null;
  readonly notes: string | null;
  readonly customer: { readonly name: string; readonly tin: string | null };
  readonly lines: readonly {
    readonly description: string;
    readonly quantity: string;
    readonly unitPrice: string;
    readonly discountBasisPoints: number;
    readonly lineTotal: string;
  }[];
  readonly subtotal: string;
}

/**
 * The paper a customer is handed before agreeing to anything.
 *
 * ---------------------------------------------------------------------------
 * A QUOTE IS AN OFFER, AND THE PAGE SAYS WHEN IT STOPS BEING ONE.
 *
 * The validity date is printed in the meta block AND repeated in words above
 * the acceptance lines, because "quoted RM 4,200 in March" is an argument
 * every repair shop has had. A lapsed quote is stamped as such rather than
 * quietly reprinted looking current — reissuing is a decision for the shop,
 * not something a printer does on its behalf.
 *
 * No tax is shown. The quote records agreed PRICES; the tax treatment is
 * resolved when the invoice is issued, from the tax codes then in force, and
 * a quote that guessed at it would disagree with the invoice that follows.
 * That is stated on the page rather than left for someone to notice.
 * ---------------------------------------------------------------------------
 */
export function renderQuotePdf(doc: QuoteDocument): Promise<Buffer> {
  return build(
    (pdf) => {
      const meta: [string, string][] = [
        ['Quote no', doc.quoteNo],
        ['Date', displayDate(doc.quoteDate)],
      ];
      if (doc.validUntil) meta.push(['Valid until', displayDate(doc.validUntil)]);

      reportHeader(pdf, doc.seller, doc.lapsed ? 'QUOTATION (EXPIRED)' : 'QUOTATION', meta);

      if (doc.lapsed) {
        const y = pdf.y;
        pdf.rect(MARGIN, y, 495, 26).fill('#fef3c7');
        pdf.fillColor('#92400e').font('Helvetica-Bold').fontSize(9);
        pdf.text(
          `This quotation lapsed on ${displayDate(doc.validUntil!)}. Ask the shop to reissue it.`,
          MARGIN + 12,
          y + 9,
          { width: 471 },
        );
        pdf.fillColor('#000000').font('Helvetica').fontSize(9);
        pdf.y = y + 34;
      }

      pair(pdf, 'Prepared for', doc.customer.name);
      if (doc.customer.tin) pair(pdf, 'Customer TIN', doc.customer.tin);
      if (doc.reference) pair(pdf, 'Reference', doc.reference);
      pdf.moveDown(1);

      const cols: Column[] = [
        { label: 'Description', x: MARGIN, width: 250 },
        { label: 'Qty', x: 310, width: 45, align: 'right' },
        { label: 'Unit price', x: 365, width: 70, align: 'right' },
        { label: 'Discount', x: 440, width: 50, align: 'right' },
        { label: 'Amount', x: 495, width: 50, align: 'right' },
      ];
      tableHeader(pdf, cols);
      for (const line of doc.lines) {
        tableRow(pdf, cols, [
          line.description,
          trimQty(line.quantity),
          money(line.unitPrice),
          line.discountBasisPoints > 0 ? `${(line.discountBasisPoints / 100).toFixed(1)}%` : '—',
          money(line.lineTotal),
        ]);
      }
      rule(pdf);

      pdf.font('Helvetica-Bold').fontSize(11);
      const totalY = pdf.y;
      pdf.text('Total', 330, totalY, { width: 100, align: 'right' });
      pdf.text(
        `${doc.currency === 'MYR' ? 'RM ' : `${doc.currency} `}${money(doc.subtotal)}`,
        435,
        totalY,
        { width: 110, align: 'right' },
      );
      pdf.font('Helvetica').fontSize(9);
      pdf.y = totalY + 22;

      if (doc.notes) {
        sectionHeading(pdf, 'NOTES');
        pdf.fontSize(8.5).text(doc.notes, MARGIN, pdf.y, { width: 495, lineGap: 1.5 });
        pdf.fontSize(9);
        pdf.moveDown(0.8);
      }

      pdf.fontSize(7.5).fillColor('#71717a');
      pdf.text(
        doc.validUntil
          ? `This quotation is valid until ${displayDate(doc.validUntil)}. Prices are as quoted; ` +
            'any sales tax due is applied when the invoice is issued.'
          : 'Prices are as quoted; any sales tax due is applied when the invoice is issued.',
        MARGIN,
        pdf.y,
        { width: 495, lineGap: 1.5 },
      );
      pdf.fillColor('#000000').fontSize(9);

      signatureBlock(
        pdf,
        { role: 'Accepted by (customer)' },
        { role: 'For and on behalf of', name: doc.seller.name },
      );
    },
    { footNote: 'Quotation — not a tax invoice. No payment is due on this document.' },
  );
}

// ---------------------------------------------------------------------------
// The sales day book
// ---------------------------------------------------------------------------

export interface SalesDayBookDocument {
  readonly seller: InvoiceDocument['seller'];
  readonly from: string;
  readonly to: string;
  readonly currency: string;
  readonly rows: readonly {
    readonly issueDate: string;
    readonly invoiceNo: string;
    readonly customer: string;
    readonly status: string;
    readonly subtotal: string;
    readonly taxTotal: string;
    readonly total: string;
    readonly amountDue: string;
  }[];
  readonly totals: {
    readonly subtotal: string;
    readonly taxTotal: string;
    readonly total: string;
    readonly amountDue: string;
  };
}

/**
 * Every invoice issued in a period, one line each — what an accountant asks
 * for at month end and what a shop currently rebuilds by hand.
 *
 * ---------------------------------------------------------------------------
 * IT PAGINATES, AND THE COLUMN HEADINGS COME WITH IT.
 *
 * This is the first document here that routinely runs past one page: a busy
 * month is a hundred invoices. `tableRow` breaks BEFORE a row rather than
 * through it and redraws the headings on the new page, because the second
 * sheet of a day book otherwise arrives as four unlabelled columns of money —
 * and the reader's guess about which one is tax is the sort of thing that ends
 * up in a return.
 *
 * `Still due` is carried per row so the page doubles as a debtors list at the
 * period end without anyone cross-referencing a second report.
 * ---------------------------------------------------------------------------
 */
export function renderSalesDayBookPdf(doc: SalesDayBookDocument): Promise<Buffer> {
  return build(
    (pdf) => {
      reportHeader(pdf, doc.seller, 'SALES DAY BOOK', [
        ['Period', `${displayDate(doc.from)} – ${displayDate(doc.to)}`],
        ['Invoices', String(doc.rows.length)],
      ]);

      const cols: Column[] = [
        { label: 'Date', x: MARGIN, width: 55 },
        { label: 'Invoice', x: 108, width: 68 },
        { label: 'Customer', x: 180, width: 150 },
        { label: 'Net', x: 334, width: 58, align: 'right' },
        { label: 'Tax', x: 396, width: 48, align: 'right' },
        { label: 'Total', x: 448, width: 55, align: 'right' },
        { label: 'Still due', x: 507, width: 38, align: 'right' },
      ];
      tableHeader(pdf, cols);

      if (doc.rows.length === 0) {
        pdf.fillColor('#71717a')
          .text('No invoices were issued in this period.', MARGIN, pdf.y, { width: 495 });
        pdf.fillColor('#000000');
        pdf.y += 16;
      }

      for (const row of doc.rows) {
        tableRow(pdf, cols, [
          displayDate(row.issueDate),
          row.invoiceNo,
          row.customer,
          money(row.subtotal),
          money(row.taxTotal),
          money(row.total),
          row.amountDue === '0.0000' ? '—' : money(row.amountDue),
        ]);
      }

      // Keep the totals with the last rows rather than orphaned on a page of
      // their own — a total sheet with nothing above it means nothing.
      if (pdf.y > 700) pdf.addPage();
      rule(pdf);
      pdf.font('Helvetica-Bold').fontSize(9);
      const y = pdf.y;
      pdf.text(`Totals — ${doc.rows.length} invoice${doc.rows.length === 1 ? '' : 's'}`,
        MARGIN, y, { width: 280 });
      pdf.text(money(doc.totals.subtotal), 334, y, { width: 58, align: 'right' });
      pdf.text(money(doc.totals.taxTotal), 396, y, { width: 48, align: 'right' });
      pdf.text(money(doc.totals.total), 448, y, { width: 55, align: 'right' });
      pdf.text(
        doc.totals.amountDue === '0.0000' ? '—' : money(doc.totals.amountDue),
        507, y, { width: 38, align: 'right' },
      );
      pdf.font('Helvetica').fontSize(9);
      pdf.y = y + 20;

      pdf.fontSize(7.5).fillColor('#71717a');
      pdf.text(
        'Every invoice issued in the period, at the figures frozen when it was issued. ' +
          '“Still due” is what remains unpaid today, not at the period end — a row can be ' +
          'settled after the period it belongs to.',
        MARGIN,
        pdf.y,
        { width: 495, lineGap: 1.5 },
      );
      pdf.fillColor('#000000').fontSize(9);
    },
    { footNote: 'Sales day book — figures as issued.' },
  );
}

// ---------------------------------------------------------------------------
// The credit note
// ---------------------------------------------------------------------------

const CREDIT_REASON: Record<string, string> = {
  RETURN: 'Goods returned',
  OVERCHARGE: 'Overcharged on the original invoice',
  DISCOUNT: 'Discount agreed after invoicing',
  CANCELLATION: 'Order cancelled',
  BAD_DEBT: 'Bad debt relief',
  OTHER: 'Other',
};

/**
 * The document a customer files against the invoice it corrects.
 *
 * ---------------------------------------------------------------------------
 * THE REASON IS PRINTED, IN WORDS, BECAUSE IT IS THE POINT OF THE DOCUMENT.
 *
 * A credit note without a stated reason is a number somebody has to phone
 * about, and under SST the reason is what supports the reduction in output
 * tax. `reason` is a constrained code in the database — this prints the code's
 * meaning ("Goods returned"), not the code, and adds the free-text detail
 * beneath it when there is any.
 *
 * Amounts are POSITIVE, exactly as stored. The direction of a credit lives in
 * the journal, not in the sign of a printed figure: a negative number on a
 * page already headed CREDIT NOTE reads as a double negative to the person
 * holding it and to the accountant keying it.
 *
 * `Still available` is carried because a credit is not always spent at once.
 * A note applied to one invoice may leave a balance the customer can use
 * against the next one, and that residue is invisible unless the paper says so.
 * ---------------------------------------------------------------------------
 */
export function renderCreditNotePdf(doc: CreditNoteDocument): Promise<Buffer> {
  return build(
    (pdf) => {
      const meta: [string, string][] = [
        ['Credit note no', doc.creditNoteNo],
        ['Date', displayDate(doc.creditDate)],
      ];
      if (doc.againstInvoiceNo) meta.push(['Against invoice', doc.againstInvoiceNo]);
      if (doc.taxPointDate !== doc.creditDate) {
        meta.push(['Tax point', displayDate(doc.taxPointDate)]);
      }

      reportHeader(
        pdf,
        doc.seller,
        doc.status === 'VOIDED' ? 'CREDIT NOTE (VOIDED)' : 'CREDIT NOTE',
        meta,
      );

      pair(pdf, 'Credit to', doc.customer.name);
      if (doc.customer.tin) pair(pdf, 'Customer TIN', doc.customer.tin);
      pdf.moveDown(0.4);

      // The reason, said in words rather than left as a database code.
      pair(pdf, 'Reason', CREDIT_REASON[doc.reason] ?? doc.reason);
      if (doc.reasonDetail) {
        pdf.fontSize(8.5).fillColor('#52525b');
        pdf.text(doc.reasonDetail, MARGIN, pdf.y + 1, { width: 495, lineGap: 1.5 });
        pdf.fillColor('#000000').fontSize(9);
      }
      pdf.moveDown(1);

      const cols: Column[] = [
        { label: 'Description', x: MARGIN, width: 240 },
        { label: 'Qty', x: 300, width: 45, align: 'right' },
        { label: 'Unit price', x: 352, width: 65, align: 'right' },
        { label: 'Tax', x: 424, width: 55, align: 'right' },
        { label: 'Amount', x: 486, width: 59, align: 'right' },
      ];
      tableHeader(pdf, cols);
      for (const line of doc.lines) {
        tableRow(pdf, cols, [
          line.description,
          trimQty(line.quantity),
          money(line.unitPrice),
          money(line.taxAmount),
          money(line.lineTotal),
        ]);
      }
      rule(pdf);

      totalRow(pdf, 'Subtotal', doc.currency, doc.subtotal);
      totalRow(pdf, 'SST', doc.currency, doc.taxTotal);
      pdf.font('Helvetica-Bold');
      totalRow(pdf, 'Total credited', doc.currency, doc.total);
      pdf.font('Helvetica');

      if (doc.unallocated !== '0.0000') {
        pdf.moveDown(0.4);
        const y = pdf.y;
        pdf.rect(MARGIN, y, 495, 30).fill('#ecfdf5');
        pdf.fillColor('#065f46').font('Helvetica-Bold').fontSize(9.5);
        pdf.text(
          `Still available to use: ${doc.currency === 'MYR' ? 'RM ' : `${doc.currency} `}` +
            `${money(doc.unallocated)} — this can be set against a future invoice.`,
          MARGIN + 12,
          y + 11,
          { width: 471 },
        );
        pdf.fillColor('#000000').font('Helvetica').fontSize(9);
        pdf.y = y + 38;
      }

      pdf.moveDown(0.4);
      pdf.fontSize(7.5).fillColor('#71717a');
      pdf.text(
        doc.againstInvoiceNo
          ? `This credit note corrects invoice ${doc.againstInvoiceNo}. Keep both documents ` +
            'together: the invoice states what was charged, this states what was credited ' +
            'back, and the difference is what is payable.'
          : 'This is a standalone credit to the customer’s account, not tied to one invoice.',
        MARGIN,
        pdf.y,
        { width: 495, lineGap: 1.5 },
      );
      pdf.fillColor('#000000').fontSize(9);
    },
    { footNote: 'Credit note — retain with the invoice it corrects.' },
  );
}
