// index.js (使用 extension_settings 存储并包含自动迁移，优化了初始化)
import { extension_settings, loadExtensionSettings, getContext } from "../../../extensions.js";
import Logger from "./Logger.js";
// 尝试导入全局列表，路径可能需要调整！如果导入失败，迁移逻辑需要改用 API 调用
import { saveSettings, saveSettingsDebounced, eventSource, event_types, getRequestHeaders, characters, scrollChatToBottom, Generate, stopGeneration, is_send_press } from "../../../../script.js";

import { groups } from "../../../group-chats.js";
import { power_user } from "../../../power-user.js";
import { getTokenCountAsync } from "../../../tokenizers.js";
import { promptManager } from "../../../openai.js";
import { checkForUpdates, getChangelog, performUpdate, initUpdateCheck } from "./update.js";

const extensionName = "hide";
const defaultSettings = {
    // 全局默认设置
    enabled: true,
    // 自动隐藏功能总开关
    autoHideEnabled: true,
    // 记录是否首次查看隐藏楼层页面的使用说明
    hide_instructions_viewed: false,
    // 用于存储每个实体设置的对象
    settings_by_entity: {},
    // 迁移标志
    migration_v1_complete: true,
    // 添加全局设置相关字段
    useGlobalSettings: false,
    globalHideSettings: {
        hideLastN: null,
        lastProcessedLength: 0,
        userConfigured: false
    },
    // --- Limiter 设置 ---
    limiter_isEnabled: false,
    limiter_saved_count: 20, // 为被篡改时的还原备份
    limiter_migration_v2_complete: true,
    // --- 标签页状态保存 ---
    last_active_tab: 'hide-panel',
    // --- 主题设置 ---
    theme: 'light',
    // --- 日志级别设置 ---
    logLevel: 0, // 0=零日志(默认), 1=核心日志, 2=运行日志, 3=完整日志
    // --- 主题提示设置 ---
    theme_notification_viewed: false, // 是否已显示过主题切换提示
    // --- 日志UI显示设置 ---
    logUiVisible: false, // 控制日志级别选择器的显示/隐藏，默认隐藏
};

// Limiter 双向同步防重入标志
let _limiterSyncing = false;

// 缓存上下文
let cachedContext = null;

// --- 模拟生成 (Dry Run) 机制变量 ---
let isFakeGenerating = false;

// 触发假发送以刷新 EJS 统计数据
function forceRefreshTokenStats() {
    // 如果已经在真正的生成中，或者正在假生成中，则跳过
    if (isFakeGenerating || is_send_press) {
        Logger.debug('当前正在生成中，跳过模拟刷新');
        return;
    }
    isFakeGenerating = true;
    Logger.debug('触发模拟生成 (Dry Run) 获取最新 EJS 统计...');
    try {
        // 调用底层的发送，逼迫酒馆计算所有动态上下文
        Generate('normal');
    } catch (e) {
        isFakeGenerating = false;
        Logger.error('模拟生成失败:', e);
    }
}

// --- 聊天统计 (Token Stats) 数据存储 ---
let calculatedWiTokens = 0;
let wiDetailedStats = {};

// --- ST-PT 隐形拦截器 ---
let stptInterceptedEntries = [];
let isSTPTInterceptorSetup = false;
let stptLastRunID = -1; // 记录 ST-PT 的运行周期 ID

function setupSTPTInterceptor() {
    if (isSTPTInterceptorSetup) return;

    if (typeof eventSource !== 'undefined') {
        eventSource.on('prompt_template_prepare', (env) => {
            if (env && env.runType === 'generate') {
                
                // 周期管控：全新的生成回合重置拦截数组
                if (env.runID !== undefined && env.runID !== stptLastRunID) {
                    stptInterceptedEntries = [];
                    stptLastRunID = env.runID;
                }

                // 1. 顶层拦截 (如 @INJECT 等注入条目)
                if (env.world_info && env.world_info.comment) {
                    const val = env.world_info;
                    stptInterceptedEntries.push({
                        world: val.world || 'ST-PT 默认注入',
                        comment: val.comment || '未命名条目',
                        rawText: val.content || '',
                        isRaw: true
                    });
                }

                // 2. 动态劫持 (如 getwi)
                const interceptFunction = (funcName) => {
                    if (typeof env[funcName] === 'function' && !env[funcName]._isIntercepted) {
                        const originalFunc = env[funcName];
                        
                        env[funcName] = async function(...args) {
                            const result = await originalFunc.apply(this, args);

                            if (result && typeof result === 'string' && result.trim() !== '') {
                                let bookName = '';
                                let keyword = '';

                                // 步骤 A: 解析用户传给 getwi 的参数 (获取书名和检索词)
                                if (args.length >= 2 && typeof args[1] !== 'object') {
                                    // 应对 getwi(null, '柳飞絮') 或 getwi('书名', '柳飞絮')
                                    bookName = args[0] || (env.world_info && env.world_info.world) || '';
                                    keyword = String(args[1]);
                                } else if (args.length > 0) {
                                    // 应对 getwi('柳飞絮')
                                    bookName = (env.world_info && env.world_info.world) || '';
                                    keyword = String(args[0]);
                                }

                                // 兜底名字，防止反查失败
                                let exactEntryName = `[动态检索] ${keyword}`;
                                let finalBookName = bookName || '当前世界书';

                                // 🌟🌟🌟 步骤 B: - 利用 ST-PT 原生接口反查真实的条目名字！
                                // env.getWorldInfoData 是 ST-PT 暴露的获取世界书所有条目的方法
                                if (typeof env.getWorldInfoData === 'function') {
                                    try {
                                        // 传入书名获取该书所有条目（如果不传则获取当前环境生效的条目）
                                        const entries = await env.getWorldInfoData(bookName || undefined);
                                        
                                        if (Array.isArray(entries)) {
                                            // 完美复刻 ST-PT 底层的查找逻辑：严格等于或正则匹配
                                            const matchedEntry = entries.find(e => {
                                                if (!e || !e.comment) return false;
                                                if (e.comment === keyword || String(e.uid) === keyword) return true;
                                                try {
                                                    // 尝试用正则匹配 (ST-PT原生逻辑)
                                                    if (e.comment.match && e.comment.match(keyword)) return true;
                                                } catch(err) {}
                                                return false;
                                            });

                                            // 如果找到了真实条目，提取出它的真名！
                                            if (matchedEntry) {
                                                exactEntryName = matchedEntry.comment;
                                                if (matchedEntry.world) {
                                                    finalBookName = matchedEntry.world;
                                                }
                                            }
                                        }
                                    } catch(e) {
                                        // 忽略反查过程中的报错，安静地回落到兜底名字
                                        console.warn("[隐藏助手] 反查真实世界书条目名失败，使用检索词替代:", e);
                                    }
                                }

                                // 推入统计数组 (等待后续缝合)
                                stptInterceptedEntries.push({
                                    world: finalBookName,
                                    comment: exactEntryName,
                                    rawText: result,
                                    isRaw: false
                                });
                            }
                            return result;
                        };
                        env[funcName]._isIntercepted = true;
                    }
                };

                interceptFunction('getwi');
                interceptFunction('getWorldInfo');
            }
        });
        Logger.success('成功挂载 ST-PT 渲染监听器 (已支持反查真实条目名)');
    }
    isSTPTInterceptorSetup = true;
}

// DOM元素缓存
const domCache = {
    hideLastNInput: null,
    currentValueDisplay: null,
    // 初始化缓存
    init() {
        Logger.debug('初始化 DOM 缓存...');
        this.hideLastNInput = document.getElementById('hide-last-n');
        this.currentValueDisplay = document.getElementById('hide-current-value');
        Logger.debug('DOM 缓存已初始化:', {
            hideLastNInput: !!this.hideLastNInput,
            currentValueDisplay: !!this.currentValueDisplay
        });
    }
};

// --- 主题应用逻辑 ---
function applyTheme(theme) {
    // 同时寻找主弹窗、更新遮罩层、通知弹窗，赋予独立的局部主题标识
    const targets = $('#hide-helper-popup, .hide-modal-overlay, #hide-helper-theme-notification');
    if (theme === 'dark') {
        targets.attr('data-theme', 'dark');
        $('#hide-helper-theme-toggle').html('<i class="fa-solid fa-sun"></i> 切换为亮色模式');
    } else {
        targets.removeAttr('data-theme');
        $('#hide-helper-theme-toggle').html('<i class="fa-solid fa-moon"></i> 切换为暗色模式');
    }
}

// --- 主题提示弹窗辅助函数 ---
function showThemeNotification() {
    const $notification = $('#hide-helper-theme-notification');
    if ($notification.length === 0) {
        return;
    }

    // 使用 centerPopup 函数居中弹窗
    $notification.show();
    centerPopup($notification);

    // 绑定窗口大小变化事件
    $(window).off('resize.hideHelperNotification').on('resize.hideHelperNotification', () => centerPopup($notification));
}

function closeThemeNotification() {
    const $notification = $('#hide-helper-theme-notification');
    $(window).off('resize.hideHelperNotification');
    $notification.fadeOut(300, function() {
        $(this).remove();
    });
}

// --- 日志级别应用逻辑 ---
function applyLogLevel(level) {
    Logger.setLogLevel(level);
    $('#hide-helper-log-level-select').val(level);

    // 更新日志级别显示文本
    const levelTexts = ['零日志', '核心日志', '运行日志', '完整日志'];
    $('#hide-helper-log-level-display').text(levelTexts[level] || '零日志');
}

/**
 * 通用弹窗居中函数
 * @param {jQuery} $popup - 需要居中的弹窗的jQuery对象
 */
function centerPopup($popup) {
    if (!$popup || $popup.length === 0 || $popup.is(':hidden')) {
        return;
    }

    // --- 改回 JS 实时计算居中 ---
    // 解决移动端浏览器因视口高度变化导致的 CSS 居中定位失效问题
    // 通过获取实际窗口宽高并减去弹窗实际宽高，算出绝对安全的像素坐标

    const windowWidth = $(window).width();
    const windowHeight = $(window).height();
    const popupWidth = $popup.outerWidth();
    const popupHeight = $popup.outerHeight();

    // 动态计算居中坐标
    let top = (windowHeight - popupHeight) / 2;
    let left = (windowWidth - popupWidth) / 2;

    // 安全边界防溢出（留出至少 10px 的边距，防止极小屏幕下跑偏到屏幕外）
    top = Math.max(10, top);
    left = Math.max(10, left);

    $popup.css({
        top: top + 'px',
        left: left + 'px',
        transform: 'none', // 清除可能存在的 CSS 缩放和平移干扰
        margin: '0'
    });
}

// 获取优化的上下文
function getContextOptimized() {
    if (!cachedContext) {
        Logger.debug('上下文缓存未命中，正在获取...');
        cachedContext = getContext(); // getContext returns a rich object
        Logger.debug('上下文已获取');
    } else {
        Logger.debug('上下文缓存命中');
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
            Logger.warn(`无法确定角色实体 ID (索引 ${context.characterId}): 缺少头像文件名`);
            return null; // 无法确定唯一ID
        }
    }
    Logger.debug('无法从上下文确定实体 ID');
    return null; // 无法确定实体
}

// 运行数据迁移 (从旧位置到新的全局位置)
function runMigration() {
    Logger.info('开始旧版本设置迁移过程...');
    let migratedCount = 0;
    // 确保容器存在
    extension_settings[extensionName].settings_by_entity = extension_settings[extensionName].settings_by_entity || {};
    const settingsContainer = extension_settings[extensionName].settings_by_entity;
    Logger.debug('设置容器已初始化');

    // --- 迁移角色数据 ---
    Logger.debug('开始角色设置迁移');
    if (typeof characters !== 'undefined' && Array.isArray(characters)) {
        Logger.debug(`找到 ${characters.length} 个角色`);
        characters.forEach((character, index) => {
            Logger.debug(`处理角色 #${index}: ${character ? character.name : '不可用'}`);
            if (!character || !character.data || !character.data.extensions) {
                Logger.debug(`跳过角色 #${index}: 缺少必要属性`);
                return;
            }
            try {
                const oldSettingsPath = 'character.data.extensions.hideHelperSettings';
                const oldSettings = character.data.extensions.hideHelperSettings;
                if (oldSettings && typeof oldSettings === 'object' && oldSettings !== null) {
                    const hasHideLastN = typeof oldSettings.hideLastN === 'number';
                    const hasLastProcessedLength = typeof oldSettings.lastProcessedLength === 'number';
                    const isUserConfigured = oldSettings.userConfigured === true;
                    const isValidOldData = hasHideLastN || hasLastProcessedLength || isUserConfigured;
                    Logger.debug(`验证旧设置: hasHideLastN=${hasHideLastN}, hasLastProcessedLength=${hasLastProcessedLength}, isUserConfigured=${isUserConfigured}`);
                    if (isValidOldData) {
                        const avatarFileName = character.avatar;
                        if (avatarFileName) {
                            const entityId = `character-${avatarFileName}`;
                            if (!settingsContainer.hasOwnProperty(entityId)) {
                                Logger.debug(`迁移实体 '${entityId}' 的设置`);
                                settingsContainer[entityId] = { ...oldSettings };
                                migratedCount++;
                                Logger.debug(`实体 '${entityId}' 迁移成功 (${migratedCount})`);
                            } else {
                                Logger.debug(`跳过 '${entityId}': 新位置已存在`);
                            }
                        } else {
                             Logger.warn(`跳过迁移: 角色 ${character.name || '不可用'} 缺少头像文件名`);
                        }
                    } else {
                         Logger.debug(`跳过角色 ${character.name || '不可用'}: 旧设置数据无效`);
                    }
                } else {
                     Logger.debug(`角色 #${index}: 无需迁移`);
                }
            } catch (charError) {
                 Logger.error(`迁移角色 #${index} (${character.name || '不可用'}) 时出错:`, charError);
            }
        });
         Logger.debug('完成角色设置迁移');
    } else {
         Logger.warn('无法迁移角色设置: characters 数组不可用');
    }

    // --- 迁移群组数据 ---
    Logger.debug('开始群组设置迁移');
    if (typeof groups !== 'undefined' && Array.isArray(groups)) {
        Logger.debug(`找到 ${groups.length} 个群组`);
        groups.forEach((group, index) => {
            Logger.debug(`处理群组 #${index}: ${group ? group.name : '不可用'} (ID: ${group ? group.id : '不可用'})`);
             if (!group || !group.data) {
                Logger.debug(`跳过群组 #${index}: 缺少必要属性`);
                return;
            }
            try {
                const oldSettingsPath = 'group.data.hideHelperSettings';
                const oldSettings = group.data.hideHelperSettings;
                if (oldSettings && typeof oldSettings === 'object' && oldSettings !== null) {
                    const hasHideLastN = typeof oldSettings.hideLastN === 'number';
                    const hasLastProcessedLength = typeof oldSettings.lastProcessedLength === 'number';
                    const isUserConfigured = oldSettings.userConfigured === true;
                    const isValidOldData = hasHideLastN || hasLastProcessedLength || isUserConfigured;
                    Logger.debug(`验证旧设置: hasHideLastN=${hasHideLastN}, hasLastProcessedLength=${hasLastProcessedLength}, isUserConfigured=${isUserConfigured}`);
                    if (isValidOldData) {
                        const groupId = group.id;
                        if (groupId) {
                            const entityId = `group-${groupId}`;
                            if (!settingsContainer.hasOwnProperty(entityId)) {
                                Logger.debug(`迁移实体 '${entityId}' 的设置`);
                                settingsContainer[entityId] = { ...oldSettings };
                                migratedCount++;
                                Logger.debug(`实体 '${entityId}' 迁移成功 (${migratedCount})`);
                            } else {
                                Logger.debug(`跳过 '${entityId}': 新位置已存在`);
                            }
                        } else {
                            Logger.warn(`跳过迁移: 群组 ${group.name || '不可用'} 缺少 ID`);
                        }
                    } else {
                        Logger.debug(`跳过群组 ${group.name || '不可用'}: 旧设置数据无效`);
                    }
                } else {
                     Logger.debug(`群组 #${index}: 无需迁移`);
                }
            } catch (groupError) {
                Logger.error(`迁移群组 #${index} (${group.name || '不可用'}) 时出错:`, groupError);
            }
        });
         Logger.debug('完成群组设置迁移');
    } else {
        Logger.warn('无法迁移群组设置: groups 数组不可用');
    }

    // --- 完成迁移 ---
     Logger.debug('迁移过程结束');
    if (migratedCount > 0) {
         Logger.success(`迁移完成：成功迁移 ${migratedCount} 个实体的设置`);
    } else {
         Logger.info('迁移完成：无需迁移设置');
    }

    // 无论是否迁移了数据，都将标志设置为 true，表示迁移过程已执行
    extension_settings[extensionName].migration_v1_complete = true;
    Logger.debug('设置 migration_v1_complete 标志为 true');
    saveSettingsDebounced();
    Logger.debug('迁移过程完毕');
}


// 初始化扩展设置 (包含迁移检查)
function loadSettings() {
    Logger.debug('加载设置中...');
    extension_settings[extensionName] = extension_settings[extensionName] || {};

    // 使用 Object.assign 合并默认值，确保所有顶级键都存在
    Object.assign(extension_settings[extensionName], {
        ...defaultSettings, // 先用默认值填充所有
        ...extension_settings[extensionName] // 然后用保存的值覆盖
    });
    // 确保深层对象也被正确初始化
    extension_settings[extensionName].globalHideSettings = extension_settings[extensionName].globalHideSettings || { ...defaultSettings.globalHideSettings };

    // --- 防止 settings_by_entity 被错误地反序列化为数组 ---
    // 如果 settings_by_entity 是数组，JSON.stringify 保存时会丢弃所有键值对，导致重启后数据丢失
    if (Array.isArray(extension_settings[extensionName].settings_by_entity)) {
        Logger.warn('检测到 settings_by_entity 数据结构损坏（类型为 Array），已强制修复为 Object');
        // 强制重置为空对象。如果不重置，后续的赋值在内存中有效，但无法写入 settings.json
        extension_settings[extensionName].settings_by_entity = {};
        // 立即触发一次保存，固化修复后的结构
        saveSettingsDebounced();
    }

    extension_settings[extensionName].settings_by_entity = extension_settings[extensionName].settings_by_entity || { ...defaultSettings.settings_by_entity };

    // --- 检查并运行迁移 ---
    if (!extension_settings[extensionName].migration_v1_complete) {
        Logger.info('迁移标志未找到，开始迁移...');
        try {
            runMigration();
        } catch (error) {
            Logger.error('执行迁移时发生错误:', error);
            // toastr.error('迁移旧设置时发生意外错误，请检查控制台日志。');
        }
    } else {
        Logger.debug('迁移标志为 true，跳过迁移');
    }
    // --------------------------

    // --- Limiter v2 迁移: 从 limiter_messageLimit 迁移到 power_user.chat_truncation ---
    if (!extension_settings[extensionName].limiter_migration_v2_complete) {
        const settings = extension_settings[extensionName];
        if (typeof settings.limiter_messageLimit === 'number') {
            if (settings.limiter_isEnabled && settings.limiter_messageLimit > 0) {
                power_user.chat_truncation = settings.limiter_messageLimit;
                if ($('#chat_truncation').length) {
                    $('#chat_truncation').val(settings.limiter_messageLimit);
                    $('#chat_truncation_counter').val(settings.limiter_messageLimit);
                }
                saveSettingsDebounced();
                Logger.info(`Limiter v2 迁移: 已将 limiter_messageLimit=${settings.limiter_messageLimit} 写入 chat_truncation`);
            }
            delete settings.limiter_messageLimit;
            Logger.info('Limiter v2 迁移: 已删除旧字段 limiter_messageLimit');
        }
        settings.limiter_migration_v2_complete = true;
        saveSettingsDebounced();
    }

    Logger.debug('设置已加载/初始化');
}

// 创建UI面板
function createUI() {
    Logger.debug('创建 UI 面板');
    const settingsHtml = `
    <div id="hide-helper-settings" class="hide-helper-container">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <div style="display:flex; align-items:center;">
                    <b>隐藏助手</b>
                    <span id="hide-helper-new-badge" class="hide-new-badge" style="display: none;">NEW</span>
                </div>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <!-- 版本信息与更新检测 -->
                <div class="hide-version-row">
                    <span>当前版本: <span id="hide-helper-current-version">加载中...</span></span>
                    <button id="hide-helper-check-update-btn" class="menu_button hide-update-btn">检查更新</button>
                </div>

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
                <div class="hide-settings-tip">点击聊天输入框左侧菜单按钮中的隐藏助手按钮，即可打开插件面板</div>
                <hr class="sysHR">
            </div>
        </div>
    </div>`;

    Logger.debug('追加设置 UI 到 #extensions_settings');
    $("#extensions_settings").append(settingsHtml);
    createInputWandButton();
    createPopup();
    setupEventListeners();
    Logger.debug('安排 DOM 缓存初始化');
    setTimeout(() => domCache.init(), 100); // DOM缓存可以稍后初始化
}

// 创建输入区旁的按钮
function createInputWandButton() {
    Logger.debug('创建输入区按钮');
    // 移除旧按钮，以防重复
    $('#hide-helper-wand-button').remove();
    const buttonHtml = `
        <div id="hide-helper-wand-button" title="打开隐藏助手设置">
            <i class="fa-solid fa-ghost"></i>
            <span>隐藏助手</span>
        </div>`;
    Logger.debug('追加按钮到 #data_bank_wand_container');
    $('#data_bank_wand_container').append(buttonHtml);
}

// index.js (部分)

// 创建弹出对话框
function createPopup() {
    Logger.debug('创建弹出对话框');
    const popupHtml = `
        <div id="hide-helper-backdrop" class="hide-helper-backdrop"></div>
        <div id="hide-helper-popup" class="hide-helper-popup">
            <button id="hide-helper-popup-close-icon" class="hide-helper-popup-close-icon">&times;</button>

            <!-- 标签页导航 -->
            <div class="popup-tabs-nav">
                <div class="tab-button veve" data-tab="hide-panel">隐藏楼层</div>
                <div class="tab-button" data-tab="limiter-panel">限制楼层</div>
                <div class="tab-button" data-tab="token-stats-panel">聊天统计</div>
                <div class="tab-button" data-tab="instructions-panel">使用说明</div>
            </div>

            <!-- 标签页内容 -->
            <div class="popup-tabs-content">
                <!-- 面板1: 隐藏楼层 -->
                <div id="hide-panel" class="tab-panel active" data-tab="hide-panel">
                    <!-- 新增：功能总开关 -->
                    <div class="limiter-setting-item">
                        <label for="hide-auto-process-toggle">启用隐藏楼层功能</label>
                        <div class="hide-helper-checkbox-container">
                            <input id="hide-auto-process-toggle" type="checkbox">
                            <label for="hide-auto-process-toggle"></label>
                        </div>
                    </div>

                    <div class="limiter-setting-item" id="hide-disabled-msg">
                        当前隐藏楼层功能已禁用
                    </div>

                    <div id="hide-settings-wrapper">
                        <div class="hide-helper-section hide-last-n-section">
                            <label class="hide-helper-label">保留最新的N条消息，并隐藏其余旧楼层</label>
                            <input type="number" id="hide-last-n" min="0" placeholder="" class="hide-last-n-input">
                        </div>
                        <div class="hide-helper-current">
                            <strong id="hide-status-text">当前保留楼层数:</strong>
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
                        <div class="hide-helper-popup-footer hide-helper-popup-footer-center">
                            <button id="hide-unhide-all-btn" class="hide-helper-btn">
                                <i class="fa-solid fa-eye-slash"></i> 立即将当前聊天所有楼层取消隐藏
                            </button>
                        </div>

                        <!-- 功能说明区域 -->
                        <div class="hide-panel-instructions">
                            <h3 id="hide-panel-instructions-title">使用说明</h3>
                            <div class="instructions-content">
                                <p class="important-note"><strong>启用该隐藏楼层功能后，酒馆将始终只发送最近N条楼层给AI，而N条目楼层之外的消息将会始终自动隐藏。</strong></p>
                                <p><strong>1. 前提说明</strong></p>
                                <p>在使用"自动隐藏"功能前，请务必确认以下配置：</p>
                                <ul>
                                    <li><strong>必要操作</strong>：必须勾选 <strong>【启用隐藏楼层功能】</strong> 并设置 <strong>【保留的楼层数 N】</strong>，否则功能不会生效。</li>
                                    <li><strong>功能独立性</strong>：插件包含【隐藏楼层】、【限制楼层】和【聊天统计】三个核心功能。它们之间相互独立，互不影响。</li>
                                    <li>若只想使用【限制楼层】和【聊天统计】，只需<strong>不勾选</strong>【启用隐藏楼层功能】即可。</li>
                                </ul>

                                <p><strong>2. 使用说明</strong></p>
                                <p>设置保留楼层数 <strong>N</strong> 并启用功能后，插件会始终自动隐藏最近 N 楼之外的所有消息。</p>
                                <ul>
                                    <li><strong>示例</strong>：设置保留最近 <strong>1</strong> 楼。</li>
                                    <li><strong>效果</strong>：若当前共有第 0 楼至第 9 楼消息，插件将自动隐藏第 0 至第 8 楼，仅将最新的第 9 楼消息发送给 AI。</li>
                                </ul>

                                <p><strong>3. 立即将当前聊天所有楼层取消隐藏</strong></p>
                                <p>点击此按钮将执行以下操作：</p>
                                <ol>
                                    <li>立即取消当前聊天中所有楼层的隐藏状态。</li>
                                    <li>清空【保留的楼层数 N】的数值。</li>
                                    <li><strong>结果</strong>：自动隐藏功能将处于不生效状态。</li>
                                </ol>

                                <p><strong>4. 模式选择</strong></p>
                                <p>插件提供两种配置模式，建议根据使用习惯选择：</p>
                                <ul>
                                    <li><strong>全局模式（推荐）</strong>：只需设置一次【保留的楼层数】。该数值将应用于所有角色，切换角色无需重新配置，简单方便。</li>
                                    <li><strong>角色模式</strong>：需要为每个角色卡单独设置【保留的楼层数】。注意：若某个角色未设置数值（数值为空），则该角色的自动隐藏功能不会生效。</li>
                                </ul>

                                <p><strong>5. 注意事项与兼容性</strong></p>
                                <ul>
                                    <li><strong>正则冲突</strong>：该功能与"隐藏楼层正则"冲突，请确保仅开启其中一个。</li>
                                    <li><strong>插件冲突</strong>：若其他插件/脚本也具备自动隐藏功能，请仅启用其中一个，避免运行逻辑打架。</li>
                                    <li><strong>核心原理</strong>：在没有其他脚本干预的情况下，本插件能确保仅发送最近 N 条消息。除了执行隐藏操作外，插件还会从底层<strong>直接截断发送的上下文</strong>，从根本上保证发送的消息层数符合设定。</li>
                                </ul>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 面板2: 限制楼层 -->
                <div id="limiter-panel" class="tab-panel" data-tab="limiter-panel">
                    <div class="limiter-setting-item">
                        <label for="limiter-enabled">启用限制楼层功能</label>
                        <div class="hide-helper-checkbox-container">
                            <input id="limiter-enabled" type="checkbox">
                            <label for="limiter-enabled"></label>
                        </div>
                    </div>
                    <div class="limiter-setting-item" id="limiter-count-wrapper">
                        <label for="limiter-count">加载的消息楼层数量</label>
                        <input id="limiter-count" type="number" class="text_pole" min="0" max="1000" step="1" placeholder="例如: 20">
                    </div>
                    <div class="limiter-setting-item" id="limiter-disabled-msg">
                        当前限制楼层功能已禁用
                    </div>
                    <div class="limiter-description">
                        该功能会实时动态限制聊天界面加载的消息楼层数量，以减少酒馆卡顿，提高流畅度。建议设置的【加载的消息楼层数量】不要超过20。没有加载（且也未被隐藏）的楼层消息依然会被当做上下文发送给AI。该功能实际上和酒馆原生的【要渲染 # 条消息】是同一个接口，因此和酒馆或酒馆助手以及鸡尾酒插件的"限制消息加载"功能不会冲突。
                    </div>
                </div>

                <!-- 面板3: 聊天统计 -->
                <div id="token-stats-panel" class="tab-panel" data-tab="token-stats-panel">
                    <div id="token-stats-content" class="tub-body">
                        <div class="tub-row-1" id="tub-row-overview"></div>
                        <div class="tub-row-2" id="tub-row-wi-chart"></div>
                        <div id="tub-entries-section"></div>
                    </div>
                </div>

                <!-- 面板4: 使用说明 -->
                <div id="instructions-panel" class="tab-panel" data-tab="instructions-panel">
                    <div id="hide-helper-instructions-content" class="hide-helper-instructions-content">

                        <!-- 主题切换按钮 -->
                        <div class="theme-switch-container">
                            <span class="theme-switch-label">UI主题</span>
                            <button id="hide-helper-theme-toggle" class="hide-helper-btn">
                                <i class="fa-solid fa-moon"></i> 切换为暗色模式
                            </button>
                        </div>

                        <!-- 日志UI显示开关 -->
                        <div class="log-ui-toggle-container">
                            <label for="hide-helper-log-ui-toggle" class="log-ui-toggle-label">显示日志</label>
                            <div style="display: flex; align-items: center;">
                                <i class="fa-solid fa-download" id="hide-helper-download-log" title="下载调试日志" style="cursor: pointer; margin-right: 12px; font-size: 16px; color: var(--hh-text-secondary); display: none; transition: color 0.2s;"></i>
                                <div class="hide-helper-checkbox-container">
                                    <input id="hide-helper-log-ui-toggle" type="checkbox">
                                    <label for="hide-helper-log-ui-toggle"></label>
                                </div>
                            </div>
                        </div>

                        <!-- 日志级别选择器（默认隐藏） -->
                        <div class="log-level-selector-wrapper" style="display: none;">
                        <div class="log-level-switch-container">
                            <span class="log-level-label">日志级别</span>
                            <select id="hide-helper-log-level-select" class="hide-helper-select log-level-select">
                                <option value="0">零日志 (无输出)</option>
                                <option value="1">核心日志 (错误+警告)</option>
                                <option value="2">运行日志 (全部运行信息)</option>
                                <option value="3">完整日志 (含调试)</option>
                            </select>
                        </div>
                        </div>

                        <video class="instructions-video" controls muted loop playsinline>
                            <source src="https://files.catbox.moe/wmv5bd.mp4" type="video/mp4">
                            您的浏览器不支持 Video 标签。
                        </video>

                        <h2>核心功能协同与区别</h2>
                        <p><strong>隐藏楼层</strong> 和 <strong>限制楼层</strong> 是两个可以独立配置并协同工作的功能，用于解决不同问题（可搭配使用）：</p>
                        <ul>
                            <li><strong>隐藏楼层（节省tokens）:</strong> 此功能通过会将消息进行隐藏，被隐藏的消息会出现👻幽灵图标。被隐藏的消息<strong>不会</strong>被发送给AI。</li>
                            <li><strong>限制楼层（提高流畅度）:</strong> 此功能不修改任何数据，它仅仅是<strong>视觉上</strong>限制了聊天界面加载和显示的消息楼层数量。所有未被隐藏的消息依然会被发送给AI，只是没有在前端被渲染出来，这可以极大提升超长对话的性能、减少酒馆卡顿。</li>
                            <li><strong>注意 :</strong>“隐藏”这个词在酒馆中是指：出现幽灵图标👻的消息。这种消息不会当做上下文发送给AI。而没有加载的消息，仅仅是聊天界面没有加载，不代表它不被发送给AI。是否发送给AI，要看它是否被隐藏，而不是看它是否显示在聊天界面中。</li>
                        </ul>

                        <h2>隐藏楼层 (功能一)</h2>
                        <p>
                           此功能的核心是：在每次与AI交互时，仅发送最新的N条消息作为上下文，并自动隐藏其余的旧消息。
                        </p>
                        <p class="important">
                            <i class="fa-solid fa-shield-halved"></i> <strong>双重保护机制：</strong>本插件同时使用“消息隐藏”和“请求拦截”两种方式确保旧消息不会被发送给AI。即使某些消息楼层因特殊原因未能生效（例如被其他插件/脚本的隐藏功能覆盖），拦截机制仍会在API请求发出前强制截断消息列表，作为最终兜底保障，确保实际上发送的消息楼层真的只有最近N条消息楼层。
                        </p>
                        <p>
                            在输入框中填入您想 <strong>保留的最新消息楼层数量</strong> (例如 <code>4</code>)，然后点击 <span class="button-like">保存设置</span> 按钮。插件便会立即生效，隐藏设定范围之外的所有内容。
                        </p>
                        <p>
                            <strong>示例：</strong> 假设当前聊天共有10条消息。您输入 <code>4</code> 并保存，则最新的4条消息会发送给AI，而之前的6条消息将不会发生给AI。当您或AI发送新消息后，插件会自动调整，确保始终只有最新的4条消息是未隐藏的，而之前的消息楼层则始终是隐藏的。
                        </p>
                        <h3>全局模式 vs 角色模式</h3>
                        <p>
                            您可以通过弹窗中的 <strong>拨动开关</strong> 在两种模式间轻松切换：
                            <ul>
                                <li><strong>全局模式：</strong> 在此模式下，您设置的保留数量将应用于 <strong>所有</strong> 角色卡和群聊。一次设置，处处生效。</li>
                                <li><strong>角色模式：</strong> 在此模式下，设置将 <strong>仅</strong> 绑定到当前角色。您可以为每个角色或群聊设定并保存一个独立的保留数量。</li>
                            </ul>
                        </p>
                         <h3>取消隐藏</h3>
                         <p>
                            点击 <span class="button-like">取消隐藏</span> 按钮后，插件会立刻将当前聊天的楼层全部取消楼层一遍，并且将保留楼层的N值置空，置空状态下自动隐藏功能将不会生效。
                        </p>
                        <p class="important">
                            <i class="fa-solid fa-circle-info"></i> 被隐藏的消息 <strong>不会</strong> 被包含在发送给AI的上下文中。这意味着AI无法“看到”这些N楼之前的消息，这对于控制上下文长度和节省tokens非常有帮助。
                        </p>

                        <h2>限制楼层 (功能2)</h2>
                        <p>
                            此功能通过控制酒馆原生的“加载消息数”设置来优化超长对话的浏览体验。它只影响您在酒馆聊天界面中<strong>【显示】</strong>的消息数量，而不会修改任何聊天数据或影响发送给AI的上下文。由于限制酒馆界面加载的消息数量，因此该功能可以极大减少酒馆的卡顿，尤其是高楼层聊天。
                        </p>
                        <p>
                            开启后，您可以在此处或酒馆的“用户设置”面板中的“要渲染 # 条消息”调整数值，两者自动同步。设为 <code>0</code> 表示不限制（加载全部消息）。
                        </p>
                        <p>
                           <strong>示例：</strong> 您设置加载 <code>20</code> 条消息。即使完整对话有1000条，聊天窗口也只加载并显示最后20条。如果需要查看更早的消息，可以点击聊天底部的“Show more messages”按钮。
                        </p>
                    </div>
                </div>
            </div>
        </div>`;
    Logger.debug('追加弹窗 HTML 到 body');
    $('body').append(popupHtml);

    // 添加更新弹窗的遮罩层
    const overlayHtml = `<div id="hide-helper-modal-overlay" class="hide-modal-overlay"></div>`;
    if ($('#hide-helper-modal-overlay').length === 0) {
        $('body').append(overlayHtml);
    }

    // 添加主题提示弹窗的HTML（如果需要显示）
    if (!extension_settings[extensionName].theme_notification_viewed) {
        const notificationHtml = `
            <div id="hide-helper-theme-notification" class="hide-helper-notification-popup">
                <div class="notification-content">
                    <div class="notification-icon">
                        <i class="fa-solid fa-moon"></i>
                    </div>
                    <h3>插件现已提供白天/黑夜两套UI主题</h3>
                    <p>可以在【使用说明】页面进行切换。</p>
                    <div class="notification-buttons">
                        <button id="hide-helper-switch-theme-now" class="hide-helper-btn notification-primary-btn">
                            <i class="fa-solid fa-moon"></i> 立即切换到黑夜主题
                        </button>
                        <button id="hide-helper-notification-close" class="hide-helper-btn notification-secondary-btn">
                            我已知晓
                        </button>
                    </div>
                </div>
            </div>`;
        $('body').append(notificationHtml);
    }
}

// 获取当前应该使用的隐藏设置 (从全局 extension_settings 读取)
function getCurrentHideSettings() {
    Logger.debug('获取当前隐藏设置');
    // 检查是否使用全局设置
    if (extension_settings[extensionName]?.useGlobalSettings) {
        Logger.debug('使用全局设置');
        return extension_settings[extensionName]?.globalHideSettings || null;
    }

    // 使用特定实体的设置
    const entityId = getCurrentEntityId();
    if (!entityId) {
        Logger.debug('无法确定实体 ID');
        return null;
    }
    const settings = extension_settings[extensionName]?.settings_by_entity?.[entityId] || null;
    Logger.debug(`读取实体 "${entityId}" 的设置:`, settings);
    return settings;
}

// 保存当前隐藏设置 (到全局 extension_settings)
function saveCurrentHideSettings(hideLastN) {
    Logger.debug(`保存隐藏设置: hideLastN=${hideLastN}`);
    const context = getContextOptimized();
    if (!context) {
        Logger.error('无法保存设置：上下文不可用');
        return false;
    }

    const chatLength = context.chat?.length || 0;
    Logger.debug(`当前聊天长度=${chatLength}`);

    const settingsToSave = {
        hideLastN: (hideLastN !== null && hideLastN > 0) ? hideLastN : null, // 存储为 null 表示禁用
        lastProcessedLength: chatLength,
        userConfigured: true
    };
    Logger.debug('要保存的设置对象:', settingsToSave);

    extension_settings[extensionName] = extension_settings[extensionName] || {};

    // 检查是否使用全局设置
    if (extension_settings[extensionName].useGlobalSettings) {
        Logger.debug('保存到全局设置');
        extension_settings[extensionName].globalHideSettings = settingsToSave;
        Logger.debug('已更新全局隐藏设置');
    } else {
        // 使用特定实体的设置
        const entityId = getCurrentEntityId();
        if (!entityId) {
            Logger.error('无法保存设置：无法确定实体 ID');
            toastr.error('无法保存设置：无法确定当前角色或群组。');
            return false;
        }

        Logger.debug(`保存实体 "${entityId}" 的设置，聊天长度=${chatLength}`);
        extension_settings[extensionName].settings_by_entity = extension_settings[extensionName].settings_by_entity || {};
        extension_settings[extensionName].settings_by_entity[entityId] = settingsToSave;
        Logger.debug(`已更新实体 "${entityId}" 的设置`);
    }

    saveSettingsDebounced();
    Logger.debug('已调用 saveSettingsDebounced()');
    return true;
}

// 更新当前设置显示
function updateCurrentHideSettingsDisplay() {
    Logger.debug('更新隐藏设置显示');

    const settings = extension_settings[extensionName];
    const currentHideSettings = getCurrentHideSettings();
    const $statusText = $('#hide-status-text');
    const $valueDisplay = $('#hide-current-value');
    const $input = $('#hide-last-n');

    // 更新功能总开关状态
    const autoHideEnabled = settings.autoHideEnabled ?? true;
    $('#hide-auto-process-toggle').prop('checked', autoHideEnabled);

    // 根据开关状态切换输入框和提示文本的显示
    if (autoHideEnabled) {
        $('#hide-settings-wrapper').show();
        $('#hide-disabled-msg').hide();
    } else {
        $('#hide-settings-wrapper').hide();
        $('#hide-disabled-msg').show();
    }

    // 逻辑判定文案
    if (!autoHideEnabled) {
        $statusText.text("自动隐藏楼层功能已禁用");
        $valueDisplay.text("");
    } else if (!currentHideSettings?.hideLastN || currentHideSettings.hideLastN <= 0) {
        $statusText.text("当前未设置保留值N，自动隐藏不会生效");
        $valueDisplay.text("");
    } else {
        $statusText.text("当前保留楼层数:");
        $valueDisplay.text(currentHideSettings.hideLastN);
    }

    // 更新输入框 (0 或空都显示为空)
    $input.val(currentHideSettings?.hideLastN > 0 ? currentHideSettings.hideLastN : '');

    // 更新模式切换 UI
    const useGlobal = extension_settings[extensionName]?.useGlobalSettings || false;
    $('#hide-mode-toggle').prop('checked', useGlobal);
    $('#hide-mode-label').text(useGlobal ? '全局模式' : '角色模式');
    $('#hide-mode-description').text(useGlobal ? '隐藏将应用于所有角色卡' : '隐藏仅对当前角色卡生效');

	// --- 更新 Limiter 面板 ---
    // 优先从插件自身的影子变量读取（防篡改兜底），其次读底层，最后读DOM
    let nativeTruncation = extension_settings[extensionName].limiter_saved_count;
    if (!nativeTruncation || nativeTruncation <= 0) {
        nativeTruncation = power_user.chat_truncation;
        if (typeof nativeTruncation !== 'number' || isNaN(nativeTruncation) || nativeTruncation <= 0) {
            nativeTruncation = Number($('#chat_truncation').val()) || 0;
        }
    }

    const isLimiterEnabled = extension_settings[extensionName].limiter_isEnabled;
    $('#limiter-enabled').prop('checked', isLimiterEnabled);
    // 有效值则显示，为 0 时设为空字符串，使其平滑回落到 placeholder 的提示
    $('#limiter-count').val(nativeTruncation > 0 ? nativeTruncation : '');

    // 根据开关状态切换输入框和提示文本的显示
    if (isLimiterEnabled) {
        $('#limiter-count-wrapper').show();
        $('#limiter-disabled-msg').hide();
    } else {
        $('#limiter-count-wrapper').hide();
        $('#limiter-disabled-msg').show();
    }

    Logger.debug('完成更新隐藏设置显示');
}

// 防抖函数
function debounce(fn, delay) {
    let timer;
    return function(...args) {
        Logger.debug(`防抖: 清除 ${fn.name} 的计时器`);
        clearTimeout(timer);
        Logger.debug(`防抖: 为 ${fn.name} 设置 ${delay}ms 计时器`);
        timer = setTimeout(() => {
            Logger.debug(`防抖: 执行 ${fn.name}`);
            fn.apply(this, args);
        }, delay);
    };
}


// 防抖版本的全量检查
const runFullHideCheckDebounced = debounce(runFullHideCheck, 200);

// 自动保存防抖
const saveSettingsAutoDebounced = debounce(() => {
    const val = parseInt($('#hide-last-n').val());
    if (val > 0) {
        saveCurrentHideSettings(val);
        runFullHideCheckDebounced();
        updateCurrentHideSettingsDisplay();
    } else if (val === 0) {
        unhideAllMessages(true);
    } else {
        // 输入为空
        saveCurrentHideSettings(null);
        updateCurrentHideSettingsDisplay();
    }
}, 800);

// 检查是否应该执行隐藏/取消隐藏操作
function shouldProcessHiding() {
    Logger.debug('检查是否应该处理隐藏');
    const mainEnabled = extension_settings[extensionName]?.enabled; // 扩展总开关
    const autoHideEnabled = extension_settings[extensionName]?.autoHideEnabled ?? true; // 隐藏功能开关

    if (!mainEnabled || !autoHideEnabled) {
        Logger.debug(`插件或自动隐藏功能已禁用 (mainEnabled=${mainEnabled}, autoHideEnabled=${autoHideEnabled})，返回 false`);
        return false;
    }

    const settings = getCurrentHideSettings();
    Logger.debug('当前实体的设置:', settings);
    // 如果没有配置，或者 hideLastN 是 null/undefined/NaN/0，则不进行自动隐藏处理
    if (!settings || !settings.userConfigured || !settings.hideLastN || settings.hideLastN <= 0) {
        Logger.debug('未找到有效的用户配置或隐藏值为空/0，返回 false');
        return false;
    }
    Logger.debug('插件已启用且找到有效用户配置，返回 true');
    return true;
}

// 增量隐藏检查
async function runIncrementalHideCheck() {
    Logger.debug('开始增量隐藏检查');
    if (!shouldProcessHiding()) {
        Logger.debug('shouldProcessHiding 返回 false，跳过');
        return;
    }

    const startTime = performance.now();
    const context = getContextOptimized();
    if (!context || !context.chat) {
        Logger.debug('上下文或聊天数据不可用，中止');
        return;
    }

    const chat = context.chat;
    const currentChatLength = chat.length;
    const settings = getCurrentHideSettings() || { hideLastN: 0, lastProcessedLength: 0, userConfigured: false };
    const { hideLastN, lastProcessedLength = 0 } = settings;
    Logger.debug(`当前聊天长度=${currentChatLength}, hideLastN=${hideLastN}, lastProcessedLength=${lastProcessedLength}`);

    if (currentChatLength === 0 || hideLastN <= 0) {
        Logger.debug('条件满足 (currentChatLength === 0 || hideLastN <= 0)，检查是否需要保存');
        if (currentChatLength !== lastProcessedLength && settings.userConfigured) {
            Logger.debug(`长度变化 (${lastProcessedLength} -> ${currentChatLength})，保存设置`);
            saveCurrentHideSettings(hideLastN);
        } else {
             Logger.debug('长度未变化或未配置用户，跳过保存');
        }
        Logger.debug('跳过主要逻辑');
        return;
    }

    if (currentChatLength <= lastProcessedLength) {
        Logger.debug(`跳过: 聊天长度未增加或减少 (${lastProcessedLength} -> ${currentChatLength})`);
         if (currentChatLength < lastProcessedLength && settings.userConfigured) {
            Logger.debug('聊天长度减少，保存设置');
            saveCurrentHideSettings(hideLastN);
         }
        return;
    }

    const targetVisibleStart = Math.max(0, currentChatLength - hideLastN);
    const previousVisibleStart = lastProcessedLength > 0 ? Math.max(0, lastProcessedLength - hideLastN) : 0;
    Logger.debug(`计算可见范围: targetVisibleStart=${targetVisibleStart}, previousVisibleStart=${previousVisibleStart}`);

    if (targetVisibleStart > previousVisibleStart) {
        const toHideIncrementally = [];
        const startIndex = previousVisibleStart;
        const endIndex = targetVisibleStart;
        Logger.debug(`需要检查范围 [${startIndex}, ${endIndex}) 的消息`);

        for (let i = startIndex; i < endIndex; i++) {
            if (chat[i] && chat[i].is_system !== true) {
                toHideIncrementally.push(i);
                 Logger.debug(`添加消息 ${i} 到增量隐藏列表`);
            } else {
                 Logger.debug(`跳过消息 ${i} (已是系统消息或缺失)`);
            }
        }

        if (toHideIncrementally.length > 0) {
            Logger.info(`增量隐藏消息: 索引 [${toHideIncrementally.join(', ')}]`);
            Logger.debug('更新聊天数组数据...');
            toHideIncrementally.forEach(idx => { if (chat[idx]) chat[idx].is_system = true; });
            Logger.debug('聊天数组数据已更新');

            try {
                Logger.debug('更新 DOM 元素...');
                const hideSelector = toHideIncrementally.map(id => `.mes[mesid="${id}"]`).join(',');
                if (hideSelector) {
                    Logger.debug(`应用选择器: ${hideSelector}`);
                    $(hideSelector).attr('is_system', 'true');
                    Logger.debug('DOM 更新命令已发出');
                } else {
                    Logger.debug('没有 DOM 元素需要更新');
                }
            } catch (error) {
                Logger.error('增量更新 DOM 时发生错误:', error);
            }

            Logger.info('增量隐藏后保存设置');
            saveCurrentHideSettings(hideLastN);

        } else {
             Logger.debug(`范围 [${startIndex}, ${endIndex}) 内无需隐藏消息`);
             if (settings.lastProcessedLength !== currentChatLength && settings.userConfigured) {
                 Logger.info('长度变化但无需隐藏消息，保存设置');
                 saveCurrentHideSettings(hideLastN);
             } else {
                  Logger.debug('长度未变化或未配置用户，跳过保存');
             }
        }
    } else {
        Logger.debug('可见起点未前进或范围无效');
         if (settings.lastProcessedLength !== currentChatLength && settings.userConfigured) {
             Logger.info('长度变化但可见起点未前进，保存设置');
             saveCurrentHideSettings(hideLastN);
         } else {
              Logger.debug('长度未变化或未配置用户，跳过保存');
         }
    }

    Logger.debug(`增量检查完成，耗时 ${performance.now() - startTime}ms`);
}

// 全量隐藏检查
async function runFullHideCheck() {
    Logger.debug('开始全量隐藏检查');
    if (!shouldProcessHiding()) {
        Logger.debug('shouldProcessHiding 返回 false，跳过');
        return;
    }

    const startTime = performance.now();
    const context = getContextOptimized();
    if (!context || !context.chat) {
        Logger.debug('上下文或聊天数据不可用，中止');
        return;
    }
    const chat = context.chat;
    const currentChatLength = chat.length;
    Logger.debug(`上下文正常，聊天长度: ${currentChatLength}`);

    const settings = getCurrentHideSettings() || { hideLastN: 0, lastProcessedLength: 0, userConfigured: false };
    const { hideLastN } = settings;
    Logger.debug(`加载当前实体的设置: hideLastN=${hideLastN}, userConfigured=${settings.userConfigured}`);

    const visibleStart = hideLastN <= 0
        ? 0
        : (hideLastN >= currentChatLength
            ? 0
            : Math.max(0, currentChatLength - hideLastN));
    Logger.debug(`计算可见起点索引: ${visibleStart}`);

    const toHide = [];
    const toShow = [];
    let changed = false;
    Logger.debug('开始差异计算...');
    for (let i = 0; i < currentChatLength; i++) {
        const msg = chat[i];
        if (!msg) {
            Logger.debug(`跳过空消息槽 ${i}`);
            continue;
        }
        const isCurrentlyHidden = msg.is_system === true;
        const shouldBeHidden = i < visibleStart;

        if (shouldBeHidden && !isCurrentlyHidden) {
            Logger.debug(`索引 ${i} 应隐藏但未隐藏，标记为隐藏`);
            msg.is_system = true;
            toHide.push(i);
            changed = true;
        } else if (!shouldBeHidden && isCurrentlyHidden) {
            Logger.debug(`索引 ${i} 应显示但已隐藏，标记为显示`);
            msg.is_system = false;
            toShow.push(i);
            changed = true;
        }
    }
    Logger.debug(`差异计算完成。需要更改: ${changed}。隐藏: ${toHide.length}, 显示: ${toShow.length}`);

    if (changed) {
        try {
            Logger.debug('应用 DOM 更新...');
            if (toHide.length > 0) {
                const hideSelector = toHide.map(id => `.mes[mesid="${id}"]`).join(',');
                if (hideSelector) {
                    Logger.debug(`隐藏 DOM 元素: ${hideSelector}`);
                    $(hideSelector).attr('is_system', 'true');
                }
            }
            if (toShow.length > 0) {
                const showSelector = toShow.map(id => `.mes[mesid="${id}"]`).join(',');
                if (showSelector) {
                    Logger.debug(`显示 DOM 元素: ${showSelector}`);
                    $(showSelector).attr('is_system', 'false');
                }
            }
             Logger.debug('DOM 更新已应用');
        } catch (error) {
            Logger.error('全量检查时更新 DOM 发生异常:', error);
        }
    } else {
         Logger.debug('无需更改聊天数据或 DOM');
    }

    Logger.debug(`检查是否需要保存设置: lastProcessedLength=${settings.lastProcessedLength}, currentChatLength=${currentChatLength}, userConfigured=${settings.userConfigured}`);
    if (settings.userConfigured && settings.lastProcessedLength !== currentChatLength) {
        Logger.info(`长度变化 (${settings.lastProcessedLength} -> ${currentChatLength})，保存设置`);
        saveCurrentHideSettings(hideLastN);
    } else {
         Logger.debug('无需保存设置（长度未变化或未配置用户）');
    }
    Logger.info(`全量检查完成，耗时 ${performance.now() - startTime}ms`);
}

// 全部取消隐藏功能
async function unhideAllMessages(isFromInputZero = false) {
    const startTime = performance.now();
    Logger.debug('开始取消所有隐藏');
    const context = getContextOptimized();

    if (context?.chat) {
        const chat = context.chat;
        chat.forEach(msg => { if (msg.is_system) msg.is_system = false; });
        $('.mes[is_system="true"]').attr('is_system', 'false');
        Logger.debug('已取消所有消息的系统标记');
    }

    // 将设置设为空/禁用状态
    saveCurrentHideSettings(null);

    if (isFromInputZero) {
        toastr.success('隐藏值已设置为0，立即取消当前所有隐藏楼层');
    } else {
        toastr.success('已立即取消当前所有楼层隐藏');
    }

    updateCurrentHideSettingsDisplay();
    Logger.info(`取消隐藏完成，耗时 ${performance.now() - startTime}ms`);
}

// ==================== 聊天统计 (Token Stats) 功能 ====================

// 更新 Token 统计 UI
function updateTokenStatsUI() {
    Logger.debug("【UI渲染触发】进入 updateTokenStatsUI，尝试重新计算各类 Tokens");
    if (!promptManager) {
        Logger.warn("【诊断失败】promptManager 为空");
        return;
    }
    if (!promptManager.messages) {
        Logger.warn("【诊断失败】promptManager.messages 为空");
        return;
    }
    const pm = promptManager;

    // 1. 计算各项 Token 数值
    const totalTokens = pm.tokenUsage || 0;
    let chatTokens = 0;
    Logger.debug(`【诊断数据】提取到的当前总 Token (pm.tokenUsage) = ${totalTokens}`);

    const findCollectionById = (c, id) => {
        if (c.identifier === id) return c;
        if (c.collection) {
            for (const i of c.collection) {
                if (i instanceof Object && i.collection) {
                    const f = findCollectionById(i, id);
                    if (f) return f;
                }
            }
        }
        return null;
    };

    Logger.debug("【诊断流程】开始在 PromptManager 结构中寻找 identifier 为 'chatHistory' 的节点");
    const chatHistory = findCollectionById(pm.messages, 'chatHistory');

    if (chatHistory) {
        const chatColl = chatHistory.getCollection();
        Logger.debug(`【诊断成功】找到了 chatHistory，内部包含了 ${chatColl.length} 条数据`);
        chatColl.forEach(msg => {
            if (msg.role === 'user' || msg.role === 'assistant') chatTokens += msg.getTokens();
        });
        Logger.debug(`【诊断数据】成功计算出聊天 Tokens 累加值 = ${chatTokens}`);
    } else {
        // 最核心的 Bug 诊断点
        Logger.error("【重大诊断警告】找不到 'chatHistory' 节点！酒馆 Prompt 构建器结构已发生改变。");
        try {
            let availableIdentifiers = [];
            if (pm.messages && pm.messages.collection) {
                availableIdentifiers = pm.messages.collection.map(c => c.identifier || '未命名节点');
            }
            Logger.error(`【结构转储】当前可用的顶层 identifiers 有: ${availableIdentifiers.join(', ')}`);
        } catch(e) {
            Logger.error("【结构转储】读取结构时发生意外错误: ", e);
        }
    }

    const wiTokens = calculatedWiTokens;
    let otherTokens = totalTokens - chatTokens - wiTokens;
    if (otherTokens < 0) otherTokens = 0;

    // 2. 无论面板是否可见，都在后台更新 DOM 内容
    renderTokenStatsContent(totalTokens, chatTokens, wiTokens, otherTokens);
}

// 渲染 Token 统计内容
function renderTokenStatsContent(totalTokens, chatTokens, wiTokens, otherTokens, statsObj = wiDetailedStats) {
    if (!totalTokens && totalTokens !== 0) return;

    const getPct = (v) => totalTokens > 0 ? ((v / totalTokens) * 100).toFixed(1) : 0;

    // 渲染概览行
    document.getElementById('tub-row-overview').innerHTML = `
        <div class="tub-stat-box"><span class="tub-stat-label">总共</span><span class="tub-stat-value">${totalTokens}</span></div>
        <div class="tub-stat-box"><span class="tub-stat-label">聊天</span><span class="tub-stat-value">${chatTokens}<br><small>${getPct(chatTokens)}%</small></span></div>
        <div class="tub-stat-box"><span class="tub-stat-label">世界书</span><span class="tub-stat-value">${wiTokens}<br><small>${getPct(wiTokens)}%</small></span></div>
        <div class="tub-stat-box"><span class="tub-stat-label">其他</span><span class="tub-stat-value">${otherTokens}<br><small>${getPct(otherTokens)}%</small></span></div>
    `;

    // 计算常量、动态和EJS世界书 tokens
    let totalC = 0, totalD = 0, totalE = 0;
    for (const b in statsObj) {
        if (statsObj[b].constant) statsObj[b].constant.forEach(e => totalC += e.tokens);
        if (statsObj[b].dynamic) statsObj[b].dynamic.forEach(e => totalD += e.tokens);
        if (statsObj[b].ejs) statsObj[b].ejs.forEach(e => totalE += e.tokens);
    }
    renderPieView(totalC, totalD, totalE, totalC + totalD + totalE);

    // 渲染条目列表
    const books = Object.keys(statsObj);
    let filtersHtml = '';
    if (books.length > 1) {
        filtersHtml = `
            <div class="tub-book-filters">
                <button class="tub-book-btn active" data-book="all">所有条目</button>
                ${books.map(b => `<button class="tub-book-btn" data-book="${b}">${b}</button>`).join('')}
            </div>
        `;
    }

    const sectionHtml = `
        <div id="tub-entries-header-sticky" class="tub-entries-header-sticky">
            <div class="tub-flex-row-between">
                <div class="tub-flex-row-center">
                    <div class="tub-section-title tub-title-text tub-section-title-no-margin">已激活条目</div>
                    <div class="tub-search-wrapper">
                        <svg class="tub-search-icon" id="tub-search-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                        </svg>
                        <input type="text" id="tub-search-input" class="tub-search-input" placeholder="搜索条目...">
                    </div>
                </div>
                <div id="tub-entries-total-display" class="tub-entries-total-display"></div>
            </div>
            ${filtersHtml}
        </div>
        <div class="tub-row-3 tub-scrollable" id="tub-row-entries"></div>
    `;
    document.getElementById('tub-entries-section').innerHTML = sectionHtml;

    // 状态保存，用于交叉过滤
    let currentBookFilter = 'all';
    let currentSearchTerm = '';

    const renderEntriesList = () => {
        const entriesContainer = document.getElementById('tub-row-entries');
        const totalDisplay = document.getElementById('tub-entries-total-display');
        entriesContainer.innerHTML = '';

        let combined = [];
        let filterTotalC = 0;
        let filterTotalD = 0;
        let filterTotalE = 0;

        for (const b in statsObj) {
            if (currentBookFilter !== 'all' && b !== currentBookFilter) continue;

            // 过滤并压入 ejs
            if (statsObj[b].ejs) {
                statsObj[b].ejs.forEach(e => {
                    if (currentSearchTerm && !e.name.toLowerCase().includes(currentSearchTerm)) return;
                    combined.push({ ...e, b, type: 'ejs' });
                    filterTotalE += e.tokens;
                });
            }
            // 过滤并压入 dynamic
            if (statsObj[b].dynamic) {
                statsObj[b].dynamic.forEach(e => {
                    if (currentSearchTerm && !e.name.toLowerCase().includes(currentSearchTerm)) return;
                    combined.push({ ...e, b, type: 'dynamic' });
                    filterTotalD += e.tokens;
                });
            }
            // 过滤并压入 constant
            if (statsObj[b].constant) {
                statsObj[b].constant.forEach(e => {
                    if (currentSearchTerm && !e.name.toLowerCase().includes(currentSearchTerm)) return;
                    combined.push({ ...e, b, type: 'constant' });
                    filterTotalC += e.tokens;
                });
            }
        }

        const filterTotal = filterTotalC + filterTotalD + filterTotalE;
        // 构建顶部总数显示，如果有 EJS 则显示红色部分
        let totalHtml = `${filterTotal} (`;
        if (filterTotalE > 0) totalHtml += `<span class="tub-stat-color-ejs">${filterTotalE}</span> + `;
        totalHtml += `<span class="tub-stat-color-dynamic">${filterTotalD}</span> + <span class="tub-stat-color-constant">${filterTotalC}</span>)`;
        totalDisplay.innerHTML = totalHtml;

        combined.sort((a, b) => {
            const order = { 'ejs': 1, 'dynamic': 2, 'constant': 3 };
            if (a.type !== b.type) return order[a.type] - order[b.type];
            return b.tokens - a.tokens;
        });

        if (!combined.length) {
            entriesContainer.innerHTML = '<div class="tub-empty-state">没有激活的条目</div>';
            return;
        }

        const absoluteMax = Math.max(...combined.map(e => e.tokens));

        combined.forEach(e => {
            const pct = absoluteMax > 0 ? ((e.tokens / absoluteMax) * 100).toFixed(1) : 0;
            const bookTag = (currentBookFilter === 'all' && books.length > 1) ? ` <span class="tub-book-tag">(${e.b})</span>` : '';

            let gradientBg = '';
            if (e.type === 'ejs') {
                gradientBg = `background: linear-gradient(to right, var(--hh-stats-bg-ejs) ${pct}%, transparent ${pct}%);`;
            } else if (e.type === 'constant') {
                gradientBg = `background: linear-gradient(to right, var(--hh-stats-bg-constant) ${pct}%, transparent ${pct}%);`;
            } else {
                gradientBg = `background: linear-gradient(to right, var(--hh-stats-bg-dynamic) ${pct}%, transparent ${pct}%);`;
            }

            entriesContainer.insertAdjacentHTML('beforeend', `
                <div class="tub-new-list-item" style="${gradientBg}">
                    <div class="tub-nli-label" title="${e.name}">${e.name}${bookTag}</div>
                    <div class="tub-nli-value">${e.tokens}</div>
                </div>`);
        });

        // 滚动条逻辑已移除
    };

    renderEntriesList();

    // 绑定书籍按钮事件
    if (books.length > 1) {
        const btns = document.querySelectorAll('.tub-book-btn');
        btns.forEach(btn => {
            btn.onclick = () => {
                btns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                currentBookFilter = btn.getAttribute('data-book');
                renderEntriesList();
            };
        });
    }

    // 绑定搜索框事件
    const searchIcon = document.getElementById('tub-search-icon');
    const searchInput = document.getElementById('tub-search-input');

    searchIcon.onclick = () => {
        searchInput.classList.toggle('active');
        if (searchInput.classList.contains('active')) {
            searchInput.focus();
        } else {
            searchInput.value = '';
            currentSearchTerm = '';
            renderEntriesList();
        }
    };

    searchInput.addEventListener('input', debounce((e) => {
        currentSearchTerm = e.target.value.toLowerCase();
        renderEntriesList();
    }, 300));
}

// 渲染饼图 (增加 EJS 红色切片)
function renderPieView(c, d, e, total) {
    const container = document.getElementById('tub-row-wi-chart');
    if (!total) { container.innerHTML = '<div class="tub-empty-state">没有激活的世界书</div>'; return; }

    const cPct = (c / total) * 100;
    const dPct = (d / total) * 100;
    const ePct = (e / total) * 100;

    const cAngle = (cPct / 2) * 3.6;
    const cRad = (cAngle - 90) * (Math.PI / 180);
    const cX = 50 + 30 * Math.cos(cRad);
    const cY = 50 + 30 * Math.sin(cRad);

    const dAngle = (cPct + dPct / 2) * 3.6;
    const dRad = (dAngle - 90) * (Math.PI / 180);
    const dX = 50 + 30 * Math.cos(dRad);
    const dY = 50 + 30 * Math.sin(dRad);

    // 计算 EJS 切片文字位置
    const eAngle = (cPct + dPct + ePct / 2) * 3.6;
    const eRad = (eAngle - 90) * (Math.PI / 180);
    const eX = 50 + 30 * Math.cos(eRad);
    const eY = 50 + 30 * Math.sin(eRad);

    container.innerHTML = `
        <div class="tub-pie-chart" style="background: conic-gradient(#3b82f6 0% ${cPct}%, #22c55e ${cPct}% ${cPct + dPct}%, #ef4444 ${cPct + dPct}% 100%);">
            ${cPct >= 5 ? `<span class="tub-pie-text" style="left: ${cX}px; top: ${cY}px;">${cPct.toFixed(0)}%</span>` : ''}
            ${dPct >= 5 ? `<span class="tub-pie-text" style="left: ${dX}px; top: ${dY}px;">${dPct.toFixed(0)}%</span>` : ''}
            ${ePct >= 5 ? `<span class="tub-pie-text" style="left: ${eX}px; top: ${eY}px;">${ePct.toFixed(0)}%</span>` : ''}
        </div>
        <div class="tub-legend">
            ${e > 0 ? `<div class="tub-legend-item"><span class="tub-dot tub-dot-red"></span>EJS: ${e}</div>` : ''}
            <div class="tub-legend-item"><span class="tub-dot tub-dot-green"></span>绿灯: ${d}</div>
            <div class="tub-legend-item"><span class="tub-dot tub-dot-blue"></span>蓝灯: ${c}</div>
        </div>
    `;
}

// 滚动条自动隐藏/显示逻辑 (已移除)
function initScrollbarLogic() {
}

// ==================== 聊天统计功能结束 ====================

// --- 更新日志弹窗 ---
function createChangelogModalHtml(changelogText) {
    return `
    <div class="hide-modal-box" id="hide-helper-modal-update">
        <div class="hide-modal-header">插件更新日志</div>
        <div class="hide-changelog-viewer" id="hide-helper-changelog-content">${changelogText}</div>
        <div class="hide-update-tip">如果更新失败，可以在酒馆扩展页面的【管理扩展程序】列表中手动更新隐藏助手。如果依然更新失败，则可以尝试删除重装来使用最新版本插件。</div>
        <div class="hide-modal-footer">
            <button id="hide-helper-btn-confirm-update" class="menu_button primary">立即更新</button>
            <button class="menu_button" onclick="document.getElementById('hide-helper-modal-overlay').classList.remove('visible')">取消</button>
        </div>
    </div>`;
}

async function showUpdateModal() {
    const overlay = document.getElementById('hide-helper-modal-overlay');
    if (!overlay) return;

    // 先显示 Loading
    overlay.innerHTML = `<div class="hide-modal-box" style="text-align:center; padding:30px;">Loading changelog...</div>`;
    overlay.classList.add('visible');

    const changelog = await getChangelog();

    // 简单的 Markdown 转义处理
    const safeLog = changelog.replace(/</g, "&lt;").replace(/>/g, "&gt;");

    overlay.innerHTML = createChangelogModalHtml(safeLog);

    const btnUpdate = document.getElementById('hide-helper-btn-confirm-update');
    if (btnUpdate) {
        btnUpdate.onclick = async () => {
            if (confirm('更新操作将刷新页面，请确保已保存对话。\n确定更新吗？')) {
                btnUpdate.disabled = true;
                btnUpdate.textContent = "更新中...";
                try {
                    const res = await performUpdate();
                    if (res.ok) {
                        alert('更新指令已发送，页面即将刷新。');
                        setTimeout(() => location.reload(), 2000);
                    } else {
                        alert('更新失败，请查看控制台日志。');
                        btnUpdate.disabled = false;
                    }
                } catch (e) {
                    alert('更新请求发生错误: ' + e);
                    btnUpdate.disabled = false;
                }
            }
        };
    }
}

/**
 * 更新版本显示
 */
function updateVersionDisplay(updateInfo) {
    if (!updateInfo) return;

    const currentVersionEl = $('#hide-helper-current-version');
    const newBadgeEl = $('#hide-helper-new-badge');
    const checkBtn = $('#hide-helper-check-update-btn');

    if (currentVersionEl.length) {
        currentVersionEl.text(updateInfo.localVersion || 'Unknown');
    }

    if (newBadgeEl.length) {
        if (updateInfo.hasUpdate) {
            newBadgeEl.show();
            if (checkBtn.length) {
                checkBtn.addClass('has-update');
                checkBtn.text('发现新版本');
                checkBtn.attr('title', `最新版本: ${updateInfo.latestVersion}`);
            }
        } else {
            newBadgeEl.hide();
            if (checkBtn.length) {
                checkBtn.removeClass('has-update');
                checkBtn.text('检查更新');
                checkBtn.removeAttr('title');
            }
        }
    }
}

// 日志UI自动关闭计时器 (60分钟熔断)
let logUiAutoDisableTimer = null;

// 环境信息抓取工具函数 (XPath)
function logEnvironmentDetails() {
    if (Logger.currentLevel !== 3) return; // 仅在级别3收集
    const getXPathText = (xpath) => {
        try {
            const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            return result.singleNodeValue ? result.singleNodeValue.textContent.trim() : "未找到";
        } catch (e) { return "获取错误"; }
    };
    const stVersion = getXPathText('//*[@id="version_display"]');
    const thVersion = getXPathText('//*[@id="tavern_helper"]/div/div[2]/div/div[1]/span');

    Logger.debug(`【调试诊断】SillyTavern 版本: ${stVersion}`);
    Logger.debug(`【调试诊断】Tavern Helper 版本: ${thVersion}`);
    Logger.debug(`【调试诊断】Hide Helper 内部设置:`, extension_settings[extensionName]);
}

// 设置UI元素的事件监听器
function setupEventListeners() {
    Logger.debug('设置事件监听器');

    // --- 聊天统计 (Token Stats) 事件监听 ---

    // 挂载 ST-PT 拦截器
    setupSTPTInterceptor();

    // 世界书扫描完成事件
    eventSource.on(event_types.WORLDINFO_SCAN_DONE, async (data) => {
        Logger.debug("【诊断事件】收到 WORLDINFO_SCAN_DONE 世界书信号");
        if (!data) {
            Logger.warn("【诊断警告】世界书扫描事件的 data 为空");
            return;
        }
        if (!data.activated || !data.activated.entries) {
            Logger.warn("【诊断警告】未能从 data 中找到 activated.entries 结构", data);
            return;
        }

        calculatedWiTokens = 0;
        wiDetailedStats = {};
        const entries = Array.from(data.activated.entries.values());
        Logger.debug(`【诊断数据】成功提取到被激活的世界书条目数: ${entries.length}`);

        await Promise.all(entries.map(async (entry) => {
            const tokens = await getTokenCountAsync(entry.content);
            const bookName = entry.world || "Embedded/Other";
            let entryName = entry.comment || (entry.key && entry.key[0] ? `[Key: ${entry.key[0]}]` : `[UID: ${entry.uid}]`);
            const type = entry.constant ? "constant" : "dynamic";

            if (!wiDetailedStats[bookName]) {
                wiDetailedStats[bookName] = { constant: [], dynamic: [], ejs: [], total: 0 };
            }
            wiDetailedStats[bookName][type].push({ name: entryName, tokens: tokens });
            wiDetailedStats[bookName].total += tokens;
            calculatedWiTokens += tokens;
        }));
    });

    // 世界书更新事件
    if (event_types.WORLDINFO_UPDATED) {
        eventSource.on(event_types.WORLDINFO_UPDATED, () => {
            updateTokenStatsUI();
        });
    }

    // 在外部声明一个合并状态锁，防止单次回合被重复合并
    let stptMergedThisTurn = false;

    // 每次生成开始时重置锁
    eventSource.on(event_types.GENERATION_STARTED, () => {
        stptMergedThisTurn = false;
    });

    // 监听生成就绪事件，进行数据缝合
    eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, (completion) => {
        // 🌟【核心机制】：如果是我们自己触发的假发送，立刻终止请求，不让它发给AI！
        if (isFakeGenerating) {
            stopGeneration();
            isFakeGenerating = false;
            Logger.debug('模拟生成已拦截，成功获取最新数据');
        }

        if (!completion || !completion.messages) return;

        setTimeout(async () => {
            try {
                if (stptMergedThisTurn) return; // 防重复执行
                stptMergedThisTurn = true;

                // 去重
                const processedSTPT = new Map();
                for (const entry of stptInterceptedEntries) {
                    const key = `${entry.world}::${entry.comment}`;
                    if (!processedSTPT.has(key)) processedSTPT.set(key, entry);
                }

                if (processedSTPT.size > 0) {
                    console.log(`[隐藏助手] 准备缝合 ST-PT 动态加载条目:`, Array.from(processedSTPT.keys()));
                }

                let addedTokens = 0;

                // 🌟【核心修复】：直接将 ST-PT 数据永久合并到酒馆原生的全局变量中
                for (const stat of processedSTPT.values()) {
                    const textToMeasure = stat.rawText || '';
                    if (textToMeasure.trim() === '') continue;

                    const tk = await getTokenCountAsync(textToMeasure);
                    addedTokens += tk;

                    let finalBookName = stat.world || '未指定世界书';
                    let finalEntryName = stat.comment || '未知条目';

                    // 写入原生全局对象 wiDetailedStats
                    if (!wiDetailedStats[finalBookName]) {
                        wiDetailedStats[finalBookName] = { constant: [], dynamic: [], ejs: [], total: 0 };
                    }
                    if (!wiDetailedStats[finalBookName].ejs) {
                        wiDetailedStats[finalBookName].ejs = [];
                    }
                    wiDetailedStats[finalBookName].ejs.push({
                        name: finalEntryName,
                        tokens: tk
                    });
                    wiDetailedStats[finalBookName].total += tk;
                }

                // 🌟 累加到原生全局 Token 变量
                calculatedWiTokens += addedTokens;

                // 🌟 强行触发 UI 刷新！因为全局变量已经修改，面板渲染将完美兼容 ST-PT 数据
                updateTokenStatsUI();

            } catch (err) {
                console.error("[隐藏助手] 缝合 ST-PT 数据时出现异常:", err);
            }
        }, 800);
    });

    // --- 聊天统计事件监听结束 ---

    // --- 弹窗和标签页交互 ---

    // 记录弹窗打开会话期间是否已刷新过统计数据
    let hasStatsRefreshedThisSession = false;

    $('#hide-helper-wand-button').on('click', function() {
        Logger.debug('魔杖按钮被点击');
        if (!extension_settings[extensionName]?.enabled) {
            Logger.debug('插件已禁用');
            toastr.warning('隐藏助手当前已禁用，请打开酒馆顶部菜单栏的扩展程序页面将插件状态设置为开启。');
            return;
        }
        Logger.debug('插件已启用，更新显示后显示弹窗');
        updateCurrentHideSettingsDisplay();

        // 首次打开时显示红色括号说明提示
        const titleEl = $('#hide-panel-instructions-title');
        if (!extension_settings[extensionName].hide_instructions_viewed) {
            titleEl.html('使用说明<span class="title-warning-text">（向下滑查看完整内容）</span>');
            extension_settings[extensionName].hide_instructions_viewed = true;
            saveSettingsDebounced();
        } else {
            titleEl.text('使用说明');
        }

        // 恢复上一次切换的标签页
        const lastActiveTab = extension_settings[extensionName].last_active_tab || 'hide-panel';
        $('.tab-button').removeClass('active');
        $(`.tab-button[data-tab="${lastActiveTab}"]`).addClass('active');
        $('.tab-panel').removeClass('active');
        $(`.tab-panel[data-tab="${lastActiveTab}"]`).addClass('active');

        // 重置弹窗会话期间的统计刷新状态
        hasStatsRefreshedThisSession = false;

        // ---- 【打开弹窗立刻执行统计】 ----
        updateTokenStatsUI();
        if (lastActiveTab === 'token-stats-panel') {
            forceRefreshTokenStats(); // 如果用户一打开就是统计页，直接触发刷新
            hasStatsRefreshedThisSession = true; // 标记本会话已刷新过
        }

        const $popup = $('#hide-helper-popup');
        const $backdrop = $('#hide-helper-backdrop');
        $backdrop.show();
        $popup.show();
        centerPopup($popup);
        $(window).off('resize.hideHelperMain').on('resize.hideHelperMain', () => centerPopup($popup));

        // 恢复日志UI开关状态
        const logUiVisible = extension_settings[extensionName].logUiVisible || false;
        $('#hide-helper-log-ui-toggle').prop('checked', logUiVisible);
        if (logUiVisible) {
            $('.log-level-selector-wrapper').slideDown(0);
            if (extension_settings[extensionName].logLevel === 3) {
                $('#hide-helper-download-log').show();
            } else {
                $('#hide-helper-download-log').hide();
            }
        } else {
            $('.log-level-selector-wrapper').slideUp(0);
            $('#hide-helper-download-log').hide();
        }

        // 显示主题提示弹窗（如果是首次打开）
        if (!extension_settings[extensionName].theme_notification_viewed) {
            showThemeNotification();
        }
    });

    $('#hide-helper-popup-close-icon').on('click', function() {
        Logger.debug('弹窗关闭图标被点击');
        $('#hide-helper-popup').hide();
        $('#hide-helper-backdrop').hide();
        $(window).off('resize.hideHelperMain');
    });

    // 点击遮罩层关闭弹窗
    $('#hide-helper-backdrop').on('click', function() {
        Logger.debug('遮罩层被点击，关闭弹窗');
        $('#hide-helper-popup').hide();
        $('#hide-helper-backdrop').hide();
        $(window).off('resize.hideHelperMain');
    });

    // 新增: ESC键快速关闭弹窗
    $(document).off('keydown.hideHelperEsc').on('keydown.hideHelperEsc', function(e) {
        if (e.key === 'Escape' && $('#hide-helper-popup').is(':visible')) {
            Logger.debug('ESC 键被按下，关闭弹窗');
            $('#hide-helper-popup').hide();
            $('#hide-helper-backdrop').hide();
            $(window).off('resize.hideHelperMain');
        }
    });

    // --- 主题切换事件 ---
    $(document).on('click', '#hide-helper-theme-toggle', function() {
        const currentTheme = extension_settings[extensionName].theme || 'light';
        const newTheme = currentTheme === 'light' ? 'dark' : 'light';
        extension_settings[extensionName].theme = newTheme;
        applyTheme(newTheme);
        saveSettingsDebounced();

        // 实时重新渲染聊天统计，以更新行内的渐变色
        if ($('.tab-panel[data-tab="token-stats-panel"]').hasClass('active')) {
            updateTokenStatsUI();
        }
    });

    // --- 日志级别切换事件 ---
    $(document).on('change', '#hide-helper-log-level-select', function() {
        const newLevel = parseInt($(this).val());
        extension_settings[extensionName].logLevel = newLevel;
        applyLogLevel(newLevel);
        saveSettingsDebounced();

        const $downloadBtn = $('#hide-helper-download-log');
        if (newLevel === 3) {
            $downloadBtn.fadeIn(200);
            logEnvironmentDetails(); // 切换到3时立马收集一次环境
        } else {
            $downloadBtn.fadeOut(200);
            Logger.logHistory = []; // 非3级别，立刻清空内存垃圾
        }

        if (newLevel > 0) {
            console.log(`%c[隐藏助手]`, 'font-weight: bold; color: #28a745;', `日志级别已更改为: ${['零日志', '核心日志', '运行日志', '完整日志'][newLevel]}`);
        }
    });

    // --- 主题提示弹窗事件 ---

    // 立即切换主题按钮
    $(document).on('click', '#hide-helper-switch-theme-now', function() {
        const newTheme = 'dark';
        extension_settings[extensionName].theme = newTheme;
        applyTheme(newTheme);
        extension_settings[extensionName].theme_notification_viewed = true;
        saveSettingsDebounced();
        closeThemeNotification();

        // 实时重新渲染聊天统计
        if ($('.tab-panel[data-tab="token-stats-panel"]').hasClass('active')) {
            updateTokenStatsUI();
        }
    });

    // 我已知晓按钮
    $(document).on('click', '#hide-helper-notification-close', function() {
        extension_settings[extensionName].theme_notification_viewed = true;
        saveSettingsDebounced();
        closeThemeNotification();
    });

    // --- 日志UI显示开关事件 (带60分钟倒计时) ---
    $(document).on('change', '#hide-helper-log-ui-toggle', function() {
        const isVisible = $(this).is(':checked');
        extension_settings[extensionName].logUiVisible = isVisible;
        saveSettingsDebounced();

        const $logLevelWrapper = $('.log-level-selector-wrapper');
        const $downloadBtn = $('#hide-helper-download-log');

        if (isVisible) {
            $logLevelWrapper.slideDown(200);
            if (extension_settings[extensionName].logLevel === 3) {
                $downloadBtn.fadeIn(200);
                logEnvironmentDetails();
            }

            // 启动 60 分钟自动关闭熔断器
            clearTimeout(logUiAutoDisableTimer);
            logUiAutoDisableTimer = setTimeout(() => {
                const $toggle = $('#hide-helper-log-ui-toggle');
                if ($toggle.is(':checked')) {
                    toastr.info('为保障性能，显示日志功能已达60分钟上限，已自动关闭并重置日志级别。');
                    $toggle.prop('checked', false).trigger('change');
                }
            }, 60 * 60 * 1000); // 60分钟

        } else {
            // UI 关闭时，连带清理所有设置，防止后台吃性能
            $logLevelWrapper.slideUp(200);
            $downloadBtn.fadeOut(200);
            clearTimeout(logUiAutoDisableTimer);

            // 强制重置日志级别为 0 并清空内存
            extension_settings[extensionName].logLevel = 0;
            applyLogLevel(0);
            saveSettingsDebounced();
            Logger.logHistory = [];
        }
    });

    // --- 日志下载按钮点击事件 ---
    $(document).on('click', '#hide-helper-download-log', function() {
        logEnvironmentDetails(); // 下载前强制再记录一次环境信息
        if (Logger.exportLogs()) {
            toastr.success('日志导出成功！');
        } else {
            toastr.warning('当前没有可导出的日志内容。');
        }
    });

    // --- 更新检测按钮事件 ---
    $(document).on('click', '#hide-helper-check-update-btn', async function(e) {
        e.stopPropagation();
        const btn = $(this);

        // 如果已经是红色状态(有更新)，点击则弹出更新日志并确认
        if (btn.hasClass('has-update')) {
            showUpdateModal();
        } else {
            const originalText = btn.text();

            // 禁用按钮，防止重复点击
            btn.prop('disabled', true);
            btn.text('检测中...');

            try {
                // 强制检查更新
                const updateInfo = await checkForUpdates(true);
                updateVersionDisplay(updateInfo);

                if (updateInfo.hasUpdate) {
                    toastr.success(`发现新版本: ${updateInfo.latestVersion}`);
                } else {
                    // 增加错误兜底判断，网络不通时不再骗你是最新版
                    if (updateInfo.latestVersion === "Check Failed") {
                        toastr.error('检测失败，无法连接到 GitHub 仓库');
                        btn.text('检测失败');
                    } else {
                        toastr.info('当前已是最新版本');
                        btn.text('已是最新');
                    }
                    setTimeout(() => {
                        btn.text('检查更新');
                    }, 2000);
                }
            } catch (err) {
                Logger.error('检测更新失败:', err);
                toastr.error('检测更新失败，请稍后重试');
                btn.text(originalText);
            } finally {
                btn.prop('disabled', false);
            }
        }
    });

    // 新增: 标签页切换逻辑
    $(document).on('click', '.tab-button', function() {
        const targetTab = $(this).data('tab');
        $('.tab-button').removeClass('active');
        $(this).addClass('active');
        $('.tab-panel').removeClass('active');
        $(`.tab-panel[data-tab="${targetTab}"]`).addClass('active');

        // 保存当前选择的标签页
        if (extension_settings[extensionName]) {
            extension_settings[extensionName].last_active_tab = targetTab;
            saveSettingsDebounced();
        }

        // 如果切换到聊天统计标签，更新UI
        if (targetTab === 'token-stats-panel') {
            updateTokenStatsUI(); // 先显示旧缓存数据防空白
            if (!hasStatsRefreshedThisSession) {
                forceRefreshTokenStats(); // 后台偷偷触发模拟生成，获取最新 EJS 数据
                hasStatsRefreshedThisSession = true; // 标记本会话已刷新过
            }
        }

        // 面板内容切换极可能导致高度发生变化，重新计算定位确保依然完美居中
        centerPopup($('#hide-helper-popup'));
    });

    // --- 全局插件开关 ---
    $('#hide-helper-toggle').on('change', function() {
        const isEnabled = $(this).val() === 'enabled';
        Logger.info(`全局开关状态变更: ${isEnabled ? '启用' : '禁用'}`);
        if (extension_settings[extensionName]) {
            extension_settings[extensionName].enabled = isEnabled;
            Logger.debug('保存全局设置');
            saveSettingsDebounced();
        }

        if (isEnabled) {
            Logger.debug('插件已启用，运行全量检查');
            toastr.success('隐藏助手已启用');
            runFullHideCheckDebounced();
        } else {
            Logger.debug('插件已禁用');
            toastr.warning('隐藏助手已禁用');
        }
    });

    // --- 面板1: Hide 设置 ---

    // 1. 新增：功能总开关切换
    $('#hide-auto-process-toggle').on('change', function() {
        extension_settings[extensionName].autoHideEnabled = $(this).is(':checked');
        saveSettingsDebounced();
        updateCurrentHideSettingsDisplay();
        if (extension_settings[extensionName].autoHideEnabled) {
            runFullHideCheckDebounced();
        }
    });

    $('#hide-mode-toggle').on('change', function() {
        const newMode = $(this).is(':checked');

        if (extension_settings[extensionName]) {
            if (!extension_settings[extensionName].globalHideSettings) {
                extension_settings[extensionName].globalHideSettings = { ...defaultSettings.globalHideSettings };
            }

            extension_settings[extensionName].useGlobalSettings = newMode;
            Logger.debug(`设置模式更改为 ${newMode ? '全局' : '角色'}`);
            saveSettingsDebounced();
            updateCurrentHideSettingsDisplay();
            runFullHideCheckDebounced();
            toastr.info(`已切换隐藏范围至${newMode ? '全局' : '角色'}模式`);
        }
    });

    // 2. 修改：输入框失去焦点时才保存，避免输入过程中频繁触发保存
    $('#hide-last-n').on('blur', function() {
        saveSettingsAutoDebounced();
    });

    // 回车键让输入框失去焦点，触发保存
    $('#hide-last-n').on('keydown', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            this.blur(); // 失去焦点会触发 blur 事件进而保存
        }
    });

    // 3. 修改：取消隐藏按钮
    $('#hide-unhide-all-btn').on('click', function() {
        unhideAllMessages(false);
    });

    // --- 面板2: Limiter 设置 ---

    // 加上 async 关键字，并接收事件对象 e 判断触发源
    async function onLimiterSettingsChange(e) {
        if (_limiterSyncing) return;
        _limiterSyncing = true;

        try {
            const settings = extension_settings[extensionName];
            const isEnabled = $('#limiter-enabled').is(':checked');

            // 1. 如果用户点击的是"功能开关"
            if (e.target.id === 'limiter-enabled') {
                settings.limiter_isEnabled = isEnabled;

                if (isEnabled) {
                    // 当再次启用时，优先抓取酒馆原生的当前值
                    // （因为在插件关闭期间，用户可能在原生界面修改过）
                    let currentNative = Number($('#chat_truncation').val());
                    if (isNaN(currentNative) || currentNative <= 0) {
                        currentNative = power_user.chat_truncation || 0;
                    }
                    if (currentNative > 0) {
                        settings.limiter_saved_count = currentNative;
                    }
                }

                // 立即更新 UI 显示
                updateCurrentHideSettingsDisplay();
            }

            // 获取最新确定的数值
            const count = parseInt($('#limiter-count').val(), 10) || 0;

            if (isEnabled && count > 0) {
                // 【核心同步】：将用户设定的值永久保存到插件的影子变量中
                settings.limiter_saved_count = count;

                // 同步到原生 chat_truncation
                power_user.chat_truncation = count;
                if ($('#chat_truncation').length) {
                    $('#chat_truncation').val(count);
                    $('#chat_truncation_counter').val(count);
                    $('#chat_truncation').trigger('change'); // 触发原生保存
                }
            }

            // 强制落盘保存到 settings.json
            await saveSettings();

            // 如果手动改了输入框的数值，重载当前聊天
            if (isEnabled && count > 0 && e.target.id === 'limiter-count') {
                const { reloadCurrentChat } = getContext();
                if (reloadCurrentChat) {
                    reloadCurrentChat();
                }
            }
        } finally {
            _limiterSyncing = false;
        }
    }
    $('#limiter-enabled, #limiter-count').on('change', onLimiterSettingsChange);

    // --- 【原生界面修改反向同步】: 原生 #chat_truncation 变更 → 插件影子变量 ---
    $('#chat_truncation').on('input', function() {
        if (_limiterSyncing) return;
        _limiterSyncing = true;

        try {
            const nativeValue = Number($(this).val()) || 0;
            const settings = extension_settings[extensionName];

            // 【静默守护】：无论插件是否开启，只要用户手动在原生界面修改了，就立刻更新影子变量备份
            if (nativeValue > 0) {
                settings.limiter_saved_count = nativeValue;
                // 仅保存插件数据，不需要全量刷新UI
                saveSettingsDebounced();
            }

            // 如果插件启用了且弹窗打开着，顺便把弹窗里的输入框数值也变一下，做到视觉统一
            if (settings.limiter_isEnabled && $('#hide-helper-popup').is(':visible')) {
                $('#limiter-count').val(nativeValue > 0 ? nativeValue : '');
            }
        } finally {
            _limiterSyncing = false;
        }
    });

    // --- 核心事件监听 (协同工作) ---

    eventSource.on(event_types.CHAT_CHANGED, (data) => {
        Logger.debug(`收到事件: ${event_types.CHAT_CHANGED}`);
        cachedContext = null; // 清理缓存

        updateCurrentHideSettingsDisplay(); // 更新所有UI

        if (extension_settings[extensionName]?.enabled) {
            runFullHideCheck(); // 立即执行，非防抖，确保数据最新
        }
    });

    const handleNewMessage = (eventType) => {
        Logger.debug(`收到事件: ${eventType}`);
        if (extension_settings[extensionName]?.enabled) {
            setTimeout(() => runIncrementalHideCheck(), 100);
        }
    };
    eventSource.on(event_types.MESSAGE_RECEIVED, () => handleNewMessage(event_types.MESSAGE_RECEIVED));
    eventSource.on(event_types.MESSAGE_SENT, () => handleNewMessage(event_types.MESSAGE_SENT));

    eventSource.on(event_types.MESSAGE_DELETED, () => {
        Logger.debug(`收到事件: ${event_types.MESSAGE_DELETED}`);
        if (extension_settings[extensionName]?.enabled) {
            runFullHideCheckDebounced();
        }
    });

    // 生成结束事件，确保最终一致性
    const streamEndEvent = event_types.GENERATION_ENDED;
    eventSource.on(streamEndEvent, () => {
        Logger.debug(`收到事件: ${streamEndEvent}`);
        // 运行一个完整的检查来纠正任何增量更新中可能出现的问题
        if (extension_settings[extensionName]?.enabled) {
            runFullHideCheckDebounced();
        }
    });

    // ============================================================
    // 防止操作弹窗时导致背后的 ST 扩展面板关闭
    // ============================================================
    const overlay = document.getElementById('hide-helper-modal-overlay');
    if (overlay) {
        const stopPropagation = (e) => { e.stopPropagation(); };
        overlay.addEventListener('mousedown', stopPropagation);
        overlay.addEventListener('touchstart', stopPropagation);
        overlay.addEventListener('click', stopPropagation);
        overlay.addEventListener('wheel', stopPropagation, { passive: true });
    }

    Logger.debug('事件监听器设置完成');
}

// 初始化扩展
jQuery(async () => {
    Logger.info('开始初始化扩展 (jQuery ready)...');

    // 标志位，确保初始化只执行一次
    let isInitialized = false;
    const initializeExtension = () => {
        if (isInitialized) {
            Logger.info('初始化已运行，跳过');
            return;
        }
        isInitialized = true;
        Logger.info('由 app_ready 事件触发，运行初始化任务');

        // --- 这里是原来 setTimeout 里面的代码 ---
        // 1. 加载设置并触发迁移检查
        loadSettings();

        // 🌟【核心修复】强制镇压手机端 ST 的偷偷重置行为
        const settings = extension_settings[extensionName];
        if (settings.limiter_isEnabled && settings.limiter_saved_count > 0) {
            // 如果底层当前值与我们保存的影子变量不一致（比如被手机端偷改成了20）
            if (power_user.chat_truncation !== settings.limiter_saved_count) {
                Logger.warn(`检测到底层加载数(${power_user.chat_truncation})被篡改，强制恢复为设定值: ${settings.limiter_saved_count}`);
                // 强行覆盖底层变量
                power_user.chat_truncation = settings.limiter_saved_count;
                // 强行覆盖 DOM
                if ($('#chat_truncation').length) {
                    $('#chat_truncation').val(settings.limiter_saved_count);
                    $('#chat_truncation_counter').val(settings.limiter_saved_count);
                }
                // 让酒馆重新保存 settings.json
                saveSettingsDebounced();
            }
        }

        // 2. 创建 UI (现在依赖于 loadSettings 完成初始化和迁移检查)
        createUI();

        // 2.5 初始化更新检测
        initUpdateCheck().then(updateInfo => {
            if (updateInfo) {
                updateVersionDisplay(updateInfo);
            }
        });

        // 3. 更新初始 UI 状态
        Logger.debug('初始设置: 设置全局开关显示');
        $('#hide-helper-toggle').val(extension_settings[extensionName]?.enabled ? 'enabled' : 'disabled');

        // 应用保存的主题
        applyTheme(settings.theme || 'light');

        // 应用保存的日志级别
        applyLogLevel(settings.logLevel || 0);

        Logger.debug('初始设置: 更新当前隐藏设置显示');
        updateCurrentHideSettingsDisplay();

        // 4. 初始加载时执行全量检查 (如果插件启用且当前实体有用户配置)
        if (extension_settings[extensionName]?.enabled) {
            Logger.debug('初始设置: 插件已启用，检查是否需要初始全量检查');
            const initialSettings = getCurrentHideSettings();
             Logger.debug('读取当前实体的初始设置:', initialSettings);
            if(initialSettings?.userConfigured === true) {
                Logger.info('找到用户配置设置，运行初始全量隐藏检查');
                runFullHideCheck(); // 直接运行，非防抖
            } else {
                Logger.debug('未找到用户配置设置，跳过初始全量检查');
            }
        } else {
             Logger.debug('插件已禁用，跳过初始全量检查');
        }
        Logger.info('初始设置任务完成');
        // --- setTimeout 里面的代码结束 ---
    };

    // 检查 app_ready 事件类型是否存在
    // 确保 eventSource 和 event_types 都已加载
    if (typeof eventSource !== 'undefined' && typeof event_types !== 'undefined' && event_types.APP_READY) {
        Logger.info(`等待 '${event_types.APP_READY}' 事件进行初始化...`);
        eventSource.on(event_types.APP_READY, initializeExtension);
    } else {
        // 回退: 如果没有 app_ready 事件，或者 eventSource/event_types 加载失败
        Logger.error('严重错误: APP_READY 事件未找到或 eventSource/event_types 未定义。回退到 2 秒延迟');
        const initialDelay = 2000;
        Logger.warn(`使用延迟 ${initialDelay}ms 计划初始设置任务 (回退方案)`);
        setTimeout(initializeExtension, initialDelay); // 使用相同的 initializeExtension 函数作为回退
    }
});

// 兜底拦截：在 API 请求前硬性截断 chat 数组，确保只有最近 N 条消息被发送
globalThis.HideHelper_interceptGeneration = function (chat) {
    const settings = extension_settings[extensionName];
    if (!settings?.enabled) return;

    const autoHideEnabled = settings.autoHideEnabled ?? true;
    if (!autoHideEnabled) return;

    const hideSettings = getCurrentHideSettings();
    if (!hideSettings?.userConfigured || !hideSettings.hideLastN || hideSettings.hideLastN <= 0) return;

    while (chat.length > hideSettings.hideLastN) {
        chat.shift();
    }
};
