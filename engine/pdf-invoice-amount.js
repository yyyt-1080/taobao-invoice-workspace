'use strict';
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');

function amountInCents(value){
 const s=String(value??'').normalize('NFKC').trim();
 if(!/^(?:[¥￥]\s*)?(?:\d{1,3}(?:,\d{3})+|\d{1,12})(?:\.\d{1,2})?$/.test(s))return null;
 const number=s.replace(/^[¥￥]\s*/,'').replace(/,/g,'');
 const [whole,fraction='']=number.split('.');
 return BigInt(whole)*100n+BigInt((fraction+'00').slice(0,2));
}
function extractInvoiceTotal(text){
 const compact=String(text||'').normalize('NFKC').replace(/\s+/g,'');
 const markers=[...compact.matchAll(/价税合计/g)];
 if(!markers.length)return {ok:false,reason:'未识别到价税合计'};
 const cents=new Set();
 for(const marker of markers){
  const tail=compact.slice(marker.index+marker[0].length,marker.index+marker[0].length+120).split(/备注|开票人|购买方|销售方|发票号码|发票代码/)[0];
  for(const m of tail.matchAll(/[¥￥]([\d,]+(?:\.\d{1,2})?)(?![\d.])/g)){const n=amountInCents(m[1]);if(n!==null)cents.add(n.toString())}
  for(const m of tail.matchAll(/小写[)）:：]?(?:[¥￥])?([\d,]+(?:\.\d{1,2})?)(?![\d.])/g)){const n=amountInCents(m[1]);if(n!==null)cents.add(n.toString())}
 }
 if(cents.size!==1)return {ok:false,reason:cents.size?'识别到多个不同的价税合计，需人工核对':'无法读取价税合计的小写金额'};
 return {ok:true,cents:BigInt([...cents][0])};
}
async function extractPdfTextWithPdfJs(file){
 const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
 const data=new Uint8Array(fs.readFileSync(file));
 const task=pdfjs.getDocument({data,useSystemFonts:true});
 const document=await task.promise;
 const pages=[];
 try{
  for(let pageNumber=1;pageNumber<=document.numPages;pageNumber++){
   const page=await document.getPage(pageNumber);
   const content=await page.getTextContent();
   pages.push(content.items.filter(item=>typeof item.str==='string').map(item=>item.str).join(' '));
   page.cleanup();
  }
 }finally{await task.destroy()}
 return pages.join('\n');
}
async function extractPdfText(file){
 const stat=fs.statSync(file);if(!stat.isFile()||stat.size<5||stat.size>20*1024*1024)throw Error('PDF 大小无效');
 const fd=fs.openSync(file,'r');const header=Buffer.alloc(5);try{fs.readSync(fd,header,0,5,0)}finally{fs.closeSync(fd)}
 if(header.toString('ascii')!=='%PDF-')throw Error('下载内容不是 PDF');
 try{return await extractPdfTextWithPdfJs(file)}catch{throw Error('PDF 文本提取失败')}
}
async function compareInvoicePdf(file,orderAmount){
 const expected=amountInCents(orderAmount);if(expected===null)return {ok:false,reason:'订单总金额未知或格式无效'};
 let text;try{text=await extractPdfText(file)}catch(e){return {ok:false,reason:e.message}}
 const total=extractInvoiceTotal(text);if(!total.ok)return total;
 if(total.cents!==expected)return {ok:false,reason:'PDF 价税合计与订单金额不一致'};
 return {ok:true,match:'amount'};
}
module.exports={amountInCents,extractInvoiceTotal,extractPdfText,compareInvoicePdf};
