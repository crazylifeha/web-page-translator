# 网页翻译 / Web Page Translator

一款更适合**论文、技术文档和复杂网页**的浏览器翻译扩展，支持**本地大模型**、**公式高保真保留**、**双语对照阅读**、**动态网页增量翻译**与**整页/划词双模式翻译**。

A browser extension built for **papers, technical documentation, and complex webpages** with **local LLM support**, **high-fidelity formula preservation**, **bilingual reading**, **incremental translation for dynamic pages**, and both **full-page** and **selection translation**.

![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)
![License](https://img.shields.io/badge/License-MIT-green)

---

## 核心优势 / Why This Extension

- **支持本地大模型，隐私友好**  
  可接入本地 OpenAI 兼容接口，适合对数据隐私、响应可控性有要求的使用场景。

- **LaTeX / MathJax / KaTeX 公式高保真保留**  
  针对学术网页和技术内容做了专门处理，尽量避免公式、变量和数学结构被误翻。

- **双语对照翻译，更适合论文和技术文档阅读**  
  保留原文上下文，方便核对术语、专有名词和关键表述，也可切换为仅看译文。

- **支持动态网页增量翻译**  
  面对滚动加载、无限列表、动态插入内容的页面，新增内容也能继续跟随翻译。

- **整页翻译 + 划词翻译，多场景覆盖**  
  既适合通读整篇文章，也适合快速查句、查段落、查选中内容。

## 功能特性 / Features

- **整页翻译** — 智能识别段落、标题、列表等块级元素，批量翻译并原位展示
- **划词翻译** — 选中文字后右键翻译，或开启划词快捷触发
- **双语对照 / 仅看译文** — 满足精读和快速浏览两类阅读习惯
- **多引擎支持** — 大模型 API、本地大模型、谷歌翻译、微软翻译
- **公式保护** — 自动保留 LaTeX、MathJax、KaTeX 与文本公式占位符
- **动态页面翻译** — 支持滚动加载内容的增量翻译
- **一键恢复原文** — 随时回退，不破坏原始阅读流程
- **自定义体验** — 支持快捷键、译文颜色等个性化配置

---

## 翻译引擎 / Translation Engines

| 引擎 | 是否需要 Key | 说明 |
|------|-------------|------|
| 大模型 API | 是 | 默认使用智谱 AI GLM-4-Flash，[获取 API Key](https://open.bigmodel.cn/) |
| 本地大模型 | 否（可选） | 兼容 OpenAI API 格式，支持 LM Studio、Ollama 等 |
| 谷歌翻译 | 否 | 免费通道，非 Google 官方 API |
| 微软翻译 | 否 | 通过 Edge 翻译服务，非 Microsoft 官方公开 API |

> **注意：** 谷歌与微软通道为社区常用方案，长期可用性不受保证，生产环境建议优先使用大模型或本地引擎。

---

## 安装 / Installation

1. 克隆或下载本仓库
2. 打开浏览器扩展管理页
   - Chrome：`chrome://extensions`
   - Edge：`edge://extensions`
3. 开启「开发者模式」
4. 点击「加载已解压的扩展程序」，选择本项目根目录（包含 `manifest.json` 的文件夹）

---

## 使用说明 / Usage

### 基本操作

1. 点击扩展图标，打开设置面板
2. 选择翻译引擎并完成配置（大模型需填写 API Key）
3. 设置源语言、目标语言与展示模式
4. 点击 **「翻译当前页面」**

### 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl + Shift + Y`（Mac: `Cmd + Shift + Y`） | 全局翻译当前页面 |
| `Alt + C`（可自定义） | 网页内触发翻译 |
| `Alt + R` | 网页内恢复原文 |

### 划词翻译

- 选中文字 → 右键 → **「翻译选中文字」**
- 或在面板中开启「启用划词翻译」

### 本地大模型配置

1. 启动本地推理服务（如 LM Studio、Ollama）
2. 在扩展中选择「本地大模型」
3. 填写 API 地址，例如：`http://localhost:1234/v1/chat/completions`
4. 点击刷新按钮检测可用模型

**Ollama 用户：** 需设置跨域允许：

```bash
# Linux / macOS
OLLAMA_ORIGINS="*" ollama serve

# Windows PowerShell
$env:OLLAMA_ORIGINS="*"; ollama serve
```

---

## 项目结构 / Project Structure

```
├── manifest.json      # 扩展清单
├── background.js      # 后台服务：API 调用、右键菜单、快捷键
├── content.js         # 内容脚本：DOM 解析、译文注入、划词气泡
├── content.css        # 译文样式
├── popup.html/js/css  # 扩展弹窗面板
└── icons/             # 扩展图标
```

---

## 隐私 / Privacy

本扩展仅在您主动触发翻译时读取网页文本，API Key 与设置保存在浏览器本地。

详见 [隐私政策 / Privacy Policy](./PRIVACY.md)。

---

## 开源协议 / License

[MIT License](./LICENSE)

---

## 贡献 / Contributing

欢迎提交 Issue 和 Pull Request！

1. Fork 本仓库
2. 创建功能分支：`git checkout -b feature/my-feature`
3. 提交更改并发起 PR

---

## English Quick Start

1. Load the extension in developer mode (`chrome://extensions` or `edge://extensions`)
2. Open the popup → choose an engine → configure API key if needed
3. Click **「翻译当前页面」** (Translate Current Page) or press `Ctrl+Shift+Y`
4. Use `Alt+R` to restore the original page

For local LLM, point the API URL to your OpenAI-compatible endpoint (e.g. `http://localhost:1234/v1/chat/completions`).
