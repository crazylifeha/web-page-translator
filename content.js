// Web Page Translator - content script

let isTranslating = false;
let originalBlocks = []; // 存储所有待翻译的节点和原始文本
let modifiedLayoutElements = []; // 暂存被动态修改了布局样式的元素及其原本 inline 样式
let translatedBlocksCount = 0;
let totalBlocksCount = 0;
let translatedColor = '#7c3aed';
let displayMode = 'bilingual'; // bilingual, translation-only, original-only
let currentShortcut = 'Alt+C';
let lastSelectedText = ''; // 记录上一次划词的原文文本
let lastSelectionRect = null; // 记录上一次划词的选择区坐标
let autoMinimizeTimeout = null; // 翻译完成后自动收起面板的定时器
let domObserver = null; // 网页 DOM 监听器，用于支持滚动动态加载的增量翻译
let pendingObserveBlocks = []; // 动态扫描到的待翻译积压队列
let observeTimeout = null; // 增量翻译的防抖定时器chrome.storage.local.get(['shortcutTrigger'], (res) => {
  if (res.shortcutTrigger) {
    currentShortcut = res.shortcutTrigger;
  }
});const BLOCK_TAGS = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'li', 'td', 'th', 'figcaption', 'summary', 'dd', 'dt'];chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'start_translation') {
    translatedColor = request.settings.translatedColor;
    displayMode = request.settings.displayMode;
    applyColorCSS(translatedColor);
    startPageTranslation(request.settings);
    sendResponse({ success: true });
  }

  if (request.action === 'restore_page') {
    restorePage();
    sendResponse({ success: true });
  }

  if (request.action === 'update_style') {
    translatedColor = request.color;
    applyColorCSS(translatedColor);
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
});function applyColorCSS(color) {
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

function isTranslatable(el) {
  const skipTags = ['script', 'style', 'code', 'pre', 'noscript', 'textarea', 'input', 'select', 'option', 'iframe', 'canvas', 'svg', 'math', 'button', 'noscript', 'annotation', 'semantics'];
  const tag = el.tagName.toLowerCase();
  
  if (skipTags.includes(tag)) return false;
  
  // 排除已翻译节点、控制条、划词浮窗等插件自身 DOM
  if (el.hasAttribute('data-glm-translated') || 
      el.classList.contains('glm-translate-widget') || 
      el.classList.contains('glm-translated') || 
      el.classList.contains('glm-float-btn') || 
      el.classList.contains('glm-translation-bubble')) {
    return false;
  }
  
  // 排除 MathJax / KaTeX 数学公式渲染出的复杂子节点，避免把公式当做独立文本翻译
  // 确保不要误杀大排版块级标签（如 p, li, dd, dt 等），哪怕它们包含公式或被加上了类名
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
}function extractTextAndMath(el) {
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
  }  let processedText = traverse(el);  processedText = processedText.replace(/\$\$([\s\S]+?)\$\$/g, (match) => {
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
}function isMetadataOrNoise(text) {
  if (!text) return true;
  // 先把 MATH 公式占位符完全移除，避免干扰字数与停用词比例的计算
  const cleanText = text.replace(/\[\s*M_\d+\s*\]/gi, '').trim();
  if (!cleanText) return true;  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const emails = cleanText.match(emailRegex);
  if (emails && emails.length >= 1) {
    // 若包含多个邮箱，或虽然只有1个邮箱但整体长度偏短（通常为联系人行），判定为元数据
    if (cleanText.length < 150 || emails.length >= 2) {
      return true;
    }
  }  const urlRegex = /https?:\/\/[^\s]+/g;
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
  }  if (words.length > 5) {
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

// 递归查找适合翻译的文本块
function scanBlocks(element, list) {
  if (!isTranslatable(element)) return;

  const tagName = element.tagName.toLowerCase();
  let isBlock = BLOCK_TAGS.includes(tagName);

  // 特殊处理 DIV：若无块级或容器子元素且包含文字，则视作块级翻译
  if (tagName === 'div') {
    const CONTAINER_TAGS = ['div', 'ul', 'ol', 'dl', 'table', 'tbody', 'thead', 'tr', 'section', 'article', 'main', 'aside', 'header', 'footer', 'form'];
    let hasBlockChild = false;
    for (let child of element.children) {
      if (!isTranslatable(child)) {
        continue; // 忽略公式节点等不可翻译子节点，避免干扰父 div 的 isBlock 判定
      }
      const childTag = child.tagName.toLowerCase();
      if (BLOCK_TAGS.includes(childTag) || CONTAINER_TAGS.includes(childTag)) {
        hasBlockChild = true;
        break;
      }
    }
    if (!hasBlockChild) {
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

    // 过滤规则：    const hasLetters = /[a-zA-Z]/.test(textInfo.text);
    const narrativeText = textInfo.text.replace(/\[\s*M_\d+\s*\]/gi, '');
    const hasNarrativeLetters = /[a-zA-Z]/.test(narrativeText);

    if (textInfo.text.length > 8 && hasLetters && hasNarrativeLetters && !isMetadataOrNoise(textInfo.text)) {
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
        // 确认该节点既没被翻译，也没被扫描加入增量待翻译队列
        if (!b.element.hasAttribute('data-glm-id') && !b.element.hasAttribute('data-glm-scanned')) {
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
}

function startPageTranslation(settings) {
  if (isTranslating) {
    // 避免重复运行扫描，只更新显示模式即可
    updateDisplayMode(settings.displayMode);
    return;
  }
  
  isTranslating = true;
  originalBlocks = [];
  translatedBlocksCount = 0;
  
  if (autoMinimizeTimeout) {
    clearTimeout(autoMinimizeTimeout);
    autoMinimizeTimeout = null;
  }  scanBlocks(document.body, originalBlocks);
  totalBlocksCount = originalBlocks.length;
  
  if (totalBlocksCount === 0) {
    showFloatingToast('未在当前页面检测到可翻译的英文文本。', 'info');
    isTranslating = false;
    return;
  }  createOrUpdateWidget();  startObserveDOM();  originalBlocks.forEach((item, index) => {
    item.id = index;
  });  // 降低每包大小能确保大模型在 2-3 秒内快速返回译文，达成极其顺畅的渐进式加载体验
  const batches = packBlocksIntoBatches(originalBlocks, 8, 1000);

  processBatches(batches, settings.sourceLang, settings.targetLang, settings.translateEngine);
}function packBlocksIntoBatches(blocks, maxCount = 50, maxCharLength = 5000) {
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
  // 限制最大并发数为 5，防止高频请求瞬间打向智谱 API 触发 429 速率限制而导致指数重试延迟
  // 如果是本地大模型，为了防止本地 CPU 推理发生算力抢占而卡死，将并发限制为 1，进行完全串行排队翻译
  const maxConcurrency = translateEngine === 'local-llm' ? 1 : 5;
  let index = 0;

  async function runNext() {
    if (index >= batches.length || !isTranslating) return;
    const currentBatch = batches[index++];    currentBatch.forEach(b => {
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
        console.error('分批翻译失败:', response ? response.error : '未知错误');        currentBatch.forEach(b => {
          removeLoadingSkeleton(b.element, b.id);
        });
      }
    } catch (err) {
      console.error('API 发送出错:', err);      currentBatch.forEach(b => {
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
    runNext();
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
  // 避免重复插入 Loading
  if (originalEl.hasAttribute('data-glm-id')) return;
  const existingLoader = document.querySelector(`.glm-loading-placeholder[data-loading-id="${id}"]`);
  if (existingLoader) return;

  const tag = originalEl.tagName.toLowerCase();
  
  if (tag === 'li' || tag === 'td' || tag === 'th') {
    const loader = document.createElement('div');
    loader.className = 'glm-translated glm-loading-placeholder';
    loader.setAttribute('data-loading-id', id);
    originalEl.appendChild(loader);
  } else {
    let targetTag = tag;
    if (!['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote'].includes(tag)) {
      targetTag = 'div';
    }
    const loader = document.createElement(targetTag);
    loader.className = 'glm-translated glm-loading-placeholder';
    loader.setAttribute('data-loading-id', id);
    originalEl.parentNode.insertBefore(loader, originalEl.nextSibling);
  }
}

// 移除骨架屏 Loading 占位节点
function removeLoadingSkeleton(originalEl, id) {
  const loader = document.querySelector(`.glm-loading-placeholder[data-loading-id="${id}"]`);
  if (loader) {
    loader.remove();
  }
}

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

    let targetTag = tag;
    if (!['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote'].includes(tag)) {
      targetTag = 'div';
    }

    let transEl;
    if (tag === 'li' || tag === 'td' || tag === 'th') {
      // 子元素模式：译文作为子节点插入原文容器内部
      // 需要先将原文内容包裹到 span.glm-original-content 中，
      // 以便译文模式下能单独隐藏原文内容而不影响译文显示
      originalEl.setAttribute('data-glm-inline', 'true');
      if (!originalEl.querySelector('.glm-original-content')) {
        const wrapper = document.createElement('span');
        wrapper.className = 'glm-original-content';
        // 将原文元素的所有子节点移入包裹 span
        while (originalEl.firstChild) {
          wrapper.appendChild(originalEl.firstChild);
        }
        originalEl.appendChild(wrapper);
      }
      transEl = document.createElement('div');
      transEl.className = 'glm-translated';
      transEl.setAttribute('data-glm-translated', 'true');
      renderTranslationContent(transEl, translatedText, orig.mathItems, orig.linkElements);
      originalEl.appendChild(transEl);
    } else {
      transEl = document.createElement(targetTag);
      transEl.className = 'glm-translated';
      transEl.setAttribute('data-glm-translated', 'true');
      renderTranslationContent(transEl, translatedText, orig.mathItems, orig.linkElements);
      originalEl.parentNode.insertBefore(transEl, originalEl.nextSibling);
    }


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
}function syncOriginalStyle(originalEl, transEl) {
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
}// 注意：只做最保守的调整（白空间折行和小固定高度容器），绝不修改 overflow 和 position，以免破坏页面原有的宽度约束布局
function adjustParentLayout(element) {
  if (!element) return;
  let current = element.parentElement;
  let depth = 0;
  const maxDepth = 5; // 向上查找5层
  
  while (current && current !== document.body && depth < maxDepth) {
    try {
      const computedStyle = window.getComputedStyle(current);
      let needsAdjustment = false;
      const originalStyles = {};      if (computedStyle.whiteSpace === 'nowrap') {
        originalStyles.whiteSpace = current.style.whiteSpace;
        current.style.setProperty('white-space', 'normal', 'important');
        needsAdjustment = true;
      }      const rawHeight = computedStyle.height;
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
      }      const maxHeightVal = computedStyle.maxHeight;
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
}function renderTranslationContent(containerEl, translatedText, mathItems, linkElements) {  if (translatedText) {
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
  const tag = el.tagName.toLowerCase();
  if (tag === 'li' || tag === 'td' || tag === 'th') {
    return el.querySelector('.glm-translated[data-glm-translated="true"]');
  } else {
    // 兄弟节点
    let sib = el.nextSibling;
    while (sib) {
      if (sib.nodeType === Node.ELEMENT_NODE && sib.classList.contains('glm-translated')) {
        return sib;
      }
      sib = sib.nextSibling;
    }
  }
  return null;
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
  scannedEls.forEach(el => el.removeAttribute('data-glm-scanned'));  const inlineEls = document.querySelectorAll('[data-glm-inline]');
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
  });  const transEls = document.querySelectorAll('.glm-translated[data-glm-translated="true"]');
  transEls.forEach(el => el.remove());  const origEls = document.querySelectorAll('[data-glm-id]');
  origEls.forEach(el => el.removeAttribute('data-glm-id'));  document.body.classList.remove('glm-mode-translation-only', 'glm-mode-original-only', 'glm-mode-bilingual');  const widget = document.getElementById('glm-widget');
  if (widget) widget.remove();  modifiedLayoutElements.forEach(item => {
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
}function updateDisplayMode(mode) {
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
        if (widget.style.left && widget.style.left !== 'auto') {          const origVisibility = widget.style.visibility;
          widget.style.visibility = 'hidden';
          widget.classList.add('dragging');
          widget.classList.remove('minimized');
          const expandedRect = widget.getBoundingClientRect();
          const expandedWidth = expandedRect.width || 280;
          const expandedHeight = expandedRect.height || 180;
          
          // 恢复 minimized 和 dragging
          widget.classList.add('minimized');
          widget.classList.remove('dragging');
          widget.style.visibility = origVisibility;          const rect = widget.getBoundingClientRect();
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
          }          widget.style.left = `${Math.max(16, targetLeft)}px`;
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
}function showFloatingToast(message, type = 'info') {
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

// HTML 转义，避免 XSS
function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}function matchShortcut(e, shortcutStr) {
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
}document.addEventListener('keydown', (e) => {
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
