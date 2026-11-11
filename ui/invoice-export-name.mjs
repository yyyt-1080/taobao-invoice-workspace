export function invoiceProjectName(text) {
  const lines = String(text || '').normalize('NFKC').replace(/\r/g, '').split('\n').map(line => line.trim()).filter(Boolean);
  const clean = value => String(value || '').normalize('NFKC')
    .replace(/^(?:项目名称|货物或应税劳务、服务名称)\s*[:：]?\s*/, '')
    .replace(/^[:：]\s*/, '')
    .split(/项目名称|货物或应税劳务、服务名称|\s{2,}|规格型号|单位|数量|单价|金额|税率|税额|合计|价税合计/)[0]
    .replace(/^[*＊\s]+|[*＊\s]+$/g, '').trim();

  // Only the first item row belongs in the ZIP filename.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], marker = line.search(/项目名称|货物或应税劳务、服务名称/);
    if (marker < 0) continue;
    const remainder = clean(line.slice(marker).replace(/^(?:项目名称|货物或应税劳务、服务名称)/, ''));
    if (remainder && remainder.length > 1) return remainder;
    for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) {
      const candidate = clean(lines[j]);
      if (candidate && candidate.length > 1 && !/^(规格型号|单位|数量|单价|金额|税率|税额|合计|价税合计)/.test(candidate)) return candidate;
    }
  }
  const starred = lines.find(line => /^\*[^*]{1,32}\*\s*\S/.test(line));
  return starred ? clean(starred) : '';
}

export function safeFilenamePart(value, fallback) {
  return String(value || '').normalize('NFKC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, '_').replace(/[. ]+$/g, '').slice(0, 72) || fallback;
}

export function invoiceAmountLabel(text, extractInvoiceTotal) {
  const result = extractInvoiceTotal(text);
  if (!result.ok) return '金额未识别';
  const value = result.cents, whole = value / 100n, fraction = String(value % 100n).padStart(2, '0');
  return `${whole}.${fraction}`;
}
