export function add(a: number, b: number) { return a + b; }
export const asyncArrow = async () => add(1, 2);
export default function namedDefault() { return add(2, 3); }
export interface Runnable { run(): number; }
export class Base { static version() { return 1; } }
export class Service extends Base implements Runnable {
  constructor() { super(); }
  run() { return add(3, 4); }
}
export type Result<T> = { value: T };
export enum State { Open, Closed }
export function overload(x: string): string;
export function overload(x: number): number;
export function overload(x: string | number) { return x; }
export const obj = { method() { return add(1, 2); } };
export function factory() { function nested() { return 1; } return () => nested(); }
