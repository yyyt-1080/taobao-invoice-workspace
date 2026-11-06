import {test} from 'node:test';import assert from 'node:assert/strict';import {planRefresh} from '../refresh-plan.mjs';
test('PDFs are skipped, waiting applications first, unknown entries next, contact last',()=>{
 const orders=[{id:'a',action:'no_action'},{id:'b',execution:'pending'},{id:'c',action:'apply_invoice'},{id:'d',execution:'pending'},{id:'e',action:'manual_review'}];
 const plan=planRefresh(orders,new Set(['d']));
 assert.deepEqual(plan.ordered.map(x=>[x.order.id,x.stage]),[['b','system_requested'],['c','entry'],['a','contact']]);assert.deepEqual(plan.groups.saved.map(x=>x.id),['d']);assert.deepEqual(plan.groups.unknown.map(x=>x.id),['e']);
});
test('issued without a verified saved PDF remains eligible for checking',()=>{
 const p=planRefresh([{id:'a',execution:'file_exists'},{id:'b',invoiceStatus:'issued'},{id:'c',execution:'seller_contacted',action:'apply_invoice'}]);assert.deepEqual(p.ordered.map(x=>x.stage),['entry','entry','contact']);
});
test('explicit status chooses invoice, customer, or manual workflow',()=>{
 const orders=[{id:'system',statusTags:['系统开票中'],action:'no_action'},{id:'customer',statusTags:['已联系客服，客服开票中'],action:'apply_invoice'},{id:'contact',statusTags:['需要联系客服']},{id:'manual',statusTags:['待人工确认'],action:'apply_invoice'}];
 const p=planRefresh(orders);assert.deepEqual(p.ordered.map(x=>[x.order.id,x.stage]),[['system','system_requested'],['manual','entry'],['customer','contact_requested'],['contact','contact_requested']]);assert.deepEqual(p.groups.unknown.map(x=>x.id),[]);
});
