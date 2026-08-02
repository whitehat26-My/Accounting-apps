import { SetMetadata } from '@nestjs/common';
import type { z } from 'zod';

export const DOC_METADATA = 'emil:doc';

export interface RouteDoc {
  readonly summary?: string;
  readonly description?: string;
  /**
   * The Zod schema the handler validates its body with. The SAME object.
   *
   * A THUNK, and it has to be. A decorator is evaluated when the class is
   * defined, and controllers declare their schemas below the class — so
   * passing the schema directly reads a `const` inside its temporal dead zone
   * and throws at import time. Deferring the read until the scanner asks costs
   * two characters at each call site and removes the ordering constraint
   * entirely, which is better than moving a hundred declarations to the top of
   * ten files and requiring everyone to remember why they are there.
   */
  readonly request?: () => z.ZodType;
  readonly response?: () => z.ZodType;
  readonly deprecated?: boolean;
  /**
   * The body's shape is defined by a THIRD PARTY, not by this API.
   *
   * Exactly one route: the gateway webhook, whose payload is whatever the
   * payment provider sends. It is verified as a signed blob and handed to the
   * adapter's own parser, so there is no schema here to publish and there never
   * will be — the shape belongs to Billplz or iPay88, and it changes when they
   * change it.
   *
   * A distinct flag rather than an absent schema because the two mean opposite
   * things. An absent schema is "nobody has written this down yet" and should
   * fail the coverage check; this is "this is not ours to write down" and is
   * complete as it stands. Collapsing them would either leave a permanent
   * false gap in the report or excuse real ones.
   */
  readonly externalBody?: string;
}

/**
 * Attach the request and response shapes to a route.
 *
 * ---------------------------------------------------------------------------
 * PASS THE SCHEMA THE HANDLER ACTUALLY VALIDATES WITH. NOT A COPY OF IT.
 *
 *     @Doc({ request: invoiceSchema })
 *     @Post('invoices')
 *     async issueInvoice(@Body() body: unknown) {
 *       const input = parse(invoiceSchema, body);   // ← the same object
 *
 * That identity is the whole point. A decorator carrying a hand-written
 * description of the body is a second source of truth and drifts the first time
 * somebody adds a field; a decorator carrying the validator cannot, because
 * changing what the route accepts changes what the document says in the same
 * edit.
 *
 * Path, method, security and the permission are NOT here — they are reflected
 * off the router and the auth guard by `scan.ts`. Anything derivable from the
 * application is derived from it, so this decorator carries only what genuinely
 * cannot be: prose, and the body schema.
 * ---------------------------------------------------------------------------
 */
export const Doc = (doc: RouteDoc) => SetMetadata(DOC_METADATA, doc);
