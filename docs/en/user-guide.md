# Piao Jia User Guide

[简体中文](../zh-CN/user-guide.md) · [English](user-guide.md) · [Project home](../../README.en.md)

This guide is for people who use Piao Jia without changing its code. The app runs locally. Order data, invoices, and Taobao login state are not automatically shared.

## 1. First-time setup

1. Install Node.js 22.13 or newer.
2. Download and unzip the GitHub repository.
3. Double-click `Setup.command` on macOS or `Setup.bat` on Windows. The first setup downloads dependencies and Chromium and may take a few minutes.
4. Edit `engine/invoice-config.json` with your own invoice title, tax number, and email. Do not send this file to anyone or upload it to GitHub.
5. Double-click `Start.command` (macOS) or `Start.bat` (Windows). Keep the terminal window open and visit <http://127.0.0.1:4318>.

Complete Taobao sign-in and verification yourself in the local browser window. Do not share the browser profile.

## 2. Create an Event and scan

1. Create an Event and enter its name and purchase date range.
2. Open the Event, confirm the date range, and select **Scan orders**.
3. Watch the Taobao browser and complete sign-in or security checks when prompted.
4. Follow progress in Task history. Review each order's status, amount, and note in the order table.

**Scanning can perform real Taobao actions:** the script checks orders and recent seller chat messages and tries to download confirmed PDFs. If it finds an invoice application card sent by a seller, it may fill in and submit that card. It does not send chat messages. Batch scanning does not submit applications through the normal system entry. A single **Check this order** action may also process and submit a seller application card.

Use the system only for accounts and orders you are authorized to manage. If a result is uncertain, a page looks unexpected, or a task is interrupted, verify the status on Taobao before retrying to avoid duplicate applications.

## 3. Statuses and invoices

- **Issued (green):** an invoice attachment is linked; the order row may show **View invoice ↗**.
- **System pending (yellow):** the system application page says the request is processing.
- **Seller pending (blue):** an application was submitted through the seller workflow and is awaiting processing.
- **Needs review (red):** a status or attachment needs human review. If a seller PDF total differs from the order amount, the PDF is still saved and can be opened from **Details**. The note explains the mismatch; the order is not marked issued.
- **Manually added (purple):** the order was added by a user.

Open **Details** to view a PDF or image. The order row shows **View invoice ↗** only when its status includes **Issued** and an attachment is linked.

## 4. Edit, upload, and reconcile

1. Select **Edit orders** to change status, note, amount, and the **Export** checkbox.
2. Upload or paste JPG, PNG, or PDF files, up to 20 MB each. You can set the status to **Issued** in the same save; open the attachment from the order details afterwards.
3. Select **Reconcile** to switch the search box to amount-list mode. Separate amounts with new lines, spaces, commas, or semicolons. The app compares amount occurrences against issued orders checked as exported in the current Event. Issued orders absent from the list remain visible in the table.
4. Select **Exit reconcile** to return to normal shop, order number, or amount search.

## 5. Export invoices

Select **Export**, choose orders with linked invoice files, and select **Export selected**. The browser saves a ZIP file. After it is created, the selected orders record the export status and time. Only PDFs/JPGs/PNGs already linked locally are included.

## 6. Stop, back up, and protect data

- Keep the terminal window running Piao Jia open. Press `Ctrl+C` to stop the service. A Taobao action may be interrupted; verify its status on Taobao before restarting work.
- Important data includes `ui/.data/events.json`, `engine/downloads/`, and `engine/invoice-config.json`. Stop the service before backing them up. Backups contain order, tax, or invoice data; encrypt them and do not send them in chat or put them in a public repository.
- Never share `engine/.playwright-browser/`, which may contain the login session.
- GitHub does not sync orders or invoices. Each user has separate data on their own computer.

## Troubleshooting

- **The page will not open:** make sure the Start window is still running, then open `http://127.0.0.1:4318`.
- **Configuration missing:** create and fill in `engine/invoice-config.json` from the example.
- **A verification prompt appears:** complete it manually in the Taobao browser; do not enter verification codes into Piao Jia.
- **The PDF amount cannot be checked:** open the saved file from Details and review its contents and order association manually.
- **The computer sleeps or the service stops:** the task will not continue. After restart, inspect Taobao and the task results before scanning again.
