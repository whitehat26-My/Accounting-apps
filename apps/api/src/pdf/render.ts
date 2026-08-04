import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import type { InvoiceDocument, PayslipDocument, ReceiptDocument } from '@emil/db';

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

export function renderInvoicePdf(doc: InvoiceDocument): Promise<Buffer> {
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

    footer(pdf);
  });
}

export function renderReceiptPdf(doc: ReceiptDocument): Promise<Buffer> {
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

    footer(pdf);
  });
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
  return build((pdf) => {
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
    pdf.y = netY + 42;

    // ---- What the employer pays on top -------------------------------------
    sectionHeading(pdf, 'EMPLOYER CONTRIBUTIONS — NOT DEDUCTED FROM YOUR PAY');
    for (const line of doc.employerContributions) {
      amountRow(pdf, line.label, undefined, line.amount);
    }
    subtotalRow(pdf, 'Paid by the employer', doc.totalEmployerContributions);

    // ---- The basis, so every figure can be checked --------------------------
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
  });
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
