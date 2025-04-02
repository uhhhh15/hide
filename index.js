import { extension_settings, loadExtensionSettings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types, getRequestHeaders } from "../../../../script.js"; // <-- Added getRequestHeaders

const extensionName = "hide-helper";
const defaultSettings = {
    // 保留全局默认设置用于向后兼容
    // 注意：hideLastN 和 lastAppliedSettings 现在将存储在角色/群组数据中，而不是这里
    enabled: true
};

// 缓存上下文
let cachedContext = null;

// DOM元素缓存
const domCache = {
    hideLastNInput: null,
    saveBtn: null,
    currentValueDisplay: null,
    // 初始化缓存
    init() {
        this.hideLastNInput = document.getElementById('hide-last-n');
        this.saveBtn = document.getElementById('hide-save-settings-btn');
        this.currentValueDisplay = document.getElementById('hide-current-value');
    }
};

// 获取优化的上下文
function getContextOptimized() {
    if (!cachedContext) {
        cachedContext = getContext();
    }
    return cachedContext;
}

// 初始化扩展设置 (仅包含全局启用状态)
function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    if (Object.keys(extension_settings[extensionName]).length === 0 || typeof extension_settings[extensionName].enabled === 'undefined') {
        extension_settings[extensionName].enabled = defaultSettings.enabled;
    }
}

// 创建UI面板 - 修改为简化版本，只有开启/关闭选项
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

    // 将UI添加到SillyTavern扩展设置区域
    $("#extensions_settings").append(settingsHtml);

    // 创建聊天输入区旁边的按钮
    createInputWandButton();

    // 创建弹出对话框
    createPopup();

    // 设置事件监听器
    setupEventListeners();
    
    // 初始化DOM缓存
    setTimeout(() => domCache.init(), 100);
}

// 新增：创建输入区旁的按钮
function createInputWandButton() {
    const buttonHtml = `
    <div id="hide-helper-wand-button" class="list-group-item flex-container flexGap5" title="隐藏助手">
        <span style="padding-top: 2px;">
            <i class="fa-solid fa-ghost"></i>
        </span>
        <span>隐藏助手</span>
    </div>`;

    $('#data_bank_wand_container').append(buttonHtml);
}

// 新增：创建弹出对话框
function createPopup() {
    const popupHtml = `
    <div id="hide-helper-popup" class="hide-helper-popup">
        <div class="hide-helper-popup-title">隐藏助手设置</div>

        <!-- 输入行 - 保存设置按钮 + 输入框 + 取消隐藏按钮 -->
        <div class="hide-helper-input-row">
            <button id="hide-save-settings-btn" class="hide-helper-btn">保存设置</button>
            <input type="number" id="hide-last-n" min="0" placeholder="隐藏最近N楼之前的消息">
            <button id="hide-unhide-all-btn" class="hide-helper-btn">取消隐藏</button>
        </div>

        <!-- 当前隐藏设置 -->
        <div class="hide-helper-current">
            <strong>当前隐藏设置:</strong> <span id="hide-current-value">无</span>
        </div>

        <!-- 底部关闭按钮 -->
        <div class="hide-helper-popup-footer">
            <button id="hide-helper-popup-close" class="hide-helper-close-btn">关闭</button>
        </div>
    </div>`;

    $('body').append(popupHtml);
}

// 获取当前角色/群组的隐藏设置 (从角色/群组数据读取)
function getCurrentHideSettings() {
    const context = getContextOptimized();
    if (!context) return null; // 添加 context 检查

    const isGroup = !!context.groupId;
    let target = null;

    if (isGroup) {
        // 确保 groups 数组存在
        target = context.groups?.find(x => x.id == context.groupId);
        // 从 group.data 读取
        return target?.data?.hideHelperSettings || null;
    } else {
        // 确保 characters 数组和 characterId 存在且有效
        if (context.characters && context.characterId !== undefined && context.characterId < context.characters.length) {
           target = context.characters[context.characterId];
           // 从 character.data.extensions 读取 (遵循 V2 卡片规范)
           return target?.data?.extensions?.hideHelperSettings || null;
        }
    }

    return null; // 如果找不到目标或数据，返回 null
}


// 保存当前角色/群组的隐藏设置 (通过API持久化)
async function saveCurrentHideSettings(hideLastN) {
    const context = getContextOptimized();
    if (!context) {
        console.error(`[${extensionName}] Cannot save settings: Context not available.`);
        return false;
    }
    const isGroup = !!context.groupId;
    const chatLength = context.chat?.length || 0; // 在获取目标前计算，避免目标不存在时出错

    const settingsToSave = {
        hideLastN: hideLastN >= 0 ? hideLastN : 0, // 确保非负
        lastProcessedLength: chatLength,
        userConfigured: true
    };

    if (isGroup) {
        const groupId = context.groupId;
        // 确保 groups 数组存在
        const group = context.groups?.find(x => x.id == groupId);
        if (!group) {
             console.error(`[${extensionName}] Cannot save settings: Group ${groupId} not found in context.`);
             return false;
        }

        // 1. (可选) 修改内存对象 (用于即时反馈, 但API保存才是关键)
        group.data = group.data || {};
        group.data.hideHelperSettings = settingsToSave;

        // 2. 持久化 (发送API请求)
        try {
             // 构造发送给 /api/groups/edit 的完整群组对象
             const payload = {
                 ...group, // 包含ID和其他所有现有字段
                 data: { // 合并或覆盖 data 字段
                     ...(group.data || {}), // 保留 data 中其他可能存在的字段
                     hideHelperSettings: settingsToSave // 添加或更新我们的设置
                 }
             };

            console.log(`[${extensionName}] Saving group settings for ${groupId}:`, payload); // 调试日志
            const response = await fetch('/api/groups/edit', {
                method: 'POST',
                headers: getRequestHeaders(), // 使用 SillyTavern 的辅助函数获取请求头
                body: JSON.stringify(payload) // 发送整个更新后的群组对象
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`[${extensionName}] Failed to save group settings for ${groupId}: ${response.status} ${errorText}`);
                // 可选：显示错误给用户
                toastr.error(`保存群组设置失败: ${errorText}`);
                return false;
            }
            console.log(`[${extensionName}] Group settings saved successfully for ${groupId}`);
            return true;
        } catch (error) {
            console.error(`[${extensionName}] Error during fetch to save group settings for ${groupId}:`, error);
            toastr.error(`保存群组设置时发生网络错误: ${error.message}`);
            return false;
        }

    } else { // 是角色
        // 确保 characters 数组和 characterId 存在且有效
        if (!context.characters || context.characterId === undefined || context.characterId >= context.characters.length) {
             console.error(`[${extensionName}] Cannot save settings: Character context is invalid.`);
             return false;
        }
        const characterId = context.characterId; // 这是索引
        const character = context.characters[characterId];
        if (!character || !character.avatar) {
            console.error(`[${extensionName}] Cannot save settings: Character or character avatar not found at index ${characterId}.`);
            return false;
        }
        const avatarFileName = character.avatar; // 获取头像文件名作为唯一标识

        // 1. (可选) 修改内存对象
        character.data = character.data || {};
        character.data.extensions = character.data.extensions || {}; // 确保 extensions 对象存在
        character.data.extensions.hideHelperSettings = settingsToSave;

        // 2. 持久化 (调用 /api/characters/merge-attributes)
        try {
            // 构造发送给 /api/characters/merge-attributes 的部分数据
            const payload = {
                avatar: avatarFileName, // API 需要知道是哪个角色
                data: { // 只发送需要更新/合并的部分
                    extensions: {
                        hideHelperSettings: settingsToSave
                    }
                }
                // 注意：merge-attributes 会深层合并，所以这样只会更新 hideHelperSettings
            };

            console.log(`[${extensionName}] Saving character settings for ${avatarFileName}:`, payload); // 调试日志
            const response = await fetch('/api/characters/merge-attributes', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`[${extensionName}] Failed to save character settings for ${avatarFileName}: ${response.status} ${errorText}`);
                toastr.error(`保存角色设置失败: ${errorText}`);
                return false;
            }
            console.log(`[${extensionName}] Character settings saved successfully for ${avatarFileName}`);
            return true;
        } catch (error) {
            console.error(`[${extensionName}] Error during fetch to save character settings for ${avatarFileName}:`, error);
            toastr.error(`保存角色设置时发生网络错误: ${error.message}`);
            return false;
        }
    }
}

// 更新当前设置显示 - 优化使用DOM缓存
function updateCurrentHideSettingsDisplay() {
    const currentSettings = getCurrentHideSettings();
    
    if (!domCache.currentValueDisplay) {
        domCache.init();
        if (!domCache.currentValueDisplay) return;
    }
    
    if (currentSettings && currentSettings.hideLastN > 0) {
        domCache.currentValueDisplay.textContent = currentSettings.hideLastN;
    } else {
        domCache.currentValueDisplay.textContent = '无';
    }
    
    if (domCache.hideLastNInput) {
        domCache.hideLastNInput.value = currentSettings?.hideLastN > 0 ? currentSettings.hideLastN : '';
    }
}

// 防抖函数
function debounce(fn, delay) {
    let timer;
    return function(...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
    };
}

// 防抖版本的全量检查
const runFullHideCheckDebounced = debounce(runFullHideCheck, 200);

/**
 * 检查是否应该执行隐藏/取消隐藏操作
 * 只有当用户明确设置过隐藏规则并且插件启用时才返回true
 */
function shouldProcessHiding() {
    // 检查插件是否启用
    if (!extension_settings[extensionName].enabled) {
        // console.log(`[${extensionName}] Skipping hide processing: Plugin disabled.`); // 减少控制台噪音
        return false;
    }

    const settings = getCurrentHideSettings();
    // 如果没有设置，或者用户没有明确配置过，则不处理
    if (!settings || settings.userConfigured !== true) {
        // console.log(`[${extensionName}] Skipping hide processing: No user-configured settings found.`); // 减少控制台噪音
        return false;
    }
    return true;
}

/**
 * 增量隐藏检查 (用于新消息到达)
 * 仅处理从上次处理长度到现在新增的、需要隐藏的消息
 */
async function runIncrementalHideCheck() { // 改为 async 以便调用 saveCurrentHideSettings
    // 首先检查是否应该执行隐藏操作
    if (!shouldProcessHiding()) return;

    const startTime = performance.now();
    const context = getContextOptimized();
    if (!context || !context.chat) return; // 添加检查

    const chat = context.chat;
    const currentChatLength = chat.length; // 无需 ?.length，因为上面检查了 context.chat
    const settings = getCurrentHideSettings() || { hideLastN: 0, lastProcessedLength: 0, userConfigured: false }; // 提供默认值
    const { hideLastN, lastProcessedLength = 0 } = settings; // 从 settings 解构

    // --- 前置条件检查 ---
    if (currentChatLength === 0 || hideLastN <= 0) {
        if (currentChatLength > lastProcessedLength && settings.userConfigured) { // 只有当用户配置过且长度增加时才更新长度
            await saveCurrentHideSettings(hideLastN); // 使用 await 调用异步函数
        }
        // console.log(`[${extensionName}] Incremental check skipped: No chat or hideLastN<=0.`);
        return;
    }

    if (currentChatLength <= lastProcessedLength) {
        // 长度未增加或减少，说明可能发生删除或其他异常，应由 Full Check 处理
        // console.log(`[${extensionName}] Incremental check skipped: Chat length did not increase (${lastProcessedLength} -> ${currentChatLength}). Might be a delete.`);
        return;
    }

    // --- 计算范围 ---
    const targetVisibleStart = currentChatLength - hideLastN;
    const previousVisibleStart = lastProcessedLength > 0 ? Math.max(0, lastProcessedLength - hideLastN) : 0; // 处理首次的情况并确保非负

    // 必须目标 > 先前才有新增隐藏
    if (targetVisibleStart > previousVisibleStart) {
        const toHideIncrementally = [];
        const startIndex = previousVisibleStart; // 直接使用计算好的 previousVisibleStart
        const endIndex = Math.min(currentChatLength, targetVisibleStart); // 确保不超过当前长度

        // --- 收集需要隐藏的消息 ---
        for (let i = startIndex; i < endIndex; i++) {
            // 允许隐藏用户消息，只检查 is_system === false
            if (chat[i] && chat[i].is_system === false) {
                toHideIncrementally.push(i);
            }
        }

        // --- 执行批量更新 ---
        if (toHideIncrementally.length > 0) {
            console.log(`[${extensionName}] Incrementally hiding messages: ${toHideIncrementally.join(', ')}`);

            // 1. 批量更新数据 (chat 数组)
            toHideIncrementally.forEach(idx => { if (chat[idx]) chat[idx].is_system = true; });

            // 2. 批量更新 DOM
            try {
                // 使用属性选择器
                const hideSelector = toHideIncrementally.map(id => `.mes[mesid="${id}"]`).join(','); // DOM 选择器需要 .mes
                if (hideSelector) {
                    $(hideSelector).attr('is_system', 'true');
                }
            } catch (error) {
                console.error(`[${extensionName}] Error updating DOM incrementally:`, error);
            }

            // 3. 延迟保存 Chat (包含 is_system 的修改) - SillyTavern 通常有自己的保存机制，这里可能不需要
            // setTimeout(() => context.saveChatDebounced?.(), 100); // 考虑移除或确认是否必要

            // 4. 更新处理长度并保存设置（重要：现在需要 await）
            await saveCurrentHideSettings(hideLastN); // 在这里保存更新后的 lastProcessedLength

        } else {
             // console.log(`[${extensionName}] Incremental check: No messages needed hiding in the new range [${startIndex}, ${endIndex}).`);
             // 即使没有隐藏，如果长度变了，也需要更新设置中的 lastProcessedLength
             if (settings.lastProcessedLength !== currentChatLength && settings.userConfigured) {
                 await saveCurrentHideSettings(hideLastN);
             }
        }
    } else {
        // console.log(`[${extensionName}] Incremental check: Visible start did not advance or range invalid.`);
        // 即使没有隐藏，如果长度变了，也需要更新设置中的 lastProcessedLength
         if (settings.lastProcessedLength !== currentChatLength && settings.userConfigured) {
             await saveCurrentHideSettings(hideLastN);
         }
    }

    // console.log(`[${extensionName}] Incremental check completed in ${performance.now() - startTime}ms`);
}

/**
 * 全量隐藏检查 (优化的差异更新)
 * 用于加载、切换、删除、设置更改等情况
 */
async function runFullHideCheck() { // 改为 async 以便调用 saveCurrentHideSettings
    // 首先检查是否应该执行隐藏操作
    if (!shouldProcessHiding()) return;

    const startTime = performance.now();
    const context = getContextOptimized();
    if (!context || !context.chat) {
        return;
    }
    const chat = context.chat;
    const currentChatLength = chat.length;

    // 加载当前角色的设置
    const settings = getCurrentHideSettings() || { hideLastN: 0, lastProcessedLength: 0, userConfigured: false };
    const { hideLastN } = settings; // 解构 hideLastN

    // 1. 计算可见边界
    const visibleStart = hideLastN <= 0 ? currentChatLength : 
                         (hideLastN >= currentChatLength ? 0 : currentChatLength - hideLastN);

    // 2. 差异计算和数据更新阶段
    const toHide = [];
    const toShow = [];
    let changed = false;
    
    for (let i = 0; i < currentChatLength; i++) {
        const msg = chat[i];
        if (!msg) continue; // 跳过空消息槽

        const isCurrentlyHidden = msg.is_system === true;
        const shouldBeHidden = i < visibleStart; // 索引小于 visibleStart 的应该隐藏

        if (shouldBeHidden && !isCurrentlyHidden) {
            msg.is_system = true;
            toHide.push(i);
            changed = true;
        } else if (!shouldBeHidden && isCurrentlyHidden) {
            msg.is_system = false;
            toShow.push(i);
            changed = true;
        }
    }

    // 3. 只有在有更改时才执行DOM更新
    if (changed) {
        try {
            // 批量处理隐藏消息
            if (toHide.length > 0) {
                const hideSelector = toHide.map(id => `.mes[mesid="${id}"]`).join(',');
                if (hideSelector) {
                    $(hideSelector).attr('is_system', 'true');
                }
            }
            
            // 批量处理显示消息
            if (toShow.length > 0) {
                const showSelector = toShow.map(id => `.mes[mesid="${id}"]`).join(',');
                if (showSelector) {
                    $(showSelector).attr('is_system', 'false');
                }
            }
            
            console.log(`[${extensionName}] Full check: Hiding ${toHide.length}, Showing ${toShow.length}`);
        } catch (error) {
            console.error(`[${extensionName}] Error updating DOM in full check:`, error);
        }
    }

    // 4. 更新处理长度并保存设置（如果长度变化且用户已配置）
    if (settings.lastProcessedLength !== currentChatLength && settings.userConfigured) {
        await saveCurrentHideSettings(hideLastN); // 使用 await
    }
}

// 新增：全部取消隐藏功能
async function unhideAllMessages() { // 改为 async
    const startTime = performance.now();
    console.log(`[${extensionName}] Unhiding all messages.`);
    const context = getContextOptimized();
    if (!context || !context.chat) {
         console.warn(`[${extensionName}] Unhide all aborted: Chat data not available.`);
         return;
    }
    const chat = context.chat;

    if (chat.length === 0) {
        // console.warn(`[${extensionName}] Unhide all aborted: Chat is empty.`); // 减少日志
        // 即使聊天为空，也要确保设置被重置为 0
         await saveCurrentHideSettings(0);
         updateCurrentHideSettingsDisplay();
        return;
    }

    // 找出所有当前隐藏的消息
    const toShow = [];
    for (let i = 0; i < chat.length; i++) {
        if (chat[i] && chat[i].is_system === true) {
            toShow.push(i);
        }
    }

    // 批量更新数据和DOM
    if (toShow.length > 0) {
        // 更新数据
        toShow.forEach(idx => { if (chat[idx]) chat[idx].is_system = false; });

        // 更新DOM
        try {
            const showSelector = toShow.map(id => `.mes[mesid="${id}"]`).join(',');
            if (showSelector) $(showSelector).attr('is_system', 'false');
        } catch (error) {
            console.error(`[${extensionName}] Error updating DOM when unhiding all:`, error);
        }

        // 保存聊天 - 确认是否必要
        // setTimeout(() => context.saveChatDebounced?.(), 100);
        console.log(`[${extensionName}] Unhide all: Showed ${toShow.length} messages`);
    } else {
        // console.log(`[${extensionName}] Unhide all: No hidden messages found.`); // 减少日志
    }

    // 重要修改：重置隐藏设置为0，并通过 API 保存
    const success = await saveCurrentHideSettings(0);
    if (success) {
        updateCurrentHideSettingsDisplay(); // 只有保存成功才更新显示
    } else {
        toastr.error("无法重置隐藏设置。");
    }
}

// 设置UI元素的事件监听器
function setupEventListeners() {
    // 设置弹出对话框按钮事件
    $('#hide-helper-wand-button').on('click', function() {
        if (!extension_settings[extensionName].enabled) {
            toastr.warning('隐藏助手当前已禁用，请在扩展设置中启用。');
            return;
        }
        updateCurrentHideSettingsDisplay(); // Update display values before showing

        const $popup = $('#hide-helper-popup');
        $popup.css({ // 先设置基本样式，位置稍后计算
            'display': 'block',
            'visibility': 'hidden',
            'position': 'fixed',
            'left': '50%',
            'transform': 'translateX(-50%)'
        });

        // 确保弹出框内容渲染完成再计算位置
        setTimeout(() => {
            const popupHeight = $popup.outerHeight();
            const windowHeight = $(window).height();
            const topPosition = Math.max(10, Math.min((windowHeight - popupHeight) / 2, windowHeight - popupHeight - 50)); // 距底部至少50px
            $popup.css({
                'top': topPosition + 'px',
                'visibility': 'visible'
            });
        }, 0); // 使用 setTimeout 0 延迟执行
    });

    // 弹出框关闭按钮事件
    $('#hide-helper-popup-close').on('click', function() {
        $('#hide-helper-popup').hide();
    });

    // 设置选项更改事件 (全局启用/禁用)
    $('#hide-helper-toggle').on('change', function() {
        const isEnabled = $(this).val() === 'enabled';
        extension_settings[extensionName].enabled = isEnabled;
        saveSettingsDebounced(); // 保存全局设置

        if (isEnabled) {
            toastr.success('隐藏助手已启用');
            // 启用时，执行一次全量检查来应用当前角色的隐藏状态
            runFullHideCheckDebounced();
        } else {
            toastr.warning('隐藏助手已禁用');
            // 禁用时，不自动取消隐藏，保留状态
        }
    });

    const hideLastNInput = document.getElementById('hide-last-n');

    if (hideLastNInput) {
        // 监听输入变化，确保非负
        hideLastNInput.addEventListener('input', (e) => {
            const value = parseInt(e.target.value);
            // 如果输入无效或小于0，则清空或设为0 (根据偏好选择，这里选择清空)
            if (isNaN(value) || value < 0) {
                 e.target.value = '';
            } else {
                 e.target.value = value; // 保留有效的非负整数
            }
        });
    }

    // 优化后的保存设置按钮处理
    $('#hide-save-settings-btn').on('click', async function() {
        const value = parseInt(hideLastNInput.value);
        const valueToSave = isNaN(value) || value < 0 ? 0 : value;
        
        // 获取当前设置，避免不必要的更新
        const currentSettings = getCurrentHideSettings();
        const currentValue = currentSettings?.hideLastN || 0;
        
        // 只有当设置实际发生变化时才保存和更新
        if (valueToSave !== currentValue) {
            // 显示加载指示器
            const $btn = $(this);
            const originalText = $btn.text();
            $btn.text('保存中...').prop('disabled', true);
            
            const success = await saveCurrentHideSettings(valueToSave);
            
            if (success) {
                // 仅在成功保存后运行全量检查
                runFullHideCheck();
                updateCurrentHideSettingsDisplay();
                toastr.success('隐藏设置已保存');
            }
            
            // 恢复按钮状态
            $btn.text(originalText).prop('disabled', false);
        } else {
            // 如果值未更改，只显示通知而不进行API调用
            toastr.info('设置未更改');
        }
    });

    // 全部取消隐藏按钮 (现在是 async)
    $('#hide-unhide-all-btn').on('click', async function() { // 改为 async
        await unhideAllMessages(); // 使用 await 调用
        // 成功或失败的消息已在 unhideAllMessages 中处理
    });

    // 监听聊天切换事件
    eventSource.on(event_types.CHAT_CHANGED, () => {
        cachedContext = null; // 清除上下文缓存

        // 更新全局启用/禁用状态显示
        $('#hide-helper-toggle').val(extension_settings[extensionName].enabled ? 'enabled' : 'disabled');

        // 更新当前角色的设置显示和输入框
        updateCurrentHideSettingsDisplay();

        // 聊天切换时执行全量检查 (如果插件启用)
        if (extension_settings[extensionName].enabled) {
            runFullHideCheckDebounced();
        }
    });

    // 监听新消息事件 (发送和接收)
    const handleNewMessage = () => {
        if (extension_settings[extensionName].enabled) {
            // 使用增量检查，稍作延迟以确保DOM更新
            setTimeout(() => runIncrementalHideCheck(), 50); // 增加一点延迟
        }
    };
    eventSource.on(event_types.MESSAGE_RECEIVED, handleNewMessage);
    eventSource.on(event_types.MESSAGE_SENT, handleNewMessage);


    // 监听消息删除事件
    eventSource.on(event_types.MESSAGE_DELETED, () => {
        // console.log(`[${extensionName}] Event ${event_types.MESSAGE_DELETED} received. Running full check.`); // 减少日志
        if (extension_settings[extensionName].enabled) {
            runFullHideCheckDebounced(); // 使用防抖全量检查
        }
    });

    // 监听流式响应结束事件 (可能导致多条消息状态更新)
    eventSource.on(event_types.STREAM_END, () => {
         if (extension_settings[extensionName].enabled) {
            // 流结束后，消息数量可能已稳定，执行一次增量检查可能不够，全量检查更保险
            runFullHideCheckDebounced();
        }
    });
}

// 初始化扩展
jQuery(async () => {
    loadSettings(); // 加载全局启用状态
    createUI(); // 创建界面元素

    // 初始加载时更新显示并执行检查
    // 延迟执行以确保 SillyTavern 的上下文已准备好
    setTimeout(() => {
        // 设置全局启用/禁用选择框的当前值
        $('#hide-helper-toggle').val(extension_settings[extensionName].enabled ? 'enabled' : 'disabled');

        // 更新当前设置显示和输入框
        updateCurrentHideSettingsDisplay();

        // 初始加载时执行全量检查 (如果插件启用且有用户配置)
        if (extension_settings[extensionName].enabled) {
             // 只有当 getCurrentHideSettings 返回非 null (表示已配置过) 时才执行初始检查
             // 避免在用户从未设置过的情况下隐藏消息
            if(getCurrentHideSettings()?.userConfigured === true) {
                runFullHideCheck();
            }
        }
    }, 1500); // 增加延迟时间
});
