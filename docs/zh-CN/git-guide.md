# 票夹 Git 下载、启动与更新指南（零基础）

[返回项目首页](../../README.md) · [票夹新手指南](beginner-guide.md)

本指南适合从未使用过 Git 或终端的人。首次使用需要下载程序、安装依赖和浏览器；之后日常使用只需要启动票夹。票夹运行在自己的电脑上，使用 GitHub 下载代码不会同步其他人的订单或发票。

> 扫描及单笔检查可能填写并提交商家发来的发票申请卡片，但不会发送客服聊天消息。请先核对开票资料和扫描范围。淘宝登录和安全验证需要本人在弹出的浏览器中完成。

## 开始前了解几个词

- **终端 / CMD**：输入命令的窗口。Mac 使用“终端”，Windows 使用“命令提示符”（CMD）。命令输入后要按 **Enter（回车）**执行。
- **Git**：用来从 GitHub 下载和更新程序的工具。`git clone` 是首次下载，`git pull` 是以后获取更新。
- **Node.js**：运行票夹所需的环境；`npm` 随 Node.js 提供。
- **项目文件夹**：存放票夹程序和本机数据的文件夹。以后请始终使用同一份文件夹，不要反复下载多个副本。

仓库目前是私有的：请先让维护者授予你的 GitHub 账号访问权限。电脑需要联网、Git 和 Node.js 22.13 或更新版本。首次设置还要下载 Chromium，可能耗时数分钟。

## 一、打开终端并检查环境

### Mac

1. 按 `Command + 空格`，输入 **终端** 或 **Terminal**，按回车。
2. 在弹出的窗口中，依次输入以下命令，**每输入一行就按一次回车**：

   ```bash
   git --version
   node -v
   npm -v
   ```

3. 三条命令都显示版本号，且 Node.js 版本不低于 22.13，就可以进入下一节。若缺少 Node.js，请按[新手指南的 Mac 部分](beginner-guide.md)安装。若 Git 不可用，按 macOS 提示安装命令行开发者工具，或联系设备管理员。

### Windows

1. 按键盘上的 **Windows 键**，输入 `cmd`，点击 **命令提示符**。请使用 CMD；下文 Windows 命令是为 CMD 写的。
2. 在黑色窗口中依次输入以下命令，**每输入一行就按一次回车**：

   ```cmd
   git --version
   node -v
   npm -v
   ```

3. 三条命令都显示版本号，且 Node.js 版本不低于 22.13，就可以进入下一节。`not recognized` 表示当前窗口找不到该命令：安装 Git 或 Node.js 后关闭 CMD、重新打开再检查；安装被设备策略限制时请联系管理员。如果 Node.js 通过 fnm 等版本管理器安装，按该工具的说明在**当前 CMD 窗口**启用 Node.js，再运行 `node -v` 和 `npm -v`。

> 命令可以从网页复制，点击终端窗口后粘贴。不要复制窗口中已有的 `C:\Users\...>` 提示符或错误输出。若某条命令报错，请先处理，不要继续输入后面的命令。

## 二、第一次从 GitHub 下载票夹

下面将票夹下载到当前用户的“文档”（Documents）文件夹。如果那里已经有 `taobao-invoice-workspace` 文件夹，不要删除或覆盖：它可能包含已有订单和发票。若那是之前克隆的票夹，可以跳到[获取更新](#五获取更新)。

### Mac：在终端中依次运行

```bash
cd ~/Documents
```

```bash
git clone https://github.com/yyyt-1080/taobao-invoice-workspace.git
```

```bash
cd taobao-invoice-workspace
```

### Windows：在 CMD 中依次运行

```cmd
cd /d "%USERPROFILE%\Documents"
```

```cmd
git clone https://github.com/yyyt-1080/taobao-invoice-workspace.git
```

```cmd
cd taobao-invoice-workspace
```

第一条命令进入“文档”，第二条下载项目，第三条进入下载好的文件夹。若提示身份验证，请按 Git 或 GitHub 的提示登录有仓库权限的账号；不要把密码、访问令牌或登录验证码发给其他人。如果提示没有权限或找不到仓库，请联系维护者确认账号权限。成功后，保持这个窗口打开，继续下一节。

## 三、第一次安装和打开票夹

确保已经完成上一节最后的 `cd taobao-invoice-workspace`。Mac 和 Windows 在各自窗口中执行相同的命令：

1. 安装程序依赖：

   ```text
   npm ci
   ```

   等待命令执行完并回到输入提示符。若显示 `npm ERR!` 或 `npm error`，请保留错误信息并联系维护者。

2. 下载扫描淘宝订单所需的 Chromium：

   ```text
   npx playwright install chromium
   ```

   等待下载结束并确认没有出现 `Failed to install browsers` 或其他错误。如果网络中断、下载失败，连接稳定网络后重新运行这条命令。安装依赖成功不代表浏览器也已安装成功。

3. 启动票夹：

   ```text
   npm start
   ```

   如果看到类似 `本机票夹：http://127.0.0.1:4318` 的提示，表示服务已启动。**保持终端窗口打开**。

4. 打开电脑上的浏览器，在地址栏输入 `http://127.0.0.1:4318` 并按回车。进入票夹后，点击左侧 **“开票资料”**，填写并保存发票抬头、税号等信息，不需要手动编辑 JSON。
5. 在票夹中新建 Event 并设置购买日期。开始扫描前，请检查日期和开票资料；遇到淘宝登录或安全验证时由本人操作。
6. 使用完毕，在运行票夹的终端窗口按 `Ctrl+C` 停止服务；Windows 若询问是否终止批处理，输入 `Y` 并回车。

浏览器打不开时，先检查终端是否还在运行、有无报错，以及地址是否完整。若提示端口被占用，检查是否已有票夹窗口运行。如果扫描提示缺少 `playwright`，确认终端进入的是正在使用的那一份项目文件夹，并在其中运行 `npm ci`。

## 四、以后每次打开票夹

日常使用不需要重新克隆，也不需要每次运行安装命令。打开终端，输入适合自己电脑的两条命令，每行按一次回车：

### Mac

```bash
cd ~/Documents/taobao-invoice-workspace
```

```bash
npm start
```

### Windows CMD

```cmd
cd /d "%USERPROFILE%\Documents\taobao-invoice-workspace"
```

```cmd
npm start
```

看到本机票夹地址后，保持窗口打开，用浏览器访问 <http://127.0.0.1:4318>。以上路径适用于按照本指南下载到“文档”的情况；如果当初选择了其他位置，请进入实际项目目录。若使用版本管理器安装 Node.js，可能需要先在新终端中启用它。使用完毕按 `Ctrl+C` 停止。

## 五、获取更新

只有维护者把修改**推送到 GitHub** 后，才能拉取；更新不是自动发生的，不需要每次打开票夹都更新。

1. 关闭正在运行的票夹：在其终端窗口按 `Ctrl+C`。
2. 备份重要本地数据，包括 `ui/.data/`、`engine/invoice-config.json`、`engine/downloads/`、`engine/snapshots/` 和 `engine/.playwright-browser/`。有些文件夹在未使用相应功能前可能不存在；这些内容包含隐私和登录状态，请妥善保管，不要提交到 GitHub。
3. 打开终端，按上一节 Mac 或 Windows 的 `cd` 命令进入票夹项目目录。
4. 查看本地代码状态：

   ```text
   git status
   ```

   如果看到 `modified` 等代码修改，请先联系维护者处理，尤其是曾手动修改过程序文件的电脑；不要执行强制覆盖或重置命令。
5. 获取更新：

   ```text
   git pull --ff-only
   ```

   如果显示 `Already up to date.`，说明该分支已经是最新；如果报错，请保留完整提示并联系维护者。如果之前手动改过代码，Git 可能拒绝覆盖，这是为了保护修改。
6. 如果维护者说明依赖或 Playwright 版本有变化，在同一目录依次运行：

   ```text
   npm ci
   npx playwright install chromium
   ```

7. 运行 `npm start`，在浏览器重新打开票夹。若页面仍显示旧内容，尝试刷新浏览器。

更新通常不需要重装 Node.js；如果新版要求更高的版本，再按更新说明处理。Git 下载或更新代码不会自动同步其他电脑上的订单、发票或登录状态。
