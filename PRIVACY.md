# 隐私政策 / Privacy Policy

**最后更新 / Last updated:** 2026-05-24

本隐私政策适用于浏览器扩展「网页智能翻译」（Web Page Translator，以下简称「本扩展」）。

This privacy policy applies to the browser extension "Web Page Translator" (网页智能翻译).

---

## 我们收集哪些数据 / What Data We Collect

### 1. 网页文本 / Web Page Text

当您主动触发翻译（点击按钮、快捷键或右键菜单）时，本扩展会读取当前网页中的可见文本段落，用于生成译文。

When you actively trigger translation (button, shortcut, or context menu), the extension reads visible text on the current page to produce translations.

**我们不会**在后台自动采集或上传您的浏览历史。

We do **not** automatically collect or upload your browsing history in the background.

### 2. 用户配置 / User Settings

以下信息仅保存在您浏览器本地的 `chrome.storage.local` 中：

The following is stored locally in your browser via `chrome.storage.local`:

- API Key（如您选择使用大模型引擎）
- 翻译引擎、源语言、目标语言、展示模式等偏好设置
- 快捷键与译文颜色等 UI 配置

### 3. 我们不收集 / What We Do NOT Collect

- 不收集姓名、邮箱、账号密码等个人身份信息
- 不运行独立的后端服务器存储您的数据
- 不向开发者发送使用统计或分析数据（除非您通过 GitHub Issues 主动联系我们）

---

## 数据如何被使用 / How Data Is Used

| 数据 | 用途 |
|------|------|
| 网页文本 | 发送至您选择的翻译引擎，获取译文后展示在页面上 |
| API Key | 用于调用对应的大模型 API，仅保存在本地 |
| 设置项 | 记住您的翻译偏好 |

---

## 第三方服务 / Third-Party Services

根据您选择的翻译引擎，文本可能被发送至以下第三方：

Depending on your selected engine, text may be sent to:

| 引擎 | 服务域名 | 说明 |
|------|----------|------|
| 大模型 API | `open.bigmodel.cn` | 智谱 AI 官方 API，需用户自行配置 Key |
| 本地大模型 | 用户配置的地址（如 `localhost`） | 数据不离开您的设备 |
| 谷歌翻译 | `translate.googleapis.com` | 非官方接口，无 API Key |
| 微软翻译 | `edge.microsoft.com`、`api.cognitive.microsofttranslator.com` | Edge 浏览器内置翻译通道 |

**请查阅各第三方服务的隐私政策，了解其数据处理规则。**

Please review each third party's privacy policy for their data handling practices.

---

## 数据存储与保留 / Storage & Retention

- 所有配置与 API Key 存储在浏览器本地，卸载扩展后将被清除
- 本扩展不在云端备份或同步您的数据
- 翻译过程中产生的网页文本不会持久化存储

---

## 权限说明 / Permissions Explained

| 权限 | 原因 |
|------|------|
| `storage` | 保存用户设置与 API Key |
| `contextMenus` | 提供「翻译选中文字」右键菜单 |
| `<all_urls>` | 在当前网页注入翻译脚本，仅用于翻译功能 |
| 网络访问权限 | 调用翻译 API |

---

## 儿童隐私 / Children's Privacy

本扩展不面向 13 岁以下儿童，也不会故意收集儿童信息。

This extension is not directed at children under 13.

---

## 政策变更 / Policy Changes

我们可能在 GitHub 仓库中更新本政策。重大变更将在 Release Notes 中说明。

We may update this policy in the GitHub repository. Significant changes will be noted in release notes.

---

## 联系我们 / Contact

如有隐私相关问题，请通过 GitHub Issues 提交：

For privacy questions, please open a GitHub Issue:

**https://github.com/crazylifeha/web-page-translator/issues**
