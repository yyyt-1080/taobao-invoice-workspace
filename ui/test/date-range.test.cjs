const test=require('node:test');
const assert=require('node:assert/strict');
const {validRange,resolveRange}=require('../public/date-range.js');
test('validates real calendar dates and inclusive range ordering',()=>{
 assert.equal(validRange({start:'2026-10-25',end:'2026-10-26'}),true);
 assert.equal(validRange({start:'2026-10-25',end:'2026-10-25'}),true);
 assert.equal(validRange({start:'2026-10-26',end:'2026-10-25'}),false);
 assert.equal(validRange({start:'2026-02-30',end:'2026-03-01'}),false);
 assert.equal(validRange({start:'',end:'2026-03-01'}),false);
});
test('saved Event range takes priority; legacy Events use latest valid scan',()=>{
 const e={range:{start:'2026-10-25',end:'2026-10-26'},scans:[{start:'2026-01-01',end:'2026-01-02'}]};
 assert.deepEqual(resolveRange(e),{start:'2026-10-25',end:'2026-10-26',ranges:[{start:'2026-10-25',end:'2026-10-26'}],source:'event'});
 delete e.range;e.scans.push({start:'',end:''});
 assert.deepEqual(resolveRange(e),{start:'2026-01-01',end:'2026-01-02',ranges:[{start:'2026-01-01',end:'2026-01-02'}],source:'previous_scan'});
 assert.equal(resolveRange({orders:[],scans:[]}),null);
});
