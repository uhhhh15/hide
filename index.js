// --- START OF FILE hide.js ---

import { extension_settings, loadExtensionSettings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types, getRequestHeaders } from "../../../../script.js";

const extensionName = "hide-helper";
const defaultSettings = {
    enabled: true
};

// 缓存上下文
let cachedContext = null;

// DOM元素缓存 - 使用延迟初始化策略
const domCache = {
    hideLastNInput: null,
    saveBtn: null,
    currentValueDisplay: null,
    initialized: false, // 标记是否已成功初始化
    /**
     * 尝试初始化 DOM 缓存。
     * 成功则返回 true，失败则返回 false。
     */
    init() {
        // 如果已成功初始化，直接返回 true
        if (this.initialized) return true;

        console.debug(`[${extensionName}] Attempting to initialize DOM cache...`);
        this.hideLastNInput = document.getElementById('hide-last-n');
        this.saveBtn = document.getElementById('hide-save-settings-btn');
        this.currentValueDisplay = document.getElementById('hide-current-value');

        // 检查所有元素是否都已找到
        if (this.hideLastNInput && this.saveBtn && this.currentValueDisplay) {
            console.debug(`[${extensionName}] DOM cache initialized successfully.`);
            this.initialized = true; // 标记为成功
            return true;
        } else {
            console.debug(`[${extensionName}] domCache.init: Failed to find one or more elements this time.`);
            this.initialized = false; // 保持未初始化状态
            return false;
        }
    }
};

/**
 * 获取优化的上下文，如果缓存无效或 chat 不存在则重新获取
 */
function getContextOptimized() {
    if (!cachedContext || !cachedContext.chat) {
        cachedContext = getContext();
    }
    return cachedContext;
}

/**
 * 初始化扩展设置 (确保在 extension_settings 可用后调用)
 */
function loadSettings() {
    if (typeof extension_settings === 'undefined') {
        console.error(`[${extensionName}] loadSettings called but extension_settings is undefined!`);
        return;
    }
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    Object.assign(extension_settings[extensionName], {
        enabled: extension_settings[extensionName].enabled ?? defaultSettings.enabled
    });
}

/**
 * 创建UI面板 (移除 DOM 缓存初始化)
 */
function createUI() {
    const settingsHtml = `
    <div id="hide-helper-settings" class="hide-helper-container">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>隐藏助手</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="hide-helper-section">
                    <!-- 开启/关闭选项 -->
                    <div class="hide-helper-toggle-row">
                        <span class="hide-helper-label">插件状态:</span>
                        <select id="hide-helper-toggle">
                            <option value="enabled">开启</option>
                            <option value="disabled">关闭</option>
                        </select>
                    </div>
                </div>
                <hr class="sysHR">
            </div>
        </div>
    </div>`;
    $("#extensions_settings").append(settingsHtml);
    createInputWandButton();
    createPopup(); // 创建弹出框 HTML
    setupEventListeners(); // 设置事件监听器
    // 注意：不再在这里使用 setTimeout 初始化 domCache
}

/**
 * 创建输入区旁的按钮
 */
function createInputWandButton() {
    const buttonHtml = `
    <div id="hide-helper-wand-button" class="list-group-item flex-container flexGap5" title="隐藏助手">
        <span style="padding-top: 2px;"><i class="fa-solid fa-ghost"></i></span>
        <span>隐藏助手</span>
    </div>`;
    $('#data_bank_wand_container').append(buttonHtml);
}

/**
 * 创建弹出对话框 HTML
 */
function createPopup() {
    const popupHtml = `
    <div id="hide-helper-popup" class="hide-helper-popup" style="display: none;"> <!-- 初始隐藏 -->
        <div class="hide-helper-popup-title">隐藏助手设置</div>
        <div class="hide-helper-input-row">
            <button id="hide-save-settings-btn" class="hide-helper-btn">保存设置</button>
            <input type="number" id="hide-last-n" min="0" placeholder="隐藏最近N楼之前的消息">
            <button id="hide-unhide-all-btn" class="hide-helper-btn">取消隐藏</button>
        </div>
        <div class="hide-helper-current">
            <strong>当前隐藏设置:</strong> <span id="hide-current-value">无</span>
        </div>
        <div class="hide-helper-popup-footer">
            <button id="hide-helper-popup-close" class="hide-helper-close-btn">关闭</button>
        </div>
    </div>`;
    $('body').append(popupHtml);
}

/**
 * 获取当前角色/群组的隐藏设置 (确保返回完整结构)
 */
function getCurrentHideSettings() {
    const context = getContextOptimized();
    if (!context) return { hideLastN: 0, userConfigured: false };

    const isGroup = !!context.groupId;
    let targetData = null;

    if (isGroup) {
        const group = context.groups?.find(x => x.id == context.groupId);
        targetData = group?.data?.hideHelperSettings;
    } else {
        if (context.characters && context.characterId !== undefined && context.characterId < context.characters.length) {
           const character = context.characters[context.characterId];
           targetData = character?.data?.extensions?.hideHelperSettings;
        }
    }
    return targetData ? {
        hideLastN: targetData.hideLastN ?? 0,
        userConfigured: targetData.userConfigured ?? false,
    } : { hideLastN: 0, userConfigured: false };
}

/**
 * 保存当前角色/群组的隐藏设置 (移除 lastProcessedLength)
 */
async function saveCurrentHideSettings(hideLastN) {
    const context = getContextOptimized();
    if (!context) {
        console.error(`[${extensionName}] Cannot save settings: Context not available.`);
        return false;
    }
    const isGroup = !!context.groupId;
    const settingsToSave = {
        hideLastN: hideLastN >= 0 ? hideLastN : 0,
        userConfigured: true
    };

    if (isGroup) {
        const groupId = context.groupId;
        const group = context.groups?.find(x => x.id == groupId);
        if (!group) { console.error(`[${extensionName}] Cannot save settings: Group ${groupId} not found.`); return false; }
        group.data = group.data || {};
        group.data.hideHelperSettings = settingsToSave;
        try {
             const payload = { ...group, data: { ...(group.data || {}), hideHelperSettings: settingsToSave } };
             const response = await fetch('/api/groups/edit', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(payload) });
             if (!response.ok) { const txt = await response.text(); throw new Error(txt); }
             console.log(`[${extensionName}] Group settings saved successfully for ${groupId}`);
             return true;
        } catch (error) { console.error(`[${extensionName}] Error saving group settings for ${groupId}:`, error); toastr.error(`保存群组设置失败: ${error.message || error}`); return false; }
    } else { // 角色
        if (!context.characters || context.characterId === undefined || context.characterId >= context.characters.length) { console.error(`[${extensionName}] Cannot save settings: Character context invalid.`); return false; }
        const characterId = context.characterId;
        const character = context.characters[characterId];
        if (!character || !character.avatar) { console.error(`[${extensionName}] Cannot save settings: Character avatar not found for index ${characterId}.`); return false; }
        const avatarFileName = character.avatar;
        character.data = character.data || {};
        character.data.extensions = character.data.extensions || {};
        character.data.extensions.hideHelperSettings = settingsToSave;
        try {
            const payload = { avatar: avatarFileName, data: { extensions: { hideHelperSettings: settingsToSave } } };
            const response = await fetch('/api/characters/merge-attributes', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(payload) });
            if (!response.ok) { const txt = await response.text(); throw new Error(txt); }
            console.log(`[${extensionName}] Character settings saved successfully for ${avatarFileName}`);
            return true;
        } catch (error) { console.error(`[${extensionName}] Error saving character settings for ${avatarFileName}:`, error); toastr.error(`保存角色设置失败: ${error.message || error}`); return false; }
    }
}

/**
 * 更新当前设置显示 (确保 DOM 缓存已初始化)
 */
function updateCurrentHideSettingsDisplay() {
    // 尝试初始化 DOM 缓存，如果失败则退出
    if (!domCache.init()) {
         console.warn(`[${extensionName}] updateCurrentHideSettingsDisplay skipped: DOM cache not ready.`);
         return;
    }

    const currentSettings = getCurrentHideSettings();

    try {
        if (currentSettings.userConfigured && currentSettings.hideLastN > 0) {
            domCache.currentValueDisplay.textContent = currentSettings.hideLastN;
            domCache.hideLastNInput.value = currentSettings.hideLastN;
        } else {
            domCache.currentValueDisplay.textContent = '无';
            domCache.hideLastNInput.value = '';
        }
    } catch (error) {
        console.error(`[${extensionName}] Error updating display values:`, error);
        domCache.initialized = false; // 出错时重置状态，允许下次重试初始化
    }
}

/**
 * 防抖函数
 */
function debounce(fn, delay) {
    let timer;
    return function(...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
    };
}

/**
 * 防抖版本的全量检查
 */
const runFullHideCheckDebounced = debounce(runFullHideCheck, 250); // 防抖延迟 250ms

/**
 * 检查是否应该执行隐藏操作 (检查插件启用和用户配置)
 */
function shouldProcessHiding() {
    if (typeof extension_settings === 'undefined' || !extension_settings[extensionName]) {
        return false;
    }
    if (!extension_settings[extensionName].enabled) {
        return false;
    }
    const settings = getCurrentHideSettings();
    return settings.userConfigured === true;
}

/**
 * 全量隐藏检查 (唯一的检查逻辑)
 */
function runFullHideCheck() {
    if (!shouldProcessHiding()) {
        // console.debug(`[${extensionName}] Full check skipped: Not enabled or not configured.`);
        return;
    }

    const startTime = performance.now();
    const context = getContextOptimized();
    if (!context || !context.chat) {
        console.warn(`[${extensionName}] Full check aborted: Context or chat not available.`);
        return;
    }
    const chat = context.chat;
    const currentChatLength = chat.length;
    const settings = getCurrentHideSettings();
    const { hideLastN } = settings;

    // 处理 hideLastN <= 0 的情况：确保所有消息都可见
    if (hideLastN <= 0) {
        const toShow = [];
        for (let i = 0; i < currentChatLength; i++) {
            if (chat[i] && chat[i].is_system === true) {
                chat[i].is_system = false; // 更新数据
                toShow.push(i);
            }
        }
        if (toShow.length > 0) {
            try {
                const showSelector = toShow.map(id => `.mes[mesid="${id}"]`).join(',');
                if (showSelector) $(showSelector).attr('is_system', 'false'); // 更新 DOM
                console.log(`[${extensionName}] Full check (hideLastN=0): Showing ${toShow.length} previously hidden messages.`);
            } catch (error) {
                console.error(`[${extensionName}] Error showing messages during full check (hideLastN=0):`, error);
            }
        }
        // console.debug(`[${extensionName}] Full check completed (hideLastN=0) in ${performance.now() - startTime}ms`);
        return;
    }

    // 处理 hideLastN > 0 的情况
    const visibleStart = Math.max(0, currentChatLength - hideLastN);
    const toHide = [];
    const toShow = [];
    let changed = false;

    for (let i = 0; i < currentChatLength; i++) {
        const msg = chat[i];
        if (!msg) continue;

        const isCurrentlyHidden = msg.is_system === true;
        const shouldBeHidden = i < visibleStart;

        if (shouldBeHidden && !isCurrentlyHidden) {
            msg.is_system = true; // 更新数据
            toHide.push(i);
            changed = true;
        } else if (!shouldBeHidden && isCurrentlyHidden) {
            msg.is_system = false; // 更新数据
            toShow.push(i);
            changed = true;
        }
    }

    // 只有在数据变化时才更新 DOM
    if (changed) {
        try {
            if (toHide.length > 0) {
                const hideSelector = toHide.map(id => `.mes[mesid="${id}"]`).join(',');
                if (hideSelector) $(hideSelector).attr('is_system', 'true');
            }
            if (toShow.length > 0) {
                const showSelector = toShow.map(id => `.mes[mesid="${id}"]`).join(',');
                if (showSelector) $(showSelector).attr('is_system', 'false');
            }
            console.log(`[${extensionName}] Full check: Hiding ${toHide.length}, Showing ${toShow.length}`);
        } catch (error) {
            console.error(`[${extensionName}] Error updating DOM in full check:`, error);
        }
    }
    // console.debug(`[${extensionName}] Full check completed in ${performance.now() - startTime}ms`);
}

/**
 * 全部取消隐藏功能 (调用 saveCurrentHideSettings(0))
 */
async function unhideAllMessages() {
    const startTime = performance.now();
    console.log(`[${extensionName}] Unhiding all messages.`);
    const context = getContextOptimized();
    if (!context || !context.chat) { console.warn(`[${extensionName}] Unhide all aborted: Chat data not available.`); return; }
    const chat = context.chat;

    if (chat.length === 0) {
         await saveCurrentHideSettings(0); // 即使为空也要重置设置
         updateCurrentHideSettingsDisplay();
        return;
    }

    const toShow = [];
    for (let i = 0; i < chat.length; i++) {
        if (chat[i] && chat[i].is_system === true) {
            toShow.push(i);
        }
    }

    if (toShow.length > 0) {
        toShow.forEach(idx => { if (chat[idx]) chat[idx].is_system = false; });
        try {
            const showSelector = toShow.map(id => `.mes[mesid="${id}"]`).join(',');
            if (showSelector) $(showSelector).attr('is_system', 'false');
            console.log(`[${extensionName}] Unhide all: Showed ${toShow.length} messages`);
        } catch (error) {
            console.error(`[${extensionName}] Error updating DOM when unhiding all:`, error);
        }
    }

    // 重置隐藏设置为0并保存
    const success = await saveCurrentHideSettings(0);
    if (success) {
        updateCurrentHideSettingsDisplay(); // 更新UI显示
    } else {
        toastr.error("无法重置隐藏设置。");
    }
    // console.debug(`[${extensionName}] Unhide all completed in ${performance.now() - startTime}ms`);
}

/**
 * 设置UI元素的事件监听器 (确保打开 popup 时初始化缓存)
 */
function setupEventListeners() {
    // 弹出对话框按钮事件
    $('#hide-helper-wand-button').on('click', function() {
        // 检查插件状态
        if (typeof extension_settings === 'undefined' || !extension_settings[extensionName]?.enabled) {
            toastr.warning('隐藏助手当前已禁用或未加载，请在扩展设置中启用。');
            return;
        }

        // **关键：在显示 popup 前，确保 DOM 缓存已初始化**
        if (!domCache.init()) {
            toastr.error("无法加载隐藏助手界面元素，请稍后再试或刷新页面。");
            console.error(`[${extensionName}] Failed to initialize DOM cache on popup open.`);
            return;
        }

        updateCurrentHideSettingsDisplay(); // 更新显示值

        const $popup = $('#hide-helper-popup');
        $popup.css({ // 先设置基本样式，确保可见性和位置计算准确
            'display': 'block',
            'visibility': 'hidden', // 先隐藏，计算完位置再显示
            'position': 'fixed',
            'left': '50%',
            'transform': 'translateX(-50%)'
        });

        // 使用 setTimeout 0 延迟计算位置，确保 DOM 渲染完成
        setTimeout(() => {
            try {
                const popupHeight = $popup.outerHeight();
                if (!popupHeight) { // 如果高度无效，可能元素还未完全渲染
                     console.warn(`[${extensionName}] Popup height is 0, delaying position calculation again.`);
                     setTimeout(arguments.callee, 50); // 稍作延迟重试
                     return;
                }
                const windowHeight = $(window).height();
                // 保持顶部至少10px，底部至少50px的边距
                const topPosition = Math.max(10, Math.min((windowHeight - popupHeight) / 2, windowHeight - popupHeight - 50));
                $popup.css({
                    'top': topPosition + 'px',
                    'visibility': 'visible' // 计算完成，设为可见
                });
            } catch (error) {
                console.error(`[${extensionName}] Error calculating popup position:`, error);
                // 即使定位失败，也要确保弹出框可见
                $popup.css('visibility', 'visible');
            }
        }, 0);
    });

    // 弹出框关闭按钮
    $('#hide-helper-popup-close').on('click', function() {
        $('#hide-helper-popup').hide();
    });

    // 全局启用/禁用切换
    $('#hide-helper-toggle').on('change', function() {
        if (typeof extension_settings === 'undefined' || !extension_settings[extensionName]) return;
        const isEnabled = $(this).val() === 'enabled';
        extension_settings[extensionName].enabled = isEnabled;
        saveSettingsDebounced();
        if (isEnabled) {
            toastr.success('隐藏助手已启用');
            runFullHideCheckDebounced(); // 启用时检查一次
        } else {
            toastr.warning('隐藏助手已禁用');
            // 禁用时不自动取消隐藏
        }
    });

    // 输入框非负数处理
    const hideLastNInput = document.getElementById('hide-last-n');
    if (hideLastNInput) {
        hideLastNInput.addEventListener('input', (e) => {
            const value = parseInt(e.target.value);
            if (isNaN(value) || value < 0) {
                 e.target.value = '';
            } else {
                 e.target.value = value; // 只保留有效的非负整数
            }
        });
    }

    // 保存设置按钮
    $('#hide-save-settings-btn').on('click', async function() {
        // 确保缓存已初始化才能读取输入值
        if (!domCache.init()) { toastr.error("界面元素未就绪，无法保存。"); return; }

        const value = parseInt(domCache.hideLastNInput.value);
        const valueToSave = isNaN(value) || value < 0 ? 0 : value;
        const currentSettings = getCurrentHideSettings();
        // 只有当值改变或者之前从未配置过时才保存
        const hasChanged = (currentSettings.userConfigured && valueToSave !== currentSettings.hideLastN) || !currentSettings.userConfigured;

        if (hasChanged) {
            const $btn = $(this);
            const originalText = $btn.text();
            $btn.text('保存中...').prop('disabled', true);
            const success = await saveCurrentHideSettings(valueToSave);
            if (success) {
                runFullHideCheck(); // 保存成功后立即执行一次全量检查 (非防抖)
                updateCurrentHideSettingsDisplay();
                toastr.success('隐藏设置已保存');
            }
            // 恢复按钮状态，无论成功失败
            $btn.text(originalText).prop('disabled', false);
        } else {
            toastr.info('设置未更改');
        }
    });

    // 全部取消隐藏按钮
    $('#hide-unhide-all-btn').on('click', async function() {
        await unhideAllMessages();
    });

    // 统一的聊天更新处理函数 (调用防抖的全量检查)
    const handleChatUpdate = () => {
        // 再次检查插件是否启用
        if (typeof extension_settings !== 'undefined' && extension_settings[extensionName]?.enabled) {
            runFullHideCheckDebounced();
        }
    };

    // 监听聊天切换事件 (需要额外处理 UI 和缓存)
    eventSource.on(event_types.CHAT_CHANGED, () => {
        cachedContext = null; // 清除上下文缓存
        // 更新全局开关状态
        if (typeof extension_settings !== 'undefined' && extension_settings[extensionName]) {
            $('#hide-helper-toggle').val(extension_settings[extensionName].enabled ? 'enabled' : 'disabled');
        }
        updateCurrentHideSettingsDisplay(); // 更新当前角色的设置显示
        handleChatUpdate(); // 触发一次检查
    });

    // 监听其他聊天内容变化事件
    eventSource.on(event_types.MESSAGE_RECEIVED, handleChatUpdate);
    eventSource.on(event_types.MESSAGE_SENT, handleChatUpdate);
    eventSource.on(event_types.MESSAGE_DELETED, handleChatUpdate);
    eventSource.on(event_types.STREAM_END, handleChatUpdate);
}

// --- 初始化扩展: 使用原始代码的结构 ---
jQuery(async () => {
    // 依赖 SillyTavern 核心确保 extension_settings 在此回调执行时可用

    // 1. 初始化本扩展的设置
    loadSettings();

    // 2. 创建 UI 元素并设置事件监听器
    createUI();

    // 3. 延迟执行 UI 更新和初始检查
    setTimeout(() => {
        // 在 setTimeout 回调中，再次检查确保环境就绪
        if (typeof extension_settings !== 'undefined' && extension_settings[extensionName]) {
            // 设置全局开关的初始状态
            $('#hide-helper-toggle').val(extension_settings[extensionName].enabled ? 'enabled' : 'disabled');

            // 尝试更新显示 (这将首次尝试初始化 DOM 缓存)
            updateCurrentHideSettingsDisplay();

            // 初始加载时，仅当插件启用且用户已配置过时执行检查
            const currentSettings = getCurrentHideSettings();
            if (extension_settings[extensionName].enabled && currentSettings.userConfigured) {
                runFullHideCheck(); // 初始加载运行非防抖版本
            }
        } else {
            console.warn(`[${extensionName}] setTimeout callback executed but extension_settings is not ready.`);
        }
    }, 1500); // 保持 1.5 秒延迟，给 SillyTavern 足够时间加载
});

// --- END OF FILE hide.js ---
