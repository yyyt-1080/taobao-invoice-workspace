// Separate discovery from follow-up; only a verified saved PDF is skipped.
export function selectedOrderStage(order){
 const tags=Array.isArray(order.statusTags)?order.statusTags:order.manualStatus?[order.manualStatus]:[];
 if(tags.includes('客服开票中')||tags.includes('已联系客服，客服开票中')||tags.includes('已联系客服，客服开票')||tags.includes('需要联系客服'))return 'contact_requested';
 if(tags.includes('系统开票中'))return 'system_requested';
 if(tags.includes('待人工确认'))return 'manual';
 if(String(order.manualNote??order.reason??'').includes('已联系客服，开票中'))return 'contact_requested';
 if(tags.includes('开票中')||(!tags.length&&['pending','submitted'].includes(order.execution)))return 'system_requested';
 return '';
}
export function classifyRefreshOrder(order, hasPdf) {
 if (hasPdf) return 'saved';
 const requested=selectedOrderStage(order);if(requested==='manual')return 'entry';if(requested==='contact_requested')return 'contact';if(requested==='system_requested')return 'pending';
 if (['pending','submitted'].includes(order.execution) || order.state==='APPLIED_WAITING') return 'pending';
 if (['seller_contacted','chat_checked'].includes(order.execution)) return 'contact';
 if (order.invoiceStatus==='issued' || ['issued','downloaded','file_exists','not_applied'].includes(order.execution) || ['apply_invoice','download_invoice','inspect_invoice'].includes(order.action)) return 'entry';
 if (['no_action','contact_seller'].includes(order.action)) return 'contact';
 return 'unknown';
}
export function planRefresh(orders, savedIds=new Set()) {
 const groups={pending:[],entry:[],contact:[],saved:[],unknown:[]};
 for(const order of orders) groups[classifyRefreshOrder(order,savedIds.has(order.id))].push(order);
 return {groups,ordered:[...groups.pending.map(order=>({order,stage:selectedOrderStage(order)||'pending'})),...groups.entry.map(order=>({order,stage:'entry'})),...groups.contact.map(order=>({order,stage:selectedOrderStage(order)||'contact'}))]};
}
