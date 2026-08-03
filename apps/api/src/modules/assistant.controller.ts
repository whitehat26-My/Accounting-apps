import { Body, Controller, Get, Inject, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTenant, type Sql } from '@emil/db';
import { ASSISTANT, SQL } from '../tokens.js';
import { Doc } from '../openapi/doc.decorator.js';
import { principalOf, tenantContextOf } from '../context/request-context.js';
import { parse } from '../validation.js';
import type { AssistantProvider } from '../assistant/provider.js';
import { buildAssistantContext } from '../assistant/context.js';
import { buildAssistantTools, type Collected } from '../assistant/tools.js';

/**
 * The in-app assistant: evaluate the numbers, teach the screens, and turn
 * plain words into records — with a human confirm on anything that is money.
 *
 * No `@Requires` on either route, deliberately: every member may talk to the
 * assistant, because the assistant is scoped to the member. The context
 * builder includes only the figures this caller's permissions reach, and the
 * tool list is filtered the same way — so a cashier's assistant genuinely
 * does not know what the boss's knows. That filter, not this route guard, is
 * the security boundary, and it is re-checked inside every tool.
 */
@Controller('v1/assistant')
export class AssistantController {
  constructor(
    @Inject(SQL) private readonly sql: Sql,
    @Inject(ASSISTANT) private readonly provider: AssistantProvider,
  ) {}

  /** Whether a model is connected — so the web can say so instead of failing. */
  @Get('status')
  status() {
    return {
      configured: this.provider.kind !== 'unconfigured',
      provider: this.provider.kind,
    };
  }

  @Doc({ request: () => chatSchema })
  @Post('chat')
  async chat(@Body() body: unknown, @Req() request: FastifyRequest) {
    const input = parse(chatSchema, body);
    const ctx = tenantContextOf(request);
    const { permissions } = principalOf(request);

    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());

    // One read-only transaction for the snapshot; the tools open their own
    // transactions per write, so a failed tool cannot poison the context read.
    const snapshot = await withTenant(this.sql, ctx, (tx) =>
      buildAssistantContext(tx, ctx, permissions, today),
    );

    const collected: Collected = { actions: [], drafts: [] };
    const tools = buildAssistantTools({ sql: this.sql, ctx, permissions, today, collected });

    const { message } = await this.provider.chat({
      system: systemPrompt(snapshot, input.screen),
      messages: input.messages,
      tools,
    });

    return {
      configured: this.provider.kind !== 'unconfigured',
      message,
      actions: collected.actions,
      drafts: collected.drafts,
    };
  }
}

const chatSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(4000),
      }),
    )
    .min(1)
    .max(24),
  /** Which screen the drawer was opened on, e.g. "pos" — context, not control. */
  screen: z.string().max(40).optional(),
});

/**
 * What every screen is for — static text, so "how do I…" answers cost no
 * tenant queries and cannot leak anything.
 */
const SCREEN_GUIDE = `
THE APP'S SCREENS
- Today: the day at a glance — takings by payment method, cash now and 30/60/90 days ahead, last week's digest with anything unusual flagged.
- Point of sale (pos): ring an over-the-counter sale. Pick items, choose payment method, ring — invoice, stock, cost and receipt post together.
- Repairs: workshop jobs from RECEIVED through QUOTED/APPROVED/IN_PROGRESS/READY to COLLECTED; quote, approve and bill from the job.
- Stock: quantities and weighted-average cost per tracked item; adjustments with a reason.
- Items: the catalogue — code, name, prices, whether stock is tracked.
- Sales: invoices — issue, take payment, download PDF, credit fully.
- Collections: who owes what, grouped by how late; send a WhatsApp reminder.
- Purchases: supplier bills — enter, approve (over the limit needs Approvals), pay.
- Approvals: bills waiting for an approver.
- Banking: import a bank statement (CSV or Maybank payment advice), match lines to invoices/bills, sign off the month; rules auto-categorise repeat lines.
- Insights: charts — daily takings, cash runway.
- Reports: P&L, balance sheet, trial balance, cash flow, changes in equity — with CSV export.
- Journals: the journal book, and manual entries (accruals, corrections) for the accountant.
- Team: who works here and what role each holds.
- Audit: every change ever made — who, when, from where — on a tamper-evident chain.
- Settings: chart of accounts, opening balances (what the shop had and owed on day one), tax codes, period lock and year-end close.
`;

function systemPrompt(snapshot: string, screen: string | undefined): string {
  return (
    'You are the in-app assistant for "Shah G Tech shop & books" — the point-of-sale, ' +
    'workshop and accounting system of Shah G Tech, a computer shop in Malaysia. ' +
    'The user is a member of that shop\'s team, talking to you from inside the app. ' +
    'Reply in the language they use (English or Malay), briefly and concretely.\n\n' +
    'HARD RULES\n' +
    '- Use ONLY the figures in the business snapshot below. If it is not there, say you ' +
    'cannot see it — never estimate or invent an amount.\n' +
    '- Dates are shown DD/MM/YYYY. Amounts are RM.\n' +
    '- You may record catalogue data (items, contacts) directly with the tools. ' +
    'Anything that moves money — an invoice, a sale — you may only DRAFT; the user ' +
    'confirms it on a card in the panel. Never claim money was recorded from a draft.\n' +
    '- Malaysian tax questions (SST, e-Invoice, LHDN thresholds): answer only what the ' +
    'app itself shows, and tell the user to confirm rates and rules with LHDN/RMCD or ' +
    'their tax agent. Do not guess rates.\n' +
    '- If a tool refuses for permissions, relay that plainly; do not look for another way.\n' +
    SCREEN_GUIDE +
    (screen ? `\nThe user currently has the "${screen}" screen open.\n` : '') +
    '\nBUSINESS SNAPSHOT (everything this user is allowed to see)\n' +
    snapshot
  );
}
