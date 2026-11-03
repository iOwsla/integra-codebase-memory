import { Handler } from './handler';
import { Base, CustomHandler, Static, StripeHandler } from './handlers';
export class Service {
  private readonly handlers: Record<string, Handler> = {};
  constructor(private readonly custom: CustomHandler) {}
  direct(h: Handler) { return h.verify('a'); }
  viaUnion(k: string) { const handler = this.handlers[k] || this.custom; return handler.verify('b'); }
  concrete(s: StripeHandler) { return s.verify('c'); }
  async viaPromise(load: () => Promise<Handler>) { return (await load()).verify('d'); }
  staticCall() { return Static.run(); }
  base(b: Base) { return b.run(); }
}
