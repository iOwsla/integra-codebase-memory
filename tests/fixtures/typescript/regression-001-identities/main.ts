export const declared = function () { return 1; };
export function caller() { return declared(); }
export function scoped() {
  { const same = () => 1; same(); }
  { const same = () => 2; same(); }
}
