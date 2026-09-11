const dep = require('./target.cjs');
function entry() { return dep.answer(); }
module.exports = entry;
