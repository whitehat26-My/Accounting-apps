import {
  buildCreditNoteDocument,
  buildInvoiceDocument,
  EInvoiceError,
  // `loadConfig` is the e-Invoice one here; `apps/api` has its own unrelated
  // `loadConfig`, so both sides alias it rather than leaving the reader to
  // work out which configuration is meant.
  loadConfig as loadEInvoiceConfig,
  queueSubmission,
} from '@emil/db';
import { handled, skipped, type Handler, type HandlerContext } from './registry.js';

/**
 * Put an issued document into the e-Invoice queue.
 *
 * ---------------------------------------------------------------------------
 * THE HANDLER THAT JUSTIFIES THE WHOLE SLICE.
 *
 * `queueSubmission` has existed and been correct since M6. Its only caller has
 * been `POST /v1/invoices/:id/einvoice/queue` — a route a human has to
 * remember to call. So the actual behaviour of this system has been: issue an
 * invoice through the API, and it never enters the MyInvois queue at all.
 *
 * Nothing failed. No error was raised, no row went red, the compliance summary
 * counted zero submissions and looked exactly like a business that had not
 * invoiced yet. Under a mandated submission regime, an omission with no
 * symptom is the worst possible shape for a defect.
 *
 * `invoice.issued` has been written to the outbox in the same transaction as
 * the ledger effect the whole time. This is the reader it was waiting for.
 * ---------------------------------------------------------------------------
 *
 * IDEMPOTENT, as every handler must be: `queueSubmission` upserts on
 * `(tenant_id, document_type, document_id)`, so a redelivery re-queues the same
 * submission rather than creating a second one. The attempt counter goes up,
 * which is accurate — it WAS queued twice.
 */
const queueDocument = (
  build: (context: HandlerContext, documentId: string) => Promise<Parameters<typeof queueSubmission>[2]>,
  idKey: string,
): Handler =>
  async (context) => {
    const { tx, ctx, event, log } = context;

    const config = await loadEInvoiceConfig(tx, ctx);
    if (!config.isEnabled) {
      // Not a failure. Most tenants below the mandate threshold will never
      // enable this, and retrying their every invoice for eight attempts before
      // dead-lettering it would turn an ordinary configuration into a queue
      // full of red.
      return skipped('e-Invoice is not enabled for this organisation');
    }

    const documentId = event.payload[idKey];
    if (typeof documentId !== 'string') {
      // A malformed payload is a bug in the emitter, not a transient fault, and
      // retrying it eight times will not improve it. Throwing still gets it to
      // the dead-letter queue where somebody can see it — which is the point.
      throw new Error(
        `Event ${event.eventType} carries no '${idKey}'; payload was ${JSON.stringify(event.payload)}`,
      );
    }

    try {
      const document = await build(context, documentId);
      const submission = await queueSubmission(tx, ctx, document, documentId);

      log('queued for MyInvois', {
        documentNo: submission.documentNo,
        submissionId: submission.id,
      });

      return handled({ submissionId: submission.id, documentNo: submission.documentNo });
    } catch (error) {
      /*
       * A document that fails validation is NOT retried.
       *
       * `DOCUMENT_INVALID` means a missing TIN, a bad classification code, or
       * arithmetic that does not add up — all master-data problems that will
       * fail identically on every one of the next eight attempts, an hour
       * further apart each time. Retrying wastes nothing but hides everything:
       * the event stays PENDING, so the queue looks busy rather than broken.
       *
       * Dead-lettering it immediately is what puts it in front of somebody.
       */
      if (error instanceof EInvoiceError && error.code === 'DOCUMENT_INVALID') {
        throw new PermanentHandlerError(
          `${event.eventType}: document cannot be submitted — ${error.message}`,
          error.detail,
        );
      }
      throw error;
    }
  };

/**
 * A failure that will not get better on its own.
 *
 * The relay dead-letters this immediately rather than working through the
 * backoff schedule. The distinction is worth the class: "the network was down"
 * and "this invoice has no customer TIN" both throw, and treating them the same
 * means either retrying what cannot succeed or giving up on what would have.
 */
export class PermanentHandlerError extends Error {
  readonly permanent = true;
  constructor(message: string, readonly detail?: unknown) {
    super(message);
    this.name = 'PermanentHandlerError';
  }
}

export const einvoiceHandlers = {
  'invoice.issued': queueDocument(
    ({ tx, ctx }, id) => buildInvoiceDocument(tx, ctx, id),
    'invoiceId',
  ),
  'creditnote.issued': queueDocument(
    ({ tx, ctx }, id) => buildCreditNoteDocument(tx, ctx, id),
    'creditNoteId',
  ),
  /*
   * `debitnote.issued` is deliberately absent.
   *
   * MyInvois has a DEBIT_NOTE document type and `einvoice_submission` accepts
   * it, but there is no `buildDebitNoteDocument` — M6 built the invoice and
   * credit-note mappings and stopped. Registering a handler that guessed at the
   * mapping would submit a plausible document with unverified field semantics
   * to a tax authority, which is precisely the failure CLAUDE.md's rule about
   * not guessing e-Invoice field requirements exists to prevent.
   *
   * So debit notes emit their event, no handler claims it, and the relay
   * reports them as unroutable rather than pretending. Visible, and correct.
   */
} as const;
