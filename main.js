/**
 * flyMD 文本翻译插件
 * 功能：选中文本后显示翻译选项，翻译结果在文本旁边浮动显示
 * 使用 Microsoft Edge 免费翻译 API
 * 
 * TODO:
 * 1.未来可扩展支持从外部文件加载完整语言列表
 * 2.修复翻译按钮浮动位置异常，目前在源码模式选择文本后切换模式后，按钮位置异常
 */

const SETTINGS_KEY = 'translatePluginSettings';
const TOOLBAR_ID = 'translate-floating-btn';
const RESULT_ID = 'translate-floating-result';

// 多语言支持
const LOCALE_LS_KEY = 'flymd.locale';

function detectLocale() {
    try {
        const nav = typeof navigator !== 'undefined' ? navigator : null;
        const lang = (nav && (nav.language || nav.userLanguage)) || 'en';
        const lower = String(lang || '').toLowerCase();
        if (lower.startsWith('zh')) return 'zh';
    } catch {
    }
    return 'en';
}

function getLocale() {
    try {
        const ls = typeof localStorage !== 'undefined' ? localStorage : null;
        const v = ls && ls.getItem(LOCALE_LS_KEY);
        if (v === 'zh' || v === 'en') return v;
    } catch {
    }
    return detectLocale();
}

function t(zh, en) {
    return getLocale() === 'en' ? en : zh;
}

// 默认设置
const defaultSettings = {
    targetLang: 'zh-Hans',
    sourceLang: 'auto',
    triggerMode: 'contextMenu'
};

// 语言列表
const LANGUAGES = [
    {code: 'auto', name: '自动检测', enName: 'Auto Detect'},
    {code: 'zh-Hans', name: '简体中文', enName: 'Simplified Chinese'},
    {code: 'zh-Hant', name: '繁体中文', enName: 'Traditional Chinese'},
    {code: 'en', name: '英语', enName: 'English'},
    {code: 'ja', name: '日语', enName: 'Japanese'},
    {code: 'ko', name: '韩语', enName: 'Korean'}
];

const state = {
    context: null,
    settings: {...defaultSettings},
    floatingBtn: null,
    resultPanel: null,
    selectionHandler: null,
    mousedownHandler: null,
    textareaObserver: null,
    isTranslating: false,
    lastSelection: null,
    lastSelectionRect: null,
    disposeLocaleListener: null,
    disposeContextMenu: null,
    // Microsoft Edge 认证相关
    accessToken: null,
    tokenExpireAt: -1,
    // 防抖相关
    debounceTimer: null,
    // 防止重复激活
    activated: false
};

// 加载设置
async function loadSettings(context) {
    try {
        const saved = await context.storage.get(SETTINGS_KEY);
        if (saved) {
            state.settings = {...defaultSettings, ...saved};
        }
    } catch (e) {
    }
}

// 保存设置
async function saveSettings(context, newSettings) {
    state.settings = {...state.settings, ...newSettings};
    await context.storage.set(SETTINGS_KEY, state.settings);
}

// 获取选中的文本
function getSelectedText(ctx) {
    if (ctx && ctx.selectedText && ctx.selectedText.trim()) {
        return ctx.selectedText.trim();
    }

    try {
        const sel = state.context.getSelection && state.context.getSelection();
        if (sel && sel.text && sel.text.trim()) {
            return sel.text.trim();
        }
    } catch {
    }

    try {
        const domSel = window.getSelection && window.getSelection();
        if (domSel && domSel.toString().trim()) {
            return domSel.toString().trim();
        }
    } catch {
    }

    return '';
}

// 获取选区的位置信息
function getSelectionRect() {
    // 方法1：使用 window.getSelection（适用于所见和阅读模式）
    try {
        const sel = window.getSelection && window.getSelection();
        if (sel && sel.rangeCount > 0) {
            const range = sel.getRangeAt(0);
            if (range) {
                const rect = range.getBoundingClientRect();
                if (rect && typeof rect.top === 'number' && typeof rect.left === 'number' && rect.top > 10 && rect.left > 10) {
                    return rect;
                }
            }
        }
    } catch (e) {
    }

    // 方法2：通过 textarea 计算选区位置
    try {
        const ctx = state.context;
        const selection = ctx && ctx.getSelection ? ctx.getSelection() : null;
        
        if (selection && selection.start !== selection.end) {
            const textarea = document.querySelector('.editor-shell textarea, .editor-surface textarea, .editor textarea');
            if (textarea) {
                const value = textarea.value;
                const currentStart = selection.start;
                const currentEnd = selection.end;
                
                const style = window.getComputedStyle(textarea);
                let lh = parseFloat(style.lineHeight || '');
                if (!lh || Number.isNaN(lh)) {
                    lh = (parseFloat(style.fontSize || '16') || 16) * 1.6;
                }
                const padTop = parseFloat(style.paddingTop || '0') || 0;
                const padLeft = parseFloat(style.paddingLeft || '0') || 0;
                
                const tab4 = (s) => s.replace(/\t/g, '    ');
                
                // 估算单字符宽度
                const measureCharWidth = () => {
                    try {
                        const font = `${style.fontStyle} ${style.fontVariant} ${style.fontWeight} ${style.fontSize} / ${style.lineHeight} ${style.fontFamily}`;
                        const canvas = document.createElement('canvas');
                        const ctx2d = canvas.getContext('2d');
                        if (!ctx2d) return 8;
                        ctx2d.font = font;
                        const w = ctx2d.measureText('0').width;
                        return (w && w > 0) ? w : 8;
                    } catch {
                        return 8;
                    }
                };
                
                const ch = measureCharWidth();
                const edRect = textarea.getBoundingClientRect();
                
                // 计算选区结束位置的行列
                const textBeforeEnd = value.substring(0, currentEnd);
                const linesBeforeEnd = textBeforeEnd.split('\n');
                const endLineIdx = Math.max(0, linesBeforeEnd.length - 1);
                const endColLen = tab4(linesBeforeEnd[endLineIdx] || '').length;
                
                // 使用选区结束位置作为按钮显示的基准点
                const top = edRect.top + padTop + endLineIdx * lh - textarea.scrollTop;
                const left = edRect.left + padLeft + endColLen * ch - textarea.scrollLeft;
                
                // 计算选中区域的宽度和高度
                const selectedLines = value.substring(currentStart, currentEnd).split('\n');
                const height = selectedLines.length * lh;
                const width = tab4(selectedLines[selectedLines.length - 1] || '').length * ch;
                
                return { top, left, bottom: top + height, right: left + width, width, height };
            }
        }
    } catch (e) {
    }

    return null;
}

// 检测当前编辑模式（使用宿主提供的 API）
function getCurrentMode() {
    try {
        // 宿主 API 直接挂在 window 上：
        // - flymdGetMode() 返回 'edit' | 'preview'
        // - flymdGetWysiwygEnabled() 返回 boolean
        const mode = typeof window.flymdGetMode === 'function' ? window.flymdGetMode() : 'edit';
        const wysiwyg = typeof window.flymdGetWysiwygEnabled === 'function' && window.flymdGetWysiwygEnabled();

        if (wysiwyg) return 'wysiwyg';
        return mode; // 'edit' | 'preview'
    } catch {
        return 'edit';
    }
}

// 检查当前模式是否应该显示翻译按钮
function shouldShowInCurrentMode() {
    // 右键菜单模式下，所有模式都支持
    if (state.settings.triggerMode === 'contextMenu') {
        return true;
    }
    
    // 浮动按钮模式：在所有编辑模式下都显示（包括源码、所见即所得、预览）
    return true;
}

// ==================== Microsoft Edge 翻译 API ====================

// 从 JWT token 解析过期时间
function getExpirationTimeFromToken(token) {
    try {
        const parts = token.split('.');
        if (parts.length !== 3) return Date.now() + 8 * 60 * 1000;

        const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
        return (payload.exp || 0) * 1000;
    } catch {
        return Date.now() + 8 * 60 * 1000;
    }
}

// 获取 Microsoft Edge 访问令牌
async function getAccessToken() {
    if (state.accessToken && Date.now() < state.tokenExpireAt - 2 * 60 * 1000) {
        return state.accessToken;
    }

    try {
        const response = await state.context.http.fetch('https://edge.microsoft.com/translate/auth', {
            method: 'GET',
            headers: {
                'Accept': '*/*',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0'
            }
        });

        const token = await response.text();

        if (!token || !token.match(/^[a-zA-Z0-9\-_]+(\.[a-zA-Z0-9\-_]+){2}$/)) {
            state.context.ui.notice(t('获取令牌失败：无效格式', 'Get token failed: Invalid format'), 'err');
            return null;
        }

        state.accessToken = token;
        state.tokenExpireAt = getExpirationTimeFromToken(token);

        return token;
    } catch (e) {
        state.context.ui.notice(t('获取令牌失败', 'Get token failed') + ': ' + e.message, 'err');
        return null;
    }
}

// 使用 Microsoft Translator API 翻译（支持指定源语言或自动检测）
async function translateWithMicrosoft(text, targetLang, sourceLang = null) {
    try {
        const accessToken = await getAccessToken();
        
        // 获取令牌失败
        if (!accessToken) {
            return null;
        }

        // 构建请求 URL
        let url = `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=${targetLang}`;

        // 如果指定了源语言且不是 auto，则添加 from 参数
        // Microsoft Translator 不指定 from 时会自动检测源语言
        if (sourceLang && sourceLang !== 'auto') {
            url += `&from=${sourceLang}`;
        }

        const response = await state.context.http.fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify([{Text: text}])
        });

        if (!response.ok) {
            state.context.ui.notice(t('Microsoft 翻译失败', 'Microsoft translation failed') + `: HTTP ${response.status}`, 'err');
            return null;
        }

        const data = await response.json();

        if (data && Array.isArray(data) && data.length > 0) {
            const result = data[0];
            if (result.translations && result.translations.length > 0) {
                return {
                    text: result.translations[0].text,
                    detectedLanguage: result.detectedLanguage?.language || null
                };
            }
        }

        // 检查是否有错误信息
        if (data && data.error) {
            state.context.ui.notice(t('Microsoft 翻译失败', 'Microsoft translation failed') + ': ' + (data.error.message || 'API error'), 'err');
            return null;
        }

        return null;
    } catch (e) {
        state.context.ui.notice(t('Microsoft 翻译失败', 'Microsoft translation failed') + ': ' + e.message, 'err');
        return null;
    }
}

// 使用 Google 翻译免费 API（备选）
async function translateWithGoogle(text, targetLang, sourceLang = null) {
    // 转换语言代码
    let googleLang = targetLang;
    if (targetLang === 'zh-Hans') googleLang = 'zh-CN';
    else if (targetLang === 'zh-Hant') googleLang = 'zh-TW';

    // Google 翻译 API：sl=auto 表示自动检测
    let url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${googleLang}&dt=t&q=${encodeURIComponent(text)}`;

    // 注意：Google 免费 API 不支持指定源语言，始终自动检测

    try {
        const response = await state.context.http.fetch(url, {
            method: 'GET'
        });

        if (!response.ok) {
            state.context.ui.notice(t('Google 翻译失败', 'Google translation failed') + `: HTTP ${response.status}`, 'err');
            return null;
        }

        const data = await response.json();

        if (data && data[0]) {
            const translatedText = data[0]
                .filter(item => item && item[0])
                .map(item => item[0])
                .join('');
            return translatedText;
        }

        return null;
    } catch (e) {
        state.context.ui.notice(t('Google 翻译失败', 'Google translation failed') + ': ' + e.message, 'err');
        return null;
    }
}

// 主翻译函数（优先使用 Microsoft，备选 Google）
async function translate(text) {
    if (!text) {
        return null;
    }

    const {targetLang, sourceLang} = state.settings;

    // 优先使用 Microsoft 翻译（支持自动检测源语言）
    const msResult = await translateWithMicrosoft(text, targetLang, sourceLang);
    
    if (msResult && msResult.text) {
        return msResult.text;
    }

    // 备选：Google 翻译
    const googleResult = await translateWithGoogle(text, targetLang, sourceLang);
    
    if (googleResult) {
        return googleResult;
    }

    return null;
}

// HTML 转义
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// 创建悬浮翻译按钮
function createFloatingBtn() {
    // 先清理可能存在的旧实例
    const existingBtn = document.getElementById(TOOLBAR_ID);
    if (existingBtn && existingBtn.parentNode) {
        existingBtn.parentNode.removeChild(existingBtn);
    }
    
    if (state.floatingBtn && state.floatingBtn.parentNode) {
        return;
    }

    const btn = document.createElement('div');
    btn.id = TOOLBAR_ID;
    btn.innerHTML = '🌐';
    btn.title = t('翻译选中文本', 'Translate Selection');
    btn.style.cssText = `
    position: fixed;
    z-index: 99998;
    display: none;
    width: 28px;
    height: 28px;
    border-radius: 6px;
    background: var(--bg, #fff);
    color: var(--fg, #222);
    box-shadow: 0 2px 8px rgba(0,0,0,0.15);
    cursor: pointer;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    user-select: none;
    transition: transform 0.15s, box-shadow 0.15s;
    border: 1px solid rgba(0,0,0,0.1);
  `;

    btn.addEventListener('mouseenter', () => {
        btn.style.transform = 'scale(1.1)';
        btn.style.boxShadow = '0 4px 12px rgba(0,0,0,0.2)';
    });

    btn.addEventListener('mouseleave', () => {
        btn.style.transform = 'scale(1)';
        btn.style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)';
    });

    btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        e.preventDefault();
        await doTranslate();
    });

    document.body.appendChild(btn);
    state.floatingBtn = btn;
}

// 创建翻译结果面板
function createResultPanel() {
    // 先清理可能存在的旧实例
    const existingPanel = document.getElementById(RESULT_ID);
    if (existingPanel && existingPanel.parentNode) {
        existingPanel.parentNode.removeChild(existingPanel);
    }
    
    if (state.resultPanel && state.resultPanel.parentNode) {
        return;
    }

    const panel = document.createElement('div');
    panel.id = RESULT_ID;
    panel.style.cssText = `
    position: fixed;
    z-index: 99999;
    display: none;
    max-width: 320px;
    min-width: 180px;
    background: var(--bg, #fff);
    color: var(--fg, #222);
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.2);
    overflow: hidden;
    font-size: 13px;
  `;

    document.body.appendChild(panel);
    state.resultPanel = panel;
}

// 显示悬浮按钮
function showFloatingBtn(rect) {
    if (!state.floatingBtn) createFloatingBtn();
    const btn = state.floatingBtn;

    const margin = 6;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;

    // 验证 rect 是否有效（允许宽高为0，只要有有效坐标）
    if (!rect || typeof rect.top !== 'number' || typeof rect.left !== 'number') {
        hideFloatingBtn();
        return;
    }

    let left = rect.right + margin;
    let top = rect.top;

    if (left + 40 > viewportWidth) {
        left = rect.left - 34;
    }

    if (left < 8) left = 8;
    if (top < 8) top = 8;
    if (top + 36 > viewportHeight) top = viewportHeight - 40;

    btn.style.left = `${left}px`;
    btn.style.top = `${top}px`;
    btn.style.display = 'flex';
}

// 隐藏悬浮按钮
function hideFloatingBtn() {
    if (state.floatingBtn) {
        state.floatingBtn.style.display = 'none';
    }
}

// 显示翻译结果面板
function showResultPanel(originalText, translatedText) {
    try {
        if (!state.resultPanel) {
            createResultPanel();
        }
        const panel = state.resultPanel;

        // 只显示翻译结果
        panel.innerHTML = `
    <div style="padding: 8px 10px;">
      <div style="line-height: 1.5;">${escapeHtml(translatedText)}</div>
    </div>
  `;

    // 使用保存的选区位置
    const rect = state.lastSelectionRect;
    const margin = 6;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;

    // 验证 rect 是否有效
    if (!rect || typeof rect.top !== 'number' || typeof rect.left !== 'number') {
        // 使用默认位置（屏幕中央偏上）
        const defaultLeft = Math.max(8, (viewportWidth - 320) / 2);
        const defaultTop = Math.max(8, viewportHeight * 0.3);
        panel.style.left = `${defaultLeft}px`;
        panel.style.top = `${defaultTop}px`;
        panel.style.display = 'block';
        hideFloatingBtn();
        return;
    }

    // 显示在选区下方，避免遮挡选中文本
    let left = rect.left;
    let top = rect.bottom + margin;

    panel.style.display = 'block';
    
    const panelRect = panel.getBoundingClientRect();

    // 调整位置，确保不超出视口
    if (left + panelRect.width > viewportWidth - 8) {
        left = viewportWidth - panelRect.width - 8;
    }
    if (left < 8) left = 8;
    
    // 如果下方空间不足，显示在选区上方
    if (top + panelRect.height > viewportHeight - 8) {
        top = rect.top - panelRect.height - margin;
    }
    if (top < 8) top = 8;

    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;

        hideFloatingBtn();
    } catch (e) {
        state.context.ui.notice(t('显示结果失败', 'Show result failed') + ': ' + e.message, 'err');
    }
}

// 隐藏翻译结果面板
function hideResultPanel() {
    if (state.resultPanel) {
        state.resultPanel.style.display = 'none';
    }
}

// 执行翻译
async function doTranslate() {
    if (state.isTranslating) {
        return;
    }

    const text = getSelectedText();
    
    if (!text) {
        state.context.ui.notice(t('请先选择文本', 'Please select text first'), 'err');
        return;
    }

    // 在翻译开始时保存选区位置（翻译完成后选区可能已改变）
    const rect = getSelectionRect();
    state.lastSelectionRect = rect;

    state.isTranslating = true;
    state.lastSelection = text;

    if (state.floatingBtn && state.settings.triggerMode === 'floating') {
        state.floatingBtn.innerHTML = '⏳';
    }

    try {
        const translatedText = await translate(text);

        if (translatedText) {
            showResultPanel(text, translatedText);
        } else {
            state.context.ui.notice(t('翻译失败，请检查网络', 'Translation failed, please check network'), 'err');
        }
    } catch (e) {
        state.context.ui.notice(t('翻译出错', 'Translation error') + ': ' + e.message, 'err');
    } finally {
        state.isTranslating = false;
        if (state.floatingBtn) {
            state.floatingBtn.innerHTML = '🌐';
        }
    }
}

// 更新悬浮按钮显示状态
function updateFloatingBtnVisibility() {
    if (state.debounceTimer) {
        clearTimeout(state.debounceTimer);
    }
    state.debounceTimer = setTimeout(() => {
        state.debounceTimer = null;
        doUpdateFloatingBtnVisibility();
    }, 150);
}

function doUpdateFloatingBtnVisibility() {
    if (state.settings.triggerMode !== 'floating') {
        hideFloatingBtn();
        return;
    }

    if (!shouldShowInCurrentMode()) {
        hideFloatingBtn();
        return;
    }

    const text = getSelectedText();

    if (!text || text.length === 0) {
        hideFloatingBtn();
        return;
    }

    if (state.isTranslating && text === state.lastSelection) {
        return;
    }

    const rect = getSelectionRect();
    if (rect) {
        showFloatingBtn(rect);
    } else {
        hideFloatingBtn();
    }
}

// 注册右键菜单
function registerContextMenu() {
    if (state.disposeContextMenu) {
        state.disposeContextMenu();
        state.disposeContextMenu = null;
    }

    // 右键菜单始终注册
    state.disposeContextMenu = state.context.addContextMenuItem({
        label: t('翻译选中文本', 'Translate Selection'),
        icon: '🌐',
        condition: (ctx) => {
            const text = getSelectedText(ctx);
            return text.length > 0;
        },
        onClick: async (ctx) => {
            await doTranslate();
        }
    });
}

// 注册选区监听
function registerSelectionWatcher() {
    // 防止重复注册
    if (state.selectionHandler) {
        return;
    }

    const handler = () => {
        updateFloatingBtnVisibility();
    };

    document.addEventListener('selectionchange', handler);
    state.selectionHandler = handler;

    try {
        const ctx = state.context;
        if (ctx && typeof ctx.onSelectionChange === 'function') {
            ctx.onSelectionChange(() => {
                updateFloatingBtnVisibility();
            });
        }
    } catch {
    }

    // 为 textarea 添加额外的事件监听（源码模式）
    // textarea 不会触发 selectionchange 事件，需要监听其他事件
    const addTextareaListeners = () => {
        const textareas = document.querySelectorAll('.editor-shell textarea, .editor-surface textarea, .editor textarea');
        textareas.forEach(textarea => {
            // 监听鼠标抬起事件（选择文本后）
            textarea.addEventListener('mouseup', handler);
            // 监听键盘抬起事件（键盘选择文本后）
            textarea.addEventListener('keyup', handler);
            // 监听从其他位置聚焦到 textarea 的情况
            textarea.addEventListener('focus', handler);
        });
    };
    
    // 初始添加监听
    addTextareaListeners();
    
    // 使用 MutationObserver 监听 DOM 变化，处理动态创建的 textarea
    const observer = new MutationObserver(() => {
        addTextareaListeners();
    });
    
    observer.observe(document.body, {
        childList: true,
        subtree: true
    });
    
    // 保存 observer 引用以便清理
    state.textareaObserver = observer;

    const mousedownHandler = (e) => {
        if (state.resultPanel && !state.resultPanel.contains(e.target) &&
            state.floatingBtn && !state.floatingBtn.contains(e.target)) {
            setTimeout(() => {
                if (!state.isTranslating) {
                    hideResultPanel();
                }
            }, 100);
        }
    };
    document.addEventListener('mousedown', mousedownHandler);
    state.mousedownHandler = mousedownHandler;
}

// 设置界面
export async function openSettings(context) {
    await loadSettings(context);

    const overlay = document.createElement('div');
    overlay.style.cssText = `
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 99999;
    display: flex;
    align-items: center;
    justify-content: center;
  `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
    background: var(--bg, #fff);
    color: var(--fg, #222);
    border-radius: 12px;
    padding: 20px 24px;
    max-width: 480px;
    width: 90%;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.2);
    max-height: 80vh;
    overflow-y: auto;
  `;

  // 过滤掉 auto 选项，用于目标语言列表
  const targetLangOptions = LANGUAGES
    .filter(lang => lang.code !== 'auto')
    .map(lang => 
      `<option value="${lang.code}" ${state.settings.targetLang === lang.code ? 'selected' : ''}>
        ${getLocale() === 'en' ? lang.enName : lang.name}
      </option>`
    ).join('');
  
  // 源语言列表包含 auto 选项
  const sourceLangOptions = LANGUAGES.map(lang => 
    `<option value="${lang.code}" ${state.settings.sourceLang === lang.code ? 'selected' : ''}>
      ${getLocale() === 'en' ? lang.enName : lang.name}
    </option>`
  ).join('');
  
  dialog.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
      <h3 style="margin: 0; font-size: 16px; font-weight: 600;">🌐 ${t('翻译设置', 'Translate Settings')}</h3>
      <button id="tp-close" style="border: none; background: transparent; font-size: 20px; cursor: pointer; opacity: 0.6; padding: 4px;">×</button>
    </div>
    
    <div style="margin-bottom: 14px;">
      <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px;">
        <input type="checkbox" id="tp-auto-show-btn" ${state.settings.triggerMode === 'floating' ? 'checked' : ''} style="cursor: pointer;">
        <span>${t('选中文本后自动显示翻译按钮', 'Auto-show button on selection')}</span>
      </label>
      <div style="margin-top: 6px; padding: 6px 8px; background: #e3f2fd; border: 1px solid #2196f3; border-radius: 4px; font-size: 11px; color: #0d47a1;">
        💡 ${t('提示：右键菜单选项需在左侧"扩展菜单管理"中设置。', 'Tip: The right-click menu option needs to be enabled in the "Extended Menu Management" on the left')}
      </div>
    </div>
    
    <div style="margin-bottom: 14px;">
      <label style="display: block; font-size: 13px; margin-bottom: 6px; font-weight: 500;">${t('源语言', 'Source Language')}</label>
      <select id="tp-source-lang" style="width: 100%; padding: 8px 10px; border-radius: 6px; border: 1px solid #ddd; font-size: 14px; box-sizing: border-box;">
        ${sourceLangOptions}
      </select>
      <div style="font-size: 11px; color: #888; margin-top: 4px;">${t('默认自动检测源语言', 'Auto detect source language by default')}</div>
    </div>
    
    <div style="margin-bottom: 14px;">
      <label style="display: block; font-size: 13px; margin-bottom: 6px; font-weight: 500;">${t('目标语言', 'Target Language')}</label>
      <select id="tp-target-lang" style="width: 100%; padding: 8px 10px; border-radius: 6px; border: 1px solid #ddd; font-size: 14px; box-sizing: border-box;">
        ${targetLangOptions}
      </select>
    </div>
    
    <div style="font-size: 12px; color: #888; margin-bottom: 16px; padding: 8px; background: rgba(0,0,0,0.03); border-radius: 6px;">
      ${t('使用 Microsoft 和 Google 免费服务，请注意限制速率。', 'Using Microsoft Translator free service,please limit the rate')}
    </div>
    
    <div style="display: flex; justify-content: flex-end; gap: 8px;">
      <button id="tp-cancel" style="padding: 8px 16px; border-radius: 6px; border: 1px solid #ddd; background: #f5f5f5; cursor: pointer; font-size: 13px;">${t('取消', 'Cancel')}</button>
      <button id="tp-save" style="padding: 8px 16px; border-radius: 6px; border: 1px solid #2563eb; background: #2563eb; color: #fff; cursor: pointer; font-size: 13px;">${t('保存', 'Save')}</button>
    </div>
  `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const closeBtn = dialog.querySelector('#tp-close');
    const cancelBtn = dialog.querySelector('#tp-cancel');
    const saveBtn = dialog.querySelector('#tp-save');
    const autoShowBtnCheckbox = dialog.querySelector('#tp-auto-show-btn');
    const sourceLangSelect = dialog.querySelector('#tp-source-lang');
    const targetLangSelect = dialog.querySelector('#tp-target-lang');

    const cleanup = () => {
        if (overlay.parentNode) {
            overlay.parentNode.removeChild(overlay);
        }
    };

    closeBtn.onclick = cleanup;
    cancelBtn.onclick = cleanup;
    overlay.onclick = (e) => {
        if (e.target === overlay) cleanup();
    };

    saveBtn.onclick = async () => {
        const newTriggerMode = autoShowBtnCheckbox.checked ? 'floating' : 'contextMenu';
        const oldTriggerMode = state.settings.triggerMode;

        await saveSettings(context, {
            triggerMode: newTriggerMode,
            sourceLang: sourceLangSelect.value,
            targetLang: targetLangSelect.value
        });

        cleanup();
        context.ui.notice(t('设置已保存', 'Settings saved'), 'ok');

        // 切换模式时更新浮动按钮显示状态
        if (newTriggerMode === 'contextMenu') {
            hideFloatingBtn();
        } else {
            updateFloatingBtnVisibility();
        }
    };
}

// 插件激活
export async function activate(context) {
    // 防止重复激活
    if (state.activated) {
        return;
    }
    state.context = context;
    await loadSettings(context);

    createFloatingBtn();
    createResultPanel();

    registerSelectionWatcher();
    registerContextMenu();

    context.addMenuItem({
        label: t('翻译选择文本', 'Translate'),
        children: [
            {
                label: t('设置...', 'Settings...'),
                onClick: () => {
                    openSettings(context);
                }
            }
        ]
    });

    const onLocaleChanged = () => {
        if (state.floatingBtn) {
            state.floatingBtn.title = t('翻译选中文本', 'Translate Selection');
        }
        registerContextMenu();
    };
    window.addEventListener('flymd:localeChanged', onLocaleChanged);
    state.disposeLocaleListener = () => {
        window.removeEventListener('flymd:localeChanged', onLocaleChanged);
    };

    state.activated = true;
    context.ui.notice(t('翻译插件已加载', 'Translate plugin loaded'), 'ok');
}

// 插件停用
export function deactivate() {

    // 清除防抖定时器
    if (state.debounceTimer) {
        clearTimeout(state.debounceTimer);
        state.debounceTimer = null;
    }
    
    // 移除选区监听
    if (state.selectionHandler) {
        document.removeEventListener('selectionchange', state.selectionHandler);
        state.selectionHandler = null;
    }
    
    // 移除 MutationObserver
    if (state.textareaObserver) {
        state.textareaObserver.disconnect();
        state.textareaObserver = null;
    }
    
    // 移除鼠标按下监听
    if (state.mousedownHandler) {
        document.removeEventListener('mousedown', state.mousedownHandler);
        state.mousedownHandler = null;
    }
    
    // 移除右键菜单
    if (state.disposeContextMenu) {
        state.disposeContextMenu();
        state.disposeContextMenu = null;
    }
    
    // 移除语言切换监听
    if (state.disposeLocaleListener) {
        state.disposeLocaleListener();
        state.disposeLocaleListener = null;
    }
    
    // 强制移除所有可能的浮动按钮实例
    const existingBtns = document.querySelectorAll(`#${TOOLBAR_ID}`);
    existingBtns.forEach(btn => {
        if (btn.parentNode) {
            btn.parentNode.removeChild(btn);
        }
    });
    
    // 强制移除所有可能的结果面板实例
    const existingPanels = document.querySelectorAll(`#${RESULT_ID}`);
    existingPanels.forEach(panel => {
        if (panel.parentNode) {
            panel.parentNode.removeChild(panel);
        }
    });
    
    // 清空状态
    state.floatingBtn = null;
    state.resultPanel = null;
    state.context = null;
    state.accessToken = null;
    state.tokenExpireAt = -1;
    state.lastSelection = null;
    state.lastSelectionRect = null;
    state.isTranslating = false;
    state.activated = false;
}