# 票夹 · Taobao Invoice Workspace

[简体中文](README.md) · [English](README.en.md)

票夹是运行在个人电脑上的淘宝发票工作台。网页界面按 Event 管理订单和附件；订单扫描与淘宝页面操作由随项目提供的 Helper 执行。支持 **macOS 和 Windows**，每位使用者各自在本机登录并保存自己的数据。它不是云端共享服务。

> **扫描会产生真实操作。**扫描及单笔“检查此订单”可能填写并提交商家发来的发票申请卡片，但不会发送客服聊天消息。系统申请入口的申请需通过界面确认。开始前请阅读[新手指南](docs/zh-CN/beginner-guide.md)。

## 快速开始

1. 安装 [Node.js 22.13 或更新版本](https://nodejs.org/)。
2. 下载并解压本仓库，双击 `Setup.command`（macOS）或 `Setup.bat`（Windows）。
3. 双击 `Start.command`（macOS）或 `Start.bat`（Windows），然后打开 <http://127.0.0.1:4318>。
4. 进入左侧“开票资料”，填写并保存发票抬头、税号、邮箱等信息；不需要手动编辑 JSON。
5. 淘宝登录和安全验证在弹出的本地浏览器中手动完成。

详细步骤见[中文新手指南](docs/zh-CN/beginner-guide.md)或[English Beginner Guide](docs/en/beginner-guide.md)。

## 功能概览

- 新建 Event 时使用默认开票资料；需要不同抬头或税号时，可在编辑 Event 中单独设置，该 Event 后续操作使用自己的资料。
- 导出 ZIP 时尝试从发票 PDF 或图片读取项目名称和票面“价税合计”；多项目发票只用第一条项目明细。文件名格式为 `Event序号_项目名称_票面金额.扩展名`；识别失败时分别使用 `NoRead` 和“金额未识别”，不会用订单金额代替票面金额。
- 更多功能及操作说明见中英文[详细使用指南](docs/zh-CN/user-guide.md)和[开发指南](docs/zh-CN/developer-guide.md)。

## 文档

- [新手指南（中文）](docs/zh-CN/beginner-guide.md) · [English Beginner Guide](docs/en/beginner-guide.md)
- [详细使用指南（中文）](docs/zh-CN/user-guide.md) · [Detailed User Guide](docs/en/user-guide.md)
- [开发指南（中文）](docs/zh-CN/developer-guide.md) · [English Developer Guide](docs/en/developer-guide.md)

## 隐私与数据

Event 数据、配置、浏览器登录会话、发票、快照和任务文件保存在使用者自己的电脑中，不会随 GitHub 下载或上传。不要把这些本地数据提交到仓库。仓库仅分发代码，不提供账号、淘宝授权或多人数据同步。

## 项目状态

本项目用于本地自动化和个人资料整理。淘宝页面结构可能改变，识别结果需人工核对。扫描范围、发票金额匹配和 PDF 文件本身都不能证明发票真伪或完整性。使用前请确认平台规则及账号所有者授权。

[简体中文](README.md) · [English](README.en.md)
