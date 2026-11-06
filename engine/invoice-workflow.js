// Classify the invoice page reached from the order's invoice entry.
function classifyInvoiceWorkflowPage({text='',hasCompanyField=false,hasTaxField=false,hasSave=false,hasDownload=false}={}) {
  const t=String(text).replace(/\s+/g,' ');
  if (/验证码|安全验证|滑块验证|扫码登录|人机验证/.test(t)) return 'security';
  if (/交易关闭|订单已取消|申请被拒绝|开票失败|开票期限|超过.*开票/.test(t)) return 'manual';
  if (/已开票|该订单已开具/.test(t)) return 'issued';
  if (/开票中|商家正在开票|申请中|待商家开票/.test(t)) return 'pending';
  if (hasCompanyField&&hasTaxField&&hasSave) return 'form';
  if (hasDownload) return 'issued';
  return 'unknown';
}
module.exports={classifyInvoiceWorkflowPage};
