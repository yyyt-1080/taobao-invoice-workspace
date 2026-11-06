const crcTable=(()=>{const table=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;table[n]=c>>>0}return table})();
function crc32(data){let crc=0xffffffff;for(const byte of data)crc=crcTable[(crc^byte)&0xff]^(crc>>>8);return (crc^0xffffffff)>>>0}
function dosDateTime(date=new Date()){const year=Math.max(1980,date.getFullYear());return {time:(date.getHours()<<11)|(date.getMinutes()<<5)|(date.getSeconds()>>1),date:((year-1980)<<9)|((date.getMonth()+1)<<5)|date.getDate()}}

export function createZip(entries){
 const local=[],central=[];let offset=0,total=0;const stamp=dosDateTime();
 for(const entry of entries){
  const name=Buffer.from(entry.name,'utf8'),data=Buffer.from(entry.data);if(name.length>65535)throw Error('ZIP 文件名过长');
  const crc=crc32(data),header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(20,4);header.writeUInt16LE(0x0800,6);header.writeUInt16LE(0,8);header.writeUInt16LE(stamp.time,10);header.writeUInt16LE(stamp.date,12);header.writeUInt32LE(crc,14);header.writeUInt32LE(data.length,18);header.writeUInt32LE(data.length,22);header.writeUInt16LE(name.length,26);header.writeUInt16LE(0,28);local.push(header,name,data);total+=header.length+name.length+data.length;
  const record=Buffer.alloc(46);record.writeUInt32LE(0x02014b50,0);record.writeUInt16LE(20,4);record.writeUInt16LE(20,6);record.writeUInt16LE(0x0800,8);record.writeUInt16LE(0,10);record.writeUInt16LE(stamp.time,12);record.writeUInt16LE(stamp.date,14);record.writeUInt32LE(crc,16);record.writeUInt32LE(data.length,20);record.writeUInt32LE(data.length,24);record.writeUInt16LE(name.length,28);record.writeUInt16LE(0,30);record.writeUInt16LE(0,32);record.writeUInt16LE(0,34);record.writeUInt16LE(0,36);record.writeUInt32LE(0,38);record.writeUInt32LE(offset,42);central.push(record,name);offset=total;
 }
 const centralSize=central.reduce((sum,item)=>sum+item.length,0),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(0,4);end.writeUInt16LE(0,6);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(centralSize,12);end.writeUInt32LE(total,16);end.writeUInt16LE(0,20);return Buffer.concat([...local,...central,end]);
}
