import { Controller, Get } from '@nestjs/common';
import { Public } from '../guards/decorators.js';
import { apiDocumentWithCoverage } from '../openapi/document.js';

/**
 * The API's own description.
 *
 * ---------------------------------------------------------------------------
 * PUBLIC, AND THAT IS A DECISION RATHER THAN AN OVERSIGHT.
 *
 * The document contains paths, methods, header requirements and the NAME of the
 * permission each route enforces. It contains no tenant data, no schema of the
 * database, and nothing that is not already discoverable by anyone holding a
 * single valid credential.
 *
 * Requiring authentication to read it would mean a client author cannot see
 * what the API accepts until they have provisioned an account — which is
 * friction paid by every honest integrator to inconvenience an attacker for
 * about a minute. Security that rests on an endpoint list being secret is not
 * security; the auth guard and RLS are.
 *
 * What this route must NEVER carry is anything derived from a request: no
 * tenant, no user, no per-caller filtering of the operations shown. It is the
 * same document for everybody, which is also what makes it cacheable.
 * ---------------------------------------------------------------------------
 */
@Controller()
export class OpenApiController {
  @Public()
  @Get('openapi.json')
  document() {
    return apiDocumentWithCoverage();
  }
}
