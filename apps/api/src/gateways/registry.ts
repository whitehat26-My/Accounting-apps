import type { PaymentGateway } from '@emil/domain';

/**
 * Which `PaymentGateway` adapters this process can talk to.
 *
 * ---------------------------------------------------------------------------
 * IT SHIPS EMPTY, AND AN EMPTY REGISTRY IS THE CORRECT PRODUCTION STATE TODAY.
 *
 * No concrete adapter exists in this repository. Billplz and iPay88 both need
 * merchant credentials to exercise, and an adapter written from documentation
 * alone — endpoint paths, signature scheme, field names — would look complete
 * and be untestable. That is worse than an obvious gap, because a finished
 * looking client invites trust it has not earned.
 *
 * So the routes that need an adapter answer 503 rather than pretending. A
 * webhook route with no adapter cannot verify a signature, and a route that
 * accepts an unverifiable payment notification is a way to mark any invoice
 * paid for free.
 * ---------------------------------------------------------------------------
 */
export class GatewayRegistry {
  private readonly adapters = new Map<string, PaymentGateway>();

  register(gateway: PaymentGateway): void {
    this.adapters.set(gateway.provider.toUpperCase(), gateway);
  }

  get(provider: string): PaymentGateway | undefined {
    return this.adapters.get(provider.toUpperCase());
  }

  get providers(): string[] {
    return [...this.adapters.keys()];
  }
}
