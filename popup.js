// Web Page Translator - popup

document.addEventListener('DOMContentLoaded', () => {
  // DOM 元素引用
  const apiKeyInput = document.getElementById('api-key');
  const toggleVisibleBtn = document.getElementById('toggle-visible');
  const sourceLangSelect = document.getElementById('source-lang');
  const targetLangSelect = document.getElementById('target-lang');
  const displayModeSelect = document.getElementById('display-mode');
  const enableSelectionTranslateInput = document.getElementById('enable-selection-translate');
  const shortcutInput = document.getElementById('shortcut-trigger-input');
  const btnResetShortcut = document.getElementById('btn-reset-shortcut');
  const apiStatusBadge = document.getElementById('api-status');
  const btnTranslate = document.getElementById('btn-translate');
  const btnRestore = document.getElementById('btn-restore');
  const colorDots = document.querySelectorAll('.color-dot');
  const apiErrorMsg = document.getElementById('api-error-msg');
  const translateEngineSelect = document.getElementById('translate-engine');
  const zhipuConfigSection = document.getElementById('zhipu-config-section');
  const modelDetectedInfo = document.getElementById('model-detected-info');
  const detectedModelText = document.getElementById('detected-model-text');  const localLlmConfigSection = document.getElementById('local-llm-config-section');
  const localApiUrlInput = document.getElementById('local-api-url');
  const localApiKeyInput = document.getElementById('local-api-key');
  const localToggleVisibleBtn = document.getElementById('local-toggle-visible');
  const localApiStatusBadge = document.getElementById('local-api-status');
  const localApiErrorMsg = document.getElementById('local-api-error-msg');
  const localModelContainer = document.getElementById('local-model-container');

  let selectedColor = '#7c3aed';  function showModelDetectedInfo(text) {
    if (modelDetectedInfo && detectedModelText) {
      detectedModelText.textContent = `检测到模型：${text}`;
      modelDetectedInfo.style.display = 'flex';
    }
  }

  function hideModelDetectedInfo() {
    if (modelDetectedInfo) {
      modelDetectedInfo.style.display = 'none';
    }
  }  function toggleEngineConfigUI(engine) {
    if (!zhipuConfigSection || !localLlmConfigSection) return;    zhipuConfigSection.classList.add('card-hidden');
    localLlmConfigSection.classList.add('card-hidden');
    
    if (engine === 'zhipu') {
      zhipuConfigSection.classList.remove('card-hidden');
    } else if (engine === 'local-llm') {
      localLlmConfigSection.classList.remove('card-hidden');
      checkLocalLlmConnection();
    }
  }  chrome.storage.local.get(['apiKey', 'sourceLang', 'targetLang', 'displayMode', 'translatedColor', 'enableSelectionTranslate', 'shortcutTrigger', 'translateEngine', 'detectedModel', 'localApiUrl', 'localModelName', 'localApiKey'], (res) => {
    // 默认翻译引擎为 zhipu
    const activeEngine = res.translateEngine || 'zhipu';
    if (translateEngineSelect) translateEngineSelect.value = activeEngine;

    // 初始化本地大模型输入框值
    if (localApiUrlInput) {
      localApiUrlInput.value = res.localApiUrl || 'http://localhost:1234/v1/chat/completions';
    }
    if (localApiKeyInput) {
      localApiKeyInput.value = res.localApiKey || '';
    }

    toggleEngineConfigUI(activeEngine);

    if (res.apiKey) {
      apiKeyInput.value = res.apiKey;
      verifyApiKey(res.apiKey);
      if (res.detectedModel) {
        showModelDetectedInfo(res.detectedModel);
      }
    } else {
      updateStatusBadge('unset');
      hideModelDetectedInfo();
    }

    // 初始化本地大模型连接状态
    if (activeEngine === 'local-llm') {
      checkLocalLlmConnection();
    } else {
      renderLocalModelInput();
    }

    if (res.sourceLang) sourceLangSelect.value = res.sourceLang;
    if (res.targetLang) targetLangSelect.value = res.targetLang;
    if (res.displayMode) displayModeSelect.value = res.displayMode;    enableSelectionTranslateInput.checked = res.enableSelectionTranslate !== false;    const shortcutVal = res.shortcutTrigger || 'Alt+C';
    shortcutInput.value = shortcutVal;
    updateShortcutGuideDisplay(shortcutVal);
    
    if (res.translatedColor) {
      selectedColor = res.translatedColor;
      let matchedPreset = false;
      colorDots.forEach(dot => {
        const dotColor = dot.getAttribute('data-color');
        if (dotColor === selectedColor) {
          dot.classList.add('active');
          matchedPreset = true;
        } else {
          dot.classList.remove('active');
        }
      });

      const customColorPicker = document.getElementById('custom-color-picker');
      const customColorBtn = document.getElementById('custom-color-btn');
      if (customColorPicker && customColorBtn) {
        if (!matchedPreset) {
          customColorBtn.classList.add('active');
          customColorBtn.style.background = selectedColor;
          customColorPicker.value = selectedColor;
        } else {
          customColorBtn.classList.remove('active');
          customColorBtn.style.background = '';
        }
      }
    }

    // 查询当前网页的翻译状态，如果正在翻译，则将按钮置灰
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0] && tabs[0].id) {
        chrome.tabs.sendMessage(tabs[0].id, { action: 'query_status' }, (response) => {
          if (chrome.runtime.lastError) return;
          if (response && response.isTranslating) {
            setTranslatingButtonState();
          } else {
            restoreTranslateButtonState();
          }
        });
      }
    });
  });  function verifyApiKey(key) {
    if (!key) {
      updateStatusBadge('unset');
      return;
    }
    updateStatusBadge('checking');
    chrome.runtime.sendMessage({ action: 'verify_key', apiKey: key }, (response) => {      if (chrome.runtime.lastError) {
        updateStatusBadge('invalid', '无法与后台校验服务通信');
        return;
      }
      if (response && response.success) {
        updateStatusBadge('valid');
        const modelInfo = `${response.provider} - ${response.model}`;
        chrome.storage.local.set({ detectedModel: modelInfo });
        showModelDetectedInfo(modelInfo);
      } else {
        const errorDetail = response ? response.error : '未知错误';
        const statusDetail = response && response.status ? `[${response.status}] ` : '';
        updateStatusBadge('invalid', `${statusDetail}${errorDetail}`);
      }
    });
  }  function updateStatusBadge(status, reason = '') {
    apiStatusBadge.className = 'status-badge';    if (apiErrorMsg) {
      apiErrorMsg.style.display = 'none';
      apiErrorMsg.textContent = '';
    }

    if (status === 'unset') {
      apiStatusBadge.textContent = '未配置';
      apiStatusBadge.classList.add('status-unset');
      chrome.storage.local.remove('detectedModel');
      hideModelDetectedInfo();
    } else if (status === 'checking') {
      apiStatusBadge.textContent = '校验中...';
      apiStatusBadge.classList.add('status-checking');
    } else if (status === 'valid') {
      apiStatusBadge.textContent = '有效';
      apiStatusBadge.classList.add('status-valid');
    } else if (status === 'invalid') {
      apiStatusBadge.textContent = '无效';
      apiStatusBadge.classList.add('status-invalid');
      chrome.storage.local.remove('detectedModel');
      hideModelDetectedInfo();      if (apiErrorMsg && reason) {
        apiErrorMsg.textContent = reason;
        apiErrorMsg.style.display = 'block';
      }
    }
  }  function checkLocalLlmConnection() {
    if (!localApiUrlInput) return;
    const url = localApiUrlInput.value.trim();
    const apiKey = localApiKeyInput ? localApiKeyInput.value.trim() : '';
    
    if (!url) {
      updateLocalStatus('unset');
      renderLocalModelInput();
      return;
    }
    
    updateLocalStatus('checking');
    
    // 构造标准的 OpenAI 兼容 models 端点
    let modelsUrl = url;
    if (url.endsWith('/chat/completions')) {
      modelsUrl = url.replace(/\/chat\/completions$/, '/models');
    } else if (url.endsWith('/')) {
      modelsUrl = url + 'v1/models';
    } else {
      if (!url.includes('/v1')) {
        modelsUrl = url + '/v1/models';
      } else {
        modelsUrl = url + '/models';
      }
    }

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    fetch(modelsUrl, { method: 'GET', headers })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP 错误 ${res.status}`);
        return res.json();
      })
      .then(data => {
        updateLocalStatus('valid');
        if (data && Array.isArray(data.data) && data.data.length > 0) {
          renderLocalModelSelect(data.data.map(m => m.id));
        } else if (data && Array.isArray(data.models) && data.models.length > 0) {
          renderLocalModelSelect(data.models.map(m => m.id || m.name));
        } else {
          renderLocalModelInput();
        }
      })
      .catch(err => {
        console.warn('获取 OpenAI 兼容的 /v1/models 失败，尝试 Ollama 原生 /api/tags', err);
        let ollamaBase = '';
        try {
          const u = new URL(url);
          ollamaBase = `${u.protocol}//${u.host}`;
        } catch (e) {
          ollamaBase = 'http://localhost:1234';
        }
        
        fetch(`${ollamaBase}/api/tags`)
          .then(res => {
            if (!res.ok) throw new Error(`HTTP 错误 ${res.status}`);
            return res.json();
          })
          .then(data => {
            updateLocalStatus('valid');
            if (data && Array.isArray(data.models) && data.models.length > 0) {
              renderLocalModelSelect(data.models.map(m => m.name));
            } else {
              renderLocalModelInput();
            }
          })
          .catch(err2 => {
            updateLocalStatus('invalid', `连接失败，请确认服务已启动。提示：如果使用 Ollama，请在启动时设置 OLLAMA_ORIGINS="*" 环境变量以允许扩展跨域连接。\n错误详情: ${err2.message}`);
            renderLocalModelInput();
          });
      });
  }

  function updateLocalStatus(status, reason = '') {
    if (!localApiStatusBadge) return;
    localApiStatusBadge.className = 'status-badge';
    
    if (localApiErrorMsg) {
      localApiErrorMsg.style.display = 'none';
      localApiErrorMsg.textContent = '';
    }

    if (status === 'unset') {
      localApiStatusBadge.textContent = '未连接';
      localApiStatusBadge.classList.add('status-unset');
    } else if (status === 'checking') {
      localApiStatusBadge.textContent = '校验中...';
      localApiStatusBadge.classList.add('status-checking');
    } else if (status === 'valid') {
      localApiStatusBadge.textContent = '连接成功';
      localApiStatusBadge.classList.add('status-valid');
    } else if (status === 'invalid') {
      localApiStatusBadge.textContent = '连接失败';
      localApiStatusBadge.classList.add('status-invalid');
      
      if (localApiErrorMsg && reason) {
        localApiErrorMsg.textContent = reason;
        localApiErrorMsg.style.display = 'block';
      }
    }
  }

  function renderLocalModelSelect(models) {
    if (!localModelContainer) return;
    
    chrome.storage.local.get(['localModelName'], (res) => {
      const savedModel = res.localModelName || '';
      let selected = savedModel;
      
      if (!models.includes(savedModel)) {
        selected = models[0] || '';
        chrome.storage.local.set({ localModelName: selected });
      }
      
      const optionsHtml = models.map(m => `<option value="${m}" ${m === selected ? 'selected' : ''}>${m}</option>`).join('');
      
      localModelContainer.innerHTML = `
        <div style="display: flex; gap: 8px; width: 100%;">
          <select id="local-model-name-select" style="flex: 1;">
            ${optionsHtml}
          </select>
          <button id="btn-refresh-local-models" type="button" title="刷新模型列表" style="
            padding: 0 8px;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 8px;
            color: var(--text-secondary);
            cursor: pointer;
            font-size: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
          ">🔄</button>
        </div>
      `;
      
      const selectEl = document.getElementById('local-model-name-select');
      if (selectEl) {
        selectEl.addEventListener('change', (e) => {
          chrome.storage.local.set({ localModelName: e.target.value });
        });
      }
      
      const refreshBtn = document.getElementById('btn-refresh-local-models');
      if (refreshBtn) {
        refreshBtn.addEventListener('click', checkLocalLlmConnection);
      }
    });
  }

  function renderLocalModelInput() {
    if (!localModelContainer) return;
    
    if (localModelContainer.querySelector('input[type="text"]') && !document.getElementById('local-model-name-select')) {
      return;
    }
    
    chrome.storage.local.get(['localModelName'], (res) => {
      const savedModel = res.localModelName || 'qwen2.5';
      
      localModelContainer.innerHTML = `
        <div style="display: flex; gap: 8px; width: 100%;">
          <input type="text" id="local-model-name" placeholder="请输入模型名称，如 qwen2.5" value="${savedModel}" style="flex: 1;" />
          <button id="btn-refresh-local-models-input" type="button" title="测试连接" style="
            padding: 0 8px;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 8px;
            color: var(--text-secondary);
            cursor: pointer;
            font-size: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
          ">🔄</button>
        </div>
      `;
      
      const inputEl = document.getElementById('local-model-name');
      if (inputEl) {
        inputEl.addEventListener('input', (e) => {
          chrome.storage.local.set({ localModelName: e.target.value.trim() });
        });
      }
      
      const refreshBtn = document.getElementById('btn-refresh-local-models-input');
      if (refreshBtn) {
        refreshBtn.addEventListener('click', checkLocalLlmConnection);
      }
    });
  }  let verifyTimeout;
  apiKeyInput.addEventListener('input', (e) => {
    const key = e.target.value.trim();
    chrome.storage.local.set({ apiKey: key });

    // 防抖校验，避免频繁请求 API
    clearTimeout(verifyTimeout);
    if (!key) {
      updateStatusBadge('unset');
      return;
    }
    updateStatusBadge('checking');
    verifyTimeout = setTimeout(() => {
      verifyApiKey(key);
    }, 1000);
  });  toggleVisibleBtn.addEventListener('click', () => {
    const type = apiKeyInput.getAttribute('type') === 'password' ? 'text' : 'password';
    apiKeyInput.setAttribute('type', type);
  });  let localVerifyTimeout;
  const triggerLocalConnectionCheck = () => {
    clearTimeout(localVerifyTimeout);
    updateLocalStatus('checking');
    localVerifyTimeout = setTimeout(() => {
      checkLocalLlmConnection();
    }, 1000);
  };

  if (localApiUrlInput) {
    localApiUrlInput.addEventListener('input', (e) => {
      const url = e.target.value.trim();
      chrome.storage.local.set({ localApiUrl: url });
      triggerLocalConnectionCheck();
    });
  }

  if (localApiKeyInput) {
    localApiKeyInput.addEventListener('input', (e) => {
      const key = e.target.value.trim();
      chrome.storage.local.set({ localApiKey: key });
      triggerLocalConnectionCheck();
    });
  }

  if (localToggleVisibleBtn && localApiKeyInput) {
    localToggleVisibleBtn.addEventListener('click', () => {
      const type = localApiKeyInput.getAttribute('type') === 'password' ? 'text' : 'password';
      localApiKeyInput.setAttribute('type', type);
    });
  }  sourceLangSelect.addEventListener('change', (e) => {
    chrome.storage.local.set({ sourceLang: e.target.value });
  });

  targetLangSelect.addEventListener('change', (e) => {
    chrome.storage.local.set({ targetLang: e.target.value });
  });

  displayModeSelect.addEventListener('change', (e) => {
    chrome.storage.local.set({ displayMode: e.target.value });
  });  enableSelectionTranslateInput.addEventListener('change', (e) => {
    chrome.storage.local.set({ enableSelectionTranslate: e.target.checked });
  });  if (translateEngineSelect) {
    translateEngineSelect.addEventListener('change', (e) => {
      const engine = e.target.value;
      chrome.storage.local.set({ translateEngine: engine });
      toggleEngineConfigUI(engine);
    });
  }  let isRecording = false;

  shortcutInput.addEventListener('focus', () => {
    isRecording = true;
    shortcutInput.value = '';
    shortcutInput.placeholder = '请按下快捷键组合...';
    shortcutInput.classList.add('recording');
  });

  shortcutInput.addEventListener('blur', () => {
    if (isRecording) {
      isRecording = false;
      shortcutInput.classList.remove('recording');
      chrome.storage.local.get(['shortcutTrigger'], (res) => {
        shortcutInput.value = res.shortcutTrigger || 'Alt+C';
      });
    }
  });

  shortcutInput.addEventListener('keydown', (e) => {
    if (!isRecording) return;
    
    e.preventDefault();
    e.stopPropagation();
    
    const keys = [];
    if (e.ctrlKey) keys.push('Ctrl');
    if (e.altKey) keys.push('Alt');
    if (e.shiftKey) keys.push('Shift');
    if (e.metaKey) keys.push('Meta');
    
    const key = e.key;
    const isModifier = ['Control', 'Alt', 'Shift', 'Meta'].includes(key);
    
    if (!isModifier) {
      let keyDisplayName = key.toUpperCase();
      if (key === ' ') keyDisplayName = 'Space';
      
      keys.push(keyDisplayName);
      
      // 必须搭配至少一个修饰键（Ctrl/Alt/Shift），防止单按字母键干扰网页正常打字输入
      if (keys.length <= 1) {
        shortcutInput.placeholder = '必须搭配 Ctrl/Alt/Shift 键！';
        shortcutInput.value = '';
        return;
      }
      
      const shortcutValue = keys.join('+');
      shortcutInput.value = shortcutValue;
      chrome.storage.local.set({ shortcutTrigger: shortcutValue });
      
      isRecording = false;
      shortcutInput.blur();
      
      updateShortcutGuideDisplay(shortcutValue);
      syncShortcutToCurrentTab(shortcutValue);
    } else {
      // 临时展示已经按下的修饰键
      shortcutInput.value = keys.join('+') + '+...';
    }
  });

  btnResetShortcut.addEventListener('click', (e) => {
    e.preventDefault();
    const defaultValue = 'Alt+C';
    shortcutInput.value = defaultValue;
    chrome.storage.local.set({ shortcutTrigger: defaultValue });
    updateShortcutGuideDisplay(defaultValue);
    syncShortcutToCurrentTab(defaultValue);
  });  colorDots.forEach(dot => {
    if (!dot.hasAttribute('data-color')) return;

    dot.addEventListener('click', () => {
      colorDots.forEach(d => d.classList.remove('active'));
      dot.classList.add('active');
      selectedColor = dot.getAttribute('data-color');
      chrome.storage.local.set({ translatedColor: selectedColor });

      // 恢复自定义颜色按钮的渐变色背景
      const customColorBtn = document.getElementById('custom-color-btn');
      if (customColorBtn) {
        customColorBtn.style.background = '';
      }

      // 实时向当前标签页发送样式更新通知
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0] && tabs[0].id) {
          chrome.tabs.sendMessage(tabs[0].id, { 
            action: 'update_style', 
            color: selectedColor 
          }, () => {
            // 忽略由于页面未加载 content.js 导致的报错
            if (chrome.runtime.lastError) { /* ignore */ }
          });
        }
      });
    });
  });  const customColorPicker = document.getElementById('custom-color-picker');
  const customColorBtn = document.getElementById('custom-color-btn');
  if (customColorPicker && customColorBtn) {
    // 点击自定义圆点按钮时触发原生的颜色拾色器
    customColorBtn.addEventListener('click', () => {
      customColorPicker.click();
    });

    const handleCustomColorChange = (e) => {
      const color = e.target.value;
      
      // 移除所有圆点的激活状态
      colorDots.forEach(d => d.classList.remove('active'));
      
      // 激活自定义圆点
      customColorBtn.classList.add('active');
      // 动态更新自定义圆点的背景，让用户能直观看到新选的颜色
      customColorBtn.style.background = color;
      
      selectedColor = color;
      chrome.storage.local.set({ translatedColor: color });
      
      // 实时向当前标签页发送样式更新通知
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0] && tabs[0].id) {
          chrome.tabs.sendMessage(tabs[0].id, { 
            action: 'update_style', 
            color: color 
          }, () => {
            if (chrome.runtime.lastError) { /* ignore */ }
          });
        }
      });
    };

    customColorPicker.addEventListener('input', handleCustomColorChange);
    customColorPicker.addEventListener('change', handleCustomColorChange);
  }  function getSettings(callback) {
    chrome.storage.local.get(['apiKey', 'sourceLang', 'targetLang', 'displayMode', 'translatedColor', 'translateEngine', 'localApiUrl', 'localModelName', 'localApiKey'], (res) => {
      callback({
        apiKey: res.apiKey || '',
        sourceLang: res.sourceLang || 'auto',
        targetLang: res.targetLang || 'zh',
        displayMode: res.displayMode || 'bilingual',
        translatedColor: res.translatedColor || '#7c3aed',
        translateEngine: res.translateEngine || 'zhipu',
        localApiUrl: res.localApiUrl || 'http://localhost:1234/v1/chat/completions',
        localModelName: res.localModelName || 'qwen2.5',
        localApiKey: res.localApiKey || ''
      });
    });
  }  function setTranslatingButtonState() {
    btnTranslate.disabled = true;
    btnTranslate.textContent = '正在翻译中...';
    btnTranslate.style.background = 'rgba(255, 255, 255, 0.15)';
    btnTranslate.style.cursor = 'not-allowed';
    btnTranslate.style.boxShadow = 'none';
  }  function restoreTranslateButtonState() {
    btnTranslate.disabled = false;
    btnTranslate.textContent = '翻译当前页面';
    btnTranslate.style.background = '';
    btnTranslate.style.cursor = '';
    btnTranslate.style.boxShadow = '';
  }  btnTranslate.addEventListener('click', () => {
    getSettings((settings) => {
      if (settings.translateEngine === 'zhipu' && !settings.apiKey) {
        alert('请先输入有效的大模型 API Key！');
        apiKeyInput.focus();
        return;
      }
      
      if (settings.translateEngine === 'local-llm' && !settings.localApiUrl) {
        alert('请先配置本地大模型 API 地址！');
        if (localApiUrlInput) localApiUrlInput.focus();
        return;
      }
      
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs[0] || !tabs[0].id) return;
        
        // 发送翻译指令
        chrome.tabs.sendMessage(tabs[0].id, { 
          action: 'start_translation', 
          settings: settings 
        }, (response) => {
          if (chrome.runtime.lastError) {
            alert('当前页面无法翻译。请刷新网页，或确保该页面不是 Chrome 系统页面（如 chrome:// 开头的页面）。');
          } else {
            // 发送成功，立即置灰按钮提示翻译进行中
            setTranslatingButtonState();
          }
        });
      });
    });
  });  btnRestore.addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0] || !tabs[0].id) return;
      chrome.tabs.sendMessage(tabs[0].id, { action: 'restore_page' }, (response) => {
        if (chrome.runtime.lastError) {
          alert('未能恢复页面，可能是内容脚本尚未加载，请刷新页面重试。');
        } else {
          // 恢复成功，还原翻译按钮状态
          restoreTranslateButtonState();
        }
      });
    });
  });  function updateShortcutGuideDisplay(shortcut) {
    const guideKeyEl = document.getElementById('guide-shortcut-key-web');
    if (guideKeyEl) {
      guideKeyEl.textContent = shortcut;
    }
  }  function syncShortcutToCurrentTab(shortcut) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0] && tabs[0].id) {
        chrome.tabs.sendMessage(tabs[0].id, {
          action: 'update_shortcut',
          shortcut: shortcut
        }, () => {
          if (chrome.runtime.lastError) { /* ignore */ }
        });
      }
    });
  }
});
