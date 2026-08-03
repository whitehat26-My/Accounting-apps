import type { z } from 'zod';

/**
 * The assistant's port: one `chat()` behind which the model lives.
 *
 * Three implementations, mirroring the `PaymentGateway` pattern exactly:
 *
 *   - `AnthropicAssistantProvider` — the real one, behind ANTHROPIC_API_KEY.
 *   - `FakeAssistantProvider`      — deterministic, for tests. A message of
 *     the form `TOOL <name> <json>` executes that tool; anything else gets a
 *     fixed reply. It exists so the permission enforcement and the draft flow
 *     can be exercised end-to-end with no credentials and no network.
 *   - `UnconfiguredAssistantProvider` — the honest default. It says what is
 *     missing rather than pretending, the same register-style unblocker as
 *     the empty gateway registry answering 503.
 *
 * The provider is deliberately ignorant of tenants, permissions and SQL: it
 * receives a system prompt and a set of ALREADY-SCOPED tools, and everything
 * it can see or do arrived through those. Scoping happens where the request
 * context lives, not here.
 */

export interface AssistantMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/**
 * A tool the model may call. `run` receives the RAW input the model produced;
 * every implementation validates with `schema` before touching anything, and
 * returns a plain string for the model to read — including refusals and
 * failures, which are answers rather than exceptions.
 */
export interface AssistantTool {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodTypeAny;
  readonly run: (input: unknown) => Promise<string>;
}

export interface AssistantChatInput {
  readonly system: string;
  readonly messages: readonly AssistantMessage[];
  readonly tools: readonly AssistantTool[];
}

export interface AssistantProvider {
  readonly kind: 'anthropic' | 'fake' | 'unconfigured';
  chat(input: AssistantChatInput): Promise<{ message: string }>;
}

export class UnconfiguredAssistantProvider implements AssistantProvider {
  readonly kind = 'unconfigured' as const;

  async chat(): Promise<{ message: string }> {
    return {
      message:
        'The assistant is not connected yet. Set ANTHROPIC_API_KEY on the server ' +
        'and restart it — nothing else is required. The how-to-use guides on this ' +
        'panel work without it.',
    };
  }
}

/**
 * Deterministic stand-in for tests and local development.
 *
 * The `TOOL name {json}` grammar is not a convenience API — it is the smallest
 * way to drive a specific tool through the REAL execution path (validation,
 * permission re-check, database write, draft collection) from an e2e test.
 */
export class FakeAssistantProvider implements AssistantProvider {
  readonly kind = 'fake' as const;

  async chat(input: AssistantChatInput): Promise<{ message: string }> {
    const last = input.messages.at(-1);
    const match = last?.content.match(/^TOOL (\w+) (.*)$/s);

    if (!match) {
      return { message: `FAKE:REPLY context=${input.system.length}ch tools=${input.tools.length}` };
    }

    const tool = input.tools.find((t) => t.name === match[1]);
    if (!tool) {
      // The same thing the real runner would experience: a tool the caller's
      // permissions did not include simply is not there to call.
      return { message: `FAKE:NO_SUCH_TOOL ${match[1]}` };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(match[2]!);
    } catch {
      return { message: 'FAKE:BAD_JSON' };
    }

    const result = await tool.run(parsed);
    return { message: `FAKE:TOOL_RESULT ${result}` };
  }
}
