const payee = require('./payee');
const idx = payee.getIndex();
const keys = Object.keys(idx);
console.log('index entries:', keys.length);
console.log('sample:', JSON.stringify(idx[keys[0]]).slice(0, 400));
