# Piao Jia Developer Guide

[简体中文](../zh-CN/developer-guide.md) · [English](developer-guide.md) · [Project home](../../README.en.md)

## Architecture

- `ui/`: static frontend, local HTTP server, Event state, file viewing, and ZIP export.
- `engine/`: Playwright Taobao automation, order classification, seller-card handling, and invoice amount checking.
- `ui/.data/events.json`: local Event and order data.
- `engine/invoice-config.json`: each user's local invoice configuration.
- `engine/.playwright-browser/`, `engine/downloads/`, `engine/snapshots/`: local login state and runtime files.

Event state writes use an incrementing `revision` for optimistic concurrency checks and are serialized. If a client submits a stale revision, the server returns `409` and the UI reloads the latest state instead of letting an older tab overwrite newer order edits. This protects concurrent writes to one local app; it does not provide multi-user collaboration or cross-device sync.

The root `package.json` manages shared dependencies. `ui/server.mjs` calls the sibling `engine/` directory by default; `INVOICE_HELPER_DIR` can point to a development helper. The service binds to `127.0.0.1`. It has no authentication or multi-user isolation and must not be exposed to a LAN or the public internet.

## Requirements and commands

- Node.js 22.13 or newer; macOS and Windows.
- `npm install` installs Playwright and PDF.js.
- `npx playwright install chromium` installs the Chromium browser used for automation.
- `npm start` starts the UI at `http://127.0.0.1:4318`.
- The Windows setup script checks Node, installs dependencies and Chromium, and creates the local config from the example only if it does not already exist.

PDF amount extraction uses PDF.js's Node API, avoiding a dependency on macOS Swift/PDFKit or external `pdftotext`. Scans use local temporary/download folders and do not upload PDF content. See the [PDF.js Node example](https://github.com/mozilla/pdf.js/blob/master/examples/node/getinfo.mjs).

## Task flow and side effects

- Event scans build Helper arguments containing Event order, saved-invoice skip IDs, manual additions, and excluded IDs, then start `invoice-actions.js --action=refresh`.
- Scans inspect order pages, invoice status, and recent seller messages. Orders with an already linked issued attachment are skipped according to current status rules.
- Scan enables `--apply-chat-card`. If a seller application card is found, the workflow may fill and submit it. It does not send chat messages. Batch scans do not submit the normal system invoice form.
- A single **Check this order** action also enables seller-card handling; batch **Check invoice progress** only reads cards.
- `--action=apply` and `--action=download` are started after UI confirmation. Do not change confirmation flags without reviewing their effects.
- Task results are merged into Event state through polling. The local service serves files only after PDF/JPEG/PNG and path checks.

Before changing live Taobao behavior, review action branches, confirmation points, and security-verification handling. Do not submit real requests or send messages for tests. If a real account is needed for manual verification, use a user-authorized test order and explain potential side effects first.

## Cross-platform maintenance

- Use `path.join`, `path.resolve`, and Node APIs; never hard-code a developer's absolute path.
- Check macOS (`Meta`) versus Windows (`Control`) shortcuts, process startup/shutdown, and browser launch on both platforms.
- Verify setup/start script changes on clean macOS and Windows accounts; ensure an empty config never overwrites an existing one.
- PDF.js text layout may differ from `pdftotext`. For amount extraction changes, use synthetic PDFs with no personal data to verify text near invoice totals. If amounts differ, keep the PDF and leave the order for human review.
- `.gitignore` must cover configuration, browser sessions, Event data, downloads, snapshots, task results, logs, and dependencies. Review `git status` and the exact staged files before each commit.

## Documentation and languages

The root README links to Chinese and English user/developer guides. The UI is Chinese-only in the first release. When behavior changes, update both languages consistently, especially seller-card submission, file retention, and permission details.

The order workspace filters statuses with five color buttons. Keep their CSS colors shared with the status-label variables. The Invoice Library is no longer a separate navigation item or page; users open files from order rows and order details. The order-table coverage notice must state that completeness is unknown and direct users to verify the count and add missing orders manually.

## Release process

1. Include only source code, setup/start scripts, sample config, documentation, and necessary licenses.
2. Confirm the root README matches actual setup commands and script names.
3. Review `.gitignore` and all changes. Search for personal order IDs, email, tax numbers, cookies, PDF/PNG/JPG files, chat HTML, logs, and local absolute paths.
4. Install from a clean macOS and Windows account following the User Guide. Use synthetic data for basic UI/file checks; never trigger external Taobao actions without authorization.
5. Publish to the private GitHub repository and invite a reviewer. Decide the UI license and publication scope before considering a public release.

The Helper source retains its MIT license in `engine/LICENSE`. The root project has no separate license declaration; do not mark all UI source as MIT without authorization.
