import { sum, Service } from './barrel';
import defaultFn, * as math from './math';
export function entry() { new Service().run(); math.add(1, 2); defaultFn(); return sum(1, 2); }
export async function dynamic() { return import('./math'); }
export function uncertain(x: any) { return x?.missing(); }
