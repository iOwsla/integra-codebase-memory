export const count = 1;
export let current = 2;
export const { first, second: renamed } = { first: 1, second: 2 };
export function overload(value: string): string;
export function overload(value: number): number;
export function overload(value: string | number) { return value; }
export class Accessors {
  get value() { return count; }
  set value(next: number) { current = next; }
}
export async function load() { const module = await import('./target.js'); return module.target(); }
export function access(item: Accessors) { item.value = 3; return item.value; }
