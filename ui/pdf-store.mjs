import {realpath,readFile,stat} from 'node:fs/promises';
import {basename,resolve,sep} from 'node:path';
const limit=20*1024*1024;
export async function readInvoicePdf(downloadDir,name){
 if(typeof name!=='string'||!name||basename(name)!==name||!name.toLowerCase().endsWith('.pdf'))throw Error('PDF 文件名无效');
 const root=await realpath(downloadDir), file=await realpath(resolve(root,name));
 if(!file.startsWith(root+sep))throw Error('文件不在发票目录');
 const info=await stat(file);if(!info.isFile()||info.size>limit||info.size<5)throw Error('PDF 文件不存在或大小无效');
 const content=await readFile(file);if(content.subarray(0,5).toString()!=='%PDF-')throw Error('文件不是可识别的 PDF');
 return content;
}
export async function invoiceFileFromResult(downloadDir,result){
 const item=result?.execution?.downloadResult;
 if(!['downloaded','file_exists'].includes(result?.execution?.status)&&item?.status!=='pdf_mismatch_saved')return null;
 const file=item.path||item.existingPath;if(typeof file!=='string')return null;
 const name=basename(file);
 try{const root=await realpath(downloadDir);if(await realpath(file)!==await realpath(resolve(root,name)))return null;await readInvoicePdf(downloadDir,name);return {name,savedAt:item.downloadedAt||result.execution.executedAt||''}}catch{return null}
}
export async function readInvoiceQr(qrDir,name){
 if(typeof name!=='string'||!/^\d{8,30}-\d+\.png$/.test(name))throw Error('二维码文件名无效');
 const root=await realpath(qrDir),file=await realpath(resolve(root,name));
 if(!file.startsWith(root+sep))throw Error('文件不在二维码目录');
 const info=await stat(file);if(!info.isFile()||info.size>limit||info.size<8)throw Error('二维码文件不存在或大小无效');
 const content=await readFile(file);if(!content.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))throw Error('二维码文件不是 PNG');
 return content;
}
export async function readOrderImage(imageDir,name){
 if(typeof name!=='string'||!/^[0-9]{8,30}-[0-9]+\.(?:png|jpe?g)$/i.test(name))throw Error('图片文件名无效');
 const root=await realpath(imageDir),file=await realpath(resolve(root,name));
 if(!file.startsWith(root+sep))throw Error('文件不在图片目录');
 const info=await stat(file);if(!info.isFile()||info.size>limit||info.size<8)throw Error('图片文件不存在或大小无效');
 const content=await readFile(file),isPng=content.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')),isJpeg=content[0]===0xff&&content[1]===0xd8&&content[2]===0xff;
 if(name.toLowerCase().endsWith('.png')&&!isPng||/\.jpe?g$/i.test(name)&&!isJpeg)throw Error('图片内容与文件格式不一致');
 return content;
}
export async function qrFileFromResult(qrDir,result){
 const file=result?.execution?.qrPath;if(result?.execution?.status!=='qr_received'||typeof file!=='string')return null;
 const name=basename(file);
 try{const root=await realpath(qrDir);if(await realpath(file)!==await realpath(resolve(root,name)))return null;await readInvoiceQr(qrDir,name);return {name}}catch{return null}
}
export async function imageFilesFromResult(dir,result){
 if(result?.execution?.status!=='images_saved'||!Array.isArray(result.execution.imagePaths))return [];
 const files=[];
 for(const file of result.execution.imagePaths){
  if(typeof file!=='string')continue;const name=basename(file);
  try{const root=await realpath(dir);if(await realpath(file)!==await realpath(resolve(root,name)))continue;await readInvoiceQr(dir,name);files.push({name,source:'chat'})}catch{}
 }
 return files;
}
