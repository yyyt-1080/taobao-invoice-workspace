(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.OrderSummary=factory()})(typeof globalThis!=='undefined'?globalThis:this,function(){
 function hasChatImages(order){return order?.execution==='image_review'||Boolean(order?.images?.some(img=>img.source==='chat'||(!img.source&&order.execution==='images_saved')))}
 function hasInvoiceLink(order){return Boolean(order?.invoice?.name||order?.images?.some(img=>img.source==='manual')||(!hasChatImages(order)&&order?.images?.length))}
 function isIssued(order){if(!hasInvoiceLink(order))return false;if(order?.statusTags?.length)return order.statusTags.includes('已开票');if(order?.manualStatus)return order.manualStatus.startsWith('已开票');return true}
 function isWaiting(order){if(!order?.invoice?.name&&!order?.statusTags?.length&&!order?.manualStatus&&['pending','submitted'].includes(order?.execution))return true;if(hasChatImages(order))return false;if(order?.statusTags?.length)return order.statusTags.some(label=>['开票中','系统开票中','客服开票中','已联系客服，客服开票中'].includes(label));if(order?.manualStatus)return order.manualStatus==='开票中';return ['pending','submitted'].includes(order?.execution)}
 function needsReview(order){if(hasChatImages(order))return true;if(order?.statusTags?.length)return order.statusTags.some(label=>label.includes('人工'));return Boolean(order?.images?.length)||!order?.execution||['manual_required','blocked','error','seller_contacted','chat_checked','qr_received','not_applied','uncertain','in_progress'].includes(order.execution)}
 function summarize(orders){const result={total:0,issued:0,waiting:0,review:0,savedPdf:0};for(const order of orders||[]){result.total++;if(isIssued(order))result.issued++;if(isWaiting(order))result.waiting++;if(needsReview(order))result.review++;if(order?.invoice?.name)result.savedPdf++}return result}
 function removeTimeoutClosedOrders(event,rows){
  const ids=new Set((rows||[]).filter(row=>row.execution==='closed_timeout'&&row.id).map(row=>row.id));
  if(!ids.size)return 0;const before=(event.orders||[]).length;event.orders=(event.orders||[]).filter(order=>!ids.has(order.id));return before-event.orders.length;
 }
 function deleteSelectedOrders(event,ids){
  const requested=new Set(ids),present=(event.orders||[]).filter(order=>requested.has(order.id)).map(order=>order.id);
  event.orders=(event.orders||[]).filter(order=>!requested.has(order.id));
  event.excludedOrderIds=[...new Set([...(event.excludedOrderIds||[]),...present])];
  return present.length;
 }
 function summarizeOrderHeader(orders,getTags,getColor){
  const result={total:0,issued:0,savedPdf:0,systemPending:0,sellerPending:0,review:0,submitted:0};
  for(const order of orders||[]){
   result.total++;
   if(order?.submission==='yes')result.submitted++;
   const tags=getTags(order),colors=tags.map(getColor),note=String(order.manualNote??order.reason??'');
   if(colors.includes('status-saved')){result.issued++;if(order.invoice?.name)result.savedPdf++;continue}
   if(tags.includes('客服开票中')||tags.includes('已联系客服，客服开票中')){result.sellerPending++;continue}
   if(tags.includes('系统开票中')){result.systemPending++;continue}
   if(tags.includes('待人工确认')){result.review++;continue}
   if(colors.includes('status-review')&&note.includes('已联系客服，开票中')){result.sellerPending++;continue}
   if(colors.includes('status-pending')&&note.includes('页面显示开票中')){result.systemPending++;continue}
   result.review++;
  }
  return result;
 }
 function summarizeAmounts(orders,getTags,getColor){
  const result={expectedCents:0,issuedCents:0,missingExpected:0,missingIssued:0};
  for(const order of orders||[]){
   const text=String(order.amount??'').trim().replace(/^[¥￥]\s*/,'').replace(/,/g,'');
   const match=/^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
   const cents=match?Number(match[1])*100+Number((match[2]||'').padEnd(2,'0')):NaN;
   const issued=getTags(order).some(tag=>getColor(tag)==='status-saved');
   if(!Number.isSafeInteger(cents)){result.missingExpected++;if(issued)result.missingIssued++;continue}
   result.expectedCents+=cents;if(issued)result.issuedCents+=cents;
  }
  return result;
 }
 function summarizeAmountsByDate(orders,getTags,getColor){
  const groups=new Map();
  for(const order of orders||[]){const date=/^\d{4}-\d{2}-\d{2}$/.test(order.date||'')?order.date:'日期未知';if(!groups.has(date))groups.set(date,[]);groups.get(date).push(order)}
  return [...groups].sort(([a],[b])=>a==='日期未知'?1:b==='日期未知'?-1:b.localeCompare(a)).map(([date,items])=>({date,count:items.length,...summarizeAmounts(items,getTags,getColor)}));
 }
 return {hasChatImages,hasInvoiceLink,isIssued,isWaiting,needsReview,summarize,summarizeOrderHeader,summarizeAmounts,summarizeAmountsByDate,removeTimeoutClosedOrders,deleteSelectedOrders};
});
