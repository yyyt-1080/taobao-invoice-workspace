# 票夹新手指南（Mac 与 Windows）

[中文](beginner-guide.md) · [English](../en/beginner-guide.md) · [项目首页](../../README.md)

本指南适合第一次使用电脑本地程序的人。按你的电脑选择 Mac 或 Windows 部分。首次安装完成后，日常只需启动票夹，不必重复安装 Node.js、依赖或浏览器。

> **先了解扫描会做什么：**扫描会读取淘宝订单页面，并可能下载发票；如果客服发来发票申请卡片，脚本可能填写并提交申请。它不会发送客服聊天消息。请只处理你有权管理的账号和订单；遇到验证时，在弹出的淘宝浏览器里亲自完成。

新建 Event 时会带入默认“开票资料”。如某个 Event 使用不同抬头或税号，可在“编辑 Event”中打开“编辑开票资料”单独修改；之后该 Event 的申请使用自己的资料。导出 ZIP 时，系统尝试从发票 PDF/图片识别项目名称和票面“价税合计”；同一张发票有多个项目时，只用第一条项目明细。

## 一、首次使用

### 第 1 步：下载项目

仓库目前是私有的。使用者需要先获得仓库访问权限，然后才能下载。

**下载 ZIP（不需要 Git）：**

1. 在浏览器打开项目的 GitHub 页面。
2. 点击绿色的 **Code** 按钮，再点 **Download ZIP**。
3. 等下载完成。浏览器通常会把文件放在“下载 / Downloads”文件夹里。

**克隆仓库：**如果你已经用 GitHub Desktop 或 Git 克隆了仓库，就使用克隆出来的文件夹，不必再下载 ZIP。克隆主要用于之后接收更新或参与开发；只想运行程序时，ZIP 已够用。

### 第 2 步：解压并找到项目文件夹

#### Mac

1. 从 Dock 栏打开 **Finder**（蓝白色笑脸图标）。
2. 在 Finder 左侧点击 **下载**。
3. 找到名字类似 `taobao-invoice-workspace-main.zip` 的文件并双击。Mac 会在旁边生成解压后的文件夹。
4. 双击解压后的 `taobao-invoice-workspace` 或 `taobao-invoice-workspace-main` 文件夹。看到 `README.md`、`Setup.command` 和 `Start.command`，就找对了。

#### Windows

1. 打开 **文件资源管理器**（任务栏上的文件夹图标）。
2. 左侧点击 **下载**。
3. 找到项目 ZIP 文件，右键并选择 **全部解压…**，再点击 **解压**。
4. 打开解压后的 `taobao-invoice-workspace` 或 `taobao-invoice-workspace-main` 文件夹。看到 `README.md`、`Setup.bat` 和 `Start.bat`，就找对了。

### 第 3 步：安装 Node.js

Node.js 是票夹运行网页服务和订单处理脚本所需的运行环境。项目要求 **Node.js 22.13 或更新版本**。如果 `node -v` 已显示符合要求的版本，跳过安装；否则使用对应系统的终端命令。Node 安装与项目首次 Setup 是两步，都要完成。

#### Mac：在“终端”安装 Node 22

打开“终端”，整段复制并回车。nvm 会把 Node 安装在当前用户目录，不需要管理员权限：

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.41.0/install.sh | bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm install 22
nvm alias default 22
node -v
npm -v
```

看到 `node -v` 输出 `v22...` 且版本不低于 `v22.13.0`，即可继续。nvm 通常会在新终端自动加载。如果新开的终端提示 `nvm: command not found`，运行：

```bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
```

#### Windows：在 CMD 安装 Node LTS

打开“命令提示符”（CMD），运行：

```cmd
winget install --id OpenJS.NodeJS.LTS --exact --source winget
```

安装完成后关闭 CMD 并重新打开，再运行：

```cmd
node -v
npm -v
```

`--source winget` 可绕过不可用的 Microsoft Store 软件源。如果学校或单位电脑提示需要管理员权限，说明设备策略限制安装，请联系 IT 安装 Node.js。Windows Node ZIP 是免安装包，不会自动配置 PATH，本指南不把它作为常规安装方式。

Node 安装完成后，还要在解压后的项目文件夹运行 `Setup.command`（Mac）或 `Setup.bat`（Windows），以安装票夹依赖和 Chromium。
### 第 4 步：运行首次设置

首次设置会下载项目依赖和 Playwright 使用的 Chromium 浏览器。网络较慢时可能需要等待几分钟；设置成功后，不用每次重复。

#### Mac：双击方式

1. 在项目文件夹最外层找到 `Setup.command`。
2. 双击它。终端窗口会打开并显示安装进度。
3. 看到 `Setup complete` 后，按提示按回车关闭窗口。
4. 如果 macOS 提示无法确认开发者：在 Finder 中按住 Control 并点击 `Setup.command`，选择 **打开**，再按屏幕提示确认。只对你从项目 GitHub 仓库下载的文件这样操作。

#### Windows：双击方式

1. 在项目文件夹最外层找到 `Setup.bat`。
2. 双击它。黑色命令窗口会显示安装进度。
3. 看到 `Setup complete` 后，按回车关闭窗口。

### 第 5 步：启动票夹并填写发票信息

1. 回到项目文件夹最外层。
2. Mac 双击 `Start.command`；Windows 双击 `Start.bat`。
3. 保持打开的终端/命令窗口运行。浏览器访问 <http://127.0.0.1:4318>。
4. 在左侧点击“开票资料”，填写发票抬头和税号；邮箱、电话、地址、银行及纸质发票收件信息按需填写，然后点击“保存开票资料”。后续开票申请会使用这些资料。不要把真实资料文件发给别人或提交到 GitHub。

### 第 6 步：登录淘宝并扫描

在票夹中创建或打开 Event。扫描时按提示在弹出的淘宝浏览器里登录并完成人工安全验证。

创建 Event 时可以添加多个购买日期区间，例如“10 月 20–24 日”“10 月 28 日”“10 月 30–31 日”。每个日期区间单独一行；单日把开始和结束日期设为同一天。扫描会检查选中区间内的订单，也会额外检查该 Event 里手动补录的订单，不受日期区间限制。

扫描过程中不要关闭启动窗口或让电脑进入睡眠。结果会在任务记录和 Event 订单表中逐步更新。

## 二、后续使用

Node.js、依赖、Chromium 和发票配置通常只需首次设置。以后每次用票夹时：

### 方式 A：点击文件启动

1. 在 Finder（Mac）或文件资源管理器（Windows）中找到之前解压/克隆的 `taobao-invoice-workspace` 项目文件夹。
2. 打开文件夹最外层。
3. Mac 双击 `Start.command`；Windows 双击 `Start.bat`。
4. 保持启动窗口打开，再访问 <http://127.0.0.1:4318>。

你可以在桌面为项目文件夹创建快捷方式/别名，之后更容易找到它。不要移动或单独复制 `Start` 文件；它需要和项目里的其他文件放在原位置。

### 方式 B：用终端启动

终端命令适合想直接输入指令的使用者。先让终端进入项目文件夹，再运行启动脚本。

#### Mac

1. 打开 **终端 Terminal**（Finder → 应用程序 → 实用工具 → 终端）。
2. 输入 `cd `（注意 `cd` 后面有一个空格，不要按回车）。
3. 把 `taobao-invoice-workspace` 项目文件夹从 Finder 拖到终端窗口，终端会自动填入文件夹路径。
4. 按回车，然后输入：

   ```bash
   ./Start.command
   ```

5. 按回车启动。保持这个终端窗口打开。

如果你确定文件夹在“下载”里，也可以直接输入：

```bash
cd ~/Downloads/taobao-invoice-workspace
./Start.command
```

如果文件夹名称带有 `-main`，或者放在别处，用拖放文件夹的方法最稳妥。

#### Windows

1. 在文件资源管理器中打开项目文件夹最外层。
2. 点击窗口顶部的地址栏，输入 `cmd`，再按回车。这会在当前项目文件夹打开命令窗口。
3. 输入并回车：

   ```bat
   Start.bat
   ```

也可以在 PowerShell 窗口中运行：

```powershell
cd "$HOME\Downloads\taobao-invoice-workspace"
.\Start.bat
```

如果实际文件夹名称或位置不同，请改成实际路径；也可以用地址栏输入 `powershell`，这样会直接在当前文件夹打开 PowerShell。

### 停止服务

在启动票夹的终端/命令窗口按 **Ctrl+C**，再按提示确认（如果出现）。停止服务会中断正在运行的任务。重新启动或重扫前，先查看淘宝页面、任务记录和订单状态，避免重复提交申请。

## 三、常见问题

- **网页显示无法访问：**确认 `Start.command` / `Start.bat` 启动窗口仍打开且没有报错，再刷新 <http://127.0.0.1:4318>。
- **提示找不到 Node.js 或版本太旧：**重新安装 Node.js 22.13 或更新版本，关闭并重开终端，再运行 Setup。
- **Setup 下载很慢：**首次 Setup 需要从网络下载依赖和 Chromium。保持窗口打开并等待；若失败，记录最后几行错误信息后再处理。
- **误关了启动窗口：**服务已经停止。重新双击 `Start` 文件即可；如果扫描被中断，先核对淘宝上的真实状态。
- **找不到配置文件：**确认在项目目录内打开 `engine` 子文件夹，并且 Setup 已成功运行。
- **订单、发票是否会自动同步给别人：**不会。程序数据和登录会话留在各自电脑。

## 四、重要数据与隐私

Event 数据、发票、快照、任务文件、`engine/invoice-config.json` 和 Playwright 浏览器登录状态都保存在本机。不要分享 `ui/.data/`、`engine/downloads/`、配置文件或 `engine/.playwright-browser/`。GitHub 仓库只用于下载程序，不是云端票务库。
