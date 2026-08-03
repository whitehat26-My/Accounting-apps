import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createContact, getContact, listContacts, withTenant, type Sql } from '@emil/db';
import { SQL } from '../tokens.js';
import { Doc } from '../openapi/doc.decorator.js';
import { Requires } from '../guards/decorators.js';
import { tenantContextOf } from '../context/request-context.js';
import { parse } from '../validation.js';

/**
 * Customers and suppliers.
 *
 * Small, and overdue: `contact` had tables since 0002 but no route, so a real
 * user could not add a customer at all and a clean tenant could not issue its
 * first invoice. Every test seeded rows directly, which is exactly why the gap
 * stayed invisible.
 */
@Controller('v1')
export class ContactsController {
  constructor(@Inject(SQL) private readonly sql: Sql) {}

  private ctx(request: FastifyRequest) {
    return tenantContextOf(request);
  }

  @Requires('contact.read')
  @Get('contacts')
  async list(
    @Query('role') role: string | undefined,
    @Query('includeInactive') includeInactive: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const parsed = parse(listSchema,
      {
        ...(role !== undefined ? { role } : {}),
        ...(includeInactive !== undefined ? { includeInactive: includeInactive === 'true' } : {}),
      },
    );

    const ctx = this.ctx(request);
    return { contacts: await withTenant(this.sql, ctx, (tx) => listContacts(tx, ctx, parsed)) };
  }

  @Requires('contact.read')
  @Get('contacts/:id')
  async get(@Param('id') id: string, @Req() request: FastifyRequest) {
    const ctx = this.ctx(request);
    return withTenant(this.sql, ctx, (tx) => getContact(tx, ctx, id));
  }

  @Requires('contact.write')
  @Doc({ request: () => contactSchema })
  @Post('contacts')
  async create(@Body() body: unknown, @Req() request: FastifyRequest) {
    const input = parse(contactSchema, body);
    const ctx = this.ctx(request);
    return withTenant(this.sql, ctx, (tx) => createContact(tx, ctx, input));
  }
}

const contactSchema = z.object({
  name: z.string().min(1),
  isCustomer: z.boolean().optional(),
  isSupplier: z.boolean().optional(),
  /**
   * NOT format-validated here.
   *
   * The authoritative check is LHDN's TIN lookup, and a regex guessed from
   * examples would reject valid identifiers — which stops a real business
   * invoicing a real customer. `einvoiceGaps` reports a MISSING TIN, which is
   * a fact rather than a guess about its shape.
   */
  tin: z.string().optional(),
  idType: z.enum(['BRN', 'NRIC', 'PASSPORT', 'ARMY']).optional(),
  idValue: z.string().optional(),
  sstNo: z.string().optional(),
  msicCode: z.string().optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  defaultCurrency: z.string().length(3).optional(),
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
  creditLimit: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
  requiresEinvoice: z.boolean().optional(),
});

const listSchema = z.object({
  role: z.enum(['CUSTOMER', 'SUPPLIER']).optional(),
  includeInactive: z.boolean().optional(),
});
