import http from 'node:http';
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {readInvoicePdf,invoiceFileFromResult,readInvoiceQr,readOrderImage,qrFileFromResult,imageFilesFromResult} from './pdf-store.mjs';
import {planRefresh,selectedOrderStage} from './refresh-plan.mjs';
import {findSavedInvoices} from './saved-invoices.mjs';
import {createZip} from './zip-archive.mjs';
const {isIssued,hasInvoiceLink,hasChatImages}=createRequire(import.meta.url)('./public/order-summary.js');
const EventDates=createRequire(import.meta.url)('./public/date-range.js');

const root=resolve(fileURLToPath(new URL('.',import.meta.url))), helper=resolve(process.env.INVOICE_HELPER_DIR||join(root,'../engine')), data=join(root,'.data');
await mkdir(data,{recursive:true,mode:0o700});
const port=Number(process.env.INVOICE_UI_PORT||4318), origin=`http://127.0.0.1:${port}`;
if(!Number.isInteger(port)||port<1||port>65535) throw Error('端口无效');
const tasks=new Map(); let active=null;
const stateFile=join(data,'events.json');
async function readState(){try{const state=JSON.parse(await readFile(stateFile,'utf8'));state.revision=Number.isSafeInteger(state.revision)?state.revision:0;return state}catch(e){if(e.code==='ENOENT')return {events:[],revision:0};throw e}}
let stateWriteQueue=Promise.resolve();
async function compareAndWriteState(value){let release;const previous=stateWriteQueue;stateWriteQueue=new Promise(resolve=>{release=resolve});await previous;try{const current=await readState(),revision=Number.isSafeInteger(current.revision)?current.revision:0;if(!Number.isSafeInteger(value.revision)||value.revision!==revision)return {conflict:true,revision};const next={...value,revision:revision+1};await writeFile(stateFile,JSON.stringify(next),{mode:0o600});return {ok:true,revision:next.revision}}finally{release()}}
function send(res,code,value,type='application/json; charset=utf-8'){res.writeHead(code,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",'Referrer-Policy':'no-referrer'});res.end(type.startsWith('application/json')?JSON.stringify(value):value)}
async function json(req){let chunks=[],size=0;for await(const c of req){size+=c.length;if(size>100000)throw Error('请求过大');chunks.push(c)}return JSON.parse(Buffer.concat(chunks).toString()||'{}')}
const date=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&!Number.isNaN(Date.parse(s+'T00:00:00Z'))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
function resultRows(file){return readFile(file,'utf8').then(JSON.parse).then(d=>d.results||[])}
function summary(r){const status=r.execution?.status||'',validClosed=r.orderMeta?.transactionStatus==='交易关闭'&&r.orderMeta?.closeReason==='超时关闭';return {id:String(r.bizOrderId||''),date:r.orderDate||'',shop:r.shopName||r.orderMeta?.shopName||'',amount:r.orderMeta?.amount||r.amount||'',action:r.actionPlan?.action||'',state:r.state||'',reason:status==='closed_timeout'&&!validClosed?'关闭状态未能确认，请人工核对':r.execution?.reason||r.actionPlan?.reason||'',execution:status==='closed_timeout'&&!validClosed?'manual_required':status,invoiceStatus:r.execution?.invoiceStatus||'',productUrl:r.execution?.productUrl||'',chatUrl:r.execution?.chatUrl||'',reviewUrl:r.execution?.finalUrl||'',url:r.url||'',detailUrl:r.detailUrl||'',platform:r.platform||'',checkedAt:r.checkedAt||''}}
async function runTask(kind,eventId,options){
 if(active)throw Error('已有任务运行中，请先等待或停止');
 const id=randomUUID(), prefix=`ui-task-${id}`, output=`${prefix}.json`, progress=`${prefix}-progress.json`;
 const args=['invoice-actions.js','--close-on-finish',`--output=${output}`,`--progress=${progress}`];
 if(options.forceDownloadIds?.length)args.push(`--force-download-ids=${options.forceDownloadIds.join(',')}`);
 if(kind==='scan'){
   args.push('--fresh','--execute','--confirm=YES_EXECUTE_TAOBAO_INVOICE_ACTIONS','--action=refresh','--apply-chat-card',`--start-date=${options.start}`,`--end-date=${options.end}`,'--max-pages=60');
   if(options.ranges?.length)args.push(`--date-ranges=${options.ranges.map(r=>`${r.start}:${r.end}`).join(',')}`);
   if(options.savedIds.length)args.push(`--skip-saved-ids=${options.savedIds.join(',')}`);
   if(options.eventOrderIds.length)args.push(`--event-order-ids=${options.eventOrderIds.join(',')}`);
   if(options.excludedOrderIds?.length)args.push(`--exclude-order-ids=${options.excludedOrderIds.join(',')}`);
   if(options.manualOrderMappings?.length){const manualFile=`${prefix}-manual-order-mappings.json`;await writeFile(join(helper,manualFile),JSON.stringify(options.manualOrderMappings),{mode:0o600});args.push(`--manual-order-mappings-file=${manualFile}`)}
   for(const [stage,ids] of Object.entries(options.requestedStages||{}))if(ids.length)args.push(`--stage-${stage}=${ids.join(',')}`);
 }
 else if(kind==='refresh'){
   const mappings=options.ordered.map(({order,stage})=>({bizOrderId:order.id,platform:order.platform,orderDate:order.date,amount:order.amount,shopName:order.shop,url:order.url,detailUrl:order.detailUrl,workflowStage:stage}));
   await writeFile(join(helper,progress),JSON.stringify({version:'0.1.0',mappings,resultsById:{}}),{mode:0o600});
   args.push('--execute','--confirm=YES_EXECUTE_TAOBAO_INVOICE_ACTIONS','--action=refresh',`--start-date=${options.start}`,`--end-date=${options.end}`,`--order-id=${mappings.map(x=>x.bizOrderId).join(',')}`);
   if(options.applyChatCard)args.push('--apply-chat-card');
 }
 else {
   const source=options.order;
   await writeFile(join(helper,progress),JSON.stringify({version:'0.1.0',mappings:[{bizOrderId:source.id,platform:source.platform,orderDate:source.date,amount:source.amount,shopName:source.shop,url:source.url,detailUrl:source.detailUrl}],resultsById:{}}),{mode:0o600});
   args.push('--execute','--confirm=YES_EXECUTE_TAOBAO_INVOICE_ACTIONS',`--action=${kind}`,`--order-id=${source.id}`);
 }
 const task={id,kind,eventId,status:'running',startedAt:new Date().toISOString(),log:kind==='refresh'?[`已跳过 ${options.stages.saved} 笔已保存 PDF；开票中 ${options.stages.pending} 笔，有入口待确认 ${options.stages.entry} 笔，客服聊天 ${options.stages.contact} 笔；另有 ${options.stages.unknown} 笔状态无法分类。`]:kind==='scan'?[`扫描日期：${EventDates.formatRange(options.ranges||{start:options.start,end:options.end})}；${options.savedIds.length} 笔已有查看发票的订单将跳过逐笔检查，按 Event 订单顺序检查；另包含 ${options.manualOrderMappings?.length||0} 笔手动补录订单（不受日期范围限制）；发现客服发来的申请卡片时会尝试填写并提交；不会发送客服消息，也不会批量提交普通系统开票申请。`]:[],rows:[],output,...(['scan','refresh'].includes(kind)?{range:EventDates.storeRange(options.ranges||{start:options.start,end:options.end})}:{}),...(kind==='refresh'?{stages:options.stages}:{})};tasks.set(id,task);active=task;
 const child=spawn(process.execPath,args,{cwd:helper,env:{...process.env,FORCE_COLOR:'0'},stdio:['ignore','pipe','pipe']});task.child=child;
 function log(chunk){task.log.push(...chunk.toString().replace(/\x1b\[[0-9;]*m/g,'').split(/\r?\n/).filter(Boolean));task.log=task.log.slice(-100)}child.stdout.on('data',log);child.stderr.on('data',log);
 child.on('error',e=>{task.log.push(`启动失败：${e.message}`)});
 child.on('close',async(code,signal)=>{let results=[];try{results=await resultRows(join(helper,output))}catch{try{let partial=JSON.parse(await readFile(join(helper,progress),'utf8'));results=Object.values(partial.resultsById||{});if(results.length)task.log.push('任务未完成，已保留已检查的订单；扫描覆盖范围未知。')}catch{}}task.rows=await Promise.all(results.map(async r=>({...summary(r),invoice:await invoiceFileFromResult(join(helper,'downloads'),r),qr:await qrFileFromResult(join(helper,'snapshots','chat-qr'),r),images:await imageFilesFromResult(join(helper,'snapshots','chat-qr'),r)})));task.code=code;task.status=task.stopping?'stopped':code===0?'finished':'failed';task.endedAt=new Date().toISOString();delete task.child;active=null;});
 return id;
}
function publicTask(t){if(!t)return null;const {child,...safe}=t;return safe}
const server=http.createServer(async(req,res)=>{try{
 if(req.headers.host!==`127.0.0.1:${port}`)return send(res,403,{error:'禁止访问'});
 let p=new URL(req.url,origin).pathname;
 if(p.startsWith('/api/')){
  if(req.headers.origin&&req.headers.origin!==origin)return send(res,403,{error:'来源不允许'});
  if(req.method!=='GET'&&(req.headers.origin!==origin||req.headers['x-invoice-request']!=='local-app'))return send(res,403,{error:'来源不允许'});
  if(p==='/api/state'&&req.method==='GET')return send(res,200,await readState());
  if(p==='/api/state'&&req.method==='PUT'){let v=await json(req);if(!Array.isArray(v.events)||v.events.length>500)throw Error('数据格式错误');const result=await compareAndWriteState(v);if(result.conflict)return send(res,409,{error:'订单数据已在其他页面更新；请刷新后再保存',revision:result.revision});return send(res,200,result)}
  if(p==='/api/config'&&req.method==='GET'){let c=JSON.parse(await readFile(join(helper,'invoice-config.json'),'utf8'));return send(res,200,{companyName:c.companyName||'',taxNo:c.taxNo||'',email:c.email||''})}
  if(p==='/api/exports/invoices'&&req.method==='POST'){
   const v=await json(req),state=await readState(),ev=state.events.find(e=>e.id===v.eventId);
   if(!ev)throw Error('Event 不存在');if(active?.eventId===ev.id)throw Error('此 Event 有任务运行中，请完成或停止后再导出');
   if(!Array.isArray(v.orderIds)||v.orderIds.length<1||v.orderIds.length>200||v.orderIds.some(id=>typeof id!=='string'||!/^[0-9]{8,30}$/.test(id))||new Set(v.orderIds).size!==v.orderIds.length)throw Error('请选择有效订单');
   const eventName=String(ev.name||'Event').replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_').trim().slice(0,80)||'Event',now=new Date(),datePrefix=`${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`,folder=`${datePrefix}_${eventName}`,entries=[];
   for(const id of v.orderIds){
    const index=ev.orders.findIndex(order=>order.id===id),order=ev.orders[index];if(!order||!hasInvoiceLink(order))throw Error(`订单 ${id} 没有可导出的发票`);
    const files=[];if(order.invoice?.name)files.push({ext:'pdf',data:await readInvoicePdf(join(helper,'downloads'),order.invoice.name)});
    const images=(order.images||[]).filter(image=>image.source==='manual'||(!image.source&&!hasChatImages(order)));
    for(const image of images){const ext=image.name.split('.').pop().toLowerCase();files.push({ext,data:await readOrderImage(join(helper,'snapshots','chat-qr'),image.name)});}
    if(!files.length)throw Error(`订单 ${id} 的发票文件不存在`);
    const seq=String(index+1),rawAmount=String(order.amount||'').trim().replace(/^[¥￥]\s*/,'').replace(/,/g,''),amountMatch=/^(\d+)(?:\.(\d{1,2}))?$/.exec(rawAmount),amount=amountMatch?`${amountMatch[1]}.${(amountMatch[2]||'').padEnd(2,'0')}`:'金额未知';for(let i=0;i<files.length;i++){const suffix=files.length===1?'':`_${i+1}`;entries.push({name:`${folder}/${seq}_CNY（${amount}）${suffix}.${files[i].ext}`,data:files[i].data})}
   }
   if(entries.reduce((sum,item)=>sum+item.data.length,0)>500*1024*1024)throw Error('所选发票总大小超过 500 MB，请分批导出');
   const archive=createZip(entries),filename=`${folder}.zip`;
   res.writeHead(200,{'Content-Type':'application/zip','Content-Length':archive.length,'Content-Disposition':`attachment; filename="invoices.zip"; filename*=UTF-8''${encodeURIComponent(filename)}`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(archive);return;
  }
  const uploadMatch=p.match(/^\/api\/images\/([0-9a-f-]+)\/(\d{8,30})$/);
  if(uploadMatch&&req.method==='POST'){
   const state=await readState(),ev=state.events.find(e=>e.id===uploadMatch[1]),order=ev?.orders?.find(o=>o.id===uploadMatch[2]);
   if(!order)throw Error('订单不存在');
   const contentType=req.headers['content-type'],ext=contentType==='image/png'?'png':contentType==='image/jpeg'?'jpg':'';if(!ext)throw Error('请选择 JPG 或 PNG 图片');
   let chunks=[],size=0;for await(const chunk of req){size+=chunk.length;if(size>20*1024*1024)throw Error('图片不能超过 20 MB');chunks.push(chunk)}
   const content=Buffer.concat(chunks),isPng=content.length>=8&&content.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')),isJpeg=content.length>=3&&content[0]===0xff&&content[1]===0xd8&&content[2]===0xff;if(ext==='png'&&!isPng||ext==='jpg'&&!isJpeg)throw Error('图片内容与文件格式不一致');
   const dir=join(helper,'snapshots','chat-qr');await mkdir(dir,{recursive:true,mode:0o700});
   const name=`${order.id}-${Date.now()}${String(Math.floor(Math.random()*1000000)).padStart(6,'0')}.${ext}`;
   await writeFile(join(dir,name),content,{flag:'wx',mode:0o600});return send(res,200,{name,source:'manual'});
  }
  let invoiceMatch=p.match(/^\/api\/invoices\/([0-9a-f-]+)\/(\d{8,30})$/);
  if(invoiceMatch&&req.method==='POST'){
   const state=await readState(),ev=state.events.find(e=>e.id===invoiceMatch[1]),order=ev?.orders?.find(o=>o.id===invoiceMatch[2]);
   if(!order)throw Error('订单不存在');
   if(req.headers['content-type']!=='application/pdf')throw Error('请选择 PDF 发票');
   let chunks=[],size=0;for await(const chunk of req){size+=chunk.length;if(size>20*1024*1024)throw Error('PDF 不能超过 20 MB');chunks.push(chunk)}
   const content=Buffer.concat(chunks);if(content.length<5||content.subarray(0,5).toString()!=='%PDF-')throw Error('文件不是可识别的 PDF');
   const dir=join(helper,'downloads');await mkdir(dir,{recursive:true,mode:0o700});
   const name=`${order.id}_manual_${Date.now()}_${randomUUID().slice(0,8)}.pdf`;
   await writeFile(join(dir,name),content,{flag:'wx',mode:0o600});
   return send(res,200,{name,savedAt:new Date().toISOString()});
  }
  if(invoiceMatch&&req.method==='GET'){let state=await readState(),ev=state.events.find(e=>e.id===invoiceMatch[1]),order=ev?.orders?.find(o=>o.id===invoiceMatch[2]);if(!order?.invoice?.name)return send(res,404,{error:'未找到发票'});let content=await readInvoicePdf(join(helper,'downloads'),order.invoice.name);return send(res,200,content,'application/pdf')}
  let imageMatch=p.match(/^\/api\/images\/([0-9a-f-]+)\/(\d{8,30})\/(\d+)$/);
  if(imageMatch&&req.method==='GET'){let state=await readState(),ev=state.events.find(e=>e.id===imageMatch[1]),order=ev?.orders?.find(o=>o.id===imageMatch[2]),item=order?.images?.[Number(imageMatch[3])];if(!item?.name||!item.name.startsWith(order.id+'-'))return send(res,404,{error:'未找到图片'});const content=await readOrderImage(join(helper,'snapshots','chat-qr'),item.name),type=/\.png$/i.test(item.name)?'image/png':'image/jpeg';return send(res,200,content,type)}
  let qrMatch=p.match(/^\/api\/qr\/([0-9a-f-]+)\/(\d{8,30})$/);
  if(qrMatch&&req.method==='GET'){let state=await readState(),ev=state.events.find(e=>e.id===qrMatch[1]),order=ev?.orders?.find(o=>o.id===qrMatch[2]);if(!order?.qr?.name||!order.qr.name.startsWith(order.id+'-'))return send(res,404,{error:'未找到二维码'});return send(res,200,await readInvoiceQr(join(helper,'snapshots','chat-qr'),order.qr.name),'image/png')}
  if(p==='/api/tasks'&&req.method==='GET')return send(res,200,[...tasks.values()].map(publicTask));
  if(p==='/api/tasks'&&req.method==='POST'){
   let v=await json(req),state=await readState(),ev=state.events.find(e=>e.id===v.eventId);if(!ev)throw Error('Event 不存在');
   if(v.kind==='scan'){
     if(active)throw Error('已有任务运行中，请先等待或停止');
     const ranges=EventDates.normalizeRanges(Array.isArray(v.ranges)?v.ranges:[{start:v.start,end:v.end}]),eventRanges=EventDates.normalizeRanges(ev.range);
     if(!ranges)throw Error('日期范围无效');
     if(!eventRanges||JSON.stringify(eventRanges)!==JSON.stringify(ranges))throw Error('Event 日期已变化，请刷新后重新确认');
     const start=ranges[0].start,end=ranges.at(-1).end;
     const orders=(ev.orders||[]).filter(o=>/^\d{8,30}$/.test(o.id||''));
     const {savedIds,recovered}=await findSavedInvoices(orders,helper);
     const recoveredById=new Map(recovered.map(item=>[item.id,item.invoice]));
     for(const order of orders)if(!isIssued(recoveredById.has(order.id)?{...order,invoice:recoveredById.get(order.id)}:order))savedIds.delete(order.id);
     const retainedRecovered=recovered.filter(item=>savedIds.has(item.id));
     const eventOrderIds=orders.map(o=>o.id);
     const manualOrderMappings=orders.filter(o=>o.manualAdded===true).map(o=>({bizOrderId:o.id,platform:o.platform==='tmall'?'tmall':'taobao',orderDate:o.date||'',amount:o.amount||'',shopName:o.shop||''}));
     const requestedStages={contact:[],system:[]};for(const o of orders){const stage=selectedOrderStage(o);if(stage==='contact_requested')requestedStages.contact.push(o.id);else if(stage==='system_requested')requestedStages.system.push(o.id)}
     const excludedOrderIds=(ev.excludedOrderIds||[]).filter(id=>typeof id==='string'&&/^\d{8,30}$/.test(id));
     return send(res,200,{id:await runTask('scan',v.eventId,{...v,start,end,ranges,savedIds:[...savedIds],eventOrderIds,manualOrderMappings,excludedOrderIds,requestedStages,forceDownloadIds:orders.filter(o=>o.invoiceLinkRemoved).map(o=>o.id)}),recovered:retainedRecovered});
   }
   if(v.kind==='refresh'){
     if(active)throw Error('已有任务运行中，请先等待或停止');
     const eventRange=EventDates.storeRange(ev.range);if(!eventRange)throw Error('请先设置 Event 日期');
     if(v.orderId!==undefined && (typeof v.orderId!=='string'||!/^\d{8,30}$/.test(v.orderId)))throw Error('订单号无效');
     const orders=(ev.orders||[]).filter(o=>/^\d{8,30}$/.test(o.id||'')&&(v.orderId===undefined||o.id===v.orderId));
     if(v.orderId!==undefined&&!orders.length)throw Error('该 Event 不包含此订单');
     const {savedIds,recovered}=await findSavedInvoices(orders,helper);
     // A deliberate single-order check can replace a bad chat image; bulk
     // refresh still skips all linked images and PDFs.
     if(v.orderId!==undefined)savedIds.delete(v.orderId);
     const {groups,ordered}=planRefresh(orders,savedIds),stages=Object.fromEntries(Object.entries(groups).map(([k,v])=>[k,v.length]));
     if(v.orderId!==undefined&&!ordered.length)ordered.push({order:orders[0],stage:'entry'});
     if(!ordered.length)return send(res,200,{id:null,stages,recovered});
     return send(res,200,{id:await runTask('refresh',v.eventId,{...eventRange,ordered,stages,applyChatCard:v.orderId!==undefined,forceDownloadIds:orders.filter(o=>o.invoiceLinkRemoved).map(o=>o.id)}),stages,recovered});
   }
   if(!['apply','download'].includes(v.kind)||v.confirm!==true)throw Error('操作或确认无效');
   if(active)throw Error('已有任务运行中，请先等待或停止');
   if(v.kind==='apply'){let c=JSON.parse(await readFile(join(helper,'invoice-config.json'),'utf8'));if(!v.config||['companyName','taxNo','email'].some(k=>(c[k]||'')!==(v.config[k]||'')))throw Error('开票资料已变化，请重新查看并确认');}
   let order=ev.orders?.find(o=>o.id===v.orderId);if(!order||!/^\d{8,30}$/.test(order.id))throw Error('订单不存在');
   if(v.kind==='apply'&&(order.action!=='apply_invoice'||order.execution))throw Error('订单状态不允许申请，请重新扫描并核对');
   if(v.kind==='apply'&&state.events.some(e=>e.orders?.some(o=>o.id===v.orderId&&o.execution)))throw Error('该订单已有操作记录，请先在淘宝核对，避免重复申请');
   if(v.kind==='download'&&!['download_invoice','inspect_invoice'].includes(order.action))throw Error('当前订单没有已识别的下载入口');
   if(v.kind==='apply'){order.execution='in_progress';order.reason='申请运行中或结果待确认，请在淘宝核对';await writeFile(stateFile,JSON.stringify(state),{mode:0o600})}
   return send(res,200,{id:await runTask(v.kind,v.eventId,{order})});
  }
  let match=p.match(/^\/api\/tasks\/([0-9a-f-]+)\/stop$/);if(match&&req.method==='POST'){let t=tasks.get(match[1]);if(!t?.child)throw Error('任务未运行');t.stopping=true;t.child.kill('SIGTERM');return send(res,200,{ok:true})}
  return send(res,404,{error:'未找到'});
 }
 if(req.method!=='GET')return send(res,405,'Method not allowed','text/plain');
 const files={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/date-range.js':'date-range.js','/order-summary.js':'order-summary.js','/style.css':'style.css'};if(!files[p])return send(res,404,'Not found','text/plain');
 const ext=p.endsWith('.js')?'text/javascript; charset=utf-8':p.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8';return send(res,200,await readFile(join(root,'public',files[p])),ext);
 }catch(e){send(res,400,{error:e.message||'操作失败'})}});
server.listen(port,'127.0.0.1',()=>console.log(`本机票夹：${origin}`));
process.on('SIGINT',()=>{if(active?.child)active.child.kill('SIGTERM');server.close()});
