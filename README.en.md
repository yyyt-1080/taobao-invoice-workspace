# Piao Jia · Taobao Invoice Workspace

[简体中文](README.md) · [English](README.en.md)

Piao Jia is a local workspace for organizing Taobao invoices. The web UI manages orders and attachments by Event; the included helper automates supported Taobao page workflows. It supports **macOS and Windows**. Each user signs in and keeps their own data on their own computer. This is not a shared cloud service.

> **Scanning can perform real actions.** Scanning and checking one order may fill in and submit an invoice application card sent by a seller. The app does not send chat messages. Applications through the normal system entry require confirmation in the UI. Read the [Beginner Guide](docs/en/beginner-guide.md) before scanning.

## Quick start

1. Install [Node.js 22.13 or newer](https://nodejs.org/).
2. Download and unzip this repository, then double-click `Setup.command` (macOS) or `Setup.bat` (Windows).
3. Setup creates `engine/invoice-config.json` only after it succeeds. It is normal for this file to be missing immediately after cloning or unzipping. Open it and enter your invoice details.
4. Double-click `Start.command` (macOS) or `Start.bat` (Windows), then open <http://127.0.0.1:4318>.
5. Complete Taobao sign-in and security checks manually in the local browser window.

See the [English Beginner Guide](docs/en/beginner-guide.md) or [中文新手指南](docs/zh-CN/beginner-guide.md) for details.

## Documentation

- [Beginner Guide (English)](docs/en/beginner-guide.md) · [新手指南（中文）](docs/zh-CN/beginner-guide.md)
- [Detailed User Guide (English)](docs/en/user-guide.md) · [详细使用指南（中文）](docs/zh-CN/user-guide.md)
- [Developer Guide (English)](docs/en/developer-guide.md) · [开发指南（中文）](docs/zh-CN/developer-guide.md)

## Privacy and data

Event data, configuration, browser login state, invoices, snapshots, and task files stay on each user's computer. They are not included when downloading or uploading the GitHub repository. Never commit local data to this repository. GitHub distributes the program; it does not provide Taobao accounts, authorization, or shared user data.

## Project status

This project supports local automation and personal record keeping. Taobao page changes may affect recognition; results require human review. Scan coverage, invoice amount matching, and PDF file checks do not prove invoice authenticity or completeness. Confirm applicable platform rules and account-owner authorization before use.

[简体中文](README.md) · [English](README.en.md)
