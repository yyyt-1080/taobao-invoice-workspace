# 使用 Git 获取和更新票夹

[项目首页](../../README.md) · [新手指南](beginner-guide.md)

本指南使用终端从 GitHub 获取票夹，并在以后拉取更新。`git pull` 不会自动运行；只有维护者提交并推送到 GitHub 的更新才能拉取。仓库为私有仓库时，使用者需要先获得访问权限，并按 GitHub 提示完成身份验证。

## 一、准备工作

电脑需要安装 Git 和 Node.js **22.13 或更新版本**。打开 Mac 的“终端”或 Windows 的“命令提示符”（CMD），分别检查：

```text
git --version
node -v
npm -v
```

三条命令都应显示版本号。如果找不到 Git 或 Node.js，请先完成安装；Windows 的设备策略可能要求管理员协助。Node.js 通过版本管理器安装时，可能需要先在当前终端启用它。详细的 Node.js 安装说明见[新手指南](beginner-guide.md)。

## 二、首次克隆

下面的命令会在当前用户的文档文件夹中创建 `taobao-invoice-workspace`。如果该文件夹已经存在，请先检查它是否是正在使用的票夹，切勿覆盖或删除其中的数据。

### Mac：终端

```bash
cd ~/Documents
git clone https://github.com/yyyt-1080/taobao-invoice-workspace.git
cd taobao-invoice-workspace
```

### Windows：命令提示符（CMD）

```cmd
cd /d "%USERPROFILE%\Documents"
git clone https://github.com/yyyt-1080/taobao-invoice-workspace.git
cd taobao-invoice-workspace
```

如果 GitHub 拒绝访问，请确认账号已获得仓库权限，并完成 Git 的身份验证。不要把密码或访问令牌发给其他人。

## 三、首次设置和启动

在刚才进入的项目目录中，依次运行以下命令。两套系统的命令相同：

```text
npm ci
npx playwright install chromium
npm start
```

等待每条命令成功结束后再执行下一条。前两条需要联网；如果 Chromium 下载报错，应检查网络并重试该命令，不要把失败当成安装成功。启动后看到本机票夹地址时，保持终端窗口打开，在浏览器访问 <http://127.0.0.1:4318>。在左侧“开票资料”中填写并保存资料，无需手动编辑 JSON。

扫描和单笔检查可能填写并提交客服发来的发票申请卡片；淘宝登录及安全验证需要本人在弹出的浏览器中完成。使用完毕后，在运行服务的终端按 `Ctrl+C` 停止。

## 四、日常打开票夹

不需要每次重新克隆或安装。打开终端，进入**同一份**项目目录，再启动：

Mac：

```bash
cd ~/Documents/taobao-invoice-workspace
npm start
```

Windows CMD：

```cmd
cd /d "%USERPROFILE%\Documents\taobao-invoice-workspace"
npm start
```

保持窗口打开，访问 <http://127.0.0.1:4318>。如果 Node.js 由版本管理器管理，先在当前终端启用 Node.js；直接双击启动脚本时环境可能不同。

## 五、获取更新

1. 先停止票夹。在正在运行的终端按 `Ctrl+C`。
2. 备份重要本地数据，尤其是 `ui/.data/`、`engine/invoice-config.json`、`engine/downloads/`、`engine/snapshots/` 和 `engine/.playwright-browser/`。这些数据包含隐私和登录状态，应妥善保管，不要提交到 GitHub。
3. 在项目目录中执行：

   ```text
   git status
   git pull --ff-only
   ```

4. 如果发布说明指出依赖或 Playwright 发生变化，在同一目录执行：

   ```text
   npm ci
   npx playwright install chromium
   ```

5. 运行 `npm start`，重新打开票夹网页。

如果 `git status` 显示修改过代码，或者 `git pull` 报错，请保留报错并联系维护者；不要用重置或强制覆盖命令丢弃本地修改。更新一般不需要重装 Node.js，但如果新版要求更高的 Node.js 版本，应先升级。克隆或拉取不会把另一台电脑上的 Event 和发票同步过来。
