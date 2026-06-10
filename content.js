// Web Page Translator - content script

// 广告与追踪域名黑名单，避免在垃圾页面上执行昂贵的 DOM 扫描和翻译，提升性能
const AD_DOMAINS = [
  'googlesyndication.com', 'doubleclick.net', 'pubmatic.com', 'google-analytics.com',
  'analytics.google.com', 'scorecardresearch.com', 'adnxs.com', 'amazon-adsystem.com',
  'advertising.com', 'rubiconproject.com', 'openx.net', 'criteo.com'
];
if (AD_DOMAINS.some(domain => window.location.hostname.includes(domain))) {
  throw new Error('[GLM Translator] 广告/追踪域名拦截，停止运行翻译插件脚本。');
}

// 处于 iframe 容器中，且宽高小于 120px（通常为追踪像素或微小广告条），直接过滤终止
if (window.self !== window.top) {
  if (window.innerWidth < 120 || window.innerHeight < 120) {
    throw new Error('[GLM Translator] 处于微小/隐藏 iframe 中，停止运行翻译插件脚本。');
  }
}

let isTranslating = false;
let originalBlocks = []; // 存储所有待翻译的节点和原始文本
let modifiedLayoutElements = []; // 暂存被动态修改了布局样式的元素及其原本 inline 样式
let translatedBlocksCount = 0;
let totalBlocksCount = 0;
let translatedColor = '#7c3aed'; // 默认翻译颜色
let displayMode = 'bilingual'; // bilingual, translation-only, original-only
let currentShortcut = 'Alt+C'; // 默认触发快捷键
let lastSelectedText = ''; // 记录上一次划词的原文文本
let lastSelectionRect = null; // 记录上一次划词的选择区坐标
let autoMinimizeTimeout = null; // 翻译完成后自动收起面板的定时器
let domObserver = null; // 网页 DOM 监听器，用于支持滚动动态加载的增量翻译
let pendingObserveBlocks = []; // 动态扫描到的待翻译积压队列
let observeTimeout = null; // 增量翻译的防抖定时器
let recentObservedBlocks = new WeakMap();
const OBSERVED_BLOCK_TTL_MS = 5000;
let translationStyle = 'highlight'; // 默认高亮样式
let targetLang = 'zh'; // 默认翻译目标语言
let enableHoverTranslate = false; // 默认关闭鼠标悬浮 Alt+Hover 翻译
let currentHoveredElement = null; // 缓存当前鼠标悬浮的待翻译段落

// 初始化读取快捷键及样式配置
chrome.storage.local.get(['shortcutTrigger', 'translationStyle', 'translatedColor', 'targetLang', 'enableHoverTranslate'], (res) => {
  if (res.shortcutTrigger) {
    currentShortcut = res.shortcutTrigger;
  }
  if (res.translationStyle) {
    translationStyle = res.translationStyle;
  }
  if (res.translatedColor) {
    translatedColor = res.translatedColor;
  }
  if (res.targetLang) {
    targetLang = res.targetLang;
  }
  if (res.enableHoverTranslate !== undefined) {
    enableHoverTranslate = res.enableHoverTranslate;
  }
  applyTranslationStyle(translationStyle, translatedColor);
});

// 标签过滤
const BLOCK_TAGS = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'li', 'td', 'th', 'figcaption', 'summary', 'dd', 'dt'];

// 行内元素白名单：判断一个 div 是否为"纯文本叶子块"时使用。
// 只有当 div 的子元素全部属于这些行内标签时，才把它当作一个完整段落来翻译；
// 只要它含有任何非行内的子元素（包括 div/section 等容器，以及 GitHub 的 <react-app>、
// <turbo-frame> 等自定义元素），就视为布局容器，继续向下递归，绝不整块吞掉。
const INLINE_TAGS = [
  'a', 'span', 'b', 'i', 'em', 'strong', 'code', 'sub', 'sup', 'br', 'font',
  'mark', 'small', 'abbr', 'time', 'u', 's', 'del', 'ins', 'cite', 'q', 'kbd',
  'samp', 'var', 'wbr', 'bdi', 'bdo', 'label', 'output', 'data', 'dfn', 'ruby',
  'rt', 'rp', 'tt', 'big', 'nobr'
];

// 消息监听：监听来自 popup 或 background 的指令
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'start_translation') {
    translatedColor = request.settings.translatedColor;
    displayMode = request.settings.displayMode;
    translationStyle = request.settings.translationStyle || 'highlight';
    targetLang = request.settings.targetLang || 'zh';
    applyTranslationStyle(translationStyle, translatedColor);
    startPageTranslation(request.settings);
    sendResponse({ success: true });
  }

  if (request.action === 'restore_page') {
    restorePage();
    sendResponse({ success: true });
  }

  if (request.action === 'update_style') {
    translatedColor = request.color;
    if (request.translationStyle) {
      translationStyle = request.translationStyle;
    }
    applyTranslationStyle(translationStyle, translatedColor);
    sendResponse({ success: true });
  }

  // API 限频重试时的骨架屏变色通知
  if (request.action === 'translation_retry') {
    if (request.ids && Array.isArray(request.ids)) {
      request.ids.forEach(id => {
        const loader = document.querySelector(`.glm-loading-placeholder[data-loading-id="${id}"]`);
        if (loader) {
          loader.classList.add('glm-loading-retry');
        }
      });
    }
    sendResponse({ success: true });
  }

  if (request.action === 'query_status') {
    sendResponse({ 
      isTranslating: isTranslating,
      displayMode: displayMode
    });
  }

  // 划词翻译：背景脚本右键触发时
  if (request.action === 'selection_translation_loading') {
    showSelectionBubble(request.originalText, null, true);
  }

  if (request.action === 'show_selection_translation') {
    showSelectionBubble(request.originalText, request.translatedText, false);
  }

  if (request.action === 'show_floating_message') {
    showFloatingToast(request.message, request.type);
  }

  if (request.action === 'update_shortcut') {
    currentShortcut = request.shortcut;
    sendResponse({ success: true });
  }

  // 更新鼠标悬停翻译开关
  if (request.action === 'update_hover_translate') {
    enableHoverTranslate = request.enabled;
    sendResponse({ success: true });
  }
});

// 动态设置译文颜色样式
function applyColorCSS(color) {
  let styleEl = document.getElementById('glm-translate-style');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'glm-translate-style';
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = `
    :root { 
      --glm-translate-color: ${color} !important; 
      --glm-translate-bg: color-mix(in srgb, ${color} 8%, transparent) !important; 
    }
  `;
}

// 动态应用译文显示样式与颜色
function applyTranslationStyle(styleName, color) {
  applyColorCSS(color);
  
  const styles = ['highlight', 'text-only', 'dotted', 'italic', 'mask', 'weakening', 'blockquote'];
  styles.forEach(s => {
    document.body.classList.remove(`glm-style-${s}`);
  });
  
  const targetStyle = styleName || 'highlight';
  document.body.classList.add(`glm-style-${targetStyle}`);
}

// =======================================================
// DOM 遍历及解析逻辑
// =======================================================

function isTranslatable(el) {
  const skipTags = ['script', 'style', 'code', 'pre', 'noscript', 'textarea', 'input', 'select', 'option', 'iframe', 'canvas', 'svg', 'math', 'button', 'annotation', 'semantics'];
  const tag = el.tagName.toLowerCase();
  
  if (skipTags.includes(tag)) return false;

  // 1. 检查自身的不翻译属性声明
  if (el.getAttribute && el.getAttribute('translate') === 'no') return false;
  if (el.classList && (el.classList.contains('notranslate') || el.classList.contains('no-translate'))) return false;

  // 排除已翻译节点、控制条、划词浮窗等插件自身 DOM
  if (el.hasAttribute('data-glm-translated') || 
      el.classList.contains('glm-translate-widget') || 
      el.classList.contains('glm-translated') || 
      el.classList.contains('glm-float-btn') || 
      el.classList.contains('glm-translation-bubble')) {
    return false;
  }

  // 2. 检查父链是否有不翻译声明，向上查找直到 body
  // 为了豁免像 GitHub 这类给高层 React 包裹容器加上 notranslate 导致的误伤，
  // 我们在中途若遇到“允许强行翻译的正文白名单类名”则豁免更外层的不翻译声明。
  let parent = el.parentElement;
  let isInsideWhitelistContainer = false;
  
  const WHITELIST_CONTAINER_CLASSES = [
    'markdown-body', 'entry-content', 'article-content', 'article-body', 
    'post-content', 'post-body', 'post-text', 'entry', 'article', 'main'
  ];

  while (parent && parent !== document.body) {
    const pTag = parent.tagName ? parent.tagName.toLowerCase() : '';
    
    // 检查是否命中正文白名单容器
    let hasWhitelistClass = false;
    if (parent.className && typeof parent.className === 'string') {
      const clsList = parent.className.split(/\s+/);
      if (clsList.some(c => WHITELIST_CONTAINER_CLASSES.includes(c))) {
        hasWhitelistClass = true;
      }
    }
    
    if (pTag === 'article' || pTag === 'main' || hasWhitelistClass) {
      isInsideWhitelistContainer = true;
    }

    // 交互控件排除：整块文本若被 <a> 或 <button> 完整包裹，属于可点击的链接/按钮控件，
    // 而非正文（如导航项、侧边栏徽标、卡片标题等），无条件跳过翻译。
    if (pTag === 'a' || pTag === 'button') {
      return false;
    }

    // 导航/页头/页脚区域排除：除非已确认处于正文白名单容器内，否则跳过这些结构区域，
    // 对齐沉浸式翻译"只翻正文、不翻界面"的行为。
    const NAV_REGION_TAGS = ['nav', 'header', 'footer'];
    const NAV_REGION_ROLES = ['navigation', 'banner', 'contentinfo', 'menu', 'menubar', 'menuitem', 'tablist', 'tab', 'toolbar', 'search'];
    const pRole = parent.getAttribute ? parent.getAttribute('role') : null;
    if (!isInsideWhitelistContainer &&
        (NAV_REGION_TAGS.includes(pTag) || (pRole && NAV_REGION_ROLES.includes(pRole)))) {
      return false;
    }

    // 检查不翻译声明
    let isNoTranslate = false;
    if (parent.getAttribute && parent.getAttribute('translate') === 'no') {
      isNoTranslate = true;
    }
    if (parent.classList && (parent.classList.contains('notranslate') || parent.classList.contains('no-translate'))) {
      isNoTranslate = true;
    }

    if (isNoTranslate) {
      // 如果遇到了不翻译声明，且我们尚未进入任何正文白名单保护区，则该元素不可翻译
      // 如果我们已经进入了正文白名单保护区（说明 noTranslate 是外层的包装容器加的），则豁免它，继续向上查找
      if (!isInsideWhitelistContainer) {
        return false;
      }
    }
    parent = parent.parentElement;
  }
  if (!BLOCK_TAGS.includes(tag)) {
    const isFormulaContainer = 
      tag === 'mjx-container' || 
      tag === 'katex' || 
      tag === 'katex-html' ||
      el.classList.contains('MathJax') || 
      el.classList.contains('MathJax_Preview') || 
      el.classList.contains('MathJax_Display') || 
      el.classList.contains('mjx-container') || 
      el.classList.contains('mjx-assistive-mml') || 
      el.classList.contains('katex') || 
      el.classList.contains('katex-html');

    if (isFormulaContainer) {
      return false;
    }
    
    if (el.className && typeof el.className === 'string') {
      const className = el.className;
      if (tag !== 'div') {
        if (className.includes('mjx-') || className.includes('katex-') || className.includes('MathJax')) {
          return false;
        }
      } else {
        // 如果是 div 标签，我们只拦截那些纯粹是公式展示/预览的容器类名，保护作为正文块容器的普通 div 不被过滤
        if (className.includes('MathJax_Display') || className.includes('MathJax_Preview')) {
          return false;
        }
      }
    }
  }
  
  return true;
}

// 智能提取 DOM 数学公式节点、超链接以及文本数学公式，并使用占位符保护
function extractTextAndMath(el) {
  const mathItems = [];
  const linkElements = [];
  
  function isMathNode(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    const tag = node.tagName.toLowerCase();
    if (tag === 'math') return true;
    
    const className = node.className;
    if (className && typeof className === 'string') {
      const lowerClass = className.toLowerCase();
      if (lowerClass.includes('mathjax') || 
          lowerClass.includes('mjx-container') || 
          lowerClass.includes('katex')) {
        return true;
      }
    }
    return false;
  }

  function traverse(node) {
    // 增加不可翻译节点防御，杜绝把 code, pre, notranslate 内容强行提取成大块文本的漏洞
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (!isTranslatable(node)) {
        return '';
      }
    }

    if (isMathNode(node)) {
      mathItems.push({ type: 'node', value: node });
      return ` [M_${mathItems.length - 1}] `;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      return node.nodeValue;
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName.toLowerCase();
      
      // 跳过脚注、注释等嵌入在段落中的附属 DOM 元素，避免其内容（尤其是 URL）混入段落文本
      // arXiv HTML5 使用 ltx_note/ltx_foot 类名，通用学术页面可能使用 footnote 类名或 aside 标签
      if (tag === 'aside') {
        return '';
      }
      if (node.className && typeof node.className === 'string') {
        const cls = node.className.toLowerCase();
        if (cls.includes('ltx_note') || cls.includes('ltx_foot') || cls.includes('footnote') || cls.includes('note_mark')) {
          return '';
        }
      }
      // 跳过 role="note" 的辅助标记元素
      if (node.getAttribute && node.getAttribute('role') === 'note') {
        return '';
      }

      const skipTags = ['script', 'style', 'code', 'pre', 'noscript'];
      if (skipTags.includes(tag)) {
        return '';
      }

      let text = '';
      for (let child of node.childNodes) {
        text += traverse(child);
      }
      return text;
    }
    
    return '';
  }

  // 1. 先提取 DOM 中的数学公式节点与超链接
  let processedText = traverse(el);

  // 2. 再提取残留的文本格式数学公式（如 $x+y$ 或 $$x+y$$）
  processedText = processedText.replace(/\$\$([\s\S]+?)\$\$/g, (match) => {
    mathItems.push({ type: 'text', value: match });
    return ` [M_${mathItems.length - 1}] `;
  });
  
  processedText = processedText.replace(/\$([\s\S]+?)\$/g, (match) => {
    mathItems.push({ type: 'text', value: match });
    return ` [M_${mathItems.length - 1}] `;
  });

  return {
    text: processedText.trim().replace(/\s+/g, ' '),
    mathItems: mathItems,
    linkElements: linkElements
  };
}

// 智能识别并过滤元数据（如纯作者名录、学术邮箱列表、纯链接列表等）
function isMetadataOrNoise(text) {
  if (!text) return true;
  // 先把 MATH 公式占位符完全移除，避免干扰字数与停用词比例的计算
  const cleanText = text.replace(/\[\s*M_\d+\s*\]/gi, '').trim();
  if (!cleanText) return true;
  
  // 1. 如果包含邮箱地址
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const emails = cleanText.match(emailRegex);
  if (emails && emails.length >= 1) {
    // 若包含多个邮箱，或虽然只有1个邮箱但整体长度偏短（通常为联系人行），判定为元数据
    if (cleanText.length < 150 || emails.length >= 2) {
      return true;
    }
  }
  
  // 2. 如果是纯链接或链接+极少单词
  const urlRegex = /https?:\/\/[^\s]+/g;
  const urls = cleanText.match(urlRegex);
  const words = cleanText.split(/\s+/).filter(w => w.length > 0);
  if (urls) {
    // 先从文本中剥离所有 URL，看剩余的纯叙述文字部分是否有足够的内容
    // 这样可以避免因脚注 URL 混入正文段落而被误判为纯链接列表
    const textWithoutUrls = cleanText.replace(urlRegex, '').trim();
    const realWords = textWithoutUrls.split(/\s+/).filter(w => w.length > 0);
    if (realWords.length <= 8) {
      return true; // 去掉 URL 后几乎没有实质叙述内容，判定为噪声
    }
  }

  // 3. 统计英文停用词的比例（叙述性段落必定包含 common stopwords）
  if (words.length > 5) {
    const stopwords = new Set([
      'the', 'of', 'and', 'to', 'in', 'is', 'a', 'for', 'with', 'that', 'this', 'on', 'as', 'by', 'an', 'we', 'our', 'it', 'its', 'are', 'was', 'were', 'or', 'at', 'from', 'be', 'has', 'have', 'which', 'but', 'not', 'they', 'their', 'you', 'your'
    ]);
    
    let stopwordCount = 0;
    words.forEach(w => {
      const cleanW = w.toLowerCase().replace(/[^a-z]/g, '');
      if (stopwords.has(cleanW)) {
        stopwordCount++;
      }
    });

    const stopwordRatio = stopwordCount / words.length;
    // 如果总字数超过 8 个，且常用停用词比重极低（例如低于 6%），通常说明是人名列表、单位机构名称、关键词标签、无语法纯列举等
    if (words.length > 8 && stopwordRatio < 0.06) {
      return true;
    }
  }

  return false;
}

// 判断一个块是否被超链接主导：其可见文字几乎全部来自 <a> 子节点。
// 这类块通常是导航项、列表卡片标题、commit 链接等可点击 UI 元素，而非正文段落。
// 注意：此处的链接是块的"子节点"（块包着 a），与 isTranslatable 中"块被 a 包裹"互补。
function isLinkDominatedBlock(el) {
  const totalLen = (el.textContent || '').replace(/\s+/g, '').length;
  if (totalLen === 0) return false;
  let linkLen = 0;
  el.querySelectorAll('a').forEach(a => {
    linkLen += (a.textContent || '').replace(/\s+/g, '').length;
  });
  return (linkLen / totalLen) > 0.6;
}

// 递归查找适合翻译的文本块
function scanBlocks(element, list) {
  if (!isTranslatable(element)) return;

  const tagName = element.tagName.toLowerCase();
  let isBlock = BLOCK_TAGS.includes(tagName);

  // 特殊处理 DIV：仅当其子元素全部为行内元素（纯文本段落）时才视作块级翻译。
  // 只要含有任何非行内子元素（容器或自定义元素），即视为布局容器，向下递归，
  // 避免把含 <react-app> 等自定义元素的顶层容器误判成叶子块，整页文字糊成一坨。
  if (tagName === 'div') {
    let hasNonInlineChild = false;
    for (let child of element.children) {
      if (!isTranslatable(child)) {
        continue; // 忽略公式节点等不可翻译子节点，避免干扰父 div 的 isBlock 判定
      }
      const childTag = child.tagName.toLowerCase();
      if (!INLINE_TAGS.includes(childTag)) {
        hasNonInlineChild = true;
        break;
      }
    }
    if (!hasNonInlineChild) {
      // 检查它自身是否是一个真正的代码块容器。如果是，我们直接不翻译它，也不用向下递归了（因为无块级子元素）
      const cls = element.className && typeof element.className === 'string' ? element.className.toLowerCase() : '';
      const isCodeContainer = cls.includes('highlight') || cls.includes('code-block') || cls.includes('syntax') || cls.includes('monaco-editor');
      if (isCodeContainer) {
        return; // 直接返回，避开代码块翻译
      }
      isBlock = true;
    }
  }

  if (isBlock) {
    const textInfo = extractTextAndMath(element);
    
    // 针对表格单元格（td/th）的特化过滤：
    // 学术表格单元格多为数值、数据集名称或模型缩写等非叙事内容。
    // 如果单元格内容过短（字符数少于 25 或单词数少于 5），直接跳过翻译，以维护表格排版完整并节省 Token。
    if (['td', 'th'].includes(tagName)) {
      const words = textInfo.text.split(/\s+/).filter(w => w.length > 0);
      if (textInfo.text.length < 25 || words.length < 5) {
        return; // 终止递归与翻译
      }
    }

    // 过滤规则：
    // 1. 提取公式占位符后的纯文本长度大于 8 个字符
    // 2. 文本中必须含有英文叙述性字母，且去除公式占位符后的叙述文本仍包含字母（防止翻译纯公式或公式+数字编号）
    // 3. 排除中文比例过高的段落（当目标语言是中文时）
    // 4. 排除元数据/噪声块（如纯作者名录、邮箱列表等）
    const hasLetters = /[a-zA-Z]/.test(textInfo.text);
    const narrativeText = textInfo.text.replace(/\[\s*M_\d+\s*\]/gi, '');
    const hasNarrativeLetters = /[a-zA-Z]/.test(narrativeText);

    const isTargetZh = /^zh/i.test(targetLang);
    let isChineseParagraph = false;
    if (isTargetZh) {
      const chineseChars = narrativeText.match(/[\u4e00-\u9fff]/g) || [];
      const totalNarrativeLen = narrativeText.replace(/\s+/g, '').length;
      if (totalNarrativeLen > 0 && (chineseChars.length / totalNarrativeLen) > 0.8) {
        isChineseParagraph = true;
      }
    }

    if (textInfo.text.length > 8 && hasLetters && hasNarrativeLetters && !isChineseParagraph && !isMetadataOrNoise(textInfo.text) && !isLinkDominatedBlock(element)) {
      list.push({
        element: element, 
        originalText: element.innerText ? element.innerText.trim() : '',
        text: textInfo.text,
        mathItems: textInfo.mathItems,
        linkElements: textInfo.linkElements
      });
      return; // 找到叶子级块元素后终止向下遍历，以整体段落进行翻译
    }
  }

  // 递归遍历子节点
  for (let child of element.children) {
    scanBlocks(child, list);
  }
}

// =======================================================
// DOM 树动态监听 (MutationObserver) 逻辑，用于增量无限滚动翻译
// =======================================================

function startObserveDOM() {
  if (domObserver) return;
  
  domObserver = new MutationObserver((mutations) => {
    let addedNodes = [];
    mutations.forEach(m => {
      m.addedNodes.forEach(node => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          addedNodes.push(node);
        }
      });
    });

    if (addedNodes.length === 0) return;

    // 扫描被添加的节点下符合条件的文本块
    addedNodes.forEach(node => {
      // 避免自身控制条、划词弹窗或小按钮触发无限循环
      if (node.classList && (
        node.classList.contains('glm-translate-widget') || 
        node.classList.contains('glm-translation-bubble') || 
        node.classList.contains('glm-float-btn') || 
        node.classList.contains('glm-translated')
      )) {
        return;
      }
      
      const newBlocks = [];
      scanBlocks(node, newBlocks);
      
      newBlocks.forEach(b => {
        const lastObservedAt = recentObservedBlocks.get(b.element) || 0;
        if (Date.now() - lastObservedAt < OBSERVED_BLOCK_TTL_MS) {
          return;
        }

        // 确认该节点既没被翻译，也没被扫描加入增量待翻译队列
        if (!b.element.hasAttribute('data-glm-id') && !b.element.hasAttribute('data-glm-scanned')) {
          recentObservedBlocks.set(b.element, Date.now());
          b.element.setAttribute('data-glm-scanned', 'true');
          pendingObserveBlocks.push(b);
        }
      });
    });

    // 若发现了未翻译的新段落，开启防抖增量发送
    if (pendingObserveBlocks.length > 0) {
      clearTimeout(observeTimeout);
      observeTimeout = setTimeout(() => {
        if (pendingObserveBlocks.length === 0 || !isTranslating) return;
        
        const count = pendingObserveBlocks.length;
        // 把这些新段落编入原本的 originalBlocks，保持统一的编号管理
        pendingObserveBlocks.forEach((item, idx) => {
          item.id = originalBlocks.length;
          originalBlocks.push(item);
        });

        // 增量更新 widget 的总量计数
        totalBlocksCount += count;
        updateWidgetProgress();
        
        // 增量分包并进行翻译发送 (调整为单包上限 30 段落或 3500 字符)
        const newBatches = packBlocksIntoBatches(pendingObserveBlocks, 30, 3500);
        pendingObserveBlocks = []; // 清空队列
        
        chrome.storage.local.get(['sourceLang', 'targetLang', 'translateEngine'], (res) => {
          processBatches(newBatches, res.sourceLang || 'auto', res.targetLang || 'zh', res.translateEngine || 'zhipu');
        });
      }, 800); // 800毫秒防抖，合并短时间内连续注入的 DOM 变动
    }
  });

  domObserver.observe(document.body, {
    childList: true,
    subtree: true
  });
}

function stopObserveDOM() {
  if (domObserver) {
    domObserver.disconnect();
    domObserver = null;
  }
  clearTimeout(observeTimeout);
  pendingObserveBlocks = [];
  recentObservedBlocks = new WeakMap();
}

// =======================================================
// 网页整体翻译流程
// =======================================================

function startPageTranslation(settings) {
  if (isTranslating) {
    // 避免重复运行扫描，只更新显示模式即可
    updateDisplayMode(settings.displayMode);
    return;
  }

  // 检查页面主要语言是否已是中文且翻译目标也是中文
  const docLang = (document.documentElement.lang || '').toLowerCase();
  const isZhDoc = /^zh/i.test(docLang);
  const isZhTarget = /^(zh|zh-CN|zh-TW|zh-HK)$/i.test(settings.targetLang || 'zh');
  if (isZhDoc && isZhTarget) {
    showFloatingToast('当前页面已是中文，无需重复翻译。', 'info');
    return;
  }
  
  isTranslating = true;
  originalBlocks = [];
  translatedBlocksCount = 0;
  recentObservedBlocks = new WeakMap();
  
  if (autoMinimizeTimeout) {
    clearTimeout(autoMinimizeTimeout);
    autoMinimizeTimeout = null;
  }
  
  // 1. 扫描页面中所有的文本块
  scanBlocks(document.body, originalBlocks);
  totalBlocksCount = originalBlocks.length;
  
  console.log('[GLM Translator] 页面扫描完成。总段落数:', totalBlocksCount);
  if (totalBlocksCount > 0) {
    console.log('[GLM Translator] 扫描到的前 10 段样本:', originalBlocks.slice(0, 10).map(b => ({
      id: b.id,
      tag: b.element.tagName,
      class: b.element.className,
      text: b.text.substring(0, 60)
    })));
  }
  
  if (totalBlocksCount === 0) {
    showFloatingToast('未在当前页面检测到可翻译的英文文本。', 'info');
    isTranslating = false;
    return;
  }

  // 2. 创建或更新控制面板
  createOrUpdateWidget();

  // 3. 启动动态 DOM 变动监听（增量翻译）
  startObserveDOM();

  // 4. 将扫描到的块编入翻译队列
  originalBlocks.forEach((item, index) => {
    item.id = index;
  });
  // 4. 使用智能自适应算法分批发送翻译请求 (限制单包最多 8 个段落且总字符不超过 1000 字)
  // 降低每包大小能确保大模型在 2-3 秒内快速返回译文，达成极其顺畅的渐进式加载体验
  const batches = packBlocksIntoBatches(originalBlocks, 8, 1000);

  processBatches(batches, settings.sourceLang, settings.targetLang, settings.translateEngine);
}

// 智能自适应打包函数
function packBlocksIntoBatches(blocks, maxCount = 50, maxCharLength = 5000) {
  const batches = [];
  let currentBatch = [];
  let currentChars = 0;

  for (let block of blocks) {
    const blockLen = block.text ? block.text.length : 0;
    
    // 如果当前包非空，且加入当前块会超出数量或字符长度限制，则打包当前批次并开新批次
    if (currentBatch.length > 0 && 
        (currentBatch.length >= maxCount || currentChars + blockLen > maxCharLength)) {
      batches.push(currentBatch);
      currentBatch = [];
      currentChars = 0;
    }
    
    currentBatch.push(block);
    currentChars += blockLen;
  }
  
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }
  
  return batches;
}

// 串行+并行控制，避免智谱 API 速率限制
async function processBatches(batches, sourceLang, targetLang, translateEngine) {
  // Google 免费通道更容易触发频率限制，因此单独收紧并发。
  const maxConcurrency =
    translateEngine === 'local-llm' ? 1 :
    translateEngine === 'google' ? 2 :
    translateEngine === 'zhipu' ? 3 : // 智谱收紧并发防限制
    5;
  let index = 0;

  async function runNext() {
    if (index >= batches.length || !isTranslating) return;
    const currentBatch = batches[index++];
    
    // 1. 发送前为本批次所有段落显示 Loading 骨架屏
    currentBatch.forEach(b => {
      insertLoadingSkeleton(b.element, b.id);
    });
    
    // 准备发送的扁平键值对数据包
    const payload = {};
    currentBatch.forEach(b => {
      payload[b.id] = b.text;
    });
    
    try {
      const response = await sendBatchTranslationMessage(payload, sourceLang, targetLang, translateEngine);
      if (response && response.success && response.results) {
        insertTranslations(response.results, currentBatch);
      } else {
        console.error('分批翻译失败:', response ? response.error : '未知错误');
        // 2. 失败时清除 Loading 骨架屏
        currentBatch.forEach(b => {
          removeLoadingSkeleton(b.element, b.id);
        });
      }
    } catch (err) {
      console.error('API 发送出错:', err);
      // 3. 出错时清除 Loading 骨架屏
      currentBatch.forEach(b => {
        removeLoadingSkeleton(b.element, b.id);
      });
    } finally {
      translatedBlocksCount += currentBatch.length;
      updateWidgetProgress();
      // 递归执行下一组
      runNext();
    }
  }

  // 启动并发通道
  for (let i = 0; i < Math.min(maxConcurrency, batches.length); i++) {
    // 300ms 错峰间隔启动，降低突发并发请求
    setTimeout(() => {
      runNext();
    }, i * 300);
  }
}

function sendBatchTranslationMessage(payload, sourceLang, targetLang, translateEngine) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({
      action: 'translate_batch',
      texts: payload,
      sourceLang,
      targetLang,
      translateEngine
    }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

// 插入骨架屏 Loading 占位节点
function insertLoadingSkeleton(originalEl, id) {
  if (originalEl.hasAttribute('data-glm-id')) return;
  const existingLoader = document.querySelector(`.glm-loading-placeholder[data-loading-id="${id}"]`);
  if (existingLoader) return;

  const loader = document.createElement('span');
  loader.className = 'glm-translated glm-loading-placeholder';
  loader.setAttribute('data-loading-id', id);
  originalEl.appendChild(loader);
}

// 移除骨架屏 Loading 占位节点
function removeLoadingSkeleton(originalEl, id) {
  const loader = document.querySelector(`.glm-loading-placeholder[data-loading-id="${id}"]`);
  if (loader) {
    loader.remove();
  }
}

// =======================================================
// 译文渲染与插入
// =======================================================

function insertTranslations(results, batch) {
  if (!results || typeof results !== 'object') return;

  // 第一步：遍历 batch 中所有段落，先统一移除 Loading 骨架屏
  // 不管 API 是否返回了该段落的翻译结果，骨架屏都必须被清理，避免成为孤儿空紫色条
  batch.forEach(b => {
    removeLoadingSkeleton(b.element, b.id);
  });

  Object.keys(results).forEach(idStr => {
    const id = parseInt(idStr, 10);
    const orig = batch.find(b => b.id === id);
    if (!orig) return;

    const translatedText = results[idStr] ? results[idStr].trim() : '';
    if (!translatedText) return;

    const originalEl = orig.element;
    
    // 检查是否已经翻译过，避免重复插入
    if (originalEl.hasAttribute('data-glm-id')) {
      const existingTrans = findExistingTranslation(originalEl);
      if (existingTrans) {
        existingTrans.innerHTML = '';
        renderTranslationContent(existingTrans, translatedText, orig.mathItems, orig.linkElements);
        syncOriginalStyle(originalEl, existingTrans);
        // 渲染后二次校验：如果翻译元素内无可见文字内容（可能只剩不可见的公式克隆节点），直接移除
        if (!existingTrans.textContent || !existingTrans.textContent.trim()) {
          existingTrans.remove();
          originalEl.removeAttribute('data-glm-id');
        } else {
          adjustParentLayout(originalEl);
        }
        return;
      }
    }

    const tag = originalEl.tagName.toLowerCase();
    originalEl.setAttribute('data-glm-id', orig.id);

    let transEl;
    // 统一使用子元素模式：译文作为子节点插入原文容器内部，
    // 避免在 flex/grid 父容器中插入兄弟节点破坏页面布局。
    // li/td/th 用 div，其余用 span（防止 div 插入 p/h1 等导致浏览器自动闭合标签）
    const transTag = (tag === 'li' || tag === 'td' || tag === 'th') ? 'div' : 'span';
    originalEl.setAttribute('data-glm-inline', 'true');
    if (!originalEl.querySelector('.glm-original-content')) {
      const wrapper = document.createElement('span');
      wrapper.className = 'glm-original-content';
      while (originalEl.firstChild) {
        wrapper.appendChild(originalEl.firstChild);
      }
      originalEl.appendChild(wrapper);
    }
    transEl = document.createElement(transTag);
    transEl.className = 'glm-translated';
    transEl.setAttribute('data-glm-translated', 'true');
    renderTranslationContent(transEl, translatedText, orig.mathItems, orig.linkElements);
    originalEl.appendChild(transEl);


    // 渲染后二次校验：如果翻译元素内没有可见文字内容，立即移除，绝不允许显示空紫色条
    if (!transEl.textContent || !transEl.textContent.trim()) {
      transEl.remove();
      originalEl.removeAttribute('data-glm-id');
      return;
    }

    syncOriginalStyle(originalEl, transEl);
    adjustParentLayout(originalEl);
  });

  // 刷新当前页面所处的隐藏/显示模式
  updateDisplayMode(displayMode);
}

// 辅助样式同步函数：同步原文的居中对齐、字号大小与粗细，保证译文排版与原文百分百一致
function syncOriginalStyle(originalEl, transEl) {
  if (!originalEl || !transEl) return;
  try {
    const origStyle = window.getComputedStyle(originalEl);
    if (origStyle) {
      if (origStyle.textAlign === 'center' || origStyle.textAlign === 'right') {
        transEl.style.setProperty('text-align', origStyle.textAlign, 'important');
      }
      transEl.style.setProperty('font-size', origStyle.fontSize, 'important');
      transEl.style.setProperty('font-weight', origStyle.fontWeight, 'important');
    }
  } catch (e) {
    console.warn('样式同步失败:', e);
  }
}

// 智能自适应父容器高度/折行宽容逻辑，解决特殊容器截断译文的问题
// 注意：只做最保守的调整（白空间折行和小固定高度容器），绝不修改 overflow 和 position，以免破坏页面原有的宽度约束布局
function adjustParentLayout(element) {
  if (!element) return;
  let current = element.parentElement;
  let depth = 0;
  const maxDepth = 5; // 向上查找5层
  
  while (current && current !== document.body && depth < maxDepth) {
    try {
      const computedStyle = window.getComputedStyle(current);
      let needsAdjustment = false;
      const originalStyles = {};
      
      // 1. 允许折行（解决 white-space: nowrap 导致文本横向溢出不换行的问题）
      if (computedStyle.whiteSpace === 'nowrap') {
        originalStyles.whiteSpace = current.style.whiteSpace;
        current.style.setProperty('white-space', 'normal', 'important');
        needsAdjustment = true;
      }
      
      // 2. 放宽固定高度限制（仅针对 < 120px 的小固定高度容器，如通知横幅、导航条等）
      const rawHeight = computedStyle.height;
      const heightPx = parseFloat(rawHeight);
      if (!isNaN(heightPx) && heightPx > 0 && heightPx < 120) {
        // 确认该高度确实是固定设定的（行内样式 / CSS 类），而非自然撑开的内容高度
        // 通过判断 scrollHeight 是否显著大于 clientHeight 来确定容器内容是否被截断
        if (current.scrollHeight > current.clientHeight + 2) {
          originalStyles.height = current.style.height;
          originalStyles.minHeight = current.style.minHeight;
          current.style.setProperty('min-height', rawHeight, 'important');
          current.style.setProperty('height', 'auto', 'important');
          needsAdjustment = true;

          // 如果该容器本身有 overflow:hidden 导致内容被隐藏，仅对纵向方向放开
          if (computedStyle.overflowY === 'hidden') {
            originalStyles.overflowY = current.style.overflowY;
            current.style.setProperty('overflow-y', 'visible', 'important');
          }
        }
      }
      
      // 3. 移除过小的最大高度限制（仅 < 120px 且确认有内容被截断时才调整）
      const maxHeightVal = computedStyle.maxHeight;
      if (maxHeightVal && maxHeightVal !== 'none') {
        const maxHeightPx = parseFloat(maxHeightVal);
        if (!isNaN(maxHeightPx) && maxHeightPx < 120 && current.scrollHeight > current.clientHeight + 2) {
          originalStyles.maxHeight = current.style.maxHeight;
          current.style.setProperty('max-height', 'none', 'important');
          needsAdjustment = true;
        }
      }
      
      if (needsAdjustment) {
        const existing = modifiedLayoutElements.find(item => item.element === current);
        if (!existing) {
          modifiedLayoutElements.push({
            element: current,
            originalStyles: originalStyles
          });
        } else {
          for (const key in originalStyles) {
            if (!(key in existing.originalStyles)) {
              existing.originalStyles[key] = originalStyles[key];
            }
          }
        }
      }
    } catch (e) {
      console.warn('调整父级布局样式失败:', e);
    }
    
    current = current.parentElement;
    depth++;
  }
}

// 辅助渲染函数：将翻译文本解析并混合插入 DOM 公式节点、超链接与文本公式
function renderTranslationContent(containerEl, translatedText, mathItems, linkElements) {
  // 1. 容错预处理：将大模型汉化或畸变的占位符高可靠还原为标准英文占位符
  if (translatedText) {
    translatedText = translatedText.replace(/\[\s*(公式|数学|math|m)_?(\d+)\s*\]/gi, ' [M_$2] ');
  }

  const hasMath = mathItems && mathItems.length > 0;
  if (!hasMath) {
    containerEl.textContent = translatedText;
    return;
  }

  // 按照占位符分割文本，匹配公式和超链接标记
  const parts = translatedText.split(/(\[\s*M_\d+\s*\])/gi);
  
  // 无需 activeContainer 嵌套，统一挂载在 containerEl

  parts.forEach(part => {
    if (!part) return;

    const trimmed = part.trim();
    if (/^\[\s*M_\d+\s*\]$/i.test(trimmed)) {
      const index = parseInt(trimmed.replace(/\D/g, ''), 10);
      const item = mathItems && mathItems[index];
      if (item) {
        if (item.type === 'node') {
          // 克隆原始 MathJax/KaTeX 渲染节点并安全地挂载到当前译文容器中
          const clonedNode = item.value.cloneNode(true);
          containerEl.appendChild(clonedNode);
        } else if (item.type === 'text') {
          // 纯文本格式公式（如 $x+y$），创建文本节点挂载
          const textNode = document.createTextNode(item.value);
          containerEl.appendChild(textNode);
        }
      }
    } else {
      // 普通翻译文本部分，创建文本节点挂载到当前译文容器中
      const textNode = document.createTextNode(part);
      containerEl.appendChild(textNode);
    }
  });
}

function findExistingTranslation(el) {
  return el.querySelector('.glm-translated[data-glm-translated="true"]');
}

// 恢复网页原文
function restorePage() {
  isTranslating = false;
  
  if (autoMinimizeTimeout) {
    clearTimeout(autoMinimizeTimeout);
    autoMinimizeTimeout = null;
  }

  // 停止动态 DOM 监听并清理标记
  stopObserveDOM();
  const scannedEls = document.querySelectorAll('[data-glm-scanned]');
  scannedEls.forEach(el => el.removeAttribute('data-glm-scanned'));
  
  // 1. 先解包 li/td/th 中的原文包裹 span（将子节点移回父元素），恢复原始 DOM 结构
  const inlineEls = document.querySelectorAll('[data-glm-inline]');
  inlineEls.forEach(el => {
    const wrapper = el.querySelector('.glm-original-content');
    if (wrapper) {
      // 将 wrapper 内的所有子节点移回 el（插在 wrapper 之前的位置）
      while (wrapper.firstChild) {
        el.insertBefore(wrapper.firstChild, wrapper);
      }
      wrapper.remove();
    }
    el.removeAttribute('data-glm-inline');
  });

  // 2. 清理译文元素
  const transEls = document.querySelectorAll('.glm-translated[data-glm-translated="true"]');
  transEls.forEach(el => el.remove());

  // 3. 清除原文的 data 标识
  const origEls = document.querySelectorAll('[data-glm-id]');
  origEls.forEach(el => el.removeAttribute('data-glm-id'));

  // 4. 清理 body 样式模式类与样式类
  document.body.classList.remove('glm-mode-translation-only', 'glm-mode-original-only', 'glm-mode-bilingual');
  ['highlight', 'text-only', 'dotted', 'italic', 'mask', 'weakening', 'blockquote'].forEach(s => {
    document.body.classList.remove(`glm-style-${s}`);
  });

  // 5. 清除控制面板
  const widget = document.getElementById('glm-widget');
  if (widget) widget.remove();

  // 6. 还原被动态修改了布局样式的父级元素样式
  modifiedLayoutElements.forEach(item => {
    try {
      const el = item.element;
      for (const prop in item.originalStyles) {
        const val = item.originalStyles[prop];
        el.style[prop] = val || '';
      }
    } catch (e) {
      console.warn('还原父级布局样式失败:', e);
    }
  });
  modifiedLayoutElements = [];
}

// 更新显示模式（双语对照/仅显示译文/仅显示原文）
function updateDisplayMode(mode) {
  displayMode = mode;
  document.body.classList.remove('glm-mode-translation-only', 'glm-mode-original-only', 'glm-mode-bilingual');
  
  if (mode === 'translation-only') {
    document.body.classList.add('glm-mode-translation-only');
  } else if (mode === 'original-only') {
    document.body.classList.add('glm-mode-original-only');
  } else {
    document.body.classList.add('glm-mode-bilingual');
  }
}

// =======================================================
// 网页右下角控制条 Widget
// =======================================================

function createOrUpdateWidget() {
  let widget = document.getElementById('glm-widget');
  if (!widget) {
    widget = document.createElement('div');
    widget.id = 'glm-widget';
    widget.className = 'glm-translate-widget';
    widget.innerHTML = `
      <div class="glm-widget-expanded-content">
        <div class="glm-widget-header">
          <span class="glm-widget-title">网页翻译</span>
          <div class="glm-widget-header-btns">
            <button class="glm-widget-btn-icon" id="glm-widget-minimize" title="折叠面板">&minus;</button>
            <button class="glm-widget-btn-icon" id="glm-widget-close" title="还原原文并关闭">&times;</button>
          </div>
        </div>
        <div class="glm-widget-progress">
          <div class="glm-progress-text">
            <span>翻译进度</span>
            <span id="glm-progress-percent">0%</span>
          </div>
          <div class="glm-progress-bar-bg">
            <div class="glm-progress-bar-fg" id="glm-progress-bar"></div>
          </div>
        </div>
        <div class="glm-widget-actions">
          <button class="glm-widget-btn ${displayMode === 'bilingual' ? 'active' : ''}" id="glm-btn-bilingual">对照</button>
          <button class="glm-widget-btn ${displayMode === 'translation-only' ? 'active' : ''}" id="glm-btn-trans">译文</button>
          <button class="glm-widget-btn ${displayMode === 'original-only' ? 'active' : ''}" id="glm-btn-orig">原文</button>
        </div>
      </div>
      <div class="glm-widget-collapsed-content">
        <img class="glm-widget-collapsed-logo" src="${chrome.runtime.getURL('icons/icon48.png')}" alt="" />
        <span class="glm-widget-collapsed-badge" id="glm-widget-collapsed-badge">0%</span>
      </div>
    `;
    document.body.appendChild(widget);

    // 读取并应用历史保存的位置坐标
    chrome.storage.local.get(['widgetPos'], (res) => {
      if (res.widgetPos && res.widgetPos.left && res.widgetPos.top) {
        widget.style.bottom = 'auto';
        widget.style.right = 'auto';
        widget.style.left = res.widgetPos.left;
        widget.style.top = res.widgetPos.top;
        
        // 面板初始挂载时是展开状态，为了防止历史坐标（如小球态最右侧）溢出屏幕右/下边界，进行防溢出修正
        const rect = widget.getBoundingClientRect();
        const maxLeft = window.innerWidth - rect.width - 16;
        const maxTop = window.innerHeight - rect.height - 16;
        
        const curLeft = parseFloat(res.widgetPos.left);
        const curTop = parseFloat(res.widgetPos.top);
        
        if (curLeft > maxLeft) {
          widget.style.left = `${Math.max(16, maxLeft)}px`;
        }
        if (curTop > maxTop) {
          widget.style.top = `${Math.max(16, maxTop)}px`;
        }
      }
    });

    // 绑定事件
    document.getElementById('glm-widget-close').addEventListener('click', (e) => {
      e.stopPropagation();
      restorePage();
    });
    
    document.getElementById('glm-widget-minimize').addEventListener('click', (e) => {
      e.stopPropagation();
      widget.classList.add('minimized');
    });

    // 拖拽相关状态变量
    let isDragging = false;
    let hasDragged = false;
    let startX = 0;
    let startY = 0;
    let initialLeft = 0;
    let initialTop = 0;

    // 实现拖拽定位绑定的函数
    function setupDrag(dragTarget) {
      dragTarget.addEventListener('mousedown', (e) => {
        // 如果点击的是内部按钮，则不要触发拖动
        if (e.target.closest('button') || e.target.closest('.glm-widget-header-btns')) {
          return;
        }

        isDragging = true;
        hasDragged = false;
        startX = e.clientX;
        startY = e.clientY;

        const rect = widget.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;

        // 清空 bottom 和 right 定位，使用 fixed 定位下的 left/top 控制坐标
        widget.style.bottom = 'auto';
        widget.style.right = 'auto';
        widget.style.left = `${initialLeft}px`;
        widget.style.top = `${initialTop}px`;

        // 拖拽时添加 dragging 类以暂时移除 transition 缓动动画，保证拖拽零延迟顺滑跟手
        widget.classList.add('dragging');

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        
        e.preventDefault();
      });
    }

    // 绑定可拖动区域：展开时的 header 区域，以及折叠后的整个小球区域
    const header = widget.querySelector('.glm-widget-header');
    const collapsedContent = widget.querySelector('.glm-widget-collapsed-content');
    setupDrag(header);
    setupDrag(collapsedContent);

    function onMouseMove(e) {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      // 位移超过 4 像素时判定为拖拽事件而非普通点击
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
        hasDragged = true;
      }

      let newLeft = initialLeft + dx;
      let newTop = initialTop + dy;

      // 限制拖拽位置不得超出当前浏览器视口范围
      const rect = widget.getBoundingClientRect();
      const maxLeft = window.innerWidth - rect.width;
      const maxTop = window.innerHeight - rect.height;

      newLeft = Math.max(0, Math.min(newLeft, maxLeft));
      newTop = Math.max(0, Math.min(newTop, maxTop));

      widget.style.left = `${newLeft}px`;
      widget.style.top = `${newTop}px`;
    }

    function onMouseUp() {
      isDragging = false;
      widget.classList.remove('dragging'); // 拖拽结束，移除 dragging 类以恢复 CSS 展开折叠的平滑过渡
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);

      // 保存最新拖拽位置到本地存储中
      const pos = {
        left: widget.style.left,
        top: widget.style.top
      };
      chrome.storage.local.set({ widgetPos: pos });
    }

    // 悬浮球点击事件（区分拖拽释放，防止拖拽完自动展开）
    widget.addEventListener('click', (e) => {
      if (hasDragged) {
        hasDragged = false; // 清除拖拽标志，不触发展开
        return;
      }
      if (widget.classList.contains('minimized')) {
        // 展开时清除自动收起定时器
        if (autoMinimizeTimeout) {
          clearTimeout(autoMinimizeTimeout);
          autoMinimizeTimeout = null;
        }

        // 仅当用户手动拖拽过或者应用了自定义位置时，才需要计算防溢出的像素级 left/top 坐标
        // 否则直接交由 CSS 处理，默认使用 right: 24px; bottom: 24px; 自动向上展开，绝不会截断
        if (widget.style.left && widget.style.left !== 'auto') {
          // 1. 暂时移除 minimized 并加入 dragging 以彻底禁用 transition 动画，进行真实尺寸测量
          const origVisibility = widget.style.visibility;
          widget.style.visibility = 'hidden';
          widget.classList.add('dragging');
          widget.classList.remove('minimized');
          const expandedRect = widget.getBoundingClientRect();
          const expandedWidth = expandedRect.width || 280;
          const expandedHeight = expandedRect.height || 180;
          
          // 恢复 minimized 和 dragging
          widget.classList.add('minimized');
          widget.classList.remove('dragging');
          widget.style.visibility = origVisibility;

          // 2. 获取折叠小球当前的 left 和 top 坐标
          const rect = widget.getBoundingClientRect();
          const currentLeft = rect.left;
          const currentTop = rect.top;
          
          let targetLeft = currentLeft;
          let targetTop = currentTop;

          const maxLeft = window.innerWidth - expandedWidth - 16; // 预留 16px 视口页边距
          const maxTop = window.innerHeight - expandedHeight - 16;

          if (targetLeft > maxLeft) {
            targetLeft = maxLeft; // 若展开后会超出右边缘，提前向左平移
          }
          if (targetTop > maxTop) {
            targetTop = maxTop; // 若展开后会超出底边缘，提前向上平移
          }

          // 3. 立即将防溢出的安全坐标应用到 widget 上，然后再移除 minimized 触发平滑过渡
          widget.style.left = `${Math.max(16, targetLeft)}px`;
          widget.style.top = `${Math.max(16, targetTop)}px`;
        }

        widget.classList.remove('minimized');
      }
    });
    
    const btnBilingual = document.getElementById('glm-btn-bilingual');
    const btnTrans = document.getElementById('glm-btn-trans');
    const btnOrig = document.getElementById('glm-btn-orig');

    btnBilingual.addEventListener('click', (e) => {
      e.stopPropagation();
      setActiveWidgetBtn(btnBilingual);
      updateDisplayMode('bilingual');
    });

    btnTrans.addEventListener('click', (e) => {
      e.stopPropagation();
      setActiveWidgetBtn(btnTrans);
      updateDisplayMode('translation-only');
    });

    btnOrig.addEventListener('click', (e) => {
      e.stopPropagation();
      setActiveWidgetBtn(btnOrig);
      updateDisplayMode('original-only');
    });
  } else {
    // 已存在时，重新恢复展开状态并同步内部的对照/译文/原文按钮 active 样式
    widget.classList.remove('minimized');
    
    // 更新控制条标题，因为上次翻译完后它可能变成了“翻译完成”
    const title = widget.querySelector('.glm-widget-title');
    if (title) title.textContent = '网页翻译';

    const btnBilingual = document.getElementById('glm-btn-bilingual');
    const btnTrans = document.getElementById('glm-btn-trans');
    const btnOrig = document.getElementById('glm-btn-orig');
    
    const setActive = (btn, active) => {
      if (btn) {
        if (active) btn.classList.add('active');
        else btn.classList.remove('active');
      }
    };
    
    setActive(btnBilingual, displayMode === 'bilingual');
    setActive(btnTrans, displayMode === 'translation-only');
    setActive(btnOrig, displayMode === 'original-only');
  }
  updateWidgetProgress();
}

function setActiveWidgetBtn(activeBtn) {
  const buttons = document.querySelectorAll('.glm-widget-btn');
  buttons.forEach(btn => btn.classList.remove('active'));
  activeBtn.classList.add('active');
}

function updateWidgetProgress() {
  const percentText = document.getElementById('glm-progress-percent');
  const progressBar = document.getElementById('glm-progress-bar');
  const collapsedBadge = document.getElementById('glm-widget-collapsed-badge');
  if (!percentText || !progressBar) return;

  const percentage = totalBlocksCount > 0 ? (translatedBlocksCount / totalBlocksCount) * 100 : 0;
  const roundedPercentage = Math.round(percentage);
  percentText.textContent = `${roundedPercentage}%`;
  progressBar.style.width = `${percentage}%`;
  
  if (collapsedBadge) {
    collapsedBadge.textContent = `${roundedPercentage}%`;
  }
  
  if (percentage >= 100) {
    isTranslating = false; // 翻译完成，重置状态以允许下一次增量翻译和更新 popup 按钮状态
    const title = document.querySelector('.glm-widget-title');
    if (title) title.textContent = '网页翻译 - 完成';
    if (collapsedBadge) collapsedBadge.classList.add('completed');

    // 翻译 100% 完成后，2 秒自动折叠面板为悬浮小球
    const widget = document.getElementById('glm-widget');
    if (widget && !widget.classList.contains('minimized') && !autoMinimizeTimeout) {
      autoMinimizeTimeout = setTimeout(() => {
        const currentWidget = document.getElementById('glm-widget');
        if (currentWidget && !currentWidget.classList.contains('minimized')) {
          currentWidget.classList.add('minimized');
        }
        autoMinimizeTimeout = null;
      }, 2000);
    }
  }
}

// =======================================================
// 划词翻译 (Floating Button & Bubble)
// =======================================================

let floatBtn = null;
let translationBubble = null;

// 鼠标按下时，如果点击了划词气泡或悬浮按钮之外的空白区域，立即关闭它们
document.addEventListener('mousedown', (e) => {
  if (
    (floatBtn && floatBtn.contains(e.target)) || 
    (translationBubble && translationBubble.contains(e.target))
  ) {
    return;
  }
  removeFloatElements();
});

// 从选区提取纯净英文，自动剔除已翻译的双语中文译文节点，避免对划词翻译造成干扰
function getCleanSelectionText(selection) {
  if (!selection || selection.rangeCount === 0) return '';
  try {
    const range = selection.getRangeAt(0);
    const container = document.createElement('div');
    container.appendChild(range.cloneContents());
    
    // 寻找并剥离选区内所有可能包含的译文或 Loading 骨架段落
    const transElements = container.querySelectorAll('.glm-translated');
    transElements.forEach(el => el.remove());
    
    return container.innerText ? container.innerText.trim() : '';
  } catch (err) {
    return selection.toString().trim();
  }
}

// 鼠标抬起时，检测划词并展示悬浮翻译小图标
document.addEventListener('mouseup', (e) => {
  // 点击了小图标或气泡内部，不需要清理
  if (
    (floatBtn && floatBtn.contains(e.target)) || 
    (translationBubble && translationBubble.contains(e.target))
  ) {
    return;
  }

  // 延迟检测选中，确保 Selection 已经更新
  setTimeout(() => {
    chrome.storage.local.get(['enableSelectionTranslate'], (res) => {
      // 默认开启划词翻译 (存储值为 undefined 或 true 时均开启)
      const isEnabled = res.enableSelectionTranslate !== false;
      if (!isEnabled) {
        removeFloatElements();
        return;
      }

      const selection = window.getSelection();
      const selectedText = getCleanSelectionText(selection);

      if (selectedText.length > 1 && /[a-zA-Z]/.test(selectedText)) {
        showFloatButton(selection);
      } else {
        removeFloatElements();
      }
    });
  }, 10);
});

function showFloatButton(selection) {
  removeFloatElements(); // 先清除可能存在的旧元素

  try {
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();

    // 缓存划词文本及选区坐标，防止点击浮标瞬间选区丢失
    lastSelectedText = getCleanSelectionText(selection);
    lastSelectionRect = {
      left: rect.left,
      top: rect.top,
      bottom: rect.bottom,
      right: rect.right,
      width: rect.width,
      height: rect.height
    };

    floatBtn = document.createElement('div');
    floatBtn.className = 'glm-float-btn';
    floatBtn.title = '划词翻译';
    
    // 使用扩展内打包的图标作为按钮内容
    const imgUrl = chrome.runtime.getURL('icons/icon.png');
    floatBtn.innerHTML = `<img src="${imgUrl}" alt="翻译图标" />`;

    // 定位在选中文字的下方居中
    floatBtn.style.left = `${rect.left + window.scrollX + rect.width / 2 - 14}px`;
    floatBtn.style.top = `${rect.bottom + window.scrollY + 6}px`;

    document.body.appendChild(floatBtn);

    // 绑定小图标点击事件
    floatBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const textToTranslate = lastSelectedText; // 使用缓存好的划词文本，避免因选区清空导致取到空文本
      removeFloatButtonOnly();
      
      // 显示载入中的气泡
      showSelectionBubble(textToTranslate, null, true);
      
      // 发送翻译单文本指令给后台
      chrome.storage.local.get(['targetLang', 'translateEngine'], (res) => {
        const targetLang = res.targetLang || 'zh';
        const engine = res.translateEngine || 'zhipu';
        chrome.runtime.sendMessage({
          action: 'translate_batch',
          texts: { "0": textToTranslate },
          sourceLang: 'auto',
          targetLang: targetLang,
          translateEngine: engine
        }, (response) => {
          if (response && response.success && response.results && response.results["0"]) {
            showSelectionBubble(textToTranslate, response.results["0"], false);
          } else {
            showSelectionBubble(textToTranslate, '翻译失败: ' + (response ? response.error : '未知错误'), false);
          }
        });
      });
    });
  } catch (err) {
    console.error('划词按钮显示失败', err);
  }
}

function showSelectionBubble(originalText, translatedText, isLoading) {
  // 如果已存在气泡卡片，先清理
  if (translationBubble) {
    translationBubble.remove();
    translationBubble = null;
  }

  // 获取划词的选择区域以定位气泡卡片，优先使用缓存的选区位置
  let rect = lastSelectionRect || { left: 100, bottom: 100, width: 200 };
  
  // 兜底再次尝试获取当前选区（如果是右键菜单触发，此时选区还在）
  const selection = window.getSelection();
  if (selection && selection.rangeCount > 0) {
    try {
      const currentRect = selection.getRangeAt(0).getBoundingClientRect();
      if (currentRect.width > 0 && currentRect.height > 0) {
        rect = currentRect;
      }
    } catch(e) {}
  }

  translationBubble = document.createElement('div');
  translationBubble.className = 'glm-translation-bubble';
  
  // 气泡内部 HTML 结构
  let bubbleHTML = `
    <div class="glm-bubble-header">
      <span class="glm-bubble-title">划词翻译</span>
      <div class="glm-bubble-actions">
        ${!isLoading ? '<button class="glm-bubble-copy" id="glm-bubble-copy" title="复制译文">📋</button>' : ''}
        <button class="glm-bubble-close" id="glm-bubble-close" title="关闭卡片">&times;</button>
      </div>
    </div>
    <div class="glm-bubble-content">
      <div class="glm-bubble-original">${escapeHtml(originalText)}</div>
  `;

  if (isLoading) {
    bubbleHTML += `
      <div class="glm-bubble-loading">
        <div class="glm-spinner"></div>
        <span>正在翻译中...</span>
      </div>
    `;
  } else {
    bubbleHTML += `
      <div class="glm-bubble-translated">${escapeHtml(translatedText)}</div>
    `;
  }

  bubbleHTML += `</div>`;
  translationBubble.innerHTML = bubbleHTML;

  // 定位气泡
  translationBubble.style.left = `${Math.min(window.innerWidth - 340, Math.max(10, rect.left + window.scrollX + rect.width / 2 - 160))}px`;
  translationBubble.style.top = `${rect.bottom + window.scrollY + 8}px`;

  document.body.appendChild(translationBubble);

  // 关闭气泡事件
  document.getElementById('glm-bubble-close').addEventListener('click', () => {
    if (translationBubble) {
      translationBubble.remove();
      translationBubble = null;
    }
  });

  // 复制译文事件
  if (!isLoading) {
    const copyBtn = document.getElementById('glm-bubble-copy');
    if (copyBtn) {
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(translatedText).then(() => {
          copyBtn.textContent = '✅';
          setTimeout(() => {
            if (copyBtn) copyBtn.textContent = '📋';
          }, 1500);
        }).catch(err => {
          console.error('复制失败', err);
        });
      });
    }
  }
}

function removeFloatButtonOnly() {
  if (floatBtn) {
    floatBtn.remove();
    floatBtn = null;
  }
}

function removeFloatElements() {
  removeFloatButtonOnly();
  if (translationBubble) {
    translationBubble.remove();
    translationBubble = null;
  }
}

// 辅助函数：显示全局轻吐司 (Toast)
function showFloatingToast(message, type = 'info') {
  let toast = document.createElement('div');
  toast.className = 'glm-toast';
  toast.style.cssText = `
    position: fixed;
    top: 24px;
    left: 50%;
    transform: translateX(-50%);
    background: ${type === 'error' ? '#ef4444' : '#1e1b4b'};
    color: #fff;
    padding: 10px 20px;
    border-radius: 8px;
    z-index: 1000000002;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 12px;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.3s;
  `;
  toast.textContent = message;
  document.body.appendChild(toast);
  
  // 触发渐入
  setTimeout(() => toast.style.opacity = '1', 50);
  
  // 3 秒后淡出并销毁
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// 辅助 HTML 转义函数，避免 XSS
function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// 8. 键盘快捷键匹配辅助函数
function matchShortcut(e, shortcutStr) {
  if (!shortcutStr) return false;
  
  const parts = shortcutStr.split('+').map(p => p.trim().toLowerCase());
  
  const hasCtrl = parts.includes('ctrl') || parts.includes('control');
  const hasAlt = parts.includes('alt');
  const hasShift = parts.includes('shift');
  const hasMeta = parts.includes('meta');
  
  const modifierKeys = ['ctrl', 'control', 'alt', 'shift', 'meta'];
  const keyName = parts.find(p => !modifierKeys.includes(p));
  
  if (!keyName) return false;
  
  const ctrlMatch = e.ctrlKey === hasCtrl;
  const altMatch = e.altKey === hasAlt;
  const shiftMatch = e.shiftKey === hasShift;
  const metaMatch = e.metaKey === hasMeta;
  
  let keyMatch = false;
  if (keyName === 'space') {
    keyMatch = e.key === ' ' || e.code.toLowerCase() === 'space';
  } else {
    keyMatch = e.key.toLowerCase() === keyName;
  }
  
  return ctrlMatch && altMatch && shiftMatch && metaMatch && keyMatch;
}

// 9. 键盘快捷键监听：触发翻译与恢复网页
document.addEventListener('keydown', (e) => {
  // 如果当前焦点在输入框、文本域中，则不触发快捷键
  const activeEl = document.activeElement;
  if (activeEl && (['input', 'textarea', 'select'].includes(activeEl.tagName.toLowerCase()) || activeEl.isContentEditable)) {
    return;
  }

  // 动态匹配自定义的翻译快捷键（默认为 Alt+C）
  if (matchShortcut(e, currentShortcut)) {
    e.preventDefault();
    chrome.storage.local.get(['apiKey', 'sourceLang', 'targetLang', 'displayMode', 'translatedColor', 'translateEngine'], (res) => {
      const engine = res.translateEngine || 'zhipu';
      const apiKey = res.apiKey;
      if (engine === 'zhipu' && !apiKey) {
        showFloatingToast('请先在插件 Popup 面板中配置大模型 API Key！', 'error');
        return;
      }
      startPageTranslation({
        apiKey: apiKey || '',
        sourceLang: res.sourceLang || 'auto',
        targetLang: res.targetLang || 'zh',
        displayMode: res.displayMode || 'bilingual',
        translatedColor: res.translatedColor || '#7c3aed',
        translateEngine: engine
      });
    });
  }

  // Alt + R: 恢复网页
  if (e.altKey && e.key.toLowerCase() === 'r') {
    e.preventDefault();
    restorePage();
  }
});

// =======================================================
// 10. 鼠标悬停按住修饰键翻译（Alt + Hover）
// =======================================================

// 递归查找鼠标所指向的最具体的、可翻译的块级文本节点
function findTranslatableBlock(element) {
  let el = element;
  while (el && el !== document.body) {
    if (!isTranslatable(el)) {
      el = el.parentElement;
      continue;
    }
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    let isBlock = BLOCK_TAGS.includes(tag);
    
    // 特殊处理 div 是否视作块级翻译（与 scanBlocks 保持一致：行内白名单判定）
    if (tag === 'div') {
      let hasNonInlineChild = false;
      for (let child of el.children) {
        if (!isTranslatable(child)) continue;
        const childTag = child.tagName.toLowerCase();
        if (!INLINE_TAGS.includes(childTag)) {
          hasNonInlineChild = true;
          break;
        }
      }
      if (!hasNonInlineChild) {
        // 检查它自身是否是一个真正的代码块容器。如果是，我们直接不翻译它，也不向上递归
        const cls = el.className && typeof el.className === 'string' ? el.className.toLowerCase() : '';
        const isCodeContainer = cls.includes('highlight') || cls.includes('code-block') || cls.includes('syntax') || cls.includes('monaco-editor');
        if (isCodeContainer) {
          el = el.parentElement;
          continue; // 直接跳过此纯代码容器
        }
        isBlock = true;
      }
    }
    
    if (isBlock) {
      const textInfo = extractTextAndMath(el);
      
      // 过滤表格单元格过短情况
      if (['td', 'th'].includes(tag)) {
        const words = textInfo.text.split(/\s+/).filter(w => w.length > 0);
        if (textInfo.text.length < 25 || words.length < 5) {
          el = el.parentElement;
          continue;
        }
      }
      
      const hasLetters = /[a-zA-Z]/.test(textInfo.text);
      const narrativeText = textInfo.text.replace(/\[\s*M_\d+\s*\]/gi, '');
      const hasNarrativeLetters = /[a-zA-Z]/.test(narrativeText);
      
      // 中文段落过滤
      const isTargetZh = /^zh/i.test(targetLang);
      let isChineseParagraph = false;
      if (isTargetZh) {
        const chineseChars = narrativeText.match(/[\u4e00-\u9fff]/g) || [];
        const totalNarrativeLen = narrativeText.replace(/\s+/g, '').length;
        if (totalNarrativeLen > 0 && (chineseChars.length / totalNarrativeLen) > 0.8) {
          isChineseParagraph = true;
        }
      }

      if (textInfo.text.length > 8 && hasLetters && hasNarrativeLetters && !isChineseParagraph && !isMetadataOrNoise(textInfo.text) && !isLinkDominatedBlock(el)) {
        return el;
      }
    }
    el = el.parentElement;
  }
  return null;
}

// 触发对单个悬浮文本块的异步翻译
function triggerHoverTranslation(el) {
  if (!el) return;
  // 避免在已翻译、正处于骨架屏加载、或者已有译文段落的元素上重复触发
  if (el.hasAttribute('data-glm-id') || el.hasAttribute('data-glm-scanned') || el.classList.contains('glm-translated') || findExistingTranslation(el)) {
    return;
  }

  // 设置扫描中状态防重入
  el.setAttribute('data-glm-scanned', 'true');
  const textInfo = extractTextAndMath(el);
  
  const batchItem = {
    id: 999999 + Math.floor(Math.random() * 100000), // 生成唯一 ID
    element: el,
    text: textInfo.text,
    mathItems: textInfo.mathItems,
    linkElements: textInfo.linkElements
  };

  // 1. 插入骨架屏 Loading
  insertLoadingSkeleton(el, batchItem.id);

  // 2. 发送单文本块翻译消息
  chrome.storage.local.get(['targetLang', 'translateEngine', 'apiKey'], (res) => {
    const engine = res.translateEngine || 'zhipu';
    const target = res.targetLang || 'zh';
    const apiKey = res.apiKey || '';

    if (engine === 'zhipu' && !apiKey) {
      removeLoadingSkeleton(el, batchItem.id);
      el.removeAttribute('data-glm-scanned');
      showFloatingToast('请先配置大模型 API Key！', 'error');
      return;
    }
    
    chrome.runtime.sendMessage({
      action: 'translate_batch',
      texts: { [batchItem.id]: batchItem.text },
      sourceLang: 'auto',
      targetLang: target,
      translateEngine: engine,
      apiKey: apiKey
    }, (response) => {
      if (response && response.success && response.results && response.results[batchItem.id]) {
        // 3. 渲染译文并同步样式
        insertTranslations(response.results, [batchItem]);
      } else {
        // 4. 失败清除 Loading
        removeLoadingSkeleton(el, batchItem.id);
        el.removeAttribute('data-glm-scanned');
        console.error('单段悬停翻译失败:', response ? response.error : '未知错误');
      }
    });
  });
}

// 全局鼠标悬浮监听与按键识别
document.addEventListener('mousemove', (e) => {
  if (!enableHoverTranslate) return;

  // 排除自身的组件元素
  if (e.target.closest('.glm-translate-widget') || e.target.closest('.glm-translation-bubble') || e.target.closest('.glm-float-btn')) {
    currentHoveredElement = null;
    return;
  }

  const block = findTranslatableBlock(e.target);
  currentHoveredElement = block;

  // 如果按住了 Alt 键且移动到可翻译的段落上，触发翻译
  if (e.altKey && block) {
    triggerHoverTranslation(block);
  }
});

// 支持按住 Alt 键瞬间对当前已悬浮的段落进行翻译
document.addEventListener('keydown', (e) => {
  if (!enableHoverTranslate) return;

  // 如果焦点在可输入节点中，则不触发
  const activeEl = document.activeElement;
  if (activeEl && (['input', 'textarea', 'select'].includes(activeEl.tagName.toLowerCase()) || activeEl.isContentEditable)) {
    return;
  }

  if (e.key === 'Alt' && currentHoveredElement) {
    triggerHoverTranslation(currentHoveredElement);
  }
});
