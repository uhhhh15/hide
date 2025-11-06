// index.js (使用 extension_settings 存储并包含自动迁移，优化了初始化)
import { extension_settings, loadExtensionSettings, getContext } from "../../../extensions.js";
// 尝试导入全局列表，路径可能需要调整！如果导入失败，迁移逻辑需要改用 API 调用
import { saveSettingsDebounced, eventSource, event_types, getRequestHeaders, characters } from "../../../../script.js";

import { groups } from "../../../group-chats.js";

const extensionName = "hide";
const defaultSettings = {
    // 全局默认设置
    enabled: true,
    // 用于存储每个实体设置的对象
    settings_by_entity: {},
    // 迁移标志
    migration_v1_complete: true,
    // 添加全局设置相关字段
    useGlobalSettings: false,
    globalHideSettings: {
        hideLastN: 0,
        lastProcessedLength: 0,
        userConfigured: false
    }
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
        console.debug(`[${extensionName} DEBUG] Initializing DOM cache.`);
        this.hideLastNInput = document.getElementById('hide-last-n');
        this.saveBtn = document.getElementById('hide-save-settings-btn');
        this.currentValueDisplay = document.getElementById('hide-current-value');
        console.debug(`[${extensionName} DEBUG] DOM cache initialized:`, {
            hideLastNInput: !!this.hideLastNInput,
            saveBtn: !!this.saveBtn,
            currentValueDisplay: !!this.currentValueDisplay
        });
    }
};

/**
 * 通用弹窗居中函数
 * @param {jQuery} $popup - 需要居中的弹窗的jQuery对象
 */
function centerPopup($popup) {
    if (!$popup || $popup.length === 0 || $popup.is(':hidden')) {
        return;
    }

    const windowWidth = $(window).width();
    const windowHeight = $(window).height();
    const popupWidth = $popup.outerWidth();
    const popupHeight = $popup.outerHeight();

    // 计算 top 和 left，确保弹窗不会完全贴边
    const top = Math.max(10, (windowHeight - popupHeight) / 2);
    const left = Math.max(10, (windowWidth - popupWidth) / 2);

    $popup.css({
        top: `${top}px`,
        left: `${left}px`,
        // 确保移除旧的 transform 定位，防止冲突
        transform: 'none'
    });
}

// 获取优化的上下文
function getContextOptimized() {
    console.debug(`[${extensionName} DEBUG] Entering getContextOptimized.`);
    if (!cachedContext) {
        console.debug(`[${extensionName} DEBUG] Context cache miss. Calling getContext().`);
        cachedContext = getContext();
        console.debug(`[${extensionName} DEBUG] Context fetched:`, cachedContext ? `CharacterId: ${cachedContext.characterId}, GroupId: ${cachedContext.groupId}, Chat Length: ${cachedContext.chat?.length}` : 'null');
    } else {
        console.debug(`[${extensionName} DEBUG] Context cache hit.`);
    }
    return cachedContext;
}

// 辅助函数：获取当前上下文的唯一实体ID
function getCurrentEntityId() {
    const context = getContextOptimized();
    if (!context) return null;

    if (context.groupId) {
        // 使用 group- 前缀和群组ID
        return `group-${context.groupId}`;
    } else if (context.characterId !== undefined && context.characters && context.characters[context.characterId]) {
        const character = context.characters[context.characterId];
        // 使用 character- 前缀和头像文件名
        if (character.avatar) {
            return `character-${character.avatar}`;
        } else {
            console.warn(`[${extensionName}] Cannot determine entityId for character at index ${context.characterId}: Missing avatar filename.`);
            return null; // 无法确定唯一ID
        }
    }
    console.debug(`[${extensionName} DEBUG] Could not determine entityId from context.`);
    return null; // 无法确定实体
}

// 运行数据迁移 (从旧位置到新的全局位置)
function runMigration() {
    console.log(`[${extensionName}] === 开始设置迁移过程 ===`);
    let migratedCount = 0;
    // 确保容器存在
    extension_settings[extensionName].settings_by_entity = extension_settings[extensionName].settings_by_entity || {};
    const settingsContainer = extension_settings[extensionName].settings_by_entity;
    console.log(`[${extensionName}] 目标设置容器已初始化/找到。`);

    // --- 迁移角色数据 ---
    console.log(`[${extensionName}] --- 开始角色设置迁移 ---`);
    if (typeof characters !== 'undefined' && Array.isArray(characters)) {
        console.log(`[${extensionName}] 全局 'characters' 数组已找到。角色数量: ${characters.length}。`);
        characters.forEach((character, index) => {
            console.log(`[${extensionName}] 处理角色 #${index}: ${character ? character.name : '不可用'}`);
            if (!character || !character.data || !character.data.extensions) {
                console.log(`[${extensionName}]   跳过角色 #${index}: 缺少角色对象、data 或 extensions 属性。`);
                return;
            }
            try {
                const oldSettingsPath = 'character.data.extensions.hideHelperSettings';
                console.log(`[${extensionName}]   尝试访问旧设置路径: ${oldSettingsPath}`);
                const oldSettings = character.data.extensions.hideHelperSettings;
                if (oldSettings && typeof oldSettings === 'object' && oldSettings !== null) {
                    console.log(`[${extensionName}]   成功: 在 ${oldSettingsPath} 找到旧设置对象。内容:`, JSON.stringify(oldSettings));
                    const hasHideLastN = typeof oldSettings.hideLastN === 'number';
                    const hasLastProcessedLength = typeof oldSettings.lastProcessedLength === 'number';
                    const isUserConfigured = oldSettings.userConfigured === true;
                    const isValidOldData = hasHideLastN || hasLastProcessedLength || isUserConfigured;
                    console.log(`[${extensionName}]   验证旧设置数据: hasHideLastN=${hasHideLastN}, hasLastProcessedLength=${hasLastProcessedLength}, isUserConfigured=${isUserConfigured}. 是否有效: ${isValidOldData}`);
                    if (isValidOldData) {
                        const avatarFileName = character.avatar;
                        console.log(`[${extensionName}]   角色头像文件名: ${avatarFileName || '缺失'}`);
                        if (avatarFileName) {
                            const entityId = `character-${avatarFileName}`;
                            console.log(`[${extensionName}]   生成的 entityId: ${entityId}`);
                            if (!settingsContainer.hasOwnProperty(entityId)) {
                                console.log(`[${extensionName}]   操作: 正在迁移 entityId '${entityId}' 的设置，因为它在新位置不存在。`);
                                settingsContainer[entityId] = { ...oldSettings };
                                migratedCount++;
                                console.log(`[${extensionName}]   entityId '${entityId}' 迁移成功。计数器增加到 ${migratedCount}。`);
                            } else {
                                console.log(`[${extensionName}]   跳过迁移: 新位置已存在 entityId '${entityId}' 的数据。正在跳过。`);
                            }
                        } else {
                             console.warn(`[${extensionName}]   跳过迁移: 无法迁移角色 ${character.name || '不可用'} 的设置: 缺少头像文件名。无法生成唯一的 entityId。`);
                        }
                    } else {
                         console.warn(`[${extensionName}]   跳过迁移: 跳过角色 ${character.name || '不可用'} 的迁移: 路径 ${oldSettingsPath} 的旧设置数据无效或为空 (不包含预期字段)。找到的数据:`, JSON.stringify(oldSettings));
                    }
                } else {
                     console.log(`[${extensionName}]   信息: 在 ${oldSettingsPath} 未找到旧设置对象。此角色无需迁移。`);
                }
            } catch (charError) {
                 console.error(`[${extensionName}]   错误: 迁移索引 ${index} (名称: ${character.name || '不可用'}) 的角色设置时出错:`, charError);
            }
             console.log(`[${extensionName}] 完成处理角色 #${index}。`);
        });
         console.log(`[${extensionName}] --- 完成角色设置迁移 ---`);
    } else {
         console.warn(`[${extensionName}] 无法迁移角色设置: 全局 'characters' 数组不可用或不是数组。如果依赖此数组，迁移可能不完整。`);
    }

    // --- 迁移群组数据 ---
    console.log(`[${extensionName}] --- 开始群组设置迁移 ---`);
    if (typeof groups !== 'undefined' && Array.isArray(groups)) {
        console.log(`[${extensionName}] 全局 'groups' 数组已找到。群组数量: ${groups.length}。`);
        groups.forEach((group, index) => {
            console.log(`[${extensionName}] 处理群组 #${index}: ${group ? group.name : '不可用'} (ID: ${group ? group.id : '不可用'})`);
             if (!group || !group.data) {
                console.log(`[${extensionName}]   跳过群组 #${index}: 缺少群组对象或 data 属性。`);
                return;
            }
            try {
                const oldSettingsPath = 'group.data.hideHelperSettings';
                console.log(`[${extensionName}]   尝试访问旧设置路径: ${oldSettingsPath}`);
                const oldSettings = group.data.hideHelperSettings;
                if (oldSettings && typeof oldSettings === 'object' && oldSettings !== null) {
                    console.log(`[${extensionName}]   成功: 在 ${oldSettingsPath} 找到旧设置对象。内容:`, JSON.stringify(oldSettings));
                    const hasHideLastN = typeof oldSettings.hideLastN === 'number';
                    const hasLastProcessedLength = typeof oldSettings.lastProcessedLength === 'number';
                    const isUserConfigured = oldSettings.userConfigured === true;
                    const isValidOldData = hasHideLastN || hasLastProcessedLength || isUserConfigured;
                    console.log(`[${extensionName}]   验证旧设置数据: hasHideLastN=${hasHideLastN}, hasLastProcessedLength=${hasLastProcessedLength}, isUserConfigured=${isUserConfigured}. 是否有效: ${isValidOldData}`);
                    if (isValidOldData) {
                        const groupId = group.id;
                         console.log(`[${extensionName}]   群组 ID: ${groupId || '缺失'}`);
                        if (groupId) {
                            const entityId = `group-${groupId}`;
                             console.log(`[${extensionName}]   生成的 entityId: ${entityId}`);
                            if (!settingsContainer.hasOwnProperty(entityId)) {
                                console.log(`[${extensionName}]   操作: 正在迁移 entityId '${entityId}' 的设置，因为它在新位置不存在。`);
                                settingsContainer[entityId] = { ...oldSettings };
                                migratedCount++;
                                console.log(`[${extensionName}]   entityId '${entityId}' 迁移成功。计数器增加到 ${migratedCount}。`);
                            } else {
                                console.log(`[${extensionName}]   跳过迁移: 新位置已存在 entityId '${entityId}' 的数据。正在跳过。`);
                            }
                        } else {
                            console.warn(`[${extensionName}]   跳过迁移: 无法迁移索引 ${index} (名称: ${group.name || '不可用'}) 的群组设置: 缺少群组 ID。无法生成唯一的 entityId。`);
                        }
                    } else {
                        console.warn(`[${extensionName}]   跳过迁移: 跳过群组 ${group.name || '不可用'} 的迁移: 路径 ${oldSettingsPath} 的旧设置数据无效或为空 (不包含预期字段)。找到的数据:`, JSON.stringify(oldSettings));
                    }
                } else {
                     console.log(`[${extensionName}]   信息: 在 ${oldSettingsPath} 未找到旧设置对象。此群组无需迁移。`);
                }
            } catch (groupError) {
                console.error(`[${extensionName}]   错误: 迁移索引 ${index} (名称: ${group.name || '不可用'}) 的群组设置时出错:`, groupError);
            }
             console.log(`[${extensionName}] 完成处理群组 #${index}。`);
        });
         console.log(`[${extensionName}] --- 完成群组设置迁移 ---`);
    } else {
        console.warn(`[${extensionName}] 无法迁移群组设置: 全局 'groups' 数组不可用或不是数组。如果依赖此数组，迁移可能不完整。`);
    }

    // --- 完成迁移 ---
     console.log(`[${extensionName}] === 结束迁移过程 ===`);
    if (migratedCount > 0) {
         console.log(`[${extensionName}] 迁移完成。成功将 ${migratedCount} 个实体的设置迁移到新的全局位置。`);
    } else {
         console.log(`[${extensionName}] 迁移完成。无需迁移设置，未找到旧设置，或目标位置已有数据。`);
    }

    // 无论是否迁移了数据，都将标志设置为 true，表示迁移过程已执行
    extension_settings[extensionName].migration_v1_complete = true;
    console.log(`[${extensionName}] 将 migration_v1_complete 标志设置为 true。`);
    saveSettingsDebounced();
    console.log(`[${extensionName}] 已调用 saveSettingsDebounced() 来持久化迁移标志和任何已迁移的数据。`);
    console.log(`[${extensionName}] === 迁移过程完毕 ===`);
}


// 初始化扩展设置 (包含迁移检查)
function loadSettings() {
    console.log(`[${extensionName}] Entering loadSettings.`);
    extension_settings[extensionName] = extension_settings[extensionName] || {};

    // 使用 Object.assign 合并默认值，确保所有顶级键都存在
    Object.assign(extension_settings[extensionName], {
        enabled: extension_settings[extensionName].hasOwnProperty('enabled') ? extension_settings[extensionName].enabled : defaultSettings.enabled,
        settings_by_entity: extension_settings[extensionName].settings_by_entity || { ...defaultSettings.settings_by_entity },
        migration_v1_complete: extension_settings[extensionName].migration_v1_complete || defaultSettings.migration_v1_complete,
        // 添加全局设置相关字段
        useGlobalSettings: extension_settings[extensionName].hasOwnProperty('useGlobalSettings') 
            ? extension_settings[extensionName].useGlobalSettings 
            : defaultSettings.useGlobalSettings,
        globalHideSettings: extension_settings[extensionName].globalHideSettings || { ...defaultSettings.globalHideSettings }
    });

    // --- 检查并运行迁移 ---
    if (!extension_settings[extensionName].migration_v1_complete) {
        console.log(`[${extensionName}] 迁移标志未找到或为 false。尝试进行迁移...`); // 中文日志
        try {
            runMigration();
        } catch (error) {
            console.error(`[${extensionName}] 执行迁移时发生错误:`, error); // 中文日志
            // toastr.error('迁移旧设置时发生意外错误，请检查控制台日志。');
        }
    } else {
        console.log(`[${extensionName}] 迁移标志为 true。跳过迁移。`); // 中文日志
    }
    // --------------------------

    console.log(`[${extensionName}] 设置已加载/初始化:`, JSON.parse(JSON.stringify(extension_settings[extensionName]))); // 深拷贝打印避免循环引用
}

// 创建UI面板
function createUI() {
    console.log(`[${extensionName}] Entering createUI.`);
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

    console.log(`[${extensionName}] Appending settings UI to #extensions_settings.`);
    $("#extensions_settings").append(settingsHtml);
    createInputWandButton();
    createPopup();
    setupEventListeners();
    console.log(`[${extensionName}] Scheduling DOM cache initialization.`);
    setTimeout(() => domCache.init(), 100); // DOM缓存可以稍后初始化
    console.log(`[${extensionName}] Exiting createUI.`);
}

// 创建输入区旁的按钮
function createInputWandButton() {
    console.log(`[${extensionName}] Entering createInputWandButton.`);
    // 移除旧按钮，以防重复
    $('#hide-helper-wand-button').remove();
    const buttonHtml = `
        <div id="hide-helper-wand-button" title="打开隐藏助手设置">
            <i class="fa-solid fa-ghost"></i>
            <span>隐藏助手</span>
        </div>`;
    console.log(`[${extensionName}] Appending wand button to #data_bank_wand_container.`);
    $('#data_bank_wand_container').append(buttonHtml);
    console.log(`[${extensionName}] Exiting createInputWandButton.`);
}

// 创建弹出对话框
function createPopup() {
    console.log(`[${extensionName}] Entering createPopup.`);
    const popupHtml = `
        <div id="hide-helper-popup" class="hide-helper-popup">
            <button id="hide-helper-popup-close-icon" class="hide-helper-popup-close-icon">&times;</button>
            <div class="hide-helper-popup-title">
                <span>查看使用说明</span>
            </div>

            <div class="hide-helper-section">
                <label for="hide-last-n" class="hide-helper-label"></label>
                <input type="number" id="hide-last-n" min="0" placeholder="隐藏最新N楼之前的消息">
            </div>

            <div class="hide-helper-current">
                <strong>当前保留楼层数:</strong>
                <span id="hide-current-value">无</span>
            </div>

            <div class="hide-helper-mode-switch">
                <div class="label-group">
                    <span id="hide-mode-label">全局模式</span>
                    <span id="hide-mode-description">设置将应用于所有聊天</span>
                </div>
                <label class="hide-helper-switch">
                    <input type="checkbox" id="hide-mode-toggle">
                    <span class="hide-helper-slider"></span>
                </label>
            </div>

            <div class="hide-helper-popup-footer">
                <button id="hide-save-settings-btn" class="hide-helper-btn">
                    <i class="fa-solid fa-save"></i> 保存设置
                </button>
                <button id="hide-unhide-all-btn" class="hide-helper-btn">
                    <i class="fa-solid fa-eye"></i> 取消隐藏
                </button>
            </div>
        </div>`;
    console.log(`[${extensionName}] Appending popup HTML to body.`);
    $('body').append(popupHtml);
    console.log(`[${extensionName}] Exiting createPopup.`);
}

// 获取当前应该使用的隐藏设置 (从全局 extension_settings 读取)
function getCurrentHideSettings() {
    console.debug(`[${extensionName} DEBUG] Entering getCurrentHideSettings.`);
    // 检查是否使用全局设置
    if (extension_settings[extensionName]?.useGlobalSettings) {
        console.debug(`[${extensionName} DEBUG] getCurrentHideSettings: Using global settings.`);
        return extension_settings[extensionName]?.globalHideSettings || null;
    }
    
    // 使用特定实体的设置
    const entityId = getCurrentEntityId();
    if (!entityId) {
        console.warn(`[${extensionName} DEBUG] getCurrentHideSettings: Could not determine entityId.`);
        return null;
    }
    const settings = extension_settings[extensionName]?.settings_by_entity?.[entityId] || null;
    console.debug(`[${extensionName} DEBUG] getCurrentHideSettings: Read settings for entityId "${entityId}":`, settings);
    return settings;
}

// 保存当前隐藏设置 (到全局 extension_settings)
function saveCurrentHideSettings(hideLastN) {
    console.log(`[${extensionName}] Entering saveCurrentHideSettings with hideLastN: ${hideLastN}`);
    const context = getContextOptimized();
    if (!context) {
        console.error(`[${extensionName}] Cannot save settings: Context not available.`);
        return false;
    }

    const chatLength = context.chat?.length || 0;
    console.log(`[${extensionName}] saveCurrentHideSettings: Current chat length=${chatLength}`);

    const settingsToSave = {
        hideLastN: hideLastN >= 0 ? hideLastN : 0,
        lastProcessedLength: chatLength,
        userConfigured: true
    };
    console.log(`[${extensionName}] saveCurrentHideSettings: Settings object to save:`, settingsToSave);

    extension_settings[extensionName] = extension_settings[extensionName] || {};
    
    // 检查是否使用全局设置
    if (extension_settings[extensionName].useGlobalSettings) {
        console.log(`[${extensionName}] saveCurrentHideSettings: Saving to global settings.`);
        extension_settings[extensionName].globalHideSettings = settingsToSave;
        console.log(`[${extensionName}] Updated global hide settings in memory.`);
    } else {
        // 使用特定实体的设置
        const entityId = getCurrentEntityId();
        if (!entityId) {
            console.error(`[${extensionName}] Cannot save settings: Could not determine entityId.`);
            toastr.error('无法保存设置：无法确定当前角色或群组。');
            return false;
        }
        
        console.log(`[${extensionName}] saveCurrentHideSettings: Saving for entityId "${entityId}", currentChatLength=${chatLength}`);
        extension_settings[extensionName].settings_by_entity = extension_settings[extensionName].settings_by_entity || {};
        extension_settings[extensionName].settings_by_entity[entityId] = settingsToSave;
        console.log(`[${extensionName}] Updated settings in memory for entityId "${entityId}".`);
    }

    saveSettingsDebounced();
    console.log(`[${extensionName}] saveSettingsDebounced() called to persist changes.`);
    return true;
}


// 更新当前设置显示
function updateCurrentHideSettingsDisplay() {
    console.debug(`[${extensionName} DEBUG] Entering updateCurrentHideSettingsDisplay.`);
    const currentSettings = getCurrentHideSettings();
    console.debug(`[${extensionName} DEBUG] updateCurrentHideSettingsDisplay: Read settings:`, currentSettings);

    if (!domCache.currentValueDisplay) {
        console.debug(`[${extensionName} DEBUG] updateCurrentHideSettingsDisplay: DOM cache for currentValueDisplay not ready, initializing.`);
        domCache.init();
        if (!domCache.currentValueDisplay) {
            console.warn(`[${extensionName} DEBUG] updateCurrentHideSettingsDisplay: currentValueDisplay element still not found after init. Aborting update.`);
            return;
        }
    }

    // 更新当前隐藏值
    const displayValue = (currentSettings && currentSettings.hideLastN > 0) ? currentSettings.hideLastN : '所有楼层均不隐藏';
    domCache.currentValueDisplay.textContent = displayValue;

    // 更新输入框的值
    if (domCache.hideLastNInput) {
        const inputValue = currentSettings?.hideLastN > 0 ? currentSettings.hideLastN : '';
        domCache.hideLastNInput.value = inputValue;
    }

    // 更新模式切换开关的状态和文本
    const useGlobal = extension_settings[extensionName]?.useGlobalSettings || false;
    $('#hide-mode-toggle').prop('checked', useGlobal);

    if (useGlobal) {
        $('#hide-mode-label').text('全局模式');
        $('#hide-mode-description').text('隐藏将应用于所有角色卡');
    } else {
        $('#hide-mode-label').text('角色模式');
        $('#hide-mode-description').text('隐藏仅对当前角色卡生效');
    }

    console.debug(`[${extensionName} DEBUG] Exiting updateCurrentHideSettingsDisplay.`);
}

// 防抖函数
function debounce(fn, delay) {
    let timer;
    return function(...args) {
        console.debug(`[${extensionName} DEBUG] Debounce: Clearing timer for ${fn.name}.`);
        clearTimeout(timer);
        console.debug(`[${extensionName} DEBUG] Debounce: Setting timer for ${fn.name} with delay ${delay}ms.`);
        timer = setTimeout(() => {
            console.debug(`[${extensionName} DEBUG] Debounce: Executing debounced function ${fn.name}.`);
            fn.apply(this, args);
        }, delay);
    };
}

// 显示使用说明弹窗
function showInstructions() {
    console.log(`[${extensionName}] Showing instructions popup.`);

    // 如果已有旧的弹窗，先移除，并解绑可能残留的事件
    $('#hide-helper-instructions-popup').remove();
    $(window).off('resize.hideHelperInstructions');

    // 创建说明弹窗HTML (HTML内容不变)
	const instructionsHtml = `
		<div id="hide-helper-instructions-popup" class="hide-helper-instructions-popup">
			<div class="hide-helper-instructions-header">
				<span class="hide-helper-instructions-title">隐藏助手 - 使用说明</span>
				<button id="hide-helper-instructions-close" class="hide-helper-instructions-close-btn">&times;</button>
			</div>
			<div class="hide-helper-instructions-content">
				<h2>核心功能</h2>
				<p>
					本插件的核心功能是： 在每次与AI交互时，仅发送最新的N条消息，并自动隐藏其余的旧消息。您也可以为不同的角色/群聊设置不同的保留数量，也可以使用一个全局设置统一管理。
				</p>
				<p>
					在弹窗的输入框中填入您想 <strong>保留的最新消息数量</strong> (例如 <code>4</code>)，然后点击 <strong class="button-like">保存设置</strong> 按钮。插件便会立即生效，只保留最新的4条消息，并隐藏此前的所有内容。
				</p>
				<p>
					<strong>示例：</strong> 假设当前聊天共有10条消息。
					<ul>
						<li>您在输入框中输入 <code>4</code> 并保存。</li>
						<li>结果：最新的4条消息（第6到9楼）会正常显示并发送给AI。</li>
						<li>之前的所有消息（第0到5楼）将被自动隐藏。</li>
						<li>当您或AI发送新消息后，插件会自动调整，确保始终只有最新的4条消息是可见的。</li>
					</ul>
				</p>

				<h2>全局模式 vs 角色模式</h2>
				<p>
					插件提供两种隐藏模式，以满足不同需求：
					<ul>
						<li><strong>全局模式：</strong> 在此模式下，您设置的保留数量将应用于 <strong>所有</strong> 角色卡和群聊。一次设置，处处生效。</li>
						<li><strong>角色模式：</strong> 在此模式下，设置将 <strong>仅</strong> 绑定到当前聊天。您可以为每个角色或群聊设定并保存一个独立的保留数量。</li>
					</ul>
				</p>
				<p>
					您可以通过弹窗中的 <strong>拨动开关</strong> 在这两种模式间轻松切换。开关下方会有文字提示当前处于哪种模式，一目了然。
				</p>
				<p>
					<strong>请注意：</strong> 无论在哪种模式下，<strong class="button-like">当前保留楼层数</strong> 显示的都是对当前聊天生效的数值。
				</p>

				<h2>取消隐藏</h2>
				 <p>
					点击 <strong class="button-like">取消隐藏</strong> 按钮后，隐藏助手会立刻将当前模式（全局或角色）的隐藏设置重置为无，此时所有隐藏的楼层消息都会被取消隐藏。
				</p>
				
				<h2>识别与交互</h2>
				<p>
					被成功隐藏的消息上方会出现一个 <span class="icon-example"><i class="fa-solid fa-ghost"></i></span> 幽灵图标，作为清晰的标识。
				</p>
				<p>
					<span class="important">重要提示：</span> 被隐藏的消息 <strong>不会</strong> 被包含在发送给AI的上下文中。这意味着AI无法“看到”这些内容，这对于控制上下文长度和引导对话非常有帮助。
				</p>
			</div>
		</div>`;

    // 添加到body
    $('body').append(instructionsHtml);

    // 获取弹窗元素
    const $popup = $('#hide-helper-instructions-popup');

    // 使用 flex 布局显示弹窗
    $popup.css('display', 'flex');

    // 立即居中
    centerPopup($popup);

    // 绑定 resize 事件
    $(window).on('resize.hideHelperInstructions', () => centerPopup($popup));

    // 添加关闭按钮事件
    $('#hide-helper-instructions-close').on('click', function() {
        $popup.remove();
        // 关闭时解绑对应的 resize 事件
        $(window).off('resize.hideHelperInstructions');
    });

    console.log(`[${extensionName}] Instructions popup displayed.`);
}

// 防抖版本的全量检查
const runFullHideCheckDebounced = debounce(runFullHideCheck, 200);

// 检查是否应该执行隐藏/取消隐藏操作
function shouldProcessHiding() {
    console.debug(`[${extensionName} DEBUG] Entering shouldProcessHiding.`);
    if (!extension_settings[extensionName]?.enabled) {
        console.debug(`[${extensionName} DEBUG] shouldProcessHiding: Plugin is disabled globally. Returning false.`);
        return false;
    }

    const settings = getCurrentHideSettings();
    console.debug(`[${extensionName} DEBUG] shouldProcessHiding: Read settings for current entity:`, settings);
    if (!settings || settings.userConfigured !== true) {
        console.debug(`[${extensionName} DEBUG] shouldProcessHiding: No user-configured settings found for this entity or settings object missing. Returning false.`);
        return false;
    }
    console.debug(`[${extensionName} DEBUG] shouldProcessHiding: Plugin enabled and user configured settings found. Returning true.`);
    return true;
}

// 增量隐藏检查
async function runIncrementalHideCheck() {
    console.debug(`[${extensionName} DEBUG] Entering runIncrementalHideCheck.`);
    if (!shouldProcessHiding()) {
        console.debug(`[${extensionName} DEBUG] runIncrementalHideCheck: shouldProcessHiding returned false. Skipping.`);
        return;
    }

    const startTime = performance.now();
    const context = getContextOptimized();
    if (!context || !context.chat) {
        console.warn(`[${extensionName} DEBUG] runIncrementalHideCheck: Aborted. Context or chat data not available.`);
        return;
    }

    const chat = context.chat;
    const currentChatLength = chat.length;
    const settings = getCurrentHideSettings() || { hideLastN: 0, lastProcessedLength: 0, userConfigured: false };
    const { hideLastN, lastProcessedLength = 0 } = settings;
    console.debug(`[${extensionName} DEBUG] runIncrementalHideCheck: currentChatLength=${currentChatLength}, hideLastN=${hideLastN}, lastProcessedLength=${lastProcessedLength}`);

    if (currentChatLength === 0 || hideLastN <= 0) {
        console.debug(`[${extensionName} DEBUG] runIncrementalHideCheck: Condition met (currentChatLength === 0 || hideLastN <= 0). Checking if length needs saving.`);
        if (currentChatLength !== lastProcessedLength && settings.userConfigured) {
            console.debug(`[${extensionName} DEBUG] runIncrementalHideCheck: Length changed (${lastProcessedLength} -> ${currentChatLength}) with hideLastN <= 0. Saving settings.`);
            saveCurrentHideSettings(hideLastN);
        } else {
             console.debug(`[${extensionName} DEBUG] runIncrementalHideCheck: Length did not change or not user configured. Skipping save.`);
        }
        console.debug(`[${extensionName} DEBUG] runIncrementalHideCheck: Skipping main logic due to condition.`);
        return;
    }

    if (currentChatLength <= lastProcessedLength) {
        console.warn(`[${extensionName} DEBUG] runIncrementalHideCheck: Skipped. Chat length did not increase or decreased (${lastProcessedLength} -> ${currentChatLength}). Possibly a delete or unexpected state.`);
         if (currentChatLength < lastProcessedLength && settings.userConfigured) {
            console.warn(`[${extensionName} DEBUG] runIncrementalHideCheck: Chat length decreased. Saving settings with new length.`);
            saveCurrentHideSettings(hideLastN);
         }
        return;
    }

    const targetVisibleStart = Math.max(0, currentChatLength - hideLastN);
    const previousVisibleStart = lastProcessedLength > 0 ? Math.max(0, lastProcessedLength - hideLastN) : 0;
    console.debug(`[${extensionName} DEBUG] runIncrementalHideCheck: Calculated visible range: targetVisibleStart=${targetVisibleStart}, previousVisibleStart=${previousVisibleStart}`);

    if (targetVisibleStart > previousVisibleStart) {
        const toHideIncrementally = [];
        const startIndex = previousVisibleStart;
        const endIndex = targetVisibleStart;
        console.debug(`[${extensionName} DEBUG] runIncrementalHideCheck: Need to check messages in range [${startIndex}, ${endIndex}).`);

        for (let i = startIndex; i < endIndex; i++) {
            if (chat[i] && chat[i].is_system !== true) {
                toHideIncrementally.push(i);
                 console.debug(`[${extensionName} DEBUG] runIncrementalHideCheck: Adding message ${i} to incremental hide list.`);
            } else {
                 console.debug(`[${extensionName} DEBUG] runIncrementalHideCheck: Skipping message ${i} (already system or missing).`);
            }
        }

        if (toHideIncrementally.length > 0) {
            console.log(`[${extensionName}] Incrementally hiding messages: Indices [${toHideIncrementally.join(', ')}]`);
            console.debug(`[${extensionName} DEBUG] runIncrementalHideCheck: Updating chat array data...`);
            toHideIncrementally.forEach(idx => { if (chat[idx]) chat[idx].is_system = true; });
            console.debug(`[${extensionName} DEBUG] runIncrementalHideCheck: Chat array data updated.`);

            try {
                console.debug(`[${extensionName} DEBUG] runIncrementalHideCheck: Updating DOM elements...`);
                const hideSelector = toHideIncrementally.map(id => `.mes[mesid="${id}"]`).join(',');
                if (hideSelector) {
                    console.debug(`[${extensionName} DEBUG] runIncrementalHideCheck: Applying selector: ${hideSelector}`);
                    $(hideSelector).attr('is_system', 'true');
                    console.debug(`[${extensionName} DEBUG] runIncrementalHideCheck: DOM update command issued.`);
                } else {
                    console.debug(`[${extensionName} DEBUG] runIncrementalHideCheck: No DOM elements to update.`);
                }
            } catch (error) {
                console.error(`[${extensionName}] Error updating DOM incrementally:`, error);
            }

            console.log(`[${extensionName}] runIncrementalHideCheck: Saving settings after incremental hide.`);
            saveCurrentHideSettings(hideLastN);

        } else {
             console.debug(`[${extensionName} DEBUG] runIncrementalHideCheck: No messages needed hiding in the new range [${startIndex}, ${endIndex}).`);
             if (settings.lastProcessedLength !== currentChatLength && settings.userConfigured) {
                 console.log(`[${extensionName}] runIncrementalHideCheck: Length changed but no messages hidden. Saving settings.`);
                 saveCurrentHideSettings(hideLastN);
             } else {
                  console.debug(`[${extensionName} DEBUG] runIncrementalHideCheck: Length did not change or not user configured. Skipping save.`);
             }
        }
    } else {
        console.debug(`[${extensionName} DEBUG] runIncrementalHideCheck: Visible start did not advance or range invalid (targetVisibleStart <= previousVisibleStart).`);
         if (settings.lastProcessedLength !== currentChatLength && settings.userConfigured) {
             console.log(`[${extensionName}] runIncrementalHideCheck: Length changed but visible start didn't advance. Saving settings.`);
             saveCurrentHideSettings(hideLastN);
         } else {
              console.debug(`[${extensionName} DEBUG] runIncrementalHideCheck: Length did not change or not user configured. Skipping save.`);
         }
    }

    console.debug(`[${extensionName} DEBUG] Incremental check completed in ${performance.now() - startTime}ms`);
}

// 全量隐藏检查
async function runFullHideCheck() {
    console.log(`[${extensionName}] Entering runFullHideCheck.`);
    if (!shouldProcessHiding()) {
        console.log(`[${extensionName}] runFullHideCheck: shouldProcessHiding returned false. Skipping.`);
        return;
    }

    const startTime = performance.now();
    const context = getContextOptimized();
    if (!context || !context.chat) {
        console.warn(`[${extensionName}] runFullHideCheck: Aborted. Context or chat data not available.`);
        return;
    }
    const chat = context.chat;
    const currentChatLength = chat.length;
    console.log(`[${extensionName}] runFullHideCheck: Context OK. Chat length: ${currentChatLength}`);

    const settings = getCurrentHideSettings() || { hideLastN: 0, lastProcessedLength: 0, userConfigured: false };
    const { hideLastN } = settings;
    console.log(`[${extensionName}] runFullHideCheck: Loaded settings for current entity: hideLastN=${hideLastN}, userConfigured=${settings.userConfigured}`);

    const visibleStart = hideLastN <= 0
        ? 0
        : (hideLastN >= currentChatLength
            ? 0
            : Math.max(0, currentChatLength - hideLastN));
    console.log(`[${extensionName}] runFullHideCheck: Calculated visibleStart index: ${visibleStart}`);

    const toHide = [];
    const toShow = [];
    let changed = false;
    console.log(`[${extensionName}] runFullHideCheck: Starting diff calculation...`);
    for (let i = 0; i < currentChatLength; i++) {
        const msg = chat[i];
        if (!msg) {
            console.warn(`[${extensionName} DEBUG] runFullHideCheck: Skipping empty message slot at index ${i}.`);
            continue;
        }
        const isCurrentlyHidden = msg.is_system === true;
        const shouldBeHidden = i < visibleStart;

        if (shouldBeHidden && !isCurrentlyHidden) {
            console.debug(`[${extensionName} DEBUG] runFullHideCheck: Index ${i} should be hidden but isn't. Marking to hide.`);
            msg.is_system = true;
            toHide.push(i);
            changed = true;
        } else if (!shouldBeHidden && isCurrentlyHidden) {
            console.debug(`[${extensionName} DEBUG] runFullHideCheck: Index ${i} should be shown but is hidden. Marking to show.`);
            msg.is_system = false;
            toShow.push(i);
            changed = true;
        }
    }
    console.log(`[${extensionName}] runFullHideCheck: Diff calculation done. Changes needed: ${changed}. To hide: ${toHide.length}, To show: ${toShow.length}.`);

    if (changed) {
        try {
            console.log(`[${extensionName}] runFullHideCheck: Applying DOM updates...`);
            if (toHide.length > 0) {
                const hideSelector = toHide.map(id => `.mes[mesid="${id}"]`).join(',');
                if (hideSelector) {
                    console.debug(`[${extensionName} DEBUG] runFullHideCheck: Hiding DOM elements with selector: ${hideSelector}`);
                    $(hideSelector).attr('is_system', 'true');
                }
            }
            if (toShow.length > 0) {
                const showSelector = toShow.map(id => `.mes[mesid="${id}"]`).join(',');
                if (showSelector) {
                    console.debug(`[${extensionName} DEBUG] runFullHideCheck: Showing DOM elements with selector: ${showSelector}`);
                    $(showSelector).attr('is_system', 'false');
                }
            }
             console.log(`[${extensionName}] runFullHideCheck: DOM updates applied.`);
        } catch (error) {
            console.error(`[${extensionName}] Error updating DOM in full check:`, error);
        }
    } else {
         console.log(`[${extensionName}] runFullHideCheck: No changes needed in chat data or DOM based on current settings.`);
    }

    console.log(`[${extensionName}] runFullHideCheck: Checking if settings need saving. lastProcessedLength=${settings.lastProcessedLength}, currentChatLength=${currentChatLength}, userConfigured=${settings.userConfigured}`);
    if (settings.userConfigured && settings.lastProcessedLength !== currentChatLength) {
        console.log(`[${extensionName}] runFullHideCheck: Length changed (${settings.lastProcessedLength} -> ${currentChatLength}) and user configured. Saving settings.`);
        saveCurrentHideSettings(hideLastN);
    } else {
         console.log(`[${extensionName}] runFullHideCheck: Settings save not required (length unchanged or not user configured).`);
    }
    console.log(`[${extensionName}] Full check completed in ${performance.now() - startTime}ms`);
}

// 全部取消隐藏功能
async function unhideAllMessages() {
    const startTime = performance.now();
    console.log(`[${extensionName}] Entering unhideAllMessages.`);
    const context = getContextOptimized();

    if (!context || !context.chat) {
         console.warn(`[${extensionName}] Unhide all: Chat data not available.`);
         
         // 即使没有聊天数据，也尝试重置隐藏设置
         if (extension_settings[extensionName].useGlobalSettings) {
             console.log(`[${extensionName}] Unhide all: Attempting to reset global hide settings to 0 even though chat is unavailable.`);
             extension_settings[extensionName].globalHideSettings.hideLastN = 0;
             extension_settings[extensionName].globalHideSettings.userConfigured = true;
             saveSettingsDebounced();
             updateCurrentHideSettingsDisplay();
         } else {
             const entityId = getCurrentEntityId();
             if (entityId) {
                 console.log(`[${extensionName}] Unhide all: Attempting to reset hide settings to 0 for entity ${entityId} even though chat is unavailable.`);
                 saveCurrentHideSettings(0);
                 updateCurrentHideSettingsDisplay();
             } else {
                 console.error(`[${extensionName}] Unhide all aborted: Cannot determine entityId to reset settings.`);
                 toastr.error('无法取消隐藏：无法确定当前目标。');
             }
         }
         return;
    }

    const chat = context.chat;
    const chatLength = chat.length;
    console.log(`[${extensionName}] Unhide all: Chat length is ${chatLength}.`);

    const toShow = [];
    console.log(`[${extensionName}] Unhide all: Scanning chat for hidden messages...`);
    for (let i = 0; i < chatLength; i++) {
        if (chat[i] && chat[i].is_system === true) {
            console.debug(`[${extensionName} DEBUG] Unhide all: Found hidden message at index ${i}. Marking to show.`);
            toShow.push(i);
        }
    }
    console.log(`[${extensionName}] Unhide all: Found ${toShow.length} messages to unhide.`);

    if (toShow.length > 0) {
        console.log(`[${extensionName}] Unhide all: Updating chat array data...`);
        toShow.forEach(idx => { if (chat[idx]) chat[idx].is_system = false; });
        console.log(`[${extensionName}] Unhide all: Chat data updated.`);
        try {
            console.log(`[${extensionName}] Unhide all: Updating DOM...`);
            const showSelector = toShow.map(id => `.mes[mesid="${id}"]`).join(',');
            if (showSelector) {
                 console.debug(`[${extensionName} DEBUG] Unhide all: Applying selector: ${showSelector}`);
                 $(showSelector).attr('is_system', 'false');
                 console.log(`[${extensionName}] Unhide all: DOM updated.`);
            }
        } catch (error) {
            console.error(`[${extensionName}] Error updating DOM when unhiding all:`, error);
        }
    } else {
        console.log(`[${extensionName}] Unhide all: No hidden messages found to change.`);
    }

    console.log(`[${extensionName}] Unhide all: Saving hide setting as 0.`);
    const success = saveCurrentHideSettings(0);
    if (success) {
        console.log(`[${extensionName}] Unhide all: Hide setting successfully reset to 0.`);
        updateCurrentHideSettingsDisplay();
    } else {
        console.error(`[${extensionName}] Unhide all: Failed to issue command to reset hide setting to 0.`);
    }
     console.log(`[${extensionName}] Unhide all completed in ${performance.now() - startTime}ms`);
}

// 设置UI元素的事件监听器
function setupEventListeners() {
    console.log(`[${extensionName}] Entering setupEventListeners.`);

    // 弹出对话框按钮事件
    console.log(`[${extensionName}] Setting up click listener for #hide-helper-wand-button.`);
    $('#hide-helper-wand-button').on('click', function() {
        console.log(`[${extensionName}] Wand button clicked.`);
        if (!extension_settings[extensionName]?.enabled) {
            console.warn(`[${extensionName}] Wand button clicked but extension is disabled.`);
            toastr.warning('隐藏助手当前已禁用，请在扩展设置中启用。');
            return;
        }
        console.log(`[${extensionName}] Wand button: Extension enabled. Updating display before showing popup.`);
        updateCurrentHideSettingsDisplay();

        const $popup = $('#hide-helper-popup');

        // 直接显示弹窗
        $popup.show();

        // 立即执行一次居中
        centerPopup($popup);

        // 绑定窗口大小调整事件，以便动态重新居中
        // 使用命名空间 .hideHelperMain 以便精确解绑
        $(window).off('resize.hideHelperMain').on('resize.hideHelperMain', () => centerPopup($popup));
    });

    // 弹出框关闭按钮事件
    console.log(`[${extensionName}] Setting up click listener for #hide-helper-popup-close-icon.`);
    $('#hide-helper-popup-close-icon').on('click', function() {
        console.log(`[${extensionName}] Popup close icon clicked.`);
        $('#hide-helper-popup').hide();
        // 解绑主弹窗的 resize 事件
        $(window).off('resize.hideHelperMain');
    });

    // 弹窗标题（使用说明）点击事件
    console.log(`[${extensionName}] Setting up click listener for .hide-helper-popup-title.`);
    $(document).on('click', '.hide-helper-popup-title', function() {
        console.log(`[${extensionName}] Popup title (instructions link) clicked.`);
        showInstructions();
    });

    // 全局启用/禁用切换事件
    console.log(`[${extensionName}] Setting up change listener for #hide-helper-toggle.`);
    $('#hide-helper-toggle').on('change', function() {
        const isEnabled = $(this).val() === 'enabled';
        console.log(`[${extensionName}] Global toggle changed. New state: ${isEnabled ? 'enabled' : 'disabled'}`);
        if (extension_settings[extensionName]) {
            extension_settings[extensionName].enabled = isEnabled;
            console.log(`[${extensionName}] Saving global settings due to toggle change.`);
            saveSettingsDebounced();
        }

        if (isEnabled) {
            console.log(`[${extensionName}] Extension enabled via toggle. Running full check.`);
            toastr.success('隐藏助手已启用');
            runFullHideCheckDebounced();
        } else {
            console.log(`[${extensionName}] Extension disabled via toggle.`);
            toastr.warning('隐藏助手已禁用');
        }
    });

    // 设置模式切换事件
    console.log(`[${extensionName}] Setting up change listener for #hide-mode-toggle.`);
    $('#hide-mode-toggle').on('change', function() {
        const newMode = $(this).is(':checked'); // true for global, false for chat

        if (extension_settings[extensionName]) {
            // 如果之前未定义，确保初始化全局设置
            if (!extension_settings[extensionName].globalHideSettings) {
                extension_settings[extensionName].globalHideSettings = { ...defaultSettings.globalHideSettings };
            }

            extension_settings[extensionName].useGlobalSettings = newMode;

            console.log(`[${extensionName}] Settings mode changed to ${newMode ? 'global' : 'chat'}`);
            saveSettingsDebounced();

            // 更新显示并运行检查
            updateCurrentHideSettingsDisplay();
            runFullHideCheckDebounced();

            toastr.info(`已切换到${newMode ? '全局' : '聊天'}设置模式`);
        }
    });

    // 输入框输入事件
    const hideLastNInput = document.getElementById('hide-last-n');
    if (hideLastNInput) {
        console.log(`[${extensionName}] Setting up input listener for #hide-last-n.`);
        hideLastNInput.addEventListener('input', (e) => {
            const value = parseInt(e.target.value);
             console.debug(`[${extensionName} DEBUG] Input field changed. Raw value: "${e.target.value}", Parsed value: ${value}`);
            if (isNaN(value) || value < 0) {
                 console.debug(`[${extensionName} DEBUG] Input invalid or negative. Clearing input field.`);
                 e.target.value = '';
            } else {
                 console.debug(`[${extensionName} DEBUG] Input valid. Keeping value: ${value}`);
                 e.target.value = value; // 保持合法数字
            }
        });
    } else {
        console.warn(`[${extensionName}] Could not find #hide-last-n input element to attach listener.`);
    }

    // 保存设置按钮事件
    console.log(`[${extensionName}] Setting up click listener for #hide-save-settings-btn.`);
    $('#hide-save-settings-btn').on('click', function() {
        console.log(`[${extensionName}] Save settings button clicked.`);
        const value = parseInt(hideLastNInput.value);
        const valueToSave = isNaN(value) || value < 0 ? 0 : value;
         console.log(`[${extensionName}] Save button: Parsed input value: ${value}. Value to save: ${valueToSave}`);

        const currentSettings = getCurrentHideSettings();
        const currentValue = currentSettings?.hideLastN || 0;
         console.log(`[${extensionName}] Save button: Current saved value: ${currentValue}`);

        if (valueToSave !== currentValue) {
            console.log(`[${extensionName}] Save button: Value changed from ${currentValue} to ${valueToSave}. Proceeding with save.`);
            const $btn = $(this);
            const originalText = $btn.text();
            $btn.text('保存中...').prop('disabled', true);

            console.log(`[${extensionName}] Save button: Calling saveCurrentHideSettings(${valueToSave}).`);
            const success = saveCurrentHideSettings(valueToSave);
             console.log(`[${extensionName}] Save button: saveCurrentHideSettings returned: ${success}`);

            if (success) {
                console.log(`[${extensionName}] Save button: Save instruction issued successfully. Running full check and updating display.`);
                runFullHideCheck(); // 直接运行检查
                updateCurrentHideSettingsDisplay();
                toastr.success('隐藏设置已保存');
            } else {
                 console.error(`[${extensionName}] Save button: Save instruction failed.`);
            }

            console.log(`[${extensionName}] Save button: Restoring button state.`);
            $btn.text(originalText).prop('disabled', false);
        } else {
            console.log(`[${extensionName}] Save button: Value (${valueToSave}) hasn't changed from current (${currentValue}). Skipping save.`);
            toastr.info('设置未更改');
        }
    });

    // 全部取消隐藏按钮事件
    console.log(`[${extensionName}] Setting up click listener for #hide-unhide-all-btn.`);
    $('#hide-unhide-all-btn').on('click', async function() {
        console.log(`[${extensionName}] Unhide all button clicked.`);
        await unhideAllMessages();
        console.log(`[${extensionName}] Unhide all process finished.`);
    });

    // --- 核心事件监听 ---

    // 聊天切换事件
    console.log(`[${extensionName}] Setting up listener for event: ${event_types.CHAT_CHANGED}`);
    eventSource.on(event_types.CHAT_CHANGED, (data) => {
        console.log(`[${extensionName}] Event received: ${event_types.CHAT_CHANGED}`, data);
        console.log(`[${extensionName}] CHAT_CHANGED: Clearing context cache.`);
        cachedContext = null;

        const newContext = getContextOptimized();
        const newCharId = newContext?.characterId;
        const newGroupId = newContext?.groupId;
        const newEntityId = getCurrentEntityId();
        console.log(`[${extensionName}] CHAT_CHANGED: New context info - CharacterId: ${newCharId}, GroupId: ${newGroupId}, EntityId: ${newEntityId}`);

        console.log(`[${extensionName}] CHAT_CHANGED: Updating global toggle display.`);
        $('#hide-helper-toggle').val(extension_settings[extensionName]?.enabled ? 'enabled' : 'disabled');

        console.log(`[${extensionName}] CHAT_CHANGED: Updating current hide settings display for new chat/entity.`);
        updateCurrentHideSettingsDisplay();

        if (extension_settings[extensionName]?.enabled) {
            console.log(`[${extensionName}] CHAT_CHANGED: Extension is enabled. Scheduling debounced full hide check.`);
            runFullHideCheckDebounced();
        } else {
            console.log(`[${extensionName}] CHAT_CHANGED: Extension is disabled. Skipping full hide check.`);
        }
    });

    // 新消息事件
    const handleNewMessage = (eventType) => {
        console.debug(`[${extensionName} DEBUG] Event received: ${eventType}`);
        if (extension_settings[extensionName]?.enabled) {
            console.debug(`[${extensionName} DEBUG] ${eventType}: Extension enabled. Scheduling incremental hide check.`);
            setTimeout(() => runIncrementalHideCheck(), 100);
        } else {
             console.debug(`[${extensionName} DEBUG] ${eventType}: Extension disabled. Skipping incremental check.`);
        }
    };
    console.log(`[${extensionName}] Setting up listener for event: ${event_types.MESSAGE_RECEIVED}`);
    eventSource.on(event_types.MESSAGE_RECEIVED, () => handleNewMessage(event_types.MESSAGE_RECEIVED));
    console.log(`[${extensionName}] Setting up listener for event: ${event_types.MESSAGE_SENT}`);
    eventSource.on(event_types.MESSAGE_SENT, () => handleNewMessage(event_types.MESSAGE_SENT));

    // 消息删除事件
    console.log(`[${extensionName}] Setting up listener for event: ${event_types.MESSAGE_DELETED}`);
    eventSource.on(event_types.MESSAGE_DELETED, () => {
        console.log(`[${extensionName}] Event received: ${event_types.MESSAGE_DELETED}`);
        if (extension_settings[extensionName]?.enabled) {
            console.log(`[${extensionName}] ${event_types.MESSAGE_DELETED}: Extension enabled. Scheduling debounced full hide check.`);
            runFullHideCheckDebounced();
        } else {
             console.log(`[${extensionName}] ${event_types.MESSAGE_DELETED}: Extension disabled. Skipping full check.`);
        }
    });

    // 生成结束事件
    const streamEndEvent = event_types.GENERATION_ENDED;
    console.log(`[${extensionName}] Setting up listener for event: ${streamEndEvent} (generation ended)`);
    eventSource.on(streamEndEvent, () => {
         console.log(`[${extensionName}] Event received: ${streamEndEvent}`);
         if (extension_settings[extensionName]?.enabled) {
            console.log(`[${extensionName}] ${streamEndEvent}: Extension enabled. Scheduling debounced full hide check after generation end.`);
            runFullHideCheckDebounced();
        } else {
             console.log(`[${extensionName}] ${streamEndEvent}: Extension disabled. Skipping full check.`);
        }
    });

    console.log(`[${extensionName}] Exiting setupEventListeners.`);
}

// 初始化扩展
jQuery(async () => {
    console.log(`[${extensionName}] Initializing extension (jQuery ready)...`);

    // 标志位，确保初始化只执行一次
    let isInitialized = false;
    const initializeExtension = () => {
        if (isInitialized) {
            console.log(`[${extensionName}] 初始化已运行。跳过。`); // 中文日志
            return;
        }
        isInitialized = true;
        console.log(`[${extensionName}] 由 app_ready 事件触发，运行初始化任务。`); // 中文日志

        // --- 这里是原来 setTimeout 里面的代码 ---
        // 1. 加载设置并触发迁移检查
        loadSettings();

        // 2. 创建 UI (现在依赖于 loadSettings 完成初始化和迁移检查)
        createUI();

        // 3. 更新初始 UI 状态
        console.log(`[${extensionName}] 初始设置: 设置全局开关显示。`); // 中文日志
        $('#hide-helper-toggle').val(extension_settings[extensionName]?.enabled ? 'enabled' : 'disabled');

        console.log(`[${extensionName}] 初始设置: 更新当前隐藏设置显示。`); // 中文日志
        updateCurrentHideSettingsDisplay();

        // 4. 初始加载时执行全量检查 (如果插件启用且当前实体有用户配置)
        if (extension_settings[extensionName]?.enabled) {
            console.log(`[${extensionName}] 初始设置: 插件已启用。检查是否需要初始全量检查。`); // 中文日志
            const initialSettings = getCurrentHideSettings();
             console.log(`[${extensionName}] 初始设置: 读取当前实体的初始设置:`, initialSettings);
            if(initialSettings?.userConfigured === true) {
                console.log(`[${extensionName}] 初始设置: 找到当前实体的用户配置设置。运行初始全量隐藏检查。`); // 中文日志
                runFullHideCheck(); // 直接运行，非防抖
            } else {
                console.log(`[${extensionName}] 初始设置: 未找到当前实体的用户配置设置。跳过初始全量检查。`); // 中文日志
            }
        } else {
             console.log(`[${extensionName}] 初始设置: 插件已禁用。跳过初始全量检查。`); // 中文日志
        }
        console.log(`[${extensionName}] 初始设置任务完成。`); // 中文日志
        // --- setTimeout 里面的代码结束 ---
    };

    // 检查 app_ready 事件类型是否存在
    // 确保 eventSource 和 event_types 都已加载
    if (typeof eventSource !== 'undefined' && typeof event_types !== 'undefined' && event_types.APP_READY) {
        console.log(`[${extensionName}] 等待 '${event_types.APP_READY}' 事件进行初始化...`); // 中文日志
        eventSource.on(event_types.APP_READY, initializeExtension);
    } else {
        // 回退: 如果没有 app_ready 事件，或者 eventSource/event_types 加载失败
        console.error(`[${extensionName}] 严重错误: 事件类型 'APP_READY' 在 event_types 中未找到，或 eventSource/event_types 未定义。无法保证正确初始化！回退到 2 秒延迟。`); // 中文日志
        const initialDelay = 2000;
        console.warn(`[${extensionName}] 使用延迟 ${initialDelay}ms 计划初始设置任务 (回退方案)`); // 中文日志
        setTimeout(initializeExtension, initialDelay); // 使用相同的 initializeExtension 函数作为回退
    }
});
