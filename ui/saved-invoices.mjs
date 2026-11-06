import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {invoiceFileFromResult} from './pdf-store.mjs';

export async function findSavedInvoices(orders,helper){
 const savedIds=new Set(),recovered=[],downloadDir=join(helper,'downloads');
 for(const order of orders){if(order.invoice?.name||order.images?.length)savedIds.add(order.id)}
 let ledger={};try{ledger=JSON.parse(await readFile(join(helper,'downloaded-invoices.json'),'utf8')).orders||{}}catch{}
 for(const order of orders){if(savedIds.has(order.id)||order.invoiceLinkRemoved)continue;const entry=ledger[order.id];if(!entry?.path)continue;const invoice=await invoiceFileFromResult(downloadDir,{execution:{status:'file_exists',downloadResult:{path:entry.path,downloadedAt:entry.downloadedAt}}});if(invoice){savedIds.add(order.id);recovered.push({id:order.id,invoice})}}
 return {savedIds,recovered};
}
