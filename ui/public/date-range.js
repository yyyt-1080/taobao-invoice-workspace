(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.EventDates=factory()})(typeof globalThis!=='undefined'?globalThis:this,function(){
 function validDate(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const d=new Date(value+'T00:00:00Z');return !Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===value}
 function validRange(range){return Boolean(range&&validDate(range.start)&&validDate(range.end)&&range.start<=range.end)}
 function resolveRange(event){if(validRange(event?.range))return {start:event.range.start,end:event.range.end,source:'event'};const scans=Array.isArray(event?.scans)?event.scans:[];for(let i=scans.length-1;i>=0;i--)if(validRange(scans[i]))return {start:scans[i].start,end:scans[i].end,source:'previous_scan'};return null}
 return {validDate,validRange,resolveRange};
});
