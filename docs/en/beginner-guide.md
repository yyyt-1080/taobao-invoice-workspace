# Beginner Guide (macOS and Windows)

[简体中文](../zh-CN/beginner-guide.md) · [English](beginner-guide.md) · [Project home](../../README.en.md)

This guide is for first-time users of a local desktop program. Follow the macOS or Windows section for your computer. After the first setup, you only need to start Piao Jia for daily use; you do not reinstall Node.js, dependencies, or Chromium each time.

> **Know what scanning does:** scanning reads Taobao order pages and may download invoices. If a seller sends an invoice application card, the script may fill it in and submit it. It does not send chat messages. Only use accounts and orders you are authorized to manage. Complete sign-in and security checks yourself in the Taobao browser window.

## 1. First-time setup

### Step 1: Download the project

The repository is private. A user needs access to it before downloading.

**Download a ZIP (no Git required):**

1. Open the project page on GitHub.
2. Select the green **Code** button, then **Download ZIP**.
3. Wait for the download. Your browser usually saves it in **Downloads**.

**Clone the repository:** If you already cloned it with GitHub Desktop or Git, use that project folder; you do not need another ZIP. Cloning is useful for receiving updates or contributing code. The ZIP is enough if you only want to run the app.

### Step 2: Unzip and find the project folder

#### macOS

1. Open **Finder** (the blue-and-white face icon in the Dock).
2. Select **Downloads** in the Finder sidebar.
3. Find a file like `taobao-invoice-workspace-main.zip` and double-click it. macOS creates an extracted folder next to it.
4. Open the extracted `taobao-invoice-workspace` or `taobao-invoice-workspace-main` folder. You are in the right place if you see `README.md`, `Setup.command`, and `Start.command`.

#### Windows

1. Open **File Explorer** (the folder icon on the taskbar).
2. Select **Downloads** in the sidebar.
3. Right-click the project ZIP, select **Extract All…**, then select **Extract**.
4. Open the extracted `taobao-invoice-workspace` or `taobao-invoice-workspace-main` folder. You are in the right place if you see `README.md`, `Setup.bat`, and `Start.bat`.

### Step 3: Install Node.js

Node.js is the runtime that Piao Jia needs for its local web server and order-processing scripts. **For most users, install it from the official installer; you do not need to type nvm commands.**

1. Open the [official Node.js download page](https://nodejs.org/en/download).
2. Download and install **Node.js 22.13 or newer**. Choose the macOS `.pkg` installer or Windows `.msi` installer that matches your computer. If an LTS release is offered, prefer LTS.
3. Follow the installer prompts. You normally do this only once.

#### About nvm (optional)

nvm means Node Version Manager. It installs and switches between Node.js versions; it manages Node.js and does not replace Piao Jia's Setup step.

The commands you shared (`curl ... | bash`, `nvm install 26`) are a terminal-based, developer-oriented method: first install nvm, then use it to install Node 26. This project requires Node.js 22.13 or newer; Node 26 meets that minimum, but regular users do not need to choose version 26 specifically. The official installer is simpler for macOS beginners. The original `nvm-sh` project targets macOS/Linux shells. Native Windows needs a different tool, nvm-windows; do not copy those commands into Windows Command Prompt.

### Step 4: Run first-time setup

Setup downloads project dependencies and the Chromium browser used by Playwright. The first download may take several minutes on a slow connection. After setup succeeds, you do not repeat it for every scan.

#### macOS: double-click

1. Find `Setup.command` in the top level of the project folder.
2. Double-click it. A Terminal window opens and shows the installation progress.
3. When you see `Setup complete`, press Return as prompted to close the window.
4. If macOS says it cannot verify the developer, Control-click `Setup.command` in Finder, choose **Open**, then follow the prompt. Do this only for files downloaded from the project's GitHub repository.

#### Windows: double-click

1. Find `Setup.bat` in the top level of the project folder.
2. Double-click it. A command window shows the installation progress.
3. When you see `Setup complete`, press Enter as prompted to close the window.

### Step 5: Enter your invoice details

First-time setup automatically copies the example to `engine/invoice-config.json`. **This is not a form on the website**; edit this local JSON file with a text editor. Its location is:

```text
taobao-invoice-workspace/
└── engine/
    └── invoice-config.json
```

- **macOS:** Open the project's `engine` folder, then open `invoice-config.json` with a text editor such as TextEdit.
- **Windows:** Open the project's `engine` folder, right-click `invoice-config.json`, and choose Notepad.

The file will look similar to the example below. Replace the example text in the first three fields with your invoice title, tax number, and receiving email. Leave the other fields as empty strings if you do not need them yet:

```json
{
  "companyName": "Your invoice title",
  "taxNo": "Your taxpayer identification number",
  "email": "Email address for receiving invoices",
  "phone": "",
  "address": "",
  "bankName": "",
  "bankAccount": "",
  "paperShippingName": "",
  "paperShippingPhone": "",
  "paperShippingAddress": "",
  "sellerMessageTemplate": "您好，这笔订单需要申请开具发票。订单号：{orderId}。烦请协助开具发票。发票信息如下：发票抬头：{companyName}；税号：{taxNo}；发票类型：{invoiceType}；接收邮箱：{email}。如需补充信息，请告知，谢谢。"
}
```

Replace only the text inside quotation marks. Keep the JSON quotation marks, commas, and braces. Save the file; Piao Jia reads it when it starts. Do not share your real configuration or commit it to GitHub.

If `invoice-config.json` is missing, confirm Setup completed successfully. `invoice-config.example.json` is the sample tracked in the repository; enter personal information in the generated `invoice-config.json` beside it. Do not overwrite the sample or commit real configuration to the repository.

### Step 6: Start Piao Jia and sign in to Taobao

1. Return to the top level of the project folder.
2. Double-click `Start.command` on macOS or `Start.bat` on Windows.
3. Keep the Terminal/command window open. Visit <http://127.0.0.1:4318> in a browser.
4. Create or open an Event. When scanning, sign in to Taobao and complete any security checks in the Taobao browser window.

Do not close the startup window or let the computer sleep during a scan. Progress appears in Task history and updates in the Event order table.

## 2. Everyday use

Node.js, dependencies, Chromium, and invoice configuration usually need to be set up only once. For each later session:

### Option A: Start by clicking the file

1. In Finder (macOS) or File Explorer (Windows), find the `taobao-invoice-workspace` folder you extracted or cloned earlier.
2. Open the top-level project folder.
3. Double-click `Start.command` on macOS or `Start.bat` on Windows.
4. Keep the startup window open, then visit <http://127.0.0.1:4318>.

You can create a desktop shortcut or alias to the project folder. Do not move or copy only the `Start` file; it needs to stay beside the rest of the project files.

### Option B: Start from Terminal or Command Prompt

Use this option if you prefer typing commands. First open a terminal in the project folder, then run the startup script.

#### macOS

1. Open **Terminal** (Finder → Applications → Utilities → Terminal).
2. Type `cd ` (include a space after `cd`, and do not press Return yet).
3. Drag the `taobao-invoice-workspace` folder from Finder into the Terminal window. Terminal fills in its path.
4. Press Return, then type:

   ```bash
   ./Start.command
   ```

5. Press Return to start. Keep this Terminal window open.

If the folder is in Downloads and has the exact name shown below, you can instead type:

```bash
cd ~/Downloads/taobao-invoice-workspace
./Start.command
```

If the folder ends in `-main` or is somewhere else, dragging it into Terminal is the easiest way to get the correct path.

#### Windows

1. Open the top-level project folder in File Explorer.
2. Select the address bar, type `cmd`, and press Enter. This opens Command Prompt in that project folder.
3. Type and run:

   ```bat
   Start.bat
   ```

You can also open PowerShell in the project folder and run:

```powershell
cd "$HOME\Downloads\taobao-invoice-workspace"
.\Start.bat
```

Change the path if your folder has a different name or location. Or type `powershell` in File Explorer's address bar to open PowerShell directly in the current folder.

### Stop the service

In the Terminal/command window running Piao Jia, press **Ctrl+C** and confirm if prompted. This stops any task in progress. Before restarting or scanning again, check Taobao, Task history, and the order status to avoid duplicate applications.

## 3. Common problems

- **The page cannot be reached:** Make sure the `Start.command` / `Start.bat` window is still open and shows no error, then refresh <http://127.0.0.1:4318>.
- **Node.js is missing or too old:** Install Node.js 22.13 or newer, close and reopen the terminal, then run Setup again.
- **Setup is downloading slowly:** First-time setup downloads dependencies and Chromium. Keep the window open and wait. If it fails, save the last few error lines for troubleshooting.
- **The startup window was closed:** The service has stopped. Double-click Start again. If a scan was interrupted, check Taobao before retrying.
- **Cannot find the configuration:** Open the `engine` subfolder inside the project folder and confirm Setup completed.
- **Will orders and invoices sync to other people?** No. App data and login state stay on each computer.

## 4. Local data and privacy

Event data, invoices, snapshots, task files, `engine/invoice-config.json`, and the Playwright browser login state are stored locally. Do not share `ui/.data/`, `engine/downloads/`, the configuration file, or `engine/.playwright-browser/`. GitHub is for downloading the program; it is not a cloud invoice library.
