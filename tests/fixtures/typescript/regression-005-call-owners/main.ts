function target() { return 1; }
const top = target();
function enclosing() {
  const local = target();
  const object = { value: target() };
  const nested = () => { const value = target(); return value; };
  const missing = externalCall();
  class Local {
    field = target();
    arrow = () => { const value = target(); return value; };
    constructor() { const value = target(); }
    method() { const value = target(); }
    static { const value = target(); }
  }
  return [local, object, nested, missing, Local];
}
