// 淘宝发票动作计划生成器
// 默认只做 dry-run：识别下载、查看、申请开票、换开等候选动作，不提交表单。
process.stdout.setEncoding('utf8');
process.stderr.setEncoding('utf8');

const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  classifyInvoicePage,
  classifyPageErrorText: classifyRichPageErrorText,
} = require('./error-classifier');
const {
  ORDER_STATES,
  appendStateEvent,
  createOrderTrace,
  deriveStateFromClassification,
  deriveStateFromExecution,
  isTerminalState,
} = require('./order-state-machine');
const { log, setLogLevel } = require('./src/logger');
const { RateLimiter } = require('./src/rate-limiter');
const { gotoWithRetry, waitForContentReady, withPageTimeout } = require('./src/page-navigator');
const { classifyInvoiceWorkflowPage } = require('./invoice-workflow');
const { analyzeRecentMessages } = require('./chat-workflow');
const { amountInCents, compareInvoicePdf } = require('./pdf-invoice-amount');

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function buildDefaultDateRange() {
  const today = new Date();
  return {
    startDate: `${today.getFullYear()}-01-01`,
    endDate: formatDate(today),
  };
}

function parseArgs() {
  const defaultRange = buildDefaultDateRange();
  const args = {
    test: null,
    orderIds: [],
    skipSavedIds: [],
    pendingIds: [],
    eventOrderIds: [],
    excludedOrderIds: [],
    manualOrderMappingsFile: '',
    stageContactIds: [],
    stageSystemIds: [],
    stageManualIds: [],
    maxPages: 8,
    output: 'invoice-action-plan.json',
    progress: 'invoice-action-progress.json',
    execute: false,
    confirm: '',
    action: 'plan',
    dateRangesRaw: '',
    dateRanges: null,
    startDate: defaultRange.startDate,
    endDate: defaultRange.endDate,
    downloadDir: 'downloads',
    config: 'invoice-config.json',
    closeOnFinish: false,
    retryUncertain: false,
    fresh: false,
    resultsCsv: '',
    maxRetries: 2,
    manualTimeoutMs: 15 * 60 * 1000,
    contactedLedger: 'contacted-orders.json',
    downloadedLedger: 'downloaded-invoices.json',
    modifiedLedger: 'modified-orders.json',
    chatReplyLedger: 'seller-chat-replies.json',
    snapshotDir: 'snapshots',
    forceContact: false,
    forceDownload: false,
    forceDownloadIds: [],
    applyChatCard: false,
    outputExplicit: false,
    progressExplicit: false,
    resultsCsvExplicit: false,
  };

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--execute') {
      args.execute = true;
      continue;
    }
    if (arg === '--apply-chat-card') { args.applyChatCard = true; continue; }
    if (arg === '--close-on-finish') {
      args.closeOnFinish = true;
      continue;
    }
    if (arg === '--retry-uncertain') {
      args.retryUncertain = true;
      continue;
    }
    if (arg === '--fresh') {
      args.fresh = true;
      continue;
    }
    if (arg === '--force-contact') {
      args.forceContact = true;
      continue;
    }
    if (arg === '--force-download') {
      args.forceDownload = true;
      continue;
    }
    if (!arg.startsWith('--')) continue;
    const [key, value = ''] = arg.slice(2).split('=');
    if (key === 'test') args.test = parseInt(value, 10) || null;
    if (key === 'order-id' && value) args.orderIds.push(...value.split(',').map(item => item.trim()).filter(Boolean));
    if (key === 'skip-saved-ids' && value) args.skipSavedIds.push(...value.split(',').filter(id => /^\d{8,30}$/.test(id)));
    if (key === 'pending-ids' && value) args.pendingIds.push(...value.split(',').filter(id => /^\d{8,30}$/.test(id)));
    if (key === 'event-order-ids' && value) args.eventOrderIds.push(...value.split(',').filter(id => /^\d{8,30}$/.test(id)));
    if (key === 'exclude-order-ids' && value) args.excludedOrderIds.push(...value.split(',').filter(id => /^\d{8,30}$/.test(id)));
    if (key === 'manual-order-mappings-file') args.manualOrderMappingsFile = value;
    if (key === 'stage-contact' && value) args.stageContactIds.push(...value.split(',').filter(id => /^\d{8,30}$/.test(id)));
    if (key === 'stage-system' && value) args.stageSystemIds.push(...value.split(',').filter(id => /^\d{8,30}$/.test(id)));
    if (key === 'stage-manual' && value) args.stageManualIds.push(...value.split(',').filter(id => /^\d{8,30}$/.test(id)));
    if (key === 'force-download-ids' && value) args.forceDownloadIds.push(...value.split(',').filter(id => /^\d{8,30}$/.test(id)));
    if (key === 'max-pages') args.maxPages = parseInt(value, 10) || args.maxPages;
    if (key === 'output') {
      args.output = value;
      args.outputExplicit = true;
    }
    if (key === 'progress') {
      args.progress = value;
      args.progressExplicit = true;
    }
    if (key === 'confirm') args.confirm = value;
    if (key === 'action') args.action = value || args.action;
    if (key === 'start-date') args.startDate = value || args.startDate;
    if (key === 'end-date') args.endDate = value || args.endDate;
    if (key === 'date-ranges') args.dateRangesRaw = value;
    if (key === 'download-dir') args.downloadDir = value || args.downloadDir;
    if (key === 'config') args.config = value || args.config;
    if (key === 'results-csv') {
      args.resultsCsv = value;
      args.resultsCsvExplicit = true;
    }
    if (key === 'max-retries') args.maxRetries = Math.max(1, parseInt(value, 10) || args.maxRetries);
    if (key === 'manual-timeout-ms') args.manualTimeoutMs = Math.max(30000, parseInt(value, 10) || args.manualTimeoutMs);
    if (key === 'contacted-ledger') args.contactedLedger = value || args.contactedLedger;
    if (key === 'downloaded-ledger') args.downloadedLedger = value || args.downloadedLedger;
    if (key === 'modified-ledger') args.modifiedLedger = value || args.modifiedLedger;
    if (key === 'chat-reply-ledger') args.chatReplyLedger = value || args.chatReplyLedger;
    if (key === 'snapshot-dir') args.snapshotDir = value || args.snapshotDir;
  }

  if (args.dateRangesRaw) {
    const ranges = args.dateRangesRaw.split(',').map(item => {
      const [start, end, ...extra] = item.split(':');
      return {start, end, extra};
    });
    const valid = value => /^\d{4}-\d{2}-\d{2}$/.test(value||'') && !Number.isNaN(Date.parse(value+'T00:00:00Z')) && new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
    if (!ranges.length || ranges.some(r => r.extra.length || !valid(r.start) || !valid(r.end) || r.start > r.end)) throw new Error('日期区间无效');
    args.dateRanges = ranges.map(({start,end})=>({start,end})).sort((a,b)=>a.start.localeCompare(b.start));
    args.startDate = args.dateRanges[0].start;
    args.endDate = args.dateRanges.at(-1).end;
  }

  if (args.action === 'chat' || args.action === 'chat-followup') {
    args.action = 'chat';
    if (!args.outputExplicit) args.output = 'seller-chat-followup.json';
    if (!args.progressExplicit) args.progress = 'seller-chat-followup-progress.json';
    if (!args.resultsCsvExplicit) args.resultsCsv = 'seller-chat-followup.csv';
  }

  return args;
}

const cliArgs = parseArgs();

function safeRelativePath(value, fallbackName) {
  const name = value || fallbackName;
  if (path.isAbsolute(name) || name.includes('..')) {
    throw new Error(`不允许使用项目目录外的路径: ${name}`);
  }
  return path.join(__dirname, name);
}

const USER_DATA_DIR = path.join(__dirname, '.playwright-browser');
const OUTPUT_FILE = safeRelativePath(cliArgs.output, 'invoice-action-plan.json');
const OUTPUT_CSV_FILE = safeRelativePath(
  cliArgs.resultsCsv || cliArgs.output.replace(/\.json$/i, '.csv'),
  'invoice-action-plan.csv'
);
const PROGRESS_FILE = safeRelativePath(cliArgs.progress, 'invoice-action-progress.json');
const CONFIG_FILE = safeRelativePath(cliArgs.config, 'invoice-config.json');
const DOWNLOAD_DIR = safeRelativePath(cliArgs.downloadDir, 'downloads');
const CONTACTED_LEDGER_FILE = safeRelativePath(cliArgs.contactedLedger, 'contacted-orders.json');
const DOWNLOADED_LEDGER_FILE = safeRelativePath(cliArgs.downloadedLedger, 'downloaded-invoices.json');
const MODIFIED_LEDGER_FILE = safeRelativePath(cliArgs.modifiedLedger, 'modified-orders.json');
const CHAT_REPLY_LEDGER_FILE = safeRelativePath(cliArgs.chatReplyLedger, 'seller-chat-replies.json');
const SNAPSHOT_DIR = safeRelativePath(cliArgs.snapshotDir, 'snapshots');
const DEBUG_CHAT_FILE = path.join(__dirname, 'debug-chat-page.json');
const LIST_URL = 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm';
const CONFIRM_TEXT = 'YES_EXECUTE_TAOBAO_INVOICE_ACTIONS';

const CONFIG = {
  listWaitTimeout: 20000,
  pageTimeout: 60000,
  detailWaitTimeout: 30000,
  loginWaitTimeout: 180000,
  actionReadyTimeout: 20000,
  manualTimeoutMs: cliArgs.manualTimeoutMs,
  delayMin: 1500,
  delayMax: 3000,
  maxRetries: cliArgs.maxRetries,
};

const ORDER_TIMEOUT_MS = 120000; // 单订单最大处理时间 2 分钟

async function withOrderTimeout(fn, timeoutMs = ORDER_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('ORDER_TIMEOUT: 单订单处理超时')), timeoutMs);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const LOGIN_URL_MARKERS = [
  'login',
  'havanaone',
  'havanone',
  'passport.taobao.com',
  'login.taobao.com',
  'havanalogin',
];

const ACTION_KEYWORDS = [
  { type: 'download_invoice', words: ['下载发票', '发票下载'] },
  { type: 'send_email', words: ['发送邮箱', '发送到邮箱', '发邮箱'] },
  { type: 'view_invoice', words: ['查看发票', '发票详情', '查看电子发票'] },
  { type: 'reissue_invoice', words: ['换开发票', '换开', '重新开票', '重开发票'] },
  { type: 'modify_invoice', words: ['修改申请', '修改发票', '修改开票信息'] },
  { type: 'apply_invoice', words: ['申请开票', '开具发票', '我要开票'] },
  { type: 'contact_seller', words: ['咨询商家', '联系商家', '联系卖家', '旺旺联系', '联系客服'] },
  { type: 'view_history', words: ['申请历史', '查看申请历史'] },
];

const MUTATING_ACTIONS = new Set(['apply_invoice', 'reissue_invoice', 'modify_invoice', 'send_email']);
const RETRYABLE_STATUS = new Set(['error']);
const UNCERTAIN_STATUS = new Set(['unknown', 'no_action']);

// Adaptive rate limiter
const rateLimiter = new RateLimiter({
  delayMin: CONFIG.delayMin,
  delayMax: CONFIG.delayMax,
  batchSize: 10,
  batchPauseMin: 5000,
  batchPauseMax: 15000,
  cooldownDurationMs: 300000,
  cooldownDelayMin: 8000,
  cooldownDelayMax: 20000,
});
const EXECUTABLE_ACTIONS = new Set(['reissue', 'apply', 'download', 'all', 'chat', 'workflow', 'refresh']);
const TERMINAL_EXECUTION_STATUS = new Set(['submitted', 'pending', 'downloaded', 'file_exists', 'seller_contacted']);

const VERIFICATION_TEXT_MARKERS = [
  '请扫码登录',
  '扫码登录',
  '验证码',
  '请输入验证码',
  '滑动验证',
  '人机验证',
  '安全验证',
  '请完成验证',
  '请拖动滑块',
];

const MESSAGE_FIELD_SELECTORS = [
  'textarea',
  'input[type="text"]',
  'div[contenteditable]',
  'div[contenteditable="true"]',
  '[role="textbox"]',
  '.editBox',
  '.biz-expression-editor',
  '.text-area',
  '[aria-label*="消息"]',
  '[aria-label*="输入"]',
  '[placeholder*="请输入"]',
  '[placeholder*="输入"]',
].join(', ');

const SEND_BUTTON_TEXTS = ['发送', '发 送', '确认发送', '发送消息'];
const WEB_CHAT_TEXTS = ['网页聊天', '网页版聊天', '继续网页聊天', '继续网页版聊天', '继续使用网页聊天', '留在网页版'];
const CHAT_HINT_CLOSE_SELECTORS = ['.next-balloon-close', '[aria-label="关闭"]', '[title="关闭"]'];
const CHAT_INVOICE_FILE_EXTENSIONS = ['.pdf', '.ofd', '.xml', '.zip', '.rar', '.7z', '.jpg', '.jpeg', '.png', '.webp'];
const CHAT_INVOICE_LINK_PATTERN = /发票|电子票|电子发票|开票|附件|文件|下载|pdf|ofd|invoice|fapiao|bill/i;
const CHAT_INFO_REQUEST_PATTERN = /请.*(提供|补充|发送).*(邮箱|抬头|税号|纳税人|资料|信息)|需要.*(邮箱|抬头|税号|纳税人|资料|信息)|(邮箱|抬头|税号|纳税人识别号).*(发一下|提供一下|发我|给我)/;
const CHAT_REJECTION_PATTERN = /无法开|不能开|开不了|不给开|不支持开|已超过|过期|超时|无法补开|无法重开/;
const CHAT_FILE_DOWNLOAD_TEXTS = ['下载文件', '下载附件', '保存文件', '下载'];

const PAGE_ERROR_HINTS = {
  expired: [
    '订单超过可开票期限',
    '超过开票日期',
    '已超过开票日期',
    '超过可开票时间',
    '已超过可开票时间',
    '超过开票时间',
    '开票申请已截止',
    '超过申请时效',
    '开票已截止',
  ],
  wrongTitle: ['抬头信息输入有误', '抬头错误', '发票抬头有误'],
  wrongTaxNo: ['税号错误', '税号有误', '纳税人识别号错误', '税号不正确'],
  missingEmail: ['请提供邮箱', '请提供电子邮箱', '提供电子邮箱', '未提供邮箱', '缺少邮箱', '电子邮箱'],
  missingInfo: ['信息不完整', '请补充信息', '信息有误', '请核实发票信息'],
  amountMismatch: ['金额不符', '金额有误', '开票金额不符'],
  rejected: ['商家拒绝', '审核不通过', '审核未通过', '申请失败', '拒绝开票'],
};

const DEFAULT_SELLER_MESSAGE_TEMPLATE = [
  '您好，这笔订单需要申请开具发票。订单号：{orderId}。烦请协助开具发票。',
  '发票信息如下：发票抬头：{companyName}；税号：{taxNo}；发票类型：{invoiceType}；接收邮箱：{email}。',
  '如需补充信息，请告知，谢谢。',
].join(' ');

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withTimeout(promise, timeoutMs, fallbackValue) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise(resolve => {
        timer = setTimeout(() => resolve(fallbackValue), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function randomDelay() {
  return rateLimiter.wait();
}

function isLoginOrVerifyUrl(url) {
  const normalized = String(url || '').toLowerCase();
  return LOGIN_URL_MARKERS.some(marker => normalized.includes(marker));
}

function loadProgress() {
  if (!fs.existsSync(PROGRESS_FILE)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
    return data && typeof data === 'object' ? data : null;
  } catch (e) {
    console.error('⚠️  进度文件损坏，从头开始:', e.message);
    return null;
  }
}

function loadInvoiceConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error(`找不到配置文件: ${CONFIG_FILE}。请复制 invoice-config.example.json 为 invoice-config.json 并填写公司信息。`);
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const required = ['companyName', 'taxNo'];
  for (const key of required) {
    if (!config[key] || typeof config[key] !== 'string') {
      throw new Error(`配置文件缺少 ${key}`);
    }
  }

  return {
    companyName: config.companyName.trim(),
    taxNo: config.taxNo.trim(),
    email: (config.email || '').trim(),
    phone: (config.phone || '').trim(),
    address: (config.address || '').trim(),
    bankName: (config.bankName || '').trim(),
    bankAccount: (config.bankAccount || '').trim(),
    sellerMessageTemplate: (config.sellerMessageTemplate || '').trim(),
  };
}

function saveJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function saveDebugJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function buildRedactionSecrets(invoiceConfig = {}) {
  return Object.values(invoiceConfig || {})
    .filter(value => typeof value === 'string')
    .map(value => value.trim())
    .filter(value => value.length >= 4 && !/^EXAMPLE_/i.test(value));
}

function redactSensitiveText(text, invoiceConfig = {}) {
  let next = String(text || '');
  for (const secret of buildRedactionSecrets(invoiceConfig)) {
    next = next.split(secret).join(`[REDACTED_${secret.length}]`);
  }
  return next;
}

async function collectPageSnapshot(page, mapping, label, invoiceConfig = {}, options = {}) {
  const { saveArtifacts = false, historyText = '', invoiceInfo = null, candidates = null } = options;
  const capturedAt = new Date().toISOString();
  const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  const title = await page.title().catch(() => '');
  const url = page.url();
  const buttonTexts = await page.evaluate(() => {
    function isVisible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    }
    return [...document.querySelectorAll('button, a, [role="button"]')]
      .filter(isVisible)
      .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 120);
  }).catch(() => []);
  const actionCandidates = candidates || await collectActionCandidates(page).catch(() => []);

  const snapshot = {
    capturedAt,
    label,
    orderId: mapping?.bizOrderId || '',
    url,
    title,
    text: bodyText,
    historyText,
    buttons: buttonTexts,
    candidates: actionCandidates,
    invoiceInfo,
    artifacts: {},
  };

  if (!saveArtifacts) return snapshot;

  ensureDirectory(SNAPSHOT_DIR);
  const stamp = capturedAt.replace(/[-:.TZ]/g, '').slice(0, 14);
  const baseName = [
    stamp,
    sanitizeFilenamePart(mapping?.bizOrderId || 'unknown_order'),
    sanitizeFilenamePart(label || 'snapshot'),
  ].filter(Boolean).join('_');
  const screenshotPath = path.join(SNAPSHOT_DIR, `${baseName}.png`);
  const htmlPath = path.join(SNAPSHOT_DIR, `${baseName}.html`);
  const textPath = path.join(SNAPSHOT_DIR, `${baseName}.txt`);

  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => null);
  const html = await page.content().catch(() => '');
  fs.writeFileSync(htmlPath, redactSensitiveText(html, invoiceConfig), 'utf8');
  fs.writeFileSync(textPath, redactSensitiveText(bodyText, invoiceConfig), 'utf8');

  snapshot.artifacts = {
    screenshotPath: fs.existsSync(screenshotPath) ? screenshotPath : '',
    htmlSnapshotPath: htmlPath,
    textSnapshotPath: textPath,
  };
  return snapshot;
}

function loadContactedLedger() {
  if (!fs.existsSync(CONTACTED_LEDGER_FILE)) {
    return { version: '0.1.0', orders: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(CONTACTED_LEDGER_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        version: parsed.version || '0.1.0',
        generatedFromArtifactsAt: parsed.generatedFromArtifactsAt || '',
        updatedAt: parsed.updatedAt || '',
        orders: parsed.orders && typeof parsed.orders === 'object' ? parsed.orders : {},
      };
    }
  } catch (error) {
    console.error(`⚠️  联系商家台账读取失败，将新建台账: ${error.message}`);
  }
  return { version: '0.1.0', orders: {} };
}

function saveContactedLedger(ledger) {
  saveJsonAtomic(CONTACTED_LEDGER_FILE, {
    version: ledger.version || '0.1.0',
    generatedFromArtifactsAt: ledger.generatedFromArtifactsAt || '',
    updatedAt: new Date().toISOString(),
    orders: ledger.orders || {},
  });
}

function loadDownloadedLedger() {
  if (!fs.existsSync(DOWNLOADED_LEDGER_FILE)) {
    return { version: '0.1.0', orders: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(DOWNLOADED_LEDGER_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        version: parsed.version || '0.1.0',
        updatedAt: parsed.updatedAt || '',
        orders: parsed.orders && typeof parsed.orders === 'object' ? parsed.orders : {},
      };
    }
  } catch (error) {
    console.error(`⚠️  下载台账读取失败，将新建台账: ${error.message}`);
  }
  return { version: '0.1.0', orders: {} };
}

function saveDownloadedLedger(ledger) {
  saveJsonAtomic(DOWNLOADED_LEDGER_FILE, {
    version: ledger.version || '0.1.0',
    updatedAt: new Date().toISOString(),
    orders: ledger.orders || {},
  });
}

function getDownloadedLedgerRecord(orderId) {
  const normalizedOrderId = String(orderId || '').trim();
  if (!normalizedOrderId) return null;
  const ledger = loadDownloadedLedger();
  const record = ledger.orders?.[normalizedOrderId] || null;
  if (!record?.path) return record;
  return fs.existsSync(record.path) ? record : null;
}

function recordDownloadedInvoice(mapping, downloadResult, inspection) {
  const orderId = String(mapping?.bizOrderId || '').trim();
  if (!orderId || !downloadResult?.path) return null;
  const ledger = loadDownloadedLedger();
  const existing = ledger.orders?.[orderId] || {};
  const record = {
    orderId,
    shopName: mapping.shopName || inspection?.orderMeta?.shopName || existing.shopName || '',
    amount: mapping.amount || inspection?.orderMeta?.amount || existing.amount || '',
    orderDate: mapping.orderDate || existing.orderDate || '',
    invoiceType: inspection?.invoiceInfo?.invoiceType || existing.invoiceType || '',
    invoiceTitle: inspection?.invoiceInfo?.invoiceTitle || existing.invoiceTitle || '',
    filename: downloadResult.filename || existing.filename || '',
    path: downloadResult.path || existing.path || '',
    downloadedAt: downloadResult.downloadedAt || existing.downloadedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  ledger.orders = { ...(ledger.orders || {}), [orderId]: record };
  saveDownloadedLedger(ledger);
  return record;
}

function loadChatReplyLedger() {
  if (!fs.existsSync(CHAT_REPLY_LEDGER_FILE)) {
    return { version: '0.1.0', orders: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(CHAT_REPLY_LEDGER_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        version: parsed.version || '0.1.0',
        updatedAt: parsed.updatedAt || '',
        orders: parsed.orders && typeof parsed.orders === 'object' ? parsed.orders : {},
      };
    }
  } catch (error) {
    console.error(`⚠️  商家聊天回访台账读取失败，将新建台账: ${error.message}`);
  }
  return { version: '0.1.0', orders: {} };
}

function saveChatReplyLedger(ledger) {
  saveJsonAtomic(CHAT_REPLY_LEDGER_FILE, {
    version: ledger.version || '0.1.0',
    updatedAt: new Date().toISOString(),
    orders: ledger.orders || {},
  });
}

function getChatReplyLedgerRecord(orderId) {
  const normalizedOrderId = String(orderId || '').trim();
  if (!normalizedOrderId) return null;
  const ledger = loadChatReplyLedger();
  return ledger.orders?.[normalizedOrderId] || null;
}

function recordChatReplyOrder(mapping, result, patch = {}) {
  const orderId = String(mapping?.bizOrderId || mapping?.orderId || '').trim();
  if (!orderId) return null;
  const ledger = loadChatReplyLedger();
  const existing = ledger.orders?.[orderId] || {};
  const record = {
    orderId,
    shopName: mapping.shopName || existing.shopName || '',
    amount: mapping.amount || existing.amount || '',
    orderDate: mapping.orderDate || existing.orderDate || '',
    status: result?.status || patch.status || existing.status || '',
    reason: result?.reason || patch.reason || existing.reason || '',
    replyCategory: result?.replyCategory || patch.replyCategory || existing.replyCategory || '',
    invoiceFilePath: result?.downloadResult?.path || result?.downloadResult?.existingPath || patch.invoiceFilePath || existing.invoiceFilePath || '',
    invoiceLink: result?.invoiceLink || patch.invoiceLink || existing.invoiceLink || '',
    finalUrl: result?.finalUrl || patch.finalUrl || existing.finalUrl || '',
    checkedAt: result?.checkedAt || patch.checkedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  ledger.orders = { ...(ledger.orders || {}), [orderId]: record };
  saveChatReplyLedger(ledger);
  return record;
}

function loadModifiedLedger() {
  if (!fs.existsSync(MODIFIED_LEDGER_FILE)) {
    return { version: '0.1.0', orders: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(MODIFIED_LEDGER_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        version: parsed.version || '0.1.0',
        updatedAt: parsed.updatedAt || '',
        generatedFromArtifactsAt: parsed.generatedFromArtifactsAt || '',
        orders: parsed.orders && typeof parsed.orders === 'object' ? parsed.orders : {},
      };
    }
  } catch (error) {
    console.error(`⚠️  修改/换开台账读取失败，将新建台账: ${error.message}`);
  }
  return { version: '0.1.0', orders: {} };
}

function saveModifiedLedger(ledger) {
  saveJsonAtomic(MODIFIED_LEDGER_FILE, {
    version: ledger.version || '0.1.0',
    updatedAt: new Date().toISOString(),
    generatedFromArtifactsAt: ledger.generatedFromArtifactsAt || '',
    orders: ledger.orders || {},
  });
}

function getModifiedLedgerRecord(orderId) {
  const normalizedOrderId = String(orderId || '').trim();
  if (!normalizedOrderId) return null;
  const ledger = loadModifiedLedger();
  return ledger.orders?.[normalizedOrderId] || null;
}

function recordModifiedOrder(mapping, execution, patch = {}) {
  const orderId = String(mapping?.bizOrderId || '').trim();
  if (!orderId) return null;
  const ledger = loadModifiedLedger();
  const existing = ledger.orders?.[orderId] || {};
  const record = {
    orderId,
    shopName: mapping.shopName || existing.shopName || '',
    amount: mapping.amount || existing.amount || '',
    orderDate: mapping.orderDate || existing.orderDate || '',
    action: execution?.action || patch.action || existing.action || '',
    status: execution?.status || patch.status || existing.status || '',
    reason: execution?.reason || patch.reason || existing.reason || '',
    submittedAt: execution?.executedAt || patch.submittedAt || existing.submittedAt || new Date().toISOString(),
    finalUrl: execution?.finalUrl || patch.finalUrl || existing.finalUrl || '',
    updatedAt: new Date().toISOString(),
  };
  ledger.orders = { ...(ledger.orders || {}), [orderId]: record };
  saveModifiedLedger(ledger);
  return record;
}

function getContactedLedgerRecord(orderId) {
  const normalizedOrderId = String(orderId || '').trim();
  if (!normalizedOrderId) return null;
  const ledger = loadContactedLedger();
  return ledger.orders?.[normalizedOrderId] || null;
}

function recordContactedOrder(mapping, message, patch = {}) {
  const orderId = String(mapping?.bizOrderId || '').trim();
  if (!orderId) return null;
  const ledger = loadContactedLedger();
  const existing = ledger.orders?.[orderId] || {};
  const record = {
    orderId,
    shopName: mapping.shopName || existing.shopName || '',
    amount: mapping.amount || existing.amount || '',
    orderDate: mapping.orderDate || existing.orderDate || '',
    invoiceUrl: mapping.invoiceUrl || mapping.detailUrl || mapping.url || existing.invoiceUrl || '',
    rejectType: mapping.rejectInfo?.rejectType || existing.rejectType || '',
    rejectReason: mapping.rejectInfo?.rejectReason || mapping.contactReason || existing.rejectReason || '',
    message: message || existing.message || '',
    contactedAt: patch.contactedAt || existing.contactedAt || new Date().toISOString(),
    finalUrl: patch.finalUrl || existing.finalUrl || '',
    source: patch.source || existing.source || '',
    updatedAt: new Date().toISOString(),
  };
  ledger.orders = { ...(ledger.orders || {}), [orderId]: record };
  saveContactedLedger(ledger);
  return record;
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function saveResultsCsv(file, results) {
  const headers = [
    'order_id',
    'platform',
    'order_date',
    'shop_name',
    'amount',
    'invoice_type',
    'invoice_title',
    'action',
    'state',
    'status',
    'page_classification',
    'matched_rules',
    'failure_reason',
    'invoice_file_path',
    'chat_reply_category',
    'chat_invoice_link',
    'screenshot_path',
    'html_snapshot_path',
    'processed_at',
  ];
  const rows = [headers.join(',')];
  for (const result of results) {
    rows.push([
      result.bizOrderId || '',
      result.platform || '',
      result.orderDate || '',
      result.orderMeta?.shopName || result.shopName || '',
      result.orderMeta?.amount || result.amount || '',
      result.invoiceInfo?.invoiceType || '',
      result.invoiceInfo?.invoiceTitle || '',
      result.execution?.action || result.actionPlan?.action || '',
      result.state || result.execution?.state || '',
      result.execution?.status || result.status || '',
      result.pageClassification?.category || '',
      (result.pageClassification?.matchedRules || []).map(rule => rule.id).join('|'),
      result.execution?.reason || result.error || '',
      result.execution?.downloadResult?.path || result.execution?.downloadResult?.existingPath || result.execution?.chatReplyResult?.downloadResult?.path || result.execution?.chatReplyResult?.downloadResult?.existingPath || '',
      result.execution?.chatReplyResult?.replyCategory || result.chatReply?.replyCategory || '',
      result.execution?.chatReplyResult?.invoiceLink || result.chatReply?.invoiceLink || '',
      result.artifacts?.screenshotPath || result.execution?.snapshot?.screenshotPath || '',
      result.artifacts?.htmlSnapshotPath || result.execution?.snapshot?.htmlSnapshotPath || '',
      result.execution?.executedAt || result.checkedAt || '',
    ].map(csvEscape).join(','));
  }
  fs.writeFileSync(file, `${rows.join('\n')}\n`, 'utf8');
}

function ensureDirectory(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function sanitizeFilenamePart(value) {
  return String(value || '')
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function buildInvoiceReceiveType(invoiceConfig) {
  return invoiceConfig.address ? '普票/专票' : '普票';
}

function buildInvoiceFilename(mapping, inspection, suggestedFilename) {
  const ext = path.extname(suggestedFilename) || '.pdf';
  const invoiceType = inspection?.invoiceInfo?.invoiceType || mapping.invoiceInfo?.invoiceType || 'unknown';
  const base = [
    mapping.bizOrderId,
    mapping.shopName || inspection?.orderMeta?.shopName || 'unknown_shop',
    mapping.amount || inspection?.orderMeta?.amount || 'unknown_amount',
    invoiceType,
    mapping.orderDate || 'unknown_date',
  ].map(sanitizeFilenamePart).filter(Boolean).join('_');
  return `${base}${ext}`;
}

function buildChatInvoiceFilename(mapping, suggestedFilename) {
  const ext = path.extname(suggestedFilename || '') || '.pdf';
  const base = [
    mapping.bizOrderId || mapping.orderId || 'unknown_order',
    mapping.shopName || 'unknown_shop',
    mapping.amount || 'unknown_amount',
    'chat_reply_invoice',
    mapping.orderDate || formatDate(new Date()),
  ].map(sanitizeFilenamePart).filter(Boolean).join('_');
  return `${base}${ext}`;
}

function ensureUniqueFilePath(targetPath) {
  if (!fs.existsSync(targetPath)) return targetPath;
  const ext = path.extname(targetPath);
  const base = targetPath.slice(0, targetPath.length - ext.length);
  let index = 2;
  while (true) {
    const candidate = `${base}_${index}${ext}`;
    if (!fs.existsSync(candidate)) return candidate;
    index += 1;
  }
}

function normalizeUrl(href, baseUrl) {
  if (!href) return '';
  try {
    return new URL(href.startsWith('//') ? `https:${href}` : href, baseUrl).href;
  } catch {
    return href;
  }
}

function classifyPageErrorText(text) {
  const parsed = classifyRichPageErrorText(text);
  const legacyType = {
    deadline_exceeded: 'expired',
    wrong_title: 'wrongTitle',
    wrong_tax_no: 'wrongTaxNo',
    missing_email: 'missingEmail',
    missing_supplement_info: 'missingInfo',
    amount_mismatch: 'amountMismatch',
    seller_rejected: 'rejected',
    security_verification: 'verification',
  };
  const hits = parsed.hits.map(hit => ({
    ...hit,
    type: legacyType[hit.type] || hit.type,
  }));
  return {
    ...parsed,
    hits,
    hasRetryableError: hits.some(hit => ['wrongTitle', 'wrongTaxNo', 'missingEmail', 'missingInfo', 'amountMismatch'].includes(hit.type)),
    hasExpiredError: hits.some(hit => hit.type === 'expired'),
    hasVerificationError: parsed.hasVerificationError || VERIFICATION_TEXT_MARKERS.some(marker => String(text || '').includes(marker)),
    primaryReason: hits[0]?.matched || parsed.primaryReason || '',
  };
}

function textIncludesAny(text, words) {
  return words.some(word => String(text || '').includes(word));
}

function extractLatestRejectInfo(historyText) {
  const lines = String(historyText || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  const entries = [];

  for (let i = 0; i < lines.length; i++) {
    if (!/卖家拒绝了发票申请|商家拒绝了发票申请|拒绝了发票申请/.test(lines[i])) continue;
    const windowLines = lines.slice(i, i + 10);
    const typeLine = windowLines.find(line => line.startsWith('拒绝类型'));
    const reasonLine = windowLines.find(line => line.startsWith('拒绝原因'));
    entries.push({
      rejectType: typeLine ? typeLine.replace(/^拒绝类型[：:\s]*/, '').trim() : '',
      rejectReason: reasonLine ? reasonLine.replace(/^拒绝原因[：:\s]*/, '').trim() : '',
      rawText: windowLines.join('\n'),
    });
  }

  if (entries.length === 0) {
    const typeLine = lines.find(line => line.startsWith('拒绝类型'));
    const reasonLine = lines.find(line => line.startsWith('拒绝原因'));
    if (typeLine || reasonLine) {
      entries.push({
        rejectType: typeLine ? typeLine.replace(/^拒绝类型[：:\s]*/, '').trim() : '',
        rejectReason: reasonLine ? reasonLine.replace(/^拒绝原因[：:\s]*/, '').trim() : '',
        rawText: lines.join('\n'),
      });
    }
  }

  return {
    entries,
    latest: entries[0] || { rejectType: '', rejectReason: '', rawText: '' },
  };
}

function classifyRejectedInvoiceHandling(inspection, history) {
  const detailText = inspection?.detailBodyText || '';
  const historyText = history?.historyText || '';
  const combinedText = `${detailText}\n${historyText}`;
  const hasRejectedState = textIncludesAny(combinedText, [
    '商家拒绝',
    '卖家拒绝了发票申请',
    '拒绝了发票申请',
    '审核不通过',
    '审核未通过',
    '申请失败',
    '拒绝开票',
  ]);

  if (!hasRejectedState) {
    return { action: 'continue', reason: '', rejectInfo: extractLatestRejectInfo(historyText) };
  }

  const rejectInfo = extractLatestRejectInfo(historyText);
  const rejectType = rejectInfo.latest.rejectType || '';
  const rejectReason = rejectInfo.latest.rejectReason || '';
  const reasonText = `${rejectType}\n${rejectReason}`;
  const parseResult = classifyPageErrorText(`${reasonText}\n${combinedText}`);
  const hasModifyEntry = inspection?.candidates?.some(candidate => (
    candidate.type === 'modify_invoice' && candidate.visible && !candidate.disabled
  ));

  if (!rejectReason && history?.opened) {
    return {
      action: 'manual_required',
      reason: '已读取申请历史，但未解析到明确拒绝原因，请人工确认',
      rejectInfo,
      parseResult,
    };
  }
  if (!history?.opened) {
    return {
      action: 'manual_required',
      reason: '当前为商家拒绝，但未能打开申请历史读取拒绝原因',
      rejectInfo,
      parseResult,
    };
  }

  if (/已开.*发票|已经开.*发票|已为.*开具|已开具.*发票/.test(reasonText)) {
    return {
      action: 'manual_required',
      reason: `商家称已开票，需确认是否下载或换开：${rejectReason}`,
      rejectInfo,
      parseResult,
    };
  }

  const asksSellerContact = /联系客服|联系在线客服|联系我们在线客服|在线客服|咨询客服|联系商家|联系卖家|旺旺/.test(reasonText);
  const asksInvoiceByContact = /(开具|开票|进行开票|发邮箱|提供邮箱|电子发票|普票)/.test(reasonText);
  const smallScaleCannotVat = /小规模.*开.*不了|小规模.*不能开|开不了.*增值税|无法开具.*增值税/.test(reasonText);
  if ((asksSellerContact && asksInvoiceByContact) || (smallScaleCannotVat && asksSellerContact)) {
    return {
      action: 'contact_seller',
      reason: `拒绝原因要求联系商家处理：${rejectReason}`,
      rejectInfo,
      parseResult,
    };
  }

  const clearlyFixableInForm = parseResult.hasRetryableError
    || /抬头|税号|纳税人识别号|统一社会信用代码|信息输入有误|信息有误|信息不完整|请核实发票信息|邮箱/.test(reasonText);
  if (clearlyFixableInForm) {
    if (!hasModifyEntry) {
      return {
        action: 'contact_seller',
        reason: `拒绝原因看起来可修正，但页面没有可用修改申请入口，改为联系商家：${rejectReason || rejectType}`,
        rejectInfo,
        parseResult,
      };
    }
    return {
      action: 'modify_invoice',
      reason: `拒绝原因可通过修改申请修正：${rejectReason || rejectType}`,
      rejectInfo,
      parseResult,
    };
  }

  return {
    action: 'manual_required',
    reason: `商家拒绝原因未纳入自动规则，请确认处理方式：${rejectReason || rejectType || '未提供原因'}`,
    rejectInfo,
    parseResult,
  };
}

function buildSellerMessage(mapping, invoiceConfig) {
  const replacements = {
    orderId: mapping.bizOrderId || '',
    companyName: invoiceConfig.companyName || '',
    taxNo: invoiceConfig.taxNo || '',
    invoiceType: '普票',
    email: invoiceConfig.email || '无',
  };

  return (invoiceConfig.sellerMessageTemplate || DEFAULT_SELLER_MESSAGE_TEMPLATE)
    .replace(/\{(\w+)\}/g, (_, key) => replacements[key] || '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function normalizeIdentifier(text) {
  return String(text || '').replace(/\s+/g, '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

function looksLikeTaxNo(value, configuredTaxNo = '') {
  const normalized = normalizeIdentifier(value);
  const expected = normalizeIdentifier(configuredTaxNo);
  if (!normalized) return false;
  if (expected && normalized === expected) return true;
  return /^[0-9A-Z]{15,20}$/.test(normalized) && /\d{10,}/.test(normalized);
}

function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function bodyShowsTaxNoAsInvoiceTitle(text, invoiceConfig = {}) {
  const taxNo = normalizeIdentifier(invoiceConfig.taxNo);
  if (!taxNo) return false;
  const compact = normalizeIdentifier(text);
  if (!compact.includes(taxNo)) return false;

  const readable = String(text || '').replace(/\s+/g, '');
  const taxPattern = String(invoiceConfig.taxNo || '')
    .split('')
    .map(escapeRegExp)
    .join('\\s*');
  return new RegExp(`(?:发票|抬头|企业)[^\\n\\r]{0,20}${taxPattern}`).test(readable)
    || readable.includes(`企业-${invoiceConfig.taxNo}`)
    || readable.includes(`发票${invoiceConfig.taxNo}`);
}

function looksLikePlatformCustomerService(url) {
  const normalized = String(url || '').toLowerCase();
  return normalized.includes('consumerservice.taobao.com')
    || normalized.includes('helpcenter.taobao.com')
    || normalized.includes('/online-help');
}

function isDateInRange(dateText) {
  if (!dateText) return false;
  const ranges=cliArgs.dateRanges||[{start:cliArgs.startDate,end:cliArgs.endDate}];
  return ranges.some(range=>dateText>=range.start&&dateText<=range.end);
}

function getMonthKey(dateText) {
  return typeof dateText === 'string' && dateText.length >= 7 ? dateText.slice(0, 7) : '';
}

function buildInvoiceDetailUrl(orderId) {
  return `https://invoice-ua.taobao.com/detail/pc#/?orderId=${orderId}`;
}

function buildFallbackMappingFromOrderId(orderId) {
  const bizOrderId = String(orderId || '').trim();
  return {
    bizOrderId,
    platform: 'taobao',
    orderDate: '',
    amount: '',
    shopName: '',
    url: buildInvoiceDetailUrl(bizOrderId),
    detailUrl: '',
    invoiceUrl: buildInvoiceDetailUrl(bizOrderId),
    sourceTag: 'direct_invoice_detail',
  };
}

function buildExpiredDeadlineSkipResult(mapping, skippedFromDate) {
  return {
    status: 'ok',
    ...mapping,
    invoiceInfo: { invoiceType: 'no_invoice', invoiceTitle: '未开票', confidence: 'low' },
    actionPlan: {
      action: 'apply_invoice',
      confidence: 'medium',
      reason: '同月较新的订单已明确超过开票日期，更早订单直接跳过',
    },
    candidates: [],
    checkedAt: new Date().toISOString(),
    execution: {
      status: 'expired_deadline',
      reason: `同月 ${skippedFromDate} 已明确超过开票日期，跳过更早订单`,
      inferred: true,
      executedAt: new Date().toISOString(),
    },
  };
}

function mergeMappingCandidate(targetMap, candidate) {
  if (!candidate || !candidate.bizOrderId) return;
  const existing = targetMap.get(candidate.bizOrderId) || {};
  const isOrderDetail = url => /trade\.(?:taobao|tmall)\.com\//i.test(url || '');
  const preferredOrderUrl = [candidate.detailUrl, candidate.url, existing.detailUrl, existing.url].find(isOrderDetail);
  const merged = {
    ...existing,
    ...candidate,
    bizOrderId: candidate.bizOrderId || existing.bizOrderId || '',
    platform: preferredOrderUrl && /trade\.tmall\.com/i.test(preferredOrderUrl) ? 'tmall' : candidate.platform || existing.platform || '',
    orderDate: candidate.orderDate || existing.orderDate || '',
    amount: candidate.amount || existing.amount || '',
    shopName: candidate.shopName || existing.shopName || '',
    url: preferredOrderUrl || candidate.url || existing.url || candidate.detailUrl || existing.detailUrl || candidate.invoiceUrl || existing.invoiceUrl || '',
    detailUrl: preferredOrderUrl || candidate.detailUrl || existing.detailUrl || candidate.url || existing.url || '',
    invoiceUrl: candidate.invoiceUrl || existing.invoiceUrl || '',
  };
  targetMap.set(merged.bizOrderId, merged);
}

function getArtifactFiles() {
  return fs.readdirSync(__dirname)
    .filter(name => /^(invoice-action|repair-).*\.json$/i.test(name))
    .filter(name => !name.includes('progress')
      && !name.includes('config')
      && name !== path.basename(OUTPUT_FILE)
      && name !== path.basename(PROGRESS_FILE)
      && name !== path.basename(CONTACTED_LEDGER_FILE)
      && name !== path.basename(DOWNLOADED_LEDGER_FILE)
      && name !== path.basename(MODIFIED_LEDGER_FILE)
      && name !== path.basename(CHAT_REPLY_LEDGER_FILE));
}

function collectMappingsFromArtifacts() {
  const candidates = new Map();

  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }

    const bizOrderId = typeof node.bizOrderId === 'string'
      ? node.bizOrderId
      : typeof node.orderId === 'string' && /^\d{8,}$/.test(node.orderId)
        ? node.orderId
        : '';
    if (bizOrderId) {
      mergeMappingCandidate(candidates, {
        bizOrderId,
        platform: typeof node.platform === 'string' ? node.platform : '',
        orderDate: typeof node.orderDate === 'string' ? node.orderDate : '',
        amount: typeof node.amount === 'string'
          ? node.amount
          : typeof node.orderMeta?.amount === 'string'
            ? node.orderMeta.amount
            : '',
        shopName: typeof node.shopName === 'string'
          ? node.shopName
          : typeof node.orderMeta?.shopName === 'string'
            ? node.orderMeta.shopName
            : '',
        url: typeof node.url === 'string'
          ? node.url
          : typeof node.detailUrl === 'string'
            ? node.detailUrl
            : typeof node.invoiceUrl === 'string'
              ? node.invoiceUrl
              : '',
        detailUrl: typeof node.detailUrl === 'string' ? node.detailUrl : '',
        invoiceUrl: typeof node.invoiceUrl === 'string' ? node.invoiceUrl : '',
      });
    }

    for (const value of Object.values(node)) {
      visit(value);
    }
  }

  for (const fileName of getArtifactFiles()) {
    const filePath = path.join(__dirname, fileName);
    if (!fs.existsSync(filePath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      visit(parsed);
    } catch (error) {
      console.error(`⚠️  读取历史映射失败 ${fileName}: ${error.message}`);
    }
  }

  return candidates;
}

function getExecutionStatusPriority(status) {
  const priorities = {
    seller_contacted: 500,
    downloaded: 450,
    submitted: 400,
    pending: 350,
    skipped: 300,
  };
  return priorities[status] || 0;
}

function compareArtifactResults(left, right) {
  const leftStatus = left?.execution?.status || '';
  const rightStatus = right?.execution?.status || '';
  const priorityDiff = getExecutionStatusPriority(leftStatus) - getExecutionStatusPriority(rightStatus);
  if (priorityDiff !== 0) return priorityDiff;

  const leftTime = new Date(
    left?.execution?.executedAt || left?.checkedAt || left?.generatedAt || 0
  ).getTime() || 0;
  const rightTime = new Date(
    right?.execution?.executedAt || right?.checkedAt || right?.generatedAt || 0
  ).getTime() || 0;
  if (leftTime !== rightTime) return leftTime - rightTime;

  const leftReason = String(left?.execution?.reason || left?.reason || '');
  const rightReason = String(right?.execution?.reason || right?.reason || '');
  return leftReason.length - rightReason.length;
}

function artifactLooksLikeWrongTitle(node) {
  let invoiceConfig = {};
  try {
    invoiceConfig = loadInvoiceConfig();
  } catch {
    invoiceConfig = {};
  }
  const texts = [
    node?.detailBodyText,
    node?.bodyText,
    node?.historyText,
    node?.invoiceInfo?.invoiceTitle,
    node?.execution?.existingApplication?.reason,
    node?.execution?.reason,
  ].filter(value => typeof value === 'string').join('\n');
  return node?.invoiceInfo?.invoiceType === 'wrong_company_title'
    || node?.execution?.existingApplication?.titleLooksLikeTaxNo === true
    || bodyShowsTaxNoAsInvoiceTitle(texts, invoiceConfig);
}

function collectTerminalResultsFromArtifacts() {
  const results = new Map();

  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }

    const bizOrderId = typeof node.bizOrderId === 'string' ? node.bizOrderId : '';
    const executionStatus = node?.execution?.status;
    if (bizOrderId && TERMINAL_EXECUTION_STATUS.has(executionStatus) && !artifactLooksLikeWrongTitle(node)) {
      const current = results.get(bizOrderId);
      if (!current || compareArtifactResults(node, current) > 0) {
        results.set(bizOrderId, node);
      }
    }

    for (const value of Object.values(node)) {
      visit(value);
    }
  }

  for (const fileName of getArtifactFiles()) {
    const filePath = path.join(__dirname, fileName);
    if (!fs.existsSync(filePath)) continue;
    try {
      visit(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    } catch (error) {
      console.error(`⚠️  读取历史终态失败 ${fileName}: ${error.message}`);
    }
  }

  return results;
}

function seedContactedLedgerFromArtifacts() {
  const ledger = loadContactedLedger();
  let changed = false;

  for (const [orderId, artifact] of collectTerminalResultsFromArtifacts()) {
    if (artifact?.execution?.status !== 'seller_contacted') continue;
    if (ledger.orders?.[orderId]) continue;

    const contactResult = artifact.execution.contactResult || {};
    const message = contactResult.message || artifact.execution.message || '';
    ledger.orders = ledger.orders || {};
    ledger.orders[orderId] = {
      orderId,
      shopName: artifact.shopName || artifact.orderMeta?.shopName || '',
      amount: artifact.amount || artifact.orderMeta?.amount || '',
      orderDate: artifact.orderDate || '',
      invoiceUrl: artifact.invoiceUrl || artifact.detailUrl || artifact.url || '',
      rejectType: artifact.rejectedDecision?.rejectInfo?.latest?.rejectType || '',
      rejectReason: artifact.rejectedDecision?.rejectInfo?.latest?.rejectReason || '',
      message,
      contactedAt: contactResult.executedAt || artifact.execution.executedAt || artifact.checkedAt || new Date().toISOString(),
      finalUrl: contactResult.finalUrl || artifact.execution.finalUrl || '',
      source: 'artifact_seed',
      updatedAt: new Date().toISOString(),
    };
    changed = true;
  }

  if (changed) {
    ledger.generatedFromArtifactsAt = ledger.generatedFromArtifactsAt || new Date().toISOString();
    saveContactedLedger(ledger);
    console.log(`🧾 已从历史结果补全联系商家台账: ${CONTACTED_LEDGER_FILE}`);
  }
}

function seedModifiedLedgerFromArtifacts() {
  const ledger = loadModifiedLedger();
  let changed = false;
  const files = fs.readdirSync(__dirname)
    .filter(fileName => /^(invoice-action|repair-).*\.(json)$/i.test(fileName))
    .filter(fileName => !fileName.includes('progress') && fileName !== path.basename(MODIFIED_LEDGER_FILE));

  function visit(node, sourceFile) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(item => visit(item, sourceFile));
      return;
    }

    const orderId = typeof node.bizOrderId === 'string' ? node.bizOrderId : '';
    const execution = node.execution || {};
    const action = execution.action || '';
    const status = execution.status || '';
    const state = node.state || execution.state || '';
    if (orderId
      && ['modify_invoice', 'reissue_invoice'].includes(action)
      && ['submitted', 'pending'].includes(status)
      && !ledger.orders?.[orderId]) {
      ledger.orders = ledger.orders || {};
      ledger.orders[orderId] = {
        orderId,
        shopName: node.shopName || node.orderMeta?.shopName || '',
        amount: node.amount || node.orderMeta?.amount || '',
        orderDate: node.orderDate || '',
        action,
        status,
        state,
        reason: execution.reason || '',
        submittedAt: execution.executedAt || node.checkedAt || new Date().toISOString(),
        finalUrl: execution.finalUrl || node.detailUrl || '',
        source: sourceFile,
        updatedAt: new Date().toISOString(),
      };
      changed = true;
    }

    for (const value of Object.values(node)) {
      visit(value, sourceFile);
    }
  }

  for (const fileName of files) {
    try {
      visit(JSON.parse(fs.readFileSync(path.join(__dirname, fileName), 'utf8')), fileName);
    } catch {
      // Ignore partial or obsolete local run artifacts.
    }
  }

  if (changed) {
    ledger.generatedFromArtifactsAt = ledger.generatedFromArtifactsAt || new Date().toISOString();
    saveModifiedLedger(ledger);
    console.log(`🧾 已从历史结果补全修改/换开台账: ${MODIFIED_LEDGER_FILE}`);
  }
}

async function ensureLoggedIn(page) {
  console.log('📄 验证登录...');
  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageTimeout });
  await page.waitForLoadState('networkidle', { timeout: CONFIG.detailWaitTimeout }).catch(() => null);
  await sleep(1000);

  const wasLoginPage=isLoginOrVerifyUrl(page.url());
  const verification=await handleVerificationIfNeeded(page,'淘宝登录或安全验证');
  if(verification.blocked)throw new Error(`WORKFLOW_AUTH_REQUIRED: ${verification.reason||'登录或验证未完成'}`);
  if(wasLoginPage||verification.parseResult?.hasVerificationError){
    await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageTimeout });
    await page.waitForLoadState('networkidle', { timeout: CONFIG.detailWaitTimeout }).catch(() => null);
    if(isLoginOrVerifyUrl(page.url()))throw new Error('WORKFLOW_AUTH_REQUIRED: 登录后仍无法访问订单列表');
    await sleep(1000);
  }
  console.log('⏳ 等待淘宝订单列表加载；如出现登录或验证，请在浏览器中完成。');
  const ready=await waitForOrderListReady(page,CONFIG.manualTimeoutMs);
  if(!ready)throw new Error('等待登录或订单列表加载超时，请重新扫描');
  console.log('✅ 已登录，订单列表已加载');
}

async function waitForOrderListReady(page,timeout) {
  return page.waitForFunction(() => {
    const path=location.pathname;
    if(!/\/trade\/itemlist\/list_bought_items\.htm/.test(path))return false;
    const body=document.body?.innerText||'';
    if(/请先登录|扫码登录|安全验证|滑动验证/.test(body))return false;
    return Boolean(document.querySelector('[id^="shopOrderContainer_"], .ant-pagination') || /暂无订单|没有找到相关订单/.test(body));
  },null,{timeout}).then(()=>true).catch(()=>false);
}

async function waitForRelevantPageContent(page, timeout = CONFIG.actionReadyTimeout) {
  await page.waitForFunction(({ actionWords, verificationWords }) => {
    const bodyText = document.body?.innerText || '';
    return actionWords.some(word => bodyText.includes(word)) || verificationWords.some(word => bodyText.includes(word));
  }, {
    actionWords: ACTION_KEYWORDS.flatMap(group => group.words),
    verificationWords: VERIFICATION_TEXT_MARKERS,
  }, { timeout }).catch(() => null);
}

async function pauseForManualVerification(page, reason) {
  console.log(`⚠️  触发人工验证: ${reason}`);
  console.log('请在弹出的淘宝浏览器中完成登录或安全验证，完成后脚本会继续。');
  rateLimiter.recordVerification();
  const resolved = await page.waitForFunction(({loginMarkers,verificationMarkers}) => {
    const url=location.href.toLowerCase();
    const text=document.body?.innerText||'';
    return !loginMarkers.some(marker=>url.includes(marker)) && !verificationMarkers.some(marker=>text.includes(marker));
  }, {loginMarkers:LOGIN_URL_MARKERS,verificationMarkers:VERIFICATION_TEXT_MARKERS}, {timeout:CONFIG.manualTimeoutMs}).then(()=>true).catch(()=>false);
  if (!resolved) return { resolved:false, reason:'等待登录或安全验证超时' };
  const currentText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
  const parseResult = classifyPageErrorText(currentText);
  if (parseResult.hasVerificationError || isLoginOrVerifyUrl(page.url())) {
    return { resolved: false, reason: '人工验证未完成' };
  }
  return { resolved: true, reason: '人工验证已完成' };
}

async function clickNextOrderPage(page) {
  const selectors = [
    'li.ant-pagination-next',
    '[title="Next Page"]',
    '[aria-label="Next Page"]',
    '[aria-label="下一页"]',
    'text=下一页',
  ];
  for (const selector of selectors) {
    const matches=page.locator(selector);
    const count=Math.min(await matches.count().catch(()=>0),10);
    for(let i=0;i<count;i++){
      const target=matches.nth(i);
      if (!(await target.isVisible().catch(()=>false))) continue;
      const disabled=await target.isDisabled().catch(()=>false);
      const aria=await target.getAttribute('aria-disabled').catch(()=>null);
      const classes=await target.getAttribute('class').catch(()=>null);
      if(disabled||aria==='true'||/(?:^|\s)ant-pagination-disabled(?:\s|$)/.test(classes||''))return 'last_page';
      // Ant Design puts the actual click target inside the pagination <li>.
      const button=target.locator('button.ant-pagination-item-link').first();
      if(await button.isVisible().catch(()=>false))await button.click({timeout:8000});
      else await target.click({timeout:8000});
      return 'clicked';
    }
  }
  return 'not_found';
}

function shouldStopScanningPage(mappings, startDate) {
  return mappings.length>0 && mappings.every(mapping => /^\d{4}-\d{2}-\d{2}$/.test(mapping.orderDate||'') && mapping.orderDate<startDate);
}

function shouldSkipSavedPdf(mapping, savedIds, execute, action='') {
  return (!execute || action==='refresh') && savedIds.has(String(mapping?.bizOrderId||''));
}
function removeExcludedMappings(mappings,ids){const excluded=new Set(ids.map(String));return mappings.filter(mapping=>!excluded.has(String(mapping.bizOrderId)))}

function sortByEventOrder(mappings, ids) {
  const positions=new Map(ids.map((id,index)=>[String(id),index]));
  return mappings.map((mapping,index)=>({mapping,index})).sort((a,b)=>{
    const left=positions.get(String(a.mapping.bizOrderId))??Infinity;
    const right=positions.get(String(b.mapping.bizOrderId))??Infinity;
    return left===right?a.index-b.index:left-right;
  }).map(item=>item.mapping);
}

async function describeOrderPagination(page) {
  return page.evaluate(() => {
    const current=document.querySelector('.ant-pagination-item-active');
    const next=document.querySelector('.ant-pagination-next');
    const activePage=(current?.textContent||current?.getAttribute('title')||'').trim();
    const cards=document.querySelectorAll('[id^="shopOrderContainer_"]').length;
    return {activePage:activePage||'未知',cards,nextDisabled:next?.getAttribute('aria-disabled')||'未知',path:location.pathname};
  }).catch(()=>null);
}

async function waitForOrderPageChange(page, previousIds, timeout) {
  return page.waitForFunction((idsBefore) => {
    const ids = [...new Set([...document.querySelectorAll('a[href*="bizOrderId"], a[href*="biz_order_id"]')]
      .map(link => (link.getAttribute('href') || '').match(/(?:bizOrderId|biz_order_id)=(\d+)/)?.[1]).filter(Boolean))];
    return ids.length > 0 && ids.sort().join(',') !== idsBefore;
  }, previousIds, {timeout}).then(()=>true).catch(()=>false);
}

async function extractBizOrderIds(page) {
  console.log('\n📋 从订单列表提取订单详情链接...');
  const allMappings = [];
  const excludedIds = new Set(cliArgs.excludedOrderIds.map(String));

  for (let currentPage = 1; currentPage <= cliArgs.maxPages; currentPage++) {
    console.log(`  第 ${currentPage}/${cliArgs.maxPages} 页...`);
    await page.waitForSelector('body', { timeout: CONFIG.listWaitTimeout });
    await sleep(1500);
    try { await page.click('text=知道了', { timeout: 1500 }); } catch {}

    const mappings = await page.evaluate(() => {
      const results = [];
      const seen = new Set();
      const links = document.querySelectorAll('a[href*="bizOrderId"], a[href*="biz_order_id"]');
      links.forEach(link => {
        const text = (link.textContent || '').trim();
        const href = link.getAttribute('href') || '';
        if (text && !text.includes('订单详情') && !href.includes('/detail/')) return;

        const tmallMatch = href.match(/bizOrderId=(\d+)/);
        const taobaoMatch = href.match(/biz_order_id=(\d+)/);
        const bizOrderId = tmallMatch?.[1] || taobaoMatch?.[1] || '';
        if (!bizOrderId || seen.has(bizOrderId)) return;
        seen.add(bizOrderId);

        const container = link.closest('[id^="shopOrderContainer_"]') || link.closest('.trade-container') || link.parentElement;
        const containerText = container?.innerText || '';
        const orderDate = containerText.match(/\d{4}-\d{2}-\d{2}/)?.[0] || '';
        const amountMatch = containerText.match(/实付款[\s\S]{0,20}?¥\s*([0-9.,]+)/) || containerText.match(/￥\s*([0-9.,]+)/);
        const amount = amountMatch?.[1] ? amountMatch[1].replace(/,/g, '') : '';
        const shopName = (
          container?.querySelector('a[class*="shopInfoName--"], a[class*="shopInfoName"]')?.innerText
          || containerText.match(/([\u4e00-\u9fa5A-Za-z0-9_-]{2,40}(旗舰店|专卖店|企业店|店铺))/)?.[1]
          || ''
        ).trim();

        results.push({
          bizOrderId,
          platform: tmallMatch ? 'tmall' : 'taobao',
          orderDate,
          amount,
          shopName,
          listTransactionStatus:(container?.querySelector('[class*="shopInfoStatus--"]')?.textContent||'').trim(),
          url: new URL(href.startsWith('//') ? `https:${href}` : href, location.href).href,
        });
      });
      return results;
    });

    const dateRangeMappings = mappings.filter(mapping => !mapping.orderDate || isDateInRange(mapping.orderDate));
    const inRangeMappings = dateRangeMappings.filter(mapping => !excludedIds.has(String(mapping.bizOrderId)));
    const excludedOnPage = dateRangeMappings.length - inRangeMappings.length;
    console.log(`    找到 ${mappings.length} 个详情链接，其中日期范围内且未手动排除 ${inRangeMappings.length} 个${excludedOnPage?`；已排除 ${excludedOnPage} 个此前从此 Event 手动删除的订单`:''}`);
    allMappings.push(...inRangeMappings);

    // Only stop on the older side of the range when the entire page has
    // recognized dates and none can belong to the requested range. A newer
    // page without matches must not stop us before reaching the range.
    if (inRangeMappings.length === 0 && shouldStopScanningPage(mappings,cliArgs.startDate)) {
      console.log(`    本页全部订单日期已确认且均早于最早选择日期 ${cliArgs.startDate}，本页没有符合范围的订单，停止翻页`);
      break;
    }

    if (currentPage >= cliArgs.maxPages) {
      throw new Error(`扫描达到 ${cliArgs.maxPages} 页上限，覆盖范围不完整，已停止自动处理`);
    }

    try {
      const beforePage=await describeOrderPagination(page);
      const beforeIds = await page.evaluate(() => [...new Set([...document.querySelectorAll('a[href*="bizOrderId"], a[href*="biz_order_id"]')].map(link => (link.getAttribute('href') || '').match(/(?:bizOrderId|biz_order_id)=(\d+)/)?.[1]).filter(Boolean))].sort().join(','));
      const next=await clickNextOrderPage(page);
      if(next==='last_page'){console.log('    已到最后一页');break;}
      if(next==='not_found')throw new Error('未找到翻页按钮，扫描覆盖范围未知');
      console.log(`    已点击下一页，等待第 ${currentPage+1} 页订单加载...`);
      let advanced = await waitForOrderPageChange(page,beforeIds,10000);
      if (!advanced) {
        const afterPage=await describeOrderPagination(page);
        if(beforePage&&afterPage)console.log(`    翻页诊断：页码 ${beforePage.activePage} → ${afterPage.activePage}；订单卡片 ${beforePage.cards} → ${afterPage.cards}；下一页禁用=${afterPage.nextDisabled}；页面路径=${afterPage.path}`);
        if(isLoginOrVerifyUrl(page.url())){
          console.log('⚠️ 翻页时淘宝要求重新登录，请完成登录和验证；订单列表加载后将从第一页重新检查，避免漏单。');
          if(!await waitForOrderListReady(page,CONFIG.manualTimeoutMs))throw new Error('等待重新登录或订单列表加载超时');
          await page.goto(LIST_URL,{waitUntil:'domcontentloaded',timeout:CONFIG.pageTimeout});
          if(!await waitForOrderListReady(page,CONFIG.manualTimeoutMs))throw new Error('重新打开订单列表超时');
          const resumed=await describeOrderPagination(page);
          if(resumed?.activePage&&resumed.activePage!=='1'&&resumed.activePage!=='未知')throw new Error('重新登录后未回到第一页，无法确认扫描覆盖范围');
          return await extractBizOrderIds(page);
        }
        console.log(`⚠️  自动翻页尚未成功。请在弹出的淘宝订单列表中完成可能出现的验证，并手动点击第 ${currentPage+1} 页或下一页；脚本会等待页面订单变化后继续（最多等待 2 分钟）。`);
        advanced=await waitForOrderPageChange(page,beforeIds,120000);
        if(!advanced)throw new Error('等待手动翻页超时，订单未变化，扫描覆盖范围未知');
        console.log(`    已检测到订单列表变化，继续扫描第 ${currentPage+1} 页。`);
      }
      const afterAdvance=await describeOrderPagination(page);
      const beforeNumber=Number(beforePage?.activePage),afterNumber=Number(afterAdvance?.activePage);
      if(Number.isInteger(beforeNumber)&&beforeNumber>0&&Number.isInteger(afterNumber)&&afterNumber>0&&afterNumber!==beforeNumber+1){
        throw new Error(`翻页后页码为 ${afterNumber}，预期为 ${beforeNumber+1}，无法确认是否漏页`);
      }
      await sleep(1000);
    } catch (error) {
      throw new Error(`翻页失败，${error.message}；已停止自动处理`);
    }
  }

  const seen = new Set();
  const unique = allMappings.filter(mapping => {
    if (seen.has(mapping.bizOrderId)) return false;
    seen.add(mapping.bizOrderId);
    return true;
  });

  console.log(`  总计: ${unique.length} 个唯一订单`);
  return unique;
}

function classifyInvoiceText(bodyText) {
  const companyTitleKeywords = [
    '公司',
    '有限',
    '企业',
    '集团',
    '中心',
    '工作室',
    '事务所',
    '研究院',
    '学校',
    '大学',
    '医院',
    '委员会',
    '协会',
    '银行',
    '厂',
  ];

  function matchField(labels, maxLen) {
    for (const label of labels) {
      const pattern = new RegExp(`${label}[：:\\s]*([^\\n\\r]{1,${maxLen}})`);
      const match = bodyText.match(pattern);
      if (match && match[1]) return match[1].trim();
    }
    return '';
  }

  function looksLikeCompanyTitle(title) {
    if (!title || title.includes('个人')) return false;
    if (companyTitleKeywords.some(keyword => title.includes(keyword))) return true;
    return title.length >= 6 && !/先生|女士|小姐/.test(title);
  }

  const title = matchField(['发票抬头', '抬头名称', '购买方名称', '购方名称', '购买方', '抬头'], 60);
  if (looksLikeCompanyTitle(title)) {
    if (looksLikeTaxNo(title)) {
      return { invoiceType: 'wrong_company_title', invoiceTitle: `错抬头-疑似税号-${title}`, confidence: 'high' };
    }
    return { invoiceType: 'company', invoiceTitle: `企业-${title}`, confidence: 'high' };
  }
  if (title.includes('个人')) {
    return { invoiceType: 'personal', invoiceTitle: `个人-${title}`, confidence: 'high' };
  }
  if (title) {
    return { invoiceType: 'has_invoice_unknown', invoiceTitle: `未知抬头-${title}`, confidence: 'low' };
  }

  const type = matchField(['抬头类型', '发票类型', '发票性质'], 30);
  if (type.includes('个人')) {
    return { invoiceType: 'personal', invoiceTitle: `个人-${type}`, confidence: 'high' };
  }
  if (type.includes('企业') || type.includes('单位')) {
    return { invoiceType: 'company', invoiceTitle: `企业-${type}`, confidence: 'medium' };
  }
  if (bodyText.includes('申请开票') || bodyText.includes('暂未开票') || bodyText.includes('未开票')) {
    return { invoiceType: 'no_invoice', invoiceTitle: '未开票', confidence: 'high' };
  }
  if (['发票', '开票', '抬头', '税号', '纳税人', '增值税'].some(keyword => bodyText.includes(keyword))) {
    return { invoiceType: 'has_invoice_unknown', invoiceTitle: '有发票信息-类型需人工确认', confidence: 'low' };
  }
  return { invoiceType: 'no_invoice_info', invoiceTitle: '页面无发票信息', confidence: 'none' };
}

async function collectActionCandidates(page) {
  return page.evaluate((actionKeywords) => {
    const candidates = [];
    const elements = [...document.querySelectorAll('a, button, div, span')];
    const seen = new Set();

    function isVisible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    }

    elements.forEach((el, index) => {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const href = el.getAttribute('href') || el.closest('a')?.getAttribute('href') || '';
      const className = typeof el.className === 'string' ? el.className : '';
      const role = el.getAttribute('role') || '';
      const clickable = el.tagName === 'A' ||
        el.tagName === 'BUTTON' ||
        role === 'button' ||
        className.includes('button') ||
        className.includes('btn') ||
        Boolean(el.getAttribute('onclick')) ||
        Boolean(el.closest('a'));
      if (!text && !href) return;
      if (!clickable || text.length > 120) return;

      for (const group of actionKeywords) {
        let matchedWord = group.words.find(word => text.includes(word) || href.toLowerCase().includes(word.toLowerCase()));
        if (!matchedWord && group.type === 'download_invoice' && text === '下载' && /invoice|bill|pdf|ofd/i.test(href)) {
          matchedWord = '下载';
        }
        if (!matchedWord) continue;

        const key = `${group.type}|${text}|${href}`;
        if (seen.has(key)) continue;
        seen.add(key);

        candidates.push({
          type: group.type,
          matchedWord,
          text: text.slice(0, 80),
          tag: el.tagName.toLowerCase(),
          href,
          visible: isVisible(el),
          disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true' || className.includes('disabled')),
          className: className.slice(0, 120),
          elementIndex: index,
        });
      }
    });

    return candidates.slice(0, 30);
  }, ACTION_KEYWORDS);
}

async function clickFirstAction(context, page, type) {
  const group = ACTION_KEYWORDS.find(item => item.type === type);
  if (!group) throw new Error(`未知动作类型: ${type}`);

  const clickableSelector = [
    'a',
    'button',
    '[role="button"]',
    'div[class*="button"]',
    'div[class*="btn"]',
    'span[class*="button"]',
    'span[class*="btn"]',
  ].join(',');

  for (const word of group.words) {
    const locator = page.locator(clickableSelector).filter({ hasText: word });
    const count = Math.min(await locator.count().catch(() => 0), 5);
    for (let i = 0; i < count; i++) {
      const target = locator.nth(i);
      if (!(await target.isVisible().catch(() => false))) continue;
      if (await target.isDisabled().catch(() => false)) continue;

      const popupPromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
      await target.click({ timeout: 8000 });
      const popup = await popupPromise;
      const actionPage = popup || page;
      await actionPage.waitForLoadState('domcontentloaded', { timeout: CONFIG.pageTimeout }).catch(() => null);
      await actionPage.waitForLoadState('networkidle', { timeout: CONFIG.detailWaitTimeout }).catch(() => null);
      await waitForRelevantPageContent(actionPage);
      await sleep(600);
      return { page: actionPage, openedPopup: Boolean(popup), clickedText: word };
    }
  }

  for (const word of group.words) {
    const locator = page.getByText(word, { exact: true });
    const count = Math.min(await locator.count().catch(() => 0), 8);
    for (let i = 0; i < count; i++) {
      const target = locator.nth(i);
      if (!(await target.isVisible().catch(() => false))) continue;

      const popupPromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
      await target.click({ timeout: 8000 });
      const popup = await popupPromise;
      const actionPage = popup || page;
      await actionPage.waitForLoadState('domcontentloaded', { timeout: CONFIG.pageTimeout }).catch(() => null);
      await actionPage.waitForLoadState('networkidle', { timeout: CONFIG.detailWaitTimeout }).catch(() => null);
      await waitForRelevantPageContent(actionPage);
      await sleep(600);
      return { page: actionPage, openedPopup: Boolean(popup), clickedText: word, source: 'text_fallback' };
    }
  }

  throw new Error(`没有找到可点击的 ${type} 入口`);
}

async function closePageQuietly(page) {
  if (!page || page.isClosed()) return;
  await page.close({ runBeforeUnload: false }).catch(() => null);
}

async function closeAuxiliaryPages(context, keepPage) {
  const pages = context.pages();
  for (const openPage of pages) {
    if (openPage === keepPage) continue;
    await closePageQuietly(openPage);
  }
}

async function downloadFirstInvoice(context, page, mapping, preferredType = 'download_invoice', inspection = null) {
  ensureDirectory(DOWNLOAD_DIR);
  const existingDownload = getDownloadedLedgerRecord(mapping.bizOrderId);
  if (existingDownload && !cliArgs.forceDownload && !cliArgs.forceDownloadIds.includes(String(mapping.bizOrderId))) {
    return {
      status: 'file_exists',
      reason: '下载台账中已有该订单发票文件，跳过重复下载',
      filename: existingDownload.filename || path.basename(existingDownload.path || ''),
      existingPath: existingDownload.path || '',
      path: existingDownload.path || '',
    };
  }

  const group = ACTION_KEYWORDS.find(item => item.type === preferredType);
  if (!group) throw new Error(`未知下载动作类型: ${preferredType}`);

  const clickableSelector = [
    'a',
    'button',
    '[role="button"]',
    'div[class*="button"]',
    'div[class*="btn"]',
    'span[class*="button"]',
    'span[class*="btn"]',
  ].join(',');

  for (const word of group.words) {
    const locator = page.locator(clickableSelector).filter({ hasText: word });
    const count = Math.min(await locator.count().catch(() => 0), 5);
    for (let i = 0; i < count; i++) {
      const target = locator.nth(i);
      if (!(await target.isVisible().catch(() => false))) continue;
      if (await target.isDisabled().catch(() => false)) continue;

      const downloadPromise = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
      const popupPromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
      await target.click({ timeout: 8000 });

      let download = await downloadPromise;
      const popup = await popupPromise;
      try {
        if (!download && popup) {
          await popup.waitForLoadState('domcontentloaded', { timeout: CONFIG.pageTimeout }).catch(() => null);
          await popup.waitForLoadState('networkidle', { timeout: CONFIG.detailWaitTimeout }).catch(() => null);
          const popupDownloadCandidates = await collectActionCandidates(popup);
          if (popupDownloadCandidates.some(candidate => candidate.type === 'download_invoice' && candidate.visible && !candidate.disabled)) {
            return await downloadFirstInvoice(context, popup, mapping, 'download_invoice', inspection);
          }
        }

        if (!download) {
          return {
            status: 'blocked',
            reason: '点击下载入口后没有捕获到浏览器下载事件',
            clickedText: word,
            openedPopup: Boolean(popup),
          };
        }

        const suggested = download.suggestedFilename();
        const targetFile = buildInvoiceFilename(mapping, inspection || mapping, suggested);
        const targetPath = ensureUniqueFilePath(path.join(DOWNLOAD_DIR, targetFile));
        await download.saveAs(targetPath);
        const result = {
          status: 'downloaded',
          clickedText: word,
          filename: path.basename(targetPath),
          path: targetPath,
          downloadedAt: new Date().toISOString(),
        };
        recordDownloadedInvoice(mapping, result, inspection);
        return result;
      } finally {
        await closePageQuietly(popup);
      }
    }
  }

  return { status: 'blocked', reason: '没有找到可点击下载入口' };
}

function buildChatInvoiceDownloadResult(mapping, savedPath, source = {}) {
  const result = {
    status: 'downloaded',
    clickedText: source.text || '',
    filename: path.basename(savedPath),
    path: savedPath,
    downloadedAt: new Date().toISOString(),
    sourceUrl: source.href || '',
    sourceText: source.text || '',
  };
  recordDownloadedInvoice(mapping, result, {
    invoiceInfo: {
      invoiceType: 'chat_reply_invoice',
      invoiceTitle: '商家聊天回复发票',
    },
    orderMeta: {
      shopName: mapping.shopName || '',
      amount: mapping.amount || '',
    },
  });
  return result;
}

async function saveChatDownload(download, mapping, source = {}) {
  ensureDirectory(DOWNLOAD_DIR);
  const suggested = download.suggestedFilename();
  const targetFile = buildChatInvoiceFilename(mapping, suggested);
  const targetPath = ensureUniqueFilePath(path.join(DOWNLOAD_DIR, targetFile));
  await download.saveAs(targetPath);
  return buildChatInvoiceDownloadResult(mapping, targetPath, source);
}

async function downloadChatInvoiceUrlWithBrowserContext(page, url, mapping, source = {}) {
  const normalizedUrl = normalizeUrl(url, page.url());
  if (!normalizedUrl || !/^https?:\/\//i.test(normalizedUrl)) {
    return { status: 'blocked', reason: '聊天发票链接不是可请求的 HTTP/HTTPS 地址', invoiceLink: normalizedUrl || url };
  }

  try {
    const response = await page.request.get(normalizedUrl, {
      timeout: 20000,
      maxRedirects: 5,
    });
    if (!response.ok()) {
      return {
        status: 'manual_required',
        reason: `发现疑似发票链接，但直接请求失败: HTTP ${response.status()}`,
        invoiceLink: normalizedUrl,
      };
    }

    const buffer = await response.body();
    if (!buffer || buffer.length < 128) {
      return {
        status: 'manual_required',
        reason: '发现疑似发票链接，但直接请求返回内容过小',
        invoiceLink: normalizedUrl,
      };
    }

    const headers = response.headers();
    const contentType = headers['content-type'] || '';
    const disposition = headers['content-disposition'] || '';
    const dispositionName = decodeURIComponent(
      disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
      || disposition.match(/filename="?([^";]+)"?/i)?.[1]
      || ''
    );
    const urlPathName = new URL(normalizedUrl).pathname.split('/').pop() || '';
    const suggested = dispositionName || urlPathName || source.text || 'chat-invoice.pdf';
    const ext = path.extname(suggested)
      || (contentType.includes('ofd') ? '.ofd'
        : contentType.includes('zip') ? '.zip'
          : contentType.includes('image/') ? `.${contentType.split('/')[1].split(';')[0] || 'jpg'}`
            : '.pdf');
    const fileName = path.extname(suggested) ? suggested : `${sanitizeFilenamePart(suggested)}${ext}`;
    ensureDirectory(DOWNLOAD_DIR);
    const targetPath = ensureUniqueFilePath(path.join(DOWNLOAD_DIR, buildChatInvoiceFilename(mapping, fileName)));
    fs.writeFileSync(targetPath, buffer);
    return buildChatInvoiceDownloadResult(mapping, targetPath, {
      href: normalizedUrl,
      text: source.text || source.sourceText || 'direct-request',
    });
  } catch (error) {
    return {
      status: 'manual_required',
      reason: `发现疑似发票链接，但直接请求异常: ${error.message}`,
      invoiceLink: normalizedUrl,
    };
  }
}

function isLikelyInvoiceHref(href = '', text = '') {
  const normalized = String(href || '').toLowerCase();
  const label = `${href} ${text}`;
  if (CHAT_INVOICE_FILE_EXTENSIONS.some(ext => normalized.includes(ext))) return true;
  return CHAT_INVOICE_LINK_PATTERN.test(label);
}

function isLikelyChatInvoiceFileText(text = '') {
  const label = String(text || '').replace(/\s+/g, '');
  return Boolean(
    /PDF|OFD|发票|电子票|文件|附件|下载文件|下载附件/i.test(label)
    || CHAT_INVOICE_FILE_EXTENSIONS.some(ext => label.toLowerCase().includes(ext.slice(1)))
  );
}

async function collectChatReplySnapshot(page, invoiceConfig = {}) {
  const frames = [];
  for (const scope of getActiveChatScopes(page).slice(0, 10)) {
    const frame = await scope.evaluate(() => {
      function isVisible(el) {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      }

      const bodyText = document.body?.innerText || '';
      const links = [...document.querySelectorAll('a[href], button, [role="button"], div, span')]
        .filter(isVisible)
        .map((el, index) => {
          const href = el.getAttribute('href') || el.closest('a')?.getAttribute('href') || '';
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
          const title = el.getAttribute('title') || '';
          const ariaLabel = el.getAttribute('aria-label') || '';
          const downloadName = el.getAttribute('download') || '';
          const className = typeof el.className === 'string' ? el.className : '';
          return {
            index,
            tag: el.tagName.toLowerCase(),
            href,
            text: text.slice(0, 160),
            title: title.slice(0, 160),
            ariaLabel: ariaLabel.slice(0, 160),
            downloadName: downloadName.slice(0, 160),
            className: className.slice(0, 160),
          };
        })
        .filter(item => item.href
          || /发票|电子票|附件|文件|下载|查看|pdf|ofd|zip/i.test(`${item.text} ${item.title} ${item.ariaLabel} ${item.downloadName} ${item.className}`))
        .slice(0, 120);

      return {
        url: location.href,
        title: document.title,
        bodyText,
        links,
      };
    }).catch(error => ({
      url: scope.url(),
      title: '',
      bodyText: '',
      links: [],
      error: error.message,
    }));

    frames.push({
      frameUrl: scope.url(),
      ...frame,
      bodyText: redactSensitiveText(frame.bodyText || '', invoiceConfig),
    });
  }

  const combinedText = frames.map(frame => frame.bodyText || '').join('\n');
  return {
    capturedAt: new Date().toISOString(),
    finalUrl: page.url(),
    title: await page.title().catch(() => ''),
    bodyText: combinedText,
    frames,
  };
}

function classifyChatReply(snapshot) {
  const rawText = String(snapshot?.bodyText || '');
  const compact = rawText.replace(/\s+/g, '');
  const links = (snapshot?.frames || []).flatMap(frame => (frame.links || []).map(link => ({
    ...link,
    frameUrl: frame.frameUrl || frame.url || '',
  })));
  const invoiceLinks = links.filter(link => isLikelyInvoiceHref(link.href, `${link.text} ${link.title} ${link.ariaLabel} ${link.downloadName}`));
  const hasFileCard = isLikelyChatInvoiceFileText(rawText) && /下载文件|下载附件|PDF|OFD|\[文件\]/i.test(rawText);



  if (invoiceLinks.length > 0 || hasFileCard) {
    return {
      replyCategory: 'invoice_link_found',
      status: 'can_download',
      state: ORDER_STATES.CAN_DOWNLOAD,
      reason: hasFileCard ? '商家聊天回复中发现疑似发票文件卡片' : '商家聊天回复中发现疑似发票附件或下载链接',
      invoiceLinks,
      hasFileCard,
    };
  }

  if (/已开|开好了|已发送|发票已发|已上传/.test(compact) && /发票|电子票|票据/.test(compact)) {
    return {
      replyCategory: 'invoice_claimed_no_link',
      status: 'manual_required',
      state: ORDER_STATES.FAILED_RETRYABLE,
      reason: '商家称已开票/已发送，但未识别到可下载附件或链接',
      invoiceLinks,
    };
  }

  if (CHAT_INFO_REQUEST_PATTERN.test(rawText)) {
    return {
      replyCategory: 'seller_requests_info',
      status: 'manual_required',
      state: ORDER_STATES.FAILED_RETRYABLE,
      reason: '商家聊天回复要求补充开票信息',
      invoiceLinks,
    };
  }

  if (CHAT_REJECTION_PATTERN.test(compact)) {
    return {
      replyCategory: 'seller_rejected_in_chat',
      status: 'manual_required',
      state: ORDER_STATES.FAILED_FINAL,
      reason: '商家聊天回复表示无法开票或无法补开',
      invoiceLinks,
    };
  }

  if (!compact || compact.length < 20) {
    return {
      replyCategory: 'chat_not_loaded',
      status: 'manual_required',
      state: ORDER_STATES.FAILED_RETRYABLE,
      reason: '聊天页面未加载出足够内容',
      invoiceLinks,
    };
  }

  return {
    replyCategory: 'waiting_or_no_invoice_reply',
    status: 'waiting',
    state: ORDER_STATES.CONTACTED_SELLER,
    reason: '暂未识别到商家发来的发票附件/链接或明确处理要求',
    invoiceLinks,
  };
}

async function clickRadioOrOption(page, texts) {
  const clickableSelector = [
    'a',
    'label',
    'button',
    '[role="radio"]',
    '[role="button"]',
    'div[class*="radio"]',
    'span[class*="radio"]',
    'div[class*="button"]',
    'span[class*="button"]',
  ].join(',');

  for (const text of texts) {
    const locator = page.locator(clickableSelector).filter({ hasText: text });
    const count = Math.min(await locator.count().catch(() => 0), 5);
    for (let i = 0; i < count; i++) {
      const target = locator.nth(i);
      if (!(await target.isVisible().catch(() => false))) continue;
      await target.click({ timeout: 5000 }).catch(() => null);
      await sleep(500);
      return true;
    }
  }
  return false;
}

async function confirmModifyIfNeeded(page) {
  const bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
  if (!bodyText.includes('修改发票申请') && !bodyText.includes('您只有一次修改电子发票的机会')) {
    return false;
  }

  const locator = page.locator('button, a, [role="button"], div[class*="button"], span[class*="button"], div[class*="btn"], span[class*="btn"]').filter({ hasText: '修改' });
  const count = Math.min(await locator.count().catch(() => 0), 6);
  for (let i = 0; i < count; i++) {
    const target = locator.nth(i);
    const text = (await target.textContent().catch(() => '') || '').trim();
    if (text !== '修改') continue;
    if (!(await target.isVisible().catch(() => false))) continue;
    await target.click({ timeout: 8000 }).catch(() => null);
    await page.waitForLoadState('networkidle', { timeout: CONFIG.detailWaitTimeout }).catch(() => null);
    await sleep(1200);
    return true;
  }

  return false;
}

async function fillByNearbyLabel(page, labelTexts, value, fieldName) {
  if (!value || labelTexts.length === 0) return { fieldName, filled: false, reason: 'empty_value' };

  return page.evaluate(({ labelTexts, value, fieldName }) => {
    const inputSelector = 'input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), textarea';

    function isVisible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    function setInputValue(el, nextValue) {
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      if (descriptor?.set) descriptor.set.call(el, nextValue);
      else el.value = nextValue;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    }

    const controls = [...document.querySelectorAll(inputSelector)]
      .filter(el => isVisible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true')
      .map(el => ({ el, rect: el.getBoundingClientRect() }));

    const labelNodes = [...document.querySelectorAll('label, span, div, p, td, th')]
      .filter(el => isVisible(el))
      .map(el => ({
        el,
        text: (el.textContent || '').replace(/\s+/g, ''),
        rect: el.getBoundingClientRect(),
      }))
      .filter(item => item.text.length > 0 && item.text.length < 80);

    for (const labelText of labelTexts) {
      const normalized = labelText.replace(/\s+/g, '');
      const labels = labelNodes.filter(item => item.text.includes(normalized));
      for (const label of labels) {
        const candidates = controls
          .map(control => {
            const sameRow = Math.abs(control.rect.top - label.rect.top) < 28;
            const belowLabel = control.rect.top >= label.rect.top - 4 && control.rect.top <= label.rect.bottom + 42;
            const rightOfLabel = control.rect.left >= label.rect.left;
            const distance = Math.abs(control.rect.top - label.rect.top) + Math.max(0, control.rect.left - label.rect.right);
            return { ...control, sameRow, belowLabel, rightOfLabel, distance };
          })
          .filter(control => (control.sameRow || control.belowLabel) && control.rightOfLabel)
          .sort((a, b) => a.distance - b.distance);

        const target = candidates[0]?.el;
        if (!target) continue;
        if (target.value !== value) setInputValue(target, value);
        return {
          fieldName,
          filled: true,
          selector: 'nearby-label',
          label: labelText,
          alreadyHadValue: target.value === value,
        };
      }
    }

    return { fieldName, filled: false, reason: 'nearby_label_not_found' };
  }, { labelTexts, value, fieldName }).catch(() => ({ fieldName, filled: false, reason: 'nearby_label_error' }));
}

async function fillInputByLabelWithPlaywright(page, labelTexts, value, fieldName) {
  if (!value || labelTexts.length === 0) return { fieldName, filled: false, reason: 'empty_value' };

  const targetMeta = await page.evaluate(({ labelTexts }) => {
    const inputSelector = 'input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), textarea';

    function isVisible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    function normalize(text) {
      return (text || '').replace(/\s+/g, '');
    }

    const allControls = [...document.querySelectorAll(inputSelector)];
    const controls = allControls
      .map((el, index) => ({ el, index, rect: el.getBoundingClientRect() }))
      .filter(item => isVisible(item.el) && !item.el.disabled && item.el.getAttribute('aria-disabled') !== 'true');

    const labelNodes = [...document.querySelectorAll('label, span, div, p, td, th')]
      .filter(el => isVisible(el))
      .map(el => ({
        text: normalize(el.textContent || ''),
        rect: el.getBoundingClientRect(),
      }))
      .filter(item => item.text.length > 0 && item.text.length < 60);

    for (const labelText of labelTexts) {
      const normalized = normalize(labelText);
      const labels = labelNodes.filter(item => item.text === normalized || item.text.startsWith(normalized) || item.text.includes(normalized));
      for (const label of labels) {
        const candidates = controls
          .map(control => {
            const rowAligned = Math.abs((control.rect.top + control.rect.bottom) / 2 - (label.rect.top + label.rect.bottom) / 2) <= 28;
            const belowLabel = control.rect.top >= label.rect.top - 6 && control.rect.top <= label.rect.bottom + 48;
            const rightOfLabel = control.rect.left >= label.rect.right - 16;
            const distance = Math.abs(control.rect.top - label.rect.top) + Math.max(0, control.rect.left - label.rect.right);
            return { ...control, rowAligned, belowLabel, rightOfLabel, distance };
          })
          .filter(control => (control.rowAligned || control.belowLabel) && control.rightOfLabel)
          .sort((a, b) => a.distance - b.distance);

        const target = candidates[0];
        if (target) {
          return {
            found: true,
            index: target.index,
            label: labelText,
            beforeValue: target.el.value || '',
          };
        }
      }
    }

    return { found: false };
  }, { labelTexts }).catch(() => ({ found: false, error: 'label_lookup_error' }));

  if (!targetMeta.found) {
    return { fieldName, filled: false, reason: targetMeta.error || 'label_input_not_found' };
  }

  const inputSelector = 'input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), textarea';
  const target = page.locator(inputSelector).nth(targetMeta.index);
  if (!(await target.isVisible().catch(() => false))) {
    return { fieldName, filled: false, reason: 'label_input_not_visible', label: targetMeta.label };
  }
  await target.click({ timeout: 5000 }).catch(() => null);
  await target.fill('', { timeout: 5000 }).catch(() => null);
  await target.fill(value, { timeout: 5000 });
  await sleep(600);
  const afterValue = await target.inputValue({ timeout: 1000 }).catch(() => '');
  return {
    fieldName,
    filled: afterValue === value,
    selector: 'playwright-label',
    label: targetMeta.label,
    beforeValue: targetMeta.beforeValue || '',
    afterValue,
    reason: afterValue === value ? '' : 'value_reverted_after_fill',
  };
}

async function clickInvoiceTitleSuggestion(page, invoiceConfig) {
  if (!invoiceConfig.companyName) return { clicked: false, reason: 'empty_company_name' };
  const optionSelectors = [
    '.search-input-result .item',
    '.next-menu-item',
    '.next-menu li',
    '[role="option"]',
  ].join(', ');

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await sleep(700);
    const locator = page.locator(optionSelectors);
    const count = Math.min(await locator.count().catch(() => 0), 8);
    for (let i = 0; i < count; i++) {
      const target = locator.nth(i);
      if (!(await target.isVisible().catch(() => false))) continue;
      const text = (await target.innerText().catch(() => '')).trim();
      try {
        await target.click({ timeout: 5000 });
      } catch {
        return { clicked: false, text, attempt, reason: 'first_suggestion_click_failed' };
      }
      await sleep(1000);
      return { clicked: true, text, attempt };
    }
  }
  return { clicked: false, reason: 'suggestion_not_found' };
}

async function fillByExactRowLabel(page, labelTexts, value, fieldName) {
  if (!value || labelTexts.length === 0) return { fieldName, filled: false, reason: 'empty_value' };

  return page.evaluate(({ labelTexts, value, fieldName }) => {
    const inputSelector = 'input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), textarea';

    function isVisible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    function normalize(text) {
      return (text || '').replace(/\s+/g, '');
    }

    function setInputValue(el, nextValue) {
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      if (descriptor?.set) descriptor.set.call(el, nextValue);
      else el.value = nextValue;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    }

    const controls = [...document.querySelectorAll(inputSelector)]
      .filter(el => isVisible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true')
      .map(el => ({ el, rect: el.getBoundingClientRect() }));

    const labelNodes = [...document.querySelectorAll('label, span, div, p, td, th')]
      .filter(el => isVisible(el))
      .map(el => ({
        el,
        text: normalize(el.textContent || ''),
        rect: el.getBoundingClientRect(),
      }))
      .filter(item => item.text.length > 0 && item.text.length < 40);

    for (const labelText of labelTexts) {
      const normalized = normalize(labelText);
      const labels = labelNodes.filter(item => item.text === normalized || item.text.startsWith(normalized) || item.text.includes(normalized));
      for (const label of labels) {
        const candidates = controls
          .map(control => {
            const rowAligned = Math.abs((control.rect.top + control.rect.bottom) / 2 - (label.rect.top + label.rect.bottom) / 2) <= 24;
            const rightOfLabel = control.rect.left >= label.rect.right - 12;
            const distance = Math.abs(control.rect.top - label.rect.top) + Math.max(0, control.rect.left - label.rect.right);
            return { ...control, rowAligned, rightOfLabel, distance };
          })
          .filter(control => control.rowAligned && control.rightOfLabel)
          .sort((a, b) => a.distance - b.distance);

        const target = candidates[0]?.el;
        if (!target) continue;
        const beforeValue = target.value || '';
        if (beforeValue !== value) setInputValue(target, value);
        return {
          fieldName,
          filled: true,
          selector: 'exact-row-label',
          label: labelText,
          beforeValue,
          afterValue: target.value || '',
        };
      }
    }

    return { fieldName, filled: false, reason: 'exact_row_label_not_found' };
  }, { labelTexts, value, fieldName }).catch(() => ({ fieldName, filled: false, reason: 'exact_row_label_error' }));
}

async function readValueByExactRowLabel(page, labelTexts, fieldName) {
  return page.evaluate(({ labelTexts, fieldName }) => {
    const inputSelector = 'input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), textarea';

    function isVisible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    function normalize(text) {
      return (text || '').replace(/\s+/g, '');
    }

    const controls = [...document.querySelectorAll(inputSelector)]
      .filter(el => isVisible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true')
      .map(el => ({ el, rect: el.getBoundingClientRect() }));

    const labelNodes = [...document.querySelectorAll('label, span, div, p, td, th')]
      .filter(el => isVisible(el))
      .map(el => ({
        text: normalize(el.textContent || ''),
        rect: el.getBoundingClientRect(),
      }))
      .filter(item => item.text.length > 0 && item.text.length < 40);

    for (const labelText of labelTexts) {
      const normalized = normalize(labelText);
      const labels = labelNodes.filter(item => item.text === normalized || item.text.startsWith(normalized) || item.text.includes(normalized));
      for (const label of labels) {
        const candidates = controls
          .map(control => {
            const rowAligned = Math.abs((control.rect.top + control.rect.bottom) / 2 - (label.rect.top + label.rect.bottom) / 2) <= 24;
            const rightOfLabel = control.rect.left >= label.rect.right - 12;
            const distance = Math.abs(control.rect.top - label.rect.top) + Math.max(0, control.rect.left - label.rect.right);
            return { ...control, rowAligned, rightOfLabel, distance };
          })
          .filter(control => control.rowAligned && control.rightOfLabel)
          .sort((a, b) => a.distance - b.distance);

        const target = candidates[0]?.el;
        if (!target) continue;
        return {
          fieldName,
          found: true,
          label: labelText,
          value: target.value || '',
        };
      }
    }

    return { fieldName, found: false, value: '' };
  }, { labelTexts, fieldName }).catch(() => ({ fieldName, found: false, value: '' }));
}

async function fillFirstVisible(page, selectors, value, fieldName, nearbyLabels = []) {
  if (!value) return { fieldName, filled: false, reason: 'empty_value' };

  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = Math.min(await locator.count().catch(() => 0), 8);
    for (let i = 0; i < count; i++) {
      const target = locator.nth(i);
      if (!(await target.isVisible().catch(() => false))) continue;
      if (await target.isDisabled().catch(() => false)) continue;

      const currentValue = await target.inputValue({ timeout: 1000 }).catch(() => '');
      if (currentValue === value) {
        return { fieldName, filled: true, selector, alreadyHadValue: true };
      }
      await target.fill('', { timeout: 5000 }).catch(() => null);
      await target.fill(value, { timeout: 5000 });
      await sleep(300);
      return { fieldName, filled: true, selector };
    }
  }

  const nearbyResult = await fillByNearbyLabel(page, nearbyLabels, value, fieldName);
  if (nearbyResult.filled) {
    await sleep(300);
    return nearbyResult;
  }

  return { fieldName, filled: false, reason: 'not_found' };
}

async function validateFilledInvoiceForm(page, invoiceConfig) {
  const companyValue = await readValueByExactRowLabel(page, ['发票抬头'], 'companyName');
  const taxValue = await readValueByExactRowLabel(page, ['税号', '纳税人识别号'], 'taxNo');
  const emailValue = await readValueByExactRowLabel(page, ['邮箱', '电子邮箱'], 'email');
  const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  const companyActual = companyValue.value || '';
  const taxActual = taxValue.value || '';
  const emailActual = emailValue.value || (invoiceConfig.email && bodyText.includes(invoiceConfig.email) ? invoiceConfig.email : '');

  const mismatches = [];
  if (companyActual !== invoiceConfig.companyName) {
    mismatches.push({
      fieldName: 'companyName',
      expected: invoiceConfig.companyName,
      actual: companyActual || '',
    });
  }
  if (taxActual !== invoiceConfig.taxNo) {
    mismatches.push({
      fieldName: 'taxNo',
      expected: invoiceConfig.taxNo,
      actual: taxActual || '',
    });
  }

    // Cross-check: tax number should not equal company name
  if (taxActual && companyActual && taxActual === companyActual) {
    mismatches.push({
      fieldName: 'taxNo_equals_companyName',
      expected: '税号和公司名应不同',
      actual: taxActual,
    });
  }
  // Tax number format validation
  if (taxActual && !/^[0-9A-Za-z]{15,20}$/.test(taxActual.replace(/\s/g, ''))) {
    mismatches.push({
      fieldName: 'taxNo_format_invalid',
      expected: '15-20位数字字母',
      actual: taxActual,
    });
  }

return {
    ok: mismatches.length === 0,
    mismatches,
    companyValue: { ...companyValue, value: companyActual, found: companyValue.found || Boolean(companyActual) },
    taxValue: { ...taxValue, value: taxActual, found: taxValue.found || Boolean(taxActual) },
    emailValue: { ...emailValue, value: emailActual, found: emailValue.found || Boolean(emailActual) },
    emailOk: !invoiceConfig.email || emailActual === invoiceConfig.email,
  };
}

async function fillReissueForm(page, invoiceConfig) {
  await clickRadioOrOption(page, ['企业', '单位', '公司']);

  const filledFields = [];
  let companyField = await fillInputByLabelWithPlaywright(page, ['发票抬头', '抬头名称', '公司名称', '单位名称'], invoiceConfig.companyName, 'companyName');
  let titleSuggestion = null;
  if (!companyField.filled) {
    companyField = await fillByExactRowLabel(page, ['发票抬头'], invoiceConfig.companyName, 'companyName');
  }
  if (!companyField.filled) {
    companyField = await fillFirstVisible(page, [
    'input[placeholder*="发票抬头"]',
    'input[placeholder*="抬头名称"]',
    'input[placeholder*="公司名称"]',
    'input[placeholder*="单位名称"]',
    'input[name*="title" i]',
    'input[name*="company" i]',
    'input[id*="title" i]',
    'input[id*="company" i]',
    ], invoiceConfig.companyName, 'companyName', ['发票抬头', '抬头名称', '公司名称', '单位名称']);
  }
  if (companyField.filled) {
    titleSuggestion = await clickInvoiceTitleSuggestion(page, invoiceConfig);
  }
  filledFields.push({ ...companyField, titleSuggestion });

  let taxField = await fillInputByLabelWithPlaywright(page, ['税号', '纳税人识别号', '统一社会信用代码'], invoiceConfig.taxNo, 'taxNo');
  if (!taxField.filled) {
    taxField = await fillByExactRowLabel(page, ['税号', '纳税人识别号', '统一社会信用代码'], invoiceConfig.taxNo, 'taxNo');
  }
  if (!taxField.filled) {
    taxField = await fillFirstVisible(page, [
    'input[placeholder*="税号"]',
    'input[placeholder*="纳税人识别号"]',
    'input[placeholder*="统一社会信用代码"]',
    'input[name*="tax" i]',
    'input[id*="tax" i]',
    'input[name*="payer" i]',
    'input[id*="payer" i]',
    ], invoiceConfig.taxNo, 'taxNo', ['纳税人识别号', '税号', '统一社会信用代码']);
  }
  filledFields.push(taxField);

  await clickRadioOrOption(page, ['展开非必填信息', '更多信息', '展开']);

  filledFields.push(await fillFirstVisible(page, [
    'input[placeholder*="邮箱"]',
    'input[type="email"]',
    'input[name*="email" i]',
    'input[id*="email" i]',
  ], invoiceConfig.email, 'email', ['邮箱', '电子邮箱']));

  filledFields.push(await fillFirstVisible(page, [
    'input[placeholder*="手机号"]',
    'input[placeholder*="电话"]',
    'input[name*="phone" i]',
    'input[id*="phone" i]',
    'input[name*="mobile" i]',
    'input[id*="mobile" i]',
  ], invoiceConfig.phone, 'phone', ['手机号', '电话号码', '电话']));

  filledFields.push({ fieldName: 'address', filled: false, reason: 'skipped_optional_address' });

  let bankNameField = await fillByExactRowLabel(page, ['开户银行', '开户行'], invoiceConfig.bankName, 'bankName');
  if (!bankNameField.filled) {
    bankNameField = await fillFirstVisible(page, [
    'input[placeholder*="开户行"]',
    'input[placeholder*="银行"]',
    'input[name*="bank" i]',
    'input[id*="bank" i]',
    ], invoiceConfig.bankName, 'bankName', ['开户银行', '开户行', '银行']);
  }
  filledFields.push(bankNameField);

  let bankAccountField = await fillByExactRowLabel(page, ['银行账号', '银行账户'], invoiceConfig.bankAccount, 'bankAccount');
  if (!bankAccountField.filled) {
    bankAccountField = await fillFirstVisible(page, [
    'input[placeholder*="银行账号"]',
    'input[placeholder*="账号"]',
    'input[name*="account" i]',
    'input[id*="account" i]',
    ], invoiceConfig.bankAccount, 'bankAccount', ['银行账户', '银行账号', '账号']);
  }
  filledFields.push(bankAccountField);

  const requiredFilled = filledFields.filter(field => ['companyName', 'taxNo'].includes(field.fieldName));
  const missingRequired = requiredFilled.filter(field => !field.filled).map(field => field.fieldName);
  const validation = await validateFilledInvoiceForm(page, invoiceConfig);
  return { filledFields, missingRequired, validation };
}

function shouldAutoModify(inspection, history) {
  const bodyText = inspection?.detailBodyText || '';
  const parseResult = classifyPageErrorText(bodyText);
  return Boolean(
    inspection?.candidates?.some(candidate => candidate.type === 'modify_invoice' && candidate.visible && !candidate.disabled)
    && (
      inspection?.invoiceInfo?.invoiceType === 'wrong_company_title'
      || parseResult.hasRetryableError
      || history?.parseResult?.hasRetryableError
      || bodyText.includes('商家拒绝')
      || bodyText.includes('修改申请')
      || bodyText.includes('咨询商家')
    )
  );
}

function invoiceNeedsReissue(inspection, invoiceConfig = {}) {
  const invoiceType = inspection?.invoiceInfo?.invoiceType || '';
  const bodyText = inspection?.detailBodyText || '';
  if (invoiceType === 'personal' || invoiceType === 'wrong_company_title') return true;
  if (inspection?.pageClassification?.status === ORDER_STATES.NEED_REISSUE) return true;
  if (invoiceType === 'company' && invoiceConfig.companyName && invoiceConfig.taxNo) {
    return !bodyText.includes(invoiceConfig.companyName) || !bodyText.includes(invoiceConfig.taxNo);
  }
  return false;
}

async function executeModifyInvoice(context, page, mapping, invoiceConfig, baseInspection = null, baseHistory = null) {
  const inspection = baseInspection || await inspectOrder(page, mapping, invoiceConfig);
  if (inspection.status === 'error') {
    return { ...inspection, execution: buildExecutionMeta(inspection, { action: 'modify_invoice', status: 'error', reason: inspection.error, error: inspection.error }) };
  }

  const history = baseHistory || await inspectHistory(context, page);
  const clickResult = await clickFirstAction(context, page, 'modify_invoice').catch(() => null);
  if (!clickResult) {
    return {
      ...inspection,
      history,
      execution: buildExecutionMeta(inspection, {
        action: 'modify_invoice',
        status: 'manual_required',
        reason: '未找到修改申请入口',
      }),
    };
  }

  const actionPage = clickResult.page;
  try {
    await confirmModifyIfNeeded(actionPage);

    const verification = await handleVerificationIfNeeded(actionPage, '修改申请前需要安全验证');
    if (verification.blocked) {
      return {
        ...inspection,
        history,
        execution: buildExecutionMeta(inspection, {
          action: 'modify_invoice',
          status: 'manual_required',
          reason: verification.reason,
        }),
      };
    }

    const deadlineExceeded = await detectInvoiceDeadlineExceeded(actionPage);
    if (deadlineExceeded.exceeded) {
      const contactResult = await contactSellerForInvoice(context, actionPage, mapping, invoiceConfig);
      return {
        ...inspection,
        history,
        execution: buildExecutionMeta(inspection, {
          action: 'modify_invoice',
          status: contactResult.status === 'seller_contacted' ? 'seller_contacted' : 'manual_required',
          clickedText: clickResult.clickedText,
          openedPopup: clickResult.openedPopup,
          deadlineExceeded,
          contactResult,
          finalUrl: contactResult.finalUrl || actionPage.url(),
          reason: contactResult.reason || deadlineExceeded.reason,
        }),
      };
    }

    const submitMeta = await retryableFormSubmit(context, actionPage, mapping, invoiceConfig, inspection, 'modify_invoice');
    if (['submitted', 'pending'].includes(submitMeta.status)) {
      recordModifiedOrder(mapping, submitMeta, { action: 'modify_invoice', finalUrl: actionPage.url() });
    }
    return {
      ...inspection,
      history,
      execution: {
        ...submitMeta,
        clickedText: clickResult.clickedText,
        openedPopup: clickResult.openedPopup,
      },
    };
  } finally {
    if (clickResult.openedPopup) {
      await closePageQuietly(actionPage);
    }
  }
}

async function detectExistingInvoiceApplication(page, invoiceConfig) {
  const bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
  const pending = ['申请中', '商家正在处理', '已提交', '处理中', '查看申请历史'].some(word => bodyText.includes(word));
  const success = ['已开票', '申请成功', '提交成功', '开票成功', '换开成功'].some(word => bodyText.includes(word));
  const hasCompany = invoiceConfig.companyName && bodyText.includes(invoiceConfig.companyName);
  const hasTaxNo = invoiceConfig.taxNo && bodyText.includes(invoiceConfig.taxNo);
  const titleLooksLikeTaxNo = bodyShowsTaxNoAsInvoiceTitle(bodyText, invoiceConfig);

  if (pending || success) {
    return {
      exists: true,
      status: titleLooksLikeTaxNo ? 'manual_required' : (success ? 'submitted' : 'pending'),
      hasCompany,
      hasTaxNo,
      titleLooksLikeTaxNo,
      reason: titleLooksLikeTaxNo
        ? '页面显示已申请，但发票抬头像税号，需走修改申请修正'
        : (success ? '页面显示已提交/成功' : '页面显示申请中/处理中'),
    };
  }

  return { exists: false, status: '' };
}

async function detectInvoiceDeadlineExceeded(page) {
  const bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
  const parseResult = classifyPageErrorText(bodyText);
  const hit = parseResult.hits.find(item => item.type === 'expired')?.matched;
  if (!hit) return { exceeded: false, parseResult };

  return {
    exceeded: true,
    keyword: hit,
    reason: `页面提示${hit}`,
    parseResult,
  };
}

async function inspectHistory(context, page) {
  const originalUrl = page.url();
  const hasHistoryEntry = await page.evaluate((words) => {
    const bodyText = document.body?.innerText || '';
    return words.some(word => bodyText.includes(word));
  }, ACTION_KEYWORDS.find(item => item.type === 'view_history')?.words || []).catch(() => false);
  if (!hasHistoryEntry) {
    return { opened: false, historyText: '', parseResult: classifyPageErrorText('') };
  }

  const clickResult = await clickFirstAction(context, page, 'view_history').catch(() => null);
  if (!clickResult) {
    return { opened: false, historyText: '', parseResult: classifyPageErrorText('') };
  }

  const historyPage = clickResult.page;
  try {
    const historyText = await historyPage.evaluate(() => document.body.innerText || '').catch(() => '');
    return {
      opened: true,
      historyText,
      historyUrl: historyPage.url(),
      parseResult: classifyPageErrorText(historyText),
    };
  } finally {
    if (clickResult.openedPopup) {
      await closePageQuietly(historyPage);
    } else if (historyPage === page && page.url() !== originalUrl) {
      await page.goto(originalUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageTimeout }).catch(() => null);
      await page.waitForLoadState('networkidle', { timeout: CONFIG.detailWaitTimeout }).catch(() => null);
      await waitForRelevantPageContent(page).catch(() => null);
      await sleep(800);
    }
  }
}

async function tryClickAction(page, texts) {
  const clickableSelector = [
    'a',
    'button',
    'textarea',
    'input',
    '[role="button"]',
    'div[class*="button"]',
    'div[class*="btn"]',
    'span[class*="button"]',
    'span[class*="btn"]',
  ].join(',');

  for (const text of texts) {
    const locator = page.locator(clickableSelector).filter({ hasText: text });
    const count = Math.min(await locator.count().catch(() => 0), 5);
    for (let index = 0; index < count; index += 1) {
      const target = locator.nth(index);
      if (!(await target.isVisible().catch(() => false))) continue;
      if (await target.isDisabled().catch(() => false)) continue;
      await target.click({ timeout: 5000 }).catch(() => null);
      await sleep(500);
      return { clicked: true, text };
    }
  }
  return { clicked: false };
}

function getActiveChatScopes(page) {
  return page.frames().filter(scope => {
    try {
      return !scope.isDetached();
    } catch {
      return true;
    }
  });
}

async function findVisibleLocatorInScope(scope, selector, maxCount = 12) {
  const locator = scope.locator(selector);
  const count = Math.min(await locator.count().catch(() => 0), maxCount);
  for (let index = 0; index < count; index += 1) {
    const target = locator.nth(index);
    if (!(await target.isVisible().catch(() => false))) continue;
    if (await target.isDisabled?.().catch(() => false)) continue;
    return target;
  }
  return null;
}

async function tryClickActionInScope(scope, texts) {
  const clickableSelector = [
    'a',
    'button',
    'input[type="button"]',
    'input[type="submit"]',
    '[role="button"]',
    'div[class*="button"]',
    'div[class*="btn"]',
    'span[class*="button"]',
    'span[class*="btn"]',
  ].join(',');

  for (const text of texts) {
    const candidates = [
      scope.locator(clickableSelector).filter({ hasText: text }),
      scope.locator(`[aria-label*="${text}"], [title*="${text}"]`),
    ];

    for (const locator of candidates) {
      const count = Math.min(await locator.count().catch(() => 0), 8);
      for (let index = 0; index < count; index += 1) {
        const target = locator.nth(index);
        if (!(await target.isVisible().catch(() => false))) continue;
        if (await target.isDisabled?.().catch(() => false)) continue;
        await target.click({ timeout: 5000 }).catch(() => null);
        await sleep(500);
        return { clicked: true, text };
      }
    }
  }

  return { clicked: false };
}

async function tryClickActionAcrossScopes(page, texts, preferredScope = null) {
  const scopes = getActiveChatScopes(page);
  const orderedScopes = preferredScope
    ? [preferredScope, ...scopes.filter(scope => scope !== preferredScope)]
    : scopes;

  for (const scope of orderedScopes) {
    const result = await tryClickActionInScope(scope, texts);
    if (result.clicked) {
      return {
        ...result,
        scopeUrl: scope.url(),
      };
    }
  }

  return { clicked: false };
}

async function findMessageFieldTarget(page) {
  for (const scope of getActiveChatScopes(page)) {
    const locator = await findVisibleLocatorInScope(scope, MESSAGE_FIELD_SELECTORS);
    if (locator) {
      return {
        scope,
        locator,
        scopeUrl: scope.url(),
      };
    }
  }
  return null;
}

async function fillMessageField(target, message) {
  const { page, locator } = target;
  const metadata = await locator.evaluate(el => ({
    tagName: el.tagName.toLowerCase(),
    contenteditable: el.getAttribute('contenteditable'),
    isContentEditable: Boolean(el.isContentEditable),
    className: typeof el.className === 'string' ? el.className : '',
  })).catch(() => ({
    tagName: '',
    contenteditable: null,
    isContentEditable: false,
    className: '',
  }));

  if (metadata.tagName === 'textarea' || metadata.tagName === 'input') {
    await locator.fill(message, { timeout: 5000 }).catch(() => null);
    return true;
  }

  await locator.click({ timeout: 5000 }).catch(() => null);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => null);
  await page.keyboard.press('Backspace').catch(() => null);
  await page.keyboard.type(message, { delay: 20 }).catch(() => null);

  const typedOk = await locator.evaluate((el, expected) => {
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    return text.includes(expected.slice(0, Math.min(expected.length, 12)));
  }, message).catch(() => false);
  if (typedOk) return true;

  const forceSet = await locator.evaluate((el, nextValue) => {
    function dispatch(target) {
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
      target.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' }));
    }

    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.value = nextValue;
      dispatch(el);
      return true;
    }

    el.focus();
    el.textContent = nextValue;
    dispatch(el);
    return (el.innerText || el.textContent || '').includes(nextValue.slice(0, Math.min(nextValue.length, 12)));
  }, message).catch(() => false);

  return forceSet;
}

async function dismissKnownChatHints(page) {
  let acted = false;
  const mainScope = page.mainFrame();

  for (const selector of CHAT_HINT_CLOSE_SELECTORS) {
    const closeTarget = await findVisibleLocatorInScope(mainScope, selector, 3);
    if (!closeTarget) continue;
    await closeTarget.click({ timeout: 3000 }).catch(() => null);
    await sleep(400);
    acted = true;
  }

  const switchResult = await tryClickActionInScope(mainScope, WEB_CHAT_TEXTS);
  if (switchResult.clicked) {
    acted = true;
    await sleep(1000);
  }

  return acted;
}

async function collectChatDebugSnapshot(page) {
  const frameSnapshots = [];
  for (const scope of getActiveChatScopes(page).slice(0, 10)) {
    const snapshot = await scope.evaluate(() => {
      function isVisible(el) {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      }

      const candidates = [...document.querySelectorAll('textarea, input, button, a, div, span, section')]
        .filter(el => isVisible(el))
        .map(el => ({
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100),
          placeholder: el.getAttribute('placeholder') || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          title: el.getAttribute('title') || '',
          role: el.getAttribute('role') || '',
          contenteditable: el.getAttribute('contenteditable') || '',
          className: typeof el.className === 'string' ? el.className.slice(0, 200) : '',
          id: el.id || '',
        }))
        .filter(item => item.placeholder
          || item.ariaLabel
          || item.title
          || item.role === 'textbox'
          || item.contenteditable === 'true'
          || /消息|发送|输入|聊天|旺旺|网页|客户端|设置/i.test(`${item.text} ${item.className} ${item.id}`))
        .slice(0, 120);

      return {
        title: document.title,
        bodyPreview: (document.body?.innerText || '').slice(0, 4000),
        candidates,
        iframeCount: document.querySelectorAll('iframe').length,
      };
    }).catch(error => ({
      error: error.message,
    }));

    frameSnapshots.push({
      url: scope.url(),
      name: typeof scope.name === 'function' ? scope.name() : '',
      ...snapshot,
    });
  }

  return {
    finalUrl: page.url(),
    title: await page.title().catch(() => ''),
    frameCount: page.frames().length,
    frames: frameSnapshots,
  };
}

function isTradeDetailUrl(url) {
  const normalized = String(url || '').toLowerCase();
  return normalized.includes('trade.taobao.com/trade/detail/trade_order_detail.htm')
    || normalized.includes('trade.tmall.com/detail/orderdetail.htm');
}

function isSellerContactText(text) {
  const normalized = String(text || '').replace(/\s+/g, '');
  return [
    '联系卖家',
    '联系商家',
    '咨询商家',
    '旺旺',
    '旺旺联系',
    '商家客服',
  ].some(word => normalized.includes(word));
}

function buildOrderDetailUrlCandidates(mapping) {
  const urls = [];
  const seen = new Set();
  const orderId = String(mapping?.bizOrderId || '').trim();

  function add(url) {
    const normalized = normalizeUrl(url, 'https://trade.taobao.com/');
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    urls.push(normalized);
  }

  [mapping?.detailUrl, mapping?.url, mapping?.invoiceUrl].forEach(url => {
    if (isTradeDetailUrl(url)) {
      add(url);
    }
  });

  if (orderId) {
    const preferred = mapping?.platform === 'tmall'
      ? [
          `https://trade.tmall.com/detail/orderDetail.htm?bizOrderId=${orderId}`,
          `https://trade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id=${orderId}`,
        ]
      : [
          `https://trade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id=${orderId}`,
          `https://trade.tmall.com/detail/orderDetail.htm?bizOrderId=${orderId}`,
        ];
    preferred.forEach(add);
  }

  return urls;
}

function rankSellerContactCandidate(candidate, baseUrl) {
  const text = String(candidate?.text || '');
  const href = normalizeUrl(candidate?.href || '', baseUrl);
  let score = 0;
  if (candidate?.visible) score += 100;
  if (!candidate?.disabled) score += 40;
  if (isSellerContactText(text)) score += 80;
  if (/旺旺|aliim|ww/i.test(href)) score += 50;
  if (/seller|shop|store|merchant/i.test(href)) score += 20;
  if (looksLikePlatformCustomerService(href)) score -= 200;
  if (text.replace(/\s+/g, '') === '联系客服') score -= 40;
  return score;
}

function summarizeContactAttempts(attempts, fallbackReason = '未进入商家会话') {
  const details = attempts
    .map(item => {
      const parts = [item.source];
      if (item.candidateText) parts.push(item.candidateText);
      if (item.reason) parts.push(item.reason);
      return parts.filter(Boolean).join(':');
    })
    .filter(Boolean);
  if (details.length === 0) return fallbackReason;
  return `已尝试联系入口但未成功：${details.join('；')}`;
}

async function restorePageUrl(page, url) {
  if (!url || page.isClosed() || page.url() === url) return;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageTimeout }).catch(() => null);
  await page.waitForLoadState('networkidle', { timeout: CONFIG.detailWaitTimeout }).catch(() => null);
  await waitForRelevantPageContent(page).catch(() => null);
  await sleep(600);
}

async function waitForContactPageReady(page, timeout = 12000) {
  const startedAt = Date.now();
  while (!page.isClosed() && Date.now() - startedAt < timeout) {
    if (await findMessageFieldTarget(page)) {
      await sleep(500);
      return;
    }

    const markers = ['发送', '客户端聊天', '默认聊天方式', '验证', ...VERIFICATION_TEXT_MARKERS];
    const checks = await Promise.all(getActiveChatScopes(page).map(scope => {
      return scope.evaluate(markerList => {
        const bodyText = document.body?.innerText || '';
        return markerList.some(marker => bodyText.includes(marker));
      }, markers).catch(() => false);
    }));

    if (checks.some(Boolean)) {
      await sleep(500);
      return;
    }

    await sleep(500);
  }

  await sleep(500);
}

async function clickActionCandidate(context, page, candidate, options = {}) {
  const { contactMode = false } = options;
  const selector = 'a, button, div, span';
  const popupPromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
  let clicked = false;

  if (Number.isInteger(candidate?.elementIndex) && candidate.elementIndex >= 0) {
    const indexedTarget = page.locator(selector).nth(candidate.elementIndex);
    if (await indexedTarget.isVisible().catch(() => false)) {
      await indexedTarget.click({ timeout: 8000 }).catch(() => null);
      clicked = true;
    }
  }

  if (!clicked && candidate?.text) {
    const fallbackTarget = page
      .locator('a, button, [role="button"], div[class*="button"], div[class*="btn"], span[class*="button"], span[class*="btn"]')
      .filter({ hasText: candidate.text })
      .first();
    if (await fallbackTarget.isVisible().catch(() => false)) {
      await fallbackTarget.click({ timeout: 8000 }).catch(() => null);
      clicked = true;
    }
  }

  const popup = await popupPromise;
  if (!clicked) {
    if (popup) await closePageQuietly(popup);
    return null;
  }

  const actionPage = popup || page;
  await actionPage.waitForLoadState('domcontentloaded', { timeout: CONFIG.pageTimeout }).catch(() => null);
  if (contactMode) {
    await waitForContactPageReady(actionPage).catch(() => null);
  } else {
    await actionPage.waitForLoadState('networkidle', { timeout: CONFIG.detailWaitTimeout }).catch(() => null);
    await waitForRelevantPageContent(actionPage).catch(() => null);
    await sleep(600);
  }
  return {
    page: actionPage,
    openedPopup: Boolean(popup),
    clickedText: candidate?.text || candidate?.matchedWord || '',
  };
}

async function sendSellerMessageOnPage(page, mapping, invoiceConfig) {
  let bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
  let manualCheck = classifyPageErrorText(bodyText);
  if (manualCheck.hasVerificationError || isLoginOrVerifyUrl(page.url())) {
    const waitResult = await pauseForManualVerification(page, '联系商家前需要安全验证');
    if (!waitResult.resolved) {
      return { status: 'manual_required', reason: waitResult.reason, finalUrl: page.url() };
    }
    bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
    manualCheck = classifyPageErrorText(bodyText);
  }

  if (looksLikePlatformCustomerService(page.url())) {
    return {
      status: 'manual_required',
      reason: '当前入口跳转到淘宝平台客服，未进入商家会话',
      finalUrl: page.url(),
    };
  }

  const message = buildSellerMessage(mapping, invoiceConfig);
  let messageFieldTarget = await findMessageFieldTarget(page);
  if (!messageFieldTarget) {
    const adjusted = await dismissKnownChatHints(page);
    if (adjusted) {
      await waitForContactPageReady(page, 10000).catch(() => null);
      messageFieldTarget = await findMessageFieldTarget(page);
    }
  }

  if (!messageFieldTarget) {
    const debugPayload = await collectChatDebugSnapshot(page).catch(() => null);
    if (debugPayload) {
      saveDebugJson(DEBUG_CHAT_FILE, {
        capturedAt: new Date().toISOString(),
        orderId: mapping.bizOrderId,
        shopName: mapping.shopName || '',
        ...debugPayload,
      });
      console.log(`    [联系商家] 已导出聊天页调试信息: ${DEBUG_CHAT_FILE}`);
    }
    const blockedByChatMode = Boolean(
      debugPayload?.frames?.some(frame => /客户端聊天|默认聊天方式/.test(frame.bodyPreview || ''))
    );
    return {
      status: 'manual_required',
      reason: blockedByChatMode ? '未找到商家消息输入框，页面停留在聊天方式提示页' : '未找到商家消息输入框',
      finalUrl: page.url(),
    };
  }

  const filled = await fillMessageField({ page, locator: messageFieldTarget.locator }, message);
  if (!filled) {
    return {
      status: 'manual_required',
      reason: '已找到消息输入区，但自动填写失败',
      message,
      finalUrl: page.url(),
    };
  }

  const sendResult = await tryClickActionAcrossScopes(page, SEND_BUTTON_TEXTS, messageFieldTarget.scope);
  if (!sendResult.clicked) {
    return {
      status: 'manual_required',
      reason: '未找到发送按钮',
      message,
      finalUrl: page.url(),
    };
  }

  const executedAt = new Date().toISOString();
  const result = {
    status: 'seller_contacted',
    reason: '已联系商家申请开票',
    message,
    executedAt,
    finalUrl: page.url(),
  };
  recordContactedOrder(mapping, message, {
    contactedAt: executedAt,
    finalUrl: result.finalUrl,
    source: 'sendSellerMessageOnPage',
  });
  return result;
}

async function clickChatInvoiceLink(context, page, linkCandidate, mapping) {
  const scopes = getActiveChatScopes(page);
  const sourceText = linkCandidate.text || linkCandidate.title || linkCandidate.ariaLabel || linkCandidate.downloadName || '';
  const sourceHref = normalizeUrl(linkCandidate.href || '', linkCandidate.frameUrl || page.url());
  for (const scope of scopes) {
    if (sourceHref) {
      const downloadPromise = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
      const popupPromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
      const clickedByHref = await withTimeout(scope.evaluate(targetHref => {
        function normalize(href) {
          try {
            return new URL(href.startsWith('//') ? `https:${href}` : href, location.href).href;
          } catch {
            return href || '';
          }
        }

        const candidates = [...document.querySelectorAll('a[href]')];
        const target = candidates.find(el => normalize(el.getAttribute('href') || '') === targetHref);
        if (!target) return false;
        target.click();
        return true;
      }, sourceHref).catch(() => false), 5000, false);

      if (clickedByHref) {
        const download = await downloadPromise;
        const popup = await popupPromise;
        try {
          if (download) {
            return await saveChatDownload(download, mapping, {
              href: sourceHref,
              text: sourceText,
            });
          }
          if (!popup && sourceHref) {
            return await downloadChatInvoiceUrlWithBrowserContext(page, sourceHref, mapping, { text: sourceText });
          }
          if (popup) {
            await popup.waitForLoadState('domcontentloaded', { timeout: CONFIG.pageTimeout }).catch(() => null);
            const popupDownload = await popup.waitForEvent('download', { timeout: 8000 }).catch(() => null);
            if (popupDownload) {
              return await saveChatDownload(popupDownload, mapping, {
                href: popup.url() || sourceHref,
                text: sourceText,
              });
            }
          }
        } finally {
          await closePageQuietly(popup);
        }
      }
    }

    const locator = scope.locator('a[href], button, [role="button"], div, span').filter({ hasText: sourceText || '下载' });
    const count = Math.min(await locator.count().catch(() => 0), 12);
    for (let index = 0; index < count; index += 1) {
      const target = locator.nth(index);
      if (!(await target.isVisible().catch(() => false))) continue;
      const meta = await target.evaluate(el => ({
        href: el.getAttribute('href') || el.closest('a')?.getAttribute('href') || '',
        text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
        title: el.getAttribute('title') || '',
        ariaLabel: el.getAttribute('aria-label') || '',
        downloadName: el.getAttribute('download') || '',
      })).catch(() => null);
      const metaHref = normalizeUrl(meta?.href || '', scope.url());
      const metaLabel = `${meta?.text || ''} ${meta?.title || ''} ${meta?.ariaLabel || ''} ${meta?.downloadName || ''}`;
      if (sourceHref && metaHref && sourceHref !== metaHref) continue;
      if (!sourceHref && sourceText && !metaLabel.includes(sourceText.slice(0, Math.min(sourceText.length, 24)))) continue;
      if (!isLikelyInvoiceHref(metaHref, metaLabel)) continue;

      const downloadPromise = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
      const popupPromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
      await withTimeout(target.click({ timeout: 8000, noWaitAfter: true }).catch(() => null), 5000, null);
      const download = await downloadPromise;
      const popup = await popupPromise;
      try {
        if (download) {
          return await saveChatDownload(download, mapping, {
            href: metaHref || sourceHref,
            text: meta?.text || sourceText,
          });
        }

        if (popup) {
          await popup.waitForLoadState('domcontentloaded', { timeout: CONFIG.pageTimeout }).catch(() => null);
          const popupDownload = await popup.waitForEvent('download', { timeout: 8000 }).catch(() => null);
          if (popupDownload) {
            return await saveChatDownload(popupDownload, mapping, {
              href: popup.url() || metaHref || sourceHref,
              text: meta?.text || sourceText,
            });
          }
          const popupUrl = popup.url();
          if (CHAT_INVOICE_FILE_EXTENSIONS.some(ext => popupUrl.toLowerCase().includes(ext))) {
            return {
              status: 'manual_required',
              reason: '聊天链接打开了疑似发票文件页，但未触发浏览器下载事件',
              invoiceLink: popupUrl,
            };
          }
        }

        if (sourceHref) {
          return await downloadChatInvoiceUrlWithBrowserContext(page, sourceHref, mapping, { text: meta?.text || sourceText });
        }
      } finally {
        await closePageQuietly(popup);
      }
    }
  }

  if (sourceHref) {
    return {
      status: 'manual_required',
      reason: '发现疑似发票链接，但未能定位到可点击元素',
      invoiceLink: sourceHref,
    };
  }
  return { status: 'blocked', reason: '未能点击聊天中的疑似发票附件' };
}

async function clickChatFileDownloadButton(context, page, mapping) {
  const scopes = getActiveChatScopes(page);
  for (const scope of scopes) {
    const scopeText = await scope.evaluate(() => document.body?.innerText || '').catch(() => '');
    if (!isLikelyChatInvoiceFileText(scopeText)) continue;

    for (const text of CHAT_FILE_DOWNLOAD_TEXTS) {
      const locator = scope.locator('a, button, [role="button"], div, span').filter({ hasText: text });
      const count = Math.min(await locator.count().catch(() => 0), 20);
      for (let index = count - 1; index >= 0; index -= 1) {
        const target = locator.nth(index);
        if (!(await target.isVisible().catch(() => false))) continue;
        const meta = await target.evaluate(el => {
          const card = el.closest('[class*="file"], [class*="File"], [class*="message"], [class*="Message"], [class*="bubble"], [class*="Bubble"]');
          return {
            text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
            cardText: (card?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300),
            href: el.getAttribute('href') || el.closest('a')?.getAttribute('href') || '',
            className: typeof el.className === 'string' ? el.className : '',
          };
        }).catch(() => null);
        const label = `${meta?.text || ''} ${meta?.cardText || ''}`;
        if (!isLikelyChatInvoiceFileText(label) && text === '下载') continue;

        const downloadPromise = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
        const popupPromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
        await withTimeout(target.click({ timeout: 8000, noWaitAfter: true }).catch(() => null), 5000, null);
        const download = await downloadPromise;
        const popup = await popupPromise;
        try {
          if (download) {
            return await saveChatDownload(download, mapping, {
              href: normalizeUrl(meta?.href || '', scope.url()),
              text: meta?.cardText || meta?.text || text,
            });
          }
          if (popup) {
            await popup.waitForLoadState('domcontentloaded', { timeout: 12000 }).catch(() => null);
            const popupDownload = await popup.waitForEvent('download', { timeout: 8000 }).catch(() => null);
            if (popupDownload) {
              return await saveChatDownload(popupDownload, mapping, {
                href: popup.url(),
                text: meta?.cardText || meta?.text || text,
              });
            }
          }
        } finally {
          await closePageQuietly(popup);
        }
      }
    }
  }

  return { status: 'blocked', reason: '未找到可点击的聊天文件下载按钮' };
}

async function downloadInvoiceFromChatReply(context, page, mapping, chatReply) {
  const existingDownload = getDownloadedLedgerRecord(mapping.bizOrderId);
  if (existingDownload && !cliArgs.forceDownload) {
    return {
      status: 'file_exists',
      reason: '下载台账中已有该订单发票文件，跳过聊天附件重复下载',
      filename: existingDownload.filename || path.basename(existingDownload.path || ''),
      existingPath: existingDownload.path || '',
      path: existingDownload.path || '',
    };
  }

  const fileButtonResult = await clickChatFileDownloadButton(context, page, mapping);
  if (['downloaded', 'file_exists'].includes(fileButtonResult.status)) {
    return fileButtonResult;
  }

  for (const link of chatReply.invoiceLinks || []) {
    const result = await clickChatInvoiceLink(context, page, link, mapping);
    if (['downloaded', 'file_exists', 'manual_required'].includes(result.status)) {
      return result;
    }
  }

  return { status: 'blocked', reason: '未能下载聊天中的疑似发票附件或链接' };
}

async function openOrderInListPage(page, orderId) {
  const normalizedOrderId = String(orderId || '').trim();
  if (!normalizedOrderId) {
    return { found: false, reason: '缺少订单号，无法在订单列表中检索' };
  }

  console.log(`    [联系商家] 回到订单列表查找 ${normalizedOrderId}`);
  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageTimeout }).catch(() => null);
  const verification=await handleVerificationIfNeeded(page,'打开订单列表时需要登录或验证');
  if(verification.blocked)throw new Error(`WORKFLOW_AUTH_REQUIRED: ${verification.reason||'登录或验证未完成'}`);
  await page.waitForLoadState('networkidle', { timeout: CONFIG.detailWaitTimeout }).catch(() => null);
  await waitForRelevantPageContent(page).catch(() => null);
  await sleep(800);
  try { await page.click('text=知道了', { timeout: 1200 }); } catch {}

  const directContainer = page.locator(`#shopOrderContainer_${normalizedOrderId}`).first();
  if (await directContainer.isVisible().catch(() => false)) {
    console.log(`    [联系商家] 订单 ${normalizedOrderId} 已在当前列表页可见`);
    return { found: true, searchUsed: false };
  }

  const searchInput = page.locator('input[placeholder*="订单号"], input[placeholder*="店铺名"], input[placeholder*="快递单号"]').first();
  if (!(await searchInput.isVisible().catch(() => false))) {
    return { found: false, reason: '未找到订单列表搜索框' };
  }

  await searchInput.click({ timeout: 5000 }).catch(() => null);
  await searchInput.fill(normalizedOrderId, { timeout: 5000 }).catch(() => null);

  const waitForOrderCard = async () => {
    return page.waitForFunction(orderId => {
      return Boolean(document.querySelector(`#shopOrderContainer_${orderId}`));
    }, normalizedOrderId, { timeout: 10000 }).then(() => true).catch(() => false);
  };

  await searchInput.press('Enter').catch(() => null);
  await page.waitForLoadState('networkidle', { timeout: CONFIG.detailWaitTimeout }).catch(() => null);
  let found = await waitForOrderCard();
  if (found) {
    console.log(`    [联系商家] 已通过搜索框定位到订单 ${normalizedOrderId}`);
    return { found: true, searchUsed: true };
  }

  const searchIcon = page.locator('[class*="headerSearchInputIcon"]').first();
  if (await searchIcon.isVisible().catch(() => false)) {
    await searchIcon.click({ timeout: 5000 }).catch(() => null);
    await page.waitForLoadState('networkidle', { timeout: CONFIG.detailWaitTimeout }).catch(() => null);
    found = await waitForOrderCard();
  }

  if (!found) {
    return { found: false, reason: '订单列表搜索后未定位到目标订单' };
  }

  console.log(`    [联系商家] 已通过搜索按钮定位到订单 ${normalizedOrderId}`);
  return { found: true, searchUsed: true };
}

async function clickSellerContactInOrderCard(context, page, orderId) {
  const selectors = [
    `#shopOrderContainer_${orderId} a[href*="amos.alicdn.com/getcid.aw"]`,
    `#shopOrderContainer_${orderId} .ww-inline`,
    `#shopOrderContainer_${orderId} [data-spm="order_wangwang"] a`,
    `#shopOrderContainer_${orderId} [data-nick] a`,
    `#shopOrderContainer_${orderId} [data-nick]`,
  ];

  for (const selector of selectors) {
    const target = page.locator(selector).first();
    if (!(await target.isVisible().catch(() => false))) continue;

    const text = (await target.textContent().catch(() => '') || '').trim();
    const href = await target.getAttribute('href').catch(() => '');
    const popupPromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
    console.log(`    [联系商家] 尝试点击订单卡片卖家入口: ${selector}`);
    await withTimeout(target.click({ timeout: 8000, noWaitAfter: true }).catch(() => null), 5000, null);
    const popup = await popupPromise;
    const actionPage = popup || page;
    await withTimeout(actionPage.waitForLoadState('domcontentloaded', { timeout: 12000 }).catch(() => null), 13000, null);
    await withTimeout(waitForContactPageReady(actionPage, 12000).catch(() => null), 13000, null);
    return {
      page: actionPage,
      openedPopup: Boolean(popup),
      clickedText: text || '旺旺在线',
      href: normalizeUrl(href || '', page.url()),
      selector,
    };
  }

  return null;
}

async function tryContactSellerFromOrderList(context, page, mapping, invoiceConfig) {
  const sourceLabel = '订单列表页';
  const openResult = await openOrderInListPage(page, mapping.bizOrderId);
  if (!openResult.found) {
    return {
      status: 'manual_required',
      reason: `${sourceLabel}${openResult.reason ? `：${openResult.reason}` : '未找到目标订单'}`,
      attempts: [{
        source: sourceLabel,
        reason: openResult.reason || '未找到目标订单',
        finalUrl: page.url(),
      }],
      finalUrl: page.url(),
    };
  }

  const clickResult = await clickSellerContactInOrderCard(context, page, mapping.bizOrderId).catch(() => null);
  if (!clickResult) {
    return {
      status: 'manual_required',
      reason: `${sourceLabel}未找到旺旺/商家联系入口`,
      attempts: [{
        source: sourceLabel,
        reason: '未找到旺旺/商家联系入口',
        finalUrl: page.url(),
      }],
      finalUrl: page.url(),
    };
  }

  const attempts = [];
  const actionPage = clickResult.page;
  try {
    console.log(`    [联系商家] 已从订单列表进入卖家入口: ${clickResult.clickedText || clickResult.href || 'unknown'}`);
    const sendResult = await sendSellerMessageOnPage(actionPage, mapping, invoiceConfig);
    if (sendResult.status === 'seller_contacted') {
      return {
        ...sendResult,
        attempts,
        clickedText: clickResult.clickedText,
        openedPopup: clickResult.openedPopup,
        source: sourceLabel,
      };
    }

    attempts.push({
      source: sourceLabel,
      candidateText: clickResult.clickedText,
      reason: sendResult.reason,
      finalUrl: sendResult.finalUrl || actionPage.url(),
      href: clickResult.href,
    });
    return {
      status: 'manual_required',
      reason: summarizeContactAttempts(attempts, `${sourceLabel}未能进入商家会话`),
      attempts,
      finalUrl: sendResult.finalUrl || actionPage.url(),
    };
  } finally {
    if (clickResult.openedPopup) {
      await closePageQuietly(actionPage);
    }
  }
}

async function openSellerChatFromLedgerOrOrder(context, page, mapping) {
  const contactedRecord = getContactedLedgerRecord(mapping.bizOrderId);
  const attempts = [];
  const ledgerUrl = contactedRecord?.finalUrl || '';
  if (ledgerUrl && !looksLikePlatformCustomerService(ledgerUrl) && !isTradeDetailUrl(ledgerUrl) && !ledgerUrl.includes('invoice-ua.taobao.com')) {
    console.log(`    [聊天回访] 尝试打开台账聊天页: ${ledgerUrl}`);
    await page.goto(ledgerUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageTimeout }).catch(error => {
      attempts.push({ source: 'contacted-ledger', reason: error.message, finalUrl: ledgerUrl });
    });
    await waitForContactPageReady(page, 15000).catch(() => null);
    const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    if (!isLoginOrVerifyUrl(page.url()) && !looksLikePlatformCustomerService(page.url()) && /发送|聊天|消息|旺旺|发票|附件|文件|pdf|ofd/i.test(bodyText)) {
      return { page, openedPopup: false, source: 'contacted-ledger', attempts };
    }
    attempts.push({ source: 'contacted-ledger', reason: '台账 URL 未打开可读商家聊天页', finalUrl: page.url() });
  }

  const openResult = await openOrderInListPage(page, mapping.bizOrderId);
  if (!openResult.found) {
    attempts.push({ source: '订单列表页', reason: openResult.reason || '未找到目标订单', finalUrl: page.url() });
    return {
      status: 'manual_required',
      reason: summarizeContactAttempts(attempts, '未能定位订单以打开商家聊天'),
      attempts,
      finalUrl: page.url(),
    };
  }

  const clickResult = await clickSellerContactInOrderCard(context, page, mapping.bizOrderId).catch(() => null);
  if (!clickResult) {
    attempts.push({ source: '订单列表页', reason: '未找到旺旺/商家联系入口', finalUrl: page.url() });
    return {
      status: 'manual_required',
      reason: summarizeContactAttempts(attempts, '未找到商家聊天入口'),
      attempts,
      finalUrl: page.url(),
    };
  }

  return { ...clickResult, source: '订单列表页', attempts };
}

async function inspectSellerChatReply(context, page, mapping, invoiceConfig) {
  console.log(`    [聊天回访] 检查订单 ${mapping.bizOrderId}`);
  const existingReply = getChatReplyLedgerRecord(mapping.bizOrderId);
  if (existingReply?.invoiceFilePath && fs.existsSync(existingReply.invoiceFilePath) && !cliArgs.forceDownload) {
    return {
      status: 'file_exists',
      replyCategory: existingReply.replyCategory || 'invoice_downloaded_from_chat',
      reason: '聊天回访台账已有发票文件，跳过重复下载',
      invoiceFilePath: existingReply.invoiceFilePath,
      finalUrl: existingReply.finalUrl || page.url(),
      checkedAt: new Date().toISOString(),
      downloadResult: {
        status: 'file_exists',
        existingPath: existingReply.invoiceFilePath,
        path: existingReply.invoiceFilePath,
        filename: path.basename(existingReply.invoiceFilePath),
      },
    };
  }

  const openResult = await openSellerChatFromLedgerOrOrder(context, page, mapping);
  if (openResult.status === 'manual_required') {
    const result = {
      status: 'manual_required',
      replyCategory: 'chat_open_failed',
      reason: openResult.reason,
      attempts: openResult.attempts || [],
      finalUrl: openResult.finalUrl || page.url(),
      checkedAt: new Date().toISOString(),
    };
    recordChatReplyOrder(mapping, result);
    return result;
  }

  const chatPage = openResult.page;
  try {
    const verification = await handleVerificationIfNeeded(chatPage, '聊天回访前需要安全验证');
    if (verification.blocked) {
      const result = {
        status: 'manual_required',
        replyCategory: 'security_verification',
        state: ORDER_STATES.NEED_MANUAL_SECURITY_CHECK,
        reason: verification.reason,
        finalUrl: chatPage.url(),
        checkedAt: new Date().toISOString(),
      };
      recordChatReplyOrder(mapping, result);
      return result;
    }

    await dismissKnownChatHints(chatPage).catch(() => null);
    await waitForContactPageReady(chatPage, 12000).catch(() => null);
    const snapshot = await collectChatReplySnapshot(chatPage, invoiceConfig);
    const reply = classifyChatReply(snapshot);
    let downloadResult = null;

    if (reply.status === 'can_download') {
      downloadResult = await downloadInvoiceFromChatReply(context, chatPage, mapping, reply);
      const result = {
        status: downloadResult.status === 'downloaded' || downloadResult.status === 'file_exists' ? downloadResult.status : 'manual_required',
        replyCategory: downloadResult.status === 'downloaded' || downloadResult.status === 'file_exists'
          ? 'invoice_downloaded_from_chat'
          : reply.replyCategory,
        state: downloadResult.status === 'downloaded' || downloadResult.status === 'file_exists'
          ? ORDER_STATES.DOWNLOADED
          : ORDER_STATES.FAILED_RETRYABLE,
        reason: downloadResult.reason || reply.reason,
        invoiceLink: downloadResult.invoiceLink || reply.invoiceLinks?.[0]?.href || '',
        downloadResult,
        chatReply: {
          ...reply,
          invoiceLinks: reply.invoiceLinks?.slice(0, 8) || [],
        },
        finalUrl: chatPage.url(),
        checkedAt: new Date().toISOString(),
      };
      recordChatReplyOrder(mapping, result);
      return result;
    }

    const result = {
      status: reply.status === 'waiting' ? 'chat_waiting_reply' : reply.status,
      replyCategory: reply.replyCategory,
      state: reply.state,
      reason: reply.reason,
      invoiceLink: reply.invoiceLinks?.[0]?.href || '',
      chatReply: {
        ...reply,
        invoiceLinks: reply.invoiceLinks?.slice(0, 8) || [],
      },
      finalUrl: chatPage.url(),
      checkedAt: new Date().toISOString(),
    };
    recordChatReplyOrder(mapping, result);
    return result;
  } finally {
    if (openResult.openedPopup) {
      await closePageQuietly(chatPage);
    }
  }
}

async function tryContactSellerOnPage(context, page, mapping, invoiceConfig, sourceLabel) {
  const originalUrl = page.url();
  const attempts = [];
  const candidates = (await collectActionCandidates(page))
    .filter(candidate => candidate.type === 'contact_seller' && candidate.visible && !candidate.disabled)
    .sort((left, right) => rankSellerContactCandidate(right, originalUrl) - rankSellerContactCandidate(left, originalUrl));

  if (candidates.length === 0) {
    return {
      status: 'manual_required',
      reason: `${sourceLabel}未找到联系商家入口`,
      attempts: [{
        source: sourceLabel,
        reason: '未找到联系商家入口',
        finalUrl: page.url(),
      }],
    };
  }

  for (const candidate of candidates) {
    const normalizedHref = normalizeUrl(candidate.href || '', originalUrl);
    console.log(`    [联系商家] ${sourceLabel}尝试入口: ${candidate.text || candidate.matchedWord || 'unknown'} ${normalizedHref || ''}`.trim());
    if (normalizedHref && looksLikePlatformCustomerService(normalizedHref) && !isSellerContactText(candidate.text)) {
      attempts.push({
        source: sourceLabel,
        candidateText: candidate.text,
        reason: '入口直接指向淘宝平台客服',
      });
      continue;
    }

    const clickResult = await clickActionCandidate(context, page, candidate, { contactMode: true }).catch(() => null);
    if (!clickResult) {
      attempts.push({
        source: sourceLabel,
        candidateText: candidate.text,
        reason: '点击入口失败',
      });
      continue;
    }

    const actionPage = clickResult.page;
    try {
      const sendResult = await sendSellerMessageOnPage(actionPage, mapping, invoiceConfig);
      if (sendResult.status === 'seller_contacted') {
        return {
          ...sendResult,
          attempts,
          clickedText: clickResult.clickedText,
          openedPopup: clickResult.openedPopup,
          source: sourceLabel,
        };
      }

      attempts.push({
        source: sourceLabel,
        candidateText: clickResult.clickedText,
        reason: sendResult.reason,
        finalUrl: sendResult.finalUrl || actionPage.url(),
      });
    } finally {
      if (clickResult.openedPopup) {
        await closePageQuietly(actionPage);
      } else {
        await restorePageUrl(page, originalUrl);
      }
    }
  }

  return {
    status: 'manual_required',
    reason: summarizeContactAttempts(attempts, `${sourceLabel}未能进入商家会话`),
    attempts,
    finalUrl: page.url(),
  };
}

async function contactSellerForInvoice(context, page, mapping, invoiceConfig) {
  console.log(`    [联系商家] 开始处理订单 ${mapping.bizOrderId}`);
  const contactedRecord = getContactedLedgerRecord(mapping.bizOrderId);
  if (contactedRecord && !cliArgs.forceContact) {
    console.log(`    [联系商家] 台账已有记录，跳过重复发送: ${mapping.bizOrderId}`);
    return {
      status: 'seller_contacted',
      reason: '已在联系商家台账中，跳过重复发送',
      skippedDuplicate: true,
      ledgerRecord: contactedRecord,
      message: contactedRecord.message || '',
      executedAt: contactedRecord.contactedAt || contactedRecord.updatedAt || new Date().toISOString(),
      finalUrl: contactedRecord.finalUrl || page.url(),
    };
  }

  const inlineAttempt = await tryContactSellerOnPage(context, page, mapping, invoiceConfig, '发票页');
  if (inlineAttempt.status === 'seller_contacted') {
    return inlineAttempt;
  }

  const detailAttempts = [...(inlineAttempt.attempts || [])];
  for (const detailUrl of buildOrderDetailUrlCandidates(mapping)) {
    console.log(`    [联系商家] 切换到订单详情页尝试: ${detailUrl}`);
    await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageTimeout }).catch(() => null);
    await page.waitForLoadState('networkidle', { timeout: CONFIG.detailWaitTimeout }).catch(() => null);
    await waitForRelevantPageContent(page).catch(() => null);
    await sleep(800);
    try { await page.click('text=知道了', { timeout: 1200 }); } catch {}

    const attempt = await tryContactSellerOnPage(context, page, mapping, invoiceConfig, `订单详情页(${detailUrl})`);
    if (attempt.status === 'seller_contacted') {
      return {
        ...attempt,
        attempts: detailAttempts.concat(attempt.attempts || []),
      };
    }

    detailAttempts.push(...(attempt.attempts || []));
  }

  const listAttempt = await tryContactSellerFromOrderList(context, page, mapping, invoiceConfig);
  if (listAttempt.status === 'seller_contacted') {
    return {
      ...listAttempt,
      attempts: detailAttempts.concat(listAttempt.attempts || []),
    };
  }
  detailAttempts.push(...(listAttempt.attempts || []));

  return {
    status: 'manual_required',
    reason: summarizeContactAttempts(detailAttempts, inlineAttempt.reason || '未找到有效的商家联系入口'),
    attempts: detailAttempts,
    finalUrl: page.url(),
  };
}

async function clickSubmitInvoiceForm(page) {
  const submitWords = ['提交申请', '提交', '确认换开', '确认提交', '提交开票', '申请开票', '保存', '确定'];
  const dangerWords = ['删除', '取消', '关闭', '返回'];
  const clickableSelector = [
    'button',
    'a',
    '[role="button"]',
    'div[class*="button"]',
    'span[class*="button"]',
    'div[class*="btn"]',
    'span[class*="btn"]',
  ].join(',');

  for (const word of submitWords) {
    const locator = page.locator(clickableSelector).filter({ hasText: word });
    const count = Math.min(await locator.count().catch(() => 0), 8);
    for (let i = 0; i < count; i++) {
      const target = locator.nth(i);
      const text = (await target.textContent().catch(() => '') || '').trim();
      if (dangerWords.some(danger => text.includes(danger))) continue;
      if (!(await target.isVisible().catch(() => false))) continue;
      if (await target.isDisabled().catch(() => false)) continue;
      await target.click({ timeout: 8000 });
      // Wait for page to show success/failure signal instead of fixed delay
      await page.waitForFunction(() => {
        const t = document.body?.innerText || '';
        return ['申请成功', '提交成功', '换开成功', '处理中', '已提交',
                '失败', '错误', '验证码', '请重试', '商家正在处理'].some(w => t.includes(w));
      }, { timeout: 10000 }).catch(() => null);
      await sleep(500);
      return { submitted: true, text };
    }
  }

  return { submitted: false, reason: 'submit_button_not_found' };
}

function buildExecutionMeta(base, patch = {}) {
  const execution = {
    action: base.actionPlan?.action || '',
    status: patch.status || 'unknown',
    reason: patch.reason || '',
    finalUrl: patch.finalUrl || base.detailUrl || '',
    retries: patch.retries || 0,
    executedAt: patch.executedAt || new Date().toISOString(),
    ...patch,
  };
  return {
    ...execution,
    state: patch.state || deriveStateFromExecution(execution, base.state || ORDER_STATES.CHECKING),
  };
}

function getMatchedRuleIds(classification) {
  return (classification?.matchedRules || []).map(rule => rule.id).filter(Boolean);
}

function buildInspectionTrace(state, classification, action = 'classify_page') {
  const trace = createOrderTrace(ORDER_STATES.PENDING);
  appendStateEvent(trace, {
    to: ORDER_STATES.CHECKING,
    action: 'inspect_order',
    reason: '打开订单发票页并读取页面',
  });
  appendStateEvent(trace, {
    to: state,
    action,
    reason: classification?.rawPrompt || classification?.category || '',
    category: classification?.category || '',
    matchedRules: getMatchedRuleIds(classification),
  });
  return trace;
}

function finalizeOrderResult(result) {
  if (!result || typeof result !== 'object') return result;
  const fallbackState = deriveStateFromClassification(result.pageClassification, result.state || ORDER_STATES.CHECKING);
  const finalState = result.execution?.state || fallbackState;
  const trace = result.stateTrace && Array.isArray(result.stateTrace.events)
    ? result.stateTrace
    : buildInspectionTrace(fallbackState, result.pageClassification, result.actionPlan?.action || 'classify_page');
  if (result.execution) {
    appendStateEvent(trace, {
      to: finalState,
      action: result.execution.action || result.actionPlan?.action || '',
      reason: result.execution.reason || '',
      category: result.pageClassification?.category || result.execution.pageClassification?.category || '',
      matchedRules: getMatchedRuleIds(result.pageClassification || result.execution.pageClassification),
      retry: Number(result.execution.retries || 0) > 0,
    });
  }
  result.state = finalState;
  result.stateTrace = trace;
  return result;
}

function shouldCaptureResultSnapshot(result) {
  const state = result?.execution?.state || result?.state || '';
  const status = result?.execution?.status || result?.status || '';
  const category = result?.pageClassification?.category || result?.execution?.pageClassification?.category || '';
  return Boolean(
    status === 'error'
    || status === 'blocked'
    || status === 'manual_required'
    || state === ORDER_STATES.FAILED_RETRYABLE
    || state === ORDER_STATES.FAILED_FINAL
    || state === ORDER_STATES.NEED_MANUAL_SECURITY_CHECK
    || category === 'unknown_error'
    || category === 'download_failed'
  );
}

async function handleVerificationIfNeeded(page, reason) {
  const bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
  const parseResult = classifyPageErrorText(bodyText);
  if (!parseResult.hasVerificationError && !isLoginOrVerifyUrl(page.url())) {
    return { blocked: false, parseResult };
  }
  const waitResult = await pauseForManualVerification(page, reason);
  return {
    blocked: !waitResult.resolved,
    reason: waitResult.reason,
    parseResult,
  };
}

async function retryableFormSubmit(context, page, mapping, invoiceConfig, inspection, mode) {
  let retries = 0;
  let fillResult = null;
  let submitResult = null;
  let lastReason = '';

  while (retries <= CONFIG.maxRetries) {
    fillResult = await fillReissueForm(page, invoiceConfig);
    if (fillResult.missingRequired.length > 0) {
      return buildExecutionMeta(inspection, {
        action: mode,
        status: 'blocked',
        retries,
        fillResult,
        reason: `必填字段未填上: ${fillResult.missingRequired.join(', ')}`,
      });
    }
    if (!fillResult.validation?.ok) {
      lastReason = `字段回读校验失败: ${fillResult.validation.mismatches.map(item => `${item.fieldName}=${item.actual || 'empty'}`).join(', ')}`;
      retries += 1;
      if (retries > CONFIG.maxRetries) {
        return buildExecutionMeta(inspection, {
          action: mode,
          status: 'manual_required',
          retries: retries - 1,
          fillResult,
          reason: lastReason,
        });
      }
      continue;
    }

    submitResult = await clickSubmitInvoiceForm(page);
    const afterText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
    const afterClassification = classifyInvoicePage({
      text: afterText,
      url: page.url(),
      title: await page.title().catch(() => ''),
      invoiceInfo: inspection.invoiceInfo,
      candidates: await collectActionCandidates(page).catch(() => []),
    }, { invoiceConfig });
    const parsedError = classifyPageErrorText(afterText);

    if (parsedError.hasRetryableError && retries < CONFIG.maxRetries) {
      retries += 1;
      lastReason = parsedError.primaryReason || '提交后页面提示可修正错误';
      continue;
    }
    if (parsedError.hasExpiredError) {
      return buildExecutionMeta(inspection, {
        action: mode,
        status: 'expired_deadline',
        retries,
        fillResult,
        submitResult,
        pageClassification: afterClassification,
        reason: parsedError.primaryReason || '页面提示超过开票期限',
      });
    }
    if (parsedError.hasVerificationError) {
      return buildExecutionMeta(inspection, {
        action: mode,
        status: 'manual_required',
        retries,
        fillResult,
        submitResult,
        pageClassification: afterClassification,
        reason: parsedError.primaryReason || '提交后需要人工验证',
        state: ORDER_STATES.NEED_MANUAL_SECURITY_CHECK,
      });
    }

    const successHint = ['申请成功', '提交成功', '换开成功', '开票成功', '已提交', '处理中'].find(word => afterText.includes(word));
    return buildExecutionMeta(inspection, {
      action: mode,
      status: submitResult.submitted ? (!successHint ? 'manual_required' : successHint.includes('处理中') ? 'pending' : 'submitted') : 'blocked',
      retries,
      fillResult,
      submitResult,
      pageClassification: afterClassification,
      successHint: successHint || '',
      reason: submitResult.submitted ? (successHint || '已点击提交，但未确认结果，请在淘宝核对后再操作') : '未找到提交按钮',
      finalUrl: page.url(),
    });
  }

  return buildExecutionMeta(inspection, {
    action: mode,
    status: 'manual_required',
    retries,
    fillResult,
    submitResult,
    reason: lastReason || '超过最大重试次数',
  });
}

async function executeApplyInvoice(context, page, mapping, invoiceConfig) {
  const inspection = await inspectOrder(page, mapping, invoiceConfig);
  if (inspection.status === 'error') {
    return { ...inspection, execution: buildExecutionMeta(inspection, { action: 'apply_invoice', status: 'error', reason: inspection.error, error: inspection.error }) };
  }
  if (inspection.pageClassification?.status === ORDER_STATES.NEED_MANUAL_SECURITY_CHECK) {
    return {
      ...inspection,
      execution: buildExecutionMeta(inspection, {
        action: 'apply_invoice',
        status: 'manual_required',
        state: ORDER_STATES.NEED_MANUAL_SECURITY_CHECK,
        reason: inspection.pageClassification.manualReason || '页面需要人工安全验证',
      }),
    };
  }


  const hasApplyCandidate = inspection.candidates?.some(candidate => candidate.type === 'apply_invoice' && candidate.visible && !candidate.disabled);
  if (inspection.invoiceInfo?.invoiceType !== 'no_invoice') {
    return {
      ...inspection,
      execution: buildExecutionMeta(inspection, {
        action: 'apply_invoice',
        status: 'skipped',
        reason: `只自动申请明确识别为未开票的订单，当前为 ${inspection.invoiceInfo?.invoiceType || 'unknown'}`,
      }),
    };
  }
  if (!hasApplyCandidate) {
    return {
      ...inspection,
      execution: buildExecutionMeta(inspection, { action: 'apply_invoice', status: 'skipped', reason: '没有发现可见的申请开票入口' }),
    };
  }

  const clickResult = await clickFirstAction(context, page, 'apply_invoice');
  const actionPage = clickResult.page;
  try {
    const verification = await handleVerificationIfNeeded(actionPage, '申请开票前需要安全验证');
    if (verification.blocked) {
      return { ...inspection, execution: buildExecutionMeta(inspection, { action: 'apply_invoice', status: 'manual_required', reason: verification.reason }) };
    }

    const postClickCandidates = await collectActionCandidates(actionPage);
    if (postClickCandidates.some(candidate => candidate.type === 'download_invoice' && candidate.visible && !candidate.disabled)) {
      const downloadResult = await downloadFirstInvoice(context, actionPage, mapping, 'download_invoice', inspection);
      return {
        ...inspection,
        execution: buildExecutionMeta(inspection, {
          action: 'download_invoice',
          status: downloadResult.status,
          clickedText: clickResult.clickedText,
          openedPopup: clickResult.openedPopup,
          downloadResult,
          finalUrl: actionPage.url(),
          reason: downloadResult.reason || '申请页已有可下载发票，已直接下载',
        }),
      };
    }

    const existingApplication = await detectExistingInvoiceApplication(actionPage, invoiceConfig);
    if (existingApplication.exists) {
      if (existingApplication.titleLooksLikeTaxNo) {
        const actionBodyText = await actionPage.evaluate(() => document.body.innerText || '').catch(() => '');
        const normalizedPostCandidates = postClickCandidates.map(candidate => ({
          ...candidate,
          href: normalizeUrl(candidate.href, actionPage.url()),
        }));
        const repairInspection = {
          ...inspection,
          detailUrl: actionPage.url(),
          detailBodyText: actionBodyText,
          candidates: normalizedPostCandidates,
          invoiceInfo: {
            invoiceType: 'wrong_company_title',
            invoiceTitle: '错抬头-疑似税号',
            confidence: 'high',
          },
          pageClassification: classifyInvoicePage({
            text: actionBodyText,
            url: actionPage.url(),
            title: await actionPage.title().catch(() => ''),
            candidates: normalizedPostCandidates,
            invoiceInfo: {
              invoiceType: 'wrong_company_title',
              invoiceTitle: '错抬头-疑似税号',
              confidence: 'high',
            },
          }, { invoiceConfig }),
          actionPlan: normalizedPostCandidates.some(candidate => candidate.type === 'modify_invoice' && candidate.visible && !candidate.disabled)
            ? { action: 'modify_invoice', confidence: 'high', reason: existingApplication.reason }
            : { action: 'contact_seller', confidence: 'medium', reason: existingApplication.reason },
        };

        if (repairInspection.actionPlan.action === 'modify_invoice') {
          const history = await inspectHistory(context, actionPage);
          const modifyResult = await executeModifyInvoice(context, actionPage, mapping, invoiceConfig, repairInspection, history);
          return {
            ...modifyResult,
            execution: {
              ...(modifyResult.execution || {}),
              originalAction: 'apply_invoice',
              existingApplication,
              clickedText: modifyResult.execution?.clickedText || clickResult.clickedText,
              openedPopup: clickResult.openedPopup || Boolean(modifyResult.execution?.openedPopup),
            },
          };
        }

        const modifiedRecord = getModifiedLedgerRecord(mapping.bizOrderId);
        if (modifiedRecord) {
          return {
            ...repairInspection,
            execution: buildExecutionMeta(repairInspection, {
              action: 'modify_invoice',
              status: 'pending',
              state: ORDER_STATES.APPLIED_WAITING,
              existingApplication,
              modifiedRecord,
              finalUrl: actionPage.url(),
              reason: '本地台账显示已提交过修改申请，等待商家处理，跳过重复修改/联系商家',
            }),
          };
        }

        const contactResult = await contactSellerForInvoice(context, actionPage, {
          ...mapping,
          contactReason: existingApplication.reason,
        }, invoiceConfig);
        return {
          ...repairInspection,
          execution: buildExecutionMeta(repairInspection, {
            action: 'contact_seller',
            status: contactResult.status === 'seller_contacted' ? 'seller_contacted' : 'manual_required',
            existingApplication,
            contactResult,
            finalUrl: contactResult.finalUrl || actionPage.url(),
            reason: contactResult.reason || existingApplication.reason,
          }),
        };
      }

      return {
        ...inspection,
        execution: buildExecutionMeta(inspection, {
          action: 'apply_invoice',
          status: existingApplication.status,
          clickedText: clickResult.clickedText,
          openedPopup: clickResult.openedPopup,
          existingApplication,
          finalUrl: actionPage.url(),
          reason: existingApplication.reason,
        }),
      };
    }

    const deadlineExceeded = await detectInvoiceDeadlineExceeded(actionPage);
    if (deadlineExceeded.exceeded) {
      const contactResult = await contactSellerForInvoice(context, actionPage, mapping, invoiceConfig);
      return {
        ...inspection,
        execution: buildExecutionMeta(inspection, {
          action: 'apply_invoice',
          status: contactResult.status === 'seller_contacted' ? 'seller_contacted' : 'manual_required',
          clickedText: clickResult.clickedText,
          openedPopup: clickResult.openedPopup,
          deadlineExceeded,
          contactResult,
          finalUrl: contactResult.finalUrl || actionPage.url(),
          reason: contactResult.reason || deadlineExceeded.reason,
        }),
      };
    }
    const history = await inspectHistory(context, actionPage);
    const submitMeta = await retryableFormSubmit(context, actionPage, mapping, invoiceConfig, inspection, 'apply_invoice');
    return {
      ...inspection,
      history,
      execution: {
        ...submitMeta,
        clickedText: clickResult.clickedText,
        openedPopup: clickResult.openedPopup,
      },
    };
  } finally {
    if (clickResult.openedPopup) {
      await closePageQuietly(actionPage);
    }
  }
}

async function executeDownloadInvoice(context, page, mapping, invoiceConfig = {}) {
  const inspection = await inspectOrder(page, mapping, invoiceConfig);
  if (inspection.status === 'error') {
    return { ...inspection, execution: buildExecutionMeta(inspection, { action: 'download_invoice', status: 'error', reason: inspection.error, error: inspection.error }) };
  }

  const hasDownloadCandidate = inspection.candidates?.some(candidate => candidate.type === 'download_invoice' && candidate.visible && !candidate.disabled);
  if (hasDownloadCandidate) {
    const downloadResult = await downloadFirstInvoice(context, page, mapping, 'download_invoice', inspection);
    return {
      ...inspection,
      execution: buildExecutionMeta(inspection, {
        action: 'download_invoice',
        status: downloadResult.status,
        downloadResult,
        reason: downloadResult.reason || '已下载发票',
      }),
    };
  }

  const hasViewCandidate = inspection.candidates?.some(candidate => candidate.type === 'view_invoice' && candidate.visible && !candidate.disabled);
  if (hasViewCandidate) {
    const clickResult = await clickFirstAction(context, page, 'view_invoice');
    const actionPage = clickResult.page;
    try {
      const candidates = await collectActionCandidates(actionPage);
      if (candidates.some(candidate => candidate.type === 'download_invoice' && candidate.visible && !candidate.disabled)) {
        const downloadResult = await downloadFirstInvoice(context, actionPage, mapping, 'download_invoice', inspection);
        return {
          ...inspection,
          execution: buildExecutionMeta(inspection, {
            action: 'download_invoice',
            status: downloadResult.status,
            clickedText: clickResult.clickedText,
            openedPopup: clickResult.openedPopup,
            downloadResult,
            reason: downloadResult.reason || '已从查看发票页下载',
          }),
        };
      }
    } finally {
      if (clickResult.openedPopup) {
        await closePageQuietly(actionPage);
      }
    }
  }

  return {
    ...inspection,
    execution: buildExecutionMeta(inspection, { action: 'download_invoice', status: 'skipped', reason: '没有发现可见下载入口' }),
  };
}

async function executeReissue(context, page, mapping, invoiceConfig) {
  const inspection = await inspectOrder(page, mapping, invoiceConfig);
  if (inspection.status === 'error') {
    return { ...inspection, execution: buildExecutionMeta(inspection, { action: 'reissue_invoice', status: 'error', reason: inspection.error, error: inspection.error }) };
  }

  const hasReissueCandidate = inspection.candidates?.some(candidate => candidate.type === 'reissue_invoice' && candidate.visible && !candidate.disabled);
  if (!invoiceNeedsReissue(inspection, invoiceConfig)) {
    return {
      ...inspection,
      execution: buildExecutionMeta(inspection, {
        action: 'reissue_invoice',
        status: 'skipped',
        reason: `当前发票信息未被识别为需要换开，当前为 ${inspection.invoiceInfo?.invoiceType || 'unknown'}`,
      }),
    };
  }
  if (!hasReissueCandidate) {
    return {
      ...inspection,
      execution: buildExecutionMeta(inspection, { action: 'reissue_invoice', status: 'skipped', reason: '没有发现可见的换开入口' }),
    };
  }

  const clickResult = await clickFirstAction(context, page, 'reissue_invoice');
  const actionPage = clickResult.page;
  try {
    const verification = await handleVerificationIfNeeded(actionPage, '换开发票前需要安全验证');
    if (verification.blocked) {
      return { ...inspection, execution: buildExecutionMeta(inspection, { action: 'reissue_invoice', status: 'manual_required', reason: verification.reason }) };
    }

    const submitMeta = await retryableFormSubmit(context, actionPage, mapping, invoiceConfig, inspection, 'reissue_invoice');
    if (['submitted', 'pending'].includes(submitMeta.status)) {
      recordModifiedOrder(mapping, submitMeta, { action: 'reissue_invoice', finalUrl: actionPage.url() });
    }

    return {
      ...inspection,
      execution: {
        ...submitMeta,
        clickedText: clickResult.clickedText,
        openedPopup: clickResult.openedPopup,
        originalInvoiceInfo: inspection.invoiceInfo || null,
      },
    };
  } finally {
    if (clickResult.openedPopup) {
      await closePageQuietly(actionPage);
    }
  }
}

async function executeChatFollowup(context, page, mapping, invoiceConfig) {
  const chatReplyResult = await inspectSellerChatReply(context, page, mapping, invoiceConfig);
  const base = {
    status: 'ok',
    ...mapping,
    detailUrl: chatReplyResult.finalUrl || page.url(),
    pageTitle: '商家聊天回访',
    detailBodyText: '',
    orderMeta: {
      shopName: mapping.shopName || '',
      amount: mapping.amount || '',
    },
    invoiceInfo: {
      invoiceType: chatReplyResult.status === 'downloaded' || chatReplyResult.status === 'file_exists'
        ? 'chat_reply_invoice'
        : 'unknown',
      invoiceTitle: chatReplyResult.replyCategory || '商家聊天回访',
      confidence: 'medium',
    },
    pageClassification: {
      category: chatReplyResult.replyCategory || 'seller_chat_followup',
      status: chatReplyResult.state || ORDER_STATES.CONTACTED_SELLER,
      recommendedAction: chatReplyResult.status === 'downloaded' || chatReplyResult.status === 'file_exists' ? 'skip_download' : 'wait',
      matchedRules: [],
      rawPrompt: chatReplyResult.reason || '',
    },
    actionPlan: {
      action: 'chat_followup',
      confidence: 'medium',
      reason: '回访已联系商家的聊天窗口，识别商家旁路回复',
    },
    chatReply: chatReplyResult.chatReply || null,
    state: chatReplyResult.state || ORDER_STATES.CONTACTED_SELLER,
    stateTrace: buildInspectionTrace(chatReplyResult.state || ORDER_STATES.CONTACTED_SELLER, {
      category: chatReplyResult.replyCategory || 'seller_chat_followup',
      rawPrompt: chatReplyResult.reason || '',
      matchedRules: [],
    }, 'chat_followup'),
    checkedAt: chatReplyResult.checkedAt || new Date().toISOString(),
  };

  return {
    ...base,
    execution: buildExecutionMeta(base, {
      action: 'chat_followup',
      status: chatReplyResult.status,
      state: chatReplyResult.state,
      reason: chatReplyResult.reason,
      chatReplyResult,
      downloadResult: chatReplyResult.downloadResult || null,
      finalUrl: chatReplyResult.finalUrl || page.url(),
      executedAt: chatReplyResult.checkedAt || new Date().toISOString(),
    }),
  };
}

const WORKFLOW_GUARD_FILE = path.join(__dirname, 'ui-workflow-application-guard.json');

function readWorkflowGuards() {
  if (!fs.existsSync(WORKFLOW_GUARD_FILE)) return {};
  const data = JSON.parse(fs.readFileSync(WORKFLOW_GUARD_FILE, 'utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('申请记录格式错误，已停止以避免重复申请');
  return data;
}

async function readWorkflowPage(page) {
  const text = await page.evaluate(() => document.body?.innerText || '');
  const chatSurface=await page.evaluate(()=>Boolean(document.querySelector('.message-item-line, pre.edit[contenteditable="true"], .ww_input'))).catch(()=>true);
  if(chatSurface||/\/app\/im\//i.test(page.url()))return {text,candidates:[],kind:'chat'};
  const candidates = await collectActionCandidates(page);
  const fields = await page.evaluate(() => {
    const visible = el => { const r=el.getBoundingClientRect(), s=getComputedStyle(el); return r.width>0 && r.height>0 && s.display!=='none' && s.visibility!=='hidden'; };
    return [...document.querySelectorAll('input:not([type=hidden]):not([type=radio]):not([type=checkbox]),textarea')].filter(visible).length;
  });
  const hasSave = await page.getByText('保存', {exact:true}).first().isVisible().catch(() => false);
  return {text, candidates, kind:classifyInvoiceWorkflowPage({text,hasCompanyField:fields>=2&&/发票抬头|抬头名称/.test(text),hasTaxField:fields>=2&&/纳税人识别号|税号/.test(text),hasSave,hasDownload:candidates.some(c=>c.type==='download_invoice'&&c.visible&&!c.disabled)})};
}

// A missing invoice button on the detail page alone is not proof that the
// order has no entry. Re-check the actual order card before suggesting support.
async function locateWorkflowProduct(page, mapping) {
  const found = await openOrderInListPage(page, mapping.bizOrderId);
  if (!found.found) return {reason:'未能在订单列表核对开票入口，请人工查看'};
  const card = page.locator(`#shopOrderContainer_${mapping.bizOrderId}`).first();
  const snapshot = await card.evaluate(el => {
    const visible = e => { const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'; };
    const nodes=[...el.querySelectorAll('a,button,[role=button],div,span')].filter(visible);
    const hasInvoice=nodes.some(e=>/^(申请开票|开具发票|我要开票)$/.test((e.innerText||e.textContent||'').trim()));
    const preferred=[...el.querySelectorAll('a[class*="title--"][href]')];
    const links=preferred.length?preferred:[...el.querySelectorAll('a[href]')];
    const products=links.filter(visible).map(a=>({href:a.href,text:(a.innerText||a.getAttribute('title')||'').trim()})).filter(a=>{try {const u=new URL(a.href);return u.protocol==='https:'&&['item.taobao.com','detail.tmall.com'].includes(u.hostname)&&u.pathname==='/item.htm'}catch{return false}});
    const shop=el.querySelector('a[class*="shopInfoName--"], a[class*="shopInfoName"], [class*="shopName"], [class*="shop-name"], [class*="seller-name"]');
    return {hasInvoice,products,shopName:(shop?.innerText||'').trim()};
  }).catch(()=>null);
  if (!snapshot) return {reason:'订单卡片无法读取，请人工查看'};
  if (snapshot.hasInvoice) return {reason:'订单列表存在开票入口，需重新检查'};
  const productUrl=snapshot.products[0]?.href||'';
  if (!productUrl) return {verifiedNoInvoice:true,reason:'未找到可确认的商品链接'};
  return {verifiedNoInvoice:true,productUrl,shopName:snapshot.shopName||mapping.shopName||'',reason:'订单卡片未发现开票入口，请从商品页进入客服'};
}

// Inspect only actual message rows from the saved chat layout, not the entire
// page (which also includes unrelated conversations and product suggestions).
async function inspectWorkflowChat(page, mapping, options={}) {
  const timeoutMs=options.timeoutMs??20000, pollMs=options.pollMs??500;
  const deadline=Date.now()+timeoutMs;
  let sawChatInterface=false;
  do {
    for (const scope of getActiveChatScopes(page)) {
    const snapshot = await scope.evaluate(() => {
      const rows=[...document.querySelectorAll('.message-item-line')];
      const seller=(document.querySelector('.goods-right .goods-shop')?.textContent||'').trim();
      const messages=rows.map((row,index)=>{
        const item=row.querySelector('.message-item');
        if (!item) return {sender:'unknown',index};
        const content=item.querySelector('.content');
        const text=(content?.innerText||content?.textContent||'').trim();
        return {index,sender:item.classList.contains('self')?'self':'seller',text,
          time:(item.querySelector('.time')?.textContent||'').trim(),
          pdf:Boolean(content?.querySelector('.file-name[title$=".pdf" i],.file-suffix.suffix-red')),
          image:Boolean(content?.querySelector('img')),
          applyCard:/去申请|填写发票申请/.test(text)};
      });
      const editor=Boolean(document.querySelector('pre.edit[contenteditable="true"], .ww_input'));
      return {seller,messages,editor};
    }).catch(()=>null);
    if(snapshot?.editor)sawChatInterface=true;
    if (!snapshot?.messages?.length) continue;
    if (!mapping.shopName || !snapshot.seller || snapshot.seller!==mapping.shopName) return {kind:'unknown',reason:'无法确认聊天窗口与订单店铺一致'};
    return {...analyzeRecentMessages(snapshot.messages,mapping.bizOrderId),scope,snapshot};
    }
    if(page.isClosed?.())break;
    if(Date.now()<deadline)await sleep(Math.min(pollMs,Math.max(0,deadline-Date.now())));
  } while(Date.now()<deadline);
  return {kind:'unknown',reason:sawChatInterface?'客服输入框已打开，但未读取到聊天消息，可能是消息尚未加载或聊天为空':'未找到客服聊天窗口或消息区域'};
}

function workflowReviewUrl(value) {
  try {
    const url=new URL(value),host=url.hostname.toLowerCase();
    if(url.protocol!=='https:'||url.username||url.password||!['taobao.com','tmall.com'].some(domain=>host===domain||host.endsWith(`.${domain}`)))return '';
    if(/(?:^|[?&#;])(?:access_?token|token|session|sessionkey|auth|password|cookie|sid|sign|code)=/i.test(url.search+url.hash))return '';
    return url.href;
  } catch { return ''; }
}

const WORKFLOW_CHAT_GUARD_FILE=path.join(__dirname,'ui-workflow-chat-guard.json');
function workflowChatGuards(){
  if(!fs.existsSync(WORKFLOW_CHAT_GUARD_FILE))return {};
  const value=JSON.parse(fs.readFileSync(WORKFLOW_CHAT_GUARD_FILE,'utf8'));
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('客服消息记录异常，已停止发送');
  return value;
}

async function sendWorkflowChatMessage(scope,orderId,message,stage){
  const guards=workflowChatGuards(),existing=guards[orderId]||{};
  if(existing[stage])return {ok:false,reason:'该消息已有发送记录或结果不明确，避免重复发送'};
  const editor=scope.locator('pre.edit[contenteditable="true"]').first();
  const button=scope.locator('button.send-btn').first();
  if(!(await editor.isVisible().catch(()=>false))||!(await button.isVisible().catch(()=>false)))return {ok:false,reason:'未找到客服输入框或发送按钮'};
  await editor.fill(message,{timeout:5000});
  const filled=await editor.innerText().catch(()=>'');
  const normalize=s=>String(s||'').replace(/\s+/g,' ').trim();
  if(normalize(filled)!==normalize(message))return {ok:false,reason:'客服消息填写校验失败'};
  guards[orderId]={...existing,[stage]:{status:'uncertain',at:new Date().toISOString()}};
  saveJsonAtomic(WORKFLOW_CHAT_GUARD_FILE,guards);
  await button.click({timeout:5000});
  const visible=await scope.waitForFunction(expected=>[...document.querySelectorAll('.message-item.self .content')].some(e=>(e.innerText||'').replace(/\s+/g,' ').trim()===expected),normalize(message),{timeout:10000}).then(()=>true).catch(()=>false);
  if(!visible)return {ok:false,reason:'已点击发送，但聊天记录未确认，请勿重复发送'};
  guards[orderId][stage].status='sent';saveJsonAtomic(WORKFLOW_CHAT_GUARD_FILE,guards);
  return {ok:true};
}

async function downloadMatchedWorkflowChatPdf(chat,reply,mapping){
  if(amountInCents(mapping.amount)===null)return {status:'manual_required',reason:'订单总金额未知，无法核对客服 PDF'};
  const candidates=reply.pdfCandidates?.length?reply.pdfCandidates:[reply.message];
  let lastReason='未发现与订单金额一致的 PDF';
  for(const candidate of candidates){
    const row=reply.scope.locator('.message-item-line').nth(candidate.index);
    const sameMessage=await row.evaluate((el,expected)=>{
      const item=el.querySelector('.message-item'),content=item?.querySelector('.content');
      const text=(content?.innerText||content?.textContent||'').trim();
      const time=(item?.querySelector('.time')?.textContent||'').trim();
      return Boolean(item&&!item.classList.contains('self')&&text===expected.text&&time===expected.time&&content?.querySelector('.file-name[title$=".pdf" i],.file-suffix.suffix-red'));
    },candidate).catch(()=>false);
    if(!sameMessage){lastReason='客服消息发生变化，需重新检查';continue}
    const btn=row.locator('.J_downloadFile').first();
    if(!(await btn.isVisible().catch(()=>false))){lastReason='未找到对应消息的 PDF 下载按钮';continue}
    const pending=chat.waitForEvent('download',{timeout:20000}).catch(()=>null);
    await btn.click({timeout:8000});
    const download=await pending;
    if(!download){lastReason='未捕获 PDF 下载，需人工核对';continue}
    const tmpDir=fs.mkdtempSync(path.join(os.tmpdir(),'taobao-invoice-check-'));
    const tmpFile=path.join(tmpDir,'candidate.pdf');
    try{
      await download.saveAs(tmpFile);
      const comparison=await compareInvoicePdf(tmpFile,mapping.amount);
      ensureDirectory(DOWNLOAD_DIR);
      const targetFile=buildChatInvoiceFilename(mapping,'invoice.pdf');
      const targetPath=ensureUniqueFilePath(path.join(DOWNLOAD_DIR,targetFile));
      fs.copyFileSync(tmpFile,targetPath,fs.constants.COPYFILE_EXCL);
      if(!comparison.ok){
        lastReason=comparison.reason;
        return {
          status:'manual_required',
          reason:'PDF 价税合计与订单金额不一致；已保存供人工核对',
          invoiceStatus:'',
          downloadResult:{status:'pdf_mismatch_saved',filename:path.basename(targetPath),path:targetPath,downloadedAt:new Date().toISOString(),amountMatched:false},
        };
      }
      const saved=buildChatInvoiceDownloadResult(mapping,targetPath,{text:'客服聊天 PDF，价税合计与订单金额一致'});
      return {...saved,reason:'客服 PDF 的价税合计与订单金额一致，已保存',amountMatched:true};
    }catch(error){lastReason='客服 PDF 下载或核对失败，需要人工查看'}
    finally{try{fs.rmSync(tmpDir,{recursive:true,force:true})}catch{}}
  }
  return {status:'manual_required',reason:lastReason};
}

async function submitWorkflowForm(invoicePage,mapping,invoiceConfig){
  const guards=readWorkflowGuards();
  if(guards[mapping.bizOrderId])return {status:'manual_required',reason:'之前提交结果尚未确认，请先在淘宝核对，避免重复申请'};
  const filled=await fillReissueForm(invoicePage,invoiceConfig);
  if(filled.missingRequired.length||!filled.validation?.ok)return {status:'manual_required',reason:'抬头或税号无法确认，未提交',fillResult:filled};
  guards[mapping.bizOrderId]={status:'submission_uncertain',at:new Date().toISOString()};saveJsonAtomic(WORKFLOW_GUARD_FILE,guards);
  const submitted=await clickSubmitInvoiceForm(invoicePage);
  if(!submitted.submitted){delete guards[mapping.bizOrderId];saveJsonAtomic(WORKFLOW_GUARD_FILE,guards);return {status:'manual_required',reason:'未找到保存按钮，未提交'}}
  await sleep(10000);
  const current=await readWorkflowPage(invoicePage);
  if(current.kind==='pending'||current.kind==='issued'){
    guards[mapping.bizOrderId]={status:'confirmed',at:new Date().toISOString()};saveJsonAtomic(WORKFLOW_GUARD_FILE,guards);
    return {status:current.kind==='pending'?'pending':'issued',reason:current.kind==='pending'?'申请已提交，页面显示开票中':'页面显示已开票',...(current.kind==='issued'?{invoiceStatus:'issued'}:{})};
  }
  return {status:'manual_required',reason:'已点击保存，但未确认开票中，请先在淘宝核对，避免重复申请'};
}

async function processWorkflowChatCard(context,chat,reply,mapping,invoiceConfig){
  if(reply.message?.sender!=='seller')return {status:'manual_required',reason:'申请卡片发送方无法确认'};
  console.log('    [客服申请] 找到商家申请卡片，按设置尝试填写');
  const card=reply.scope.locator('.message-item-line').nth(reply.message.index);
  const button=card.getByText('去申请',{exact:true}).first();
  if(!(await button.isVisible().catch(()=>false)))return {status:'manual_required',reason:'未找到申请卡片按钮'};
  const pending=context.waitForEvent('page',{timeout:5000}).catch(()=>null);
  await button.click({timeout:8000});console.log('    [客服申请] 已点击申请卡片，等待申请页面');const popup=await pending,form=popup||chat;
  try {
    await form.waitForLoadState('domcontentloaded',{timeout:CONFIG.pageTimeout}).catch(()=>null);
    await waitForRelevantPageContent(form);
    const current=await readWorkflowPage(form);
    if(current.kind==='pending')return {status:'pending',reason:'页面显示开票中'};
    if(current.kind==='issued')return {status:'issued',reason:'页面显示已开票',invoiceStatus:'issued'};
    if(current.kind!=='form')return {status:'manual_required',reason:current.kind==='chat'?'点击后仍停留在聊天页面，未确认打开申请表，未提交':'客服申请页状态不明确，请人工确认'};
    return await submitWorkflowForm(form,mapping,invoiceConfig);
  } finally {if(popup)await closePageQuietly(popup)}
}

async function captureMatchedWorkflowQr(reply,mapping){
  if(!reply.matchedOrder)return {status:'manual_required',reason:'聊天图片无法确认属于本订单，需人工核对'};
  const row=reply.scope.locator('.message-item-line').nth(reply.message.index);
  const img=row.locator('.content img').first();
  if(!(await img.isVisible().catch(()=>false)))return {status:'manual_required',reason:'聊天图片无法读取'};
  const isQr=await img.evaluate(async el=>{
    try { if(!('BarcodeDetector' in window))return false;const detector=new BarcodeDetector({formats:['qr_code']});return (await detector.detect(el)).length>0; } catch {return false;}
  }).catch(()=>false);
  if(!isQr)return {status:'manual_required',reason:'无法确认聊天图片是二维码，需人工核对'};
  const dir=path.join(__dirname,'snapshots','chat-qr');ensureDirectory(dir);
  const file=path.join(dir,`${mapping.bizOrderId}-${Date.now()}.png`);
  await img.screenshot({path:file});
  return {status:'qr_received',reason:'已保存商家提供的二维码，请扫码获取发票',qrPath:file};
}

async function captureRecentSellerImages(reply,mapping){
  const messages=reply.snapshot.messages.slice(-5).filter(m=>m.sender==='seller'&&m.image);
  console.log(`    [图片检查] 最近 5 条消息中，${messages.length} 条商家消息包含图片`);
  const dir=path.join(__dirname,'snapshots','chat-qr');ensureDirectory(dir);
  const imagePaths=[];let attempted=0;
  for(const message of messages){
    const images=reply.scope.locator('.message-item-line').nth(message.index).locator('.content img');
    const count=await images.count();
    for(let i=0;i<count;i++){
      attempted++;
      const file=path.join(dir,`${mapping.bizOrderId}-${Date.now()}${String(attempted).padStart(3,'0')}.png`);
      try{
        const image=images.nth(i);
        await image.waitFor({state:'visible',timeout:8000});
        await image.evaluate(el=>el.decode?.().catch(()=>{})).catch(()=>{});
        const original=await image.evaluate(el=>{
          if(!el.complete||!el.naturalWidth||!el.naturalHeight||el.naturalWidth*el.naturalHeight>40000000)return null;
          try{const canvas=document.createElement('canvas');canvas.width=el.naturalWidth;canvas.height=el.naturalHeight;canvas.getContext('2d').drawImage(el,0,0);return canvas.toDataURL('image/png')}catch{return null}
        }).catch(()=>null);
        let bytes;
        if(original?.startsWith('data:image/png;base64,')){bytes=Buffer.from(original.split(',')[1],'base64');console.log(`    [图片检查] 图片 ${attempted}：已读取完整图片`)}
        else{
          await image.scrollIntoViewIfNeeded();
          const visible=await image.evaluate(el=>{
            const r=el.getBoundingClientRect();let bounds={left:0,top:0,right:innerWidth,bottom:innerHeight};
            for(let p=el.parentElement;p;p=p.parentElement){const style=getComputedStyle(p);if(/(auto|scroll|hidden|clip)/.test(style.overflow+style.overflowX+style.overflowY)){const b=p.getBoundingClientRect();bounds={left:Math.max(bounds.left,b.left),top:Math.max(bounds.top,b.top),right:Math.min(bounds.right,b.right),bottom:Math.min(bounds.bottom,b.bottom)}}}
            return r.width>0&&r.height>0&&r.left>=bounds.left-1&&r.right<=bounds.right+1&&r.top>=bounds.top-1&&r.bottom<=bounds.bottom+1;
          });
          if(!visible){console.log(`    [图片检查] 图片 ${attempted}：页面遮挡或裁切，未保存`);continue;}
          bytes=await image.screenshot({timeout:8000});
          console.log(`    [图片检查] 图片 ${attempted}：无法读取原图，使用完整可见区域截图`);
        }
        const nonblank=await reply.scope.evaluate(async data=>{
          const img=new Image();img.src='data:image/png;base64,'+data;await img.decode();const c=document.createElement('canvas');c.width=32;c.height=32;const ctx=c.getContext('2d');ctx.drawImage(img,0,0,32,32);const pixels=ctx.getImageData(0,0,32,32).data;let min=255,max=0;for(let j=0;j<pixels.length;j+=4){if(pixels[j+3]<16)continue;const lum=(pixels[j]+pixels[j+1]+pixels[j+2])/3;min=Math.min(min,lum);max=Math.max(max,lum)}return max-min>8;
        },bytes.toString('base64')).catch(()=>false);
        if(!nonblank){console.log(`    [图片检查] 图片 ${attempted}：内容为空白或无法验证，未保存`);continue;}
        fs.writeFileSync(file,bytes,{flag:'wx'});imagePaths.push(file);
      }catch{console.log(`    [图片检查] 图片 ${attempted}：读取或保存失败`)}
    }
  }
  if(!imagePaths.length)return {status:'manual_required',reason:'发现商家图片，但无法保存，请人工核对'};
  return {status:'images_saved',reason:`已保存 ${imagePaths.length} 张客服图片${imagePaths.length<attempted?'，部分图片保存失败；':''}，请人工核对是否为发票`,imagePaths};
}

async function findShopCustomerButton(page,options={}){
  const timeout=options.timeoutMs??15000,deadline=Date.now()+timeout;
  do{
    const selectors=[
      ()=>page.locator('div[class*="rightContainer"] > div[class*="button"]:has(#aliww-click-trigger)'),
      ()=>page.getByRole('button',{name:'客服',exact:true}),
      ()=>page.locator('[class*="shopHeader"] a').filter({hasText:/^\s*客服\s*$/}),
      ()=>page.getByText('客服',{exact:true}),
    ];
    for(const make of selectors){
      let matches;try{matches=make()}catch{continue}
      const count=typeof matches.count==='function'?Math.min(await matches.count().catch(()=>0),20):1;
      for(let i=0;i<count;i++){
        const candidate=typeof matches.nth==='function'?matches.nth(i):matches.first();
        if(await candidate.isVisible().catch(()=>false))return candidate;
      }
    }
    if(Date.now()>=deadline)break;
    await sleep(Math.min(500,Math.max(0,deadline-Date.now())));
  }while(true);
  return null;
}

async function readOrderDetailShop(page){
  return page.evaluate(()=>{
    const links=[...document.querySelectorAll('.trade-order-detail-shop-info [data-spm="shop_shopname"] a[href]')];
    if(links.length!==1)return null;
    const name=(links[0].innerText||links[0].textContent||'').trim();
    try{const u=new URL(links[0].href,location.href);if(u.protocol!=='https:'||!/^shop\d+\.taobao\.com$/.test(u.hostname)||!name)return null;return {shopName:name,shopUrl:u.href}}catch{return null}
  }).catch(()=>null);
}

async function inspectWorkflowProductChat(context,page,mapping,product,invoiceConfig,options={}) {
  if ((!product.productUrl&&!product.shopUrl) || !product.shopName) return {reason:'商品或店铺无法确认，需人工打开客服'};
  if(!options.pageReady){
    if(product.shopUrl)console.log(`    [客服检查] 优先打开订单详情中的店铺：${product.shopName}`);
    await page.goto(product.shopUrl||product.productUrl,{waitUntil:'domcontentloaded',timeout:CONFIG.pageTimeout});
  }
  // The saved product page places the visible 客服 text inside an anchor in
  // the shop header. Wait for the app to hydrate and click that anchor, not
  // an unrelated 客服 label elsewhere on the page.
  await page.waitForLoadState('networkidle',{timeout:10000}).catch(()=>null);
  let customer=await findShopCustomerButton(page);
  if(!customer&&product.productUrl&&product.shopUrl){
    console.log('    [客服检查] 店铺页未找到客服，尝试商品页面');
    await page.goto(product.productUrl,{waitUntil:'domcontentloaded',timeout:CONFIG.pageTimeout});
    await page.waitForLoadState('networkidle',{timeout:10000}).catch(()=>null);
    customer=await findShopCustomerButton(page);
  }
  if (!customer) return {reason:product.shopUrl?(product.productUrl?'商品页和店铺页未找到客服入口':'店铺页等待加载后仍未找到客服按钮'):'商品页未找到客服入口，订单详情店铺链接无法确认'};
  const beforeUrl=page.url();
  const existingPages=new Set(context.pages());
  const popupPromise=context.waitForEvent('page',{timeout:10000}).catch(()=>null);
  await customer.click({timeout:8000});
  const popup=(await popupPromise)||context.pages().find(p=>!existingPages.has(p))||null, chat=popup||page;
  try {
    console.log(`    [客服检查] 已点击店铺客服，${popup?'发现新窗口':page.url()!==beforeUrl?'当前页面发生跳转':'未发现新窗口，检查当前页面及内嵌窗口'}，等待聊天消息加载`);
    await waitForContactPageReady(chat,12000);
    let reply=await inspectWorkflowChat(chat,{...mapping,shopName:product.shopName});
    console.log(`    [客服检查] ${reply.snapshot?'已读取消息':'暂未读取到消息'}${reply.reason?'：'+reply.reason:''}`);
    // Embedded chat may have its own address; preserve it for manual review.
    // The UI will mark this as a chat entry, not guarantee a specific thread.
    const scopedUrl=workflowReviewUrl(reply.scope?.url?.());
    const chatUrl=scopedUrl && scopedUrl!==product.productUrl ? scopedUrl : (workflowReviewUrl(chat.url())!==product.productUrl ? workflowReviewUrl(chat.url()) : '');
    const processReply=async r=>{
      if(r.kind==='pdf'){const file=await downloadMatchedWorkflowChatPdf(chat,r,mapping);return {...file,downloadResult:file.downloadResult||file,invoiceStatus:file.status==='downloaded'?'issued':''};}
      if(r.kind==='image')return {status:'image_review',reason:'客服最近 5 条消息含图片，请人工审查；未保存图片'};
      if(r.kind==='card')return processWorkflowChatCard(context,chat,r,mapping,invoiceConfig);
      return null;
    };
    if(options.readOnly){
      if(cliArgs.applyChatCard&&reply.snapshot){
        const card=reply.snapshot.messages.slice(-5).findLast(m=>m.sender==='seller'&&m.applyCard);
        if(card){const applied=await processWorkflowChatCard(context,chat,{...reply,message:card,matchedOrder:String(card.text||'').includes(String(mapping.bizOrderId))},mapping,invoiceConfig);return {...applied,chatUrl}}
      }
      if(reply.kind==='pdf'){
        const file=await downloadMatchedWorkflowChatPdf(chat,reply,mapping);
        return {...file,downloadResult:file.downloadResult||file,invoiceStatus:['downloaded','file_exists'].includes(file.status)?'issued':'',chatUrl};
      }
      if(reply.kind==='image')return {status:'image_review',reason:'客服最近 5 条消息含图片，请人工审查；未保存图片',chatUrl};
      if(reply.kind==='card'){
        if(cliArgs.applyChatCard){const applied=await processWorkflowChatCard(context,chat,reply,mapping,invoiceConfig);return {...applied,chatUrl}}
        return {status:'manual_required',reason:'客服消息含申请卡片，尚未执行申请',chatUrl};
      }
      if(reply.kind==='no_invoice'||reply.kind==='already_contacted'){
        const recent=reply.snapshot.messages.slice(-5).filter(m=>m.sender==='self').map(m=>m.text||'').join(' ');
        const requested=/发票|开票|抬头|税号|纳税人识别号/.test(recent);
        return {status:'chat_checked',reason:requested?'最近 5 条消息有开票相关信息，未发现可确认的 PDF':'最近 5 条消息未发现开票申请信息或可确认的 PDF；更早记录未检查',chatUrl};
      }
      return {status:'manual_required',reason:reply.reason||'无法可靠读取客服消息',chatUrl};
    }
    let handled=await processReply(reply);if(handled)return {...handled,chatUrl};
    if(reply.kind==='already_contacted'||getContactedLedgerRecord(mapping.bizOrderId))return {status:'seller_contacted',reason:'已联系过商家，等待人工审核',chatUrl};
    if(reply.kind!=='no_invoice')return {status:'manual_required',reason:reply.reason||'无法可靠读取客服消息',chatUrl};
    const rawTax=String(invoiceConfig.taxNo||'').replace(/\s+/g,'');
    const formattedTax=rawTax.length===18?`${rawTax.slice(0,4)} ${rawTax.slice(4,12)} ${rawTax.slice(12)}`:rawTax;
    const message=`可以开发票吗？我找不到具体开票入口\n名称：${invoiceConfig.companyName}\n税号：${formattedTax}`;
    const sent=await sendWorkflowChatMessage(reply.scope,mapping.bizOrderId,message,'first');
    if(!sent.ok)return {status:'manual_required',reason:sent.reason,chatUrl};
    recordContactedOrder(mapping,message,{contactedAt:new Date().toISOString(),finalUrl:chatUrl,source:'workflow'});
    await sleep(10000);
    reply=await inspectWorkflowChat(chat,{...mapping,shopName:product.shopName});
    if(!reply.snapshot)return {status:'seller_contacted',reason:'已联系客服，等待人工审核',chatUrl};
    const normalize=s=>String(s||'').replace(/\s+/g,' ').trim();
    const sentIndex=reply.snapshot.messages.findLastIndex(m=>m.sender==='self'&&normalize(m.text)===normalize(message));
    if(sentIndex<0)return {status:'seller_contacted',reason:'已联系客服，未能确认后续回复，等待人工审核',chatUrl};
    const newer=reply.snapshot.messages.slice(sentIndex+1).filter(m=>m.sender==='seller');
    if(!newer.length)return {status:'seller_contacted',reason:'已联系客服，等待商家回复',chatUrl};
    const newReply=analyzeRecentMessages(newer,mapping.bizOrderId);
    handled=await processReply({...newReply,scope:reply.scope});
    if(handled)return {...handled,chatUrl};
    const followup='可以直接帮我开票吗，开票信息在上面了，直接聊天区给我或者帮我录入系统可以吗，我找不到了入口。';
    const second=await sendWorkflowChatMessage(reply.scope,mapping.bizOrderId,followup,'followup');
    return {status:'seller_contacted',reason:second.ok?'已联系客服，等待人工审核':`已联系客服；后续消息未确认：${second.reason}`,chatUrl};
  } catch (error) {
    return {status:'manual_required',reason:'客服页面处理失败，请人工查看',chatUrl:workflowReviewUrl(chat.url())===product.productUrl?'':workflowReviewUrl(chat.url())};
  } finally { if (popup) await closePageQuietly(popup); }
}

async function executeInvoiceWorkflow(context, page, mapping, invoiceConfig) {
  const inspection = await inspectOrder(page, mapping, invoiceConfig);
  const result = (status, reason, extra={}) => ({...inspection, execution:buildExecutionMeta(inspection,{action:'workflow',status,reason,...extra})});
  if (!mapping.orderDate || !isDateInRange(mapping.orderDate)) return result('manual_required','购买日期未确认或不在选择范围内');
  if (inspection.status !== 'ok') return result('manual_required','订单页面未能读取');
  if (!inspection.candidates?.some(c=>c.type==='apply_invoice'&&c.visible&&!c.disabled)) {
    const product=await locateWorkflowProduct(page,mapping);
    const chat=product.productUrl ? await inspectWorkflowProductChat(context,page,mapping,product,invoiceConfig).catch(()=>({status:'manual_required',reason:'客服页面未能处理，请人工查看'})) : null;
    return result(chat?.status||'manual_required',chat?.reason||product.reason,{...chat,productUrl:product.productUrl||''});
  }
  let opened;
  try {
    opened = await clickFirstAction(context,page,'apply_invoice');
    const invoicePage = opened.page;
    const verification = await handleVerificationIfNeeded(invoicePage,'发票页面需要人工验证');
    if (verification.blocked) return result('manual_required',verification.reason||'需要人工验证',{finalUrl:invoicePage.url()});
    let current = await readWorkflowPage(invoicePage);
    if (current.kind === 'issued') {
      if (!current.candidates.some(c=>c.type==='download_invoice'&&c.visible&&!c.disabled)) return result('issued','页面显示已开票，但未找到下载入口',{invoiceStatus:'issued',finalUrl:invoicePage.url()});
      const downloaded = await downloadFirstInvoice(context,invoicePage,mapping,'download_invoice',inspection);
      return result(downloaded.status,downloaded.reason || (downloaded.status==='downloaded'?'已开票，发票文件已下载':'发票下载未完成'),{downloadResult:downloaded,invoiceStatus:'issued',finalUrl:invoicePage.url()});
    }
    if (current.kind === 'pending') return result('pending','页面显示开票中',{finalUrl:invoicePage.url()});
    if (current.kind !== 'form') return result('manual_required','发票页面状态不明确，需要人工确认',{finalUrl:invoicePage.url()});
    const submitted=await submitWorkflowForm(invoicePage,mapping,invoiceConfig);
    return result(submitted.status,submitted.reason,{...submitted,finalUrl:invoicePage.url()});
  } finally { if (opened?.openedPopup) await closePageQuietly(opened.page); }
}

async function executeRefresh(context,page,mapping,invoiceConfig){
  const inspection=await inspectOrder(page,mapping,invoiceConfig);
  mapping={...mapping,amount:mapping.amount||inspection.orderMeta?.amount||'',shopName:mapping.shopName||inspection.orderMeta?.shopName||''};
  const result=(status,reason,extra={})=>({...inspection,execution:buildExecutionMeta(inspection,{action:'refresh',status,reason,...extra})});
  if(inspection.status!=='ok')return result('manual_required','订单页面未能读取');
  if(inspection.orderMeta?.transactionStatus==='交易关闭'){
    if(isTimeoutClosedOrder(inspection.orderMeta))return result('closed_timeout','交易关闭 · 超时关闭，将从 Event 移除');
    return result('manual_required','交易关闭，关闭原因需人工核对，本次未申请或联系客服');
  }
  const hasEntry=inspection.candidates?.some(c=>c.type==='apply_invoice'&&c.visible&&!c.disabled);
  if(mapping.workflowStage==='system_requested'&&!hasEntry)return result('manual_required','未找到系统开票入口，请人工核对');
  if(!hasEntry||mapping.workflowStage==='contact_requested'){
    const detailShop=await readOrderDetailShop(page);
    if(detailShop){
      let shopPage;
      try{
        const link=page.locator('.trade-order-detail-shop-info [data-spm="shop_shopname"] a[href]').first();
        if(!await link.isVisible())return result('manual_required','订单详情中的店铺名称不可见，无法点击');
        console.log(`    [客服检查] 订单详情已识别店铺：${detailShop.shopName}，点击店铺名称`);
        const popup=page.waitForEvent('popup',{timeout:8000}).catch(()=>null);
        await link.click({timeout:8000});
        shopPage=await popup||page;
        await shopPage.waitForLoadState('domcontentloaded',{timeout:CONFIG.pageTimeout}).catch(()=>null);
        let actual;try{actual=new URL(shopPage.url())}catch{}
        if(!actual||actual.protocol!=='https:'||actual.hostname!==new URL(detailShop.shopUrl).hostname)return result('manual_required','点击店铺后页面地址未能确认，请人工核对');
        const chat=await inspectWorkflowProductChat(context,shopPage,mapping,detailShop,invoiceConfig,{readOnly:true,pageReady:true});
        return result(chat.status||'manual_required',chat.reason,{...chat});
      }catch(error){return result('manual_required','打开订单店铺或客服失败，请人工核对')}
      finally{if(shopPage&&shopPage!==page)await closePageQuietly(shopPage)}
    }
    console.log('    [客服检查] 订单详情未识别到店铺名称，尝试原有商品入口');
    const product=await locateWorkflowProduct(page,mapping);
    if(!product.verifiedNoInvoice)return result('manual_required',product.reason);
    if(detailShop?.shopName&&product.shopName&&detailShop.shopName!==product.shopName)return result('manual_required','订单详情与订单列表的店铺名称不一致，需人工核对');
    const combined={...product,shopUrl:detailShop?.shopUrl||'',shopName:detailShop?.shopName||product.shopName||''};
    if(!combined.productUrl&&!combined.shopUrl)return result('manual_required',product.reason);
    const chat=await inspectWorkflowProductChat(context,page,mapping,combined,invoiceConfig,{readOnly:true}).catch(()=>({status:'manual_required',reason:'客服页面未能读取'}));
    return result(chat.status||'manual_required',chat.reason,{...chat,productUrl:product.productUrl||''});
  }
  let opened;
  try{
    opened=await clickFirstAction(context,page,'apply_invoice');const invoicePage=opened.page;
    const verification=await handleVerificationIfNeeded(invoicePage,'查看开票进度时需要验证');
    if(verification.blocked)return result('manual_required',verification.reason||'需要人工验证',{finalUrl:invoicePage.url()});
    const current=await readWorkflowPage(invoicePage);
    if(current.kind==='pending')return result('pending','页面显示开票中',{finalUrl:invoicePage.url()});
    if(current.kind==='issued'){
      if(!current.candidates.some(c=>c.type==='download_invoice'&&c.visible&&!c.disabled))return result('issued','页面显示已开票，但未找到下载入口',{invoiceStatus:'issued',finalUrl:invoicePage.url()});
      const file=await downloadFirstInvoice(context,invoicePage,mapping,'download_invoice',inspection);
      return result(file.status,file.reason||(file.status==='downloaded'?'已开票，发票文件已下载':'发票下载未完成'),{downloadResult:file,invoiceStatus:'issued',finalUrl:invoicePage.url()});
    }
    if(current.kind==='form')return result('not_applied','页面显示申请表，尚未确认申请；本次未提交',{finalUrl:invoicePage.url()});
    return result('manual_required','开票页面状态不明确，未提交申请',{finalUrl:invoicePage.url()});
  }finally{if(opened?.openedPopup)await closePageQuietly(opened.page)}
}

function isTimeoutClosedOrder(meta){
 return meta?.transactionStatus==='交易关闭'&&meta?.closeReason==='超时关闭';
}

async function executeInvoiceAction(context, page, mapping, invoiceConfig) {
  if (cliArgs.action === 'refresh') return executeRefresh(context,page,mapping,invoiceConfig);
  if (cliArgs.action === 'workflow') return executeInvoiceWorkflow(context, page, mapping, invoiceConfig);
  if (cliArgs.action === 'chat') {
    return executeChatFollowup(context, page, mapping, invoiceConfig);
  }
  if (cliArgs.action === 'apply') {
    return executeApplyInvoice(context, page, mapping, invoiceConfig);
  }
  if (cliArgs.action === 'reissue') {
    return executeReissue(context, page, mapping, invoiceConfig);
  }
  if (cliArgs.action === 'download') {
    return executeDownloadInvoice(context, page, mapping, invoiceConfig);
  }

  const inspection = await inspectOrder(page, mapping, invoiceConfig);
  if (inspection.status === 'error') {
    return { ...inspection, execution: buildExecutionMeta(inspection, { action: 'all', status: 'error', reason: inspection.error, error: inspection.error }) };
  }
  if (inspection.pageClassification?.status === ORDER_STATES.NEED_MANUAL_SECURITY_CHECK) {
    return {
      ...inspection,
      execution: buildExecutionMeta(inspection, {
        action: 'manual_security_check',
        status: 'manual_required',
        state: ORDER_STATES.NEED_MANUAL_SECURITY_CHECK,
        reason: inspection.pageClassification.manualReason || '页面需要人工安全验证',
      }),
    };
  }

  const history = await inspectHistory(context, page);
  const rejectedDecision = classifyRejectedInvoiceHandling(inspection, history);
  if (rejectedDecision.action === 'manual_required') {
    return {
      ...inspection,
      history,
      rejectedDecision,
      execution: buildExecutionMeta(inspection, {
        action: 'manual_review',
        status: 'manual_required',
        reason: rejectedDecision.reason,
      }),
    };
  }
  if (rejectedDecision.action === 'contact_seller') {
    const contactResult = await contactSellerForInvoice(context, page, {
      ...mapping,
      rejectInfo: rejectedDecision.rejectInfo?.latest || null,
      contactReason: rejectedDecision.reason,
    }, invoiceConfig);
    return {
      ...inspection,
      history,
      rejectedDecision,
      execution: buildExecutionMeta(inspection, {
        action: 'contact_seller',
        status: contactResult.status === 'seller_contacted' ? 'seller_contacted' : 'manual_required',
        contactResult,
        finalUrl: contactResult.finalUrl || page.url(),
        reason: contactResult.reason || rejectedDecision.reason,
      }),
    };
  }
  if (rejectedDecision.action === 'modify_invoice' || shouldAutoModify(inspection, history)) {
    return executeModifyInvoice(context, page, mapping, invoiceConfig, inspection, history);
  }
  if (inspection.actionPlan?.action === 'manual_review') {
    return {
      ...inspection,
      history,
      execution: buildExecutionMeta(inspection, { action: 'manual_review', status: 'manual_required', reason: inspection.actionPlan.reason }),
    };
  }
  if (inspection.actionPlan?.action === 'contact_seller') {
    const contactResult = await contactSellerForInvoice(context, page, {
      ...mapping,
      contactReason: inspection.actionPlan.reason,
    }, invoiceConfig);
    return {
      ...inspection,
      history,
      execution: buildExecutionMeta(inspection, {
        action: 'contact_seller',
        status: contactResult.status === 'seller_contacted' ? 'seller_contacted' : 'manual_required',
        contactResult,
        finalUrl: contactResult.finalUrl || page.url(),
        reason: contactResult.reason || inspection.actionPlan.reason,
      }),
    };
  }
  if (inspection.actionPlan?.action === 'download_invoice' || inspection.actionPlan?.action === 'inspect_invoice') {
    return executeDownloadInvoice(context, page, mapping, invoiceConfig);
  }
  if (inspection.actionPlan?.action === 'reissue_invoice') {
    return executeReissue(context, page, mapping, invoiceConfig);
  }
  if (inspection.actionPlan?.action === 'apply_invoice') {
    return executeApplyInvoice(context, page, mapping, invoiceConfig);
  }
  return {
    ...inspection,
    execution: buildExecutionMeta(inspection, {
      action: 'all',
      status: 'skipped',
      reason: `没有可执行的开票/换开动作，当前计划为 ${inspection.actionPlan?.action || 'unknown'}`,
    }),
  };
}

function chooseRecommendedAction(invoiceInfo, candidates, pageClassification = null) {
  const visibleEnabled = candidates.filter(c => c.visible && !c.disabled);
  const byType = type => visibleEnabled.find(c => c.type === type);

  if (pageClassification?.status === ORDER_STATES.NEED_MANUAL_SECURITY_CHECK) {
    return { action: 'manual_review', confidence: 'high', reason: pageClassification.manualReason || '页面需要人工安全验证' };
  }

  if (pageClassification?.recommendedAction === 'contact_seller') {
    return { action: 'contact_seller', confidence: 'high', reason: pageClassification.rawPrompt || '页面提示需要联系商家处理' };
  }
  if (['wrong_title', 'wrong_tax_no', 'invoice_info_mismatch'].includes(pageClassification?.category)) {
    if (byType('modify_invoice')) return { action: 'modify_invoice', confidence: 'high', reason: pageClassification.rawPrompt || '发票信息不符合配置，发现修改申请入口' };
    if (byType('reissue_invoice')) return { action: 'reissue_invoice', confidence: 'high', reason: pageClassification.rawPrompt || '发票信息不符合配置，发现换开入口' };
    return { action: 'contact_seller', confidence: 'medium', reason: '发票信息不符合配置，但未发现修改/换开入口，改为联系商家' };
  }
  if (pageClassification?.recommendedAction === 'apply_invoice' && byType('apply_invoice')) {
    return { action: 'apply_invoice', confidence: 'high', reason: pageClassification.rawPrompt || '页面识别为可申请开票' };
  }
  if (pageClassification?.recommendedAction === 'download_invoice' && byType('download_invoice')) {
    return { action: 'download_invoice', confidence: 'high', reason: pageClassification.rawPrompt || '页面识别为可下载发票' };
  }

  if (invoiceInfo.invoiceType === 'wrong_company_title' && byType('modify_invoice')) {
    return { action: 'modify_invoice', confidence: 'high', reason: '发票抬头像税号，发现修改申请入口' };
  }
  if (invoiceInfo.invoiceType === 'wrong_company_title' && byType('reissue_invoice')) {
    return { action: 'reissue_invoice', confidence: 'high', reason: '发票抬头像税号，发现换开入口' };
  }
  if (invoiceInfo.invoiceType === 'wrong_company_title') {
    return { action: 'contact_seller', confidence: 'medium', reason: '发票抬头像税号，但未发现修改/换开入口，改为联系商家' };
  }
  if (invoiceInfo.invoiceType === 'personal' && byType('reissue_invoice')) {
    return { action: 'reissue_invoice', confidence: 'medium', reason: '个人发票且发现换开入口' };
  }
  if (invoiceInfo.invoiceType === 'no_invoice' && byType('apply_invoice')) {
    return { action: 'apply_invoice', confidence: 'medium', reason: '未开票且发现申请开票入口' };
  }
  if (byType('download_invoice')) {
    return { action: 'download_invoice', confidence: 'medium', reason: '发现可见下载发票入口' };
  }
  if (byType('view_invoice')) {
    return { action: 'inspect_invoice', confidence: 'low', reason: '发现查看发票入口，需要进一步打开确认' };
  }
  if (visibleEnabled.length > 0) {
    return { action: 'manual_review', confidence: 'low', reason: '发现发票相关入口，但无法安全判断动作' };
  }
  return { action: 'no_action', confidence: 'none', reason: '未发现可操作发票入口' };
}

async function inspectOrder(page, mapping, invoiceConfig = {}) {
  try {
    await gotoWithRetry(page, mapping.url, { timeout: CONFIG.pageTimeout, maxRetries: 3 });
    const wasLoginPage=isLoginOrVerifyUrl(page.url());
    const verification=await handleVerificationIfNeeded(page,'打开订单时需要登录或验证');
    if(verification.blocked)throw new Error(`WORKFLOW_AUTH_REQUIRED: ${verification.reason||'登录或验证未完成'}`);
    if(verification.parseResult?.hasVerificationError || wasLoginPage){
      await gotoWithRetry(page,mapping.url,{timeout:CONFIG.pageTimeout,maxRetries:3});
      if(isLoginOrVerifyUrl(page.url()))throw new Error('WORKFLOW_AUTH_REQUIRED: 登录后仍无法打开订单，请检查淘宝账号');
    }
    await waitForContentReady(page, {
      keywords: ACTION_KEYWORDS.flatMap(g => g.words).concat(VERIFICATION_TEXT_MARKERS),
      timeout: CONFIG.detailWaitTimeout,
    });
    await sleep(800);
    try { await page.click('text=知道了', { timeout: 1500 }); } catch {}

    const bodyText = await page.evaluate(() => document.body.innerText || '');
    const pageTitle = await page.title().catch(() => '');
    const invoiceInfo = classifyInvoiceText(bodyText);
    const orderMeta = await page.evaluate(() => {
      const bodyText = document.body?.innerText || '';
      const amountMatch = bodyText.match(/实付款[\s\S]{0,20}?￥\s*([0-9.,]+)/) || bodyText.match(/发票金额[\s\S]{0,12}?￥\s*([0-9.,]+)/);
      const shopName = bodyText.match(/([\u4e00-\u9fa5A-Za-z0-9_-]{2,40}(旗舰店|专卖店|企业店|店铺))/)?.[1] || '';
      return {
        amount: amountMatch?.[1] ? amountMatch[1].replace(/,/g, '') : '',
        shopName: shopName.trim(),
        transactionStatus:(document.querySelector('#headerContainer > div > span[class*="content--"]')?.textContent||'').trim(),
        closeReason:(document.querySelector('#headerContainer > div > span[class*="subContent--"]')?.textContent||'').trim(),
      };
    }).catch(() => ({ amount: '', shopName: '' }));
    const candidates = await collectActionCandidates(page);
    const normalizedCandidates = candidates.map(candidate => ({
      ...candidate,
      href: normalizeUrl(candidate.href, page.url()),
    }));
    const pageClassification = classifyInvoicePage({
      text: bodyText,
      url: page.url(),
      title: pageTitle,
      candidates: normalizedCandidates,
      invoiceInfo,
    }, { invoiceConfig });
    const actionPlan = chooseRecommendedAction(invoiceInfo, normalizedCandidates, pageClassification);
    const state = deriveStateFromClassification(pageClassification, ORDER_STATES.CHECKING);

    return {
      status: 'ok',
      ...mapping,
      detailUrl: page.url(),
      pageTitle,
      detailBodyText: bodyText,
      orderMeta,
      invoiceInfo,
      pageClassification,
      state,
      stateTrace: buildInspectionTrace(state, pageClassification, actionPlan.action),
      actionPlan,
      candidates: normalizedCandidates,
      checkedAt: new Date().toISOString(),
    };
  } catch (e) {
    if (e.message?.includes('WORKFLOW_AUTH_REQUIRED')) throw e;
    const snapshot = await collectPageSnapshot(page, mapping, 'inspect-error', invoiceConfig, { saveArtifacts: true }).catch(() => null);
    const pageClassification = snapshot
      ? classifyInvoicePage(snapshot, { invoiceConfig })
      : classifyInvoicePage({ text: e.message || '' }, { invoiceConfig });
    return {
      status: 'error',
      ...mapping,
      error: e.message,
      pageClassification,
      state: ORDER_STATES.FAILED_RETRYABLE,
      stateTrace: buildInspectionTrace(ORDER_STATES.FAILED_RETRYABLE, pageClassification, 'inspect_error'),
      artifacts: snapshot?.artifacts || {},
      checkedAt: new Date().toISOString(),
    };
  }
}

function shouldSkipExisting(result) {
  if (!result) return false;
  if (cliArgs.action === 'refresh') return false;
  if (cliArgs.action === 'chat') {
    return ['downloaded', 'file_exists'].includes(result.execution?.status);
  }
  if (artifactLooksLikeWrongTitle(result)) return false;
  if (cliArgs.execute) {
    if (result.execution?.status === 'skipped') return false;
    if (cliArgs.action === 'download') return ['downloaded', 'file_exists'].includes(result.execution?.status);
    if (cliArgs.action === 'apply' && ['downloaded', 'file_exists'].includes(result.execution?.status)) return true;
    return TERMINAL_EXECUTION_STATUS.has(result.execution?.status) || isTerminalState(result.state || result.execution?.state);
  }
  if (RETRYABLE_STATUS.has(result.status)) return false;
  if (cliArgs.retryUncertain && UNCERTAIN_STATUS.has(result.actionPlan?.action)) return false;
  return true;
}

function seedTerminalResultsFromArtifacts(resultsById) {
  for (const [bizOrderId, artifact] of collectTerminalResultsFromArtifacts()) {
    if (!bizOrderId || resultsById[bizOrderId]) continue;
    resultsById[bizOrderId] = artifact;
  }
}

function buildSummary(results) {
  const summary = {
    total: results.length,
    downloadInvoice: 0,
    applyInvoice: 0,
    reissueInvoice: 0,
    inspectInvoice: 0,
    manualReview: 0,
    noAction: 0,
    errors: 0,
    mutatingCandidates: 0,
    submitted: 0,
    downloaded: 0,
    fileExists: 0,
    pending: 0,
    blocked: 0,
    skipped: 0,
    closedTimeout: 0,
    expiredDeadline: 0,
    sellerContacted: 0,
    manualRequired: 0,
    needManualSecurityCheck: 0,
    failedRetryable: 0,
    failedFinal: 0,
    chatDownloaded: 0,
    chatWaitingReply: 0,
    chatManualRequired: 0,
  };

  for (const result of results) {
    if (result.status === 'error') {
      summary.errors++;
      continue;
    }
    const action = result.actionPlan?.action;
    if (action === 'download_invoice') summary.downloadInvoice++;
    else if (action === 'apply_invoice') summary.applyInvoice++;
    else if (action === 'reissue_invoice') summary.reissueInvoice++;
    else if (action === 'inspect_invoice') summary.inspectInvoice++;
    else if (action === 'manual_review') summary.manualReview++;
    else summary.noAction++;

    if (result.candidates?.some(candidate => MUTATING_ACTIONS.has(candidate.type))) {
      summary.mutatingCandidates++;
    }
    if (result.execution?.status === 'submitted') summary.submitted++;
    if (result.execution?.status === 'downloaded') summary.downloaded++;
    if (result.execution?.status === 'file_exists') {
      summary.fileExists++;
      summary.downloaded++;
    }
    if (result.execution?.status === 'pending') summary.pending++;
    if (result.execution?.status === 'closed_timeout') summary.closedTimeout++;
    if (result.execution?.status === 'blocked') summary.blocked++;
    if (result.execution?.status === 'skipped') summary.skipped++;
    if (result.execution?.status === 'expired_deadline') summary.expiredDeadline++;
    if (result.execution?.status === 'seller_contacted') summary.sellerContacted++;
    if (result.execution?.status === 'manual_required') summary.manualRequired++;
    if (result.execution?.status === 'chat_waiting_reply') summary.chatWaitingReply++;
    if (result.execution?.action === 'chat_followup' && ['downloaded', 'file_exists'].includes(result.execution?.status)) summary.chatDownloaded++;
    if (result.execution?.action === 'chat_followup' && result.execution?.status === 'manual_required') summary.chatManualRequired++;
    const state = result.state || result.execution?.state;
    if (state === ORDER_STATES.NEED_MANUAL_SECURITY_CHECK) summary.needManualSecurityCheck++;
    if (state === ORDER_STATES.FAILED_RETRYABLE) summary.failedRetryable++;
    if (state === ORDER_STATES.FAILED_FINAL) summary.failedFinal++;
  }
  return summary;
}

function slimResultForProgress(result) {
  if (!result || typeof result !== 'object') return result;
  const slim = { ...result };
  delete slim.detailBodyText;
  delete slim.history;
  if (slim.artifacts) {
    slim.artifacts = {
      screenshotPath: slim.artifacts.screenshotPath || '',
      htmlSnapshotPath: slim.artifacts.htmlSnapshotPath || '',
    };
  }
  return slim;
}

function loadManualOrderMappings(fileName) {
  if (!fileName) return [];
  const data = JSON.parse(fs.readFileSync(path.resolve(fileName), 'utf8'));
  if (!Array.isArray(data)) throw new Error('手动补录订单映射文件格式无效');
  return data.map(item => {
    const bizOrderId = String(item?.bizOrderId || '').trim();
    if (!/^\d{8,30}$/.test(bizOrderId)) return null;
    const platform = item.platform === 'tmall' ? 'tmall' : 'taobao';
    const url = platform === 'tmall'
      ? `https://trade.tmall.com/detail/orderDetail.htm?bizOrderId=${bizOrderId}`
      : `https://trade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id=${bizOrderId}`;
    return {bizOrderId,platform,orderDate:String(item.orderDate||''),amount:String(item.amount||''),shopName:String(item.shopName||''),url,detailUrl:url,sourceTag:'event_manual_order'};
  }).filter(Boolean);
}

async function main() {
  console.log('='.repeat(60));
  console.log(cliArgs.action==='refresh'?'🧾 淘宝订单发票状态检查':'🧾 淘宝发票动作 dry-run 计划生成器');
  console.log('='.repeat(60));

  if (cliArgs.execute && cliArgs.confirm !== CONFIRM_TEXT) {
    throw new Error(`执行模式需要 --confirm=${CONFIRM_TEXT}`);
  }
  if(cliArgs.applyChatCard&&(!cliArgs.execute||cliArgs.action!=='refresh'))throw new Error('客服申请卡片仅支持发票状态检查');
  if (cliArgs.execute && !EXECUTABLE_ACTIONS.has(cliArgs.action)) {
    throw new Error(`执行模式目前只支持 --action=apply、reissue、download、chat、all、workflow 或 refresh`);
  }
  const invoiceConfig = cliArgs.execute ? loadInvoiceConfig() : null;

  const progress = cliArgs.fresh ? null : loadProgress();
  let mappings = progress?.mappings || null;
  const resultsById = progress?.resultsById && typeof progress.resultsById === 'object'
    ? progress.resultsById
    : {};
  const artifactMappings = collectMappingsFromArtifacts();
  if (!cliArgs.fresh && cliArgs.action !== 'refresh') {
    seedTerminalResultsFromArtifacts(resultsById);
  }
  if (cliArgs.execute && cliArgs.action !== 'refresh') {
    seedContactedLedgerFromArtifacts();
    seedModifiedLedgerFromArtifacts();
  }
  const overdueCutoffByMonth = new Map();
  for (const existing of Object.values(resultsById)) {
    if (existing?.execution?.status !== 'expired_deadline') continue;
    const monthKey = getMonthKey(existing.orderDate);
    if (!monthKey || !existing.orderDate) continue;
    const current = overdueCutoffByMonth.get(monthKey);
    if (!current || existing.orderDate > current) {
      overdueCutoffByMonth.set(monthKey, existing.orderDate);
    }
  }

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    acceptDownloads: true,
    slowMo: 150,
  });

  const page = context.pages()[0] || await context.newPage();
  await closeAuxiliaryPages(context, page);

  try {
    await ensureLoggedIn(page);

    if (cliArgs.action === 'chat' && cliArgs.orderIds.length === 0) {
      const contactedLedger = loadContactedLedger();
      const mappingById = new Map();
      for (const record of Object.values(contactedLedger.orders || {})) {
        if (!record?.orderId) continue;
        mergeMappingCandidate(mappingById, {
          bizOrderId: String(record.orderId),
          platform: 'taobao',
          orderDate: record.orderDate || '',
          amount: record.amount || '',
          shopName: record.shopName || '',
          url: record.invoiceUrl || buildInvoiceDetailUrl(record.orderId),
          detailUrl: record.invoiceUrl || '',
          invoiceUrl: record.invoiceUrl || buildInvoiceDetailUrl(record.orderId),
          sourceTag: 'contacted_ledger_chat_followup',
        });
      }
      mappings = [...mappingById.values()];
      console.log(`\n💬 聊天回访模式：从联系商家台账读取 ${mappings.length} 个订单`);
    }

    if (!mappings && cliArgs.orderIds.length > 0) {
      const prioritized = cliArgs.orderIds
        .map(orderId => artifactMappings.get(orderId))
        .filter(Boolean);
      const mappingById = new Map();
      for (const mapping of prioritized) {
        mergeMappingCandidate(mappingById, mapping);
      }
      const missingFromArtifacts = cliArgs.orderIds.filter(orderId => !mappingById.has(orderId));
      for (const orderId of missingFromArtifacts) {
        const contactedRecord = getContactedLedgerRecord(orderId);
        mergeMappingCandidate(mappingById, contactedRecord ? {
          ...buildFallbackMappingFromOrderId(orderId),
          orderDate: contactedRecord.orderDate || '',
          amount: contactedRecord.amount || '',
          shopName: contactedRecord.shopName || '',
          invoiceUrl: contactedRecord.invoiceUrl || buildInvoiceDetailUrl(orderId),
          url: contactedRecord.invoiceUrl || buildInvoiceDetailUrl(orderId),
          sourceTag: 'contacted_ledger_chat_followup',
        } : buildFallbackMappingFromOrderId(orderId));
      }
      mappings = cliArgs.orderIds.map(orderId => mappingById.get(orderId)).filter(Boolean);
      if (missingFromArtifacts.length > 0) {
        console.log(`\n⚠️  历史映射中缺少部分指定订单，已改用发票详情页直达: ${missingFromArtifacts.join(', ')}`);
      } else {
        console.log(`\n🎯 定向模式：已从历史结果恢复指定订单 ${mappings.length} 个，无需先全量翻页`);
      }
    }

    if (!mappings) {
      mappings = await extractBizOrderIds(page);
    }
    const manualOrderMappings=loadManualOrderMappings(cliArgs.manualOrderMappingsFile);
    if (cliArgs.action==='refresh' && cliArgs.fresh) {
      const before=mappings.length;
      mappings=removeExcludedMappings(mappings,cliArgs.excludedOrderIds);
      if(before!==mappings.length)console.log(`    已跳过 ${before-mappings.length} 笔在此 Event 中手动删除的订单`);
      const presentIds=new Set(mappings.map(mapping=>String(mapping.bizOrderId)));
      const excludedIds=new Set(cliArgs.excludedOrderIds.map(String));
      const manualToAppend=manualOrderMappings.filter(mapping=>!presentIds.has(String(mapping.bizOrderId))&&!excludedIds.has(String(mapping.bizOrderId)));
      if(manualToAppend.length)console.log(`    另加入 ${manualToAppend.length} 笔 Event 手动补录订单，不受日期范围筛选`);
      mappings.push(...manualToAppend);
      mappings=sortByEventOrder(mappings,cliArgs.eventOrderIds);
      const contact=new Set(cliArgs.stageContactIds),system=new Set(cliArgs.stageSystemIds),manual=new Set(cliArgs.stageManualIds);
      mappings=mappings.map(mapping=>({...mapping,workflowStage:contact.has(mapping.bizOrderId)?'contact_requested':system.has(mapping.bizOrderId)?'system_requested':manual.has(mapping.bizOrderId)?'manual':mapping.workflowStage}));
    }
    if (cliArgs.orderIds.length > 0) {
      const wanted = new Set(cliArgs.orderIds);
      const mappingById = new Map();
      for (const mapping of mappings) {
        mergeMappingCandidate(mappingById, mapping);
      }
      for (const orderId of cliArgs.orderIds) {
        const artifactMapping = artifactMappings.get(orderId);
        if (artifactMapping) {
          mergeMappingCandidate(mappingById, artifactMapping);
        }
      }
      const filtered = cliArgs.orderIds
        .map(orderId => mappingById.get(orderId))
        .filter(Boolean);
      const missing = cliArgs.orderIds.filter(orderId => !mappingById.has(orderId));
      if (missing.length > 0) {
        for (const orderId of missing) {
          const fallback = buildFallbackMappingFromOrderId(orderId);
          mergeMappingCandidate(mappingById, fallback);
          filtered.push(fallback);
        }
        console.log(`\n⚠️  指定订单未在历史/当前列表中出现，已改用发票详情页直达: ${missing.join(', ')}`);
      }
      mappings = filtered;
      console.log(`\n🎯 定向模式：仅处理指定订单 ${mappings.length} 个`);
    }
    if (cliArgs.test && cliArgs.test > 0) {
      console.log(`\n⚠️  测试模式：仅处理前 ${cliArgs.test} 个订单`);
      mappings = mappings.slice(0, cliArgs.test);
    }

    console.log('\n' + '='.repeat(60));
    console.log(cliArgs.action==='refresh'?`🚀 开始检查订单发票状态（共 ${mappings.length} 个）`:`🚀 开始生成动作计划（共 ${mappings.length} 个）`);
    console.log('='.repeat(60));

    let refreshStage='',skippedSavedPdf=0;
    const savedPdfIds=new Set(cliArgs.skipSavedIds);
    for (let i = 0; i < mappings.length; i++) {
      const mapping = mappings[i];
      if(cliArgs.action==='refresh' && mapping.workflowStage!==refreshStage){
        refreshStage=mapping.workflowStage;
        console.log(`\n📌 检查阶段：${{pending:'开票中',entry:'有开票入口，状态待确认',contact:'客服聊天'}[refreshStage]||'待确认'}`);
      }
      const needsClosedCheck=cliArgs.fresh&&(!mapping.listTransactionStatus||mapping.listTransactionStatus==='交易关闭');
      if(shouldSkipSavedPdf(mapping,savedPdfIds,cliArgs.execute,cliArgs.action)&&!needsClosedCheck){
        skippedSavedPdf++;
        console.log(`  [${i + 1}/${mappings.length}] ${mapping.bizOrderId} → 已有保存记录，跳过重新检查`);
        continue;
      }
      if (shouldSkipExisting(resultsById[mapping.bizOrderId])) {
        console.log(`  [${i + 1}/${mappings.length}] 跳过已检查 ${mapping.bizOrderId}`);
        continue;
      }

      const monthKey = getMonthKey(mapping.orderDate);
      const overdueCutoff = monthKey ? overdueCutoffByMonth.get(monthKey) : '';
      if (cliArgs.execute && overdueCutoff && mapping.orderDate && mapping.orderDate <= overdueCutoff) {
        const skippedResult = buildExpiredDeadlineSkipResult(mapping, overdueCutoff);
        resultsById[mapping.bizOrderId] = finalizeOrderResult(skippedResult);
        console.log(`  [${i + 1}/${mappings.length}] ${mapping.bizOrderId} (${mapping.platform}) → apply_invoice / expired_deadline | ${skippedResult.execution.reason}`);
        saveJsonAtomic(PROGRESS_FILE, {
          version: '0.1.0',
          dryRun: !cliArgs.execute,
          action: cliArgs.action,
          mappings,
          resultsById,
          updatedAt: new Date().toISOString(),
        });
        continue;
      }

      let result;
      try {
        const runOrder = () => cliArgs.execute
          ? executeInvoiceAction(context, page, mapping, invoiceConfig)
          : inspectOrder(page, mapping, invoiceConfig || {});
        // Do not race a live submission against a timer: the losing promise would
        // continue using the browser while the next order starts.
        result = ['workflow','refresh'].includes(cliArgs.action) ? await runOrder() : await withOrderTimeout(runOrder);
      } catch (orderError) {
        if (orderError.message && orderError.message.includes('ORDER_TIMEOUT')) {
          log('warn', mapping.bizOrderId, 'timeout', '单订单处理超时，跳过');
          result = {
            status: 'error',
            ...mapping,
            error: orderError.message,
            state: ORDER_STATES.FAILED_RETRYABLE,
            checkedAt: new Date().toISOString(),
          };
        } else {
          throw orderError;
        }
      } finally {
        await closeAuxiliaryPages(context, page);
      }
      result = finalizeOrderResult(result);
      if (shouldCaptureResultSnapshot(result)) {
        const snapshot = await collectPageSnapshot(
          page,
          mapping,
          `final-${result.state || result.execution?.status || result.status}`,
          invoiceConfig || {},
          {
            saveArtifacts: true,
            historyText: result.history?.historyText || '',
            invoiceInfo: result.invoiceInfo || null,
            candidates: result.candidates || null,
          }
        ).catch(() => null);
        if (snapshot?.artifacts) {
          result.artifacts = {
            ...(result.artifacts || {}),
            ...snapshot.artifacts,
          };
        }
      }
      resultsById[mapping.bizOrderId] = result;

      if (result.execution?.status === 'expired_deadline' && monthKey && mapping.orderDate) {
        const currentCutoff = overdueCutoffByMonth.get(monthKey);
        if (!currentCutoff || mapping.orderDate > currentCutoff) {
          overdueCutoffByMonth.set(monthKey, mapping.orderDate);
        }
      }

      const action = result.actionPlan?.action || result.status;
      const statusLabels={closed_timeout:'交易关闭 · 超时关闭',downloaded:'已开票 · PDF 已保存',file_exists:'已开票 · PDF 已保存',pending:'开票中',issued:'已开票 · 文件待保存',not_applied:'未申请 · 待处理',chat_checked:'客服已查看',manual_required:'需人工核对'};
      const execution = result.execution ? ` / ${statusLabels[result.execution.status]||result.execution.status}` : '';
      const reason = result.execution?.reason || result.actionPlan?.reason || result.error || '';
      console.log(`  [${i + 1}/${mappings.length}] ${mapping.bizOrderId} (${mapping.platform}) → ${action}${execution} | ${reason}`);

      saveJsonAtomic(PROGRESS_FILE, {
        version: '0.1.0',
        dryRun: !cliArgs.execute,
        action: cliArgs.action,
        mappings,
        resultsById: Object.fromEntries(
          Object.entries(resultsById).map(([k, v]) => [k, slimResultForProgress(v)])
        ),
        updatedAt: new Date().toISOString(),
      });

      await randomDelay();
      rateLimiter.recordSuccess();
    }

    const results = mappings.map(mapping => resultsById[mapping.bizOrderId]).filter(Boolean);
    const summary = buildSummary(results);
    summary.skippedSavedPdf=skippedSavedPdf;
    const output = {
      version: '0.1.0',
      dryRun: !cliArgs.execute,
      action: cliArgs.action,
      generatedAt: new Date().toISOString(),
      summary,
      results,
    };
    saveJsonAtomic(OUTPUT_FILE, output);
    saveResultsCsv(OUTPUT_CSV_FILE, results);

    console.log('\n' + '='.repeat(60));
    console.log(cliArgs.execute ? '📊 执行完成' : '📊 dry-run 计划完成');
    console.log('='.repeat(60));
    console.log(`  可下载：${summary.downloadInvoice}`);
    console.log(`  可申请开票：${summary.applyInvoice}`);
    console.log(`  可换开：${summary.reissueInvoice}`);
    console.log(`  可查看后确认：${summary.inspectInvoice}`);
    console.log(`  需人工复核：${summary.manualReview}`);
    console.log(`  无动作：${summary.noAction}`);
    console.log(`  已保存 PDF，跳过检查：${summary.skippedSavedPdf}`);
    console.log(`  识别到超时关闭：${summary.closedTimeout}`);
    console.log(`  错误：${summary.errors}`);
    if (cliArgs.execute) {
      console.log(`  已提交：${summary.submitted}`);
      console.log(`  已下载：${summary.downloaded}`);
      console.log(`  复用已下载文件：${summary.fileExists}`);
      console.log(`  处理中：${summary.pending}`);
      console.log(`  已阻止：${summary.blocked}`);
      console.log(`  已跳过：${summary.skipped}`);
      console.log(`  超期开票：${summary.expiredDeadline}`);
      console.log(`  已联系商家：${summary.sellerContacted}`);
      console.log(`  需人工处理：${summary.manualRequired}`);
      console.log(`  待人工安全验证：${summary.needManualSecurityCheck}`);
      console.log(`  可重试失败：${summary.failedRetryable}`);
      console.log(`  最终失败：${summary.failedFinal}`);
      if (cliArgs.action === 'chat') {
        console.log(`  聊天回访下载：${summary.chatDownloaded}`);
        console.log(`  聊天等待回复：${summary.chatWaitingReply}`);
        console.log(`  聊天需人工确认：${summary.chatManualRequired}`);
      }
    }
    console.log(`\n💾 结果文件: ${OUTPUT_FILE}`);
    console.log(`💾 结果表: ${OUTPUT_CSV_FILE}`);

    if (cliArgs.closeOnFinish) {
      await context.close();
      console.log('\n✅ 完成，浏览器已关闭');
    } else {
      console.log('\n✅ 浏览器保持打开，手动关闭即可');
      await new Promise(() => {});
    }
  } catch (e) {
    await context.close().catch(() => null);
    throw e;
  }
}

if (require.main === module) {
  main().catch(e => {
    console.error('❌ 致命错误:', e.message);
    process.exit(1);
  });
}

module.exports = {
  classifyChatReply,
  isLikelyInvoiceHref,
  clickInvoiceTitleSuggestion,
  validateFilledInvoiceForm,
  workflowReviewUrl,
  pauseForManualVerification,
  inspectWorkflowChat,
  findShopCustomerButton,
  readOrderDetailShop,
  isTimeoutClosedOrder,
  clickNextOrderPage,
  waitForOrderPageChange,
  shouldStopScanningPage,
  shouldSkipSavedPdf,
  removeExcludedMappings,
  sortByEventOrder,
};
