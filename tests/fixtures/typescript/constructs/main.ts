export function target<T>(value: T): T { return value; }
export function decorate<T extends Function>(value: T) { return value; }
@decorate
export abstract class Base<T> {
  abstract run(value: T): T;
  static build() { return target(1); }
}
export class Concrete extends Base<number> {
  constructor() { super(); }
  run(value: number) { return target(value); }
  arrow = (value: number) => target(value);
}
export namespace Nested {
  export const execute = () => target(1);
}
export const object = { invoke() { return target(2); } };
export const chained = new Concrete().run(3);
const { run: renamed } = new Concrete();
export const viaBinding = () => renamed(4);
export { target as alias };
