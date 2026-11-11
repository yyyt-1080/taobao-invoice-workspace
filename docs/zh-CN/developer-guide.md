# 票夹开发指南

[中文](developer-guide.md) · [English](../en/developer-guide.md) · [项目首页](../../README.md)

## 架构

- `ui/`：静态前端、HTTP 服务、Event 状态、文件查看与 ZIP 导出。
- `engine/`：Playwright 淘宝自动化、订单分类、客服卡片处理和发票金额核对。
- `ui/.data/events.json`：本地 Event/订单数据。
- `engine/invoice-config.json`：用户本机开票配置。
- `engine/.event-configs/<eventId>.json`：服务端按 Event 的默认资料与 Event 覆盖项生成的临时配置；已加入 `.gitignore`，不可提交。
- `engine/.playwright-browser/`、`engine/downloads/`、`engine/snapshots/`：本机登录会话和运行文件。

Event 状态保存使用递增的 `revision` 做乐观并发校验，并串行写入。客户端提交的版本落后时，服务端返回 `409`，前端重新载入最新状态，避免旧标签页整份覆盖较新的订单编辑。该机制保护同一本机应用中的并发写入，不提供多人协作或跨设备同步。

根目录 `package.json` 管理共享依赖；`ui/server.mjs` 默认调用相邻的 `engine/`，也可以通过 `INVOICE_HELPER_DIR` 指向开发用 Helper 目录。服务绑定 `127.0.0.1`，没有认证或多人隔离，不可直接开放到局域网或公网。

## 环境与命令

- Node.js 22.13 或更新版本；macOS 和 Windows。
- `npm install` 安装 Playwright 与 PDF.js。
- `npx playwright install chromium` 安装自动化使用的 Chromium。
- `npm start` 启动 UI，访问 `http://127.0.0.1:4318`。
- Windows 脚本通过 PowerShell 检查 Node、安装依赖和 Chromium，并只在不存在时从样例创建本机配置。

PDF 金额提取使用 PDF.js 的 Node API，避免依赖 macOS Swift/PDFKit 或外部 `pdftotext`。扫描只使用本机临时/下载目录，不上传 PDF 内容。[PDF.js Node 示例](https://github.com/mozilla/pdf.js/blob/master/examples/node/getinfo.mjs)

## Event 开票资料与 ZIP 文件名

- `ui/public/app.js` 在新建 Event 时把“开票资料”中的默认值填入 Event；用户可在编辑 Event 时单独调整资料。
- `ui/server.mjs` 将 Event 配置与本机默认配置合并，写入 `engine/.event-configs/`，再用 Helper 的 `--config` 参数执行；申请确认时会重新核对同一份 Event 配置。
- PDF 文本由 `engine/pdf-invoice-amount.js` 和 PDF.js 提取；PNG/JPG 由 `ui/ocr-invoice-image.swift`（macOS）、`ui/ocr-invoice-image.ps1`（Windows）识别，Windows 可回退到 Tesseract。
- `ui/invoice-export-name.mjs` 从识别文本提取第一条项目明细及票面“价税合计”。失败时分别用 `NoRead` 和“金额未识别”，不使用订单页面金额。测试覆盖第一条明细选择与端口错误提示。
- 运行 UI 测试：`npm run test:ui`。

## 任务流程与副作用

- UI 的 Event 扫描由服务端生成带 Event 顺序、已保存发票跳过列表、手动补录和排除订单的 Helper 参数，然后启动 `invoice-actions.js --action=refresh`。
- 扫描会检查订单详情、发票状态及客服最近消息；已有已开票附件会按当前状态规则跳过。
- 扫描命令会启用 `--apply-chat-card`。发现客服发来的申请卡片时，流程会尝试填写和提交；不会发送聊天消息。普通系统申请表不由批量扫描提交。
- 单笔“检查此订单”也会启用客服卡片申请处理；批量“检查开票进度”则只读取卡片。
- `--action=apply` 和 `--action=download` 由 UI 确认后启动。不要在未核对提示和行为时更改确认参数。
- 结果经任务轮询合并进 Event 状态。文件通过 PDF/JPEG/PNG 格式与路径检查后由本机服务提供读取。

修改涉及真实淘宝交互时应先检查动作分支、用户确认点和安全验证分支。不得为测试提交真实申请或发送消息；如需真实账号人工验证，使用用户明确授权的测试订单，并先说明可能的副作用。

## 跨平台维护

- 用 `path.join`、`path.resolve` 和 Node API 处理路径；不要写本机绝对路径。
- 浏览器快捷键须区分 macOS (`Meta`) 与 Windows (`Control`)；启动、终止进程和打开浏览器也需在两个系统验证。
- Setup/Start 脚本改动后分别在干净 macOS 与 Windows 环境验证，确保空配置不会覆盖已有配置。
- PDF.js 解析版式可能不同于 `pdftotext`；修改金额提取时须使用无个人数据的合成 PDF 验证税额/价税合计附近的文本布局。金额不匹配时保留 PDF，状态仍需人工确认。
- `.gitignore` 必须覆盖配置、浏览器会话、Event 数据、下载、快照、任务结果、日志和依赖目录。提交前查看 `git status` 和待提交文件内容。

## 文档与语言

根 README 与中英文用户/开发指南互相链接。程序界面首版为中文。更新行为时同时检查两个语言版本，确保扫描是否提交卡片、文件保存规则和权限说明一致。

订单工作台以五个状态颜色按钮筛选对应状态；按钮颜色通过 CSS 状态变量与状态标签共用配色。发票库不再作为独立导航或页面，文件从订单行和订单详情进入。订单表覆盖提示需明确说明完整性未知，并引导用户核对数量、手动补录。

## 发布流程

1. 在新提交中只包含程序源码、安装/启动脚本、示例配置、文档和必要许可文件。
2. 确认根 README 的快速开始与脚本名称一致。
3. 核对 `.gitignore` 和待发布差异，搜索个人订单号、邮箱、税号、Cookie、PDF/PNG/JPG、聊天 HTML、日志及本机路径。
4. 在干净 macOS 和 Windows 用户账户上按使用指南安装。仅使用合成数据做基本 UI/文件核验；禁止无授权地触发淘宝外部操作。
5. 发布到私有 GitHub 仓库，邀请 reviewer；确定 UI 代码许可与发布范围后再考虑改为公开。

Helper 源码的 MIT 许可保留在 `engine/LICENSE`。当前根项目无单独许可声明，不能自行把所有 UI 代码标注为 MIT。
