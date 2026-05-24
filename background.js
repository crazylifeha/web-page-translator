// GLM Web Translator Background Service Worker

const API_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

// 语言代码到名称的映射，以便给模型更明确的翻译指令
const LANG_MAP = {
  'auto': '自动检测',
  'zh': '中文',
  'en': '英语',
  'ja': '日语',
  'ko': '韩语',
  'fr': '法语',
  'de': '德语',
  'es': '西班牙语'
};

// 1. 初始化安装时创建右键菜单
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'glm-translate-selection',
    title: '翻译选中文字',
    contexts: ['selection']
  });
});

// 2. 右键菜单点击事件监听
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'glm-translate-selection' && info.selectionText) {
    const textToTranslate = info.selectionText;
    
    // 从 storage 中获取设置，并分发翻译引擎
    chrome.storage.local.get(['apiKey', 'targetLang', 'translateEngine', 'localApiUrl', 'localModelName', 'localApiKey'], (res) => {
      const engine = res.translateEngine || 'zhipu';
      const targetLang = res.targetLang || 'zh';
      
      const engineSettings = {
        engine: engine,
        apiKey: res.apiKey,
        localApiUrl: res.localApiUrl,
        localModelName: res.localModelName,
        localApiKey: res.localApiKey
      };
      
      if (engine === 'zhipu' && !res.apiKey) {
        chrome.tabs.sendMessage(tab.id, { 
          action: 'show_floating_message', 
          message: '请先在插件 Popup 面板中配置大模型 API Key！',
          type: 'error'
        });
        return;
      }

      // 发送通知告诉内容脚本正在翻译中
      chrome.tabs.sendMessage(tab.id, { 
        action: 'selection_translation_loading',
        originalText: textToTranslate
      });

      // 根据不同的翻译引擎，分发对应底层的翻译动作
      let translatePromise;
      if (engine === 'google') {
        translatePromise = translateBatchGoogle({ "0": textToTranslate }, 'auto', targetLang)
          .then(results => results["0"]);
      } else if (engine === 'microsoft') {
        translatePromise = translateBatchMicrosoft({ "0": textToTranslate }, 'auto', targetLang)
          .then(results => results["0"]);
      } else {
        // 走大模型 API (智谱或本地大模型) 翻译单句
        translatePromise = translateSingleText(textToTranslate, 'auto', targetLang, engineSettings);
      }

      translatePromise
        .then(translatedText => {
          chrome.tabs.sendMessage(tab.id, {
            action: 'show_selection_translation',
            originalText: textToTranslate,
            translatedText: translatedText
          });
        })
        .catch(err => {
          chrome.tabs.sendMessage(tab.id, {
            action: 'show_floating_message',
            message: '翻译出错: ' + err.message,
            type: 'error'
          });
        });
    });
  }
});

// 3. 消息监听：处理内容脚本和 popup 的请求
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'verify_key') {
    // 校验 API Key，返回完整的校验结果对象
    verifyApiKey(request.apiKey)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // 保持异步消息通道打开
  }

  if (request.action === 'translate_batch') {
    // 批量翻译网页段落，支持多种引擎分发
    const engine = request.translateEngine || 'zhipu';
    
    if (engine === 'google') {
      translateBatchGoogle(request.texts, request.sourceLang, request.targetLang)
        .then(results => sendResponse({ success: true, results }))
        .catch(err => sendResponse({ success: false, error: err.message }));
    } else if (engine === 'microsoft') {
      translateBatchMicrosoft(request.texts, request.sourceLang, request.targetLang)
        .then(results => sendResponse({ success: true, results }))
        .catch(err => sendResponse({ success: false, error: err.message }));
    } else {
      // 走大模型翻译（智谱大模型或本地大模型）
      chrome.storage.local.get(['apiKey', 'localApiUrl', 'localModelName', 'localApiKey'], (res) => {
        const engineSettings = {
          engine: engine,
          apiKey: res.apiKey || request.apiKey,
          localApiUrl: res.localApiUrl,
          localModelName: res.localModelName,
          localApiKey: res.localApiKey
        };
        
        if (engine === 'zhipu' && !engineSettings.apiKey) {
          sendResponse({ success: false, error: 'API Key 未配置' });
          return;
        }
        
        translateBatchTexts(request.texts, request.sourceLang, request.targetLang, engineSettings)
          .then(results => sendResponse({ success: true, results }))
          .catch(err => sendResponse({ success: false, error: err.message }));
      });
    }
    return true; // 保持异步消息通道打开
  }
});

// 4. 辅助函数：校验 API Key 是否有效
async function verifyApiKey(apiKey) {
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'glm-4-flash',
        messages: [
          { role: 'user', content: 'hi' }
        ],
        max_tokens: 5
      })
    });
    
    if (response.ok) {
      // 智能识别大模型厂商与型号
      let provider = '未知厂商';
      let model = '未知模型';
      
      // 根据智谱的 Key 典型特征进行判断 (32位.16位)
      const isZhipu = apiKey.includes('.') && apiKey.split('.').length === 2 && apiKey.split('.')[0].length === 32;
      
      if (isZhipu) {
        provider = '智谱 AI';
        model = 'GLM-4-Flash';
      } else if (apiKey.startsWith('sk-')) {
        provider = 'OpenAI/DeepSeek';
        model = 'API 兼容模型';
      }
      
      return { success: true, provider, model };
    } else {
      let errText = '';
      try {
        const errData = await response.json();
        errText = errData.error ? errData.error.message : response.statusText;
      } catch (e) {
        errText = await response.text() || response.statusText;
      }
      return { success: false, status: response.status, error: errText };
    }
  } catch (e) {
    return { success: false, error: '网络连接失败，请确认您的网络是否通畅，或是否可正常连接 open.bigmodel.cn。' };
  }
}

// 4.5. 统一的大模型请求路由（同时适配智谱 API 和本地大模型 API 兼容通道）
async function requestLLMTranslation(messages, isJsonMode, engineSettings) {
  const isLocal = engineSettings.engine === 'local-llm';
  const url = isLocal ? (engineSettings.localApiUrl || 'http://localhost:1234/v1/chat/completions') : 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
  const model = isLocal ? (engineSettings.localModelName || 'qwen2.5') : 'glm-4-flash';
  const apiKey = isLocal ? engineSettings.localApiKey : engineSettings.apiKey;

  const headers = {
    'Content-Type': 'application/json'
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const requestBody = {
    model: model,
    messages: messages,
    temperature: isJsonMode ? 0.2 : 0.3
  };

  // 部分本地大模型推理引擎（例如新版 LM Studio v0.3+）不支持 'json_object' 格式约束
  // 强行传递会导致 API 返回 HTTP 400 报错。因此仅对云端智谱 API 强制开启 JSON 模式，本地大模型依靠 System Prompt 约束即可
  if (isJsonMode && !isLocal) {
    requestBody.response_format = { type: 'json_object' };
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`大模型 API 访问错误 HTTP ${response.status}: ${errText}`);
  }

  const data = await response.json();
  if (data.choices && data.choices[0] && data.choices[0].message) {
    return data.choices[0].message.content.trim();
  } else {
    throw new Error('未知的 API 响应结构，未能提取到翻译文本');
  }
}

// 5. 辅助函数：翻译单文本 (用于划词翻译)
async function translateSingleText(text, sourceLang, targetLang, engineSettings) {
  const sourceName = LANG_MAP[sourceLang] || sourceLang;
  const targetName = LANG_MAP[targetLang] || targetLang;

  const messages = [
    { 
      role: 'system', 
      content: `你是一个专业的网页翻译助手。请将用户输入的文本从【${sourceName}】翻译为【${targetName}】。只输出翻译后的文本，不要输出任何解释、注释、Markdown 格式标记或额外回复。` 
    },
    { role: 'user', content: text }
  ];

  return requestLLMTranslation(messages, false, engineSettings);
}

// 6. 核心接口：批量翻译接口 (防接口频率限制，打包为 JSON 交互)
async function translateBatchTexts(textsArray, sourceLang, targetLang, engineSettings) {
  const maxRetries = 2;
  let attempt = 0;

  while (attempt <= maxRetries) {
    try {
      return await doTranslateBatch(textsArray, sourceLang, targetLang, engineSettings);
    } catch (err) {
      attempt++;
      if (attempt > maxRetries) {
        throw err;
      }
      console.warn(`翻译批次失败，正在进行第 ${attempt} 次重试... 错误: ${err.message}`);
      // 避退重试
      await new Promise(resolve => setTimeout(resolve, attempt * 1000));
    }
  }
}

// 实际发送翻译请求的函数
async function doTranslateBatch(textsDict, sourceLang, targetLang, engineSettings) {
  const sourceName = LANG_MAP[sourceLang] || sourceLang;
  const targetName = LANG_MAP[targetLang] || targetLang;

  // 将要翻译的扁平键值对对象转为 JSON 格式传给大模型
  const requestPayload = JSON.stringify(textsDict);

  const systemMessage = `你是一个专业的网页智能翻译助手。请将输入的 JSON 对象中所有的值（Value）翻译为【${targetName}】。
要求：
1. 保持原有的 JSON 结构，即键名（ID）必须与输入完全一致，不可更改。
2. 将对应的值替换为翻译后的【${targetName}】文本。如果值原本就是【${targetName}】则保持不变；如果是英文或其它非【${targetName}】语言，必须翻译为【${targetName}】。
3. 即使某些段落是图表说明（如 Figure X）、短句或包含专业术语，也请务必全部翻译为流畅的【${targetName}】，切勿漏翻或直接保留原文。
4. 必须绝对原样保留以 \`[M_...]\` 格式包裹的公式占位符（例如 [M_0] 等）！切勿翻译、修改其格式、数字或拼写（例如绝对不要修改为“[公式_0]”或“[数学_0]”）。
5. 直接输出合法的 JSON 文本，不要在输出中包含任何 Markdown 格式标记 or 额外回复。`;

  const messages = [
    { role: 'system', content: systemMessage },
    { role: 'user', content: requestPayload }
  ];

  const rawContent = await requestLLMTranslation(messages, true, engineSettings);
  
  // 清洗可能存在的 Markdown 代码块
  let cleanContent = rawContent;
  if (cleanContent.startsWith('```')) {
    cleanContent = cleanContent.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim();
  }
  
  try {
    const parsed = JSON.parse(cleanContent);
    return parsed; // 返回扁平的 { "id": "译文" } 对象
  } catch (parseErr) {
    console.error('JSON 解析失败。模型原始输出：', rawContent);
    throw new Error('无法解析模型返回的 JSON 数据：' + parseErr.message);
  }
}

// 7. 监听全局快捷键触发翻译
chrome.commands.onCommand.addListener((command) => {
  if (command === 'trigger-translation') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0] || !tabs[0].id) return;
      
      chrome.storage.local.get(['apiKey', 'sourceLang', 'targetLang', 'displayMode', 'translatedColor', 'translateEngine'], (res) => {
        const engine = res.translateEngine || 'zhipu';
        const apiKey = res.apiKey;
        if (engine === 'zhipu' && !apiKey) {
          chrome.tabs.sendMessage(tabs[0].id, {
            action: 'show_floating_message',
            message: '请先在插件 Popup 面板中配置大模型 API Key！',
            type: 'error'
          }, () => {
            if (chrome.runtime.lastError) { /* ignore */ }
          });
          return;
        }

        chrome.tabs.sendMessage(tabs[0].id, {
          action: 'start_translation',
          settings: {
            apiKey: apiKey,
            sourceLang: res.sourceLang || 'auto',
            targetLang: res.targetLang || 'zh',
            displayMode: res.displayMode || 'bilingual',
            translatedColor: res.translatedColor || '#7c3aed',
            translateEngine: engine
          }
        }, () => {
          if (chrome.runtime.lastError) { /* ignore */ }
        });
      });
    });
  }
});

// =======================================================
// 多翻译引擎支持 (谷歌/微软免 Key 免费通道)
// =======================================================

// 谷歌语言代码对齐
function getGoogleLangCode(lang) {
  if (lang === 'zh') return 'zh-CN';
  return lang;
}

// 微软语言代码对齐
function getMicrosoftLangCode(lang) {
  if (lang === 'zh') return 'zh-Hans';
  return lang;
}

// 1. 谷歌翻译免 Key 并发逻辑
async function translateBatchGoogle(textsDict, sourceLang, targetLang) {
  const keys = Object.keys(textsDict);
  if (keys.length === 0) return {};

  const sl = getGoogleLangCode(sourceLang);
  const tl = getGoogleLangCode(targetLang);

  // 并发拉取谷歌翻译结果
  const promises = keys.map(async (key) => {
    const text = textsDict[key];
    if (!text || !text.trim()) {
      return { key, translated: '' };
    }
    try {
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${encodeURIComponent(text)}`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Google HTTP ${res.status}`);
      }
      const data = await res.json();
      if (data && data[0]) {
        // 拼接多行段落的翻译
        const translatedText = data[0]
          .map(item => item[0])
          .filter(Boolean)
          .join('');
        return { key, translated: translatedText };
      }
      return { key, translated: text }; // fallback
    } catch (err) {
      console.error(`Google translate segment failed:`, err);
      // 若单段失败，保留原文以防整批崩溃
      return { key, translated: text };
    }
  });

  const resultsList = await Promise.all(promises);
  const results = {};
  resultsList.forEach(item => {
    results[item.key] = item.translated;
  });
  return results;
}

// 2. 微软 Edge 官方免 Key 批量翻译通道
let edgeToken = {
  value: '',
  expire: 0
};

// 获取或刷新 Edge JWT Token
async function getEdgeToken() {
  if (edgeToken.value && Date.now() < edgeToken.expire) {
    return edgeToken.value;
  }
  try {
    const res = await fetch('https://edge.microsoft.com/translate/auth');
    if (!res.ok) {
      throw new Error(`Edge auth HTTP ${res.status}`);
    }
    const token = await res.text();
    if (!token) {
      throw new Error('Edge auth returned empty token');
    }
    // 缓存 15 分钟
    edgeToken = {
      value: token,
      expire: Date.now() + 15 * 60 * 1000
    };
    return token;
  } catch (err) {
    console.error('Failed to get Edge translation token:', err);
    throw new Error('无法初始化微软翻译授权：' + err.message);
  }
}

async function translateBatchMicrosoft(textsDict, sourceLang, targetLang) {
  const keys = Object.keys(textsDict);
  if (keys.length === 0) return {};

  const token = await getEdgeToken();
  const to = getMicrosoftLangCode(targetLang);
  
  // 组装 query 字符串。如果 sourceLang 不是 auto，则传递 from
  let url = `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=${to}`;
  if (sourceLang !== 'auto') {
    const from = getMicrosoftLangCode(sourceLang);
    url += `&from=${from}`;
  }

  // 构造微软要求的批量请求体
  const bodyPayload = keys.map(key => ({ Text: textsDict[key] }));

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify(bodyPayload)
  });

  if (!res.ok) {
    const errText = await res.text();
    // 如果是 401 认证失效，清空 Token 缓存以便下次能重新获取
    if (res.status === 401) {
      edgeToken = { value: '', expire: 0 };
    }
    throw new Error(`Microsoft API HTTP ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const results = {};
  keys.forEach((key, index) => {
    const translationList = data[index] && data[index].translations;
    if (translationList && translationList[0]) {
      results[key] = translationList[0].text;
    } else {
      results[key] = textsDict[key]; // fallback 原文
    }
  });

  return results;
}


