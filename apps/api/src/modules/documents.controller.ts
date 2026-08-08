import { Controller, Get, Inject, Param, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  fingerprintDocument,
  invoiceDocumentData,
  receiptDocumentData,
  withTenant,
  type Sql,
} from '@emil/db';
import { SQL } from '../tokens.js';
import { Requires } from '../guards/decorators.js';
import { tenantContextOf } from '../context/request-context.js';
import { renderInvoicePdf, renderReceiptPdf, renderThermalReceiptPdf } from '../pdf/render.js';
import { verifyUrl } from '../config.js';

/**
 * Printed documents.
 *
 * The renderer is presentation only — every figure on the page was computed
 * and stored when the document was issued, so printing can never disagree with
 * the ledger. A regenerated PDF of a 2024 invoice shows 2024's figures because
 * they are READ, not recomputed.
 *
 * Each printed invoice and receipt also carries its own fingerprint, computed
 * and stored HERE rather than at issue. That is what lets every document
 * already in the system gain a verifiable QR the next time it is printed,
 * with no backfill: the digest is a pure function of the frozen figures, so
 * computing it late gives the same answer as computing it early.
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
    const { data, digest } = await withTenant(this.sql, ctx, async (tx) => ({
      data: await invoiceDocumentData(tx, ctx, id),
      digest: (await fingerprintDocument(tx, ctx, 'INVOICE', id)).digest,
    }));
    const pdf = await renderInvoicePdf(data, { digest, verifyUrl: verifyUrl() });

    void reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `inline; filename="${data.invoiceNo}.pdf"`)
      .send(pdf);
  }

  /**
   * `?format=thermal` renders the same receipt on 80mm roll paper — what the
   * till actually prints. The A4 default stays for the emailed/filed copy.
   * Same stored data either way; only the garment changes.
   *
   * The thermal copy carries no QR: 80mm at 203dpi cannot hold a scannable
   * version-3 code beside anything else, and a code too small to read is
   * worse than none. The A4 copy is the one that gets filed and disputed.
   */
  @Requires('invoice.read')
  @Get('receipts/:id/pdf')
  async receiptPdf(
    @Param('id') id: string,
    @Query('format') format: string | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const ctx = tenantContextOf(request);
    const { data, digest } = await withTenant(this.sql, ctx, async (tx) => ({
      data: await receiptDocumentData(tx, ctx, id),
      digest: (await fingerprintDocument(tx, ctx, 'RECEIPT', id)).digest,
    }));
    const pdf =
      format === 'thermal'
        ? await renderThermalReceiptPdf(data)
        : await renderReceiptPdf(data, { digest, verifyUrl: verifyUrl() });

    void reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `inline; filename="${data.paymentNo}.pdf"`)
      .send(pdf);
  }
}
