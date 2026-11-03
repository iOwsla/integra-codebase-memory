import { Handler } from './handler';
export class StripeHandler implements Handler {
  verify(payload: string): boolean { return payload.length > 0; }
}
export class CustomHandler implements Handler {
  verify(payload: string): boolean { return true; }
}
export class Base { run(): number { return 1; } }
export class Sub extends Base { run(): number { return 2; } }
export class Static extends Base { static run(): number { return 3; } }
