import { Controller, Get, Inject, Param, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { invoiceDocumentData, receiptDocumentData, withTenant, type Sql } from '@emil/db';
import { SQL } from '../tokens.js';
import { Requires } from '../guards/decorators.js';
import { tenantContextOf } from '../context/request-context.js';
import { renderInvoicePdf, renderReceiptPdf } from '../pdf/render.js';

/**
 * Printed documents.
 *
 * The renderer is presentation only — every figure on the page was computed
 * and stored when the document was issued, so printing can never disagree with
 * the ledger. A regenerated PDF of a 2024 invoice shows 2024's figures because
 * they are READ, not recomputed.
 */
@Controller('v1')
export class DocumentsController {
  constructor(@Inject(SQL) private readonly sql: Sql) {}

  @Requires('invoice.read')
  @Get('invoices/:id/pdf')
  async invoicePdf(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const ctx = tenantContextOf(request);
    const data = await withTenant(this.sql, ctx, (tx) => invoiceDocumentData(tx, ctx, id));
    const pdf = await renderInvoicePdf(data);

    void reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `inline; filename="${data.invoiceNo}.pdf"`)
      .send(pdf);
  }

  @Requires('invoice.read')
  @Get('receipts/:id/pdf')
  async receiptPdf(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const ctx = tenantContextOf(request);
    const data = await withTenant(this.sql, ctx, (tx) => receiptDocumentData(tx, ctx, id));
    const pdf = await renderReceiptPdf(data);

    void reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `inline; filename="${data.paymentNo}.pdf"`)
      .send(pdf);
  }
}
