import Anthropic from '@anthropic-ai/sdk';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { AssistantChatInput, AssistantProvider } from './provider.js';

/**
 * The real assistant, on the Claude API.
 *
 * The SDK's beta tool runner drives the agentic loop — model asks for a tool,
 * the tool runs, the result goes back, until the model answers in prose. Every
 * tool in the list has already been filtered to the caller's permissions and
 * closes over the caller's own tenant context, so there is nothing the loop
 * can reach that the signed-in user could not reach themselves.
 *
 * Failures come back as a message rather than a thrown 500: the drawer is a
 * conversation, and "I could not reach the model" is an answer the person can
 * act on, where a toast with a status code is not.
 */
export class AnthropicAssistantProvider implements AssistantProvider {
  readonly kind = 'anthropic' as const;
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async chat(input: AssistantChatInput): Promise<{ message: string }> {
    try {
      const finalMessage = await this.client.beta.messages.toolRunner({
        model: 'claude-opus-5',
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        system: input.system,
        tools: input.tools.map((tool) =>
          betaZodTool({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.schema,
            run: (toolInput) => tool.run(toolInput),
          }),
        ),
        messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
        // A chat turn that wants nine tool calls is confused about its job;
        // the drafts-not-postings design means long chains have nothing to do.
        max_iterations: 8,
      });

      const text = finalMessage.content
        .filter((block): block is { type: 'text'; text: string } & typeof block => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();

      return {
        message:
          text.length > 0
            ? text
            : 'I ran the requested actions but have nothing further to add — see the cards below.',
      };
    } catch (error) {
      if (error instanceof Anthropic.APIError) {
        return {
          message:
            `I could not reach the model just now (upstream ${error.status ?? 'error'}). ` +
            'Nothing was recorded. Please try again in a moment.',
        };
      }
      throw error;
    }
  }
}
