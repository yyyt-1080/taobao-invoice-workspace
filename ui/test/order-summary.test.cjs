const {test}=require('node:test');const assert=require('node:assert/strict');const {hasChatImages,isIssued,isWaiting,needsReview,summarize}=require('../public/order-summary');
test('a saved PDF and a recent unresolved error remain independently visible',()=>{
 const order={invoice:{name:'invoice.pdf'},execution:'manual_required'};
 assert.equal(isIssued(order),true);assert.equal(needsReview(order),true);assert.equal(isWaiting(order),false);
});
test('counts may overlap when an issued invoice still needs review',()=>{
 const orders=[{invoice:{name:'a.pdf'},execution:'manual_required'},{execution:'pending'},{execution:'manual_required'},{action:'apply_invoice'},{invoiceStatus:'issued',execution:'blocked'}];
 assert.deepEqual(summarize(orders),{total:5,issued:1,waiting:1,review:4,savedPdf:1});
});
test('merchant chat images require review and do not count as issued',()=>{
 const order={images:[{name:'x.png',source:'chat'}],execution:'images_saved',statusTags:['已开票']};
 assert.equal(hasChatImages(order),true);assert.equal(isIssued(order),false);assert.equal(needsReview(order),true);
});
test('header uses displayed tag colors and exact note text',()=>{
 const {summarizeOrderHeader}=require('../public/order-summary');
 const tags=o=>o.tags, color=t=>t==='已开票'?'status-saved':t==='开票中'?'status-pending':'status-review';
 const orders=[{tags:['已开票'],invoice:{name:'a.pdf'}},{tags:['待核对'],reason:'已联系客服，开票中'}, {tags:['开票中'],reason:'页面显示开票中'}, {tags:['开票中'],reason:'申请已提交，页面显示开票中'}, {tags:['待核对'],reason:'已联系客服'}, {tags:['开票中'],reason:'等待回复'},{tags:['已开票','需人工核对'],reason:'已联系客服，开票中'}];
 assert.deepEqual(summarizeOrderHeader(orders,tags,color),{total:7,issued:2,savedPdf:1,systemPending:2,sellerPending:1,review:2});
});

test('issued status requires a linked invoice',()=>{assert.equal(isIssued({statusTags:['已开票']}),false);assert.equal(isIssued({statusTags:['已开票'],invoice:{name:'a.pdf'}}),true)});

test('selected system and seller statuses determine header counts regardless of notes',()=>{const {summarizeOrderHeader}=require('../public/order-summary');const get=o=>o.tags,color=t=>t==='已开票'?'status-saved':t==='系统开票中'?'status-pending':t==='客服开票中'?'status-customer':'status-review';const orders=[{tags:['系统开票中']},{tags:['客服开票中']},{tags:['待人工确认']},{tags:['已开票'],invoice:{name:'a.pdf'}}];assert.deepEqual(summarizeOrderHeader(orders,get,color),{total:4,issued:1,savedPdf:1,systemPending:1,sellerPending:1,review:1})});
test('only a linked invoice marked issued is treated as issued',()=>{
 assert.equal(isIssued({invoice:{name:'x.pdf'},statusTags:['待人工确认']}),false);
 assert.equal(isIssued({invoice:{name:'x.pdf'},statusTags:['系统开票中']}),false);
 assert.equal(isIssued({invoice:{name:'x.pdf'},statusTags:['已开票']}),true);
});
test('only timeout-closed results remove matching orders from the event',()=>{
 const {removeTimeoutClosedOrders}=require('../public/order-summary');
 const event={orders:[{id:'a',invoice:{name:'a.pdf'}},{id:'b'},{id:'c'}]};
 assert.equal(removeTimeoutClosedOrders(event,[{id:'a',execution:'closed_timeout'},{id:'b',execution:'manual_required'}]),1);
 assert.deepEqual(event.orders.map(o=>o.id),['b','c']);
 assert.equal(removeTimeoutClosedOrders(event,[{id:'a',execution:'closed_timeout'}]),0);
});
test('manually deleted orders are excluded from subsequent scans within that event',()=>{
 const {deleteSelectedOrders}=require('../public/order-summary');
 const e={orders:[{id:'a',invoice:{name:'file.pdf'}},{id:'b'},{id:'c'}],excludedOrderIds:['z']};
 assert.equal(deleteSelectedOrders(e,new Set(['a','c','missing'])),2);
 assert.deepEqual(e.orders.map(o=>o.id),['b']);assert.deepEqual(e.excludedOrderIds,['z','a','c']);
});
test('manual upload remains a valid invoice link after a chat image review',()=>{
 const {hasInvoiceLink}=require('../public/order-summary');
 const order={execution:'image_review',images:[{name:'upload.png',source:'manual'}],statusTags:['已开票']};
 assert.equal(hasInvoiceLink(order),true);assert.equal(isIssued(order),true);
 assert.equal(hasInvoiceLink({execution:'image_review',images:[{name:'chat.png',source:'chat'}]}),false);
});
test('amount totals use cents, exclude unknown values and follow displayed issued status',()=>{
 const {summarizeAmounts}=require('../public/order-summary');const tags=o=>o.tags||[],color=t=>t==='已开票'?'status-saved':'status-review';
 const orders=[{amount:'0.10',tags:['已开票']},{amount:'0.20',tags:['已开票']},{amount:'¥ 1,234.56',tags:['待人工确认']},{amount:'',tags:['已开票']},{amount:'未知',tags:['待人工确认']}];
 assert.deepEqual(summarizeAmounts(orders,tags,color),{expectedCents:123486,issuedCents:30,missingExpected:2,missingIssued:1});
});
test('daily breakdown groups order dates and keeps missing amounts visible',()=>{
 const {summarizeAmountsByDate}=require('../public/order-summary');const tags=o=>o.tags||[],color=t=>t==='已开票'?'status-saved':'status-review';
 const orders=[{date:'2026-10-25',amount:'0.10',tags:['已开票']},{date:'2026-10-25',amount:'0.20'},{date:'2026-10-26',amount:'12.34'},{date:'',amount:'',tags:['已开票']}];
 const days=summarizeAmountsByDate(orders,tags,color);
 assert.deepEqual(days.map(x=>[x.date,x.count,x.expectedCents,x.issuedCents,x.missingExpected]),[['2026-10-26',1,1234,0,0],['2026-10-25',2,30,10,0],['日期未知',1,0,0,1]]);
});
