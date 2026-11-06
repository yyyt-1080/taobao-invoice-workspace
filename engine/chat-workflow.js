function analyzeRecentMessages(messages,orderId){
 if(!Array.isArray(messages)||!messages.length)return {kind:'unknown'};
 const recent=messages.slice(-5); const seller=recent.filter(m=>m.sender==='seller');
 if(recent.some(m=>!['seller','self'].includes(m.sender)))return {kind:'unknown'};
 const files=seller.filter(m=>m.pdf).reverse();
 if(files.length){const file=files[0];return {kind:'pdf',message:file,pdfCandidates:files,matchedOrder:String(file.text||'').includes(String(orderId))};}
 const image=seller.findLast(m=>m.image);
 if(image)return {kind:'image',message:image,matchedOrder:String(image.text||'').includes(String(orderId))};
 const card=seller.findLast(m=>m.applyCard);
 if(card)return {kind:'card',message:card,matchedOrder:String(card.text||'').includes(String(orderId))};
 if(recent.some(m=>m.sender==='self'&&/可以开发票吗|可以直接帮我开票吗/.test(m.text||'')))return {kind:'already_contacted'};
 return {kind:'no_invoice'};
}
module.exports={analyzeRecentMessages};
