import { Handler } from './handler';
export class StripeHandler implements Handler {
  verify(payload: string): boolean { return payload.length > 0; }
}
export class CustomHandler implements Handler {
  verify(payload: string): boolean { return true; }
}
export class Base { run(): number { return 1; } static make(): number { return 0; } }
export class Sub extends Base { run(): number { return super.run() + 2; } static make(): number { return 1; } }
export class Static extends Base { static run(): number { return 3; } }
export class Built { constructor(readonly n: number) {} }
export class Derived extends Built { constructor() { super(1); } }
