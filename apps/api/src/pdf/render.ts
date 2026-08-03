import PDFDocument from 'pdfkit';
import type { InvoiceDocument, ReceiptDocument } from '@emil/db';

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

/** The shop's accent — the same emerald the app wears. */
const BRAND = '#059669';

function header(
  pdf: PDFKit.PDFDocument,
  seller: InvoiceDocument['seller'],
  title: string,
): void {
  // A brand band across the top: the one place a customer's copy carries the
  // shop's colour. Presentation only; every figure below is stored data.
  pdf.rect(0, 0, 595, 6).fill(BRAND);
  pdf.fillColor('#000000');

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
