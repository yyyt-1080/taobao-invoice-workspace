import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {findSavedInvoices} from '../saved-invoices.mjs';
test('orders with a view-invoice link are skipped regardless of review status; only valid ledger files are recovered',async()=>{
 const root=await mkdtemp(join(tmpdir(),'event-saved-pdf-'));
 try{
  await mkdir(join(root,'downloads'));
  const a=join(root,'downloads','a.pdf'),b=join(root,'downloads','b.pdf'),bad=join(root,'downloads','bad.pdf');
  await writeFile(a,'%PDF-1.4\nvalid');await writeFile(b,'%PDF-1.4\nvalid');await writeFile(bad,'not pdf');
  await writeFile(join(root,'downloaded-invoices.json'),JSON.stringify({orders:{'22222222':{path:b},'33333333':{path:bad},'44444444':{path:'/etc/passwd'},'77777777':{path:a}}}));
  const orders=[{id:'11111111',invoice:{name:'a.pdf'},execution:'manual_required'},{id:'22222222'},{id:'33333333'},{id:'44444444'},{id:'55555555',invoice:{name:'missing.pdf'}},{id:'66666666',images:[{name:'image.png'}],execution:'manual_required'},{id:'77777777',invoiceLinkRemoved:true}];
  const result=await findSavedInvoices(orders,root);
  assert.deepEqual([...result.savedIds],['11111111','55555555','66666666','22222222']);assert.deepEqual(result.recovered.map(x=>[x.id,x.invoice.name]),[['22222222','b.pdf']]);
 } finally {await rm(root,{recursive:true,force:true})}
});
