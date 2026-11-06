(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.EventDates=factory()})(typeof globalThis!=='undefined'?globalThis:this,function(){
 function validDate(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const d=new Date(value+'T00:00:00Z');return !Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===value}
 function normalizeRanges(value){
  const raw=Array.isArray(value)?value:Array.isArray(value?.ranges)?value.ranges:value&&validDate(value.start)&&validDate(value.end)?[{start:value.start,end:value.end}]:[];
  if(!raw.length||raw.some(r=>!r||!validDate(r.start)||!validDate(r.end)||r.start>r.end))return null;
  const sorted=raw.map(r=>({start:r.start,end:r.end})).sort((a,b)=>a.start.localeCompare(b.start)||a.end.localeCompare(b.end)),merged=[];
  for(const next of sorted){const last=merged.at(-1);if(!last){merged.push(next);continue}const dayAfter=new Date(Date.parse(last.end+'T00:00:00Z')+86400000).toISOString().slice(0,10);if(next.start<=dayAfter){if(next.end>last.end)last.end=next.end}else merged.push(next)}
  return merged;
 }
 function storeRange(value){const ranges=normalizeRanges(value);return ranges?{start:ranges[0].start,end:ranges.at(-1).end,ranges}:null}
 function validRange(value){return Boolean(normalizeRanges(value))}
 function containsDate(value,range){if(!validDate(value))return false;const ranges=normalizeRanges(range);return Boolean(ranges&&ranges.some(r=>value>=r.start&&value<=r.end))}
 function formatRange(value){const ranges=normalizeRanges(value);if(!ranges)return '';return ranges.map(r=>r.start===r.end?r.start:`${r.start} 至 ${r.end}`).join('、')}
 function equalRanges(a,b){const aa=normalizeRanges(a),bb=normalizeRanges(b);return Boolean(aa&&bb&&JSON.stringify(aa)===JSON.stringify(bb))}
 function resolveRange(event){const saved=storeRange(event?.range);if(saved)return {...saved,source:'event'};const scans=Array.isArray(event?.scans)?event.scans:[];for(let i=scans.length-1;i>=0;i--){const prior=storeRange(scans[i]);if(prior)return {...prior,source:'previous_scan'}}return null}
 return {validDate,normalizeRanges,storeRange,validRange,containsDate,formatRange,equalRanges,resolveRange};
});
