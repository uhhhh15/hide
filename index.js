// index.js (使用 extension_settings 存储并包含自动迁移，优化了初始化)
import { extension_settings, loadExtensionSettings, getContext } from "../../../extensions.js";
import Logger from "./Logger.js";
// 尝试导入全局列表，路径可能需要调整！如果导入失败，迁移逻辑需要改用 API 调用
import { saveSettings, saveSettingsDebounced, eventSource, event_types, getRequestHeaders, characters, scrollChatToBottom } from "../../../../script.js";

import { groups } from "../../../group-chats.js";
import { power_user } from "../../../power-user.js";
import { getTokenCountAsync } from "../../../tokenizers.js";
import { promptManager } from "../../../openai.js";
import { loadWorldInfo } from "../../../world-info.js";
// 第三十一轮：`callGenericPopup` / `POPUP_TYPE` 已不再使用（「模拟发送」弹窗改为插件自绘，
//   见 askSimulateContent）—— 保留 import 会是个永远不用的死引用，故移除。
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
    // --- 功能启用/禁用（第三十六轮用户口径①）---
    // 「使用说明 → UI主题」下方新增的三个开关：分别控制「隐藏楼层 / 限制楼层 / 聊天统计」。
    // 关掉 = **两件事一起做**：① 该功能的标签页隐藏；② 该功能的后台行为停掉（用户原话：
    //   「当然是隐藏标签页 + 停掉后台功能。而且插件本身就提供有"禁用隐藏楼层/禁用限制楼层"的开关，
    //   就差"聊天统计"了」）。
    // ⚠️ 前两项**复用已有的功能开关**（隐藏楼层 = autoHideEnabled、限制楼层 = limiter_isEnabled），
    //    不另建一套并行状态 —— 否则「限制楼层」页里的开关与这里的开关会各自为政、互相打脸。
    //    这里只存**标签页可见性**（默认全 true）；真正的功能开关仍读那两个老字段。
    //    「聊天统计」以前没有开关键，故新增 stats_enabled（默认 true = 保持既有行为）。
    tab_visible: { hide: true, limiter: true, stats: true },
    stats_enabled: true,
    // --- 主题设置 ---
    theme: 'light',
    // --- 日志级别设置 ---
    logLevel: 0, // 0=零日志(默认), 1=核心日志, 2=运行日志, 3=完整日志
    // --- 主题提示设置 ---
    theme_notification_viewed: false, // 是否已显示过主题切换提示
    // --- 日志UI显示设置 ---
    logUiVisible: false, // 控制日志级别选择器的显示/隐藏，默认隐藏
    logUiOpenedAt: null, // 记录日志UI开启时的时间戳，用于60分钟熔断
};

// Limiter 双向同步防重入标志
let _limiterSyncing = false;

// 缓存上下文
let cachedContext = null;

// --- 聊天统计 (Token Stats)：消息锚定模型 ---
// 统计不再依赖"打开弹窗时模拟发送"，而是在每次**真实发送**时计算：
// 请求发出前捕获最终上下文（EJS 等渲染完成后），把统计结果锚定在
// "触发本次发送的那条消息"上（message.extra，随聊天文件持久化）。
// 打开统计页时直接读取最近一次锚定即可：
//   - 数据 = 上次实际发送的上下文，不含发送之后才产生的 AI 回复；
//   - 秒开、零副作用（不再触碰输入框/聊天记录）。
// 只保留最新 STATS_ANCHOR_KEEP 条消息上的锚定，更早的自动清理，避免聊天文件膨胀。
// 带滑动的消息：同一条消息的各个 swipe 版本是"同一个锚点的不同版本"，共享同一份输入上下文，
// 因此锚定会镜像写入 message.swipe_info[*].extra，切到任意版本都能读到（详见 writeAnchoredStats）。
const STATS_EXTRA_KEY = 'hideHelperStats';
const STATS_ANCHOR_KEEP = 2;
// 预算预警阈值：总上下文 tokens ≥ 该值时，「总共」框标红提示（用户口径 200000）。
const STATS_BUDGET_TOKENS = 200000;
// 参与锚定的生成类型（用户实际发起的发送；quiet 等后台生成如总结请求不参与）
const ANCHORED_GEN_TYPES = new Set(['normal', 'continue', 'swipe', 'regenerate', 'impersonate']);
// 标记聊天切换的时刻，异步统计以此判废（避免切聊天后旧数据写入新聊天）。
// 语义：computeRenderedStats 开始时清零，本次统计过程中若发生 CHAT_CHANGED 会把它设为
// 一个晚于本次开始的时间戳，统计完成时即可判定"期间切过聊天"并丢弃结果。
let statsClearedAt = 0;
// 最近一次前台生成的类型：GENERATION_STARTED 记录、SETTINGS_READY 消费一次即清空，
// 用于"只锚定真实发送类生成、过滤 quiet 等后台请求"。
// 定义在模块级（而非 setupEventListeners 局部）是为了让模拟发送能在 finally 里兜底清理：
// 模拟期间会临时屏蔽 GENERATION_ENDED / GENERATION_STOPPED，其"清空 pendingGenType"的
// 监听器不会执行，若不手动清理，模拟在 SETTINGS_READY 之前被别的拦截器中止时会残留 'normal'，
// 之后的后台请求消费到它就会被错误锚定。
let pendingGenType = null;
// 最近一次世界书扫描的激活条目（任何来源的扫描都会记录，供后续世界书归属分析）。
// SETTINGS_READY 触发时会快照为 lockedScanEntries，锁定"本次发送"真正使用的条目集。
let lastScanEntries = [];
// 本次发送锁定的世界书条目快照（SETTINGS_READY 时刻从 lastScanEntries 复制）。
// 归因只使用这份快照，避免其他扩展在发送前/后台触发的 dry-run 扫描覆盖 lastScanEntries，
// 导致归因用错条目集。
let lockedScanEntries = [];
// —— 统计任务串行队列（P4-6 修复；替代原"布尔互斥 + 直接丢弃"的写法）——
// 背景（第六轮审查实测）：真实发送与模拟发送共用一份统计流程。原实现用布尔量做互斥，
// 被"丢弃"的请求走 `if (互斥量) return;` 时其 finally 会把正在执行者持有的锁一并释放，
// 导致后到的统计与正在执行的统计重叠、互相覆盖锚点（实测连发 400/40000/8000：40000 被静默丢弃、
// 8000 穿透写入）；且被丢弃的请求没有任何日志与补救。
// 现在：所有统计请求进 FIFO 队列串行执行（一次仅一个）；锁用 owner token（引用比较），
// finally 只释放自己持有的锁；排队与超限均有 Logger.warn，不再静默；
// 任务携带各自的"世界书条目集快照"（见两个入队点），排队期间不再依赖模块级运行时全局。
const STATS_QUEUE_MAX = 8;   // 队列上限：异常积压时丢弃最早的任务，防止无限增长
let statsRunOwner = null;    // 当前执行者的令牌；null = 空闲
const statsJobQueue = [];    // 待执行任务 [{ run, onError, label }]，FIFO

// 把一次统计任务加入队列；空闲时立即调度执行，忙碌时排队等待（有告警，不再静默丢弃）。
function enqueueStatsJob(job) {
    while (statsJobQueue.length >= STATS_QUEUE_MAX) {
        const dropped = statsJobQueue.shift();
        Logger.warn(`【统计】排队已满（上限 ${STATS_QUEUE_MAX}），丢弃最早的一次统计任务（${dropped?.label || '未命名'}）`);
    }
    statsJobQueue.push(job);
    if (statsRunOwner) {
        Logger.warn(`【统计】上一次统计尚未完成，本次任务（${job.label || '未命名'}）改为排队执行（排队中 ${statsJobQueue.length}）`);
    }
    drainStatsQueue();
}

// 串行执行队列：一次只跑一个任务；完成后自动取下一个。
// owner token 保证"本次执行的 finally 只清理本次的锁"——即使任务内部提前 return 或抛错。
function drainStatsQueue() {
    if (statsRunOwner) return;            // 已有任务在跑（含已占位未开跑）
    const job = statsJobQueue.shift();
    if (!job) return;
    const owner = {};                     // 引用比较的令牌（不复用布尔量，杜绝"替别人开锁"）
    statsRunOwner = owner;                // 同步占位：防止同一批连续入队触发多次启动
    setTimeout(async () => {              // 延迟到下一个事件循环：不阻塞 SETTINGS_READY 的监听链
        try {
            await job.run();
        } catch (err) {
            try { job.onError?.(err); } catch (e) { Logger.warn('【统计】任务错误处理失败:', e); }
        } finally {
            if (statsRunOwner === owner) statsRunOwner = null;   // 只释放自己持有的锁
            drainStatsQueue();                                    // 串行：继续下一个任务
        }
    }, 0);
}
// 统计页的锚点浏览状态（仅进程内，不持久化；切换聊天时重置）。
//   statsPinnedIndex  明细模式下手动选中的锚点消息下标；null = 自动跟随最新锚点
//   statsViewMode     当前视图：'detail'（明细）| 'compare'（对比）
//   statsBaselineIndex 对比模式的基准锚点下标；null = 默认取最新
let statsPinnedIndex = null;
let statsViewMode = 'detail';
let statsBaselineIndex = null;
// 明细「已激活条目」列表的排序/过滤状态
//   statsListSortMode   'default'（当前顺序）| 'context'（实际上下文先后顺序）
//   statsListTypeFilter 'all' | 'ejs' | 'dynamic' | 'constant'
let statsListSortMode = 'default';
let statsListTypeFilter = 'all';
// 对比视图「世界书条目差异」的过滤状态
//   statsCmpBookFilter 'all' | 世界书书名
//   statsCmpTypeFilter 'all' | 'ejs' | 'dynamic' | 'constant'
let statsCmpBookFilter = 'all';
let statsCmpTypeFilter = 'all';
// 对比视图的「组合」状态：statsBaselineIndex = 基准锚点、statsCompareIndex = 对比锚点。
// 对比下拉不再逐列选基准，而是直接枚举「基准 → 对比」的有序组合（2 个锚点 2 种、3 个锚点 6 种）。
// 两者同为 null 表示"跟随默认组合"（上一条真实锚点 → 最新真实锚点）。
let statsCompareIndex = null;

// --- 聊天统计 (Token Stats)：模拟发送的临时锚定 ---
// 「模拟发送」= 用当前上下文真实跑一遍组装管线（世界书扫描 + EJS 等渲染），
// 在 CHAT_COMPLETION_SETTINGS_READY 里截获最终上下文并立即 abort 掉真正的 API 请求，
// 因此统计口径与真实发送完全一致（含 EJS），且不消耗 token（落盘说明见 runSimulateSend 上方注释）。
// 结果只放在这个模块级变量里，绝不写入 message.extra、绝不主动 saveChat：
//   - 重新模拟发送 → 覆盖；切换聊天 / 插件初始化 / 刷新页面 → 丢失。
let simulateAnchor = null;      // { total, chat, wi, other, at, genType, wiDetailedStats } | null
let simulateInProgress = false; // 模拟进行中标志：SETTINGS_READY 据此把统计转入临时锚定并 abort 请求
let simulateContent = '';       // 本次模拟发送的自定义内容（供 UI 提示）
let simulateChatId = null;      // 本次模拟发起时的聊天 id；统计落盘前用它核对，防止把 A 聊天的组装结果写进 B 聊天
// 模拟锚定在"统一锚点列表"里的哨兵 id：真实锚点用消息下标（非负整数），二者不会冲突。
// 模拟锚定始终排在列表最右（最新），从而能在 chips / 对比基准里像普通锚点一样被浏览与比对。
const SIM_ANCHOR_ID = 'sim';

// --- 聊天统计：完整上下文快照（内存 + localStorage 持久副本）---
// 每次统计（真实发送 / 模拟发送）会把**实际发送的每条消息**（角色/tokens/来源槽位/正文）存进来，
// 供统计页的「完整上下文」查看器逐条查看与分析。**不写入聊天文件**（聊天文件不会因为它膨胀）。
// ⚠️ 第二十六轮新增**浏览器 localStorage 持久副本**（用户口径：「每次查看效果都要重新生成一遍消息，
//    开发测试阶段非常麻烦」）—— 刷新页面 / 切聊天回来都还在：改完 `style.css` 刷新页面即可直接复看，
//    不用再重发消息。上限 CONTEXT_DUMP_LS_MAX_BYTES，超了从最旧的开始丢；配额写爆则本次会话退化成纯内存。
// 内存里保留最近 CONTEXT_DUMP_KEEP 份（真实锚点按锚定到的消息下标、模拟锚定用 SIM_ANCHOR_ID 作键）。
const CONTEXT_DUMP_KEEP = 3;
const CONTEXT_DUMP_LS_KEY = 'hide-helper.contextDumps.v1';
const CONTEXT_DUMP_LS_MAX_BYTES = 4 * 1024 * 1024;
let contextDumpPersistOff = false;   // 配额写爆过一次就不再尝试（本会话内）
const contextDumpStore = new Map(); // key = `${chatId}|${anchorId}` -> { chatId, anchorId, source, genType, at, total, messages }
// 最近一次 computeRenderedStats 产出的原始快照；由调用方（写锚定 / 模拟锚定）消费后连同键一起入库。
let lastContextDump = null;

function contextDumpKey(chatId, anchorId) { return `${chatId}|${anchorId}`; }

// localStorage 句柄（隐私模式 / 没有 window 时返回 null；离线单测的 shim 里也没有它）
function contextDumpStorage() {
    try {
        return (typeof localStorage !== 'undefined' && localStorage) ? localStorage : null;
    } catch (e) { return null; }
}

function persistContextDumps() {
    if (contextDumpPersistOff) return;
    const ls = contextDumpStorage();
    if (!ls) return;
    try {
        let entries = Array.from(contextDumpStore.values());
        for (let i = 0; i < 4; i++) {
            const payload = JSON.stringify({ v: 1, at: Date.now(), dumps: entries });
            if (payload.length <= CONTEXT_DUMP_LS_MAX_BYTES || entries.length <= 1) {
                ls.setItem(CONTEXT_DUMP_LS_KEY, payload);
                return;
            }
            entries = entries.slice(1);   // 太大 → 先丢掉最旧的那份再试
        }
    } catch (e) {
        contextDumpPersistOff = true;
        Logger.warn('【完整上下文】快照持久化失败（配额或隐私模式），本次会话只保留内存副本:', e?.message || e);
    }
}

// 插件初始化时恢复持久副本（见 initializeExtension 的 1.5 步）
function loadPersistedContextDumps() {
    const ls = contextDumpStorage();
    if (!ls) return 0;
    try {
        const raw = ls.getItem(CONTEXT_DUMP_LS_KEY);
        if (!raw) return 0;
        const data = JSON.parse(raw);
        for (const d of (Array.isArray(data?.dumps) ? data.dumps : [])) {
            if (!d || !d.chatId || d.anchorId === undefined || d.anchorId === null) continue;
            contextDumpStore.set(contextDumpKey(d.chatId, d.anchorId), d);
        }
        if (contextDumpStore.size) Logger.debug(`【完整上下文】已从 localStorage 恢复 ${contextDumpStore.size} 份快照`);
        return contextDumpStore.size;
    } catch (e) {
        Logger.warn('【完整上下文】快照恢复失败:', e?.message || e);
        return 0;
    }
}

function saveContextDump(chatId, anchorId, source, dump) {
    if (!chatId || !dump) return;
    const key = contextDumpKey(chatId, anchorId);
    if (contextDumpStore.has(key)) contextDumpStore.delete(key); // 先删再插 → 刷新 LRU 顺序
    contextDumpStore.set(key, { ...dump, chatId, anchorId, source, at: Date.now() });
    while (contextDumpStore.size > CONTEXT_DUMP_KEEP) {
        const oldest = contextDumpStore.keys().next().value;
        contextDumpStore.delete(oldest);
    }
    persistContextDumps();   // 持久副本：刷新页面 / 切聊天回来仍可查看
}

// --- 聊天统计：锚定落点（"生成的那条消息"）---
// 用户口径：锚定写在**这次发送所生成的那条消息**上，而不是触发发送的那条（否则用户看到 #4 是用户消息会疑惑）。
//   · normal：生成的是触发消息后面新追加的 AI 回复；但统计完成时它可能还没到达（也可能先到）→ 用挂起 + 补写覆盖两种顺序；
//   · swipe / regenerate / continue：被重新生成的就是触发消息本身（chat 最后一条 AI 消息），直接写它（含 swipe_info 镜像）；
//   · impersonate：生成的就是那条（用户侧）消息本身，直接写它。
// 挂起期间若生成被中止/失败（始终没有回复），回退写到触发消息上，保证统计不丢。
let pendingReplyAnchor = null;  // { chatId, triggerIndex, stats, dump } | null

// --- 聊天统计：世界书条目详情子弹窗 ---
// 点击「已激活条目」列表或「世界书条目差异」表格里的条目时，实时从世界书读出该条目的定义并展示：
// 关键词/次关键词、插入位置（position+depth 合并）、顺序、递归两项（只读勾选框）、UID/tokens 行、内容（content）。
// 位置规则：桌面端贴在主弹窗正右方（右侧放不下则左侧、两侧都放不下则居中）；窄屏/移动端居中。
// 尺寸始终与主弹窗一致；连续点击不同条目会刷新同一子窗（用序号丢弃过期请求结果）。
let entryPopupSeq = 0;

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
    // 同时寻找主弹窗、条目详情子窗、聊天统计子弹窗、完整上下文查看器、更新遮罩层、通知弹窗，赋予独立的局部主题标识
    const targets = $('#hide-helper-popup, #hide-helper-entry-popup, #hide-helper-chat-stats-popup, #hide-helper-wi-msg-popup, #hide-helper-ctx-outline-popup, #hide-helper-ctx-merged-popup, .hide-modal-overlay, #hide-helper-theme-notification');
    if (theme === 'dark') {
        targets.attr('data-theme', 'dark');
        $('#hide-helper-theme-toggle').html('<i class="fa-solid fa-sun"></i> 切换为亮色模式');
    } else {
        targets.removeAttr('data-theme');
        $('#hide-helper-theme-toggle').html('<i class="fa-solid fa-moon"></i> 切换为暗色模式');
    }
}

// --- 水波纹主题切换 (View Transitions API) ---
// 以弹窗左下角为圆心，新主题像水波一样向右上角扩散。
// 浏览器不支持 View Transitions（或系统开启"减少动态效果"）时，自动回退为即时切换。
let activeThemeTransition = null;

// 选择本次动画的"涟漪表面"：优先主弹窗，其次是主题提示弹窗
// 注意：这两个都是 position:fixed，offsetParent 恒为 null，不能用来判断可见性
function pickRippleTarget() {
    const isVisible = (el) => !!el && el.getClientRects().length > 0;
    const main = document.getElementById('hide-helper-popup');
    if (isVisible(main)) return main;
    const notification = document.getElementById('hide-helper-theme-notification');
    if (isVisible(notification)) return notification;
    return null;
}

function applyThemeWithRipple(newTheme, { afterFinish } = {}) {
    const applyNow = () => {
        extension_settings[extensionName].theme = newTheme;
        applyTheme(newTheme);
    };

    // 动画全部结束后：落盘保存 + 收尾回调（避免在动画主线程上做重活）
    const finish = () => {
        saveSettingsDebounced();
        if (typeof afterFinish === 'function') {
            afterFinish();
        }
    };

    const cleanup = () => {
        document.querySelectorAll('.hh-ripple-surface').forEach(el => el.classList.remove('hh-ripple-surface'));
        document.documentElement.classList.remove('hh-theme-switching');
    };

    const reduceMotion = typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const target = pickRippleTarget();

    if (reduceMotion || !target || typeof document.startViewTransition !== 'function') {
        applyNow();
        finish();
        return;
    }

    // 计算涟漪几何。
    // 关键：clip-path 作用在与元素等大的快照伪元素上，坐标系原点在**元素自己的左上角**
    // （不是视口原点）。所以圆心用元素内坐标：左下角 = (0, height)；
    // 半径 = 左下角到右上角的对角线长，让扩散终点正好铺满整个弹窗。
    const rect = target.getBoundingClientRect();
    const originX = 0;
    const originY = rect.height;
    const radius = Math.hypot(rect.width, rect.height) + 2;

    // 上一次切换动画还没结束则跳过它，避免叠加
    if (activeThemeTransition) {
        try {
            activeThemeTransition.skipTransition();
        } catch (e) {
            // 忽略：旧动画可能已经结束
        }
        activeThemeTransition = null;
    }

    try {
        // view-transition-name 与"冻结微过渡"标记必须和 startViewTransition 同帧生效：
        // 前者决定快照归属，后者保证旧快照里也不含 0.2s 的颜色过渡
        target.classList.add('hh-ripple-surface');
        document.documentElement.classList.add('hh-theme-switching');

        const transition = document.startViewTransition(applyNow);
        activeThemeTransition = transition;

        // 用 Web Animations 对"新快照"做裁剪扩散，而不是 CSS keyframes。
        // 好处：起止值都是运行时算出的像素值，无需自定义属性传递，
        // 也可以选用"前快后缓"的平滑缓动，避免 ease-out 尾段爬行造成的卡顿感。
        // ⚠️ 必须同时给出**起止两个**关键帧：只给一个时，浏览器会把缺失的另一端补成
        //    元素自身的底层值（clip-path: none = 整个新快照可见），动画就变成"从整块
        //    收缩到左下角一点"，视觉上等于没有水波纹（本轮修复的丢失点）。
        transition.ready.then(() => {
            if (activeThemeTransition !== transition) return;
            document.documentElement.animate(
                {
                    clipPath: [
                        `circle(0px at ${originX}px ${originY}px)`,
                        `circle(${radius}px at ${originX}px ${originY}px)`,
                    ],
                },
                {
                    duration: 620,
                    easing: 'cubic-bezier(0.4, 0.2, 0.2, 1)',
                    fill: 'forwards',
                    pseudoElement: '::view-transition-new(hh-theme-surface)',
                },
            );
        }).catch(() => {});

        transition.finished
            .catch(() => {})
            .finally(() => {
                // 只有"当前有效"的那次过渡才做收尾；被新点击跳过的那次直接忽略
                if (activeThemeTransition === transition) {
                    activeThemeTransition = null;
                    cleanup();
                    finish();
                }
            });
    } catch (e) {
        Logger.warn('主题水波纹切换失败，已回退为即时切换:', e);
        cleanup();
        applyNow();
        finish();
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

    // 主弹窗位置/尺寸变化后，让「条目详情」子窗跟随，保持"正右方 / 居中"的对齐关系
    if ($popup.attr('id') === 'hide-helper-popup') {
        positionEntryPopup();
    }
}

// 把标签页导航的滑动下划线指示条定位到当前激活的标签上（iOS 风格）
function updateTabIndicator() {
    const nav = document.querySelector('#hide-helper-popup .popup-tabs-nav');
    if (!nav) return;
    const indicator = nav.querySelector('.tub-tab-indicator');
    const active = nav.querySelector('.tab-button.active');
    if (!indicator || !active) return;
    const navRect = nav.getBoundingClientRect();
    const btnRect = active.getBoundingClientRect();
    // 弹窗不可见时尺寸为 0，跳过定位，等可见后再调用
    if (!btnRect.width) return;
    indicator.style.width = btnRect.width + 'px';
    indicator.style.transform = `translateX(${btnRect.left - navRect.left}px)`;
}

// ══════════════ 功能启用/禁用（第三十六轮用户口径①）══════════════
// 三个开关 = 「隐藏楼层 / 限制楼层 / 聊天统计」。关掉时**两件事一起做**：
//   ① 隐藏对应的标签页（导航按钮 + 面板本身都藏）；
//   ② 停掉该功能的后台行为。
// 前两项不新建状态，直接复用插件既有的功能开关（用户原话：「插件本身就提供有『禁用隐藏楼层/禁用限制楼层』的开关」）：
//   · 隐藏楼层 → `autoHideEnabled`（`shouldProcessHiding()` 已经在读它）；
//   · 限制楼层 → `limiter_isEnabled`（真正决定是否同步 `chat_truncation`）。
// 「聊天统计」以前没有开关键 → 新增 `stats_enabled`，在统计落笔前的三个入口处统一拦。
// `tab_visible` 只负责"标签页藏不藏"，与功能开关同进同退（写开关时一起写），但读的时候互相独立 ——
//   老用户可能有 `autoHideEnabled=false` 而从未碰过新开关，那种情况要按"功能关着"来处理（见 isFeatureEnabled）。
const FEATURE_TABS = [
    { key: 'hide', tab: 'hide-panel', label: '隐藏楼层' },
    { key: 'limiter', tab: 'limiter-panel', label: '限制楼层' },
    { key: 'stats', tab: 'token-stats-panel', label: '聊天统计' },
];
// 唯一的功能状态读取口：任何"这个功能到底开没开"的判断都走它。
//   · hide / limiter 读老的功能开关字段（缺省 true，保持历史行为）；
//   · stats 读新加 `stats_enabled`（缺省 true）。
function isFeatureEnabled(key) {
    const s = extension_settings[extensionName];
    if (!s) return true;
    if (key === 'hide') return s.autoHideEnabled ?? true;
    if (key === 'limiter') return !!s.limiter_isEnabled;
    if (key === 'stats') return s.stats_enabled ?? true;
    return true;
}

// 把三个开关的状态应用到 UI：导航按钮显隐 + 面板显隐 + 复选框回显。
// 只在主弹窗存在时动手；不会主动切标签页（切换交给 ensureActiveTabAvailable）。
// ⚠️ 显隐一律用 **class**（`.hh-tab-off`），不能用 jQuery 的 `.hide()/.show()` 写内联 display ——
//   标签页的 display 是 CSS 里带 `!important` 的（`.tab-panel{display:none!important}` /
//   `.tab-panel.active{display:block!important}`），内联样式根本压不住，写了等于没写。
function applyFeatureToggles() {
    const s = extension_settings[extensionName];
    if (!s) return;
    // 老用户的兼容：`tab_visible` 缺字段就按功能开关的当前值补齐，
    // 这样"功能本来就关着"的人首次看到新开关时，标签页也是隐藏的（口径一致）。
    const vis = s.tab_visible && typeof s.tab_visible === 'object' ? s.tab_visible : {};
    for (const f of FEATURE_TABS) {
        if (typeof vis[f.key] !== 'boolean') vis[f.key] = isFeatureEnabled(f.key);
    }
    s.tab_visible = vis;

    for (const f of FEATURE_TABS) {
        const show = !!vis[f.key];
        $(`.tab-button[data-tab="${f.tab}"]`).toggleClass('hh-tab-off', !show);
        $(`.tab-panel[data-tab="${f.tab}"]`).toggleClass('hh-tab-off', !show);
        const $chk = $(`#hh-feature-toggle-${f.key}`);
        if ($chk.length) $chk.prop('checked', isFeatureEnabled(f.key));
    }
    // 导航下划线的位置要跟着"可见按钮"重算（被藏的按钮 rect 宽度是 0）
    updateTabIndicator();
}

// 当前停着的页被禁用后，跳到哪：优先「使用说明」（它永远可用），
// 其次任意一个还开着的功能页，都没有就落在使用说明。
// ⚠️ 用户口径追问时问过"跳到哪"，原话是「开关是放在『使用说明』页面的，关掉其他页面又有什么影响？」
//   ⇒ 用户的核心诉求是"别把我正在看的页弄空"；使用说明页始终存在，作兜底最稳。
// 当前停着的页被禁用后，跳到哪：优先任意一个还开着的功能页，都关着就落「使用说明」（它永远可用）。
// ⚠️ 用 class 驱动显隐（`.hh-tab-off`），不用内联 display —— 标签页的 display 是 CSS `!important`。
function ensureActiveTabAvailable() {
    const s = extension_settings[extensionName];
    if (!s) return;
    const vis = s.tab_visible || {};
    const active = $('.tab-button.active').data('tab');
    if (active === 'instructions-panel') return;   // 使用说明页永远可用
    if (active) {
        const blocked = FEATURE_TABS.some(f => f.tab === active && !vis[f.key]);
        if (!blocked) return;
    }
    // 当前页被禁（或本来就没有激活页）→ 落到第一个可用页
    const fallback = (FEATURE_TABS.find(f => vis[f.key])?.tab) || 'instructions-panel';
    $('.tab-button').removeClass('active');
    $(`.tab-button[data-tab="${fallback}"]`).addClass('active').removeClass('hh-tab-off');
    $('.tab-panel').removeClass('active hh-slide-left hh-slide-right');
    const $panel = $(`.tab-panel[data-tab="${fallback}"]`);
    $panel.addClass('active').removeClass('hh-tab-off');
    // 重新触发滑入动画（与点标签时同一套手感；不写死方向）
    void $panel[0]?.offsetWidth;
    $panel.addClass('hh-slide-left');
    if (s.last_active_tab !== fallback) {
        s.last_active_tab = fallback;
        saveSettingsDebounced();
    }
    updateTabIndicator();
    // 落到聊天统计页时要补渲染（与点标签那条路径一致）
    if (fallback === 'token-stats-panel') {
        try { updateTokenStatsUI(); } catch (e) { /* 面板还没建好时忽略 */ }
    }
}

// 只同步"表面状态"：复选框回显 + 标签页可见性，**不写功能字段**（功能字段由调用方自己写）。
// 用途：功能页里原有的开关（`#hide-auto-process-toggle` / `#limiter-enabled`）改动时，
// 让「使用说明」页那三个开关跟着变。`keepTab:true` 表示"不要因为当前页被藏起来就切页" ——
// 用户正站在原地操作它，被弹走会很困惑；标签按钮藏起来，下次进弹窗自然就看不到这页了。
function syncFeatureToggleUI(key, enabled, { keepTab = true } = {}) {
    const s = extension_settings[extensionName];
    if (!s) return;
    if (!s.tab_visible || typeof s.tab_visible !== 'object') s.tab_visible = {};
    s.tab_visible[key] = !!enabled;
    applyFeatureToggles();
    if (!keepTab) ensureActiveTabAvailable();
}

// 写一个功能的开关：功能字段 + 标签页可见性**一起写**（保证"关掉=既不工作也不显示"这一个语义）。
// 限制楼层还要顺手把 `chat_truncation` 同步回原生行为（关 → 恢复插件接管前的原生值；开 → 用影子值）。
async function setFeatureEnabled(key, enabled) {
    const s = extension_settings[extensionName];
    if (!s) return;
    const on = !!enabled;
    if (key === 'hide') {
        s.autoHideEnabled = on;
    } else if (key === 'limiter') {
        s.limiter_isEnabled = on;
        try {
            // 与「限制楼层」页里那个开关走**同一套同步规则**（见 onLimiterSettingsChange）：
            // 开 → 把影子值写回 chat_truncation；关 → 清掉本插件设的值，交还酒馆原生。
            if (on) {
                const count = Number(s.limiter_saved_count) || 0;
                if (count > 0) {
                    power_user.chat_truncation = count;
                    if ($('#chat_truncation').length) {
                        $('#chat_truncation').val(count);
                        $('#chat_truncation_counter').val(count);
                        $('#chat_truncation').trigger('change');
                    }
                }
            } else {
                power_user.chat_truncation = 0;
                if ($('#chat_truncation').length) {
                    $('#chat_truncation').val(0);
                    $('#chat_truncation_counter').val(0);
                    $('#chat_truncation').trigger('change');
                }
            }
        } catch (e) { Logger.warn('【功能开关】同步限制楼层失败:', e); }
    } else if (key === 'stats') {
        s.stats_enabled = on;
    }
    if (!s.tab_visible || typeof s.tab_visible !== 'object') s.tab_visible = {};
    s.tab_visible[key] = on;
    applyFeatureToggles();
    ensureActiveTabAvailable();
    // 「限制楼层」页里那个开关与这里的开关是同一个状态，回显要跟着变
    if (key === 'limiter') {
        $('#limiter-enabled').prop('checked', on);
    }
    // 第三十七轮用户口径②：关掉后标签页立刻消失 → 提示去哪儿重新开启。
    // 三个功能一视同仁（「聊天统计」虽然用户没点名，但它同样会让标签消失，不提示会让人觉得"页面不见了"）。
    // ⚠️ 这里只在**使用说明页的开关**被拨动时触发；功能页里那两个页内开关走的是各自的 change 处理器
    //   （见 `#hide-auto-process-toggle` / `onLimiterSettingsChange`），那里也各调了一次，两条路径不重叠。
    if (!on) showFeatureDisabledHint(FEATURE_TABS.find(f => f.key === key)?.label || key);
    try { await updateCurrentHideSettingsDisplay(); } catch (e) { /* 面板还没建好时忽略 */ }
    saveSettingsDebounced();
}

// 第三十七轮用户口径②：**在功能页里**关掉「隐藏楼层 / 限制楼层」时给一句提示。
// 为什么需要：这两个功能页里各有一个页内开关（`#hide-auto-process-toggle` / `#limiter-enabled`），
//   关掉后**该页的标签按钮会立刻消失** —— 用户站在原地，看不到"怎么再打开"，会以为功能坏了。
//   所以提示里必须写清"去哪重新开启"（= 使用说明页里的那个同名开关）。
// ⚠️ 只在**用户主动拨动页内开关**时提示：其它路径（`setFeatureEnabled` 反向同步、`updateCurrentHideSettingsDisplay`
//   回显）都用 `.prop('checked', …)` 写状态，**不会派发 change 事件**，因此不会误弹。
function showFeatureDisabledHint(label) {
    try {
        toastr?.warning?.(`${label}功能已禁用，可以在【使用说明】页面重新开启。`);
    } catch (e) { /* 没有 toastr 就算了（离线夹具 / 单测） */ }
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
                <span class="tub-tab-indicator" aria-hidden="true"></span>
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
                        <div id="tub-anchor-bar" class="tub-anchor-bar"></div>
                        <div id="tub-detail-section">
                            <div class="tub-row-1" id="tub-row-overview"></div>
                            <div class="tub-row-2" id="tub-row-wi-chart"></div>
                            <div id="tub-entries-section"></div>
                        </div>
                        <div id="tub-compare-section" class="tub-compare-section" style="display: none;"></div>
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

                        <!-- 功能启用/禁用（第三十六轮用户口径①）：紧接「UI主题」下方 -->
                        <!-- 第三十七轮用户口径①：每行的说明文本已整体删除（用户口径"太多余了"），
                             现在每行只剩「名称 + 复选框」。
                             ⚠️ 本模板是 JS 的模板字符串，注释里绝不能出现反引号 —— 那会提前截断字符串，
                                后面的类名会被当成减法表达式求值，实测报 "feature is not defined"、整个弹窗都建不出来。 -->
                        <div class="hh-feature-toggle-container" id="hh-feature-toggles">
                            <div class="hh-feature-toggle-title">功能启用 / 禁用</div>
                            <div class="hh-feature-toggle-row">
                                <div class="hh-feature-toggle-text">
                                    <span class="hh-feature-toggle-name">隐藏楼层</span>
                                </div>
                                <div class="hide-helper-checkbox-container">
                                    <input id="hh-feature-toggle-hide" type="checkbox">
                                    <label for="hh-feature-toggle-hide"></label>
                                </div>
                            </div>
                            <div class="hh-feature-toggle-row">
                                <div class="hh-feature-toggle-text">
                                    <span class="hh-feature-toggle-name">限制楼层</span>
                                </div>
                                <div class="hide-helper-checkbox-container">
                                    <input id="hh-feature-toggle-limiter" type="checkbox">
                                    <label for="hh-feature-toggle-limiter"></label>
                                </div>
                            </div>
                            <div class="hh-feature-toggle-row">
                                <div class="hh-feature-toggle-text">
                                    <span class="hh-feature-toggle-name">聊天统计</span>
                                </div>
                                <div class="hide-helper-checkbox-container">
                                    <input id="hh-feature-toggle-stats" type="checkbox">
                                    <label for="hh-feature-toggle-stats"></label>
                                </div>
                            </div>
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
    Logger.debug('');
    Logger.debug('💾💾💾【保存隐藏设置】开始 💾💾💾');

    const context = getContextOptimized();
    if (!context) {
        Logger.error('【保存隐藏设置】❌ 无法保存设置：上下文不可用');
        Logger.debug('💾💾💾【保存隐藏设置】结束（失败）💾💾💾');
        Logger.debug('');
        return false;
    }

    const chatLength = context.chat?.length || 0;
    const settings = extension_settings[extensionName];
    const useGlobalSettings = settings?.useGlobalSettings || false;
    const entityId = getCurrentEntityId();

    Logger.debug(`【保存隐藏设置】📊 保存参数:`);
    Logger.debug(`【保存隐藏设置】   - hideLastN: ${hideLastN}`);
    Logger.debug(`【保存隐藏设置】   - 当前聊天长度: ${chatLength}`);
    Logger.debug(`【保存隐藏设置】   - 使用全局模式: ${useGlobalSettings}`);
    Logger.debug(`【保存隐藏设置】   - 实体ID: ${entityId || '无法确定'}`);

    const settingsToSave = {
        hideLastN: (hideLastN !== null && hideLastN > 0) ? hideLastN : null,
        lastProcessedLength: chatLength,
        userConfigured: true
    };

    extension_settings[extensionName] = extension_settings[extensionName] || {};

    if (useGlobalSettings) {
        Logger.debug(`【保存隐藏设置】💾 保存到【全局设置】`);
        extension_settings[extensionName].globalHideSettings = settingsToSave;
        Logger.debug(`【保存隐藏设置】✅ 全局设置已更新:`, settingsToSave);
    } else {
        if (!entityId) {
            Logger.error('【保存隐藏设置】❌ 无法保存设置：无法确定实体 ID');
            toastr.error('无法保存设置：无法确定当前角色或群组。');
            Logger.debug('💾💾💾【保存隐藏设置】结束（失败）💾💾💾');
            Logger.debug('');
            return false;
        }
        Logger.debug(`【保存隐藏设置】💾 保存到【实体设置】: ${entityId}`);
        extension_settings[extensionName].settings_by_entity = extension_settings[extensionName].settings_by_entity || {};
        extension_settings[extensionName].settings_by_entity[entityId] = settingsToSave;
        Logger.debug(`【保存隐藏设置】✅ 实体设置已更新:`, settingsToSave);
    }

    saveSettingsDebounced();
    Logger.debug(`【保存隐藏设置】✅ 已调用 saveSettingsDebounced()`);
    Logger.debug(`【保存隐藏设置】✨ 设置已保存: N=${hideLastN}, 模式=${useGlobalSettings ? '全局' : '实体'}`);
    Logger.debug('💾💾💾【保存隐藏设置】结束💾💾💾');
    Logger.debug('');
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
    Logger.debug('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    Logger.debug('【隐藏检查】开始判断是否应该处理隐藏');

    const mainEnabled = extension_settings[extensionName]?.enabled; // 扩展总开关
    const autoHideEnabled = extension_settings[extensionName]?.autoHideEnabled ?? true; // 隐藏功能开关

    Logger.debug(`【隐藏检查】插件总开关状态: mainEnabled=${mainEnabled}`);
    Logger.debug(`【隐藏检查】自动隐藏功能状态: autoHideEnabled=${autoHideEnabled}`);

    if (!mainEnabled || !autoHideEnabled) {
        Logger.debug(`【隐藏检查】❌ 插件或自动隐藏功能已禁用，返回 false`);
        Logger.debug('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        return false;
    }

    const settings = getCurrentHideSettings();
    Logger.debug(`【隐藏检查】当前实体设置:`, {
        exists: !!settings,
        userConfigured: settings?.userConfigured,
        hideLastN: settings?.hideLastN,
        lastProcessedLength: settings?.lastProcessedLength
    });

    // 如果没有配置，或者 hideLastN 是 null/undefined/NaN/0，则不进行自动隐藏处理
    if (!settings) {
        Logger.debug(`【隐藏检查】❌ 设置对象不存在，返回 false`);
        Logger.debug('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        return false;
    }
    if (!settings.userConfigured) {
        Logger.debug(`【隐藏检查】❌ 用户未配置 (userConfigured=false)，返回 false`);
        Logger.debug('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        return false;
    }
    if (!settings.hideLastN || settings.hideLastN <= 0) {
        Logger.debug(`【隐藏检查】❌ 隐藏值无效 (hideLastN=${settings.hideLastN})，返回 false`);
        Logger.debug('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        return false;
    }

    Logger.debug(`【隐藏检查】✅ 所有检查通过，将执行隐藏操作，保留最新 ${settings.hideLastN} 条消息`);
    Logger.debug('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    return true;
}

// 增量隐藏检查
async function runIncrementalHideCheck() {
    Logger.debug('');
    Logger.debug('🔄🔄🔄【增量隐藏检查】开始 🔄🔄🔄');

    if (!shouldProcessHiding()) {
        Logger.debug('【增量隐藏检查】⛔ shouldProcessHiding 返回 false，跳过增量检查');
        Logger.debug('🔄🔄🔄【增量隐藏检查】结束（跳过）🔄🔄🔄');
        Logger.debug('');
        return;
    }

    const startTime = performance.now();
    const context = getContextOptimized();
    if (!context || !context.chat) {
        Logger.debug('【增量隐藏检查】⛔ 上下文或聊天数据不可用，中止');
        Logger.debug('🔄🔄🔄【增量隐藏检查】结束（数据不可用）🔄🔄🔄');
        Logger.debug('');
        return;
    }

    const chat = context.chat;
    const currentChatLength = chat.length;
    const settings = getCurrentHideSettings() || { hideLastN: 0, lastProcessedLength: 0, userConfigured: false };
    const { hideLastN, lastProcessedLength = 0 } = settings;

    Logger.debug(`【增量隐藏检查】📊 当前状态:`);
    Logger.debug(`【增量隐藏检查】   - 当前聊天长度: ${currentChatLength}`);
    Logger.debug(`【增量隐藏检查】   - 保留楼层数 N: ${hideLastN}`);
    Logger.debug(`【增量隐藏检查】   - 上次处理长度: ${lastProcessedLength}`);
    Logger.debug(`【增量隐藏检查】   - 用户已配置: ${settings.userConfigured}`);

    if (currentChatLength === 0 || hideLastN <= 0) {
        Logger.debug(`【增量隐藏检查】⛔ 聊天为空或 N 值无效，跳过`);
        if (currentChatLength !== lastProcessedLength && settings.userConfigured) {
            Logger.debug(`【增量隐藏检查】💾 长度变化 (${lastProcessedLength} -> ${currentChatLength})，保存设置`);
            saveCurrentHideSettings(hideLastN);
        }
        Logger.debug('🔄🔄🔄【增量隐藏检查】结束（空聊天或无效N值）🔄🔄🔄');
        Logger.debug('');
        return;
    }

    if (currentChatLength <= lastProcessedLength) {
        Logger.debug(`【增量隐藏检查】⛔ 聊天长度未增加 (${lastProcessedLength} -> ${currentChatLength})，跳过增量处理`);
        if (currentChatLength < lastProcessedLength && settings.userConfigured) {
            Logger.debug(`【增量隐藏检查】💾 聊天长度减少，保存设置`);
            saveCurrentHideSettings(hideLastN);
        }
        Logger.debug('🔄🔄🔄【增量隐藏检查】结束（长度未增加）🔄🔄🔄');
        Logger.debug('');
        return;
    }

    // 计算可见范围
    const targetVisibleStart = Math.max(0, currentChatLength - hideLastN);
    const previousVisibleStart = lastProcessedLength > 0 ? Math.max(0, lastProcessedLength - hideLastN) : 0;

    Logger.debug(`【增量隐藏检查】📐 可见范围计算:`);
    Logger.debug(`【增量隐藏检查】   - 目标可见起点: ${targetVisibleStart} (索引 >= ${targetVisibleStart} 的消息将可见)`);
    Logger.debug(`【增量隐藏检查】   - 上次可见起点: ${previousVisibleStart}`);
    Logger.debug(`【增量隐藏检查】   - 需要检查的索引范围: [${previousVisibleStart}, ${targetVisibleStart})`);

    if (targetVisibleStart > previousVisibleStart) {
        const toHideIncrementally = [];
        const startIndex = previousVisibleStart;
        const endIndex = targetVisibleStart;

        Logger.debug(`【增量隐藏检查】🔍 扫描消息 [${startIndex}, ${endIndex})...`);

        for (let i = startIndex; i < endIndex; i++) {
            if (chat[i]) {
                if (chat[i].is_system !== true) {
                    toHideIncrementally.push(i);
                    Logger.debug(`【增量隐藏检查】   ✋ 消息 #${i} 标记为隐藏 (is_system: false -> true)`);
                } else {
                    Logger.debug(`【增量隐藏检查】   ⏭️  消息 #${i} 已是隐藏状态，跳过`);
                }
            } else {
                Logger.debug(`【增量隐藏检查】   ❌ 消息 #${i} 不存在，跳过`);
            }
        }

        if (toHideIncrementally.length > 0) {
            Logger.debug(`【增量隐藏检查】🎯 准备隐藏 ${toHideIncrementally.length} 条消息: [${toHideIncrementally.join(', ')}]`);

            // 更新数据
            toHideIncrementally.forEach(idx => {
                if (chat[idx]) {
                    chat[idx].is_system = true;
                }
            });
            Logger.debug(`【增量隐藏检查】✅ 聊天数组数据已更新`);

            // 更新 DOM
            try {
                const hideSelector = toHideIncrementally.map(id => `.mes[mesid="${id}"]`).join(',');
                if (hideSelector) {
                    $(hideSelector).attr('is_system', 'true');
                    Logger.debug(`【增量隐藏检查】✅ DOM 更新完成: ${hideSelector}`);
                }
            } catch (error) {
                Logger.error('【增量隐藏检查】❌ DOM 更新失败:', error);
            }

            Logger.debug(`【增量隐藏检查】💾 保存设置`);
            saveCurrentHideSettings(hideLastN);

            const elapsed = (performance.now() - startTime).toFixed(2);
            Logger.debug(`【增量隐藏检查】✨ 增量隐藏完成！隐藏了 ${toHideIncrementally.length} 条消息，耗时 ${elapsed}ms`);

        } else {
            Logger.debug(`【增量隐藏检查】ℹ️  范围内无需隐藏的消息`);
            if (settings.lastProcessedLength !== currentChatLength && settings.userConfigured) {
                Logger.debug(`【增量隐藏检查】💾 保存设置`);
                saveCurrentHideSettings(hideLastN);
            }
        }
    } else {
        Logger.debug(`【增量隐藏检查】ℹ️  可见起点未前进 (targetVisibleStart=${targetVisibleStart} <= previousVisibleStart=${previousVisibleStart})`);
        if (settings.lastProcessedLength !== currentChatLength && settings.userConfigured) {
            Logger.debug(`【增量隐藏检查】💾 保存设置`);
            saveCurrentHideSettings(hideLastN);
        }
    }

    Logger.debug('🔄🔄🔄【增量隐藏检查】结束🔄🔄🔄');
    Logger.debug('');
}

// 全量隐藏检查
async function runFullHideCheck() {
    Logger.debug('');
    Logger.debug('🔍🔍🔍【全量隐藏检查】开始 🔍🔍🔍');

    if (!shouldProcessHiding()) {
        Logger.debug('【全量隐藏检查】⛔ shouldProcessHiding 返回 false，跳过全量检查');
        Logger.debug('🔍🔍🔍【全量隐藏检查】结束（跳过）🔍🔍🔍');
        Logger.debug('');
        return;
    }

    const startTime = performance.now();
    const context = getContextOptimized();
    if (!context || !context.chat) {
        Logger.debug('【全量隐藏检查】⛔ 上下文或聊天数据不可用，中止');
        Logger.debug('🔍🔍🔍【全量隐藏检查】结束（数据不可用）🔍🔍🔍');
        Logger.debug('');
        return;
    }

    const chat = context.chat;
    const currentChatLength = chat.length;
    Logger.debug(`【全量隐藏检查】📊 当前聊天长度: ${currentChatLength}`);

    const settings = getCurrentHideSettings() || { hideLastN: 0, lastProcessedLength: 0, userConfigured: false };
    const { hideLastN, lastProcessedLength, userConfigured } = settings;

    Logger.debug(`【全量隐藏检查】📋 配置信息:`);
    Logger.debug(`【全量隐藏检查】   - 保留楼层数 N: ${hideLastN}`);
    Logger.debug(`【全量隐藏检查】   - 用户已配置: ${userConfigured}`);
    Logger.debug(`【全量隐藏检查】   - 上次处理长度: ${lastProcessedLength}`);

    // 计算可见起点
    const visibleStart = hideLastN <= 0
        ? 0
        : (hideLastN >= currentChatLength
            ? 0
            : Math.max(0, currentChatLength - hideLastN));

    Logger.debug(`【全量隐藏检查】📐 可见范围计算:`);
    Logger.debug(`【全量隐藏检查】   - 可见起点索引: ${visibleStart}`);
    Logger.debug(`【全量隐藏检查】   - 可见消息范围: [${visibleStart}, ${currentChatLength}) (共 ${currentChatLength - visibleStart} 条)`);
    Logger.debug(`【全量隐藏检查】   - 隐藏消息范围: [0, ${visibleStart}) (共 ${visibleStart} 条)`);

    const toHide = [];
    const toShow = [];
    let changed = false;

    Logger.debug(`【全量隐藏检查】🔍 开始扫描所有 ${currentChatLength} 条消息...`);

    for (let i = 0; i < currentChatLength; i++) {
        const msg = chat[i];
        if (!msg) {
            Logger.debug(`【全量隐藏检查】   ⚠️  索引 ${i}: 消息为空，跳过`);
            continue;
        }

        const isCurrentlyHidden = msg.is_system === true;
        const shouldBeHidden = i < visibleStart;

        if (shouldBeHidden && !isCurrentlyHidden) {
            // 应该隐藏但当前未隐藏 → 需要隐藏
            msg.is_system = true;
            toHide.push(i);
            changed = true;
            Logger.debug(`【全量隐藏检查】   ✋ 索引 ${i}: 隐藏 (is_system: false -> true)`);
        } else if (!shouldBeHidden && isCurrentlyHidden) {
            // 应该显示但当前已隐藏 → 需要显示
            msg.is_system = false;
            toShow.push(i);
            changed = true;
            Logger.debug(`【全量隐藏检查】   👁️  索引 ${i}: 显示 (is_system: true -> false)`);
        } else {
            // 状态正确，无需更改
            const status = isCurrentlyHidden ? '已隐藏' : '已显示';
            Logger.debug(`【全量隐藏检查】   ✓  索引 ${i}: ${status} (无需更改)`);
        }
    }

    Logger.debug(`【全量隐藏检查】📊 差异计算结果:`);
    Logger.debug(`【全量隐藏检查】   - 需要隐藏: ${toHide.length} 条 [${toHide.join(', ') || '无'}]`);
    Logger.debug(`【全量隐藏检查】   - 需要显示: ${toShow.length} 条 [${toShow.join(', ') || '无'}]`);
    Logger.debug(`【全量隐藏检查】   - 是否有变化: ${changed}`);

    if (changed) {
        try {
            Logger.debug(`【全量隐藏检查】🔄 开始应用 DOM 更新...`);

            if (toHide.length > 0) {
                const hideSelector = toHide.map(id => `.mes[mesid="${id}"]`).join(',');
                if (hideSelector) {
                    $(hideSelector).attr('is_system', 'true');
                    Logger.debug(`【全量隐藏检查】   ✅ 隐藏 DOM: ${hideSelector}`);
                }
            }

            if (toShow.length > 0) {
                const showSelector = toShow.map(id => `.mes[mesid="${id}"]`).join(',');
                if (showSelector) {
                    $(showSelector).attr('is_system', 'false');
                    Logger.debug(`【全量隐藏检查】   ✅ 显示 DOM: ${showSelector}`);
                }
            }

            Logger.debug(`【全量隐藏检查】✅ DOM 更新完成`);
        } catch (error) {
            Logger.error('【全量隐藏检查】❌ DOM 更新异常:', error);
        }
    } else {
        Logger.debug(`【全量隐藏检查】ℹ️  无需更改聊天数据或 DOM`);
    }

    // 保存设置
    if (userConfigured && lastProcessedLength !== currentChatLength) {
        Logger.debug(`【全量隐藏检查】💾 长度变化 (${lastProcessedLength} -> ${currentChatLength})，保存设置`);
        saveCurrentHideSettings(hideLastN);
    } else {
        Logger.debug(`【全量隐藏检查】ℹ️  无需保存设置`);
    }

    const elapsed = (performance.now() - startTime).toFixed(2);
    Logger.debug(`【全量隐藏检查】✨ 全量检查完成！隐藏: ${toHide.length}, 显示: ${toShow.length}, 耗时: ${elapsed}ms`);
    Logger.debug('🔍🔍🔍【全量隐藏检查】结束🔍🔍🔍');
    Logger.debug('');
}

// 全部取消隐藏功能
async function unhideAllMessages(isFromInputZero = false) {
    Logger.debug('');
    Logger.debug('👁️👁️👁️【取消所有隐藏】开始 👁️👁️👁️');

    const startTime = performance.now();
    const context = getContextOptimized();

    Logger.debug(`【取消所有隐藏】触发方式: ${isFromInputZero ? '输入值设为0' : '点击取消隐藏按钮'}`);

    if (context?.chat) {
        const chat = context.chat;
        const unhiddenCount = chat.filter(msg => msg.is_system).length;

        Logger.debug(`【取消所有隐藏】📊 当前状态:`);
        Logger.debug(`【取消所有隐藏】   - 总消息数: ${chat.length}`);
        Logger.debug(`【取消所有隐藏】   - 已隐藏消息数: ${unhiddenCount}`);

        chat.forEach(msg => {
            if (msg.is_system) {
                msg.is_system = false;
            }
        });

        const selector = $('.mes[is_system="true"]');
        const domCount = selector.length;
        selector.attr('is_system', 'false');

        Logger.debug(`【取消所有隐藏】✅ 已取消所有消息的隐藏状态`);
        Logger.debug(`【取消所有隐藏】   - 聊天数组更新: ${unhiddenCount} 条`);
        Logger.debug(`【取消所有隐藏】   - DOM 元素更新: ${domCount} 个`);
    }

    // 将设置设为空/禁用状态
    Logger.debug(`【取消所有隐藏】💾 将隐藏设置重置为 null (禁用自动隐藏)`);
    saveCurrentHideSettings(null);

    if (isFromInputZero) {
        Logger.debug(`【取消所有隐藏】✨ 隐藏值已设置为0，已取消当前所有隐藏楼层`);
        toastr.success('隐藏值已设置为0，立即取消当前所有隐藏楼层');
    } else {
        Logger.debug(`【取消所有隐藏】✨ 已取消当前所有楼层隐藏`);
        toastr.success('已立即取消当前所有楼层隐藏');
    }

    updateCurrentHideSettingsDisplay();

    const elapsed = (performance.now() - startTime).toFixed(2);
    Logger.debug(`【取消所有隐藏】✅ 完成，耗时 ${elapsed}ms`);
    Logger.debug('👁️👁️👁️【取消所有隐藏】结束👁️👁️👁️');
    Logger.debug('');
}

// ==================== 聊天统计 (Token Stats) 功能 ====================

// 多模态分片的 token 估算值，对齐 SillyTavern 自身的记账口径：
// 后端无法从纯文本还原图片/视频/音频的真实 token，ST 在拿不到精确值时也使用固定估算
// （见 openai.js 的 Message.addImage/addVideo/addAudio：图片默认 85，视频 263/秒，音频 32/秒）。
// 这里同样采用 ST 的兜底常量，使"实际发送"不会因为这些分片而归零。
const IMAGE_TOKEN_ESTIMATE = 85;                 // ST Message.tokensPerImage
const VIDEO_TOKEN_ESTIMATE = 263 * 40;           // ST 视频兜底估算（约 40 秒）
const AUDIO_TOKEN_ESTIMATE = 32 * 300;           // ST 音频兜底估算（约 5 分钟）

// --- 分词结果缓存（进程内）---
// 每次发送都会对"全部最终消息 + 各条目的命中片段"逐一调用分词器；相邻两次发送中，
// 大部分文本（历史消息、常驻条目、重复片段）逐字相同，重复分词是统计延迟的主要来源。
// 这里按"文本内容"缓存 token 数（以文本本身为键，等价于内容哈希，省掉另算哈希的开销）：
// 命中直接复用，未命中才真正分词；失败的请求不缓存（可重试）。
// 上限 TOKEN_CACHE_MAX 条，超出后按插入顺序淘汰最旧条目（Map 保持插入序），防止长会话无界增长。
const TOKEN_CACHE_MAX = 3000;
const tokenCountCache = new Map();
function cachedTokenCount(text) {
    const key = String(text ?? '');
    if (!key) return Promise.resolve(0);
    const cached = tokenCountCache.get(key);
    if (cached !== undefined) return cached;
    const promise = Promise.resolve()
        .then(() => getTokenCountAsync(key))
        .catch(err => {
            tokenCountCache.delete(key);
            throw err;
        });
    tokenCountCache.set(key, promise);
    if (tokenCountCache.size > TOKEN_CACHE_MAX) {
        const overflow = tokenCountCache.size - TOKEN_CACHE_MAX;
        let n = 0;
        for (const k of tokenCountCache.keys()) {
            if (n++ >= overflow) break;
            tokenCountCache.delete(k);
        }
    }
    return promise;
}

// 统计单条最终消息的 token 数（与"实际发送"口径一致）：
// content 为字符串时直接计数；数组（多模态）时文本分片按分词器计数，
// 图片/视频/音频分片按 ST 的兜底常量估算；工具调用按 JSON 字符串计数（与 ST 的
// setToolCalls 记账方式一致）。所有文本计数走 cachedTokenCount（进程内缓存）。
async function countFinalMessageTokens(msg) {
    let tokens = 0;
    const content = msg?.content;
    if (typeof content === 'string') {
        if (content) tokens += await cachedTokenCount(content);
    } else if (Array.isArray(content)) {
        for (const part of content) {
            if (!part || typeof part !== 'object') continue;
            if (part.type === 'text' && typeof part.text === 'string' && part.text) {
                tokens += await cachedTokenCount(part.text);
            } else if (part.type === 'image_url') {
                tokens += IMAGE_TOKEN_ESTIMATE;
            } else if (part.type === 'video_url') {
                tokens += VIDEO_TOKEN_ESTIMATE;
            } else if (part.type === 'audio_url') {
                tokens += AUDIO_TOKEN_ESTIMATE;
            }
        }
    }
    if (Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0) {
        tokens += await cachedTokenCount(JSON.stringify(msg.tool_calls));
    }
    return tokens;
}

// ---------- 世界书条目归因 ----------
// 思路：最终上下文（实际发送内容）里的每个字符区间只能归属一个来源。
// 把每个激活条目的"可见文本"（EJS 渲染后的文本）拆成行锚点，在最终消息里查找，
// 命中的字符区间折算为 token；已被其他条目认领的区间不再重复计数。
// 这样条目合计不会超过实际发送量，也不会把 EJS 源码或未生效内容算进去。

const ANCHOR_MIN_LENGTH = 12;
const MAX_ANCHORS_PER_ENTRY = 300;
const MAX_RENDERED_EJS_ENTRIES = 80;

// —— 提示词标识的对齐捕获 ——
// 背景：槽位来源判定（世界书 前置/后置、深度注入、聊天）必须知道每条最终消息出自哪个提示词标识
// （main / charDescription / authorsNote / chatHistory-N …，见 openai.js 的 preparePromptsForChatCompletion）。
// 难点（均经浏览器插桩实测）：
//   ① PromptManager 持有的 Message 实例与最终消息**不是同一批对象**（getChat() 生成新对象，
//      之后数组还会被再次替换），"对象引用映射"不可用；
//   ② 第三方在 PROMPT_READY 里会往同一个数组 splice 注入消息（柏宝书实测 +1 条），且监听器顺序不由我们决定；
//   ③ ST-Prompt-Template 在 SETTINGS_READY 里就地改写 content（EJS 渲染），此刻已无法与 promptManager 比对原文。
// 因此选择在 **GENERATE_AFTER_DATA** 采样：此时 PROMPT_READY 的所有监听器（含第三方注入）都已执行完，
// 而 EJS 渲染尚未开始（ST-PT 对 openai 的 AFTER_DATA 处理直接 return），内容与 promptManager 的原文一致。
// 用"顺序内容匹配"把 promptManager 的标识贴到数组下标上（匹配不上 = 第三方插入 → null）。
// 到 SETTINGS_READY 时 EJS 只改 content 不改条数，按下标取用即可。

// ---------- 结构身份（P2-4 修复）：判定每条 `chatHistory-N` 是"真实聊天楼层"还是"注入块" ----------
// 依据 ST 源码，不猜文本内容：
//   · `openai.js:810-874`：注入块按 (depth i, order 组, role) 生成，"新→旧"数组上插到 `i + 已插入数`；
//   · `openai.js:948-955`：随后整条合并数组（楼层 + 注入块）按"自上而下"编号 `chatHistory-1..M`，
//     且编号发生在**预算裁剪之前**（被裁掉的楼层不影响其余编号）。
// 于是：只要数对"块"的条数与顺序，就能算出哪几个 N 是块、其余是楼层——与条目/聊天文本是否被改写无关。
// 数据源与 ST 同源：`promptManager.getPromptCollection(genType)`（openai.js:1470 用的同一个）
// ＋ 运行时注入表 `extension_prompts`（WI @D、扩展 IN_CHAT 注入）。
// 任何一处形状不可信（depth/role 非有限数）或自检不通过 → 返回 null，调用方**回退**到原内容启发式。
const CHAT_HISTORY_ID_RE = /^chatHistory-(\d+)$/;

// 纯函数：把"预设 in-chat 提示词"与"运行时注入表"折算成 ST 会生成的注入块列表。
//   presetPrompts: PromptCollection.collection（含 injection_position / injection_depth / injection_order / role / content）
//   extPrompts:    [{ depth, role }]（已过滤：position=IN_CHAT、value 非空；depth/role 取原始值用于校验）
// 返回 Map<depth, string[]>（元素 = 该 depth 下每个块的 role，顺序与 ST 的 roleMessages 完全一致）。
function buildInjectionBlocks(presetPrompts, extPrompts) {
    const IN_CHAT = 1;
    const ROLE_ORDER = ['system', 'user', 'assistant'];
    const ROLE_NUM = { system: 0, user: 1, assistant: 2 };
    const presets = (Array.isArray(presetPrompts) ? presetPrompts : [])
        .filter(p => p && Number(p.injection_position) === IN_CHAT && p.content);
    const exts = Array.isArray(extPrompts) ? extPrompts : [];
    // ST 侧 `getExtensionPrompt` 用严格比较筛 depth/role；非有限值无法可靠预测 → 放弃（回退）
    for (const p of exts) {
        if (!Number.isFinite(Number(p?.depth)) || !Number.isFinite(Number(p?.role))) return null;
    }
    const depths = [...new Set([
        ...presets.map(p => Number(p.injection_depth ?? 0)),
        ...exts.map(p => Number(p.depth)),
    ])].filter(d => Number.isFinite(d)).sort((a, b) => a - b);
    const byDepth = new Map();
    for (const d of depths) {
        const atDepth = presets.filter(p => Number(p.injection_depth ?? 0) === d);
        // ST：order 组从大到小；组内 role 固定按 system→user→assistant
        const orders = [...new Set([100, ...atDepth.map(p => Number(p.injection_order ?? 100))])]
            .sort((a, b) => b - a);
        const roles = [];
        for (const order of orders) {
            for (const role of ROLE_ORDER) {
                const hasPreset = atDepth.some(p => String(p.role ?? 'system') === role
                    && Number(p.injection_order ?? 100) === order);
                const hasExt = order === 100
                    && exts.some(p => Number(p.depth) === d && Number(p.role) === ROLE_NUM[role]);
                if (hasPreset || hasExt) roles.push(role);
            }
        }
        if (roles.length) byDepth.set(d, roles);
    }
    return byDepth;
}

// 纯函数：复刻 ST 的插入 + 编号，返回"注入块占用哪些 N"（N 从 1 起 = 合并数组里自上而下第 N 条）。
// floorCount = **全部**待发送聊天楼层数（含被预算裁掉的；编号本来就算它们）。
function predictInjectionNs(floorCount, blocksByDepth) {
    const arr = new Array(Math.max(0, Number(floorCount) || 0)).fill('floor'); // 新→旧，楼层顺序不影响块位置
    let inserted = 0;
    for (const [depth, roles] of [...blocksByDepth.entries()].sort((a, b) => a[0] - b[0])) {
        arr.splice(depth + inserted, 0, ...roles.map(() => 'injection'));
        inserted += roles.length;
    }
    const forward = arr.reverse(); // 旧→新 ⇒ 下标 + 1 = chatHistory-N
    const ns = new Set();
    forward.forEach((k, i) => { if (k === 'injection') ns.add(i + 1); });
    return { ns, length: forward.length, blockCount: inserted };
}

// 读数据源 → 预测注入块的 N 集合。失败返回 null。
function collectInjectionBlockNs(genType) {
    try {
        let presetPrompts = [];
        try {
            const coll = promptManager?.getPromptCollection?.(String(genType || 'normal'))?.collection;
            if (Array.isArray(coll)) presetPrompts = coll;
        } catch (e) {
            presetPrompts = [];
        }
        const extAll = getContextOptimized()?.extensionPrompts || {};
        const extPrompts = [];
        for (const key of Object.keys(extAll).sort()) { // ST 用 Object.keys(...).sort()
            const p = extAll[key];
            if (!p || Number(p.position) !== 1 || !p.value || !String(p.value).trim()) continue;
            extPrompts.push({ depth: p.depth, role: p.role });
        }
        const blocksByDepth = buildInjectionBlocks(presetPrompts, extPrompts);
        if (!blocksByDepth) return null;
        const floorCount = computeSendableChat(getContextOptimized()?.chat, genType).length;
        return { ...predictInjectionNs(floorCount, blocksByDepth), floorCount };
    } catch (e) {
        Logger.debug('【统计】结构身份预测失败（回退内容启发式）:', e);
        return null;
    }
}
let lastPromptCapture = null; // Array<string|null> | null（与捕获时刻的消息数等长）
let lastPromptKindCapture = null; // Array<'floor'|'injection'|null> | null（结构身份，与 ids 同步消费）

function captureContentOf(msg) {
    const content = msg?.content;
    if (typeof content === 'string') return content.replace(/\r/g, '');
    if (Array.isArray(content)) {
        return content
            .filter(p => p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string')
            .map(p => p.text)
            .join('\n')
            .replace(/\r/g, '');
    }
    return '';
}

// 在 GENERATE_AFTER_DATA 处同步采样并构建"按下标的标识数组"。
function capturePromptIdentifiers(chatMessages) {
    lastPromptCapture = null;
    lastPromptKindCapture = null;
    try {
        const root = promptManager?.messages;
        if (!root || !Array.isArray(chatMessages) || !chatMessages.length) return;
        // 展平 promptManager 的 Message 集合（顺序与 ChatCompletion.getChat() 一致）
        const items = [];
        const walk = (collection) => {
            const list = collection?.collection;
            if (!Array.isArray(list)) return;
            for (const item of list) {
                if (Array.isArray(item?.collection)) { walk(item); continue; }
                if (item && (item.content || item.tool_calls)) {
                    items.push({ id: item.identifier ?? null, content: captureContentOf(item) });
                }
            }
        };
        walk(root);
        if (!items.length) return;

        // 结构身份（P2-4）：预测"注入块"占用的 N 集合；自检不过或无法预测 → identityNs = null（全回退）
        let identityNs = null;
        {
            const predicted = collectInjectionBlockNs(pendingGenType);
            let maxN = 0;
            let chTotal = 0;
            for (const it of items) {
                const m = typeof it.id === 'string' ? CHAT_HISTORY_ID_RE.exec(it.id) : null;
                if (m) { chTotal++; maxN = Math.max(maxN, Number(m[1])); }
            }
            // 自检：树里存在的最大 N 必须等于预测的合并数组长度
            //（编号在预算裁剪前生成，最靠下的那条必然存活；不等 → 说明预测的块数/顺序有误）
            if (predicted && chTotal > 0 && maxN === predicted.length) {
                identityNs = predicted.ns;
                Logger.debug(`【统计】结构身份：待发送楼层 ${predicted.floorCount} 条 / 注入块 ${predicted.blockCount} 条 / 合并长度 ${predicted.length}（自检通过）`);
            } else if (predicted && chTotal > 0) {
                Logger.debug(`【统计】结构身份自检未通过（maxN=${maxN} vs 预测长度=${predicted.length}）→ 回退内容启发式`);
            }
        }
        const kindOfId = (id) => {
            if (!identityNs || typeof id !== 'string') return null;
            const m = CHAT_HISTORY_ID_RE.exec(id);
            if (!m) return null;
            return identityNs.has(Number(m[1])) ? 'injection' : 'floor';
        };

        // 顺序内容匹配：pm 项按序消费；匹配不上的最终消息视为第三方插入（记 null，不推进 pm 游标）。
        // 允许多看几条：pm 里有、但本次未进入最终上下文的消息（如被预算截断/被压缩）应被跳过。
        // squash_system_messages 开启时相邻系统消息会被合并成一条（内容以 \n 连接）：
        // 这种"包含式"命中要把它吃掉的所有 pm 项一并消费，否则后续消息会整体错位。
        // 同时要求包含式命中的 pm 文本足够长（>= LOOSE_MIN_LENGTH），避免极短文本（如 "ok"）造成误消费。
        const ids = new Array(chatMessages.length).fill(null);
        const kinds = new Array(chatMessages.length).fill(null);
        const LOOSE_MIN_LENGTH = 16;
        const LOOKAHEAD = 6;
        const exact = (a, b) => a === b || (a.length > 0 && a.trim() === b.trim());
        const loose = (msgText, pmText) => pmText.length >= LOOSE_MIN_LENGTH
            && (msgText.startsWith(pmText) || msgText.includes(pmText));
        // 吃掉一条合并消息里的其余 pm 组成项（内容都被该消息包含）
        const consumeMergedParts = (from, msgText) => {
            let k = from;
            while (k < items.length && items[k].content.length >= LOOSE_MIN_LENGTH
                && msgText.includes(items[k].content)) {
                k++;
            }
            return k;
        };
        let j = 0;
        let matched = 0;
        for (let i = 0; i < chatMessages.length; i++) {
            const text = captureContentOf(chatMessages[i]);
            let consumed = -1;
            for (let k = j; k < Math.min(j + LOOKAHEAD, items.length); k++) {
                if (exact(text, items[k].content)) { consumed = k; break; }
                if (loose(text, items[k].content)) { consumed = k; break; }
            }
            if (consumed >= 0) {
                const wasExact = exact(text, items[consumed].content);
                ids[i] = items[consumed].id;
                kinds[i] = kindOfId(items[consumed].id);
                j = wasExact ? consumed + 1 : consumeMergedParts(consumed + 1, text);
                matched++;
            }
            // 未匹配：第三方插入，保持 null 且不推进游标
        }

        // 命中率过低（不是同一次组装等）时放弃，避免给出错误的类目。
        // 分母取两侧较小值：promptManager 里可能包含本次未进入最终上下文的消息（如被预算截断）。
        const base = Math.min(items.length, chatMessages.length) || 1;
        const okCapture = matched / base >= 0.6;
        lastPromptCapture = okCapture ? ids : null;
        lastPromptKindCapture = okCapture ? kinds : null;
    } catch (e) {
        Logger.debug('【统计】捕获提示词标识失败，跳过构成拆解:', e);
        lastPromptCapture = null;
        lastPromptKindCapture = null;
    }
}

// 把 SETTINGS_READY 的最终消息对齐到捕获的标识序列（消费一次，避免过期数据误配到后续请求）。
// 返回值与 messages 等长：字符串 = 该消息来自 ST 组装；null = 第三方插入（未对齐）。
// 条数不一致（期间又发生增删）或整体命中率过低时返回 null，放弃拆解。
function alignPromptIdentifiers(messages) {
    const ids = lastPromptCapture;
    lastPromptCapture = null; // 消费一次：过期数据绝不错配到后续无来源的后台请求
    if (!Array.isArray(ids) || !Array.isArray(messages) || !messages.length) return null;
    if (ids.length !== messages.length) {
        Logger.debug(`【统计】提示词标识条数不一致（${ids.length} vs ${messages.length}），跳过构成拆解`);
        return null;
    }
    const stCount = ids.filter(x => x !== null).length;
    if (!stCount || stCount / messages.length < 0.5) {
        Logger.debug(`【统计】提示词标识对齐率过低（${stCount}/${messages.length}），跳过构成拆解`);
        return null;
    }
    return ids;
}

// 消费结构身份捕获（与 alignPromptIdentifiers 同一时刻、同一套条数校验；过期数据绝不错配）。
// 返回 Array<'floor'|'injection'|null>；null（整条） = 本次没有可用的结构身份 → 调用方回退内容启发式。
function alignPromptKinds(messages) {
    const kinds = lastPromptKindCapture;
    lastPromptKindCapture = null;
    if (!Array.isArray(kinds) || !Array.isArray(messages) || !messages.length) return null;
    if (kinds.length !== messages.length) return null;
    if (!kinds.some(k => k !== null)) return null;
    return kinds;
}

// 统计过程绝不能改动游戏状态：渲染条目时把这些会产生副作用的函数替换为空操作
const READONLY_ENV_OVERRIDES = [
    'setvar', 'setLocalVar', 'setGlobalVar', 'setMessageVar',
    'incvar', 'incLocalVar', 'incGlobalVar', 'incMessageVar',
    'decvar', 'decLocalVar', 'decGlobalVar', 'decMessageVar',
    'delvar', 'delLocalVar', 'delGlobalVar', 'delMessageVar',
    'insvar', 'insertLocalVar', 'insertGlobalVar', 'insertMessageVar',
    'patchVariables', 'applyVarYamlAnnotate', 'setVariableSchema',
    'activateRegex', 'deactivateRegex',
    'activewi', 'activateWorldInfo', 'activateWorldInfoByKeywords',
    'injectPrompt', 'execute',
].reduce((acc, name) => { acc[name] = () => undefined; return acc; }, {});

function entryHasEjs(entry) {
    return typeof entry?.content === 'string' && /<%(?!%)[\s\S]*?(?<!%)%>/.test(entry.content);
}

function entryKey(entry) {
    return `${entry?.world ?? ''}::${entry?.uid ?? ''}::${entry?.comment ?? ''}`;
}

// 提取消息的可搜索文本（多模态消息取文本分片）
function getMessageSearchText(msg) {
    const content = msg?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter(p => p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string')
            .map(p => p.text)
            .join('\n');
    }
    return '';
}

// 把一个条目的可见文本拆成行锚点（过短的行不参与匹配，降低误判）
// 除了原文，还会用"去掉宏语法"的变体补充锚点：某些条目不含 EJS 但含 {{char}} 等宏，
// 在酒馆端会被替换后才发送，直接用原文匹配会漏。这里只做文本层面的宏剥离，不执行宏（避免副作用）。
function extractAnchors(visibleText) {
    const anchors = [];
    const seen = new Set();
    const variants = [String(visibleText), String(visibleText).replace(/\{\{[^}]*\}\}/g, '')];
    for (const variant of variants) {
        for (const rawLine of variant.split('\n')) {
            const line = rawLine.trim();
            if (line.length < ANCHOR_MIN_LENGTH || seen.has(line)) continue;
            seen.add(line);
            anchors.push(line);
            if (anchors.length >= MAX_ANCHORS_PER_ENTRY) break;
        }
        if (anchors.length >= MAX_ANCHORS_PER_ENTRY) break;
    }
    if (!anchors.length) {
        const whole = String(visibleText).trim();
        if (whole.length >= 6) anchors.push(whole);
    }
    return anchors;
}

// 条目可见文本里**第一个可用行锚点**（第二十九轮：给「上下文目录 → 完整上下文」的条目定位用）。
// 与 `extractAnchors` / `findEntrySpans` 同一套口径 —— 也就是说：统计里"认领"了哪些字符，
// 就用同样的一段原文去内容区里找它的起点。优先取整段（去首尾空白），太长时退回第一个非空行。
function entryAnchorHint(visibleText) {
    const raw = String(visibleText ?? '').trim();
    if (!raw) return '';
    const whole = raw;
    if (whole.length <= 240) return whole;
    const line = raw.split(/\r?\n/).map(l => l.trim()).find(l => l.length >= ANCHOR_MIN_LENGTH);
    return line || whole.slice(0, 240);
}

// 认领一个字符区间；与已认领区间重叠则失败（避免条目间重复计数）
function claimInterval(slot, start, end) {    for (const [s, e] of slot.claimed) {
        if (start < e && end > s) return false;
    }
    slot.claimed.push([start, end]);
    return true;
}

// 在最终消息（slots，含 user/assistant，不分角色）中查找条目锚点，返回命中的字符区间
function findEntrySpans(visibleText, slots) {
    const anchors = extractAnchors(visibleText);
    const spans = [];
    const totalChars = String(visibleText).length || 1;
    let matchedChars = 0;

    for (const anchor of anchors) {
        if (matchedChars / totalChars >= 0.95) break;
        for (const slot of slots) {
            if (!slot.text) continue;
            let from = 0;
            let hits = 0;
            while (hits < 2) {
                const idx = slot.text.indexOf(anchor, from);
                if (idx === -1) break;
                const end = idx + anchor.length;
                if (claimInterval(slot, idx, end)) {
                    spans.push({ slot, start: idx, end });
                    matchedChars += anchor.length;
                }
                from = end;
                hits++;
            }
        }
    }
    return spans;
}

// 合并相邻命中区间后，按"所属消息"取出文本片段，供 token 计数与归属回填。
// 返回 Map<slot, string[]>：每个槽位（对应一条最终消息）被认领的文本片段。
function extractSpanPiecesBySlot(spans) {
    const bySlot = new Map();
    for (const span of spans) {
        if (!bySlot.has(span.slot)) bySlot.set(span.slot, []);
        bySlot.get(span.slot).push(span);
    }
    const result = new Map();
    for (const [slot, list] of bySlot) {
        list.sort((a, b) => a.start - b.start);
        const pieces = [];
        let curStart = -1;
        let curEnd = -1;
        for (const span of list) {
            if (curStart >= 0 && span.start <= curEnd + 1) {
                curEnd = Math.max(curEnd, span.end);
            } else {
                if (curStart >= 0) pieces.push(slot.text.slice(curStart, curEnd));
                curStart = span.start;
                curEnd = span.end;
            }
        }
        if (curStart >= 0) pieces.push(slot.text.slice(curStart, curEnd));
        result.set(slot, pieces);
    }
    return result;
}

// 计算所有激活条目的"可见文本"（EJS 优先渲染；渲染期间屏蔽副作用函数）。
// 返回 Map<entryKey, string>：条目的可见文本（EJS 条目为渲染后文本，其余为原文）。
// entries = 本次统计锁定的条目集（由 computeRenderedStats 传入；调用方保证同一批次一致）。
async function getEntriesVisibleTexts(startedAt, entries) {
    const results = new Map();
    const ejs = globalThis.EjsTemplate;
    let readonlyEnv = null;

    if (ejs && typeof ejs.evalTemplate === 'function') {
        try {
            const env = await ejs.prepareContext();
            readonlyEnv = { ...env, ...READONLY_ENV_OVERRIDES };
        } catch (e) {
            Logger.warn('准备 EJS 渲染环境失败，条目将退回按原始文本匹配:', e);
        }
    }

    let renderedCount = 0;
    for (const entry of entries) {
        let text = typeof entry.content === 'string' ? entry.content : '';
        if (entryHasEjs(entry) && readonlyEnv && renderedCount < MAX_RENDERED_EJS_ENTRIES) {
            renderedCount++;
            try {
                const rendered = await ejs.evalTemplate(text, readonlyEnv, {});
                if (typeof rendered === 'string') {
                    text = rendered;
                }
            } catch (e) {
                // 渲染失败：退回原始文本，仅能匹配其中的静态部分
            }
        }
        results.set(entryKey(entry), String(text).replace(/\r/g, ''));
        if (statsClearedAt > startedAt) break;
    }
    return results;
}

// 计算"本次实际发送的聊天消息"（老→新）及其在聊天数组里的下标。
// 对齐 ST 的 coreChat：隐藏楼层（is_system）不发送；swipe 时被重新生成的那条（最后一条）会被 pop() 排除。
// 世界书深度注入（position=4 / depth:N）最终落在"倒数第 N 条消息之前"，
// 即插到"发送列表里的第 (n − N) 条消息之前"（N=0 → 末尾；N≥n → 顶部）。
// 这里返回发送列表：[{ floor, isUser, name }]（floor = 聊天数组下标），供 entryContextAnchor 映射。
function computeSendableChat(chatSnapshot, genType) {
    if (!Array.isArray(chatSnapshot) || !chatSnapshot.length) return [];
    // 与 ST 的 setOpenAIMessages（openai.js:578-618）对齐：隐藏楼层（is_system）与带"忽略"符号
    // （extra[IGNORE_SYMBOL]）的楼层都不发送；NARRATOR 楼层仍会发送（只是 role 变 system），故不排除。
    // 用 Symbol.for('ignore') 兜底：与 ST 的 IGNORE_SYMBOL 同源（constants.js:25），且不依赖外部函数，
    // 便于审计装置（probe5）从源码抽取本函数单独运行。
    const ignoreSymbol = globalThis.SillyTavern?.getContext?.()?.symbols?.ignore ?? Symbol.for('ignore');
    let list = chatSnapshot.filter(m => m && !m.is_system
        && !(ignoreSymbol && m.extra && m.extra[ignoreSymbol]));
    if (genType === 'swipe' && list.length) list = list.slice(0, -1); // swipe 的最后一条（被重生成的回复）不参与
    return list.map((m, i) => ({ floor: chatSnapshot.indexOf(m), isUser: !!m.is_user, name: String(m.name || ''), seq: i }));
}

// 判断一个上下文槽位的文本是否"就是"某条聊天消息（最终消息 = 聊天原文，可能带"名字: "前缀，
// 也可能被正则/替换改写）。改写后仍包含原文的最常见，故主判据是包含关系。
// 短消息（如"继续"）容易在任何长文本里误命中：要求整段相等，或位于末尾且前面是名字/换行分隔。
function slotContainsChatText(slotText, raw) {
    if (!slotText || !raw) return false;
    if (slotText === raw) return true;
    if (raw.length >= 8) return slotText.includes(raw);
    if (!slotText.endsWith(raw)) return false;
    const prefix = slotText.slice(0, slotText.length - raw.length);
    return /(^|[:\n])\s*$/.test(prefix);
}

// 该槽是否匹配"真实聊天楼层"（用于混槽救援的护栏：真实聊天消息永不被当成世界书整块）。
// 返回 true=能对上某条待发送消息；false=有快照但对不上（典型：深度注入/第三方插入）；
// null=快照缺失、无法判定（调用方据此禁用救援，保持旧的保守行为）。
function slotIsChatFloor(slotText, chatSnapshot, genType) {
    if (!Array.isArray(chatSnapshot) || !chatSnapshot.length || !slotText) return null;
    const sendable = computeSendableChat(chatSnapshot, genType);
    for (const m of sendable) {
        const raw = String(chatSnapshot[m.floor]?.mes ?? '').replace(/\r/g, '');
        if (slotContainsChatText(slotText, raw)) return true;
    }
    return false;
}

// 发送时刻捕获作者注释（AN）的**真实落点**：`extension_prompts['2_floating_prompt']` 在发送前由
// `setFloatingPrompt()`（`authors-note.js`）写入，`{ position, depth, role }` 就是 ST 用来决定 AN 位置的那组值：
//   position = 0（IN_PROMPT，主提示词后）→ 紧随 main（在全部聊天消息之前）
//   position = 2（BEFORE_PROMPT，主提示词前）→ 紧随 main（同上，只是在 main 之前）
//   position = 1（IN_CHAT，注入深度 d）→ 与 @D 同落点（插到发送列表第 n−d 条之前）
// AN 顶/底 的世界书条目（position 2/3）会并进这段 AN 文本，因此也用这个落点。
// 取不到时返回 null，`entryContextAnchor` 退回"紧随主提示词"的默认落点。
// 注意：AN 为空（本次未插入作者注释）时也返回 null —— 此时 AN 顶/底的世界书条目会随 AN 一起**不被发送**，
// 它们只会落在「未匹配」里，不该凭空给一个深度落点。
function captureAnInfo() {
    try {
        const p = getContext?.()?.extensionPrompts?.['2_floating_prompt'];
        if (!p || !p.value) return null;
        const position = Number(p.position);
        if (!Number.isFinite(position) || position < 0) return null;
        return { position, depth: Number(p.depth), role: p.role ?? null };
    } catch (e) {
        return null;
    }
}

// 发送时刻同步取「提示词顺序快照」——这是**本次发送真正生效**的区块顺序。
// 依据 ST 源码：`openai.js:1470` 取 `prompts = promptManager.getPromptCollection(type)`，随后每个区块都用
// `chatCompletion.add(collection, prompts.index(source))` 落位（`populateChatCompletion`）——
// 即**区块在 prompt 集合里的下标决定最终次序**。
// ⚠️ `prompt_order` 可被用户随时增删/启停/拖动（提示词管理器），`promptManagerDefaultPromptOrder` 只是初始值，
// 所以绝不能把 ST 的默认顺序写死；这里取的就是与 ST 同源的那份集合（用户改完后，本次发送即按新顺序）。
// 返回 { ranks: Map<identifier, 下标>, chatOrd, length }；取不到 → null（调用方逐字节回退旧固定键）。
function capturePromptOrderSnapshot(genType) {
    try {
        const coll = promptManager?.getPromptCollection?.(String(genType || 'normal'))?.collection;
        if (!Array.isArray(coll) || !coll.length) return null;
        const ranks = new Map();
        coll.forEach((p, i) => {
            const id = p?.identifier;
            if (typeof id === 'string' && !ranks.has(id)) ranks.set(id, i);
        });
        if (!ranks.size) return null;
        const chatOrd = ranks.has('chatHistory') ? ranks.get('chatHistory') : null;
        Logger.debug(`【统计】提示词顺序快照：${ranks.size} 个区块，chatHistory@${chatOrd}`);
        return { ranks, chatOrd, length: coll.length };
    } catch (e) {
        Logger.debug('【统计】提示词顺序快照失败（顺序键回退固定值）:', e);
        return null;
    }
}

// 由条目的 position/depth 算出它在本轮上下文中的"真实插入点"，供「上下文顺序」归组。
// 返回 { key, ord, chatOrd, kind, label, badge, after, mesid, ... }：label/badge 供展示；
// 深度注入额外带 { mesid, who, name } —— 有了这些结构字段，「上下文顺序」的分组标题就能直接显示
// **聊天里那串 mesIDDisplay 序号**（由 contextAnchorView 渲染），而不是再拼一句"在聊天 #N 之前插入"。
// ⚠️ 依据 ST 源码（`openai.js: populateChatCompletion` + `world-info.js: WIDepthEntries`）：
//   · position=0/1（前置/后置世界书）：`chatCompletion.add(collection, prompts.index('worldInfoBefore'|'worldInfoAfter'))`
//     —— 落点由 **prompt_order** 决定，**不是**写死的默认顺序；两者默认都在 chatHistory 之前，
//     但用户可以把它们拖到 chatHistory 之后（那时它们就在**全部聊天消息之后**，`after` 会跟着变）。
//   · position=2/3（作者注释 顶/底）：并入 AN 文本，而 AN 的落点由用户设置决定（见 anInfo）：
//     「主提示词前/后」→ 紧随 main（`openai.js: injectToMain`），「注入深度」→ 与 @D 同样插到第 (n−d) 条消息之前。
//   · position=4（@D 深度注入）：插到发送列表第 (n − depth) 条消息之前（`world-info.js`：`entry.depth ?? DEFAULT_DEPTH`；
//     越界：b≥n → 末尾、b<0 → 顶部）。
//   · position=5/6（对话示例 顶/底）：并入 dialogueExamples（5 在前、6 在后），位置同样由 prompt_order 给出。
//   · position=7（出口）：落点由 `{{outlet::名字}}` 宏出现处决定，无法反推。
// anInfo（可选）= 当前 AN（作者注释）的真实落点，由调用方在发送时刻捕获：
//   { position: extension_prompt_types 值(0=IN_PROMPT / 1=IN_CHAT / 2=BEFORE_PROMPT), depth, role }
// orderSnap（可选）= `capturePromptOrderSnapshot()` 的结果：发送时刻同步取的**本次真实提示词顺序**。
//   ⚠️ 顺序号必须来自它，**不能**假设 `promptManagerDefaultPromptOrder`；取不到时 ord/chatOrd 为 null，
//   渲染层回退旧的固定键（旧行为逐字节不变）。
function entryContextAnchor(entry, sendable, anInfo = null, orderSnap = null) {
    const pos = Number(entry.position) || 0;
    const n = sendable.length;
    // 首/末条"会被发送的聊天消息"的 mesIDDisplay 序号：给各"非深度"位置定位用
    // （用户口径：上下文顺序里除确实定不出序号的情形外，每组的标题都要显示一条聊天消息的序号）
    const firstFloor = n ? sendable[0].floor : null;
    const lastFloor = n ? sendable[n - 1].floor : null;
    // 本次发送的真实顺序号（= 区块在 prompt 集合里的下标）；取不到 → null（回退旧固定键）
    const rankOf = (id) => {
        const r = orderSnap?.ranks?.get?.(id);
        return Number.isFinite(r) ? Number(r) : null;
    };
    const chatOrd = Number.isFinite(orderSnap?.chatOrd) ? Number(orderSnap.chatOrd) : null;
    // 集合长度：标识**不在集合里**时用它当"追加到末尾"的顺序号。
    // 依据 ST：这类提示词会被 `prompts.add(newPrompt)`（openai.js 1473-1493，systemPrompts 合并）
    // 或 `chatCompletion.add(collection, -1)`（1106/890，对话示例）**push 到末尾**；
    // 若该提示词是被"停用"的（enabled=false / isPromptDisabledForActiveCharacter）则根本不发送，
    // 条目只会落进「未匹配」——这种情况下顺序号取值不影响任何可见结果。
    const snapEnd = Number.isFinite(orderSnap?.length) ? Number(orderSnap.length) : null;
    const rankOfSection = (id, offset = 0) => {
        const r = rankOf(id);
        if (r !== null) return r + offset;
        return snapEnd === null ? null : snapEnd + offset;
    };
    // 区块落点（前置/后置/AN/EM 共用一个模型）：
    //   ord   该区块的真实顺序号（小者更靠上）；null = 没拿到顺序快照 → 回退旧固定键
    //   after 该区块是否整块落在**全部聊天消息之后**（用户把 chatHistory 拖到它前面时才会发生）
    //   mesid 对应哪条聊天消息（after 时是末条，否则是首条）
    // ⚠️ 顺序由 prompt_order 决定、用户随时可改，所以一律按 orderSnap 现场推导，绝不写死默认顺序。
    const sectionAnchor = ({ id, legacyKey, kind, badge, text }) => {
        const rank = id ? rankOfSection(id) : null;
        const after = (rank !== null && chatOrd !== null) ? rank > chatOrd : false;
        return {
            key: legacyKey,                                            // 旧字段：仅作旧格式/回退用（渲染层已改用 kind + ord）
            ord: rank,                                                 // 新字段：本次发送的真实顺序号（null = 无快照）
            chatOrd: rank === null ? null : chatOrd,
            kind, badge, after,
            mesid: after ? lastFloor : firstFloor,
            label: `${text}（${after ? '位于全部聊天消息之后' : '位于全部聊天消息之前'}）`,
        };
    };
    // 「深度注入」共用的落点换算（@D 与 AN-at-depth 都走这里）
    const depthAnchorOf = (dRaw, kindName, badgePrefix) => {
        const dNum = Number(dRaw);
        const d = (dRaw === null || dRaw === undefined) ? ST_DEFAULT_DEPTH
            : (Number.isFinite(dNum) ? dNum : ST_DEFAULT_DEPTH);
        const b = n - d; // 插到发送列表第 b 条之前（b=n → 末尾）
        // 深度注入落在 chatHistory 区块内部：带 chatOrd 让渲染层把顺序号归一化到 (chatOrd, chatOrd+1)
        const ord = chatOrd;
        // 越界两种情形也带 mesid：缺口序号时显示层要能显示"最后一条 / 第一条待发送消息"的序号
        if (b >= n) return { key: 1000 + n, ord, chatOrd, kind: 'depth-end', mesid: lastFloor, label: '在所有聊天消息之后（末尾）', badge: '末尾' };
        if (b < 0) return { key: 1000 + b, ord, chatOrd, kind: 'depth-top', mesid: firstFloor, label: '在所有聊天消息之前（顶部）', badge: '顶部' };
        const m = sendable[b];
        const who = m.isUser ? '用户' : '角色';
        const nameText = m.name ? ` · ${m.name}` : '';
        // mesid = 该楼层在聊天里的 mesIDDisplay 序号（= 它在 chat 数组里的下标；ST `addOneMessage`
        // 写的就是 `mesIDDisplay.textContent = '#' + messageId`，messageId 即数组下标）。
        const mesid = m.floor;
        return {
            key: 1000 + b, ord, chatOrd, kind: kindName, mesid, who, name: m.name || '',
            label: `在此消息之前插入（${who}消息${nameText}）`,
            badge: `${badgePrefix}#${mesid}`,
        };
    };
    if (pos === 4) return depthAnchorOf(entry.depth, 'depth', '');
    // 作者注释（AN 顶/底）：落点随 AN 设置（anInfo）——注入深度时与 @D 同落点，否则紧随主提示词（在全部聊天之前）
    if (pos === 2 || pos === 3) {
        const topBottom = pos === 2 ? '顶部' : '底部';
        const badge = pos === 2 ? 'AN↑' : 'AN↓';
        if (anInfo && Number(anInfo.position) === 1 /* IN_CHAT */) {
            const a = depthAnchorOf(anInfo.depth, 'an-depth', '');
            return { ...a, label: `世界书·作者注释（${topBottom}，随作者注释的注入深度 ${Number(anInfo.depth ?? ST_DEFAULT_DEPTH)} 落位）`, badge };
        }
        // 「主提示词前 / 后」：AN 由 `injectToMain` 插进 **main 那条消息**里（BEFORE_PROMPT→'start' 在 main 之前、
        // IN_PROMPT→'end' 在 main 之后）⇒ 顺序号 = main 的下标 ±0.5，再按 顶/底 微调（同一条消息内部的先后）。
        const mainRank = rankOfSection('main');
        const isBeforeMain = (anInfo && Number(anInfo.position) === 2 /* BEFORE_PROMPT */);
        const anOrd = mainRank === null ? null : mainRank + (isBeforeMain ? -0.5 : 0.5);
        const ord = anOrd === null ? null : anOrd + (pos === 2 ? -0.1 : 0.1);
        const after = (ord !== null && chatOrd !== null) ? ord > chatOrd : false;
        return {
            key: pos === 2 ? -20 : -19,
            ord, chatOrd: ord === null ? null : chatOrd,
            kind: pos === 2 ? 'an-top' : 'an-bottom', badge, after,
            mesid: after ? lastFloor : firstFloor,
            label: `世界书·作者注释（${topBottom}，紧随主提示词，${after ? '位于全部聊天消息之后' : '位于全部聊天消息之前'}）`,
        };
    }
    // ⚠️ 前置（position=0 → worldInfoBefore）与后置（position=1 → worldInfoAfter）**通常**都在 chatHistory 之前，
    //    但"谁在前、谁在后"完全由 prompt_order 决定（用户可拖动）——顺序号一律现取（orderSnap）；
    //    若被拖到 chatHistory 之后，`after` 为真 ⇒ mesid 改用**最后一条**待发送消息（见 sectionAnchor）。
    if (pos === 0) return sectionAnchor({ id: 'worldInfoBefore', legacyKey: 0, kind: 'wi-before', badge: '前置', text: '世界书·前置（↑Char，角色定义之前）' });
    if (pos === 1) return sectionAnchor({ id: 'worldInfoAfter', legacyKey: 10, kind: 'wi-after', badge: '后置', text: '世界书·后置（↓Char，角色定义之后）' });
    // 对话示例 顶/底：并进 `dialogueExamples` 区块（5 在前、6 在后），位置同样由顺序号给出
    if (pos === 5 || pos === 6) {
        const ord = rankOfSection('dialogueExamples', pos === 5 ? 0.1 : 0.2);
        const after = (ord !== null && chatOrd !== null) ? ord > chatOrd : false;
        return {
            key: pos === 5 ? 30 : 31,
            ord, chatOrd: ord === null ? null : chatOrd,
            kind: pos === 5 ? 'em-top' : 'em-bottom', badge: pos === 5 ? 'EM↑' : 'EM↓', after,
            mesid: after ? lastFloor : firstFloor,
            label: `世界书·对话示例（${pos === 5 ? '顶部' : '底部'}，${after ? '位于全部聊天消息之后' : '位于全部聊天消息之前'}）`,
        };
    }
    // 出口条的落点由 `{{outlet::名字}}` 宏出现的位置决定（可能在任意消息之间）→ 不给 mesid，显示层保留原文案
    if (pos === 7) return { key: 90000, kind: 'outlet', label: `世界书·出口（${entry.outletName || ''}）`, badge: 'Outlet' };
    return { key: 95000, kind: 'other', label: '世界书·其他位置', badge: '其他' };
}

// ── 「上下文顺序」的分组：序号推导 + 排序键 + 标题显示模型 ──
// 用户口径（第十三轮复查）：`tub-ctx-msg-main` 里只要 messageID，不要"世界书·前置（位于全部聊天消息之前）"
// 这类描述文案；凡是能定位到某条聊天消息的分组，就必须显示那条消息的 mesIDDisplay 序号。
// 位置事实（据 ST 源码）：**区块先后完全由 prompt_order 决定**（`openai.js` 用 prompt 集合下标落位），
// 所以"前置/后置/AN/EM 全都在 chatHistory 之前"只是**默认顺序**下的结果，不是规矩：
//   · 区块（前置 / 后置 / AN / EM）→ 顺序号取自发送时刻的顺序快照（`anchor.ord`）；若该区块被拖到
//     chatHistory 之后，`anchor.after` 为真 ⇒ 它对应**最后一条**待发送消息，否则对应**第一条**。
//   · 深度注入 → 插到哪条消息之前就是哪条（`anchor.mesid`）。
//   · 末尾（depth 0）→ 在**最后一条**待发送消息之后。
// 旧锚点没有结构字段时，用入参 edges（由当前聊天推得的首/末条序号）兜底，所以旧锚点也能立刻显示序号；
// 只有确实定不出序号时才回退原文案（未匹配条目、出口条目、更早的旧格式锚点）。
// 解释性文字（在哪条消息之前/之后、消息归属）挂在行的 title 上，悬停可见，不占主视野。
const CTX_ANCHOR_BEFORE_KINDS = ['depth-top', 'an-depth', 'wi-before', 'wi-after', 'an-top', 'an-bottom', 'em-top', 'em-bottom'];
const CTX_ANCHOR_AFTER_KINDS = ['depth-end'];
const CTX_ANCHOR_RELATION = {
    'depth-top': '世界书深度注入（顶部：在所有聊天消息之前）',
    'depth-end': '世界书深度注入（末尾：在所有聊天消息之后）',
    'an-depth': '世界书·作者注释（随作者注释的注入深度落位）',
    'wi-before': '世界书·前置（↑Char，角色定义之前）',
    'wi-after': '世界书·后置（↓Char，角色定义之后）',
    'an-top': '世界书·作者注释（顶部，紧随主提示词）',
    'an-bottom': '世界书·作者注释（底部，紧随主提示词）',
    'em-top': '世界书·对话示例（顶部）',
    'em-bottom': '世界书·对话示例（底部）',
};

// 区块"在全部聊天消息之前 / 之后"的说明：以锚点里的 after 为准（顺序可能被用户改过，见 entryContextAnchor）；
// 旧锚点没有 after → 返回空串（沿用 kind 自带文案，行为不变）
function contextAnchorPlace(anchor) {
    if (anchor?.after === true) return '位于全部聊天消息之后';
    if (anchor?.after === false) return '位于全部聊天消息之前';
    return '';
}

// 该分组"对应哪条聊天消息"（mesIDDisplay 序号）；定不出则 null（纯函数）
function contextAnchorMesid(anchor, edges) {
    const kind = anchor?.kind;
    if (Number.isFinite(anchor?.mesid)) return Number(anchor.mesid);
    if (kind === 'depth') {
        // 旧锚点：label 形如"在聊天 #5 之前插入（用户消息 · User）"
        const m = /#(\d+)/.exec(String(anchor?.label || ''));
        if (m) return Number(m[1]);
    }
    if (CTX_ANCHOR_BEFORE_KINDS.includes(kind) && Number.isFinite(edges?.first)) return Number(edges.first);
    if (CTX_ANCHOR_AFTER_KINDS.includes(kind) && Number.isFinite(edges?.last)) return Number(edges.last);
    return null;
}

// 显示顺序键（纯函数）：**不看锚点里存下的 key**——旧锚点的 key 是旧方案（后置=1、深度=100+b），
// 会把"后置"排到深度注入前面，正是用户看到的 `#0 → #5 → #2 → #5`。
// 新锚点按**本次发送时的真实提示词顺序**推导（发送时刻写进锚点，见 entryContextAnchor）：
//   区块（前置/后置/AN/EM）→ ord = 区块在 prompt 集合里的下标（0,1,2…）
//   深度注入 / AN@depth   → 落在 chatHistory 区间内部：chatOrd + 归一化序号 ∈ (chatOrd, chatOrd+1)
//   末尾（depth 0）       → chatOrd + 1 − ε（同区间内但排在最靠后）
//   出口 / 位置未知        → 90000 / 95000（一律排到最后）
// 旧锚点（无 ord/chatOrd）逐字节回退旧固定键：
//   作者注释(-20/-19) < 前置(0) < 后置(10) < 对话示例(30/31) < 深度注入(1000+mesid) < 出口/其他 < 更早的旧格式(20000+)
const CTX_ANCHOR_SECTION_KEYS = { 'an-top': -20, 'an-bottom': -19, 'wi-before': 0, 'wi-after': 10, 'em-top': 30, 'em-bottom': 31 };
const CTX_ANCHOR_DEPTH_KINDS = ['depth', 'depth-top', 'an-depth', 'depth-end'];

// 深度注入在 chatHistory 区间内的归一化位置 ∈ (0,1)：严格随"插到哪条消息之前"递增。
// edges = 当前聊天推得的首/末条待发送消息序号（取不到 → 0.5 兜底）。
// ⚠️ 不用 Number() 强转锚点字段：null 会被转成 0 而误判成"有限数"。
function contextAnchorDepthFraction(kind, mesid, edges) {
    const first = Number(edges?.first);
    const last = Number(edges?.last);
    const hasEdges = Number.isFinite(first) && Number.isFinite(last) && last >= first;
    if (kind === 'depth-end') return hasEdges ? 1 - 0.5 / (last - first + 2) : 1 - 1e-6;
    if (!hasEdges) return 0.5;
    const m = Number.isFinite(mesid) ? Math.min(Math.max(Number(mesid), first), last) : first;
    return (m - first + 1) / (last - first + 2);
}

function contextAnchorOrderKey(anchor, mesid, edges = null) {
    const kind = anchor?.kind;
    // 深度注入：带 chatOrd ⇒ 新方案（落在 chatHistory 区间内）；否则回退旧键
    if (CTX_ANCHOR_DEPTH_KINDS.includes(kind)) {
        const chatOrd = anchor?.chatOrd;
        if (Number.isFinite(chatOrd)) return chatOrd + contextAnchorDepthFraction(kind, mesid, edges);
        return 1000 + (Number.isFinite(mesid) ? Number(mesid) : 0) + (kind === 'depth-end' ? 0.5 : 0);
    }
    if (kind === 'outlet') return 90000;
    if (kind === 'other') return 95000;
    const ord = anchor?.ord;
    if (Number.isFinite(ord)) return ord;                                       // 新方案：本次发送的真实顺序号
    if (kind in CTX_ANCHOR_SECTION_KEYS) return CTX_ANCHOR_SECTION_KEYS[kind];  // 旧锚点：旧固定键
    // 更早的旧格式（没有 kind，只有存下的 key = 1000+槽位序号）：整体放到"未知位置"区，保留相对次序
    return 20000 + (Number(anchor?.key) || 0) % 10000;
}

// 标题显示模型：`{ badge, title, tooltip }`（title 为空串 = 调用方只渲染徽标；badge 就是聊天里的 `#N`）
function contextAnchorView(anchor, edges) {
    const kind = anchor?.kind;
    const mesid = contextAnchorMesid(anchor, edges);
    if (mesid !== null) {
        let tooltip;
        if (kind === 'depth') {
            // 归属说明：新锚点用结构字段 who/name；旧锚点从 label 的括号里取
            let who = anchor.who || '';
            let name = anchor.name || '';
            if (!who) {
                const inner = /（(.+)）/.exec(String(anchor.label || ''))?.[1] || '';
                const m2 = /^(.+?)消息(?:\s*·\s*(.+))?$/.exec(inner);
                if (m2) { who = m2[1]; name = name || (m2[2] || ''); }
            }
            const nm = name ? ` · ${name}` : '';
            tooltip = `世界书深度注入：插到聊天消息 #${mesid} 之前${who ? `（${who}消息${nm}）` : ''}`;
        } else if (kind === 'an-depth') {
            tooltip = `世界书·作者注释（${anchor.badge || ''}）：随作者注释的注入深度落位，插到聊天消息 #${mesid} 之前`;
        } else {
            const rel = CTX_ANCHOR_RELATION[kind] || '世界书注入';
            const place = contextAnchorPlace(anchor);
            tooltip = `${rel}${place ? `：${place}` : ''}（对应聊天消息 #${mesid}）`;
        }
        return { badge: `#${mesid}`, title: '', tooltip };
    }
    // 定不出序号（未匹配条目 / 出口条目 / 更早的旧格式锚点）：保留原文案，不显示空白
    return { badge: anchor?.badge || '', title: anchor?.label || '', tooltip: '' };
}

// 供「上下文顺序」用的"位置基准"：由**当前聊天**推出待发送消息的序号数组、首/末条、每条的"前一条"、每条的 role。
// model.index = 该锚定对应的消息下标（模拟锚定为 'sim'）；genType 影响 swipe 是否排除最后一条。
// 取不到（无聊天/空聊天）时返回 null，调用方回退原文案。
// prev：Map<floor, 前一条的 floor|null> —— 深度注入夹在"前一条"与"该条"之间，两侧的 messageID 都要标出来
//       （用户口径：只要某条消息的前/后**紧邻**有世界书条目，就必须显示它的 messageID）。
// roleOf：Map<floor, 'user'|'AI'> —— 标记行右侧显示该消息的 role（用户口径 §2.24-R5，替代原来的条目数）。
function contextSendableEdges(model) {
    try {
        const chat = getContext?.()?.chat;
        if (!Array.isArray(chat) || !chat.length) return null;
        const idx = model?.index;
        const end = (typeof idx === 'number' && idx >= 0 && idx < chat.length) ? idx + 1 : chat.length;
        const sendable = computeSendableChat(chat.slice(0, end), model?.genType);
        if (!sendable.length) return null;
        const floors = sendable.map(m => m.floor);
        const prev = new Map();
        const roleOf = new Map();
        sendable.forEach((m, i) => {
            prev.set(m.floor, i > 0 ? floors[i - 1] : null);
            roleOf.set(m.floor, m.isUser ? 'user' : 'AI');
        });
        return { first: floors[0], last: floors[floors.length - 1], prev, roleOf };
    } catch (e) {
        Logger.debug('【统计】推导上下文序号兜底失败:', e);
        return null;
    }
}

// 判定一条最终消息（槽位）的来源：'wi-before' | 'wi-after' | 'wi-depth' | 'wi-block' | 'chat' | 'other'。
//   · identifier 是 ST 侧确定的来源标识；但深度注入与前置/后置世界书都会落进 chatHistory-N，
//     所以不能只看标识——再用"该槽位被世界书命中的覆盖比例 + 命中条目是否都来自世界书位置(0/1/4)"兜底判定。
//   · ownClaimed/tokens = 该槽位被世界书命中量占比；matchedPositions = 该槽位命中条目的 position 集合。
//   · depthSlotTokens（可选）= ST 侧在同一 depth+role 注入槽里**属于世界书条目**的渲染体积合计；
//     提供时可区分"槽位内容全是世界书（只是文本匹配不全）"与"槽位还混着第三方文本"（D2′）。
// 返回 'wi-before'/'wi-after'/'wi-depth'/'wi-block'（世界书内容与其它文本混在同一条消息里）/'chat'/'other'。
// 纯函数，便于单测。
const WI_SLOT_COVERAGE = 0.5;
// 聊天槽位的容忍上限（仅用于"已知标识 + 本身就是聊天角色"的槽位，不参与属主判定）：
// 只有当命中的世界书内容几乎占满整条消息时才例外（D3′）。
const WI_CHAT_SLOT_COVERAGE = 0.9;
// 世界书位置：0=前置 1=后置 4=@D 深度注入
function isWorldInfoPosition(p) { return p === 0 || p === 1 || p === 4; }
// 「全部命中都来自世界书位置」——用于识别被 squash/合并的槽位（D1）
function allHitsFromWorldInfo(matchedPositions) {
    return Array.isArray(matchedPositions) && matchedPositions.length > 0
        && matchedPositions.every(isWorldInfoPosition);
}

// 属于「世界书」来源的槽位类型（classifyPromptSlot 取值的一个子集）：供「完整上下文」判断某条消息
// 要不要给出「世界书条目来源」子弹窗（CHANGELOG §2.30）。纯函数，便于单测。
const WI_SLOT_KINDS = ['wi-before', 'wi-after', 'wi-depth', 'wi-block', 'wi-merged'];
function isWiKind(kind) { return WI_SLOT_KINDS.includes(kind); }

// 一条快照消息的「来源」文案 / 全称（第三十五轮抽出为模块级纯函数）：
//   · 世界书来源 → 一律显示「世界书」（第二十八轮口径⑥）；全称（世界书·前置 · worldInfoBefore）进 title；
//   · 其它来源 → `来源 · identifier`。
// 目的：**上下文目录**的项头（`.hco-src`）与**「条目来源」子窗**的头部（`.hc-msg-kind`）显示同一串文字
// （用户口径⑪要求两者保持一致），所以文案只能有一处实现。
function ctxSourceFullText(m) {
    const label = CONTEXT_KIND_LABELS[m?.kind] || m?.kind || '';
    return `${label}${m?.identifier ? ` · ${m.identifier}` : ''}`;
}
function ctxSourceTextOf(m) {
    return isWiKind(m?.kind) ? '世界书' : ctxSourceFullText(m);
}
// 世界书来源才给 title（其余来源文案本身就是全称，不需要）
function ctxSourceTitleAttr(m) {
    if (!isWiKind(m?.kind)) return '';
    const full = ctxSourceFullText(m);
    return full ? ` title="${escapeHtmlText(full)}"` : '';
}

// 由"命中本槽的 position=4 条目"反推该槽所属的 depth+role 注入组，再取该组世界书条目体量合计。
//   · 为什么不用 chatHistory-N 推 depth：实测（受控浏览器探针，见审查文档 §十二）N 是"自上而下第 N 条"
//     的顺序号，会随注入条数/预算裁剪漂移，**与 depth 没有稳定对应**；用它查表会查错组。
//   · 内容推导：ST 只把**同 depth+role** 的世界书条目并进同一条消息，所以命中同一槽的 @D 条目必然同组；
//     出现两个不同组即说明该槽被别的来源也写了东西 → 返回 null（缺证据，不做 D2′ 判定）。
// 纯函数，便于单测。
function parseIntOrNull(value) {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : null;
}
// ST 的折算口径（`script.js:8926-8934` `Number(role ?? SYSTEM)`）+ 运行时枚举（world-info.js 的
// extension_prompt_roles：0=system / 1=user / 2=assistant）。**必须与 ST 一致**，否则分组键会撞车：
//   · 数字与数字字符串（"1"/"01"/" 1 "/0x1…）在 ST 侧等价（同一个 Number()）→ 这里也等价；
//   · null / undefined → ST 用 SYSTEM(0)；
//   · 非数字（'user'/'AI'/对象…）→ ST 侧 Number() 得 NaN，`getExtensionPrompt` 的数字严格比较
//     （`script.js:3309-3315`）会把该注入**整条过滤掉**（内容根本不在上下文里）→ 这里给一个不会并进
//     任何真实角色组的独立键，避免"并不存在的体量"抬高 win、反过来误关混槽护栏/救援（第三轮审查 D-反例）。
function normalizedSlotRole(role) {
    if (role === null || role === undefined) return 'system';
    if (typeof role === 'symbol') return 'x:symbol';
    const n = Number(role);
    if (n === 0) return 'system';
    if (n === 1) return 'user';
    if (n === 2) return 'assistant';
    if (Number.isFinite(n)) return `num:${n}`;   // 其它数字（3 / -1 …）在 ST 侧同样不会被注入
    return `x:${String(role).slice(0, 24)}`;      // 非数字 → 独立键
}
// ST 侧默认深度（`world-info.js:96 DEFAULT_DEPTH = 4`）：`entry.depth ?? DEFAULT_DEPTH`（5205/5236）
const ST_DEFAULT_DEPTH = 4;
// 深度注入的分组键 `${depth}::${role}`。depth 只在**有限数字**时才真实可注入：
//   · null/undefined → ST 用 DEFAULT_DEPTH；
//   · 字符串/其它 → ST 会把原始值写进 `customDepthWI_*` 与 injection_depth，最终在
//     `populationInjectionPrompts`（openai.js:820-822）的 `injection_depth === i` 过滤中被丢掉 →
//     给独立键，避免与真实 depth 组撞车（第三轮审查 D-反例）。
function depthGroupKeyOfEntry(entry) {
    const raw = entry?.depth;
    const d = (raw === null || raw === undefined) ? ST_DEFAULT_DEPTH : raw;
    // ⚠️ 与调用侧必须用**同一口径**：ST 侧 `setExtensionPrompt(..., Number(depth), ...)`（script.js:8930）
    // + `getExtensionPrompt` 的数字严格相等（3309-3315）→ 只有 Number() 有限的值才真能注入；
    // 'abc'/NaN/Infinity → 该注入被整条丢弃，给它独立键（否则会把"不在上下文里"的体量算进真实 depth 组，
    // 抬高 win、反过来关掉混槽护栏与 D5 救援——第四轮审查 P2-3 的复现用例）。
    // 注意：数字字符串 '4' 在 ST 侧等价于 4，这里也必须等价（不能用 typeof 判数字）。
    const n = Number(d);
    const dk = Number.isFinite(n) ? String(n) : 'x';
    return `${dk}::${normalizedSlotRole(entry?.role)}`;
}
function depthGroupKeyOf(hitDepthKeys) {
    if (!Array.isArray(hitDepthKeys) || !hitDepthKeys.length) return null;
    const uniq = new Set(hitDepthKeys.filter(k => typeof k === 'string' && k));
    return uniq.size === 1 ? [...uniq][0] : null;
}
// 槽位是否"世界书内容 + 别的来源"混在同一条消息里（D2′ 判定，纯函数）。
//   win     = 该槽所属 depth+role 注入组里"世界书条目体量"合计（由命中条目反推）
//   tokens  = 整槽 token
//   claimed = 本槽被世界书精确命中的 token
// 判定思路（只认"结构上互补"的证据，宁可少改判）：
//   ① win ≥ tokens → 世界书体量已能填满整槽，不存在多余来源（含渲染/分词差异）→ 纯世界书槽；
//   ② claimed 没到 win 的 SLOT_MIX_MATCH_RATIO → 世界书自己都还没匹配全，差额可能只是匹配不全 → 不改判；
//   ③ 其余情况（claimed 已覆盖 win，但槽位明显比世界书体量大）→ 超出部分只能来自别的来源 → 混入。
const SLOT_MIX_MATCH_RATIO = 0.9;       // claimed 至少要覆盖 win 的 90%，才谈得上"世界书已匹配全"
const SLOT_MIX_FILL_TOLERANCE = 0.05;   // 整槽口径的 5%：小于此的差额视为渲染/分词抖动
const SLOT_MIX_MIN_TOKENS = 5;          // 绝对下限：只有几 token 的差额不够当证据
function isSlotMixed(win, tokens, claimed) {
    const total = Number(tokens) || 0;
    const own = Number(win) || 0;
    const hit = Number(claimed) || 0;
    if (own <= 0 || total <= 0) return false;           // 没有结构证据 → 不改判
    if (own >= total) return false;                      // 世界书体量已能填满整槽 → 纯世界书槽
    if (hit < own * SLOT_MIX_MATCH_RATIO) return false;  // 世界书尚未匹配全 → 差额可能是匹配不全，不改判
    return (total - own) > Math.max(total * SLOT_MIX_FILL_TOLERANCE, SLOT_MIX_MIN_TOKENS);
}

// 混槽救援判定（覆盖比例低于阈值时的第二证据）。用途：槽被第三方文本"稀释"到普通阈值之下
// （非聊天槽 <50%，聊天槽 <90%）时，不再整槽丢弃/计入其他，而是"只认世界书命中量、其余归回原角色"。
// 与 isSlotMixed 的区别：不要求整槽口径的 5% 容差（救援场景的第三方小尾巴可能恰好 ≤5%），
// 改用绝对下限；其余条件（命中量盖住 win 的 90%）一致。纯函数，便于单测。
const SLOT_MIX_RESCUE_MIN_TOKENS = 2;
function isSlotRescueMerged(win, tokens, claimed) {
    const total = Number(tokens) || 0;
    const own = Number(win) || 0;
    const hit = Number(claimed) || 0;
    if (own <= 0 || total <= 0) return false;
    if (hit < own * SLOT_MIX_MATCH_RATIO) return false;
    return (total - own) > SLOT_MIX_RESCUE_MIN_TOKENS;
}
function classifyPromptSlot({ identifier, isChat, isChatFloor, isIdentityFloor, tokens, ownClaimed, matchedPositions, depthSlotTokens, wiBlockTokens, hasForeignText }) {
    const id = identifier;
    // 结构身份优先（第六轮审查 P2-4）：`chatHistory-N` 经结构预测确认为**真实聊天楼层**时直接归「聊天」。
    // 与文本内容无关 → "聊天照抄条目正文（D3′/S6）"不再需要内容相似度取舍；NARRATOR 等 system 角色的
    // 真实楼层也不会再被误判成世界书/其他。未提供（null/undefined）时沿用下面的内容启发式。
    if (isIdentityFloor === true) return 'chat';
    // 前置/后置世界书槽：标识本身就是 ST 侧确定的来源，通常整槽计入世界书。
    // D6（第三轮审查）：但 squash_system_messages 会把相邻 system 槽合并、**沿用首条标识**——
    // 实测 main_prompt 为空（ST 默认值；用户配置实测也是空串）时 squash 会强制跳过空 system 槽，
    // 存活者变成 worldInfoBefore，于是角色卡描述/人设/场景/NSFW 等**非世界书内容**被按标识整块算进「世界书」。
    // 护栏与 D1 同源（内容证据优先于标识）：**槽内确有命中之外的内容**（hasForeignText）且
    // 世界书自己已被匹配全（claimed ≥ 0.9×本块体量）、槽位明显比本块体量大 → 只认命中量（wi-merged）。
    // hasForeignText 为 false（命中区间之外只有空白/换行）时**不改判**：纯槽里的条目间空行不算别的来源，
    // 否则多条目块的连接空白会把纯槽误判成混合槽（少算）。undefined/null = 未提供该证据 → 沿用旧行为。
    // 代价（与 D1 一致）：合并槽里"比世界书多出来的部分"（wi_format 包装串、并入的其它提示词）会落进「其他」，
    // 不再算作世界书——宁可少算包装，也不想把别人的文本算成世界书。
    if (id === 'worldInfoBefore' || id === 'worldInfoAfter') {
        const kind = id === 'worldInfoBefore' ? 'wi-before' : 'wi-after';
        if (typeof wiBlockTokens === 'number' && wiBlockTokens > 0 && hasForeignText !== false
            && isSlotMixed(wiBlockTokens, tokens, ownClaimed)) return 'wi-merged';
        return kind;
    }
    if (typeof id === 'string' && id.startsWith('customDepthWI_')) return 'wi-depth';
    const cov = tokens > 0 ? ownClaimed / tokens : 0;
    const fromDepth = Array.isArray(matchedPositions) && matchedPositions.length > 0
        && matchedPositions.every(p => p === 4);
    // 槽位里属于世界书条目的渲染体积（ST 侧注入表交叉验证；无此信息时为 null）
    const win = (typeof depthSlotTokens === 'number' && depthSlotTokens >= 0) ? depthSlotTokens : null;
    // ① 匿名槽（对齐失败/第三方插入）或 chatHistory-N（深度注入在最终消息上的标识）：靠覆盖比例 + 命中位置判定
    if (id === null || id === undefined || (typeof id === 'string' && id.startsWith('chatHistory-'))) {
        // D3′：聊天消息默认算聊天，只有"整条基本就是世界书条目文本且命中全来自世界书位置"时才例外
        // （命中 ≥ WI_CHAT_SLOT_COVERAGE、全来自 0/1/4）。改前是 0.5 覆盖就劫走，聊天照抄条目正文
        // 会被整条算成世界书（实测 E3c 误报 +17）；这里把门槛抬到 0.9 并限定命中位置。
        if (isChat) {
            // D5：注入型聊天槽救援（isChatFloor === false = 已确认"不是真实聊天楼层"）。
            // 深度注入若被分配了 user/assistant 角色，第三方文本混入后覆盖会跌破 0.9，
            // 原逻辑会把整条世界书内容判成「聊天」（实测 A/B/C/T8 漏计 29~34）。
            // 救援条件与 wi-merged 一致：只认命中量，其余归回「聊天」；真实聊天楼层不救援（保住 D3′ 防照抄）。
            if (isChatFloor === false && win !== null && allHitsFromWorldInfo(matchedPositions)
                && isSlotRescueMerged(win, tokens, ownClaimed)) return 'wi-merged';
            if (cov >= WI_CHAT_SLOT_COVERAGE && allHitsFromWorldInfo(matchedPositions)) return 'wi-block';
            return 'chat';
        }
        if (cov >= WI_SLOT_COVERAGE && fromDepth) {
            // D2′：槽内混入其它扩展文本（ST-PT/JSR/LWB 与 @D 世界书被并进同一条消息）——
            // 判定依据是"世界书条目体量（win）撑不起这一整槽、而世界书自己已被匹配全"——
            // 两者互相印证才认定混入。只认命中量、其余交还原角色，避免两个方向的翻转
            // （整槽判成世界书 / 第三方文本算成世界书）。win 为 null（命中条目不属于同一注入组）
            // = 缺结构证据，保持原判定。
            if (win !== null && isSlotMixed(win, tokens, ownClaimed)) return 'wi-merged';
            return 'wi-depth';
        }
        if (cov >= WI_SLOT_COVERAGE) return 'wi-block';
        // D5：低于阈值但结构证据成立（命中已盖住 win、整槽又更大）→ 混槽只认命中量。
        // 原先整槽掉进「其他」（实测 S5 型漏计 12）；win 为 null 或缺证据时不改判（保守）。
        if (win !== null && allHitsFromWorldInfo(matchedPositions)
            && isSlotRescueMerged(win, tokens, ownClaimed)) return 'wi-merged';
        return 'other';
    }
    // ② 已知标识 + 聊天消息：走不到这里（上面已把聊天槽全部排除）；保留判定只为可读性
    if (isChat) return 'chat';
    // ③ 已知标识 + 非聊天（预设/角色卡等）：squash_system_messages 会把相邻 system 槽
    //    （main + worldInfoBefore + worldInfoAfter + charDescription …）合并成一条并沿用首条标识，
    //    世界书整块会藏在标识为 main 的槽里 → 命中全来自世界书位置且覆盖够高时判为世界书（D1）。
    //    P2-5（第六轮交叉验证）：这条"覆盖过半"分支只凭"命中过 0/1"就放行并不安全——
    //    世界书块仍在自己标识槽里（squash 关闭）时，别处"照抄 ≥50% 条目正文"同样会命中 0/1，
    //    于是同一段文本被双重计数（自身槽整块 + 照抄槽命中量，实测 wi=2×）。
    //    护栏与 P1-1 同源：命中里若含 0/1（前置/后置块），必须证明"该块已被 squash 合并掉"
    //    （wiBlockTokens>0 ⇔ 块自己的标识槽在本请求里已不存在、且命中已盖住块体量）才可改判；
    //    命中只来自 @D(4) 的槽不受此门控影响（wiBlockTokens 为 null 属正常）。
    //    残余（已登记）：块确被合并掉时（wiBlockTokens>0），槽内"真照抄"仍无法与"并入内容"区分；
    //    标识对齐失败（identifier=null，走分支①）时同样不经过此门控。
    if (allHitsFromWorldInfo(matchedPositions) && cov >= WI_SLOT_COVERAGE) {
        const citesBlock = Array.isArray(matchedPositions) && matchedPositions.some(p => p === 0 || p === 1);
        const blockMergedAway = typeof wiBlockTokens === 'number' && wiBlockTokens > 0;
        if (!citesBlock || blockMergedAway) return 'wi-merged';
    }
    // P1-1：squash 合并槽——世界书那一块被并进这条消息（标识沿用 main 等），上面"覆盖过半"这条线
    // 在角色卡/预设占多数时会失手（实测 main 2269t 里含 623t 世界书 → cov 27% → 整块掉进「其他」）。
    // wiBlockTokens 只在"命中全来自被合并掉的前置/后置块"时才非 null（见 slotInputs）：块自己的
    // 标识槽在本请求里已不存在（= 确实被 squash 合并了），配合"命中已盖住该块体量 + 整槽明显更大"
    // 就只认命中量、其余交还原角色（与 D1/D2′ 的 wi-merged 同义）。squash 关闭时块还在自己槽里，
    // 该值恒为 null → 这条救援不会触发（不会把"别处照抄条目文本"算成世界书）。
    if (typeof wiBlockTokens === 'number' && wiBlockTokens > 0
        && isSlotRescueMerged(wiBlockTokens, tokens, ownClaimed)) return 'wi-merged';
    return 'other';
}

// 纯函数：按来源槽位归因。
//   slots           = [{ tokens, isChat, identifier }]（按发送顺序）
//   slotKind[i]     = classifyPromptSlot 的结果
//   entries         = [{ key, position, depth, role, weight, name, book, type, uid }]（后四项只供下层展示用）
//   entryMatchToken = Map<key, Map<slotIdx, tokens>>（条目在槽位的精确命中量；weight 用于余量分摊）
// 返回 { wi, chat, perEntry: Map<key, tokens>, perSlotEntries: Map<slotIdx, Map<key, tokens>> }。
//   perSlotEntries 与 perEntry **同源同值**，只是按槽位保留明细：供「完整上下文」逐条列出该消息的
//   世界书条目来源（左侧子弹窗，CHANGELOG §2.30）。
// 世界书槽位通常整条计入 wi，并在其"归属条目组"内把 token 分成 精确命中 + 余量按 weight 加权；
// 唯一的例外是 kind='wi-merged'（同一条消息里既有世界书内容又混着第三方文本，D1/D2′）：
// 只把"被世界书命中的部分"计入 wi，其余按原角色归回 chat/other，避免把第三方文本算成世界书。
// 无归属条目的世界书槽位仍整条计入 wi（由调用方补差额到明细）。
function attributeSlotsBySource({ slots, slotKind, entries, entryMatchToken }) {
    const byKey = new Map(entries.map(e => [e.key, e]));
    const perEntry = new Map(entries.map(e => [e.key, 0]));
    const matchedKeysInSlot = (idx) => entries
        .filter(e => (entryMatchToken.get(e.key)?.get(idx) || 0) > 0)
        .map(e => e.key);
    const posGroupKeys = (pos) => entries.filter(e => e.position === pos).map(e => e.key);
    const weightOf = (k) => {
        const w = byKey.get(k)?.weight;
        return (typeof w === 'number' && w > 0) ? w : 1;
    };
    // 槽位里"属于世界书"的 token 量与其余量的归属（余量挂到与原槽同角色的栏位：
    // 聊天槽回到 chat，其余（含 system 角色的混合槽）回到 other）
    const contentInfo = (idx) => {
        const slot = slots[idx];
        const theKind = slotKind[idx];
        if (theKind !== 'wi-merged') return { wiTokens: slot.tokens, rest: 0, restTo: null };
        const claimed = Math.min(slot.tokens, Math.max(0, slotOwnClaimedOf(idx)));
        return { wiTokens: claimed, rest: Math.max(0, slot.tokens - claimed), restTo: slot.isChat ? 'chat' : 'other' };
    };
    const slotOwnClaimedOf = (idx) => matchedKeysInSlot(idx)
        .reduce((sum, k) => sum + (entryMatchToken.get(k)?.get(idx) || 0), 0);
    // 槽位 → 条目组：用于把"世界书那一部分"分摊到条目明细
    const groupOf = (idx, kind) => {
        if (kind === 'wi-before') return posGroupKeys(0);
        if (kind === 'wi-after') return posGroupKeys(1);
        const matchedKeys = matchedKeysInSlot(idx);
        // 混合槽（squash 合并 / 同槽混入）：本槽命中哪些条目，就在这些条目之间分摊——
        // 若按"命中条目的 position 归纳一个组"，另一 position 的命中量会被漏掉（明细会偏向一侧）。
        if (kind === 'wi-merged' && matchedKeys.length) return matchedKeys;
        if (matchedKeys.length) {
            const mp = byKey.get(matchedKeys[0])?.position;
            const md = byKey.get(matchedKeys[0])?.depth;
            const mr = byKey.get(matchedKeys[0])?.role;
            return entries
                .filter(e => e.position === mp && (mp !== 4 || (e.depth === md && e.role === mr)))
                .map(e => e.key);
        }
        return entries.filter(e => entryMatchToken.get(e.key)?.has(idx)).map(e => e.key);
    };
    let wi = 0, chat = 0;
    // 逐槽的条目分摊（键 = 槽位数组下标，与 entryMatchToken 的键同口径）
    const perSlotEntries = new Map();
    slots.forEach((slot, idx) => {
        const kind = slotKind[idx];
        if (kind === 'chat') { chat += slot.tokens; return; }
        if (kind === 'other') return;
        const content = contentInfo(idx);
        wi += content.wiTokens;
        if (content.rest > 0 && content.restTo === 'chat') chat += content.rest;
        const group = groupOf(idx, kind);
        if (!group.length) return;
        let matchedSum = 0, wSum = 0;
        for (const k of group) {
            matchedSum += entryMatchToken.get(k)?.get(idx) || 0;
            wSum += weightOf(k);
        }
        const remainder = Math.max(0, content.wiTokens - matchedSum);
        const slotMap = new Map();
        for (const k of group) {
            const w = weightOf(k);
            const t = (entryMatchToken.get(k)?.get(idx) || 0) + remainder * (w / wSum);
            perEntry.set(k, (perEntry.get(k) || 0) + t);
            if (t > 0) slotMap.set(k, t);
        }
        if (slotMap.size) perSlotEntries.set(idx, slotMap);
    });
    return { wi, chat, perEntry, perSlotEntries };
}

// 计算"实际发送"的完整统计（总量 + 世界书条目归因）
// 口径（三者相加恒等于总计，避免自相矛盾）：
//   总上下文 = 所有最终消息 token 之和
//   世界书   = ST 用来源槽位确定注入的整块内容（worldInfoBefore/After + 各深度注入 @D），**整条计入、不限消息角色**
//   聊天     = 其余聊天消息（user/assistant）整条
//   其他     = 总上下文 − 世界书 − 聊天（预设、角色卡描述等非聊天、非世界书内容）
//
// 关键点①：世界书条目可携带自己的 role 注入到指定深度（openai.js 的 getPromptRole），
// 因此最终上下文里会出现 role=user/assistant 的世界书消息。绝不按 role 判定来源——
// 判定"是不是世界书"用来源槽位（classifyPromptSlot），深度注入即便命名为 chatHistory-N 也能被识别。
// 关键点②：文本匹配（findEntrySpans）不再决定"世界书总计"，只用于 ① 判定深度注入槽位
// ② 把世界书槽位内的 token 分摊到条目明细；匹配不到的余量按条目体积加权分摊，
// 从而"世界书内容漏匹配"不会再掉进「其他」（消除 §2.15 前把世界书残余标成「深度注入」的矛盾）。
//
// options.chatSnapshot = 本次发送时的聊天快照（含触发发送的消息，供楼层对齐）；
// options.genType = 本次生成类型（swipe 需要排除最后一条）。
// options.identifiers = alignPromptIdentifiers 的结果（与 messages 等长，见其注释）；null = 放弃来源识别（槽位标识记 null，退回内容证据判定）。
// options.entries = 本次统计使用的世界书条目集快照（由调用方在事件时刻捕获、随任务携带）；
//    缺省时退回模块级 lockedScanEntries（审计装置等旧调用方兼容）。统计已改为串行队列（P4-6），
//    排队等待期间模块级变量可能被后续请求改写，故队列路径必须显式传入。
async function computeRenderedStats(messages, options = {}) {
    const startedAt = Date.now();
    // 进入统计即消费掉"切换聊天"判废标记：本函数运行期间若发生 CHAT_CHANGED，
    // 会把 statsClearedAt 更新为 > startedAt，后续检查即可正确丢弃本次结果。
    statsClearedAt = 0;
    // 本次归因使用的条目集：优先取任务携带的快照（见 options.entries 说明）。
    const scanEntries = Array.isArray(options.entries) ? options.entries : lockedScanEntries;
    // 上次运行的完整上下文快照先清空：失败/中断时不留下过期内容（消费方只在 await 返回后立即读取）。
    lastContextDump = null;
    const stats = { total: 0, chat: 0, system: 0, other: 0, wi: 0, at: startedAt, wiDetailedStats: {} };
    const slots = [];
    const identifiers = Array.isArray(options.identifiers) && options.identifiers.length === messages.length
        ? options.identifiers
        : null;
    // 结构身份（第六轮审查 P2-4）：Array<'floor'|'injection'|null>，与 identifiers 在同一次采样里产出
    // （见 capturePromptIdentifiers / alignPromptKinds）。null = 预测不可用 → 全部回退内容启发式（同改前行为）。
    const kinds = Array.isArray(options.kinds) && options.kinds.length === messages.length
        ? options.kinds
        : null;

    let slotIndex = 0;
    for (const msg of messages) {
        const tokens = await countFinalMessageTokens(msg);
        const isChat = msg?.role === 'user' || msg?.role === 'assistant';
        stats.total += tokens;
        // 每条消息都作为归因槽位参与世界书匹配（含 user/assistant，防止深度注入被漏判）。
        // identifier 语义：字符串 = ST 组装的消息标识；null = 第三方插入（未对齐）；
        // undefined = 本次未取得对齐数据（整栏拆解不显示）。
        slots.push({
            text: getMessageSearchText(msg).replace(/\r/g, ''),
            claimed: [],
            tokens,
            isChat,
            role: msg?.role || 'system',
            index: slotIndex, // 消息在上下文中的先后序号（0 起），用于"上下文顺序"排序
            identifier: identifiers ? (identifiers[slotIndex] ?? null) : undefined,
        });
        slotIndex++;
    }

    // ===================== 归因：按「来源槽位」（CHANGELOG §2.16，方案 A）=====================
    // 口径（三者相加恒等于总计，且不再自相矛盾）：
    //   世界书 = ST 用**来源槽位**确定注入的整块内容：
    //            · identifier = worldInfoBefore / worldInfoAfter 的槽位（position 0/1 的世界书）
    //            · 深度注入槽位：identifier = customDepthWI_* / customWIOutlet_*，
    //              或最终上下文里"来自 position=4 条目、且内容被世界书覆盖 ≥ 阈值"的那条消息
    //   聊天   = 其余聊天消息（role=user/assistant）整条
    //   其他   = 总上下文 − 世界书 − 聊天
    // 文本匹配（findEntrySpans）现在只用于两件事：① 判定某个槽位是不是世界书深度注入；
    // ② 在被判为世界书的槽位内部，尽量精确地把 token 分摊到各条目（匹配不到的部分按条目体积加权分摊）。
    // 于是"世界书内容漏匹配"不再掉进「其他」，消除了旧口径把世界书残余标成「深度注入（世界书等）」的矛盾。
    const visibleTexts = (scanEntries.length && slots.some(s => s.text))
        ? await getEntriesVisibleTexts(startedAt, scanEntries)
        : new Map();
    if (statsClearedAt > startedAt) return null;
    // 本次实际发送的聊天消息（老→新）：用于把深度注入映射到"在聊天 #k 之前插入"。
    const sendable = computeSendableChat(options.chatSnapshot, options.genType);

    const entrySlotTokens = new Map(); // entryKey -> Map<slotIdx, tokens>：条目在各槽位**精确命中**的 token
    const entrySpanSlots = new Map();  // entryKey -> Set<slotIdx>
    const entryFirstPos = new Map();   // entryKey -> pos|null
    // 第二十九轮（用户口径④"世界书条目的滚动定位还是不够准确"）：
    //   pos 原先取**全部槽位里的最小命中偏移**，于是"同一条目在多条消息里都命中"时，
    //   pos 总是落在最早那条消息上 → 后一条消息里的该条目在 `ensureEntryLayout` 里被判成
    //   "槽位号对不上"直接丢弃 → 剩下能亮的那几条边界被拉得很开，滚动时高亮就"一下跳好几个"。
    //   这里另存**逐槽位**的首个命中偏移：`entrySlotFirstPos: entryKey -> Map<slotIdx, 首个 start>`，
    //   完整上下文的 `wiEntries[].pos` 改为"**本槽位内**的首个命中偏移"，不再跨条污染。
    const entrySlotFirstPos = new Map();
    const slotOwnClaimed = new Map();  // slotIdx -> tokens（被世界书命中量，仅用于判定覆盖阈值）

    for (const entry of scanEntries) {
        if (statsClearedAt > startedAt) return null;
        const key = entryKey(entry);
        const visibleText = visibleTexts.get(key) || '';
        const spans = findEntrySpans(visibleText, slots);
        const piecesBySlot = extractSpanPiecesBySlot(spans);
        const perSlot = new Map();
        for (const [slot, pieces] of piecesBySlot) {
            let t = 0;
            for (const piece of pieces) t += await cachedTokenCount(piece);
            if (!t) continue;
            perSlot.set(slot.index, t);
            slotOwnClaimed.set(slot.index, (slotOwnClaimed.get(slot.index) || 0) + t);
        }
        entrySlotTokens.set(key, perSlot);
        entrySpanSlots.set(key, new Set(perSlot.keys()));
        let pos = null;
        const firstInSlot = new Map();   // slotIdx -> 该条目在这个槽位里最早的命中字符偏移
        for (const span of spans) {
            const si = span.slot.index ?? 0;
            const p = si * 1e6 + span.start;
            if (pos === null || p < pos) pos = p;
            const prev = firstInSlot.get(si);
            if (prev === undefined || span.start < prev) firstInSlot.set(si, span.start);
        }
        entryFirstPos.set(key, pos);
        entrySlotFirstPos.set(key, firstInSlot);
    }

    // 条目元数据（供纯函数归因）：key / position / depth / role / 体积权重（渲染后可见文本 token，≥1）。
    const entriesMeta = [];
    for (const e of scanEntries) {
        const key = entryKey(e);
        entriesMeta.push({
            key,
            position: Number(e.position) || 0,
            depth: Number(e.depth) || 0,
            // 分组键专用：**原始** depth（不折算），交给 depthGroupKeyOfEntry 按 ST 的 Number() 口径归一
            depthRaw: e.depth,
            role: e.role ?? null,
            weight: Math.max(1, await cachedTokenCount(visibleTexts.get(key) || '')),
            // 展示用元数据：归因纯函数原样透传，供「完整上下文」的左侧子窗逐条列出该消息的世界书条目来源。
            // 口径与下方 wiDetailedStats 的 record **完全一致**（同一套 name/book/type 推导），避免两处不一致。
            name: e.comment || (e.uid !== undefined ? `[UID: ${e.uid}]` : '未命名条目'),
            book: e.world || 'Embedded/Other',
            type: entryHasEjs(e) ? 'ejs' : (e.constant ? 'constant' : 'dynamic'),
            uid: e.uid ?? null,
            // 展示用（第二十七轮 R5）：条目行第二行要显示「插入位置 · 顺序」。
            // ⚠️ **不能直接改上面的 `position`**：归因纯函数（0/1 判定、D 系列护栏）就在用它，
            //    把 undefined 变成 null 会改变那些判定；故另存原始值。`depthRaw` 上面已有，同样可用。
            positionRaw: (e.position === undefined || e.position === null) ? null : Number(e.position),
            order: (e.order === undefined || e.order === null) ? null : Number(e.order),
        });
    }

    // 槽位来源分类：'wi-before' | 'wi-after' | 'wi-depth' | 'wi-block' | 'wi-merged' | 'chat' | 'other'
    // depthGroups：按 depth+role 汇总"世界里属于世界书条目的渲染体积合计"（D2′ 的对照尺子）。
    // 槽位归属哪一组**由内容推导**（命中本槽的 @D 条目必然同组），不用 chatHistory-N 推 depth——
    // 实测 N 是自上而下的顺序号、会随注入条数与预算裁剪漂移，与 depth 没有稳定对应。
    const depthGroups = new Map();
    // 前置/后置世界书块的体量（D6 护栏的对照尺子）：position 0 / 1 全部已激活条目的渲染体积合计
    const wiBlockTokens = [0, 0];
    for (const m of entriesMeta) {
        if (m.position === 0) { wiBlockTokens[0] += m.weight; continue; }
        if (m.position === 1) { wiBlockTokens[1] += m.weight; continue; }
        if (m.position !== 4) continue;
        const k = depthGroupKeyOfEntry({ depth: m.depthRaw, role: m.role });
        depthGroups.set(k, (depthGroups.get(k) || 0) + m.weight);
    }
    // 混槽救援的护栏（D5）：先判定每个聊天槽是否"匹配真实聊天楼层"。
    // 只有明确 false（有聊天快照、但对不上任何待发送消息 → 典型是深度注入槽）才允许救援；
    // null（快照缺失/无法判定）时救援被禁用，保持原判定，避免影响无快照的合成/历史用例。
    // 混槽救援的护栏（D5 / 结构身份，第六轮审查 P2-4）：
    //   ① 结构身份可用时直接采用：'floor' → true（真楼层禁救援）；'injection' → false（注入块允许救援）；
    //   ② 否则回退原内容启发式（快照缺失/无法判定 → null → 救援被禁用，保持保守）。
    // 身份来自 `chatHistory-N` 的结构预测（collectInjectionBlockNs），**与文本内容无关**：
    // 于是"条目引用聊天原文"不会再被误判成楼层（P2-4），"聊天照抄条目正文"也不再需要内容阈值取舍（S6/D3′）。
    const slotFloorFlags = slots.map((s, i) => {
        const k = kinds ? kinds[i] : null;
        if (k === 'floor') return true;
        if (k === 'injection') return false;
        return s.isChat ? slotIsChatFloor(s.text, options.chatSnapshot, options.genType) : null;
    });
    // 判定输入（classifyPromptSlot 与 slotDecisions 共用同一份推导，避免两处各写一遍而漂移）
    // 本请求里"实际存在"的槽标识，以及"在任意槽里命中过"的前置/后置世界书块：
    // 用于判断"另一块世界书是否真的并进了这一槽"（内容/结构证据，第四轮审查 P2-2）。
    const presentIdentifiers = new Set(slots.map(s => s.identifier).filter(id => typeof id === 'string'));
    const blocksWithHits = new Set();
    for (const e of scanEntries) {
        const p = Number(e.position) || 0;
        if ((p === 0 || p === 1) && (entrySpanSlots.get(entryKey(e))?.size || 0) > 0) blocksWithHits.add(p);
    }
    const slotInputs = slots.map(slot => {
        const hitEntries = scanEntries.filter(e => entrySpanSlots.get(entryKey(e))?.has(slot.index));
        const hitPositions = hitEntries.map(e => Number(e.position) || 0);
        const depthKey = depthGroupKeyOf(hitEntries
            .filter(e => (Number(e.position) || 0) === 4)
            .map(e => depthGroupKeyOfEntry(e)));
        // D6：该槽"与前置/后置世界书有关"的体量——标识所指那块，加上槽内确有命中的另一块
        //（squash 会把两块并进同一条消息）；不涉及前置/后置槽时为 null。
        let wiBlockTokensOfSlot = null;
        // 命中区间之外是否还有非空白内容（null = 不适用/未曾计算）
        let hasForeignText = null;
        // P1-1（第五轮审查实测）：本槽命中**全部**来自前置/后置块（position 0/1）时，这些块也可能被
        // squash 合并进本槽——ST 的 squashSystemMessages（openai.js）把相邻 system 槽合并进该段
        // **第一条**消息并沿用其标识（lastMessage.content += …）；main 非空时存活标识就是 main，
        // 于是走不到下面"前置/后置槽"的整块认定，覆盖又不到 50% → 整块世界书掉进「其他」
        // （实测：623t 前置条目被并进 main 2269t 的槽 → 面板世界书 990→367）。
        const ownBlock = slot.identifier === 'worldInfoBefore' ? 0
            : slot.identifier === 'worldInfoAfter' ? 1 : null;
        const blockHitsOnly = hitPositions.length > 0 && hitPositions.every(p => p === 0 || p === 1);
        if (ownBlock !== null || blockHitsOnly) {
            const blocks = new Set(ownBlock === null ? [] : [ownBlock]);
            for (const p of hitPositions) if (p === 0 || p === 1) blocks.add(p);
            const blockIdOf = (p) => (p === 0 ? 'worldInfoBefore' : 'worldInfoAfter');
            let own = 0;
            for (const p of [0, 1]) {
                // "被 squash 合并掉"的结构证据：这一块自己的标识槽在本请求里不存在
                const mergedAway = !presentIdentifiers.has(blockIdOf(p));
                if (ownBlock !== null) {
                    // 前置/后置槽：标识所指那块无条件算进来；
                    // 另一块（通常是后置）没被匹配到、但体量上装得进这一槽时，把它也算进"世界书体量"：
                    // 世界书文本被 Regex(WORLD_INFO) 改写 / EJS 未渲染（>MAX_RENDERED_EJS_ENTRIES）时匹配不到，
                    // 若只看命中就会把"其实是世界书"的那一块当成别人的文本而整块漏计（第三轮审查 B-反例，少算）。
                    // 装不下则说明它不在这一槽里，保持原样。
                    if (blocks.has(p)) { own += wiBlockTokens[p]; continue; }
                    if (blocksWithHits.has(p) || !mergedAway) continue;
                    if (own + wiBlockTokens[p] <= slot.tokens) own += wiBlockTokens[p];
                } else {
                    // 合并槽（本槽标识不是前置/后置，如 main）：只认"已被合并掉"的那些块——
                    // 块还在自己槽里时，本槽里出现的相同文本只可能是别处照抄，算进来会双重计数。
                    if (!mergedAway) continue;
                    if (blocks.has(p)) own += wiBlockTokens[p];
                    else if (!blocksWithHits.has(p) && own + wiBlockTokens[p] <= slot.tokens) own += wiBlockTokens[p];
                }
            }
            if (own > 0) wiBlockTokensOfSlot = own;
        }
        if (ownBlock !== null) {
            // 残余文本 = 槽文本 − 命中区间并集；只有"确有非空白残余"才谈混合（纯槽里的连接空行不算）。
            const claimed = Array.isArray(slot.claimed) ? [...slot.claimed].sort((a, b) => a[0] - b[0]) : [];
            let cursor = 0, residual = '';
            for (const [s, e] of claimed) {
                if (s > cursor) residual += slot.text.slice(cursor, s);
                cursor = Math.max(cursor, e);
            }
            residual += slot.text.slice(cursor);
            hasForeignText = /\S/.test(residual);
        }
        return { hitEntries, hitPositions, depthKey, wiBlockTokensOfSlot, hasForeignText };
    });
    const slotKind = slots.map((slot, slotIdx) => {
        const info = slotInputs[slotIdx];
        return classifyPromptSlot({
            identifier: slot.identifier,
            isChat: slot.isChat,
            isChatFloor: slotFloorFlags[slotIdx],
            isIdentityFloor: kinds ? kinds[slotIdx] === 'floor' : null,
            tokens: slot.tokens,
            ownClaimed: slotOwnClaimed.get(slot.index) || 0,
            matchedPositions: info.hitPositions,
            depthSlotTokens: info.depthKey === null ? null : (depthGroups.get(info.depthKey) ?? null),
            wiBlockTokens: info.wiBlockTokensOfSlot,
            hasForeignText: info.hasForeignText,
        });
    });

    // 「聊天统计」子弹窗用的补充字段（体积很小，随锚点持久化）：
    //   sentChat：本次**实际发送**的聊天楼层范围（首/末条 mesIDDisplay 序号 + 条数，来源 = sendable）
    //   ⚠️ 只有这一项需要落盘；「AI 平均 tokens / 平均生成速度 / 折线」全部由**当前聊天最新的 N 条 AI 消息**
    //   实时算出（用户口径：不必是实际发送的那些），故不写入锚点。
    const sentChat = sendable.length
        ? { first: sendable[0].floor, last: sendable[sendable.length - 1].floor, count: sendable.length }
        : { first: null, last: null, count: 0 };
    stats.sentChat = sentChat;

    // 槽位判定留痕（D4 可观测性）：把"每个非聊天槽位被判成什么、依据多少 token"记进锚点。
    // 用途：事后自查"世界书/其他"的边界争议（例如 squash 合并槽、同槽混入、聊天照抄条目）。
    // 只记非聊天槽（聊天槽恒为 'chat'，记了只是徒增锚点体积）；旧锚点没有该字段，视图按缺失回退。
    const slotDecisions = [];
    slots.forEach((slot, i) => {
        if (slotKind[i] === 'chat') return; // 恒为「聊天」的槽不留痕；身份判定的注入型聊天槽会被记下
        const info = slotInputs[i];
        slotDecisions.push({
            i: slot.index,
            id: slot.identifier ?? null,
            kind: slotKind[i],
            tokens: slot.tokens,
            claimed: slotOwnClaimed.get(slot.index) || 0,
            // win = 该槽对应来源的"世界书体量"：深度槽用 depth+role 组体量，前置/后置槽用世界书本块体量
            win: info.wiBlockTokensOfSlot !== null
                ? info.wiBlockTokensOfSlot
                : (info.depthKey === null ? null : (depthGroups.get(info.depthKey) ?? null)),
            // 判定来源（第六轮审查 P2-4）：identity-* = 结构身份；heuristic = 内容启发式兜底
            by: !kinds ? 'heuristic'
                : (kinds[i] === 'floor' ? 'identity-floor'
                    : (kinds[i] === 'injection' ? 'identity-injection' : 'heuristic')),
        });
    });
    stats.slotDecisions = slotDecisions;
    Logger.debug('【统计】槽位判定：' + slotDecisions
        .map(d => `#${d.i} ${d.id ?? '∅'}=${d.kind}(${d.tokens}${d.claimed ? '/' + d.claimed : ''}${d.win !== null ? ' win=' + d.win : ''})`)
        .join(' | '));

    // 按来源槽位归因（纯函数）：世界书槽位整条计入 wi，并把其中 token 分摊到各条目；其余按角色分到 chat/other。
    const attr = attributeSlotsBySource({
        slots, slotKind, entries: entriesMeta, entryMatchToken: entrySlotTokens,
    });
    const entryTokens = attr.perEntry;
    let wi = attr.wi;
    const chat = attr.chat;

    // 构建世界书明细（四舍五入为整数）；再把舍入 / 未归属槽位的差额补到最大的条目，
    // 保证「Σ 明细 token」恰好等于 stats.wi（三栏恒等式之外，明细与「世界书」栏也自洽）。
    const wiBuckets = {};
    // 每个条目的「真实插入点」锚点：只算一次，两处共用——① wiDetailedStats 的 record.anchor
    // ② 完整上下文快照里逐条消息的 wiEntries[].anchor（左侧子窗按「上下文顺序」排条目要用）。
    const entryAnchors = new Map();
    const pending = [];
    let assigned = 0;
    for (const entry of scanEntries) {
        const key = entryKey(entry);
        const t = Math.max(0, Math.round(entryTokens.get(key) || 0));
        assigned += t;
        const bookName = entry.world || 'Embedded/Other';
        const type = entryHasEjs(entry) ? 'ejs' : (entry.constant ? 'constant' : 'dynamic');
        // 真实插入点（由 position/depth 推得）：供「上下文顺序」按"在聊天 #k 之前插入"归组。
        const anchor = entryContextAnchor(entry, sendable, options.anInfo ?? null, options.promptOrder ?? null);
        entryAnchors.set(key, anchor);
        pending.push({
            bookName, type,
            record: {
                name: entry.comment || (entry.uid !== undefined ? `[UID: ${entry.uid}]` : '未命名条目'),
                uid: entry.uid ?? null,
                tokens: t,
                matched: t > 0,
                pos: entryFirstPos.get(key) ?? null,
                anchor,
                // 展示用（第二十七轮 R5）：条目行第二行「插入位置 · 顺序」（与 entriesMeta 同一来源、同一口径）
                position: (entry.position === undefined || entry.position === null) ? null : Number(entry.position),
                depth: entry.depth ?? null,
                role: entry.role ?? null,
                order: (entry.order === undefined || entry.order === null) ? null : Number(entry.order),
            },
        });
    }
    const surplus = wi - assigned;
    if (surplus !== 0 && pending.length) {
        let target = pending[0];
        for (const p of pending) if (p.record.tokens > target.record.tokens) target = p;
        target.record.tokens = Math.max(0, target.record.tokens + surplus);
        target.record.matched = target.record.tokens > 0;
    }
    for (const p of pending) {
        if (!wiBuckets[p.bookName]) wiBuckets[p.bookName] = { constant: [], dynamic: [], ejs: [], total: 0 };
        wiBuckets[p.bookName][p.type].push(p.record);
        wiBuckets[p.bookName].total += p.record.tokens;
    }

    // 防御性钳制：确保概览三栏相加恒等于总计。
    if (wi > stats.total) wi = stats.total;
    stats.wi = wi;
    stats.chat = Math.max(0, Math.min(chat, stats.total - stats.wi));
    stats.other = Math.max(0, stats.total - stats.wi - stats.chat);
    stats.wiDetailedStats = wiBuckets;

    // 单条消息的世界书条目明细（展示用，见 lastContextDump.wiEntries 注释）。
    // 与 wiDetailedStats 同源（perSlotEntries），只是**不做**"舍入差额补到最大条目"那一步——
    // 这里回答的是"这一条消息里有哪些条目、各占多少"，按槽位原样四舍五入即可。

    const metaByKey = new Map(entriesMeta.map(m => [m.key, m]));
    const slotEntriesOf = (i) => {
        const per = attr.perSlotEntries.get(i);
        if (!per || !per.size) return [];
        const out = [];
        for (const [k, t] of per) {
            const meta = metaByKey.get(k);
            if (!meta || !(t > 0)) continue;
            // pos 的口径（第二十九轮修正）：**本槽位内**该条目正文的首个命中字符偏移，
            // 编码为 `槽位号 * 1e6 + 偏移`。此前取的是"全部槽位里的最小偏移"，
            // 同一个条目在多条消息里都命中时，其他消息里的这条会因槽位号对不上而失去定位
            // → 世界书条目的滚动联动高亮会"一下跳好几个"（用户口径④）。
            const offInSlot = entrySlotFirstPos.get(k)?.get(i);
            const pos = (offInSlot === undefined || offInSlot === null)
                ? (entryFirstPos.get(k) ?? null)   // 本槽位没有精确命中（余量分摊得到的 token）→ 退回旧口径
                : (i * 1e6 + offInSlot);
            // 定位提示（第二十九轮）：条目可见文本里第一个行锚点（与文本匹配用的是同一套锚点）。
            // 内容区里"条目正文从第几个字符开始"直接用它 `indexOf` 定位 —— 比单靠 pos 偏移稳：
            // pos 来自"渲染后可见文本"的偏移，而内容区里的是**实际发送的字符**（可能被正则改写过），
            // 两者一旦错位，旧实现会把超出的偏移钳到最后一位 ⇒ 多条条目挤在同一个纵坐标上 ⇒ 高亮乱跳。
            const hint = entryAnchorHint(visibleTexts.get(k));
            out.push({
                name: meta.name, book: meta.book, type: meta.type, uid: meta.uid,
                tokens: Math.max(1, Math.round(t)),
                // 该条目自己的"真实插入点"（与 wiDetailedStats 的 anchor 是同一份推导）：
                // 左侧子窗按「上下文顺序」排条目、并渲染聊天位置标记行时要用它。
                anchor: entryAnchors.get(k) || null,
                pos,
                hint,
                // 展示用（第二十七轮 R5）：条目行第二行「插入位置 · 顺序」（来自 entriesMeta 的原始值）
                position: meta.positionRaw ?? null,
                depth: meta.depthRaw ?? null,
                role: meta.role ?? null,
                order: meta.order ?? null,
            });
        }
        return out.sort((a, b) => (b.tokens - a.tokens) || String(a.name).localeCompare(String(b.name)));
    };
    // 完整上下文快照（**仅内存**，不落盘）：供「完整上下文」查看器逐条查看实际发送的消息。
    // 刷新页面 / 切换聊天即清空（用户口径：即用即丢，避免把完整上下文写进聊天文件）。
    // 消费方（写锚定 / 模拟锚定）在 await 返回后立即取走——统计任务走串行队列，两处之间不会被别的任务覆盖。
    lastContextDump = {
        genType: options.genType || null,
        total: stats.total,
        messages: slots.map((s, i) => ({
            i: s.index,
            role: s.role,
            tokens: s.tokens,
            identifier: typeof s.identifier === 'string' ? s.identifier : null,
            kind: slotKind[i],
            text: String(s.text ?? ''),
            // 世界书来源的消息：该条的**条目明细** [{ name, book, type, uid, tokens }]（非世界书消息为 null）。
            // 数据来源 = attributeSlotsBySource 的 perSlotEntries（与 wiDetailedStats 同源同值，只是按槽位保留），
            // 于是左侧子窗能回答"这条世界书消息具体由哪些条目组成"。仅内存、不落盘。
            wiEntries: isWiKind(slotKind[i]) ? slotEntriesOf(i) : null,
        })),
    };

    return stats;
}

// 把一条消息上的锚定统计数据整体摘除（含各个 swipe 版本里存储的副本）。
// 仅用于清理"超出保留窗口"的旧消息。
function stripAnchoredStats(message) {
    if (!message) return;
    if (message.extra && STATS_EXTRA_KEY in message.extra) {
        delete message.extra[STATS_EXTRA_KEY];
    }
    if (Array.isArray(message.swipe_info)) {
        for (const info of message.swipe_info) {
            if (info?.extra && STATS_EXTRA_KEY in info.extra) {
                delete info.extra[STATS_EXTRA_KEY];
            }
        }
    }
}

// 清理超出保留窗口的锚定数据：只保留最新 STATS_ANCHOR_KEEP 条"带锚定"的消息。
// 按"带锚定的消息条数"而非 chat 长度计算，这样不受发送过程中 chat 长度奇偶性的影响
// （写锚定时 AI 回复可能尚未追加），窗口始终精确等于 STATS_ANCHOR_KEEP。
function pruneAnchoredStats() {
    const chat = getContextOptimized()?.chat;
    if (!Array.isArray(chat)) return;

    const keep = new Set();
    for (let i = chat.length - 1; i >= 0 && keep.size < STATS_ANCHOR_KEEP; i--) {
        if (readAnchoredStatsFromMessage(chat[i])) {
            keep.add(i);
        }
    }
    for (let i = 0; i < chat.length; i++) {
        if (!keep.has(i) && readAnchoredStatsFromMessage(chat[i])) {
            stripAnchoredStats(chat[i]);
        }
    }
}

// 把统计结果锚定到指定消息上（写入 message.extra，随聊天文件持久化）。
// 加固校验：ST 的 chat 数组跨聊天始终保持同一引用（切换时用 splice 原地替换内容），
// 因此必须用 chatId + 锚定消息对象身份双重核对，避免统计期间切聊天导致数据错位。
//
// 落点口径（用户口径 §2.26）：锚定写在**这次发送所生成的那条消息**上（见 resolveAnchorTarget），
// 这样用户点开统计页看到的楼层号就是"生成的那条消息"，而不是触发它的用户消息。
//
// 关于 swipe：同一条消息的各个 swipe 版本是"同一个锚点的不同版本"——它们由同一段上下文
// （swipe 生成时最后一条消息本身被 coreChat.pop() 排除）生成，因此共享同一份统计。
// 而 ST 的 syncSwipeToMes 在切换 swipe 时会用 swipe_info[swipe_id].extra 覆盖 message.extra，
// 若只写 message.extra，滑到没有该锚定的旧版本时统计就会变空。所以这里把锚定镜像写入
// message.extra 与 message.swipe_info[*].extra（每个版本各存一份，切到任意版本都能读到）。
// 生成 swipe 时（genType='swipe'）目标消息就是被重生成的那条 → 上面这条镜像规则正好覆盖"更新该 swipe 的锚定"。
function writeAnchoredStats(anchor, stats, dump = null) {
    // 第三十六轮（功能开关）：聊天统计被禁用 → **不再往消息上写锚定**，也不再存快照。
    // 放在最前面：此时数据结构都可能还没校验，直接短路最省事（也是"停掉后台功能"的唯一落点之一）。
    if (!isFeatureEnabled('stats')) {
        Logger.debug('【统计】聊天统计功能已禁用，跳过锚定写入');
        return false;
    }
    const context = getContext();
    if (!context) return false;
    if (context.chatId !== anchor.chatId) {
        Logger.debug(`【统计】锚定丢弃：聊天已切换 (${anchor.chatId} -> ${context.chatId})`);
        return false;
    }
    if (context.chat[anchor.index] !== anchor.messageRef) {
        Logger.debug('【统计】锚定丢弃：锚定位置上的消息已变化');
        return false;
    }
    const message = anchor.messageRef;

    message.extra = message.extra || {};
    message.extra[STATS_EXTRA_KEY] = stats;

    // 同一条消息的所有 swipe 版本共享该锚定
    if (Array.isArray(message.swipe_info)) {
        for (const info of message.swipe_info) {
            if (!info || typeof info !== 'object') continue;
            info.extra = info.extra || {};
            info.extra[STATS_EXTRA_KEY] = stats;
        }
    }

    pruneAnchoredStats();
    // 完整上下文快照（仅内存）：跟着锚点一起入库，供「完整上下文」查看器读取
    saveContextDump(anchor.chatId, anchor.index, anchor.source || 'real', dump);
    return true;
}

// ── 锚定落点解析：把统计写到"这次生成出来的那条消息"上（用户口径 §2.26）──
// ST 各生成类型的行为（`script.js` Generate / Generate('swipe') 分支）：
//   · normal      → 触发消息（chat 末条，通常是用户消息）**之后**新追加一条 AI 回复；
//                   统计完成时它可能还没到（也可能先到），故解析为"待补写"（见 pendingReplyAnchor）。
//   · swipe       → 重生成 chat 末条（必为 AI 消息）的另一个版本，就地替换其 mes/swipe_info；
//                   → 锚点落在该消息自身，并靠 swipe_info 镜像覆盖"每个 swipe 各存一份"。
//   · regenerate  → 与 swipe 同理，重生成的是末条 AI 消息本身。
//   · continue    → 续写 chat 末条（通常为 AI 消息）→ 锚点落在该消息自身。
//   · impersonate → 生成结果写回输入框（不产生消息）→ 没有"生成的消息"，回退锚在触发消息上。
// 返回 { mode:'self'|'reply'|'trigger', index, messageRef }
function resolveAnchorTarget(genType, chat) {
    const last = chat.length - 1;
    if (last < 0) return null;
    const lastMsg = chat[last];
    if (genType === 'swipe' || genType === 'regenerate' || genType === 'continue') {
        // 被重生成的/续写的就是末条消息本身（swipe 只可能发生在末条）
        return { mode: 'self', index: last, messageRef: lastMsg };
    }
    if (genType === 'normal') {
        // 生成的是"即将追加"的那条 AI 回复：此刻还不存在 → 先记下触发位置，等它到达再写
        return { mode: 'reply', index: last, messageRef: lastMsg };
    }
    // impersonate 等：没有独立的消息产出，锚在触发消息上
    return { mode: 'trigger', index: last, messageRef: lastMsg };
}

// normal 生成的锚定补写：统计往往先于 AI 回复到达。
// `allowFallback=false`（回复尚未到达时的常规检查）→ 继续等待，返回 false；
// `allowFallback=true`（生成已结束/中止/超时兜底）→ 仍没有回复就回退写到触发消息上，保证统计不丢。
function flushPendingReplyAnchor(reason = '', allowFallback = false) {
    const pending = pendingReplyAnchor;
    if (!pending) return false;
    const context = getContext();
    if (!context || context.chatId !== pending.chatId) { // 切了聊天：静默作废
        pendingReplyAnchor = null;
        return false;
    }
    const reply = context.chat[pending.triggerIndex + 1];
    const hasReply = !!(reply && !reply.is_user);
    if (!hasReply && !allowFallback) return false; // 回复还没到 → 继续等待

    pendingReplyAnchor = null;
    const target = hasReply
        ? { chatId: pending.chatId, index: pending.triggerIndex + 1, messageRef: reply, source: 'real' }
        : { chatId: pending.chatId, index: pending.triggerIndex, messageRef: context.chat[pending.triggerIndex], source: 'real' };
    if (!target.messageRef) return false;
    const ok = writeAnchoredStats(target, pending.stats, pending.dump);
    if (ok) {
        Logger.debug(`【统计】锚定到生成的消息 #${target.index}${hasReply ? '（AI 回复）' : '（回退：触发消息）'}${reason ? ` @${reason}` : ''}`);
        updateTokenStatsUI();
    }
    return ok;
}

// 从一条消息上读取锚定统计：优先读当前可见的 message.extra；若为空则回退到当前 swipe
// 版本对应的 swipe_info[swipe_id].extra（防止个别时序下 extra 尚未同步）。
function readAnchoredStatsFromMessage(message) {
    if (!message) return null;
    const direct = message.extra?.[STATS_EXTRA_KEY];
    if (direct && typeof direct.total === 'number') return direct;

    if (Array.isArray(message.swipe_info) && typeof message.swipe_id === 'number') {
        const info = message.swipe_info[message.swipe_id];
        const fromSwipe = info?.extra?.[STATS_EXTRA_KEY];
        if (fromSwipe && typeof fromSwipe.total === 'number') return fromSwipe;
    }
    return null;
}

// 读取当前聊天里所有锚定统计，按消息下标升序返回 [{ index, stats, isSim }]。
// 真实锚点下标为消息下标（非负整数）；模拟锚定用哨兵 id（SIM_ANCHOR_ID）并置于最右（最新），
// 从而在 chips / 对比基准里与真实锚点一同被浏览、比对。
// 由于 pruneAnchoredStats 只保留最新 STATS_ANCHOR_KEEP 条，真实锚点数量恒 ≤ 该值。
function getAnchoredStatsList() {
    const chat = getContextOptimized()?.chat;
    const list = [];
    if (Array.isArray(chat)) {
        for (let i = 0; i < chat.length; i++) {
            const stats = readAnchoredStatsFromMessage(chat[i]);
            if (stats) list.push({ index: i, stats, isSim: false });
        }
    }
    if (simulateAnchor) list.push({ index: SIM_ANCHOR_ID, stats: simulateAnchor, isSim: true });
    return list;
}

// 模拟锚点的显示编号（第三十三轮用户口径④）：它代表"下一次发送" ⇒ 紧接在最后一条真实锚点之后，
// 即 `#{最后一条真实 messageID + 1}`（例：#9 → #10）。没有真实锚点时退回"当前聊天消息数"
// （= 下一条消息的下标）；聊天也读不到就退回 0。时间信息不再进 chip，只留在 title 里。
function simAnchorDisplayIndex(list) {
    let last = null;
    for (const item of (list || [])) {
        if (!item || item.isSim) continue;
        const n = Number(item.index);
        if (!Number.isFinite(n)) continue;
        last = (last === null) ? n : Math.max(last, n);
    }
    if (last !== null) return last + 1;
    // 没有真实锚点：从当前聊天实时读消息数（不读 getContextOptimized 的缓存 —— 它会滞后于新消息）
    const chat = getContext()?.chat;
    return Array.isArray(chat) ? chat.length : 0;
}

// 锚点在列表里的显示标签（第三十三轮用户口径④：**只显示 messageID**，时间去掉了）：
// 真实锚点 → `#N`；模拟锚定 → `#(N+1)`（由 simAnchorDisplayIndex 算好传入；未传时退回旧文案「模拟」）。
// ⚠️ 第三十五轮：本函数只剩**对比表列头**在用（`#N` 的紧凑写法）；锚定栏的菜单项改用
//    `anchorMenuItemLabel()`（`第 N 楼` 的口语写法，用户口径见该函数）。
function formatAnchorLabel(item, simDisplayId = null) {
    if (item?.isSim) {
        return (simDisplayId === null || simDisplayId === undefined) ? '模拟' : `#${simDisplayId}`;
    }
    return `#${item?.index}`;
}

// 锚定菜单项的显示文案（第三十五轮用户口径①：「菜单项名称改为 `第 %{messageID} 楼`」）：
//   真实锚点 → `第 N 楼`（N = 该锚定所在的 messageID）；
//   模拟锚定 → `第 M 楼`（M = simAnchorDisplayIndex 算出的"下一条 messageID"，与真实锚点同一套口语）。
// 拿不到编号时退回旧文案「模拟发送」，不会显示一个错的楼层号。
function anchorMenuItemLabel(item, simDisplayId = null) {
    if (!item) return '';
    if (item.isSim) {
        return (simDisplayId === null || simDisplayId === undefined) ? '模拟发送' : `第 ${simDisplayId} 楼`;
    }
    return `第 ${item.index} 楼`;
}

// 锚定时间戳 -> HH:MM:SS
function formatAnchorTime(at) {
    if (typeof at !== 'number' || !isFinite(at)) return '--:--:--';
    const d = new Date(at);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 极简 HTML 转义（用于渲染聊天正文摘要等用户内容）
function escapeHtmlText(s) {
    return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// 汇总一个锚点的统计数字（供对比表使用）
function getAnchorSummary(stats) {
    const det = stats?.wiDetailedStats || {};
    let constant = 0, dynamic = 0, ejs = 0, entries = 0, matched = 0;
    for (const b in det) {
        const book = det[b] || {};
        const constList = Array.isArray(book.constant) ? book.constant : [];
        const dynList = Array.isArray(book.dynamic) ? book.dynamic : [];
        const ejsList = Array.isArray(book.ejs) ? book.ejs : [];
        for (const list of [constList, dynList, ejsList]) {
            for (const e of list) {
                entries++;
                if (e?.matched) matched++;
            }
        }
        for (const e of constList) constant += Number(e?.tokens) || 0;
        for (const e of dynList) dynamic += Number(e?.tokens) || 0;
        for (const e of ejsList) ejs += Number(e?.tokens) || 0;
    }
    const total = Number(stats?.total) || 0;
    const chat = Number(stats?.chat) || 0;
    const wi = Number(stats?.wi) || 0;
    return { total, chat, wi, other: Math.max(0, total - chat - wi), constant, dynamic, ejs, entries, matched };
}

// 相对基准的差值小字（基准列自身不显示）
function fmtDelta(cur, base) {
    const diff = cur - base;
    if (diff === 0) return '';
    const cls = diff > 0 ? 'up' : 'down';
    const sign = diff > 0 ? '+' : '';
    const pct = base > 0 ? ` (${sign}${((diff / base) * 100).toFixed(1)}%)` : '';
    return ` <span class="tub-delta ${cls}">${sign}${diff}${pct}</span>`;
}

// 对比视图的默认「基准 → 对比」组合：上一条真实 message 作基准、最新真实 message 作对比。
// （模拟锚定不算"真实 message"；只有一个真实锚点时用该真实锚点作基准、最新锚点作对比。）
function getDefaultCompareCombo(list) {
    const reals = list.filter(x => !x.isSim);
    const latest = list[list.length - 1];
    if (reals.length >= 2) {
        return { baseId: reals[reals.length - 2].index, compareId: reals[reals.length - 1].index };
    }
    if (reals.length === 1) {
        // 只有一个真实锚点：基准=该真实锚点，对比=最新锚点（通常是模拟；若与基准相同则无对比）
        const cmp = latest.index === reals[0].index ? null : latest.index;
        return { baseId: reals[0].index, compareId: cmp };
    }
    return { baseId: latest?.index ?? null, compareId: null };
}

// 更新 Token 统计 UI（直接读取消息上锚定的统计数据，无任何副作用）。
// 模拟锚定已并入统一列表（最右），无需单独分支。
function updateTokenStatsUI() {
    Logger.debug("【UI渲染触发】进入 updateTokenStatsUI");
    // 整块重绘前先收起类型过滤菜单：它挂在外层弹窗直下，不随这些面板的 innerHTML 重绘消失，
    // 若还开着，触发器会被换掉，菜单就变成"无主"的浮层。
    closeTypeFilterMenu();
    // 「聊天」统计子弹窗同理：内容区的 innerHTML 会被整体重绘，锚定它的统计框元素会被替换，
    // 若不收起就会变成浮在旧位置上的无主浮层。
    closeChatStatsPopup();
    closeChildStack(); // 重绘前的地道"重置"：整轮层级结束（不是"退一层"）
    const list = getAnchoredStatsList();
    const anchorBarEl = document.getElementById('tub-anchor-bar');
    const detailEl = document.getElementById('tub-detail-section');
    const compareEl = document.getElementById('tub-compare-section');

    // 没有任何锚定数据（尚未发送过消息、也没模拟过）：锚定栏仍要渲染（含"模拟发送"按钮）
    if (!list.length) {
        statsPinnedIndex = null;
        statsBaselineIndex = null;
        statsCompareIndex = null;
        renderAnchorBar(list, { selectedId: null, latestId: null, defaultCombo: null, compareId: null });
        if (detailEl) detailEl.style.display = '';
        if (compareEl) { compareEl.style.display = 'none'; compareEl.innerHTML = ''; }
        renderTokenStatsContent(null);
        return;
    }

    const latestId = list[list.length - 1].index;
    // 对比默认组合：上一条真实锚点（基准）→ 最新真实锚点（对比）
    const defaultCombo = getDefaultCompareCombo(list);
    const idSet = new Set(list.map(x => x.index));

    // 校验手动选中/基准/对比是否仍有效（可能已被剪枝清除），无效则回退
    if (statsPinnedIndex !== null && !idSet.has(statsPinnedIndex)) statsPinnedIndex = null;
    if (statsBaselineIndex !== null && !idSet.has(statsBaselineIndex)) statsBaselineIndex = null;
    if (statsCompareIndex !== null && !idSet.has(statsCompareIndex)) statsCompareIndex = null;
    // 手动指定的组合必须成对且不同；任一无效则两者一起退回默认
    if ((statsBaselineIndex === null) !== (statsCompareIndex === null)) {
        statsBaselineIndex = null;
        statsCompareIndex = null;
    }
    if (statsBaselineIndex !== null && statsBaselineIndex === statsCompareIndex) {
        statsBaselineIndex = null;
        statsCompareIndex = null;
    }

    const selectedId = statsPinnedIndex ?? latestId;
    const baselineId = statsBaselineIndex ?? defaultCombo.baseId;
    const compareId = statsCompareIndex ?? defaultCombo.compareId;
    const barId = statsViewMode === 'compare' ? baselineId : selectedId;
    renderAnchorBar(list, { selectedId: barId, latestId, defaultCombo, compareId });

    if (statsViewMode === 'compare') {
        if (detailEl) detailEl.style.display = 'none';
        if (compareEl) compareEl.style.display = '';
        renderCompareContent(list, baselineId, compareId);
        centerPopup($('#hide-helper-popup'));
        return;
    }

    if (detailEl) detailEl.style.display = '';
    if (compareEl) { compareEl.style.display = 'none'; compareEl.innerHTML = ''; }

    const selected = list.find(x => x.index === selectedId) || list[list.length - 1];
    const { total, chat, wi } = selected.stats;
    const other = Math.max(0, total - chat - wi);
    Logger.debug(`【诊断数据】锚点 ${selected.index}: 总计 ${total}（聊天 ${chat} / 世界书 ${wi} / 其他 ${other}）`);
    renderTokenStatsContent({
        index: selected.index,
        isSim: selected.isSim,
        totalTokens: total,
        chatTokens: chat,
        wiTokens: wi,
        otherTokens: other,
          statsObj: selected.stats.wiDetailedStats || {},
          genType: selected.stats.genType || null, // 「上下文顺序」旧锚点兜底推导首/末条消息序号时用（swipe 会排除最后一条）
          stats: selected.stats, // 【聊天统计子弹窗】读取 sentChat 等原始字段（AI 统计改由当前聊天实时算）
    });
}

// 点击「模拟发送」：先弹窗收集自定义内容（可留空），确认后再真正模拟。
// 第三十一轮（用户口径）：「模拟发送的弹窗美化一下，不要使用 popup，使用与插件一套风格主题的自定义弹窗
//   （日夜双主题）」—— 原来走 ST 的 `callGenericPopup(..., POPUP_TYPE.INPUT)`，外观是酒馆原生弹窗、
//   与插件的紫调/暗色主题完全两套。现改为自绘弹窗 `askSimulateContent()`：
//   · 结构与「更新日志」弹窗同一套（`.hide-modal-overlay` + `.hide-modal-box`）；
//   · 变量全部取 `--hh-*`，随 `data-theme` 自动日夜切换（applyTheme 已覆盖 `.hide-modal-overlay`）；
//   · 返回 `Promise<string|null>`：确认 → 输入字符串（可为空串）；取消 / Esc / 点遮罩 → `null`。
function askSimulateContent(initialValue = '') {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'hide-modal-overlay hide-sim-overlay';
        overlay.id = 'hide-helper-simulate-overlay';
        overlay.innerHTML = `
            <div class="hide-modal-box hide-sim-box" role="dialog" aria-modal="true" aria-labelledby="hide-sim-title">
                <div class="hide-modal-header hide-sim-header">
                    <span id="hide-sim-title">模拟发送</span>
                    <button type="button" class="hide-helper-popup-close-icon hide-sim-close" id="hide-sim-close" title="关闭">&times;</button>
                </div>
                <div class="hide-sim-tip">
                    将以当前聊天上下文<b>真实组装一次请求</b>（含世界书与 EJS 渲染）后拦截统计 ——
                    不会发往 API、不消耗 token、不新增消息。
                </div>
                <label class="hide-sim-label" for="hide-sim-input">自定义内容（可留空）</label>
                <textarea id="hide-sim-input" class="hide-sim-input" rows="4"
                    placeholder="（可留空，直接按下方按钮模拟发送）"></textarea>
                <div class="hide-modal-footer hide-sim-footer">
                    <button type="button" class="menu_button hide-sim-cancel" id="hide-sim-cancel">取消</button>
                    <button type="button" class="menu_button primary hide-sim-ok" id="hide-sim-ok">模拟发送</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        // 主题：与主弹窗同一套判定（applyTheme 写的是 data-theme="dark"）
        if ((extension_settings[extensionName]?.theme || 'light') === 'dark') {
            overlay.setAttribute('data-theme', 'dark');
        }
        // 强制 reflow 后再加 .visible，让 CSS 的入场动画真的跑起来
        void overlay.offsetWidth;
        overlay.classList.add('visible');

        const ta = overlay.querySelector('#hide-sim-input');
        ta.value = initialValue;
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);

        let done = false;
        const finish = (value) => {
            if (done) return;
            done = true;
            document.removeEventListener('keydown', onKey, true);
            overlay.classList.remove('visible');
            // 等淡出结束再移除（没有 transition 时也只是多等一帧）
            setTimeout(() => overlay.remove(), 160);
            resolve(value);
        };
        const onKey = (ev) => {
            if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finish(null); return; }
            // Ctrl/Cmd + Enter = 确认（textarea 里裸 Enter 要留给换行）
            if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); finish(ta.value); }
        };
        document.addEventListener('keydown', onKey, true);
        overlay.querySelector('#hide-sim-ok').addEventListener('click', () => finish(ta.value));
        overlay.querySelector('#hide-sim-cancel').addEventListener('click', () => finish(null));
        overlay.querySelector('#hide-sim-close').addEventListener('click', () => finish(null));
        // 点遮罩空白处 = 取消（点 box 内部不关）
        overlay.addEventListener('mousedown', (ev) => { if (ev.target === overlay) finish(null); });
    });
}

async function triggerSimulate() {
    if (simulateInProgress) return;
    // 第三十六轮（功能开关）：聊天统计关着时，模拟发送没有意义（跑完也写不进锚定）→ 直接拒绝。
    // 用 notify 而不是 toastr：与其它开发入口保持同一套"没有 toastr 也不炸"的写法。
    if (!isFeatureEnabled('stats')) {
        notify('warning', '「聊天统计」功能已禁用，请先在「使用说明 → 功能启用 / 禁用」中开启。');
        return;
    }

    const context = getContext();
    if (!context?.chatId) { toastr.warning('当前没有打开的聊天，无法模拟发送。'); return; }
    // 只有 Chat Completion 会在 SETTINGS_READY 处给我们拦截时机；其它 API 走不到该事件，
    // 继续下去会真的发出请求，因此直接拒绝。
    if (context.mainApi !== 'openai') {
        toastr.warning('「模拟发送」目前仅支持 Chat Completion（聊天补全）API。');
        return;
    }
    // 避免与正在进行的真实生成相互干扰
    if (document.body.dataset.generating === 'true') {
        toastr.warning('正在生成中，请等生成结束后再模拟发送。');
        return;
    }

    // 第三十一轮：改用插件自绘弹窗（日夜双主题），不再用 ST 的 callGenericPopup
    const value = await askSimulateContent(simulateContent || '');
    if (typeof value !== 'string') return;   // 取消 / Esc / 点遮罩
    await runSimulateSend(value);
}

// ── 模拟发送的"正在生成中"提示弹窗（第三十五轮用户口径⑤）────────────────────────────────
// 用户口径：「在『模拟发送』生成阶段，请出现一个提示弹窗提示正在生成。」
// 为什么要有：模拟发送会真实跑一遍组装管线（世界书扫描 + EJS 渲染 + 统计），耗时从几百毫秒到数秒不等；
//   原来这一整段时间界面上**什么变化都没有**（只在锚定栏按钮上把文案改成"模拟中…"），用户会以为没点上、
//   反复点击。现在改为一个**不可交互、不可关闭**的轻量遮罩（转圈 + 文案），管线一结束就移除。
// 实现要点：
//   · 复用 `.hide-modal-overlay` 骨架（与「模拟发送」输入弹窗 /「更新日志」同一套变量，日夜自动切换）；
//   · 加 `.hide-sim-progress-overlay` 只用来关掉"点遮罩取消"的交互（它根本没有取消按钮）；
//   · 用**幂等**的 show/hide：runSimulateSend 的 finally 一定调 hide，重复调用也不会残留两个遮罩；
//   · 不抢焦点、不阻止键盘（Esc 仍能关主弹窗，不影响管线）。
const SIM_PROGRESS_ID = 'hide-helper-sim-progress';
function showSimulateProgress() {
    if (typeof document === 'undefined') return;
    let overlay = document.getElementById(SIM_PROGRESS_ID);
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = SIM_PROGRESS_ID;
        overlay.className = 'hide-modal-overlay hide-sim-progress-overlay';
        overlay.innerHTML = `
            <div class="hide-modal-box hide-sim-progress-box" role="status" aria-live="polite">
                <div class="hide-sim-progress-spinner" aria-hidden="true"></div>
                <div class="hide-sim-progress-title">正在模拟发送…</div>
                <div class="hide-sim-progress-tip">正在用当前上下文真实组装一次请求（含世界书与 EJS 渲染）并统计 token 来源。<br>不会发往 API、不消耗 token、不新增消息，请稍候。</div>
            </div>`;
        if ((extension_settings[extensionName]?.theme || 'light') === 'dark') {
            overlay.setAttribute('data-theme', 'dark');
        }
        document.body.appendChild(overlay);
        void overlay.offsetWidth;   // 强制 reflow 后再加 .visible，让入场动画真的跑起来
    }
    overlay.classList.add('visible');
}

function hideSimulateProgress() {
    if (typeof document === 'undefined') return;
    const overlay = document.getElementById(SIM_PROGRESS_ID);
    if (!overlay) return;
    overlay.classList.remove('visible');
    // 等淡出结束再移除（没有 transition 时也只是多等一帧）；重入时新遮罩可能已建好 → 按 id 复核一次
    setTimeout(() => {
        const still = document.getElementById(SIM_PROGRESS_ID);
        if (still && !still.classList.contains('visible')) still.remove();
    }, 160);
}

// —— 模拟发送的状态快照 / 还原工具 ——
// 深度克隆：优先 structuredClone，退化到 JSON；值不可克隆时返回 null（调用方按"不做保护"处理）。
function safeDeepClone(value) {
    if (value == null) return value;
    try {
        return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    } catch (e) {
        Logger.warn('【模拟发送】快照克隆失败，该项不做还原保护:', e);
        try { return JSON.parse(JSON.stringify(value)); } catch { return null; }
    }
}

// 把 target 还原成 snapshot：删除新增键，回填被改写的键（回填用深拷贝，避免共享引用）。
function restoreObjectFromSnapshot(target, snapshot) {
    if (!target || typeof target !== 'object' || snapshot == null || typeof snapshot !== 'object') return;
    for (const key of Object.keys(target)) {
        if (!Object.prototype.hasOwnProperty.call(snapshot, key)) delete target[key];
    }
    for (const key of Object.keys(snapshot)) {
        target[key] = safeDeepClone(snapshot[key]);
    }
}

// 深比较（判断是否发生了需落盘的改动）；比较失败时保守返回 false（视为"已改变"，宁可多存一次）。
function roughDeepEqual(a, b) {
    try {
        return JSON.stringify(a) === JSON.stringify(b);
    } catch {
        return false;
    }
}

// 快照每条消息的 variables / variables_initialized：ST-Prompt-Template（setVariable withMsg / 指定楼层）
// 与 JS-Slash-Runner（replaceVariables）会在组装中就地改写变量，可能写到真实楼层上。
// P4-8（第六轮审查）：**原本没有 variables 字段的楼层也要纳入保护**——快照记为
// `{ variables: null, variables_initialized: null }`，还原时删除字段（而不是跳过）。
// 旧实现把这些楼层记为 null（“跳过保护”），若管线给它们写入变量，就会在内存里残留
// 并随插件自身的 saveChat() 落盘（实测夹具 +20B）。只有消息对象无效或克隆失败才记 null（跳过）。
function snapshotMessageVariables(chatArr) {
    if (!Array.isArray(chatArr)) return null;
    return chatArr.map(msg => {
        if (!msg || typeof msg !== 'object') return null;
        return safeDeepClone({
            variables: msg.variables ?? null,
            variables_initialized: msg.variables_initialized ?? null,
        });
    });
}

// 按快照回填每条消息的变量；返回是否有实际改动。
function restoreMessageVariables(chatArr, snapshot) {
    if (!Array.isArray(chatArr) || !Array.isArray(snapshot)) return false;
    let changed = false;
    const limit = Math.min(chatArr.length, snapshot.length);
    for (let i = 0; i < limit; i++) {
        const snap = snapshot[i];
        const msg = chatArr[i];
        if (!snap || !msg) continue;
        const current = { variables: msg.variables ?? null, variables_initialized: msg.variables_initialized ?? null };
        if (roughDeepEqual(current, snap)) continue;
        changed = true;
        // 快照为 null 表示"原本没有该字段"：删除而非写入 null，避免落盘时多出空字段。
        if (snap.variables === null) delete msg.variables;
        else msg.variables = safeDeepClone(snap.variables);
        if (snap.variables_initialized === null) delete msg.variables_initialized;
        else msg.variables_initialized = safeDeepClone(snap.variables_initialized);
    }
    return changed;
}

// —— 模拟发送的事件屏蔽（副作用治理）——
// 模拟在 SETTINGS_READY 里中止请求时，ST 核心会同步发出 GENERATION_STOPPED（stopGeneration）与
// GENERATION_ENDED（hideStopButton）。其它扩展无法区分"模拟"与"真实生成结束"，会因此触发各自的
// 生成后处理：聊天自动备份会把带临时消息的聊天写进备份库、LWB 定时任务会写入处理标记、剧情总结会
// 投影并保存隐藏状态……这些副作用全部来自这两个事件，因此模拟期间把它们的监听器表临时摘空。
// 只摘这两个事件；GENERATION_STARTED / CHAT_COMPLETION_SETTINGS_READY 必须保留，否则统计拿不到
// 最终上下文。屏蔽结束后按原引用还原；屏蔽期间新增的监听器在还原时保留（追加在原有监听器之后）。
const SIMULATE_SHIELD_TIMEOUT_MS = 30000;
let simulateShieldState = null; // Map<事件名, 原监听器数组|null>；null = 未屏蔽
let simulateShieldTimer = null;

function shieldGenerationEndEvents() {
    if (simulateShieldState) return; // 已在屏蔽中，防止重入覆盖已保存的监听器
    const saved = new Map();
    for (const event of [event_types.GENERATION_STOPPED, event_types.GENERATION_ENDED]) {
        if (!event) continue;
        const current = eventSource.events[event];
        saved.set(event, Array.isArray(current) ? current : null);
        eventSource.events[event] = []; // emit 在调用时对监听器表做 slice，置空后本次中止的 STOPPED/ENDED 不会触达任何第三方监听器
    }
    simulateShieldState = saved;
    // 兜底：若 finally 因管线被第三方卡死而迟迟不执行，到点强制解除屏蔽，
    // 避免真实生成的"生成后处理"被长期吞掉。
    // 注意：这里只解除屏蔽，**不**复位 simulateInProgress —— 若卡住的管线稍后才走到
    // SETTINGS_READY，仍需被拦截并 abort，绝不能放行成真实请求；代价是这次模拟期间
    // 「模拟发送」按钮保持禁用，直到管线结束（这正是期望的互斥行为）。
    clearTimeout(simulateShieldTimer);
    simulateShieldTimer = setTimeout(() => {
        Logger.warn('【模拟发送】事件屏蔽超时未解除（管线疑似卡住），已强制还原监听器');
        unshieldGenerationEndEvents();
    }, SIMULATE_SHIELD_TIMEOUT_MS);
}

function unshieldGenerationEndEvents() {
    if (!simulateShieldState) return;
    clearTimeout(simulateShieldTimer);
    simulateShieldTimer = null;
    const saved = simulateShieldState;
    simulateShieldState = null;
    for (const [event, prior] of saved) {
        const added = Array.isArray(eventSource.events[event]) ? eventSource.events[event] : [];
        eventSource.events[event] = (prior || []).concat(added);
    }
}

// 执行一次「模拟发送」：以当前上下文真实跑一遍组装管线并截获统计，随后 abort 掉真正的请求。
// 统计口径与真实发送完全一致（含 EJS 渲染），不消耗 token。
// ⚠️ 准确性说明（第六轮审查订正）：并非"零落盘"——管线运行期间第三方扩展可能触发落盘
// （ST-PT autosave_enabled=true 会在渲染后立即 checkAndSave；LWB 等定时器 save 亦可能落到窗口内），
// 此时注入的临时消息与未还原的元数据会被写盘，并由 ST 服务端备份机制（trySaveChat 的 backupChat）
// 永久留存；本插件自身在 finally 里**先还原、后落盘**（落盘守卫：chatId 同 + 消息数同 + 确有改动）。
// 除 chat_metadata 外，还会快照并还原：ST 全局变量、扩展注入表、各消息的 variables，
// 并用 chatId + 消息数守卫决定是否重新落盘，避免污染聊天文件或误写别的聊天。
async function runSimulateSend(rawContent) {
    if (simulateInProgress) return;

    const context = getContext();
    if (!context?.chatId) { toastr.warning('当前没有打开的聊天，无法模拟发送。'); return; }
    if (context.mainApi !== 'openai') {
        toastr.warning('「模拟发送」目前仅支持 Chat Completion（聊天补全）API。');
        return;
    }

    rawContent = String(rawContent ?? '');
    const trimmed = rawContent.trim();

    // 第三十五轮用户口径⑤：整个生成阶段显示"正在生成中"提示弹窗（finally 里必定收起）。
    // 原来这里改的是 `#tub-simulate-btn` 的文案 —— 该按钮已按用户口径②删除，改为独立遮罩。
    showSimulateProgress();

    const textareaEl = document.getElementById('send_textarea');
    const savedTextarea = textareaEl ? textareaEl.value : null;
    const chatArr = context.chat;
    const chatIdAtStart = context.chatId;
    simulateChatId = chatIdAtStart;
    const originalLength = Array.isArray(chatArr) ? chatArr.length : 0;

    // 快照 chat_metadata：真实跑一遍生成会触发核心与其它扩展（如 LWB）改写元数据
    // （tainted / lastInContextMessageId / LWB 快照等），还可能在管线中触发一次落盘。
    let savedMetadata = null;
    let metadataRef = null;
    // 快照 ST 全局变量（extension_settings.variables.global）：ST-Prompt-Template 的 updateTokens
    // 会写 LAST_SEND_TOKENS/CHARS，任何 setGlobalVar 也会写这里，必须一并还原。
    let savedGlobalVars = null;
    let globalVarsRef = null;
    // 快照扩展注入表（extension_prompts）：ST-PT 的 flushWIInjections / LWB 召回会写入深度注入条目。
    let savedExtPrompts = null;
    let extPromptsRef = null;
    // 快照各消息的 variables（ST-PT / JS-Slash-Runner 可能改写真实楼层变量）。
    let savedMessageVars = null;
    // 注入的临时消息对象引用（按引用移除，不依赖"最后一条是 user"）。
    let injectedMessageRef = null;

    simulateContent = rawContent;

    try {
        metadataRef = context.chatMetadata || null;
        savedMetadata = metadataRef ? safeDeepClone(metadataRef) : null;

        globalVarsRef = context.extensionSettings?.variables?.global || null;
        savedGlobalVars = globalVarsRef ? safeDeepClone(globalVarsRef) : null;

        extPromptsRef = context.extensionPrompts || null;
        savedExtPrompts = extPromptsRef ? { ...extPromptsRef } : null;

        savedMessageVars = snapshotMessageVariables(chatArr);

        // 清空输入框，避免用户草稿被当作 bias / 内容混入本次模拟组装
        if (textareaEl) {
            textareaEl.value = '';
            textareaEl.dispatchEvent(new Event('input', { bubbles: true }));
        }

        // 非空自定义内容 → 临时注入一条用户消息（仅内存，不 saveChat、不渲染 DOM），
        // 让世界书扫描与最终上下文都把它当作"下一条要发送的用户消息"。
        // 关键：还要复制"上一条消息的变量"。ST-Prompt-Template 会把每条消息的变量存在
        // variables/variables_initialized（按 swipe 索引的数组）里，EJS 的 getvar 等据此渲染；
        // 真实发送时 ST-PT 会 clonePreviousMessage 为这条新消息复制变量。若我们注入的消息不带变量，
        // EJS（MVU 类世界书）会以"空变量"渲染，导致统计偏低、与真实发送不一致。
        if (trimmed) {
            let prevVars = {};
            for (let i = chatArr.length - 1; i >= 0; i--) {
                const v = chatArr[i]?.variables?.[chatArr[i]?.swipe_id ?? 0];
                if (v != null) { prevVars = JSON.parse(JSON.stringify(v)); break; }
            }
            const mes = context.substituteParams(rawContent);
            const injectedMessage = {
                name: context.name1,
                is_user: true,
                is_system: false,
                send_date: Date.now(),
                mes,
                swipe_id: 0,
                swipes: [mes],
                variables: [prevVars],
                variables_initialized: [true],
                extra: {},
            };
            chatArr.push(injectedMessage);
            injectedMessageRef = injectedMessage;
        }

        // 屏蔽 GENERATION_STOPPED / GENERATION_ENDED：模拟中止请求时会发出这两个事件，
        // 第三方扩展（聊天自动备份、LWB 定时任务、剧情总结等）会误当作"真实生成结束"而触发生成后
        // 处理，可能把注入的临时消息写进备份、或在还原之后改写聊天状态。屏蔽覆盖整个模拟窗口，
        // 由本次 finally（或超时兜底）解除。
        shieldGenerationEndEvents();
        simulateInProgress = true;
        // automatic_trigger：跳过 sendMessageAsUser（不落盘、不渲染）；真实跑完整条组装管线。
        await context.generate('normal', { automatic_trigger: true });
    } catch (err) {
        // 预期路径：SETTINGS_READY 里 stopGeneration() 会让本次生成以 AbortError 结束，属正常
        Logger.debug('【模拟发送】生成结束（多为拦截中止）:', err?.message || err);
    } finally {
        simulateInProgress = false;
        // 解除事件屏蔽（若已由超时兜底解除，这里是空操作）；
        // 屏蔽期间 GENERATION_ENDED / STOPPED 的清理监听器（含本插件自己的）不会执行，手动兜底：
        // 模拟若在 SETTINGS_READY 之前被中止，pendingGenType 会残留 'normal'，必须清掉。
        unshieldGenerationEndEvents();
        pendingGenType = null;

        // 1) 精确移除临时消息（按对象引用定位，不依赖它仍是最后一条）
        if (injectedMessageRef) {
            const idx = Array.isArray(chatArr) ? chatArr.indexOf(injectedMessageRef) : -1;
            if (idx >= 0) chatArr.splice(idx, 1);
            injectedMessageRef = null;
        }

        // 2) 输入框：仅当仍是本次清空后的状态才恢复，避免覆盖用户期间的新输入
        if (textareaEl && savedTextarea !== null && textareaEl.value === '') {
            textareaEl.value = savedTextarea;
            textareaEl.dispatchEvent(new Event('input', { bubbles: true }));
        }

        // 3) 先判断改动，再整体还原内存状态
        let metadataChanged = false;
        let globalVarsChanged = false;

        if (metadataRef && savedMetadata) {
            metadataChanged = !roughDeepEqual(metadataRef, savedMetadata);
            restoreObjectFromSnapshot(metadataRef, savedMetadata);
        }
        if (globalVarsRef && savedGlobalVars) {
            globalVarsChanged = !roughDeepEqual(globalVarsRef, savedGlobalVars);
            restoreObjectFromSnapshot(globalVarsRef, savedGlobalVars);
            // ST-Prompt-Template 的 updateTokens 用 setTimeout + 异步分词，在管线之后才写
            // LAST_SEND_TOKENS/CHARS，晚于上面这次同步还原；因此再补一次延迟还原冲掉该异步写入。
            // 守卫：期间若已切聊天、开始新的模拟或开始真实生成，则放弃补还原，避免误伤。
            const deferredRef = globalVarsRef;
            const deferredSnap = savedGlobalVars;
            const deferredChatId = chatIdAtStart;
            setTimeout(() => {
                if (simulateInProgress) return;
                if (document.body?.dataset?.generating === 'true') return;
                if (getContext()?.chatId !== deferredChatId) return;
                if (roughDeepEqual(deferredRef, deferredSnap)) return;
                restoreObjectFromSnapshot(deferredRef, deferredSnap);
                try { saveSettingsDebounced?.(); } catch (e) { /* 忽略持久化异常 */ }
            }, 800);
        }
        if (extPromptsRef && savedExtPrompts) {
            for (const key of Object.keys(extPromptsRef)) {
                if (!Object.prototype.hasOwnProperty.call(savedExtPrompts, key)) delete extPromptsRef[key];
            }
            Object.assign(extPromptsRef, savedExtPrompts);
        }
        const messageVarsChanged = restoreMessageVariables(chatArr, savedMessageVars);

        // 4) UI 复位
        try { context.activateSendButtons?.(); } catch (e) { /* 忽略 UI 复位异常 */ }
        // 第三十五轮：收起"正在生成中"提示弹窗（与 showSimulateProgress 成对；finally 里必定执行）
        hideSimulateProgress();

        // 5) 落盘：管线中途可能已写过盘（tainted / lastInContextMessageId / 元数据），
        //    仅当聊天未切换、消息数未变、且确有改动时才重写，冲掉临时状态；否则跳过以防污染。
        const chatIdStillSame = getContext()?.chatId === chatIdAtStart;
        const lengthIntact = Array.isArray(chatArr) && chatArr.length === originalLength;
        if (metadataRef && savedMetadata && chatIdStillSame && lengthIntact
            && (metadataChanged || globalVarsChanged || messageVarsChanged)) {
            try { await context.saveChat?.(); } catch (e) { Logger.warn('【模拟发送】保存元数据失败:', e); }
        } else if (!chatIdStillSame || !lengthIntact) {
            Logger.warn('【模拟发送】检测到聊天切换或消息数变化，跳过落盘以防污染（内存状态已还原）。');
        }

        // 复位锚定栏（模拟按钮已删，但「模拟中…」的 busy 态与菜单项仍需重渲染）
        updateTokenStatsUI();
    }
}

// 锚点 id 解析：模拟锚定是字符串哨兵，真实锚点是消息下标数字
function parseAnchorId(raw) {
    return raw === SIM_ANCHOR_ID ? SIM_ANCHOR_ID : Number(raw);
}

// 渲染统计页顶部锚定栏：明细/对比切换 + 锚点菜单 + 两个图标签入口（第三十五轮重做）
// opts = { selectedId, latestId, defaultCombo, compareId }
//   selectedId  明细模式下为选中锚点、对比模式下为当前基准
//   defaultCombo 默认「基准 → 对比」组合 {baseId, compareId}
//   compareId   当前生效的对比锚点（用于组合下拉回显）
//
// ── 第三十五轮（用户口径①②③）────────────────────────────────────────────────────────
//   ① 原来的每条锚点一个 chip（`.tub-anchor-chip`）**合并成一个菜单**：菜单按钮显示**当前锚点**
//      （默认 = 最新 messageID），点开列出全部锚点 + 「模拟发送」动作项；菜单项文案统一为
//      `第 %{messageID} 楼`（见 anchorMenuItemLabel）。
//   ② 删掉原来右侧的「模拟发送」按钮 `#tub-simulate-btn`（模拟入口并入上面那个菜单）。
//   ③ 在原来模拟按钮的位置（行尾）新增**两个图标**：
//      `#tub-open-outline` → 打开「上下文目录 + 完整上下文」这一对窗口；
//      `#tub-open-chat-stats` → 打开「聊天」统计子窗。
//   这样锚定栏只剩两行：第一行（明细/对比切换 + 锚点菜单 + 两个图标），不再有乱七八糟的 chip 流。
function renderAnchorBar(list, opts = {}) {
    const el = document.getElementById('tub-anchor-bar');
    if (!el) return;
    const { selectedId = null, latestId = null, defaultCombo = null, compareId = null } = opts || {};

    const isDetail = statsViewMode === 'detail';
    const simulating = simulateInProgress;
    // 模拟锚点的显示编号（= 最后一条真实 messageID + 1；用户口径：`%{#N+1}`）
    const simDisplayId = simAnchorDisplayIndex(list);

    // 当前锚点的显示文案（= 菜单按钮上那一段）：明细取 selectedId 对应的项，取不到就用最新一条。
    const selectedItem = list.find(x => x.index === selectedId) || list[list.length - 1] || null;
    // 第三十六轮用户口径②：当前这条 messageID 有没有存下「完整上下文」快照。
    // 没有 → `#tub-open-outline` 置灰（`.is-disabled`）+ 点它只弹提示（不打开窗口）。
    const hasCtxDump = !!selectedItem && currentAnchorHasDump(selectedItem);

    // 行尾两个图标入口（用户口径③：占用原来「模拟发送」按钮的位置）。
    // 第三十六轮：`#tub-open-outline` 在"当前锚点没有快照"时置灰。
    // 只在明细视图出现 —— 对比视图不显示模拟按钮是既有口径，这里同样不给对比页塞入口。
    const entryIconsHtml = isDetail ? `
        <div class="tub-anchor-icons">
            <button type="button" class="tub-anchor-icon-btn${hasCtxDump ? '' : ' is-disabled'}" id="tub-open-outline"
                aria-disabled="${hasCtxDump ? 'false' : 'true'}"
                title="${hasCtxDump ? '打开「上下文目录 + 完整上下文」（左侧目录、右侧实际发送的全文）' : '该楼层没有存储完整上下文数据'}">${HC_ICON_OUTLINE}</button>
            <button type="button" class="tub-anchor-icon-btn" id="tub-open-chat-stats"
                title="打开「聊天统计详情」（实际发送范围 / AI 平均 tokens / 生成速度 / 历史折线）">${HC_ICON_CHAT}</button>
        </div>` : '';

    // 第三十六轮用户口径③：「明细 / 对比」切换**移到右上角**（原来是 head 里的第一项、靠左）。
    // 两个图标不再跟着 head 走，改挂到第二行的锚点选择框右侧（见下面 isDetail 分支）。
    let html = `
        <div class="tub-anchor-head">
            <div class="tub-view-toggle">
                <button class="tub-view-btn${isDetail ? ' active' : ''}" data-view="detail">明细</button>
                <button class="tub-view-btn${!isDetail ? ' active' : ''}" data-view="compare">对比</button>
            </div>
        </div>
    `;

    if (isDetail) {
        // 第三十六轮用户口径③：第二行 = 「选择楼层 [第 9 楼 ▾] [▤][💬]」
        //   · 原「锚定」二字改成「选择楼层」；
        //   · 两个图标**紧跟在锚点选择框右侧**（原来在行尾）、**去掉了边框与底色**（只剩图标本身）。
        const anchorText = selectedItem ? anchorMenuItemLabel(selectedItem, simDisplayId) : '暂无锚定';
        const anchorTip = selectedItem?.isSim
            ? (simulateContent.trim() ? `模拟内容：${simulateContent}` : '模拟内容：（空）')
            : (selectedItem ? `锚定时间 ${formatAnchorTime(selectedItem.stats?.at)}` : '');
        html += `
            <div class="tub-anchor-row">
                <span class="tub-anchor-row-label">选择楼层</span>
                <button type="button" class="tub-anchor-select${selectedItem?.isSim ? ' is-sim' : ''}${simulating ? ' busy' : ''}"
                    id="tub-anchor-select" title="${escapeHtmlText(anchorTip ? `选择要查看的锚定统计（${anchorTip}）` : '选择要查看的锚定统计')}">
                    <span class="tub-anchor-select-text">${escapeHtmlText(anchorText)}</span>
                </button>
                ${entryIconsHtml}
            </div>
        `;
        el.innerHTML = html;
        bindAnchorBarEvents(el, list, { latestId, defaultCombo, simDisplayId });
        return;
    }

    // 对比视图：组合下拉：枚举「基准 → 对比」的有序组合（2 个锚点 2 种、3 个锚点 6 种）。
    // 枚举顺序：先按基准（旧→新），同一基准下按对比（旧→新）。
    const combos = enumerateCompareCombos(list);
    // 第三十三轮用户口径③：`tub-anchor-baseline-select` 改成与 `tub-type-filter` 一样的**菜单按钮**
    // （原生 <select> 右侧的倒三角去不掉，故整体换掉），点开的浮层由 openTypeFilterMenu 渲染。
    // 第三十五轮用户口径⑦：组合文案里的「→」换成「：」（`第 8 楼：第 9 楼`），菜单项同样改。
    const comboText = (() => {
        const hit = combos.find(c => c.baseId === selectedId && c.compareId === compareId);
        if (hit) return `${anchorMenuItemLabel(hit.base, simDisplayId)}：${anchorMenuItemLabel(hit.compare, simDisplayId)}`;
        return combos.length ? '选择组合' : '暂无可对比组合';
    })();
    html += `
        <div class="tub-anchor-baseline">
            <span class="tub-anchor-baseline-label">对比组合</span>
            <button type="button" class="tub-anchor-baseline-select" id="tub-anchor-baseline-select" title="选择「基准：对比」组合，直接显示两个锚定的对比">
                <span class="tub-anchor-baseline-text">${escapeHtmlText(comboText)}</span>
            </button>
        </div>
    `;
    el.innerHTML = html;
    bindAnchorBarEvents(el, list, { latestId, defaultCombo, simDisplayId });
    bindBaselineMenu(el, combos, { selectedId, compareId, defaultCombo, simDisplayId });
}

// 锚定栏里的「明细/对比」切换 + 锚点菜单 + 两个图标签入口（两个视图共用的绑定）
function bindAnchorBarEvents(el, list, { latestId = null, simDisplayId = null } = {}) {
    el.querySelectorAll('.tub-view-btn').forEach(btn => {
        btn.onclick = () => {
            const v = btn.getAttribute('data-view');
            if (v === statsViewMode) return;
            statsViewMode = v;
            updateTokenStatsUI();
        };
    });

    bindAnchorMenu(el, list, { latestId, simDisplayId });

    // 两个图标签入口（用户口径③）：都按"开着就收起"的 toggle 语义
    const outlineBtn = el.querySelector('#tub-open-outline');
    if (outlineBtn) {
        outlineBtn.onclick = () => {
            const model = currentStatsModel();
            if (!model) return;
            // 第三十六轮用户口径②：当前 messageID 没存完整上下文 → 只提示，不打开窗口。
            // ⚠️ 用 `.is-disabled` 判断而不是按钮的 disabled 属性：这个按钮还要保留 hover/提示的可达性
            //    （disabled 的按钮在部分浏览器里不派发 click，提示就弹不出来了）。
            const item = getAnchoredStatsList().find(x => x.index === model.index && x.isSim === model.isSim);
            if (!currentAnchorHasDump(item)) {
                notify('warning', '无该历史请求的完整上下文数据存储');
                return;
            }
            toggleContextOutlineFromStats(model);
        };
    }
    const chatBtn = el.querySelector('#tub-open-chat-stats');
    if (chatBtn) {
        chatBtn.onclick = () => {
            const model = currentStatsModel();
            if (model) toggleChatStatsPopup(model, chatBtn);
        };
    }
}

// 当前锚点有没有「完整上下文」快照（第三十六轮用户口径②）。
// 键的口径与 openChatStatsPopup / openContextOutlinePopup 完全一致：`${chatId}|${anchorId}`，
//   真实锚点用消息下标、模拟锚定用哨兵 'sim'。拿不到 chatId 就按"没有"处理（宁可不给开，也不开会话空的窗）。
function currentAnchorDumpKey(item) {
    const chatId = getContext?.()?.chatId;
    if (!chatId || !item) return null;
    const anchorId = item.isSim ? SIM_ANCHOR_ID : item.index;
    if (anchorId === undefined || anchorId === null) return null;
    return contextDumpKey(chatId, anchorId);
}
function currentAnchorHasDump(item) {
    const key = currentAnchorDumpKey(item);
    return !!key && contextDumpStore.has(key);
}

// 当前明细视图正在展示的统计模型（供锚定栏的图标入口复用它去开子窗）。
// 与 renderTokenStatsContent 的入参同一套字段：{ index, isSim, totalTokens, chatTokens, wiTokens, otherTokens,
// statsObj, genType, stats }。拿不到锚点就返回 null（调用方什么都不做）。
function currentStatsModel() {
    const list = getAnchoredStatsList();
    if (!list.length) return null;
    const selectedId = statsPinnedIndex ?? list[list.length - 1].index;
    const selected = list.find(x => x.index === selectedId) || list[list.length - 1];
    if (!selected) return null;
    const { total = 0, chat = 0, wi = 0 } = selected.stats || {};
    return {
        index: selected.index,
        isSim: selected.isSim,
        totalTokens: total,
        chatTokens: chat,
        wiTokens: wi,
        otherTokens: Math.max(0, total - chat - wi),
        statsObj: selected.stats?.wiDetailedStats || {},
        genType: selected.stats?.genType || null,
        stats: selected.stats,
    };
}

// 锚点菜单（第三十五轮用户口径①②）：按钮 + 浮层菜单，交互与「类型过滤」完全一致（无倒三角、点别处收起）。
// 菜单项 = 全部锚定（`第 N 楼`，模拟锚定带虚线/异色区分）+ 末尾一条「模拟发送」动作项。
// 选中一个锚点 → 固定到它（选最新一条 = 恢复"自动跟随"）；点「模拟发送」→ 走 triggerSimulate()。
function bindAnchorMenu(el, list, { latestId = null, simDisplayId = null } = {}) {
    const trigger = el.querySelector('#tub-anchor-select');
    if (!trigger) return;
    const selectedId = list.find(x => x.index === (statsPinnedIndex ?? latestId))?.index ?? list[list.length - 1]?.index;
    const actions = list.map(item => ({
        value: String(item.index),
        text: anchorMenuItemLabel(item, simDisplayId),
        cls: item.isSim ? 'tub-type-menu-item-sim' : '',
    }));
    // 动作项用哨兵 value（不会与任何锚点 id 冲突：真实锚点是数字、模拟锚点是 'sim'）
    actions.push({ value: '__simulate__', text: '模拟发送', cls: 'tub-type-menu-item-action' });
    trigger.onclick = () => {
        if (openTypeMenuTrigger === trigger) { closeTypeFilterMenu(); return; }
        openTypeFilterMenu(trigger, {
            options: actions,
            current: selectedId === undefined ? null : String(selectedId),
            onPick: (value) => {
                if (value === '__simulate__') { triggerSimulate(); return; }
                const id = parseAnchorId(value);
                // 点最新锚点 = 恢复"自动跟随"；否则固定到该锚点
                statsPinnedIndex = (id === latestId) ? null : id;
                updateTokenStatsUI();
            },
        });
    };
}

// 对比组合菜单（第三十三轮）：按钮 + 浮层菜单，交互与「类型过滤」完全一致（无倒三角、点别处收起）。
function bindBaselineMenu(el, combos, { selectedId = null, compareId = null, defaultCombo = null, simDisplayId = null } = {}) {
    const trigger = el.querySelector('#tub-anchor-baseline-select');
    if (!trigger) return;
    if (!combos.length) { trigger.disabled = true; trigger.classList.add('is-empty'); return; }
    const current = `${selectedId}|${compareId}`;
    trigger.onclick = () => {
        // 再点触发器 = 收起（与类型过滤同一套行为）
        if (openTypeMenuTrigger === trigger) { closeTypeFilterMenu(); return; }
        openTypeFilterMenu(trigger, {
            // 用户口径⑦：「→」换成「：」——组合文案与菜单项一起改，两处口径必须一致
            options: combos.map(({ baseId, compareId: cmpId, base, compare }) =>
                [`${baseId}|${cmpId}`, `${anchorMenuItemLabel(base, simDisplayId)}：${anchorMenuItemLabel(compare, simDisplayId)}`]),
            current,
            onPick: (value) => {
                const [rawBase, rawCmp] = String(value).split('|');
                const baseId = parseAnchorId(rawBase);
                const cmpId = parseAnchorId(rawCmp);
                // 选回默认组合 = 恢复"自动跟随默认"；否则固定该组合
                if (defaultCombo && baseId === defaultCombo.baseId && cmpId === defaultCombo.compareId) {
                    statsBaselineIndex = null;
                    statsCompareIndex = null;
                } else {
                    statsBaselineIndex = baseId;
                    statsCompareIndex = cmpId;
                }
                updateTokenStatsUI();
            },
        });
    };
}


// ==================== 类型过滤：菜单（替代原生 <select>） ====================
// 触发按钮沿用原 id（#tub-type-filter / #tub-cmp-type-filter，方便定位与测试）；点开的浮层菜单挂在
// **外层弹窗**直下，因此不受内容区滚动/裁切影响。菜单位置默认落在触发器的左下角（左边缘对齐触发器左边缘、
// 向下展开），越界时自动内收/上翻，保证始终完整可见。
// 菜单项只列「当前数据里真实存在的类型」——没有 EJS 条目就不显示 EJS 选项（available 由调用方算好）。
const TYPE_FILTER_ORDER = ['ejs', 'dynamic', 'constant'];
// 第三十六轮用户口径④：类型文案统一成"灯"的说法 ——
//   constant → **蓝灯**（原来是「常量」，条目详情窗里同一个类型写作「常驻」，一并统一）
//   dynamic  → **绿灯**（原来是「动态」）
//   ejs      → EJS（不动）
// ⚠️ 只改**显示文案**，内部 key（'constant' / 'dynamic' / 'ejs'）与 CSS 类名一律不动 ——
//   它们被统计口径、快照字段、离线夹具大量引用，改 key 会连带炸一片。
//   同时因为"蓝灯/绿灯"是颜色语义，条目详情窗的类型徽标、饼图图例、对比表都跟着走这一张表。
const TYPE_FILTER_LABELS = { all: '所有', ejs: 'EJS', dynamic: '绿灯', constant: '蓝灯' };
let openTypeMenuEl = null;        // 当前打开的菜单元素（同一时刻只允许一个）
let openTypeMenuTrigger = null;   // 该菜单的触发器（再点触发器 = 收起）
let openTypeMenuCleanup = null;   // 关闭时要执行的解绑动作

// 组装菜单项：永远有「所有」，其余按固定顺序只保留实际存在的类型
function typeFilterOptionsOf(available) {
    return [['all', TYPE_FILTER_LABELS.all]]
        .concat(TYPE_FILTER_ORDER.filter(t => available?.has?.(t)).map(t => [t, TYPE_FILTER_LABELS[t]]));
}

// 关闭菜单（幂等）
function closeTypeFilterMenu() {
    if (openTypeMenuCleanup) { try { openTypeMenuCleanup(); } catch (e) { /* 忽略 */ } openTypeMenuCleanup = null; }
    if (openTypeMenuEl) { openTypeMenuEl.remove(); openTypeMenuEl = null; }
    if (openTypeMenuTrigger) { openTypeMenuTrigger.classList.remove('open'); openTypeMenuTrigger = null; }
}

// 打开菜单：{ options: [[value,text],...], current, onPick(value) }
// host = 菜单挂载的窗口（默认主弹窗）：完整上下文里的「世界书消息条目」子窗会传自己的元素，
// 否则菜单会被挂到主弹窗上（坐标是相对挂载窗口的 padding box 算的，挂错窗口就会跑到另一个窗口里）。
// options 既接受 `[value, text]` 数组，也接受 `{ value, text, cls }` 对象（第三十五轮：锚点菜单需要给
// 「模拟发送」动作项与模拟锚点项挂额外 class，才能与真实锚点项区分开）。
function normalizeMenuOptions(options) {
    return (options || []).map((o) => {
        if (Array.isArray(o)) return { value: o[0], text: o[1], cls: '' };
        if (o && typeof o === 'object') return { value: o.value, text: o.text, cls: o.cls || '' };
        return { value: o, text: o, cls: '' };
    });
}

function openTypeFilterMenu(triggerEl, { options, current, onPick, host = null } = {}) {
    closeTypeFilterMenu();
    const popup = host || document.getElementById('hide-helper-popup');
    if (!popup || !triggerEl) return;
    const menu = document.createElement('div');
    menu.className = 'tub-type-menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = normalizeMenuOptions(options).map(({ value: v, text: t, cls }) =>
        `<button type="button" class="tub-type-menu-item${v === current ? ' active' : ''}${cls ? ` ${cls}` : ''}" data-value="${escapeHtmlText(v)}">${escapeHtmlText(t)}</button>`).join('');
    popup.appendChild(menu);           // 先入 DOM 才能测量尺寸
    openTypeMenuEl = menu;
    openTypeMenuTrigger = triggerEl;
    triggerEl.classList.add('open');

    // 定位：left/top 是相对弹窗 padding box 的（绝对定位子元素的包含块）。
    // ⚠️ 必须先把 rect 差值换算回弹窗**自身（未缩放）坐标系**：弹窗的入场动画 `hhFadeIn` 带
    //    `transform: scale(0.95)`，动画未结束时 getBoundingClientRect 会小于布局尺寸
    //    （自动化/后台页面里文档时间轴冻结，该动画会长期停在起始帧，实测常驻 0.95 缩放）；
    //    直接用 rect 差值会把触发器的位置算小 5%，菜单会歪十几像素、压在触发器上。
    //    换算方式与 positionEntryPopup 的 layoutBox 同源：视觉长度 ÷ 缩放比例 = 布局长度。
    const pr = popup.getBoundingClientRect();
    const tr = triggerEl.getBoundingClientRect();
    const sx = popup.offsetWidth ? pr.width / popup.offsetWidth : 1;
    const sy = popup.offsetHeight ? pr.height / popup.offsetHeight : 1;
    const toLayout = (v, s) => (s ? v / s : v);
    const bw = popup.clientLeft || 0;
    const M = 8, GAP = 4;
    const menuW = menu.offsetWidth, menuH = menu.offsetHeight;
    const boxW = popup.clientWidth, boxH = popup.clientHeight;
    let left = toLayout(tr.left - pr.left, sx) - bw;
    left = Math.max(M, Math.min(left, boxW - menuW - M));
    let top = toLayout(tr.bottom - pr.top, sy) - bw + GAP;
    if (top + menuH > boxH - M) {
        // 下方放不下：翻到触发器上方；仍越界则钳制在弹窗内
        top = toLayout(tr.top - pr.top, sy) - bw - menuH - GAP;
        top = Math.max(M, Math.min(top, boxH - menuH - M));
    }
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;

    menu.addEventListener('click', (ev) => {
        const item = ev.target?.closest?.('.tub-type-menu-item');
        if (!item) return;
        ev.stopPropagation();
        const value = item.getAttribute('data-value');
        closeTypeFilterMenu();
        onPick?.(value);
    });

    // 点击别处 / ESC / 滚动 / 缩放 → 关闭
    const onDocDown = (ev) => {
        if (menu.contains(ev.target) || triggerEl === ev.target || triggerEl.contains(ev.target)) return;
        closeTypeFilterMenu();
    };
    const onKey = (ev) => { if (ev.key === 'Escape') closeTypeFilterMenu(); };
    const onScrollOrResize = () => closeTypeFilterMenu();
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onScrollOrResize);
    const contentEl = popup.querySelector('.popup-tabs-content');
    contentEl?.addEventListener('scroll', onScrollOrResize, { passive: true });
    openTypeMenuCleanup = () => {
        document.removeEventListener('mousedown', onDocDown, true);
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('resize', onScrollOrResize);
        contentEl?.removeEventListener('scroll', onScrollOrResize);
    };
}

// 触发器按钮的通用点击行为：已展开 → 收起；否则按当前可用类型打开菜单
// host：菜单挂载窗口（透传给 openTypeFilterMenu；子窗的过滤按钮必须传自己的窗口，否则菜单会挂到主弹窗上）
function toggleTypeFilterMenu(triggerEl, { available, current, onPick, host = null } = {}) {
    if (openTypeMenuTrigger === triggerEl) { closeTypeFilterMenu(); return; }
    openTypeFilterMenu(triggerEl, { options: typeFilterOptionsOf(available), current, onPick, host });
}

// 触发器文案随当前选择更新（按钮 HTML 由各视图渲染，这里只改文字，避免整块重绘丢失菜单）
function updateTypeFilterTriggerLabel(id, value) {
    const btn = document.getElementById(id);
    const textEl = btn?.querySelector('.tub-type-filter-text');
    if (textEl) textEl.textContent = TYPE_FILTER_LABELS[value] || TYPE_FILTER_LABELS.all;
}

// 对比视图：当前「世界书过滤」范围内**实际有差异**的类型集合（决定菜单里出现哪些类型）
function availableDiffTypes(diff, bookFilter) {
    const s = new Set();
    for (const g of (diff?.books || [])) {
        if (bookFilter && bookFilter !== 'all' && g.name !== bookFilter) continue;
        for (const r of (g.rows || [])) s.add(r.type);
    }
    return s;
}

// 渲染"对比"视图：只并列显示所选「基准 → 对比」两个锚点。
// 上方是总量与世界书构成对比表，下方是世界书条目差异表（按世界书分组）。
function renderCompareContent(list, baselineIndex, compareIndex) {
    const el = document.getElementById('tub-compare-section');
    if (!el) return;
    if (list.length < 2) {
        el.innerHTML = `<div class="tub-empty-state">需要至少 2 条锚定数据才能对比（当前 ${list.length} 条）。</div>`;
        return;
    }

    let basePos = list.findIndex(c => c.index === baselineIndex);
    if (basePos < 0) basePos = list.length - 1;
    // 对比锚点：默认取"列表中基准之外的最右一条"；无效/与基准相同则回退
    let cmpPos = list.findIndex(c => c.index === compareIndex);
    if (cmpPos < 0 || cmpPos === basePos) {
        cmpPos = -1;
        for (let i = list.length - 1; i >= 0; i--) {
            if (i !== basePos) { cmpPos = i; break; }
        }
    }
    if (cmpPos < 0) {
        el.innerHTML = `<div class="tub-empty-state">需要至少 2 条锚定数据才能对比（当前 ${list.length} 条）。</div>`;
        return;
    }

    const order = [basePos, cmpPos]; // 基准列固定在最左，对比列在其右
    const summaries = list.map(c => getAnchorSummary(c.stats));
    const base = summaries[basePos];
    const heads = order.map(oi => list[oi]);

    // 对比视图的列头：真实锚点显示 `#N`，模拟锚定同样显示"下一条 messageID"（`#N+1`，与明细 chips 同口径）
    const simDisplayId = simAnchorDisplayIndex(list);
    const headCells = heads.map((c, k) => {
        const idText = c.isSim ? `#${simDisplayId}` : `#${c.index}`;
        const baseTag = k === 0 ? '<span class="tub-cmp-baseline-tag">基准</span>' : '<span class="tub-cmp-compare-tag">对比</span>';
        return `<th class="tub-cmp-col-head"><div class="tub-cmp-col-id">${idText}${baseTag}</div><div class="tub-cmp-col-time">${formatAnchorTime(c.stats?.at)}</div></th>`;
    }).join('');

    // 数值行：值 + 相对基准的 Δ（概览行附带占比）
    const numRow = (label, key, withPct = false) => {
        const cells = order.map((oi, k) => {
            const s = summaries[oi];
            const v = s[key];
            const delta = k === 0 ? '' : fmtDelta(v, base[key]);
            const pct = withPct && s.total > 0 ? `<small>${((v / s.total) * 100).toFixed(1)}%</small>` : '';
            return `<td class="tub-cmp-cell">${v}${pct}${delta}</td>`;
        }).join('');
        return `<tr><th class="tub-cmp-label">${label}</th>${cells}</tr>`;
    };

    const totalsTable = `
        <table class="tub-compare-table">
            <thead><tr><th class="tub-cmp-label"></th>${headCells}</tr></thead>
            <tbody>
                ${numRow('总计', 'total')}
                ${numRow('聊天', 'chat', true)}
                ${numRow('世界书', 'wi', true)}
                ${numRow('其他', 'other', true)}
                <tr class="tub-cmp-sep"><th class="tub-cmp-label"></th>${order.map(() => '<td class="tub-cmp-cell"></td>').join('')}</tr>
                ${numRow(TYPE_FILTER_LABELS.constant, 'constant')}
                ${numRow(TYPE_FILTER_LABELS.dynamic, 'dynamic')}
                ${numRow('EJS', 'ejs')}
                ${numRow('已激活条目', 'entries')}
                ${numRow('已匹配条目', 'matched')}
            </tbody>
        </table>
    `;

    // 条目差异结构（按世界书分组，仅含有差异的条目）。
    // 注意：diff/vals 的列索引空间是 heads（基准在前、对比在后）；totalsTable 的 order 是 list 下标空间。
    const diff = buildEntryDiff(heads, 0);
    const bookNames = diff.books.map(b => b.name);

    // 校验过滤状态（结构变化后可能失效）
    const TYPE_KEYS = new Set(['all', 'ejs', 'dynamic', 'constant']);
    if (!TYPE_KEYS.has(statsCmpTypeFilter)) statsCmpTypeFilter = 'all';
    if (statsCmpBookFilter !== 'all' && !bookNames.includes(statsCmpBookFilter)) statsCmpBookFilter = 'all';

    const multiBook = bookNames.length >= 2;
    if (!multiBook) statsCmpBookFilter = 'all'; // 仅一个世界书有差异时无需按世界书过滤

    // 类型过滤的可用集合：当前「世界书过滤」范围内**实际有差异**的类型（没有 EJS 差异就不列 EJS）。
    // 也顺带把"选了某类型、但换了世界书后该类型已不存在"的状态回退成「所有」，避免列表永远空白。
    const cmpAvailableTypes = availableDiffTypes(diff, statsCmpBookFilter);
    if (statsCmpTypeFilter !== 'all' && !cmpAvailableTypes.has(statsCmpTypeFilter)) statsCmpTypeFilter = 'all';

    // 类型过滤触发器（按钮；展开的菜单由 openTypeFilterMenu 动态挂到外层弹窗上）
    const typeFilterHtml = (id) => `
        <button type="button" class="tub-type-filter" id="${id}" title="按类型过滤">
            <span class="tub-type-filter-text">${TYPE_FILTER_LABELS[statsCmpTypeFilter] || TYPE_FILTER_LABELS.all}</span>
        </button>`;

    // 差异子标题：只有一个世界书有差异时，把类型过滤放到子标题最右
    const subFilterHtml = (diff.anyDiff && !multiBook)
        ? `<span class="tub-entries-tools">${typeFilterHtml('tub-cmp-type-filter')}</span>`
        : '';
    const subHeadingHtml = `
        <div class="tub-cmp-subheading tub-title-text tub-cmp-subheading-row">
            <span>世界书条目差异</span>${subFilterHtml}
        </div>`;

    // 世界书菜单栏：>=2 个世界书有差异时显示；右侧放类型过滤（不放排序）
    const bookBarHtml = (diff.anyDiff && multiBook)
        ? `<div class="tub-cmp-book-bar">
                <div class="tub-book-filters">
                    <button class="tub-book-btn${statsCmpBookFilter === 'all' ? ' active' : ''}" data-book="all">所有条目</button>
                    ${bookNames.map(b => `<button class="tub-book-btn${statsCmpBookFilter === b ? ' active' : ''}" data-book="${escapeHtmlText(b)}">${escapeHtmlText(b)}</button>`).join('')}
                </div>
                <span class="tub-entries-tools">${typeFilterHtml('tub-cmp-type-filter')}</span>
            </div>`
        : '';

    el.innerHTML = `
        <div class="tub-cmp-subheading tub-title-text">总量与世界书构成</div>
        ${totalsTable}
        ${subHeadingHtml}
        ${bookBarHtml}
        ${renderEntryDiffTable(diff, heads, [0, 1], statsCmpBookFilter, statsCmpTypeFilter, simDisplayId)}
    `;

    // 世界书菜单栏事件
    el.querySelectorAll('.tub-cmp-book-bar .tub-book-btn').forEach(btn => {
        btn.onclick = () => {
            statsCmpBookFilter = btn.getAttribute('data-book');
            updateTokenStatsUI();
        };
    });

    // 类型过滤：菜单项（只列当前世界书过滤范围内实际有差异的类型）
    const tf = el.querySelector('#tub-cmp-type-filter');
    if (tf) {
        tf.onclick = () => toggleTypeFilterMenu(tf, {
            available: cmpAvailableTypes,
            current: statsCmpTypeFilter,
            onPick: (value) => {
                statsCmpTypeFilter = value;
                updateTokenStatsUI();   // 重新渲染整块对比视图，按钮文案也随之更新
            },
        });
    }

    // 点击条目差异表里的条目 → 打开条目详情子窗（按"书名 + UID/条目名"定位）。
    // 行序与 renderEntryDiffTable 一致（同一套过滤函数），因此用序号对齐。
    const visibleRows = applyEntryDiffFilters(diff, statsCmpBookFilter, statsCmpTypeFilter)
        .flatMap(g => g.rows);
    el.querySelectorAll('.tub-cmp-entry-row').forEach((row, i) => {
        row.onclick = () => {
            const rec = visibleRows[i] || null;
            openEntryDetailPopup({
                book: row.getAttribute('data-book'),
                name: row.getAttribute('data-name'),
                uid: row.getAttribute('data-uid'),
                type: row.getAttribute('data-type'),
                tokens: rec ? (rec.vals[1] ?? null) : null,
            });
        };
    });
}

// 构建"条目差异"结构：按世界书分组，仅保留各锚点间真正有差异的条目。
// 行键 = 书名 + UID（缺 UID 时回退"书名 + 条目名"，兼容旧锚点）：同一本书里的同名条目按 UID 分开。
// 返回 { books:[{name, change, rows:[{name,uid,type,vals,present,maxAbs}]}], anyEntries, anyDiff }
function buildEntryDiff(cols, basePos) {
    // 每个锚点 -> Map(key -> { book, name, uid, type, tokens })
    const maps = cols.map(c => {
        const m = new Map();
        const det = c.stats?.wiDetailedStats || {};
        for (const b in det) {
            const book = det[b] || {};
            const push = (list, type) => {
                for (const e of (list || [])) {
                    const uid = e?.uid ?? null;
                    // UID 存在 → 用 UID 作键（同名条目可分开）；否则回退条目名（旧锚点）
                    const key = (uid !== null && uid !== undefined)
                        ? `${b}\u0000u${uid}`
                        : `${b}\u0000n${e?.name ?? ''}`;
                    m.set(key, { book: b, name: e?.name ?? '', uid, type, tokens: Number(e?.tokens) || 0 });
                }
            };
            push(book.ejs, 'ejs');
            push(book.dynamic, 'dynamic');
            push(book.constant, 'constant');
        }
        return m;
    });

    // 并集：key -> 元信息（书名/条目名/UID/类型）
    const meta = new Map();
    maps.forEach(m => m.forEach((v, k) => { if (!meta.has(k)) meta.set(k, v); }));
    const anyEntries = meta.size > 0;

    const byBook = new Map();
    for (const [k, info] of meta) {
        // present[i]：该锚点本次发送是否"激活"了此条目（即是否出现在该锚点的 wiDetailedStats 里）。
        // 注意：wiDetailedStats 里的条目**本身就已经是激活条目**（来自 WORLDINFO_SCAN_DONE 的 activated），
        // 所以"不在其中"= 未激活；"在其中但 tokens=0"= 已激活但未能在上下文中定位到内容 = 未匹配。
        const present = maps.map(m => m.has(k));
        const vals = maps.map(m => m.get(k)?.tokens || 0);
        // 第三十三轮用户口径①：**两侧都"未匹配 / 未激活"的条目直接不显示**。
        //   · 未激活 = 该锚点的 wiDetailedStats 里根本没有这条（present=false）
        //   · 未匹配 = 有这条但 tokens=0（激活了却没能在实际发送的上下文里定位到内容）
        // 这两者都是"没算到 token"，并排列出来只会是两格「未激活 / 未匹配」，对对比没有信息量。
        const isBlankCell = (i) => !present[i] || vals[i] === 0;
        if (present.every((_, i) => isBlankCell(i))) continue;
        // 只要各锚点的状态（未激活=null / 未匹配=0 / 具体数值）存在差异就纳入对比
        const sig = vals.map((v, i) => (present[i] ? v : null));
        if (new Set(sig).size <= 1) continue;
        let maxAbs = 0;
        vals.forEach((v, i) => { if (i !== basePos) maxAbs = Math.max(maxAbs, Math.abs(v - vals[basePos])); });
        if (!byBook.has(info.book)) byBook.set(info.book, []);
        byBook.get(info.book).push({
            name: info.name,
            uid: info.uid,
            type: info.type,
            vals,
            present,
            maxAbs,
        });
    }

    // 类型顺序：EJS > 动态 > 常驻
    const TYPE_ORDER = { ejs: 0, dynamic: 1, constant: 2 };
    const books = [...byBook.entries()].map(([name, rows]) => ({
        name,
        rows: rows.sort((a, b) =>
            (TYPE_ORDER[a.type] - TYPE_ORDER[b.type]) || (b.maxAbs - a.maxAbs) || a.name.localeCompare(b.name)),
        change: rows.reduce((s, r) => s + r.maxAbs, 0),
    })).sort((a, b) => (b.change - a.change) || a.name.localeCompare(b.name));

    return { books, anyEntries, anyDiff: books.length > 0 };
}

// 按当前过滤状态筛出要显示的差异分组（渲染与点击绑定共用，保证行序一致）。
function applyEntryDiffFilters(diff, bookFilter, typeFilter) {
    let groups = diff.books;
    if (bookFilter && bookFilter !== 'all') groups = groups.filter(g => g.name === bookFilter);
    return groups
        .map(g => ({ ...g, rows: (typeFilter === 'all' ? g.rows : g.rows.filter(r => r.type === typeFilter)) }))
        .filter(g => g.rows.length);
}

// 渲染条目差异子表：按世界书分组的行，组内按 EJS > 动态 > 常驻 排序。
// diff 由 buildEntryDiff 生成；bookFilter/typeFilter 生效于当前视图。
// cols 为"本次对比显示的列"（基准在前、对比在后），order 为其在 cols 中的下标（此处恒为 [0,1]）。
// simDisplayId：模拟锚定的显示编号（= 最后一条真实 messageID + 1，由调用方按**整份锚点列表**算好传入；
//   不要在这里用 cols 现算——cols 只有两列，基准是模拟锚点时算出来的数会偏小）。
// 行带 book/name 属性并挂 .tub-cmp-entry-row，点击可打开条目详情子窗。
function renderEntryDiffTable(diff, cols, order, bookFilter, typeFilter, simDisplayId = null) {
    if (!diff.anyEntries) return `<div class="tub-empty-state">无世界书条目</div>`;
    if (!diff.anyDiff) return `<div class="tub-empty-state">各锚点的世界书条目完全一致</div>`;

    const groups = applyEntryDiffFilters(diff, bookFilter, typeFilter);

    if (!groups.length) return `<div class="tub-empty-state">没有符合条件的条目</div>`;

    const body = groups.map(g => {
        const bookRow = `<tr class="tub-cmp-book-row"><th class="tub-cmp-book-name" colspan="${order.length + 1}">${escapeHtmlText(g.name)}</th></tr>`;
        const entryRows = g.rows.map(it => `
            <tr class="tub-cmp-entry-row" data-book="${escapeHtmlText(g.name)}" data-name="${escapeHtmlText(it.name)}" data-uid="${it.uid ?? ''}" data-type="${it.type}" title="点击查看条目详情">
                <th class="tub-cmp-label tub-cmp-entry-name" title="${escapeHtmlText(it.name)}"><span class="tub-stat-color-${it.type}">${escapeHtmlText(it.name)}</span></th>
                ${order.map((oi, k) => {
                    const v = it.vals[oi];
                    const delta = k === 0 ? '' : fmtDelta(v, it.vals[order[0]]);
                    // 区分"未激活"（该锚点本次未激活此条目）与"未匹配"（已激活但未在上下文中定位到内容）
                    let cell;
                    if (!it.present[oi]) {
                        cell = `<span class="tub-cmp-unmatched" title="该锚点本次发送未激活此条目">未激活</span>`;
                    } else if (v === 0) {
                        cell = `<span class="tub-cmp-unmatched" title="该锚点已激活此条目，但未能在实际发送的上下文中定位到其内容">未匹配</span>`;
                    } else {
                        cell = `${v}`;
                    }
                    return `<td class="tub-cmp-cell${v === 0 ? ' tub-cmp-zero' : ''}">${cell}${delta}</td>`;
                }).join('')}
            </tr>
        `).join('');
        return bookRow + entryRows;
    }).join('');

    return `
        <table class="tub-compare-table tub-cmp-entry-table">
            <thead><tr><th class="tub-cmp-label tub-cmp-entry-name-head">条目</th>${order.map(oi => `<th class="tub-cmp-col-head">#${cols[oi].isSim ? (simDisplayId ?? simAnchorDisplayIndex(cols)) : cols[oi].index}</th>`).join('')}</tr></thead>
            <tbody>${body}</tbody>
        </table>
    `;
}

// 把"已激活条目"列表按"真实插入点"（来自 position/depth，见 entryContextAnchor）分组。
// 每组 = 一个插入锚点（"世界书·前置" / "在聊天 #k 之前插入" / "在末尾" …）；排序键由显示层按 kind+序号重推
// （`contextAnchorOrderKey`，**不用**锚点里存下的旧 key，见 §2.24-R2），每组另带 `mesid`（对应哪条聊天消息）
// 与 `side`（'before' = 条目位于该消息之前 / 'after' = 之后），供渲染层把"之前"的条目排到 `#N` 标记行上方。
// 未匹配（无 anchor 或未命中）的条目归入 unmatched。
// 兼容旧锚点：这些记录写入时还没记 `anchor`（只有命中位置 pos）。此时**不要**当作"未匹配"，
// 而是退回按 pos 的上下文槽位分组，标为"发送顺序第 N 条消息"，避免把已匹配条目误显示成未匹配。
function groupEntriesByAnchor(entries, edges) {
    const groups = new Map();
    const unmatched = [];
    for (const e of (entries || [])) {
        if (!e.matched) { unmatched.push(e); continue; }
        let anchor = e.anchor;
        if (!anchor) {
            // 旧锚点回退：pos = 槽位序号 * 1e6 + 字符偏移
            const si = (e.pos === null || e.pos === undefined) ? null : Math.floor(e.pos / 1e6);
            if (si === null) { unmatched.push(e); continue; }
            anchor = { key: 1000 + si, label: `发送顺序第 ${si + 1} 条消息（旧数据，按命中位置）`, badge: '旧' };
        }
        const g = groups.get(anchor.key);
        if (g) { g.items.push(e); continue; }
        // anchor 一并带上：标题文案由 contextAnchorView(anchor, edges) 推导为聊天里的 mesIDDisplay 序号
        groups.set(anchor.key, { key: anchor.key, anchor, label: anchor.label, badge: anchor.badge, items: [e] });
    }
    // ⚠️ 排序**不能**用锚点里存下的 key（旧锚点的 key 是旧方案：后置=1、深度=100+b，会把"后置"排到
    //    深度注入前面——用户看到的 `#0 → #5 → #2 → #5`）。这里统一按 kind + 序号在显示层重推顺序键。
    // 每个分组同时带上：
    //   mesid 该组"对应哪条聊天消息"（`contextAnchorMesid`；定不出为 null）
    //   side  'before' = 这组条目位于消息 mesid **之前**；'after' = 位于其后（末尾/深度 0）
    // 渲染层据此把"之前"的条目排在 `#N` 标记行**上方**、"之后"的排在下方（用户口径见 §2.24-R3）。
    const list = [...groups.values()]
        .map(g => {
            const mesid = contextAnchorMesid(g.anchor, edges);
            // 新锚点：区块"在聊天之前 / 之后"由捕获时刻算好的 anchor.after 决定（顺序可被用户改动）；
            // 旧锚点（after 未定义）沿用 kind 表。
            const afterFlag = g.anchor?.after;
            const isAfter = mesid === null || afterFlag === true
                || (afterFlag === undefined && CTX_ANCHOR_AFTER_KINDS.includes(g.anchor?.kind));
            return {
                ...g, mesid,
                // 'before' = 这组条目位于消息 mesid **之前**（渲染在 `#N` 标记行上方）；'after' = 位于其后
                // 定不出序号的块（出口/更早的旧格式，mesid=null）保持"标记行在上、条目在下"的老样子
                side: isAfter ? 'after' : 'before',
                // 紧邻在注入点**前面**的那条消息（深度注入夹在 predMesid 与 mesid 之间）→ 两侧 messageID 都要标出来
                predMesid: (!isAfter && mesid !== null && edges?.prev?.has?.(mesid)) ? (edges.prev.get(mesid) ?? null) : null,
                orderKey: contextAnchorOrderKey(g.anchor, mesid, edges),
            };
        })
        .sort((a, b) => (a.orderKey - b.orderKey)
            || String(a.anchor?.kind || '').localeCompare(String(b.anchor?.kind || ''))
            || String(a.label || '').localeCompare(String(b.label || '')));
    return { groups: list, unmatched };
}

// 枚举对比视图的「基准 → 对比」有序组合（N 个锚点 → N*(N-1) 种；2 个锚点 2 种、3 个锚点 6 种）。
function enumerateCompareCombos(list) {
    const combos = [];
    for (const base of (list || [])) {
        for (const cmp of (list || [])) {
            if (base.index === cmp.index) continue;
            combos.push({ baseId: base.index, compareId: cmp.index, base, compare: cmp });
        }
    }
    return combos;
}

// ⓪ 条目列表排序（纯函数；主弹窗明细视图 ↔ 世界书消息条目子窗共用，CHANGELOG §2.30）：
//    · mode='context' → 按**显示层推导**的"上下文顺序键"（见 contextAnchorOrderKey；**不用**锚点里存下的
//      旧 key，否则旧锚点会把"后置"排到深度注入前面）；无 anchor 的老数据退回按命中槽位序号排。
//    · 否则 → 默认顺序：EJS > 动态 > 常驻，同类型按 token 降序。
//    未匹配的一律排在后面、彼此按条目名排序（与抽函数前逐字节一致）。
const ENTRY_TYPE_ORDER = { 'ejs': 1, 'dynamic': 2, 'constant': 3 };
function sortEntriesByMode(combined, mode, edges) {
    const ctxKey = (e) => {
        if (e.anchor) return contextAnchorOrderKey(e.anchor, contextAnchorMesid(e.anchor, edges), edges);
        if (e.pos === null || e.pos === undefined) return Infinity;
        return 20000 + Math.floor(e.pos / 1e6);
    };
    (combined || []).sort((a, b) => {
        if (a.matched !== b.matched) return a.matched ? -1 : 1;
        if (mode === 'context') {
            // 按"真实插入点"从上到下排序（同锚点内按 token 降序），供分组标题行按序出现。
            if (a.matched) {
                const ak = ctxKey(a), bk = ctxKey(b);
                if (ak !== bk) return ak - bk;
                return (b.tokens - a.tokens) || String(a.name).localeCompare(String(b.name));
            }
            return String(a.name).localeCompare(String(b.name));
        }
        // 默认顺序：EJS > 动态 > 常驻，同类型按 token 降序
        if (a.matched) {
            if (a.type !== b.type) return ENTRY_TYPE_ORDER[a.type] - ENTRY_TYPE_ORDER[b.type];
            return b.tokens - a.tokens;
        }
        return String(a.name).localeCompare(String(b.name));
    });
    return combined;
}

// ── 「已激活条目」列表的共用渲染（主弹窗明细视图 ↔ 世界书消息条目子窗，CHANGELOG §2.30）──
// 抽出的原因：左侧「世界书条目来源」子弹窗要复刻同一套列表（同样的行样式、同样的"位置标记行"口径），
// 各写一份必然漂移，故把三块**纯**渲染逻辑提出来共用（调用方各自持有自己的容器与状态）。

// ① 条目行构建器：返回 html(e) 与"行 → 原始记录"表（点击行时按 data-rid 取回 uid/type 等原始记录）。
//    booksCount/bookFilter 决定行尾要不要补书名标签；alwaysShowBook = 行尾**一律**括号显示来源世界书
//    （世界书消息子窗 / 上下文目录子窗用：这两处的条目来自哪本书必须一眼可见，不随筛选/书目数量隐藏）；
//    absoluteMax 是行内进度条的分母（本列表内最大命中量）。
function createEntryRowBuilder({ booksCount = 1, bookFilter = 'all', absoluteMax = 1, alwaysShowBook = false, rowTitle = '点击查看条目详情', insertMeta = false, insertPos = true } = {}) {
    const records = new Map();
    let seq = 0;
    // 条目行第二行「插入位置 · 顺序」（第二十七轮 R5 新增；R6 按用户口径改文案与排版）：
    //   · 插入位置 = `entryInsertPositionText({position, depth, role})` —— 与「条目详情」窗**同一套文案**
    //     （角色定义前/后、作者注释前/后、示例消息前/后、系统/AI/用户 @D n）；
    //   · 顺序 = ST 世界书条目的 `order`（与「条目详情」窗的「顺序」行同值）；
    //   · 字段缺失（旧快照 / 调用方没给）就整行不渲染 —— 宁可没有这一行，也不显示一个错的插入位置。
    //   · R6 用户口径：**去掉"插入位置 / 顺序"这两个标题词**（只显示值本身）、**顺序必须看得见**
    //     （原先两段拼一行 + nowrap + 省略号，位置文案一长就把顺序截掉了）；整行做成两列：
    //     位置在左（长了先截它）、顺序在右（小 chip，永远完整、右边缘与上一行的 tokens 对齐）。
    //     两个值的口径挪进各自的 `title`（悬停可见）。
    // ⚠️ 只有 `insertMeta: true` 的调用方（上下文目录 / 世界书消息条目子窗）才展开；主面板保持紧凑。
    // 第三十二轮（用户口径）：`insertPos: false` 时**只隐藏「插入位置」**、保留右侧的顺序 chip。
    //   用途 = 「条目来源」子窗（`#hide-helper-wi-msg-popup`）：那里的条目**全都属于同一条消息**，
    //   插入位置每一行都一样、纯冗余；顺序才是个体差异。
    const metaLine = (e) => {
        if (!insertMeta) return '';
        const hasPos = insertPos && e.position !== null && e.position !== undefined && Number.isFinite(Number(e.position));
        const hasOrder = e.order !== null && e.order !== undefined && Number.isFinite(Number(e.order));
        if (!hasPos && !hasOrder) return '';
        const posText = hasPos ? entryInsertPositionText({ position: Number(e.position), depth: e.depth, role: e.role }) : '';
        const orderText = hasOrder ? String(Number(e.order)) : '';
        const posHtml = hasPos
            ? `<span class="tub-nli-pos" title="插入位置：${escapeHtmlText(posText)}">${escapeHtmlText(posText)}</span>`
            : '';
        const orderHtml = hasOrder
            ? `<span class="tub-nli-order" title="顺序（ST 世界书条目的 order，数字越大越靠后）：${escapeHtmlText(orderText)}">${escapeHtmlText(orderText)}</span>`
            : '';
        // 只有顺序一格时补个占位类，让 CSS 把它照旧推到最右（两列 flex 的左列 `flex:1` 缺失时仍贴右）
        const rowCls = posHtml ? 'tub-nli-meta' : 'tub-nli-meta tub-nli-meta-orderonly';
        return `<div class="${rowCls}">${posHtml}${orderHtml}</div>`;
    };
    const html = (e) => {
        const pct = e.matched && absoluteMax > 0 ? ((e.tokens / absoluteMax) * 100).toFixed(1) : 0;
        const bookTag = (alwaysShowBook || (bookFilter === 'all' && booksCount > 1)) ? ` <span class="tub-book-tag">(${escapeHtmlText(e.b)})</span>` : '';

        let gradientBg = '';
        if (e.type === 'ejs') {
            gradientBg = `background: linear-gradient(to right, var(--hh-stats-bg-ejs) ${pct}%, transparent ${pct}%);`;
        } else if (e.type === 'constant') {
            gradientBg = `background: linear-gradient(to right, var(--hh-stats-bg-constant) ${pct}%, transparent ${pct}%);`;
        } else {
            gradientBg = `background: linear-gradient(to right, var(--hh-stats-bg-dynamic) ${pct}%, transparent ${pct}%);`;
        }

        const unmatchedStyle = e.matched ? '' : ' opacity: 0.55;';
        const valueHtml = e.matched
            ? `${e.tokens}`
            : `<span class="tub-book-tag" title="未能在此次实际发送的上下文中定位到该条目内容（点击查看原因）">未匹配</span>`;

        const rid = ++seq;
        records.set(rid, e);

        // 第三十五轮用户口径⑪：**去掉每个条目行尾的「跳到正文」图标**（`tub-entry-jump`）。
        // 用户原话：「最后去除 `hc-msg-tokens` 和 `tub-entry-jump` 按钮图标。」
        // 该图标原本只给「条目来源」子窗用（jumpIcon: true），现在整套（标记 + 绑定 + CSS）一起删；
        // 想跳到正文仍可从「上下文目录」点条目行（那才是导航入口）。
        // ⚠️ 行内**不再有任何图标**，`.tub-nli-value` 就只剩 tokens 数字。
        return `<div class="tub-new-list-item tub-entry-clickable" data-rid="${rid}" data-book="${escapeHtmlText(e.b)}" data-name="${escapeHtmlText(e.name)}" data-uid="${e.uid ?? ''}" data-type="${e.type}" title="${escapeHtmlText(rowTitle)}" style="${gradientBg}${unmatchedStyle}">
                <div class="tub-nli-label" title="${escapeHtmlText(e.name)}">${escapeHtmlText(e.name)}${bookTag}</div>
                <div class="tub-nli-value">${valueHtml}</div>
                ${metaLine(e)}
            </div>`;
    };
    return { html, records };
}

// ② 「上下文顺序」的 messageID 标记行（用户口径 §2.24-R4）：
//   · 一条聊天消息的 messageID 在列表里**只出现一次**，作为"位置标记"；
//   · 只要某条消息的前/后**紧邻**有世界书条目，就必须把它的 messageID 标出来——所以深度注入
//     夹在 `#N-1` 与 `#N` 之间时，**两侧都要出现标记行**（`predMesid` 就是前面那条）；
//   · 标记行里只有 `#N`（描述/归属挂在 title 悬停），右侧显示**该消息的 role**（`user` / `AI`，§2.24-R5）。
// 定不出序号的块（未匹配、出口、更早的旧格式）退回原文案：标记行 + 下方条目。
function contextAnchorMarkerHtml(blockGroups, mesid, edges) {
    let badge, tooltip, total = 0, title = '';
    if (blockGroups.length) {
        const v = contextAnchorView(blockGroups[0].anchor || {}, edges);
        badge = v.badge || '';
        title = v.title || '';
        tooltip = [...new Set(blockGroups.map(g => (contextAnchorView(g.anchor || {}, edges).tooltip || '')).filter(Boolean))].join('；') || v.tooltip || '';
        total = blockGroups.reduce((s, g) => s + g.items.length, 0);
    } else {
        // 前面那条消息：这次没有任何条目"归属"它，它只作为位置标记出现（说明该消息后面紧邻着注入）
        badge = `#${mesid}`;
        tooltip = `聊天消息 #${mesid}（位置标记：它后面紧邻着世界书注入）`;
    }
    const titleAttr = tooltip ? ` title="${escapeHtmlText(tooltip)}"` : '';
    const titleHtml = title ? `<span class="tub-ctx-msg-title">${escapeHtmlText(title)}</span>` : '';
    // 右侧：对应到聊天消息的标记行显示该消息的 role（`user` / `AI`）；
    // 定不出序号的块（出口/更早的旧格式）没有消息可对应 → 仍显示归属它的条目数
    const role = (mesid !== null && edges?.roleOf?.get) ? (edges.roleOf.get(mesid) ?? '') : '';
    const sideHtml = role
        ? `<span class="tub-ctx-msg-role">${escapeHtmlText(role)}</span>`
        : (total > 0 ? `<span class="tub-ctx-msg-tokens">${total}</span>` : '<span class="tub-ctx-msg-tokens"></span>');
    return `
            <div class="tub-ctx-msg"${titleAttr}>
                <div class="tub-ctx-msg-main">
                    <span class="tub-ctx-msg-badge">${escapeHtmlText(badge)}</span>${titleHtml}
                </div>
                ${sideHtml}
            </div>`;
}

// ③ 「上下文顺序」整段列表：按条目真实插入点分组 → 渲染标记行 + 条目行。纯函数（entries 已按顺序排好）。
//   按条目的"真实插入点"分组；顺序键已保证同一 messageID 的 before/after 分组相邻（1000+mesid / +0.5）。
//   markers=false（世界书消息子窗，第二十轮用户口径）：**不渲染任何 `tub-ctx-msg` 标记行**——
//   那个列表里的条目本来就都属于同一条消息，位置标记没有意义；分组与顺序仍走同一套逻辑。
function renderContextOrderHtml(entries, edges, rowHtml, { markers = true } = {}) {
    const { groups, unmatched } = groupEntriesByAnchor(entries, edges);
    // 每个 messageID 上挂了哪些分组（标记行的数字与 tooltip 用）
    const groupsByMesid = new Map();
    for (const g of groups) {
        if (g.mesid === null) continue;
        if (!groupsByMesid.has(g.mesid)) groupsByMesid.set(g.mesid, []);
        groupsByMesid.get(g.mesid).push(g);
    }
    const emitted = new Set(); // 已经渲染过标记的 messageID（保证"同一 id 只出现一次"）
    const emitMarker = (mesid) => {
        if (!markers || mesid === null || emitted.has(mesid)) return '';
        emitted.add(mesid);
        return contextAnchorMarkerHtml(groupsByMesid.get(mesid) || [], mesid, edges);
    };
    // 「位于 #mesid 之前」的**连续分组共享同一个标记行**（用户口径 §2.26-R2）：
    // 系统区有多组落在同一条消息之前（作者注释 / 前置 / 后置 / 对话示例 / 顶部注入），
    // 它们必须**全部渲染在 `#N` 标记行上方**——所以标记要等这一串跑完再补，否则后一组会掉到标记行下面
    //（用户实际看到的就是"worldInfoAfter 排在了 #0 之后"，与实际发送顺序不符）。
    let pendingBeforeMesid = null;
    const flushBeforeMarker = () => {
        if (pendingBeforeMesid === null) return '';
        const m = emitMarker(pendingBeforeMesid);
        pendingBeforeMesid = null;
        return m;
    };
    let html = '';
    for (const g of groups) {
        if (g.mesid === null) {                       // 出口 / 更早的旧格式：原文案标记 + 条目
            html += flushBeforeMarker();
            html += markers ? contextAnchorMarkerHtml([g], null, edges) : '';
            html += g.items.map(rowHtml).join('');
            continue;
        }
        if (g.side === 'after') {                     // 末尾（深度 0）：标记行在上、条目在下
            html += flushBeforeMarker();
            html += emitMarker(g.mesid);
            html += g.items.map(rowHtml).join('');
            continue;
        }
        // 「位于 #mesid 之前」：同一条消息的连续分组先攒着，
        // 换到下一条消息（或本串结束）时才补标记——保证这一串条目全在标记行上方。
        if (pendingBeforeMesid !== g.mesid) {
            html += flushBeforeMarker();
            html += emitMarker(g.predMesid ?? null); // 注入点**前一条**的标记行（深度注入两侧都要标）
            pendingBeforeMesid = g.mesid;
        }
        html += g.items.map(rowHtml).join('');
    }
    html += flushBeforeMarker();
    if (unmatched.length) {
        html += markers ? `<div class="tub-ctx-msg tub-ctx-msg-nonfloor tub-ctx-unmatched" title="已激活但未能在实际发送的上下文中定位到内容，无法确认其插入位置">
                        <div class="tub-ctx-msg-main">
                            <span class="tub-ctx-msg-badge tub-ctx-msg-badge-nonfloor">未匹配</span>
                        </div>
                        <span class="tub-ctx-msg-tokens">${unmatched.length}</span>
                    </div>` : '';
        html += unmatched.map(rowHtml).join('');
    }
    if (!groups.length && !unmatched.length) {
        html = '<div class="tub-empty-state">没有激活的条目</div>';
    }
    return html;
}

// 渲染 Token 统计内容（明细视图）。model 为 null 表示无锚定数据。
// model = { index, totalTokens, chatTokens, wiTokens, otherTokens, statsObj }
function renderTokenStatsContent(model) {
    const overviewEl = document.getElementById('tub-row-overview');
    if (!overviewEl) return;

    const { totalTokens, chatTokens = 0, wiTokens = 0, otherTokens = 0, statsObj = {} } = model || {};
    // 「上下文顺序」用：本锚点对应的"首/末条待发送聊天消息"的 mesIDDisplay 序号。
    // 新锚点自带结构字段 mesid；旧锚点（或"位于全部消息之前/之后"的块）靠这里兜底，保证标题一定能显示序号。
    const ctxEdges = contextSendableEdges(model);

    // 本聊天尚无锚定统计（还没发送过消息）
    if (totalTokens === null || totalTokens === undefined) {
        overviewEl.innerHTML = '<div class="tub-empty-state">暂无统计数据：发送一条消息后会自动统计并显示。</div>';
        document.getElementById('tub-row-wi-chart').innerHTML = '';
        document.getElementById('tub-entries-section').innerHTML = '';
        return;
    }

    const getPct = (v) => totalTokens > 0 ? ((v / totalTokens) * 100).toFixed(1) : 0;

    // 渲染概览行（全部来自最终上下文，与"实际发送"一致）
    // 「总共」框可点击：**直接**开出「上下文目录（左）+ 完整上下文（右）」这一对窗口
    //   （第二十九轮用户口径①：原来的第一层「完整上下文」查看器内容重复，已整体删除）。
    // 「聊天」框可点击：打开聊天统计子弹窗（实际发送范围 / AI token 均值 / 生成速度 / 历史折线）。
    // 「总共」框在总量达到预算阈值（200000）时标红预警。
    const overBudget = totalTokens >= STATS_BUDGET_TOKENS;
    const totalTitle = `点击查看完整上下文（左侧上下文目录 + 右侧实际发送的 ${totalTokens} tokens 全文）`
        + (overBudget ? `；⚠️ 总量已达 ${STATS_BUDGET_TOKENS} 的预算上限` : '');
    overviewEl.innerHTML = `
        <div class="tub-stat-box tub-stat-box-clickable${overBudget ? ' tub-stat-box-over-budget' : ''}" data-stat="total" title="${escapeHtmlText(totalTitle)}"><span class="tub-stat-label">总共</span><span class="tub-stat-value">${totalTokens}<br><small>${overBudget ? '超出预算' : '实际发送'}</small></span></div>
        <div class="tub-stat-box tub-stat-box-clickable" data-stat="chat" title="点击查看：实际发送的消息范围 / AI 平均 tokens / AI 平均生成速度 / 最近七条 AI 消息折线"><span class="tub-stat-label">聊天</span><span class="tub-stat-value">${chatTokens}<br><small>${getPct(chatTokens)}%</small></span></div>
        <div class="tub-stat-box"><span class="tub-stat-label">世界书</span><span class="tub-stat-value">${wiTokens}<br><small>${getPct(wiTokens)}%</small></span></div>
        <div class="tub-stat-box"><span class="tub-stat-label">其他</span><span class="tub-stat-value">${otherTokens}<br><small>${getPct(otherTokens)}%</small></span></div>
    `;
    // 「总共」→ 上下文目录 + 完整上下文（点击开/关；层级 = 直接挂主弹窗）
    const totalStatBox = overviewEl.querySelector('.tub-stat-box[data-stat="total"]');
    if (totalStatBox) totalStatBox.onclick = (ev) => { ev.stopPropagation(); toggleContextOutlineFromStats(model); };
    // 「聊天」→ 聊天统计子弹窗（点击开/关；与条目详情子窗同款交互，但形态为贴框小浮层）
    const chatStatBox = overviewEl.querySelector('.tub-stat-box[data-stat="chat"]');
    if (chatStatBox) chatStatBox.onclick = (ev) => { ev.stopPropagation(); toggleChatStatsPopup(model, chatStatBox); };

    // 渲染条目列表（含排序/过滤工具栏）
    const books = Object.keys(statsObj);
    // 类型过滤触发器：按钮 + 浮层菜单（见 openTypeFilterMenu）。菜单项在打开时按"当前数据里真实存在的类型"生成。

    const bookFiltersHtml = books.length > 1
        ? `<div class="tub-book-filters">
                <button class="tub-book-btn active" data-book="all">所有条目</button>
                ${books.map(b => `<button class="tub-book-btn" data-book="${b}">${b}</button>`).join('')}
            </div>`
        : '';

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
            <div class="tub-book-filters-row">
                ${bookFiltersHtml}
                <div class="tub-entries-tools">
                    <button class="tub-sort-btn${statsListSortMode === 'context' ? ' active' : ''}" id="tub-sort-btn" title="切换排序：默认顺序 / 实际上下文先后顺序">
                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h13M3 12h9M3 18h5"></path><path d="M18 9l3 3-3 3"></path></svg>
                        <span>${statsListSortMode === 'context' ? '上下文顺序' : '默认排序'}</span>
                    </button>
                    <button type="button" class="tub-type-filter" id="tub-type-filter" title="按类型过滤">
                        <span class="tub-type-filter-text">${TYPE_FILTER_LABELS[statsListTypeFilter] || TYPE_FILTER_LABELS.all}</span>
                    </button>
                </div>
            </div>
        </div>
        <div class="tub-row-3 tub-scrollable" id="tub-row-entries"></div>
    `;
    document.getElementById('tub-entries-section').innerHTML = sectionHtml;

    // 状态保存，用于交叉过滤
    let currentBookFilter = 'all';
    let currentSearchTerm = '';

    // 按当前世界书过滤聚合饼图数据（常量/动态/EJS）
    const computePieForBook = (bookFilter) => {
        let c = 0, d = 0, e = 0;
        for (const b in statsObj) {
            if (bookFilter !== 'all' && b !== bookFilter) continue;
            (statsObj[b].constant || []).forEach(x => { c += x.tokens; });
            (statsObj[b].dynamic || []).forEach(x => { d += x.tokens; });
            (statsObj[b].ejs || []).forEach(x => { e += x.tokens; });
        }
        return { c, d, e, total: c + d + e };
    };
    // 当前「世界书过滤」范围内实际存在的类型集合（决定类型过滤菜单里出现哪些选项）。
    // ⚠️ 只算 matched 的条目：未匹配条目已被列表过滤掉（用户口径①），若把它们算进可用类型，
    //    会出现"菜单里有「动态」、点开却一条都列不出来"的死路。
    const availableListTypes = () => {
        const s = new Set();
        for (const b in statsObj) {
            if (currentBookFilter !== 'all' && b !== currentBookFilter) continue;
            const rec = statsObj[b] || {};
            for (const t of TYPE_FILTER_ORDER) if ((rec[t] || []).some(e => e.matched)) s.add(t);
        }
        return s;
    };
    // 最近一次渲染算出的可用类型：类型过滤菜单打开时直接用它（保证菜单项与列表数据一致）
    let availableListTypesCache = availableListTypes();

    const renderEntriesList = () => {
        // 类型过滤自检：当前选中的类型在（当前世界书过滤后的）数据里已不存在 → 回退「所有」。
        // 否则会出现"选了 EJS 却一条都列不出来"的死路（菜单里也不会再出现该选项）。
        availableListTypesCache = availableListTypes();
        if (statsListTypeFilter !== 'all' && !availableListTypesCache.has(statsListTypeFilter)) {
            statsListTypeFilter = 'all';
        }
        updateTypeFilterTriggerLabel('tub-type-filter', statsListTypeFilter);
        const entriesContainer = document.getElementById('tub-row-entries');
        const totalDisplay = document.getElementById('tub-entries-total-display');
        entriesContainer.innerHTML = '';

        let combined = [];
        let filterTotalC = 0;
        let filterTotalD = 0;
        let filterTotalE = 0;

        const pushEntries = (list, type, bookName) => {
            if (!list) return;
            if (statsListTypeFilter !== 'all' && type !== statsListTypeFilter) return;
            list.forEach(e => {
                // 第三十三轮用户口径①：「已激活条目」里**未匹配的条目不再显示**
                //   （matched=false = 已激活但没能在实际发送的上下文里定位到内容、tokens 恒为 0）。
                //   它们既贡献不了 token、又占满列表末尾，用户明确要求过滤掉。
                if (!e.matched) return;
                if (currentSearchTerm && !e.name.toLowerCase().includes(currentSearchTerm)) return;
                combined.push({ ...e, b: bookName, type });
                if (type === 'ejs') filterTotalE += e.tokens;
                else if (type === 'dynamic') filterTotalD += e.tokens;
                else filterTotalC += e.tokens;
            });
        };

        for (const b in statsObj) {
            if (currentBookFilter !== 'all' && b !== currentBookFilter) continue;
            pushEntries(statsObj[b].ejs, 'ejs', b);
            pushEntries(statsObj[b].dynamic, 'dynamic', b);
            pushEntries(statsObj[b].constant, 'constant', b);
        }

        // 饼图跟随当前世界书过滤
        const pie = computePieForBook(currentBookFilter);
        renderPieView(pie.c, pie.d, pie.e, pie.total);

        const filterTotal = filterTotalC + filterTotalD + filterTotalE;
        // 构建顶部总数显示，如果有 EJS 则显示红色部分
        let totalHtml = `${filterTotal}`;
        if (filterTotalE > 0 || filterTotalD > 0 || filterTotalC > 0) {
            totalHtml += ' (';
            const parts = [];
            if (filterTotalE > 0) parts.push(`<span class="tub-stat-color-ejs">${filterTotalE}</span>`);
            if (filterTotalD > 0) parts.push(`<span class="tub-stat-color-dynamic">${filterTotalD}</span>`);
            if (filterTotalC > 0) parts.push(`<span class="tub-stat-color-constant">${filterTotalC}</span>`);
            totalHtml += parts.join(' + ') + ')';
        }
        totalDisplay.innerHTML = totalHtml;

        // 排序由共用纯函数负责（与「世界书消息条目」子窗同一套口径，见 sortEntriesByMode）
        sortEntriesByMode(combined, statsListSortMode, ctxEdges);

        if (!combined.length) {
            entriesContainer.innerHTML = '<div class="tub-empty-state">没有激活的条目</div>';
            return;
        }

        const matchedTokens = combined.filter(e => e.matched).map(e => e.tokens);
        const absoluteMax = matchedTokens.length ? Math.max(...matchedTokens) : 1;

        // 条目行 → 原始记录表：点击时按 data-rid 取回完整记录（uid/type 等）。
        // 行 HTML 与"行 → 记录"表由共用构建器产出（与「世界书消息条目」子窗同一套渲染，见 createEntryRowBuilder）。
        const rowBuilder = createEntryRowBuilder({ booksCount: books.length, bookFilter: currentBookFilter, absoluteMax });
        const entryRowHtml = rowBuilder.html;
        const rowRecords = rowBuilder.records;

        if (statsListSortMode === 'context') {
            // 分组 + 标记行整段渲染由共用纯函数负责（与「世界书消息条目」子窗同一套口径，见 renderContextOrderHtml）
            entriesContainer.innerHTML = renderContextOrderHtml(combined, ctxEdges, entryRowHtml);
        } else {
            entriesContainer.innerHTML = combined.map(entryRowHtml).join('');
        }

        // 条目行点击 → 打开条目详情子窗（两种模式统一绑定）；按 data-rid 取回原始记录
        entriesContainer.querySelectorAll('.tub-entry-clickable').forEach(row => {
            row.onclick = () => {
                const rec = rowRecords.get(Number(row.getAttribute('data-rid'))) || null;
                openEntryDetailPopup({
                    book: row.getAttribute('data-book'),
                    name: row.getAttribute('data-name'),
                    uid: row.getAttribute('data-uid'),
                    type: row.getAttribute('data-type'),
                    tokens: rec ? rec.tokens : null,
                });
            };
        });
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

    // 排序按钮：默认顺序 <-> 实际上下文顺序
    const sortBtn = document.getElementById('tub-sort-btn');
    if (sortBtn) {
        sortBtn.onclick = () => {
            statsListSortMode = statsListSortMode === 'context' ? 'default' : 'context';
            sortBtn.classList.toggle('active', statsListSortMode === 'context');
            sortBtn.querySelector('span').textContent = statsListSortMode === 'context' ? '上下文顺序' : '默认排序';
            renderEntriesList();
        };
    }

    // 类型过滤：菜单项（只列当前数据里真实存在的类型；列表每次渲染都会刷新可用集合）
    const typeFilter = document.getElementById('tub-type-filter');
    if (typeFilter) {
        typeFilter.onclick = () => toggleTypeFilterMenu(typeFilter, {
            available: availableListTypesCache,
            current: statsListTypeFilter,
            onPick: (value) => {
                statsListTypeFilter = value;
                updateTypeFilterTriggerLabel('tub-type-filter', value);
                renderEntriesList();
            },
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

    // 统计加载完成（内容高度变化）后，立即将弹窗重新居中
    if ($('.tab-panel[data-tab="token-stats-panel"]').hasClass('active')) {
        centerPopup($('#hide-helper-popup'));
    }
}

// 渲染世界书构成饼图（SVG 扇形，抗锯齿、无 conic-gradient 锯齿；保持实心饼状而非圆环）
// c/d/e 分别为 常量 / 动态 / EJS 的 token 数；total 为其和。扇区上标注百分比（<5% 不标注）。
// container 版（CHANGELOG §2.30）：主面板（#tub-row-wi-chart）与「世界书消息条目」子窗共用同一套绘制，
// 只是容器不同——两处各画一份必然漂移。renderPieView 是主面板口径的薄包装（见下）。
function renderPieViewInto(container, c, d, e, total) {
    if (!container) return;
    if (!total) { container.innerHTML = '<div class="tub-empty-state">没有激活的世界书</div>'; return; }

    const R = 50, CX = 50, CY = 50, LABEL_R = 30; // LABEL_R：百分比文字离圆心的距离
    const segs = [
        { v: c, color: 'var(--hh-stats-color-constant)' }, // 常量（蓝，最先，从 0% 起）
        { v: d, color: 'var(--hh-stats-color-dynamic)' },  // 动态（绿）
        { v: e, color: 'var(--hh-stats-color-ejs)' },      // EJS（红）
    ].filter(s => s.v > 0);

    // 从 12 点方向开始顺时针取点（f 为 0~1 的比例，radius 为取值半径）
    const pt = (f, radius = R) => {
        const a = 2 * Math.PI * f;
        return [(CX + radius * Math.sin(a)).toFixed(3), (CY - radius * Math.cos(a)).toFixed(3)];
    };

    let slices, labels = '';
    if (segs.length === 1) {
        // 单一构成：整圆（避免退化的 360° 圆弧），百分比标在圆心
        slices = `<circle class="tub-pie-wedge" cx="${CX}" cy="${CY}" r="${R}" style="fill:${segs[0].color}"></circle>`;
        labels = `<text class="tub-pie-text" x="${CX}" y="${CY}">100%</text>`;
    } else {
        let acc = 0;
        slices = segs.map(s => {
            const f0 = acc / total, f1 = (acc + s.v) / total;
            const [x0, y0] = pt(f0);
            const [x1, y1] = pt(f1);
            const large = (f1 - f0) > 0.5 ? 1 : 0;
            // 百分比标在扇区中线处；过小的扇区（<5%）不标，避免文字溢出/重叠
            const pct = (s.v / total) * 100;
            if (pct >= 5) {
                const [lx, ly] = pt((f0 + f1) / 2, LABEL_R);
                labels += `<text class="tub-pie-text" x="${lx}" y="${ly}">${pct.toFixed(0)}%</text>`;
            }
            // 同色描边 0.6px：消除相邻扇区之间的抗锯齿接缝
            acc += s.v;
            return `<path class="tub-pie-wedge" d="M ${CX} ${CY} L ${x0} ${y0} A ${R} ${R} 0 ${large} 1 ${x1} ${y1} Z" style="fill:${s.color};stroke:${s.color};stroke-width:0.6"></path>`;
        }).join('');
    }

    container.innerHTML = `
        <svg class="tub-pie-svg" viewBox="0 0 100 100" role="img" aria-label="世界书构成">
            ${slices}
            ${labels}
        </svg>
        <div class="tub-legend">
            ${e > 0 ? `<div class="tub-legend-item"><span class="tub-dot tub-dot-red"></span>${TYPE_FILTER_LABELS.ejs}: ${e}</div>` : ''}
            <div class="tub-legend-item"><span class="tub-dot tub-dot-green"></span>${TYPE_FILTER_LABELS.dynamic}: ${d}</div>
            <div class="tub-legend-item"><span class="tub-dot tub-dot-blue"></span>${TYPE_FILTER_LABELS.constant}: ${c}</div>
        </div>
    `;
}

// 主面板口径的包装：容器固定为 #tub-row-wi-chart
function renderPieView(c, d, e, total) {
    renderPieViewInto(document.getElementById('tub-row-wi-chart'), c, d, e, total);
}

// 滚动条自动隐藏/显示逻辑 (已移除)
function initScrollbarLogic() {
}

// ==================== 条目详情子弹窗 ====================
// 点击「已激活条目」/「世界书条目差异」里的条目时，从世界书实时读出条目定义并展示。
// 桌面端贴在主弹窗正右方（右侧放不下则换左侧）；窄屏/移动端居中——两种情况尺寸都与主弹窗一致。

// 世界书 position 值 → 「插入位置」文案（与 ST 世界书编辑器的中文标签口径一致：
// 界面截图里的 角色定义前/后、作者注释前/后、示例消息前/后、锚点 ↔ zh-cn.json 的
// "Before Char Defs"/"After Char Defs"/"Before AN"/"After AN"/"Before EM"/"After EM"/"Outlet"）。
// position=4（@D 深度注入）不在这里：它要拼角色与深度，见 entryInsertPositionText()。
const WI_POSITION_LABELS = {
    0: '角色定义前',
    1: '角色定义后',
    2: '作者注释前',
    3: '作者注释后',
    5: '示例消息前',
    6: '示例消息后',
    7: '锚点',
};
// @D 深度注入的角色名（ST `extension_prompt_roles`：0=system / 1=user / 2=assistant）
const WI_DEPTH_ROLE_LABELS = { 0: '系统', 1: '用户', 2: 'AI' };

// 「插入位置」行的文案（纯函数，便于审计/单测）：
//   · position=4 → `系统 @D 3` / `用户 @D 3` / `AI @D 3`（角色 + 深度，深度口径同 ST：`entry.depth ?? DEFAULT_DEPTH`）
//   · 其它 position → 上面的固定文案；未知值兜底为 `未知（n）`
function entryInsertPositionText(entry) {
    const position = Number(entry?.position) || 0;
    if (position === 4) {
        const raw = entry?.depth;
        const num = Number(raw);
        // ST：缺省用 DEFAULT_DEPTH(4)；数字（含数字字符串）原样显示；非数字照实显示（ST 会整条丢弃该注入）
        const depthText = (raw === null || raw === undefined) ? String(ST_DEFAULT_DEPTH)
            : (Number.isFinite(num) ? String(num) : String(raw));
        const role = Number(entry?.role ?? 0);
        const roleText = WI_DEPTH_ROLE_LABELS[role] || `角色${entry?.role}`;
        return `${roleText} @D ${depthText}`;
    }
    return WI_POSITION_LABELS[position] || `未知（${position}）`;
}

// 确保条目详情弹窗的 DOM 存在（只创建一次，后续复用刷新内容）
function ensureEntryPopup() {
    let el = document.getElementById('hide-helper-entry-popup');
    if (el) return el;
    $('body').append(`
        <div id="hide-helper-entry-popup" class="hide-helper-popup hide-helper-entry-popup" style="display: none;">
            <button id="hide-helper-entry-popup-close-icon" class="hide-helper-popup-close-icon" title="关闭">&times;</button>
            <div class="hide-entry-head">
                <div class="hide-entry-name" id="hide-entry-name">条目详情</div>
                <div class="hide-entry-sub" id="hide-entry-sub"></div>
            </div>
            <div class="hide-entry-body" id="hide-entry-body"></div>
        </div>
    `);
    el = document.getElementById('hide-helper-entry-popup');
    $('#hide-helper-entry-popup-close-icon').on('click', () => closeEntryPopup());
    // 滚动条"默认隐藏、滚动/悬停时才显示"（三档显色见 CSS 的 .hh-sb-*）：滚动中/悬停/拖拽由 JS 打类。
    // 绑定一次即可——内容区元素本身长期复用，只有它的 innerHTML 会被替换。
    initHiddenScrollbar(el.querySelector('#hide-entry-body'));
    // 主题跟随主弹窗
    const theme = extension_settings[extensionName]?.theme || 'light';
    if (theme === 'dark') el.setAttribute('data-theme', 'dark');
    return el;
}

// 子窗内容区的滚动条指示（条目详情子窗 / 完整上下文查看器共用）：滚动中、鼠标在滚动条窄带上、按住拖拽时
// 给内容区加类，让滑块从"透明（= 隐藏）"逐级变为浅色/深色（同款样式见 style.css 的 .hh-sb-*）。
// ⚠️ 「默认隐藏」这里**同时内联兜一层**（scrollbar-width: thin + scrollbar-color 全透明）：样式表由 ST 在
//   页面加载时以 <link> 注入、**不会热更新**，页面没刷新时旧 CSS 会让滚动条一直可见（用户实测踩过）。
//   三档显色仍由 CSS 的 .hh-sb-* 负责——它们带 !important，优先级高于内联值，故滚动/悬停/拖拽照常显色。
// 失败（元素缺失等）不影响功能，纯样式增强。
// 全局 mouseup 只注册一次（见函数尾部）：完整上下文里**每条消息体**都会绑一次本函数，
// 若每次都往 window 上挂监听器就会持续累积。
let hiddenScrollbarMouseupBound = false;
function initHiddenScrollbar(bodyEl) {
    if (!bodyEl || bodyEl.dataset.hhSbBound === '1') return;
    bodyEl.dataset.hhSbBound = '1';
    if (bodyEl.style) {
        bodyEl.style.scrollbarWidth = 'thin';
        bodyEl.style.scrollbarColor = 'transparent transparent';
    }
    // 滚动条在右侧，宽度 8px（见 CSS）——命中区多给 4px 容差，避免贴边抖不出 hover 态
    const SB_HIT_W = 12;
    const inScrollbarStrip = (clientX) => clientX >= bodyEl.getBoundingClientRect().right - SB_HIT_W;

    let scrollTimer = null;
    bodyEl.addEventListener('scroll', () => {
        bodyEl.classList.add('hh-sb-scrolling');
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(() => bodyEl.classList.remove('hh-sb-scrolling'), 900);
    }, { passive: true });

    // 鼠标移到滚动条那条窄带上 → hover 态（与「滚动中」分开，颜色更深一档）。
    // 用 JS 而不是纯 CSS :hover 的原因：.hide-entry-body:hover 是整个内容区，太宽；
    // 而 ::-webkit-scrollbar-thumb:hover 在指定了 scrollbar-color 的浏览器（Chrome 121+）里不生效。
    const updateHover = (clientX, buttons) => {
        const onBar = inScrollbarStrip(clientX);
        bodyEl.classList.toggle('hh-sb-hover', onBar);
        if (onBar && buttons) bodyEl.classList.add('hh-sb-dragging');
    };
    bodyEl.addEventListener('mousemove', (ev) => updateHover(ev.clientX, ev.buttons), { passive: true });
    bodyEl.addEventListener('mouseleave', () => {
        bodyEl.classList.remove('hh-sb-hover');
        bodyEl.classList.remove('hh-sb-dragging');
    }, { passive: true });
    // 按住滚动条拖（按下时命中的就是那条窄带）→ 最深一档；松开即退
    bodyEl.addEventListener('mousedown', (ev) => {
        if (inScrollbarStrip(ev.clientX)) bodyEl.classList.add('hh-sb-dragging');
    });
    if (!hiddenScrollbarMouseupBound && typeof window.addEventListener === 'function') {
        hiddenScrollbarMouseupBound = true;
        window.addEventListener('mouseup', () => {
            // 用 DOM 查类名统一清态：不持有元素引用，重绘产生的旧元素自然被回收
            document.querySelectorAll('.hh-sb-dragging').forEach(el => el.classList.remove('hh-sb-dragging'));
        });
    }
}

// ── 子窗布局：父窗**保持原位**、子窗开在它的"另一侧"（第二十四轮用户口径）─────────────────────────────
//  用户原话：「我希望子弹窗是显示在另一侧的，而不是上一级父弹窗移至左侧，子弹窗显示在右侧这种逻辑。」
//          +「把子弹窗的"返回"按钮去除了，这个没什么用。」（后者已照做：返回按钮整套删除）
//  规则（屏幕上**通常两个窗口**，唯一例外见下面的"三窗例外"）：
//   · 父窗 = 当前窗的**直接父窗**（= 打开它时正显示的那个窗口）；层级为空时 = 插件主弹窗（最高一级父窗）。
//   · 父窗**一动不动**；子窗开在父窗的**另一侧**：父窗中心在视口左半边（含正中）→ 往右；右半边 → 往左（逐层左右交错）。
//   · 父窗**不是**主弹窗时 → **主弹窗隐藏**；子窗与父窗**同宽同顶**（子窗更高时只上移必要的量）。
//   · 首选那侧放不下 → 改用另一侧；两侧都放不下（窄屏）→ 两窗居中叠放（当前窗压在上层）。
//   · 位置全部由 layoutChildPair() 一处决定（各 open* 只负责渲染内容 + 亮出自己的 DOM）。
//   · **唯一的三窗例外**（第二十七轮用户口径，第二十九轮入口改为目录）：从「条目来源」里点条目开「条目详情」时，
//     `pairExtraId` 记下"该继续留在屏幕上的那一层"（= 条目来源的父窗，现在是上下文目录）→ 屏幕上恒为
//     「条目详情(左) | 条目来源(中) | 上下文目录(右)」三窗；本窗一律落在 **extra 的对面**（避开重叠），
//     而不是按"父窗落在视口哪半边"决定。其余任何打开子窗的步骤**仍是两个窗口**。
//  ⚠️ 历史（别照抄）：第二十轮"三窗一排"（'center'/'above'/'right-edge'，已删）；第二十一轮"主窗恒在左 + 单槽位"；
//     第二十二轮把「目录」「条目来源」收进查看器内部（A 方案，已回退）；第二十三轮"父左子右两槽 + 子窗「← 返回」"（返回按钮第二十四轮删除）。
//  ⚠️ 尺寸不能用 getBoundingClientRect 当布局坐标 —— 入场动画（hhFadeIn 的 scale 0.95）会让 rect 偏小，
//     故一律用 `offsetWidth/offsetHeight` + 主窗自己写入的 inline `left/top` 当"未缩放的布局框"。
const PAIR_GAP = 12;
const PAIR_MARGIN = 8;

let pairCurrentId = null;        // 当前窗 id；null = 没有子窗（只有主窗）
let pairMainSlot = null;         // 主窗"自己的槽位" {left, top, width, height}（主窗被隐藏时仍靠它给子窗算落点）
let pairMainPrevDisplay = undefined;  // 主窗被隐藏前的 inline display（还原用；undefined = 当前没被我们隐藏）
let pairExtraId = null;          // 额外保留在屏幕上的那一层（第三窗；只有"条目来源 → 条目详情"这一步非空）
const childStack = [];           // 层级链：栈顶 = 当前窗的**直接父窗**
const CTX_OUTLINE_ID = 'hide-helper-ctx-outline-popup';   // 上下文目录（= 目录页，第二十轮新增；第二十九轮起是顶层入口）
const CTX_MERGED_ID = 'hide-helper-ctx-merged-popup';     // 完整上下文（= 内容区，第二十七轮新增）
// 第二十九轮：`hide-helper-context-viewer`（第一层「完整上下文」查看器）**整体删除** ——
//   用户口径："第一层的完整上下文弹窗内容太过重复"，点「总共」直接显示「上下文目录 + 完整上下文」。
const CHILD_POPUP_IDS = [
    'hide-helper-entry-popup',
    'hide-helper-chat-stats-popup',
    'hide-helper-wi-msg-popup',
    'hide-helper-ctx-outline-popup',
    'hide-helper-ctx-merged-popup',
];

// 子窗登记表：id → 最小高度（主窗很矮时也要保证"下面那一整段列表"看得见：条目来源 / 上下文目录）
function childPopupTable() {
    return [
        ['hide-helper-entry-popup', 0],
        ['hide-helper-chat-stats-popup', 0],
        ['hide-helper-wi-msg-popup', WI_MSG_POPUP_MIN_HEIGHT],
        ['hide-helper-ctx-outline-popup', CTX_OUTLINE_MIN_HEIGHT],
        ['hide-helper-ctx-merged-popup', 0],
    ];
}

function minHeightOf(id) {
    const row = childPopupTable().find(([x]) => x === id);
    return row ? row[1] : 0;
}

// 主窗自己的槽位：只在主窗**可见**时更新（隐藏后仍沿用最后一次的槽位给子窗算落点）
function captureMainSlot() {
    const mainEl = document.getElementById('hide-helper-popup');
    if (!mainEl || !mainEl.getClientRects || !mainEl.getClientRects().length) return pairMainSlot;
    const width = mainEl.offsetWidth || 0;
    const height = mainEl.offsetHeight || 0;
    const left = parseFloat(mainEl.style.left);
    const top = parseFloat(mainEl.style.top);
    if (!width || !height || !Number.isFinite(left) || !Number.isFinite(top)) return pairMainSlot;
    pairMainSlot = { left, top, width, height };
    return pairMainSlot;
}

// 当前窗 id；没有子窗时 null
function currentChildId() {
    if (!pairCurrentId) return null;
    const el = document.getElementById(pairCurrentId);
    return (el && el.style.display !== 'none') ? pairCurrentId : null;
}

// 当前窗的**直接父窗** id（null = 插件主弹窗）
function parentChildId() {
    return childStack.length ? childStack[childStack.length - 1] : null;
}

// 可见的子窗 id 列表（父窗 + 当前窗；三窗例外时再加上 extra 那一层）
function visibleChildIds() {
    return CHILD_POPUP_IDS.filter(id => {
        const el = document.getElementById(id);
        return el && el.style.display !== 'none';
    });
}

// 兼容旧语义：**当前窗** id —— 父窗不算"当前"
function visibleChildId() {
    return currentChildId();
}

// 打开子窗前的统一入口：记下"当前窗"并压栈（它将成为新窗的**父窗**、原地不动）；返回被压栈的 id
// ⚠️ 顺带清掉"第三窗"（pairExtraId）：任何一次新的打开都回到两窗语义（要留三窗的调用方在 focus 之后再设回它）
function focusChildPopup(id) {
    pairExtraId = null;
    const cur = currentChildId();
    if (cur && cur !== id) {
        childStack.push(cur);
        // 同一层不重复入栈 + 栈深兜底
        while (childStack.length >= 2 && childStack[childStack.length - 1] === childStack[childStack.length - 2]) childStack.pop();
        while (childStack.length > 6) childStack.shift();
    }
    pairCurrentId = id;
    return cur;
}

// 用户主动关闭子窗 / 回到"只有主窗"：清空层级 + 隐藏所有子窗 + 主窗回到自己的槽位
function closeChildStack() {
    childStack.length = 0;
    pairCurrentId = null;
    pairExtraId = null;
    exitContextOutlineMergeMode();   // 成对窗口（目录 + 合并内容）连同本模式的状态一起清掉
    layoutChildPair();
}

// 关闭**某个子窗**（× 按钮 / `Esc` / 图标 toggle 都走这里）—— **只退到该退的那一层**：
//   · 它就是"当前窗" → 退回它的父窗（父窗成为新的当前窗）；
//   · 它是**父窗**（上面还压着更深的子窗）→ 连同那些子窗一起收起，退回它自己的父窗；
//   · 它本来就是最外层子窗 → 回到"只有主窗"。
// ⚠️ 与 `closeChildStack()`（**结束整轮层级**）区分：后者只给"重置"路径用（切聊天 / 换快照 / 关主弹窗）。
function closeChildPopupAt(id) {
    if (!id) return;
    // 「目录 + 合并内容」是一对：关掉其中任意一个都退出该模式（合并内容窗一并收起、查看器回到台前）
    if (ctxMergeMode && (id === CTX_OUTLINE_ID || id === CTX_MERGED_ID)) exitContextOutlineMergeMode();
    pairExtraId = null;   // 关任一层都回到两窗语义（三窗只活在"条目详情开着"的这段时间里）
    const idx = childStack.lastIndexOf(id);
    if (idx >= 0) {                                   // id 是父窗：截掉它和压在它上面的更深子窗
        pairCurrentId = idx > 0 ? childStack[idx - 1] : null;
        childStack.length = idx > 0 ? idx - 1 : 0;
    } else if (pairCurrentId === id) {                 // id 就是当前窗：退一层
        pairCurrentId = childStack.pop() || null;
    }
    // ⚠️ 先把"新的当前窗"显示出来再重排：它是被上一层压着隐藏的（`display:none`），而 `currentChildId()` 会
    // 把 display:none 的窗口当成"没有当前窗" —— 不先亮出来，整对会被当成"只剩主窗"（实测踩过）。
    if (pairCurrentId) {
        const nxt = document.getElementById(pairCurrentId);
        if (nxt) nxt.style.display = 'flex';
    }
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
    layoutChildPair();
    // 第二十九轮：关掉的若是"成对窗口的临时子窗"（如「条目来源」），退回到目录后要把右侧完整上下文放回来。
    // ⚠️ 放在 layoutChildPair 之后：先按挂起态摆好「目录 | 子窗 → 目录」，再由 resume 补回内容窗。
    if (ctxMergeMode && ctxMergeSuspended && currentChildId() === CTX_OUTLINE_ID) resumeOutlineMergeAfterChild();
}

// 关闭**当前窗**（= closeChildPopupAt(当前窗)）：语义就是"退一层"
function popChildPopup() {
    closeChildPopupAt(currentChildId());
}


// 父窗不是主弹窗时要隐藏主弹窗（记住它原来的 inline display，还原时按原值写回）
function setMainHiddenForPair(hide) {
    const mainEl = document.getElementById('hide-helper-popup');
    if (!mainEl || !mainEl.style) return;
    if (hide) {
        if (pairMainPrevDisplay === undefined) pairMainPrevDisplay = mainEl.style.display || '';
        mainEl.style.display = 'none';
    } else if (pairMainPrevDisplay !== undefined) {
        if (pairMainPrevDisplay) mainEl.style.display = pairMainPrevDisplay;
        else mainEl.style.removeProperty('display');
        pairMainPrevDisplay = undefined;
    }
}

// ── 整对布局：父窗**保持原位**、子窗开在它的"另一侧" ──────────────────────
// 清掉"叠放层级"类（主窗 + 全部子窗，**含此刻隐藏的那些**）。⚠️ 必须清所有窗口：只对自己这一对 toggle 会留陈旧类 ——
// 曾在窄屏当过"当前窗"的子窗会一直带着 `hh-pair-front`，下次叠放时它若是父窗，反而压住真正的当前窗（实测踩过）。
function clearPairStacking(mainEl) {
    const els = [mainEl || document.getElementById('hide-helper-popup')];
    for (const id of CHILD_POPUP_IDS) {
        const el = document.getElementById(id);
        if (el) els.push(el);
    }
    for (const el of els) if (el && el.classList) el.classList.remove('hh-pair-front', 'hh-pair-under');
}

// 读一个**可见**窗口自己的槽位：inline left/top + 未缩放的 offset 尺寸
//（⚠️ 不用 getBoundingClientRect：入场动画 hhFadeIn 的 scale(0.95) 会让 rect 偏小/偏移）
function readWindowSlot(el) {
    if (!el || !el.style) return null;
    const width = el.offsetWidth || 0;
    const height = el.offsetHeight || 0;
    const left = parseFloat(el.style.left);
    const top = parseFloat(el.style.top);
    if (!width || !height || !Number.isFinite(left) || !Number.isFinite(top)) return null;
    return { left, top, width, height };
}

function layoutChildPair() {
    const mainEl = document.getElementById('hide-helper-popup');
    clearPairStacking(mainEl);
    const curId = currentChildId();
    // 成对模式（「目录 + 完整上下文」）：落点整体交给 layoutOutlineMergePair 一处决定
    if (ctxMergeMode) {
        if (ctxMergeSuspended) {
            // 挂起中（从目录里打开了「条目来源」等子窗）：**模式保持不变**，只是右侧完整上下文暂时收起，
            // 让下面普通的两窗逻辑摆「目录 | 条目来源」。关掉子窗后 resumeOutlineMergeAfterChild 恢复成对窗口。
            // ⚠️ 这一支必须排在最前面：挂起时"当前窗"本来就不是目录，不能据此判定模式结束（实测踩过：
            //    那样会把 ctxMergeMode 清掉，关闭条目来源后右侧完整上下文再也回不来）。
            const mrgEl = document.getElementById(CTX_MERGED_ID);
            if (mrgEl) mrgEl.style.display = 'none';
        } else if (curId === CTX_OUTLINE_ID) {
            // 成对模式：屏幕上**只留「目录 + 完整上下文」** —— 其它子窗（条目来源 / 条目详情…）一律收起。
            // ⚠️ 这一条不能省：从「条目来源」的"跳到正文"图标进成对模式时，可能同时还开着别的子窗，
            //    少了它屏幕上会堆出 3~4 个重叠窗口（真实 Chromium 实测）。
            for (const id of CHILD_POPUP_IDS) {
                if (id === CTX_OUTLINE_ID || id === CTX_MERGED_ID) continue;
                const el = document.getElementById(id);
                if (el) el.style.display = 'none';
            }
            layoutOutlineMergePair();
            return;
        } else {
            // 目录已经不在了（被别的路径关掉）→ 模式结束
            ctxMergeMode = false;
            ctxMergeSuspended = false;
        }
    }
    if (!curId) {                                  // 没有子窗：只有主窗（位置不动）
        for (const id of CHILD_POPUP_IDS) {
            const el = document.getElementById(id);
            if (el) el.style.display = 'none';
        }
        setMainHiddenForPair(false);
        captureMainSlot();      // 主窗重新可见 → 刷新"主窗自己的槽位"（下次开子窗时按它算落点）
        pairCurrentId = null;
        pairExtraId = null;
        return;
    }
    const pid = parentChildId();
    const curEl = document.getElementById(curId);
    const parEl = pid ? document.getElementById(pid) : mainEl;
    // 可见集合：父窗 + 当前窗（+ 三窗例外里的 extra 那一层）；其余子窗（更深的层级）一律隐藏；
    // 主窗只在它是父窗时可见
    const extraId = (pairExtraId && pairExtraId !== curId && pairExtraId !== pid
        && document.getElementById(pairExtraId)) ? pairExtraId : null;
    for (const id of CHILD_POPUP_IDS) {
        const el = document.getElementById(id);
        if (!el) continue;
        // 成对模式挂起期间（「目录 | 条目来源」两窗）不得把完整上下文窗亮回来
        if (ctxMergeMode && ctxMergeSuspended && id === CTX_MERGED_ID) { el.style.display = 'none'; continue; }
        el.style.display = (id === curId || id === pid || id === extraId) ? 'flex' : 'none';
    }
    setMainHiddenForPair(!!pid);

    // 父窗**一动不动**（主窗 = 最高一级父窗，位置由插件自己管；子窗用它自己当前的位置）；
    // 子窗尺寸跟随父窗的实际尺寸（同宽，最小高度按 childPopupTable 兜底）
    const slot = (parEl === mainEl ? captureMainSlot() : readWindowSlot(parEl))
        || captureMainSlot() || { left: PAIR_MARGIN, top: PAIR_MARGIN, width: 420, height: 480 };
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = slot.width, h = slot.height;
    // 子窗开在父窗的**另一侧**：父窗中心落在视口左半边（含正中）→ 往右；落在右半边 → 往左。
    // 三窗例外（extra 非空）时改为"开在 extra 的对面"—— 例：条目来源在中、查看器在右 ⇒ 条目详情落到最左，
    // 三窗（左/中/右）互不重叠。
    const extraEl = extraId ? document.getElementById(extraId) : null;
    const extraSlot = extraEl ? readWindowSlot(extraEl) : null;
    const goLeft = extraSlot
        ? ((extraSlot.left + extraSlot.width / 2) > (slot.left + w / 2))
        : ((slot.left + w / 2) > vw / 2);
    const nearLeft = goLeft ? slot.left - w - PAIR_GAP : slot.left + w + PAIR_GAP;
    const farLeft = goLeft ? slot.left + w + PAIR_GAP : slot.left - w - PAIR_GAP;
    const fitsAt = l => l >= PAIR_MARGIN && l + w <= vw - PAIR_MARGIN;
    const overlay = !fitsAt(nearLeft) && !fitsAt(farLeft);  // 首选那侧放不下 → 另一侧；两侧都放不下 → 居中叠放
    // 叠放时贴着父窗（父窗在视口内 → 完全重叠）；但父窗自己已在视口外（桌面窗口被缩小后子窗没跟着重排）时，
    // 把当前窗钳进视口 —— 父窗不动，至少保证"当前窗看得见"。
    const clampIn = l => Math.max(PAIR_MARGIN, Math.min(l, Math.max(PAIR_MARGIN, vw - w - PAIR_MARGIN)));
    const left = fitsAt(nearLeft) ? nearLeft
        : (fitsAt(farLeft) ? farLeft : clampIn(slot.left));
    if (curEl) {
        const curH = Math.max(h, Math.min(minHeightOf(curId) || 0, vh - 2 * PAIR_MARGIN));
        curEl.style.width = w + 'px';
        curEl.style.height = curH + 'px';
        curEl.style.left = left + 'px';
        // 正常与父窗同顶；子窗更高（最小高度）时只上移必要的量，不越出视口
        curEl.style.top = Math.max(PAIR_MARGIN, Math.min(slot.top, Math.max(PAIR_MARGIN, vh - curH - PAIR_MARGIN))) + 'px';
    }
    // 叠放（两侧都放不下）时"当前窗"必须压住父窗；并排时不需要（陈旧类已在函数开头统一清掉，这里只 add）
    if (overlay) {
        if (parEl && parEl.classList) parEl.classList.add('hh-pair-under');
        if (curEl && curEl.classList) curEl.classList.add('hh-pair-front');
    }
}

// 各 open* 的落点入口（第二十三轮起位置统一由 layoutChildPair 决定；
// 调用方还没登记"当前窗"时，用它兜底登记）
function positionChildPopup(popupEl) {
    if (popupEl && popupEl.id && CHILD_POPUP_IDS.includes(popupEl.id) && !pairCurrentId) pairCurrentId = popupEl.id;
    layoutChildPair();
}

// 视口变化：子窗重新落位（父窗不动）
// ⚠️ 第二十九轮 R1：成对模式（目录居中 + 完整上下文贴右）的落点**完全依赖视口宽度**，
//   窗口一改大小就必须重算，否则两窗会停在旧坐标、甚至跑出视口（实测：1536 → 900 后右窗跑到 1108）。
//   `layoutChildPair()` 在成对模式下会转交 `layoutOutlineMergePair()`，故这里只要调它即可。
function repositionChildPopups() {
    layoutChildPair();
}

// 全局只绑一次的窗口 resize 监听：任何子窗/成对窗口开着时都能跟随重排。
// （原来只在「魔杖按钮打开主弹窗」时绑，demo / 控制台入口打开的窗口不跟随 —— 实测踩过）
let ctxResizeBound = false;
function ensureChildPopupResizeHandler() {
    if (ctxResizeBound || typeof window.addEventListener !== 'function') return;
    ctxResizeBound = true;
    window.addEventListener('resize', () => {
        if (pairCurrentId || ctxMergeMode) repositionChildPopups();
    }, { passive: true });
}

function positionEntryPopup() {
    positionChildPopup(document.getElementById('hide-helper-entry-popup'));
}

// 显示条目详情弹窗前先走层级入口：原可见窗**原地不动**，成为它的**父窗**。
// keepId（第二十七轮）：需要**继续留在屏幕上**的那一层（第三窗）。从「条目来源」里点开条目时传它，
// 于是屏幕上出现「条目详情(左) | 条目来源(中) | 完整上下文查看器(右)」三窗（用户口径：这是预期的）。
// ⚠️ R1（用户实测）：本窗**已经开着**时（= 只是"换一条条目"）→ 位置与层级**原样不动**：
//     `pairExtraId` 沿用它原来的值（不因为"这次没传 keepId"把第三窗丢掉、把本窗甩到另一侧），
//     位置仍由同一套（父窗槽位 + extra 槽位）关系算出 → 结果与原位一致。
function showEntryPopup({ keepId = null } = {}) {
    const sameWindow = currentChildId() === 'hide-helper-entry-popup';
    const prevExtra = pairExtraId;
    focusChildPopup('hide-helper-entry-popup');
    if (sameWindow) {
        pairExtraId = (prevExtra && prevExtra !== 'hide-helper-entry-popup') ? prevExtra : null;
    } else {
        pairExtraId = (keepId && keepId !== 'hide-helper-entry-popup') ? keepId : null;
    }
    const el = ensureEntryPopup();
    el.style.display = 'flex';
    positionEntryPopup();
}

function closeEntryPopup() {
    // × / Esc：只退一层 —— 关条目详情 → 回到打开它的那个窗口（**不再把父窗一起关掉**）
    closeChildPopupAt('hide-helper-entry-popup');
}

// 读取世界书条目定义：优先 uid 精确匹配，其次按条目名（comment）匹配。
// 返回 { entry, uid }（uid 为世界书里的真实键；旧锚点记录里没有 uid 时子窗靠它显示）。
async function fetchWorldEntryDetail(book, name, uid) {
    if (!book) return null;
    try {
        const data = await loadWorldInfo(book);
        const entries = data?.entries || {};
        const hasUid = uid !== null && uid !== undefined && uid !== '';
        if (hasUid && entries[uid]) return { entry: entries[uid], uid };
        for (const key of Object.keys(entries)) {
            if (entries[key]?.comment === name) return { entry: entries[key], uid: key };
        }
        return null;
    } catch (e) {
        Logger.warn('【条目详情】读取世界书失败:', e);
        return null;
    }
}

// 构建条目详情 HTML。
// 返回 { html, type, typeText }：条目名的着色与副标题行右侧的类型徽标由调用方按 type/typeText 渲染
// （它们不在 body 里，而在子窗头部），故这里一并返回。
// extra = { uid, uidFallback }：UID 单独占一行 —— 放在原来「内容（content）」行的位置（内容本身不再展示）。
async function buildEntryDetailHtml(entry, fallbackType, extra = {}) {
    const type = entryHasEjs(entry) ? 'ejs' : (entry.constant ? 'constant' : (fallbackType || 'dynamic'));
    const typeText = { ejs: TYPE_FILTER_LABELS.ejs, constant: TYPE_FILTER_LABELS.constant, dynamic: TYPE_FILTER_LABELS.dynamic }[type] || TYPE_FILTER_LABELS.dynamic;

    const keys = Array.isArray(entry.key) ? entry.key.filter(k => k !== undefined && k !== null && String(k).length) : [];
    const secKeys = Array.isArray(entry.keysecondary) ? entry.keysecondary.filter(k => k !== undefined && k !== null && String(k).length) : [];
    const selectiveLogicLabels = { 0: '任一主键 + 任一次键', 1: '任一主键 + 全部次键', 2: '任一主键 + 非全部次键', 3: '任一主键 + 无次键' };
    const logicText = selectiveLogicLabels[Number(entry.selectiveLogic)] ?? '';

    // 第二十九轮 R1（口径⑤）：**不再显示「插入位置」行** —— 用户口径"条目详情里不显示它"。
    //   位置信息仍可从条目列表行的第二行（`.tub-nli-pos`）看到，详情窗只保留关键词 / 顺序 / 递归 / UID·tokens / 内容。
    const orderText = Number(entry.order) || 0;

    // 「递归」行的两个只读勾选项：勾上=绿色（该项已生效），未勾=红色（该项未生效）。
    // 只读展示：详情子窗原本就是纯读取视图，点一下就能改世界书文件不在本轮范围内。
    const checkItem = (label, on) => `<span class="hide-entry-check hide-entry-check-${on ? 'on' : 'off'}" title="${on ? '已启用' : '未启用'}">
                <span class="hide-entry-checkbox hide-entry-checkbox-${on ? 'on' : 'off'}">${on ? '✓' : ''}</span>${label}</span>`;
    const recursionHtml = `<span class="hide-entry-checks">${checkItem('不可递归', !!entry.excludeRecursion)}${checkItem('防止进一步递归', !!entry.preventRecursion)}</span>`;

    const row = (label, valueHtml) => `<div class="hide-entry-row"><span class="hide-entry-label">${label}</span><span class="hide-entry-value">${valueHtml}</span></div>`;

    const keysHtml = keys.length
        ? keys.map(k => `<span class="hide-entry-key">${escapeHtmlText(k)}</span>`).join('')
        : '<span class="hide-entry-none">无</span>';
    const secKeysHtml = secKeys.length
        ? secKeys.map(k => `<span class="hide-entry-key hide-entry-key-sec">${escapeHtmlText(k)}</span>`).join('')
        : '';

    // 「UID / tokens」行：占据原来「内容（content）」标签行的位置 —— **左侧显示 UID，右侧显示 tokens**。
    // tokens 口径 = 世界书编辑器给条目显示的口径：`cachedTokenCount(entry.content)`（宏未替换、keys 不计入）；
    // 与「本次发送中命中多少 token」（列表里的数字）是两回事。
    // uid 回退顺序：锚点记录/行属性 → 世界书真实键（extra.uidFallback）。旧锚点记录无 uid 时靠后者。
    const pickUid = (...cands) => {
        for (const c of cands) {
            if (c !== null && c !== undefined && c !== '') return c;
        }
        return null;
    };
    const uidValue = pickUid(extra.uid, extra.uidFallback, entry.uid);
    const entryTokens = await cachedTokenCount(String(entry.content ?? ''));
    const metaRowHtml = `<div class="hide-entry-row hide-entry-meta-row">
            <span class="hide-entry-uid">UID ${uidValue === null ? '—' : escapeHtmlText(String(uidValue))}</span>
            <span class="hide-entry-tokens">${entryTokens} tokens</span>
        </div>`;

    const html = `
        ${row('关键词', keysHtml)}
        ${secKeys.length ? row('次关键词', secKeysHtml + (logicText ? `<span class="hide-entry-logic">（${logicText}）</span>` : '')) : ''}
        ${row('顺序', `<span class="hide-entry-plain">${orderText}</span>`)}
        ${row('递归', recursionHtml)}
        ${metaRowHtml}
        <div class="hide-entry-content">${escapeHtmlText(entry.content ?? '')}</div>
    `;
    return { html, type, typeText };
}

// 渲染子窗头部：条目名按类型着色（红=EJS / 蓝=常驻 / 绿=动态），副标题行 = 左「所属世界书」+ 右「类型徽标」。
// 与 buildEntryDetailHtml 的 type 口径完全一致（entryHasEjs → constant → 传入的 fallback）。
function setEntryPopupHead({ name, book, type }) {
    const nameEl = document.getElementById('hide-entry-name');
    const subEl = document.getElementById('hide-entry-sub');
    if (nameEl) {
        nameEl.textContent = name || '条目详情';
        nameEl.classList.remove('hide-entry-name-ejs', 'hide-entry-name-constant', 'hide-entry-name-dynamic');
        if (type) nameEl.classList.add(`hide-entry-name-${type}`);
    }
    if (subEl) {
        const typeText = { ejs: TYPE_FILTER_LABELS.ejs, constant: TYPE_FILTER_LABELS.constant, dynamic: TYPE_FILTER_LABELS.dynamic }[type] || '';
        const badge = typeText ? `<span class="hide-entry-type hide-entry-type-${type}">${typeText}</span>` : '';
        subEl.innerHTML = `<span class="hide-entry-book">${escapeHtmlText(book || '')}</span>${badge}`;
    }
}

// 打开/刷新条目详情弹窗。连续点击不同条目时，旧请求结果按序号丢弃，只显示最后一次点击的条目。
// 参数：{ book, name, uid, type }（type 来自行上的 data-type，作为读取完成前的着色提示）
// 落点：由 layoutChildPair 统一决定（第二十四轮起：父窗原位、本窗开在它的另一侧）。
// 第二十七轮：若本窗是从「条目来源」里点开的，则**同时保留第三窗**（条目来源的父窗，通常是完整上下文查看器），
//   本窗落在条目来源的另一侧 → 「条目详情(左) | 条目来源(中) | 查看器(右)」。其它入口仍是两窗。
async function openEntryDetailPopup({ book, name, uid, type }) {
    const el = ensureEntryPopup();
    const bodyEl = document.getElementById('hide-entry-body');
    if (!bodyEl) return;

    const seq = ++entryPopupSeq;
    const hintType = ['ejs', 'constant', 'dynamic'].includes(type) ? type : '';
    setEntryPopupHead({ name, book, type: hintType });
    bodyEl.innerHTML = '<div class="tub-empty-state">正在读取条目…</div>';
    // 第三窗：当前窗是「条目来源」时，把它的父窗（通常是完整上下文查看器）也留在屏幕上
    const keepId = currentChildId() === 'hide-helper-wi-msg-popup' ? parentChildId() : null;
    showEntryPopup({ keepId });

    const found = await fetchWorldEntryDetail(book, name, uid);
    if (seq !== entryPopupSeq) return; // 期间又点了别的条目：丢弃本次结果
    if (!found?.entry) {
        bodyEl.innerHTML = '<div class="tub-empty-state">未能读取到该条目（可能已被删除、重命名，或不属于可读取的世界书）。</div>';
        positionEntryPopup();
        return;
    }
    const { entry, uid: realUid } = found;
    // uid 回退顺序：调用方给的（锚点记录/行属性）→ 世界书真实键
    const built = await buildEntryDetailHtml(entry, type, { uid, uidFallback: realUid });
    if (seq !== entryPopupSeq) return; // 构建期间（含 token 统计等异步）又换了条目
    setEntryPopupHead({ name: entry.comment || name, book: book || entry.world || '', type: built.type });
    bodyEl.innerHTML = built.html;
    bodyEl.scrollTop = 0;
    positionEntryPopup();
}

// ==================== 聊天统计 · 「聊天」子弹窗 ====================
// 点击概览行的「聊天」统计框，弹出一个小浮层（贴框显示，形态上区别于条目详情子窗的"整窗并排"）：
//   · 实际发送范围：**本次实际发送**的首/末条 messageID（来自锚点 sentChat；旧锚点由当前聊天兜底）
//   · AI 平均 tokens：当前聊天**最新 N 条 AI 消息**的 token 均值
//   · AI 平均生成速度：同上这批消息里"有耗时记录"的那些的 t/s 均值
//   · 两条折线：输出 tokens（折线一）与生成速度（折线二），同一批消息、不同配色
// 口径（用户 §2.26）：除「实际发送范围」外，AI 相关统计都不要求"实际发送"，只取最新的 N 条 AI messageID；
// token/耗时均取聊天里 ST 原生现成字段（token_count / gen_started / gen_finished），故无需额外持久化，
// 刷新页面或切换聊天后仍能从聊天历史立即重建。
const AI_HISTORY_COUNT = 7;
let chatStatsPopupSeq = 0;
let chatStatsPopupAnchor = null; // 当前浮层所贴的统计框元素（用于 toggle 与"点外部关闭"判定）
let chatStatsPopupModel = null;  // 当前浮层对应的统计模型（供"完整上下文"按钮等复用）

function ensureChatStatsPopup() {
    let el = document.getElementById('hide-helper-chat-stats-popup');
    if (el) return el;
    // 与条目详情子窗同款：带 .hide-helper-popup 基础类（入场动画 / 亮暗变量 / 固定定位），
    // 尺寸与位置由 positionChildPopup 内联写入（与父窗同尺寸、开在父窗的另一侧）。
    $('body').append(`
        <div id="hide-helper-chat-stats-popup" class="hide-helper-popup hide-helper-chat-stats-popup" style="display: none;">
            <button id="hide-helper-chat-stats-close" class="hide-helper-popup-close-icon" title="关闭">&times;</button>
            <div class="hcs-title">聊天统计详情</div>
            <div class="hcs-body" id="hcs-body"></div>
        </div>
    `);
    el = document.getElementById('hide-helper-chat-stats-popup');
    $('#hide-helper-chat-stats-close').on('click', () => closeChatStatsPopup());
    // 内容区滚动条与条目详情子窗 / 完整上下文查看器同款：默认隐藏，滚动/悬停拖拽时才显色
    //（见 initHiddenScrollbar 与 CSS 的 .hh-sb-*）。**必须绑**——只靠 CSS 的 scrollbar-width 会退回平台原生滚动条。
    initHiddenScrollbar(el.querySelector('#hcs-body'));
    // Esc 关闭交给主弹窗那个统一处理器（keydown.hideHelperEsc）：它优先关"当前子窗"、只退一层。
    // **不再**点外部自动关闭：本子窗与父窗并排显示，点主窗是正常操作（切换锚点/查看条目），不应把它收掉。
    const theme = extension_settings[extensionName]?.theme || 'light';
    if (theme === 'dark') el.setAttribute('data-theme', 'dark');
    return el;
}

function closeChatStatsPopup() {
    chatStatsPopupAnchor = null;
    closeChildPopupAt('hide-helper-chat-stats-popup');   // × / Esc / 再点统计框：只退一层
}

// 统计框点击：已开着同一框 → 关闭；否则重开（与主窗同尺寸、开在主窗的另一侧）。
function toggleChatStatsPopup(model, anchorEl) {
    const el = document.getElementById('hide-helper-chat-stats-popup');
    if (el && el.style.display !== 'none' && chatStatsPopupAnchor === anchorEl) {
        closeChatStatsPopup();
        return;
    }
    openChatStatsPopup(model, anchorEl);
}

// 一条 AI 回复的输出 tokens：优先用 ST 记录的 extra.token_count（与消息上的计时同源），
// 缺失（未开启"消息 token 计数"设置）时回退按正文分词计数。
async function replyOutputTokens(msg) {
    if (!msg) return 0;
    const tc = Number(msg.extra?.token_count);
    if (Number.isFinite(tc) && tc > 0) return tc;
    return await cachedTokenCount(String(msg.mes ?? ''));
}

// 一条 AI 回复的生成耗时（秒）：**从后端字段算** —— `message.gen_started` / `message.gen_finished`
// （ST 在 `script.js` 生成收尾时写到消息对象上、随聊天落盘；swipe 时由 `syncSwipeToMes` 同步为当前版本的值）。
// ⚠️ 绝不读前端 DOM：消息上的计时显示可被用户手动关闭，DOM 取不到 ≠ 没有记录。
// 时间值可能是 Date / ISO 字符串 / 毫秒数，统一走 `new Date()`；缺失或非正耗时 → null。
function replySeconds(msg) {
    const parseMs = (t) => {
        if (t === null || t === undefined || t === '') return null;
        const v = new Date(t).getTime();
        return Number.isFinite(v) ? v : null;
    };
    const s = parseMs(msg?.gen_started);
    const f = parseMs(msg?.gen_finished);
    if (s === null || f === null) return null;
    const sec = (f - s) / 1000;
    return Number.isFinite(sec) && sec > 0 ? sec : null;
}

// 采集**当前聊天里最新的 cap 条"有生成时间记录"的 AI 消息**（用户口径：不必是"实际发送"的那些，
// 只要是最新的 N 条 AI messageID）。
// ⚠️ 没有生成时间的 AI 消息**一律不计入**（用户口径）：ST 里 #0 这条可以是从别处"提取 / 人为预置"的，
// 它没有 gen_started/gen_finished —— 计入会让均值与折线失真；被导入或清理过时间的老消息同理排除。
// 第三十五轮用户口径②：**再显式过滤掉 messageID = 0（#0）** 的那条 —— 即便它带有生成时间
//   （例如用脚本注入的"开场白"、或用户手动补过时间），也不进 AI 统计（均值 / 速度 / 两条折线）。
//   #0 在 ST 里既可能是 system/预置楼层、也可能是被导入的首条，口径不稳定，故一律剔除。
// AI 平均 tokens / AI 平均生成速度 / 两条折线都基于这一份数据。返回按聊天顺序从旧到新。
// 注意：缺 token_count 的会由调用方补算（`replyOutputTokens`），不在这里过滤。
function collectLatestAiMessages(chat, cap = AI_HISTORY_COUNT) {
    const out = [];
    if (!Array.isArray(chat)) return out;
    for (let i = chat.length - 1; i >= 0 && out.length < cap; i--) {
        // 用户口径②：messageID = 0（#0）的数据统计一律不要
        if (i === 0) continue;
        const m = chat[i];
        if (!m || m.is_user) continue;
        const seconds = replySeconds(m);
        if (seconds === null) continue; // 无生成时间记录（人工预置 / 提取 / 导入）→ 不进任何 AI 统计
        out.push({ index: i, msg: m, tokens: null, seconds, tps: null });
    }
    return out.reverse();
}

// 迷你折线（通用，**带横纵坐标 + 每点数值标注**）：points = [{ value, mesid, tip }]，null/非有限值的点直接跳过。
//   纵轴：max / mid / min 三档刻度文字 + 浅色网格线；
//   横轴：各点对应的聊天 messageID（`#N`），刻度就是数据点本身；
//   数值标注（用户口径 §2.29）：每个点旁直接写出它的数值——
//     · 峰点（含平坦段）标在点**上方**、谷点标在点**下方**（永远待在折线外侧，不压线）；
//     · 非极值点按局部走向选边（正在上升 → 上方、正在下降 → 下方）；
//     · 最后按画布边界夹一次：会撞到上沿 / 横轴刻度行的自动翻到另一侧，保证不被裁掉。
// tone 决定配色（折线一 = 输出 tokens / 折线二 = 生成速度），两线用不同颜色便于区分。
// valueText 负责把数值格式化（tokens 取整 / 速度保留一位小数），纵轴刻度与点标注共用同一套格式。
function renderSparkline(points, { width = 380, height = 132, tone = 'tokens', valueText = (v) => String(Math.round(v)) } = {}) {
    const pts = (points || []).filter(p => p && Number.isFinite(p.value));
    if (pts.length < 2) {
        return '<div class="hcs-chart-empty">至少需要 2 条可用记录才能画折线</div>';
    }
    // padT 由 10 提到 22：给"最高点上方那行数值"留位置（否则最大值的标注会被画布切掉）
    // padT 由 10 提到 22：给"最高点上方那行数值"留位置（否则最大值的标注会被画布切掉）
    const padL = 54, padR = 12, padT = 22, padB = 26;
    // 数据区上下再各留一点：让"峰点上 / 谷点下"的数值都放得下——否则底部的谷点只能翻到上方，
    // 正好落进 V 形夹角里，会被折线穿字（实测：底部谷点翻面后 20~46/240 个采样点落在字上）。
    const dataTopInset = 2, dataBottomInset = 16;
    const innerW = width - padL - padR;
    const plotTop = padT + dataTopInset, plotBottom = height - padB - dataBottomInset;
    const vals = pts.map(p => p.value);
    let min = Math.min(...vals), max = Math.max(...vals);
    if (max - min < 1e-9) { // 平坦数据：上下各留一点余量，避免贴边
        const margin = Math.abs(max) > 2 ? Math.abs(max) * 0.05 : 1;
        min = Math.max(0, min - margin);
        max = max + margin;
    }
    const x = (i) => padL + (innerW * i) / (pts.length - 1);
    const y = (v) => plotTop + (plotBottom - plotTop) * (1 - (v - min) / (max - min));
    const line = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
    const axisBottom = height - padB;

    // 纵轴：三档刻度（max / mid / min）+ 横向网格线
    const yTicks = [max, (min + max) / 2, min];
    const grid = yTicks.map((t) => {
        const yy = y(t).toFixed(1);
        return `<line class="hcs-axis-grid" x1="${padL}" y1="${yy}" x2="${width - padR}" y2="${yy}" />`
            + `<text class="hcs-axis-label" x="${padL - 6}" y="${yy}" text-anchor="end" dominant-baseline="central">${escapeHtmlText(valueText(t))}</text>`;
    }).join('');

    // 横轴：每个数据点一个 messageID 刻度
    const xLabels = pts.map((p, i) =>
        `<text class="hcs-axis-label" x="${x(i).toFixed(1)}" y="${axisBottom + 8}" text-anchor="middle">#${escapeHtmlText(String(p.mesid ?? i))}</text>`
    ).join('');

    // 数值标注该放哪一侧：峰 / 平坦 → 上方（先判它：平坦段既 ≥ 又 ≤）；谷 → 下方；其余按走向选"背线"的一侧
    const sideOf = (i) => {
        const v = pts[i].value;
        const p = i > 0 ? pts[i - 1].value : v;
        const n = i < pts.length - 1 ? pts[i + 1].value : v;
        if (v >= p && v >= n) return 'above';
        if (v <= p && v <= n) return 'below';
        return n > v ? 'above' : 'below';
    };
    const LABEL_TOP_LIMIT = 9;                 // 标注允许的最高基线（画布内留白）
    const LABEL_BOTTOM_LIMIT = axisBottom - 3; // 不许压到横轴 messageID 那一行
    const labelPos = (i) => {
        const vy = y(pts[i].value);
        let above = sideOf(i) === 'above';
        let ty = above ? vy - 7 : vy + 12;
        if (ty < LABEL_TOP_LIMIT) { above = false; ty = vy + 12; }   // 顶到上沿 → 翻到下方
        if (ty > LABEL_BOTTOM_LIMIT) { above = true; ty = vy - 7; }  // 压到横轴 → 翻到上方
        if (ty < LABEL_TOP_LIMIT) ty = LABEL_TOP_LIMIT;              // 两侧都放不下（极扁画布）→ 夹住不越界
        if (ty > LABEL_BOTTOM_LIMIT) ty = LABEL_BOTTOM_LIMIT;
        return { above, ty };
    };
    const dots = pts.map((p, i) =>
        `<circle class="hcs-spark-dot hcs-spark-dot-${tone}" cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="2.8"><title>${escapeHtmlText(p.tip || String(p.value))}</title></circle>`
    ).join('');
    // 首点左对齐、末点右对齐、中间点居中；再按"危险侧"水平微移最多 8px：
    //   标注在上方时，危险侧 = 邻居**更高**的那一边（那条折线是往上爬的，会从标注里穿过去）；
    //   标注在下方时，危险侧 = 邻居**更低**的那一边（那条折线往下走，同理）。
    //   只在一侧危险时往另一侧挪；两侧都危险或都不危险就居中（这时折线不会切进标注）。
    const shiftOf = (i) => {
        const v = pts[i].value;
        const p = i > 0 ? pts[i - 1].value : v;
        const n = i < pts.length - 1 ? pts[i + 1].value : v;
        const above = sideOf(i) === 'above';
        const dangerRight = above ? (n > v) : (n < v);
        const dangerLeft = above ? (p > v) : (p < v);
        if (dangerRight && !dangerLeft) return -8;
        if (dangerLeft && !dangerRight) return 8;
        return 0;
    };
    const pointLabels = pts.map((p, i) => {
        const { ty } = labelPos(i);
        const anchor = i === 0 ? 'start' : (i === pts.length - 1 ? 'end' : 'middle');
        const base = i === 0 ? -2 : (i === pts.length - 1 ? 2 : 0);
        let cx = x(i) + Math.max(-10, Math.min(10, base + shiftOf(i)));
        // 首点不许往左压到纵轴刻度列（刻度文字右对齐到 padL-6）
        if (i === 0) cx = Math.max(padL - 2, cx);
        return `<text class="hcs-pt-label hcs-pt-label-${tone}" x="${cx.toFixed(1)}" y="${ty.toFixed(1)}" text-anchor="${anchor}">${escapeHtmlText(valueText(p.value))}</text>`;
    }).join('');
    return `<svg class="hcs-chart" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
        ${grid}
        <line class="hcs-axis-line" x1="${padL}" y1="${padT}" x2="${padL}" y2="${axisBottom}" />
        <line class="hcs-axis-line" x1="${padL}" y1="${axisBottom}" x2="${width - padR}" y2="${axisBottom}" />
        <polyline class="hcs-spark-line hcs-spark-line-${tone}" points="${line}" fill="none" />
        ${dots}
        ${pointLabels}
        ${xLabels}
    </svg>`;
}

// 打开/刷新「聊天」统计子窗（与父窗同尺寸；开在父窗的另一侧）。
// 异步补算缺失的 token（旧聊天可能无 token_count），用序号丢弃过期结果。
async function openChatStatsPopup(model, anchorEl) {
    const el = ensureChatStatsPopup();
    const bodyEl = document.getElementById('hcs-body');
    if (!bodyEl) return;
    const seq = ++chatStatsPopupSeq;
    chatStatsPopupAnchor = anchorEl || null;
    chatStatsPopupModel = model || null;

    bodyEl.innerHTML = '<div class="hcs-loading">正在读取…</div>';
    el.style.display = 'flex';
    focusChildPopup('hide-helper-chat-stats-popup');  // 单槽位：原可见子窗压栈（左上角出现「← 返回」）
    positionChildPopup(el);

    const stats = model?.stats || {};
    const chat = getContext?.()?.chat;

    // 1) 实际发送的聊天消息范围 = **本次实际发送**的首/末条 messageID（这一项必须用真实发送口径）
    let rangeHtml;
    const rc = stats.sentChat;
    if (rc && Number.isFinite(rc.first) && Number.isFinite(rc.last)) {
        rangeHtml = `<span class="hcs-range">#${rc.first} → #${rc.last}</span><small>共 ${rc.count} 条</small>`;
    } else {
        // 旧锚点（无 sentChat）或模拟锚定：由当前聊天兜底推导首/末条序号
        const edges = contextSendableEdges(model);
        rangeHtml = (edges && Number.isFinite(edges.first) && Number.isFinite(edges.last))
            ? `<span class="hcs-range">#${edges.first} → #${edges.last}</span><small>旧数据（按当前聊天推算）</small>`
            : '<span class="hcs-plain">—</span>';
    }

    // 2~4) AI 平均 tokens / AI 平均生成速度 / 两条折线：全部取**当前聊天最新的 N 条"有生成时间"的 AI 消息**
    //      （实时算，不落盘；无生成时间的 AI 消息整体不计入——见 collectLatestAiMessages）
    const aiHist = collectLatestAiMessages(chat, AI_HISTORY_COUNT);
    const tokenPoints = [], speedPoints = [];
    let tokenSum = 0, speedSum = 0, speedCount = 0;
    for (const h of aiHist) {
        const v = h.tokens !== null ? h.tokens : await replyOutputTokens(h.msg);
        if (seq !== chatStatsPopupSeq) return;
        h.tokens = v;
        tokenSum += v;
        const tps = (h.seconds && v > 0) ? v / h.seconds : null;
        h.tps = tps;
        if (tps !== null) { speedSum += tps; speedCount++; }
        const base = `聊天 #${h.index} · ${v} tokens`;
        tokenPoints.push({ value: v, mesid: h.index, tip: base });
        speedPoints.push({ value: tps, mesid: h.index, tip: `${base}${tps !== null ? ` · ${tps.toFixed(1)} t/s` : ' · 无输出'}` });
    }
    const n = aiHist.length; // n = 有生成时间记录的消息条数（无记录的不参与均值）
    // 说明文本（"最近 N 条 AI 消息" / "最近 N 条有耗时记录"）已按用户口径删除：窗口数据由横轴 messageID 直接体现
    const aiTokenHtml = n
        ? `<span class="hcs-range">${Math.round(tokenSum / n)}</span>`
        : '<span class="hcs-plain">—</span>';
    const aiSpeedHtml = speedCount
        ? `<span class="hcs-range">${(speedSum / speedCount).toFixed(1)} t/s</span>`
        : '<span class="hcs-plain">—</span>';

    const chartHtml = `
        <div class="hcs-chart-block">
            <div class="hcs-chart-title">输出 tokens</div>
            ${renderSparkline(tokenPoints, { tone: 'tokens', valueText: (v) => String(Math.round(v)) })}
        </div>
        <div class="hcs-chart-block">
            <div class="hcs-chart-title">生成速度（t/s）</div>
            ${renderSparkline(speedPoints, { tone: 'speed', valueText: (v) => v.toFixed(1) })}
        </div>`;

    // 「查看完整上下文」按钮：**只有本锚点已有快照时**才出现。
    // 第三十四轮用户口径：把「没有快照 · 点此生成」（id `hcs-make-snapshot`）整个去掉，不再从这里生成快照；
    // 没有快照时这一行就**什么都不显示**（统计页顶部本来就有「模拟发送」，需要快照时用它）。
    const ctxAnchorId = model?.isSim ? SIM_ANCHOR_ID : model?.index;
    const ctxChatId = getContext?.()?.chatId;
    const ctxHasDump = !!(ctxChatId && ctxAnchorId !== undefined && ctxAnchorId !== null
        && contextDumpStore.has(contextDumpKey(ctxChatId, ctxAnchorId)));
    const ctxBtnHtml = ctxHasDump
        ? `<button type="button" class="hcs-ctx-btn" id="hcs-open-context">查看完整上下文（${contextDumpStore.get(contextDumpKey(ctxChatId, ctxAnchorId)).messages.length} 条）</button>`
        : '';

    bodyEl.innerHTML = `
        <div class="hcs-row"><span class="hcs-label">实际发送范围</span><span class="hcs-value">${rangeHtml}</span></div>
        <div class="hcs-row"><span class="hcs-label">AI 平均 tokens</span><span class="hcs-value">${aiTokenHtml}</span></div>
        <div class="hcs-row"><span class="hcs-label">AI 平均生成速度</span><span class="hcs-value">${aiSpeedHtml}</span></div>
        ${chartHtml}
        ${ctxBtnHtml}
    `;
    if (ctxHasDump) {
        const btn = document.getElementById('hcs-open-context');
        if (btn) btn.onclick = () => { closeChatStatsPopup(); openContextOutlinePopup(model); };
    }
    positionChildPopup(el); // 子窗内容/尺寸变化后重新与主窗对齐（高度与主窗一致）
}


// ==================== 开发/调试：不"重新生成消息"也能拿到并查看快照 ====================

// 安全提示：离线夹具 / 单测里没有 toastr（第二十六轮的开发入口也要能在那些环境跑）
function notify(kind, msg) {
    try { toastr?.[kind]?.(msg); } catch (e) { /* 忽略：没有 toastr 就算了 */ }
}
// 背景（用户口径，2026-10-16）：「每次我需要手动查看效果时，都要重新生成一遍消息，以便显示"完整上下文"，
//   这在现在的开发测试阶段非常麻烦。」→ 三条免重发的路子：
//   ① `refreshContextSnapshot()`：用当前上下文**静默跑一次模拟发送**（= 点「模拟发送」但跳过输入弹窗），
//      快照一落库就自动打开「完整上下文」查看器 —— 内容与真实发送一致（含世界书 / EJS 渲染），不消耗 token。
//   ② `openLatestContextViewer()`：打开本聊天**最近一份**快照（配合 localStorage 持久副本，刷新页面也还在）。
//   ③ `makeDemoContextDump()`：塞一份**合成快照**并打开 —— 完全不跑管线、不需要任何发送，纯看 UI / 布局用。
// 控制台入口：`hideHelperDev.snapshot()` / `.openViewer()` / `.demo()` / `.clear()`。
function latestContextDumpFor(chatId) {
    let best = null;
    for (const d of contextDumpStore.values()) {
        if (!chatId || d.chatId !== chatId) continue;
        if (!best || (d.at || 0) >= (best.at || 0)) best = d;
    }
    return best;
}

function openLatestContextViewer() {
    const chatId = getContext?.()?.chatId;
    const dump = latestContextDumpFor(chatId);
    if (!dump) {
        notify('info', '当前聊天还没有快照：点「立即生成快照（模拟发送）」，或在统计页点「模拟发送」。');
        return false;
    }
    openContextOutlinePopup({ isSim: dump.anchorId === SIM_ANCHOR_ID, index: dump.anchorId, genType: dump.genType });
    notify('success', `已打开最近的快照（${dump.messages?.length || 0} 条消息 · ${dump.total || 0} tokens）`);
    return true;
}

// 静默跑一次模拟发送（跳过输入弹窗）→ 等快照落库 → 按需直接打开「目录 + 完整上下文」
async function refreshContextSnapshot({ openViewer = true, waitMs = 8000 } = {}) {
    const context = getContext?.();
    if (!context?.chatId) { notify('warning', '当前没有打开的聊天，无法生成快照。'); return null; }
    if (simulateInProgress) { notify('warning', '模拟发送正在进行中，稍等一下再试。'); return null; }
    await runSimulateSend('');
    const key = contextDumpKey(context.chatId, SIM_ANCHOR_ID);
    const t0 = Date.now();
    while (!contextDumpStore.has(key) && Date.now() - t0 < waitMs) {
        await new Promise(r => setTimeout(r, 120));
    }
    const dump = contextDumpStore.get(key) || null;
    if (!dump) { notify('warning', '快照没有生成（详见控制台日志）。'); return null; }
    notify('success', `快照已更新：${dump.messages.length} 条消息 · ${dump.total} tokens`);
    if (openViewer) openContextOutlinePopup({ isSim: true, index: SIM_ANCHOR_ID, genType: dump.genType });
    return dump;
}

// 合成快照（不跑管线）：覆盖 目录 / 筛选 / 检索 / 世界书条目来源 / 长正文内部滚动 这些 UI 情形，纯调试用
function makeDemoContextDump() {
    const chatId = getContext?.()?.chatId || 'demo';
    const long = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行：用于测试"正文折叠 + 内部滚动"的长文本，含 ELDORIA 关键词。`).join('\n');
    const mk = (i, role, tokens, identifier, kind, text, wiEntries = null) => ({ i, role, tokens, identifier, kind, text, wiEntries });
    // ⚠️ 世界书条目的定位字段（第二十九轮口径④）：`pos` = 槽位序号*1e6 + 条目正文**在本槽位内**的字符偏移；
    //    `hint` = 条目正文的第一个行锚点（内容区按它在正文里 indexOf 出起点，比单靠 pos 稳）。
    //    演示数据里每条占一行 ⇒ 偏移 0 / 16 / 32。
    const wiText1 = '【世界书·前置】常驻设定：ELDORIA 是一座浮空城。\n【世界书·前置】补充设定：城里有三座钟塔。\n【世界书·前置】细节设定：钟塔只在黄昏鸣响。';
    const wiText2 = '【世界书·后置】补充设定：主角随身带着一枚旧铜钥匙。\n【世界书·后置】补充设定：钥匙上刻着看不懂的字。';
    // 第三十二轮：条目补上 `position / depth / role / order` —— 条目行第二行要用它们。
    //   ⚠️ 缺这两个字段时 `metaLine` 会**整行不渲染**，于是「条目来源」子窗里既看不到插入位置、
    //      也看不到顺序（本轮实测就踩到了：`posCount=0` 且 `orderCount=0`）。
    //   位置与 kinds 对应：前置=0、后置=1；深度注入=4（配 depth/role）。order 给个递增的值方便肉眼区分。
    const messages = [
        mk(0, 'system', 260, 'main', 'other', 'You are a helpful assistant.\n{{char}} 住在 ELDORIA。'),
        mk(1, 'system', 900, 'worldInfoBefore', 'wi-before', wiText1, [
            { name: '前置常驻条目', book: 'Eldoria', type: 'constant', uid: '90001', tokens: 600, anchor: null, pos: 1000000, hint: '【世界书·前置】常驻设定：ELDORIA 是一座浮空城。', position: 0, depth: 4, role: 0, order: 10 },
            { name: '前置动态条目', book: 'EldoriaNSFW', type: 'dynamic', uid: '90002', tokens: 300, anchor: null, pos: 1000016, hint: '【世界书·前置】补充设定：城里有三座钟塔。', position: 0, depth: 4, role: 0, order: 20 },
            { name: '前置细节条目', book: 'Eldoria', type: 'dynamic', uid: '90003', tokens: 120, anchor: null, pos: 1000032, hint: '【世界书·前置】细节设定：钟塔只在黄昏鸣响。', position: 0, depth: 4, role: 0, order: 30 },
        ]),
        // 同一个条目（90001）在第二条世界书消息里**也命中**了：第二十九轮之前，它的 pos 会被第一条消息的偏移"抢走"，
        // 于是这条消息里的条目全部失去定位（滚动联动"一下跳好几个"）。
        mk(2, 'system', 140, 'worldInfoAfter', 'wi-after', wiText2, [
            { name: '后置常驻条目', book: 'Eldoria', type: 'constant', uid: '90001', tokens: 90, anchor: null, pos: 2000000, hint: '【世界书·后置】补充设定：主角随身带着一枚旧铜钥匙。', position: 1, depth: 4, role: 0, order: 40 },
            { name: '后置动态条目', book: 'Eldoria', type: 'dynamic', uid: '90004', tokens: 50, anchor: null, pos: 2000022, hint: '【世界书·后置】补充设定：钥匙上刻着看不懂的字。', position: 1, depth: 4, role: 0, order: 50 },
        ]),
        mk(3, 'system', 60, 'authorsNote', 'other', 'AN：保持 ELDORIA 世界观一致。'),
        mk(4, 'user', 22, 'chatHistory-2', 'chat', '我们去 ELDORIA 的集市看看。'),
        mk(5, 'assistant', 180, 'chatHistory-1', 'chat', long),
        mk(6, 'user', 14, 'chatHistory-0', 'chat', '继续。'),
    ];
    const dump = { genType: 'normal', total: messages.reduce((s, m) => s + m.tokens, 0), source: 'simulate', messages };
    saveContextDump(chatId, SIM_ANCHOR_ID, 'simulate', dump);
    openContextOutlinePopup({ isSim: true, index: SIM_ANCHOR_ID, genType: 'normal' });
    notify('success', `已塞入演示快照（${messages.length} 条消息，不跑管线）`);
    return dump;
}

// 清空本地快照（内存 + localStorage）
function clearContextDumps() {
    contextDumpStore.clear();
    try { contextDumpStorage()?.removeItem(CONTEXT_DUMP_LS_KEY); } catch (e) { /* 忽略 */ }
    notify('info', '已清空本地快照（内存 + localStorage）。');
}

// 控制台 / Playwright 入口（免"重新生成消息"）
if (typeof window !== 'undefined') {
    window.hideHelperDev = {
        snapshot: refreshContextSnapshot,
        openViewer: openLatestContextViewer,
        demo: makeDemoContextDump,
        clear: clearContextDumps,
        latest: latestContextDumpFor,
    };
}
// ==================== 聊天统计 · 上下文快照（仅内存） ====================
// 数据来源：`contextDumpStore`（每次统计时写入的"实际发送的每条消息"快照），刷新/切聊天即清空。
// 第二十九轮（用户口径①）：原来的**第一层「完整上下文」查看器**整体删除（"内容太过重复"），
//   它的「筛选 / 检索 / 键盘导航」平移到「上下文目录」窗头部，「条目来源」子窗改由目录行打开；
//   快照的载入逻辑（本段）仍由成对窗口复用，故保留 `ctxDump` / `ctxModel` / `ctxMsgByIndex` 等状态。
let contextViewerKey = null;      // 当前快照键（沿用旧名：锚点视图 / 条目来源都按它判"换没换内容"）
let ctxModel = null;              // 打开时的 model（条目按"上下文顺序"排序要用它推序号）
let ctxDump = null;               // 当前快照
let ctxMsgByIndex = new Map();    // 序号 → 消息记录
let ctxSearchTerm = '';           // 目录检索词（第二十九轮：从查看器平移到目录）
let ctxSourceFilter = 'all';      // 'all' | 'chat' | 'wi' | 'other'
let ctxRoleFilter = 'all';        // 'all' | 'system' | 'user' | 'assistant'
let ctxHotkeysBound = false;      // 键盘导航的文档级监听只绑一次
let ctxHitCount = 0;              // 目录检索的命中总数
let ctxHitCursor = -1;            // 当前命中序号（0 起；-1 = 尚未跳转）
let ctxVisibleCount = 0;          // 目录筛选后可见的消息条数（"显示 x / y 条"）
// 第三十二轮：筛选后可见的消息（序号 → 记录）。与目录共用同一份筛选结果；
//   `ensureEntryLayout` / `jumpContextOutlineTo*` 这些"按序号找消息"的地方都应读它，
//   而不是无条件读 `ctxMsgByIndex`（后者是**全部**消息，筛选后会让内容区/条目定位对不上）。
let ctxVisibleMsgByIndex = new Map();

// 内联 SVG 图标（不依赖字体图标是否加载）：放大镜 / 条目来源 / 上一个 / 下一个
const HC_ICON_SEARCH = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>';
const HC_ICON_WI = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"></rect><line x1="9" y1="4" x2="9" y2="20"></line><path d="M13 9h5M13 14h5"></path></svg>';
const HC_ICON_UP = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"></path></svg>';
const HC_ICON_DOWN = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"></path></svg>';
// "跳到正文"图标（条目来源子窗用；第二十七轮 R2 建议⑥）：一个向右的箭头
const HC_ICON_JUMP = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h13"></path><path d="M12 7l5 5-5 5"></path></svg>';
// 第三十五轮：锚定栏行尾的两个入口图标（原来「模拟发送」按钮的位置）
//   · HC_ICON_OUTLINE = 「上下文目录 + 完整上下文」这一对窗口（左侧目录 + 右侧全文）
//   · HC_ICON_CHAT    = 「聊天」统计详情子窗
const HC_ICON_OUTLINE = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"></rect><line x1="9" y1="4" x2="9" y2="20"></line></svg>';
// 第三十九轮用户口径：`#tub-open-chat-stats` 的图标换成**统计图**（原来是对话气泡，看不出"统计"这件事）。
// 造型：三根高低不同的柱子 + 底部基线 —— 与子窗里那两张「输出 tokens / 生成速度」柱状折线图的语义一致。
// ⚠️ 几何必须让**柱子底边正好压在基线上**（y=21）：初次写的三根柱高 6/11/14.5、底边都停在 y=18，
//    离基线悬空 3px（用 DOM 逐个读 rect 才发现，肉眼在小尺寸下看不出来）。现按 `height = 21 - y` 对齐：
//    柱 1 y=12→h=9、柱 2 y=7→h=14、柱 3 y=3.5→h=17.5。
const HC_ICON_CHAT = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="21" x2="21" y2="21"></line><rect x="5" y="12" width="3.4" height="9" rx="0.8"></rect><rect x="10.3" y="7" width="3.4" height="14" rx="0.8"></rect><rect x="15.6" y="3.5" width="3.4" height="17.5" rx="0.8"></rect></svg>';
// 第三十五轮：上下文目录左上角的「折叠栏」图标（用户口径⑨，移动端用它展开/收起目录窗）
const HC_ICON_SIDEBAR = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"></rect><line x1="9" y1="4" x2="9" y2="20"></line></svg>';

// 槽位类型 → 简短中文标签（供每条消息的来源列显示）
const CONTEXT_KIND_LABELS = {
    'chat': '聊天', 'wi-before': '世界书·前置', 'wi-after': '世界书·后置', 'wi-depth': '世界书·深度',
    'wi-block': '世界书·混入', 'wi-merged': '世界书·合并', 'other': '其他',
};

// 目录里聊天子行的正文预览长度（第二十八轮用户口径：删掉来源列后，中间改显"正文前 N 个字符"）。
// 只是 DOM 里的字符上限 —— 视觉截断由 CSS 的省略号负责（行宽远小于 N），全文进 title 悬停可见。
const OUTLINE_PREVIEW_CHARS = 80;

// ---------- 纯函数（供离线单测）----------
// 来源分组：'chat'（聊天）| 'wi'（世界书）| 'other'（其他）
function ctxSourceGroupOf(kind) {
    if (kind === 'chat') return 'chat';
    if (isWiKind(kind)) return 'wi';
    return 'other';
}

// 筛选判定：两个维度都为 'all' 时恒真
function ctxMessageVisible(m, { source = 'all', role = 'all' } = {}) {
    if (source !== 'all' && ctxSourceGroupOf(m?.kind) !== source) return false;
    if (role !== 'all' && String(m?.role ?? '') !== role) return false;
    return true;
}

// 检索命中区间：大小写不敏感、**不重叠**的连续扫描（"aa" 在 "aaa" 里只算 1 个，不会在同一处重复标记）
function contextSearchHits(text, term) {
    const needle = String(term ?? '').toLowerCase();
    if (!needle) return [];
    const hay = String(text ?? '').toLowerCase();
    const out = [];
    let from = 0;
    for (;;) {
        const at = hay.indexOf(needle, from);
        if (at === -1) break;
        out.push({ start: at, end: at + needle.length });
        from = at + needle.length;
    }
    return out;
}

// 高亮 HTML：**先按命中区间切分、再逐段转义**（绝不在已转义文本上做替换，避免跨实体误匹配）。
// 每个 <mark> 带 data-<attr>="编号"（编号自 base 起），跳转时按编号精确定位。
function highlightTextHtml(text, term, { attr = '', base = 0, cls = 'hc-hit' } = {}) {
    const raw = String(text ?? '');
    const hits = contextSearchHits(raw, term);
    let html = '', cursor = 0;
    hits.forEach((h, n) => {
        html += escapeHtmlText(raw.slice(cursor, h.start));
        const attrHtml = attr ? ` ${attr}="${base + n}"` : '';
        html += `<mark class="${cls}"${attrHtml}>${escapeHtmlText(raw.slice(h.start, h.end))}</mark>`;
        cursor = h.end;
    });
    html += escapeHtmlText(raw.slice(cursor));
    return { html, count: hits.length };
}

// 「清空检索」图标：橡皮擦（比 `&times;` 直观 —— 用户口径）
const HC_ICON_ERASER = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 20H20"></path><path d="M14.6 3.9 3.8 14.7a2 2 0 0 0 0 2.8l2.7 2.7a2 2 0 0 0 2.8 0L20.2 9.3a2 2 0 0 0 0-2.8l-2.7-2.7a2 2 0 0 0-2.8 0z"></path><path d="M8 10.2l5.8 5.8"></path></svg>';

// 查看器工具栏的两个下拉菜单（来源 / 角色）——
// ⚠️ 不能复用 `openTypeFilterMenu`：它把菜单挂进窗口内部，而查看器是 `overflow: hidden`（菜单会被裁掉），
//   而且查看器可见时主弹窗可能正好是隐藏的（挂主弹窗会看不见）。
//   这里统一挂 `body` + `position: fixed` + 触发器的**视口坐标**定位（所见即所得，也不受入场动画 scale 影响）。
let ctxMenuEl = null, ctxMenuTrigger = null, ctxMenuCleanup = null;

function closeCtxFilterMenu() {
    if (ctxMenuCleanup) { ctxMenuCleanup(); ctxMenuCleanup = null; }
    if (ctxMenuTrigger) ctxMenuTrigger.classList.remove('open');
    ctxMenuEl?.remove();
    ctxMenuEl = null;
    ctxMenuTrigger = null;
}

function openCtxFilterMenu(triggerEl, { options = [], current = 'all', onPick } = {}) {
    closeCtxFilterMenu();
    if (!triggerEl || !options.length) return;
    const menu = document.createElement('div');
    menu.className = 'hh-menu';
    menu.setAttribute('role', 'menu');
    if ((extension_settings[extensionName]?.theme || 'light') === 'dark') menu.setAttribute('data-theme', 'dark');
    menu.innerHTML = options.map(([v, t]) =>
        `<button type="button" class="hh-menu-item${v === current ? ' active' : ''}" data-value="${escapeHtmlText(v)}">${escapeHtmlText(t)}</button>`).join('');
    document.body.appendChild(menu);          // 先入 DOM 才能量尺寸
    ctxMenuEl = menu;
    ctxMenuTrigger = triggerEl;
    triggerEl.classList.add('open');

    const tr = triggerEl.getBoundingClientRect();
    const M = 6, GAP = 4;
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = Math.max(M, Math.min(tr.left, vw - mw - M));
    let top = tr.bottom + GAP;
    if (top + mh > vh - M) top = Math.max(M, tr.top - mh - GAP);   // 下方放不下 → 翻到触发器上方
    menu.style.left = Math.round(left) + 'px';
    menu.style.top = Math.round(top) + 'px';

    menu.addEventListener('click', (ev) => {
        const item = ev.target?.closest?.('.hh-menu-item');
        if (!item) return;
        ev.stopPropagation();
        const value = item.getAttribute('data-value');
        closeCtxFilterMenu();
        onPick?.(value);
    });
    const onDocDown = (ev) => { if (!menu.contains(ev.target) && !triggerEl.contains(ev.target)) closeCtxFilterMenu(); };
    const onKey = (ev) => { if (ev.key === 'Escape') closeCtxFilterMenu(); };
    const onScrollOrResize = () => closeCtxFilterMenu();
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onScrollOrResize);
    ctxMenuCleanup = () => {
        document.removeEventListener('mousedown', onDocDown, true);
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('resize', onScrollOrResize);
    };
}

function toggleCtxFilterMenu(triggerEl, cfg) {
    if (ctxMenuTrigger === triggerEl) { closeCtxFilterMenu(); return; }
    openCtxFilterMenu(triggerEl, cfg);
}

// 工具栏的选项表（来源 / 角色）
const CTX_SOURCE_OPTIONS = [['all', '全部'], ['chat', '聊天'], ['wi', '世界书'], ['other', '其他']];
const CTX_ROLE_OPTIONS = [['all', '全部'], ['system', 'system'], ['user', 'user'], ['assistant', 'assistant']];

// ── 键盘导航（第二十九轮：查看器删除后保留在成对窗口上）──────────────────────────────
// ↑/↓ 或 J/K：在右侧内容区里逐条跳（左侧目录跟着高亮）；Home/End：首条 / 末条。
// ⚠️ 只在成对窗口开着、且目录窗是当前窗时生效；输入框 / 文本域里一律不拦（否则会吃掉正常输入）。
function topVisibleMessageIndex() {
    const bodyEl = document.getElementById('hcm-body');
    if (!bodyEl) return null;
    const top = bodyEl.getBoundingClientRect().top;
    for (const el of bodyEl.querySelectorAll('.hcm-chunk')) {
        if (el.getBoundingClientRect().bottom - top > 4) return Number(el.getAttribute('data-i'));   // 第一条还看得见的
    }
    return null;
}

function handleContextHotkeys(ev) {
    if (ev.altKey || ev.ctrlKey || ev.metaKey || ev.defaultPrevented) return;
    const t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (!ctxMergeMode || ctxMergeSuspended) return;
    if (currentChildId() !== CTX_OUTLINE_ID) return;
    const key = ev.key;
    let delta = 0, edge = null;
    if (key === 'ArrowDown' || key === 'j' || key === 'J') delta = 1;
    else if (key === 'ArrowUp' || key === 'k' || key === 'K') delta = -1;
    else if (key === 'Home') edge = 0;
    else if (key === 'End') edge = 1;
    else return;
    // 导航范围 = 目录当前可见的那些消息（筛选生效时只在筛选结果里走，别把筛选吞掉）
    // 第三十二轮：直接复用 ctxVisibleMessages()（与目录 / 内容区同一份筛选结果）
    const ids = ctxVisibleMessages().map(m => m.i);
    if (!ids.length) return;
    ev.preventDefault();
    const cur = ids.includes(ctxOutlineActiveIndex) ? ctxOutlineActiveIndex : topVisibleMessageIndex();
    let next;
    if (edge !== null) {
        next = ids[edge === 0 ? 0 : ids.length - 1];
    } else {
        const at = ids.indexOf(cur);
        const from = (at < 0) ? (delta > 0 ? -1 : ids.length) : at;
        next = ids[Math.max(0, Math.min(ids.length - 1, from + delta))];
    }
    jumpContextOutlineToMessage(next);
}

// 筛选菜单按钮的文案 + 选中态（第二十九轮：两个维度跟着工具栏一起搬到目录窗；非"全部"时按钮高亮）
function syncCtxFilterButtons() {
    const el = document.getElementById(CTX_OUTLINE_ID);
    if (!el) return;
    for (const [btnId, textId, value, options] of [
        ['hco-filter-source', 'hco-filter-source-text', ctxSourceFilter, CTX_SOURCE_OPTIONS],
        ['hco-filter-role', 'hco-filter-role-text', ctxRoleFilter, CTX_ROLE_OPTIONS],
    ]) {
        const btn = el.querySelector(`#${btnId}`);
        const textEl = el.querySelector(`#${textId}`);
        if (textEl) textEl.textContent = (options.find(([v]) => v === value) || options[0])[1];
        btn?.classList.toggle('active', value !== 'all');
    }
}

// ── 跳转时"只滚我们自己的滚动容器"（**绝不用 scrollIntoView**）────────────────────────
// ⚠️ 为什么：真实 ST 页的 `<html>` 带 transform（实测 `matrix(1, 0, 0, 1, 0, 0)`）→ html 成了
//   `position: fixed` 后代的 **containing block**，我们的弹窗其实**跟着文档滚动一起走**；
//   而 `scrollIntoView` 会把 target 的**所有可滚祖先**都滚一遍（含文档 html）。于是点一下目录里的
//   消息头/检索"下一个"，整页 scrollTop 被改 → 整个插件 UI（连同网页内容）一起向上偏移（用户实测；
//   夹具已用 `html{transform}` 复现：点击前 viewer.top=224 → 点击后 −125、页面滚了 349px）。
//   这里改为：由内向外只滚 target 与"我们指定的根容器"之间的那几层滚动容器，最后只滚根容器，
//   文档/页面一律不碰。block='start' → 对齐到容器顶部；否则按"最小滚动"（与旧的 nearest 语义一致）。
const OVERFLOW_SCROLLABLE = new Set(['auto', 'scroll', 'overlay']);

function isScrollableY(el) {
    if (!el || !el.scrollHeight || !el.clientHeight) return false;
    if (el.scrollHeight <= el.clientHeight + 1) return false;
    if (typeof getComputedStyle !== 'function') return true;   // 测试桩环境（无 getComputedStyle）
    const oy = getComputedStyle(el).overflowY;
    return !oy || OVERFLOW_SCROLLABLE.has(oy);
}

// 单层：把 target 带进 container 的视野
function scrollLayerTo(container, target, block = 'nearest') {
    const c = container.getBoundingClientRect();
    const t = target.getBoundingClientRect();
    const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const cur = container.scrollTop;
    let next = cur;
    if (block === 'start' || t.top < c.top) next = cur + (t.top - c.top);
    else if (t.bottom > c.bottom) next = cur + (t.bottom - c.bottom);
    const clamped = Math.min(maxTop, Math.max(0, Math.round(next)));
    if (clamped !== cur) container.scrollTop = clamped;
}

// 把 target 带进 root 的视野：内层滚动容器先"最小滚动"，最外层 root 按 block 语义滚动。
// **root 之上的容器（含文档）一个都不碰**。
function scrollIntoViewWithin(root, target, block = 'nearest') {
    if (!root || !target) return;
    const inner = [];
    for (let el = target.parentElement; el && el !== root; el = el.parentElement) {
        if (isScrollableY(el)) inner.push(el);
    }
    for (const el of inner) scrollLayerTo(el, target, 'nearest');
    scrollLayerTo(root, target, block);
}

// 目录检索的"命中游标"：给当前命中加类 + 把它滚进目录的视野（只滚目录自己的容器）。
// 命中编号（data-hit）由 renderContextOutlineList 渲染时就编好了，顺序 = DOM 顺序 = 阅读顺序。
function applyOutlineHitCursor({ jump = false } = {}) {
    const listEl = document.getElementById('hco-body');
    if (!listEl) return;
    if (ctxHitCursor >= ctxHitCount) ctxHitCursor = ctxHitCount ? ctxHitCount - 1 : -1;
    if (ctxHitCursor < 0 && ctxHitCount) ctxHitCursor = 0;
    listEl.querySelectorAll('mark.hc-hit-current').forEach(el => el.classList.remove('hc-hit-current'));
    listEl.querySelectorAll('.hco-hit-current').forEach(el => el.classList.remove('hco-hit-current'));
    const all = listEl.querySelectorAll('mark[data-hit]');
    const target = (ctxHitCursor >= 0 && ctxHitCursor < all.length) ? all[ctxHitCursor] : null;
    if (target) {
        target.classList.add('hc-hit-current');
        const rowEl = target.closest ? target.closest('.hco-row') : null;
        if (rowEl) rowEl.classList.add('hco-hit-current');
        if (jump) scrollIntoViewWithin(listEl, target, 'nearest');
    }
    updateCtxCounts();
}

// 上/下一个命中（环形）：无命中则不动；尚未跳转过时按方向取首个/末个
function jumpContextOutlineHit(delta) {
    if (!ctxHitCount) return;
    ctxHitCursor = (ctxHitCursor < 0)
        ? (delta > 0 ? 0 : ctxHitCount - 1)
        : ((ctxHitCursor + delta + ctxHitCount) % ctxHitCount);
    applyOutlineHitCursor({ jump: true });
}

// 计数文案：目录检索"第 n / 共 m 个命中" + "显示 x / y 条消息"
function updateCtxCounts() {
    const setText = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    };
    const fmt = (cursor, total) => (total ? `${cursor < 0 ? 1 : cursor + 1}/${total}` : '无命中');
    setText('hco-search-count', ctxSearchTerm.trim() ? fmt(ctxHitCursor, ctxHitCount) : '');
    const all = ctxDump?.messages?.length || 0;
    setText('hco-count', (all && ctxVisibleCount !== all) ? `显示 ${ctxVisibleCount} / ${all} 条` : '');
}

// 载入一份快照（第二十九轮：原 `openContextViewer` 的状态部分；开窗由 openContextOutlinePopup 负责）。
// model 用来找当前锚点对应的 dump（含模拟锚定）；不传 = 沿用当前 ctxModel。
function loadContextSnapshot(model) {
    const chatId = getContext?.()?.chatId;
    const anchorId = model?.isSim ? SIM_ANCHOR_ID : model?.index;
    const dump = (chatId && anchorId !== undefined && anchorId !== null)
        ? contextDumpStore.get(contextDumpKey(chatId, anchorId))
        : null;

    contextViewerKey = (dump ? contextDumpKey(chatId, anchorId) : null);
    // 换快照 = 换内容：条目来源 / 整轮层级都收起（随后由 openContextOutlinePopup 重新起一层）
    closeWiMsgPopup();
    closeChildStack();
    ctxModel = model || null;
    ctxDump = dump || null;
    ctxMsgByIndex = new Map((ctxDump?.messages || []).map(m => [m.i, m]));
    // 视图状态复位（检索 / 筛选 / 折叠都不跨快照沿用）
    ctxSearchTerm = '';
    ctxSourceFilter = 'all';
    ctxRoleFilter = 'all';
    ctxVisibleCount = 0;
    ctxHitCount = 0;
    ctxHitCursor = -1;
    ctxOutlineActiveIndex = null;
    const sInput = document.getElementById('hco-search-input');
    if (sInput) sInput.value = '';
    syncCtxFilterButtons();
    updateCtxCounts();
}
// ==================== 聊天统计 · 世界书消息条目来源子窗（第二十一轮新增；第二十四轮：父窗原位 + 子窗另一侧） ====================
// 入口（第三十五轮起）：**「上下文目录」里世界书消息项头行尾的 `.hco-wi-src` 图标**。
//   历史上的入口是查看器里 `hc-msg-tokens` 的展开图标（放大镜左侧）—— 查看器第二十九轮删除、
//   `hc-msg-tokens` 第三十五轮删除，那条路径已不存在。
// 内容（自上而下）：① 该消息的 hc-msg-head 数据 ② 该消息的世界书构成饼图（同主面板 #tub-row-wi-chart 口径）
//   ③ 该消息的条目列表（同主面板 tub-entries-header-sticky 那一段：检索 + 类型过滤 + 总数，
//      **去掉排序按钮**，排序固定为「上下文顺序」——这些条目本来就在同一条消息里）
// 层级（第二十四轮）：本子窗是**消息行里那个图标**的直接子窗 —— 打开时开在父窗的另一侧；
//   它的父窗（= 打开它时可见的那个窗口，通常是「上下文目录」）**原地不动**（见 §3.7）。
let wiMsgPopupIndex = null;      // 当前展示的消息序号（null = 未开）
let wiMsgPopupMsg = null;        // 当前展示的消息记录
let wiMsgRowRecords = new Map(); // 行号 → 条目记录（点击开条目详情子窗）
let wiMsgBookFilter = 'all';
let wiMsgEntryFilter = 'all';
let wiMsgSearchTerm = '';

// 子窗最小高度：主窗很矮时（例如刚打开、统计页还没渲染完）也要保证"head + 饼图 + 条目列表"都看得见——
// 条目列表是 flex 里最后一段，主窗太矮会被压成 0 高度、条目完全看不见（真实 Chromium 夹具实测）。
const WI_MSG_POPUP_MIN_HEIGHT = 420;

function ensureWiMsgPopup() {
    let el = document.getElementById('hide-helper-wi-msg-popup');
    if (el) return el;
    $('body').append(`
        <div id="hide-helper-wi-msg-popup" class="hide-helper-popup hide-helper-wi-msg-popup" style="display: none;">
            <button id="hide-helper-wi-msg-close" class="hide-helper-popup-close-icon" title="关闭">&times;</button>
            <div id="hwmp-head" class="hc-msg-head hwmp-head"></div>
            <div id="hwmp-pie" class="tub-row-2 hwmp-pie"></div>
            <div class="hwmp-entries-section">
                <div class="tub-entries-header-sticky hwmp-entries-header">
                    <div class="tub-flex-row-between">
                        <div class="tub-flex-row-center">
                            <div class="tub-section-title tub-title-text tub-section-title-no-margin" id="hwmp-entries-title">本条世界书条目</div>
                            <div class="tub-search-wrapper">
                                <svg class="tub-search-icon" id="hwmp-search-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                                </svg>
                                <input type="text" id="hwmp-search-input" class="tub-search-input" placeholder="搜索条目...">
                            </div>
                        </div>
                        <div id="hwmp-entries-total-display" class="tub-entries-total-display"></div>
                    </div>
                    <div class="tub-book-filters-row">
                        <div class="tub-book-filters" id="hwmp-book-filters"></div>
                        <div class="tub-entries-tools">
                            <button type="button" class="tub-type-filter" id="hwmp-type-filter" title="按类型过滤">
                                <span class="tub-type-filter-text">所有</span>
                            </button>
                        </div>
                    </div>
                </div>
                <div class="tub-row-3 tub-scrollable hwmp-list" id="hwmp-row-entries"></div>
            </div>
        </div>
    `);
    el = document.getElementById('hide-helper-wi-msg-popup');
    $('#hide-helper-wi-msg-close').on('click', () => closeWiMsgPopup());
    // 条目列表的滚动条：与其余子窗同款（默认隐藏 + 滚动/悬停/拖拽三档显色）
    initHiddenScrollbar(el.querySelector('#hwmp-row-entries'));
    // 条目检索（与主面板同一交互：点放大镜展开输入框；输入防抖 300ms）
    const searchInput = el.querySelector('#hwmp-search-input');
    el.querySelector('#hwmp-search-icon')?.addEventListener('click', () => {
        if (!searchInput) return;
        searchInput.classList.toggle('active');
        if (searchInput.classList.contains('active')) {
            searchInput.focus();
        } else {
            searchInput.value = '';
            wiMsgSearchTerm = '';
            refreshWiMsgList();
        }
    });
    searchInput?.addEventListener('input', debounce(() => {
        wiMsgSearchTerm = searchInput.value;
        refreshWiMsgList();
    }, 300));
    // 类型过滤：菜单挂在**本子窗**上（openTypeFilterMenu 的 host 参数），不是主弹窗
    el.querySelector('#hwmp-type-filter')?.addEventListener('click', (ev) => {
        const trigger = ev.currentTarget;
        toggleTypeFilterMenu(trigger, {
            host: el,
            available: new Set((wiMsgPopupMsg?.wiEntries || []).map(e => e.type)),
            current: wiMsgEntryFilter,
            onPick: (value) => {
                wiMsgEntryFilter = value;
                updateTypeFilterTriggerLabel('hwmp-type-filter', value);
                refreshWiMsgList();
            },
        });
    });
    const theme = extension_settings[extensionName]?.theme || 'light';
    if (theme === 'dark') el.setAttribute('data-theme', 'dark');
    return el;
}

function closeWiMsgPopup() {
    wiMsgPopupIndex = null;
    wiMsgPopupMsg = null;
    // closeChildPopupAt 内部会按"退回目录 + 成对窗口挂起"的判定自动放回右侧完整上下文（见该函数末尾）
    closeChildPopupAt('hide-helper-wi-msg-popup');   // × ：只退一层（父窗 = 目录 留下）
}

// 打开某条消息的「条目来源」子窗（i = 该消息在快照里的序号）
function openWiMsgPopup(i) {
    const m = ctxMsgByIndex.get(Number(i));
    if (!m) return;
    const el = ensureWiMsgPopup();
    // 第二十九轮：入口改到「上下文目录」的世界书消息行 → 本窗开在目录的另一侧；
    // 同时右侧「完整上下文」暂时收起（成对模式挂起），关掉本窗后自动恢复成对窗口。
    focusChildPopup('hide-helper-wi-msg-popup');
    suspendOutlineMergeForChild();
    // 每次打开都按这条消息复位：过滤 / 检索不跨消息沿用
    wiMsgPopupIndex = m.i;
    wiMsgPopupMsg = m;
    wiMsgBookFilter = 'all';
    wiMsgEntryFilter = 'all';
    wiMsgSearchTerm = '';
    const sInput = document.getElementById('hwmp-search-input');
    if (sInput) {
        sInput.value = '';
        sInput.classList.remove('active');
    }
    updateTypeFilterTriggerLabel('hwmp-type-filter', 'all');

    // ① 该消息的 hc-msg-head 数据（与查看器里那条消息同款字段）
    // 第三十五轮用户口径⑪：
    //   · 去掉角色 chip（`hc-msg-role`）—— 同一条消息的角色在「上下文目录」里本来就不显示，
    //     这个窗里也没必要重复一遍；
    //   · `hc-msg-kind` 的文案与「上下文目录」里条目的 `hco-src` **完全一致**（世界书来源一律显示
    //     「世界书」、其余 `来源 · identifier`），全称留在 title 里（与 `srcTitleAttr` 同一套）；
    //   · 去掉行尾的 tokens（`hc-msg-tokens`）—— 饼图与条目列表已经把 token 讲清楚了。
    const headEl = document.getElementById('hwmp-head');
    if (headEl) {
        headEl.innerHTML = `
            <span class="hc-msg-idx">#${m.i}</span>
            <span class="hc-msg-kind"${ctxSourceTitleAttr(m)}>${escapeHtmlText(ctxSourceTextOf(m))}</span>`;
    }

    // ② 该消息的世界书构成饼图（常量 / 动态 / EJS，口径与主面板一致）
    const entries = Array.isArray(m.wiEntries) ? m.wiEntries : [];
    const sumByType = (t) => entries.filter(e => e.type === t).reduce((s, e) => s + (Number(e.tokens) || 0), 0);
    const cPie = sumByType('constant'), dPie = sumByType('dynamic'), ePie = sumByType('ejs');
    renderPieViewInto(document.getElementById('hwmp-pie'), cPie, dPie, ePie, cPie + dPie + ePie);

    refreshWiMsgList();
    el.style.display = 'flex';
    positionChildPopup(el);   // 位置由 layoutChildPair 决定（父窗原位 + 本窗在另一侧）；最小高度由 childPopupTable 提供
}

// ③ 条目列表（检索 / 过滤会反复重绘这一段）：行样式用与主面板同一个构建器，排序**固定**上下文顺序。
//    用户口径（第二十轮）：条目名后**一律**括号显示来源世界书；列表**不显示 `tub-ctx-msg` 位置标记行**
//    （这些条目本来就在同一条消息里）；世界书筛选按钮**始终提供**（不再要求"多于一本才出现"）。
function refreshWiMsgList() {
    const listEl = document.getElementById('hwmp-row-entries');
    if (!listEl || !wiMsgPopupMsg) return;
    const entries = Array.isArray(wiMsgPopupMsg.wiEntries) ? wiMsgPopupMsg.wiEntries : [];
    const titleEl = document.getElementById('hwmp-entries-title');
    const totalEl = document.getElementById('hwmp-entries-total-display');
    const booksEl = document.getElementById('hwmp-book-filters');
    const books = [...new Set(entries.map(e => e.book))];

    // 世界书筛选（用户口径：本子窗始终提供 tub-book-filters，便于切换不同世界书来源的条目）
    if (booksEl) {
        booksEl.innerHTML = books.length
            ? `<button class="tub-book-btn${wiMsgBookFilter === 'all' ? ' active' : ''}" data-book="all">所有条目</button>`
                + books.map(b => `<button class="tub-book-btn${wiMsgBookFilter === b ? ' active' : ''}" data-book="${escapeHtmlText(b)}">${escapeHtmlText(b)}</button>`).join('')
            : '';
        booksEl.querySelectorAll('.tub-book-btn').forEach(btn => {
            btn.onclick = () => {
                wiMsgBookFilter = btn.getAttribute('data-book');
                refreshWiMsgList();
            };
        });
    }
    const inBook = entries.filter(e => wiMsgBookFilter === 'all' || e.book === wiMsgBookFilter);

    // 类型过滤自检：选中的类型在当前书范围内不存在 → 回退「所有」（与主面板同一规则）
    const avail = new Set(inBook.map(e => e.type));
    if (wiMsgEntryFilter !== 'all' && !avail.has(wiMsgEntryFilter)) wiMsgEntryFilter = 'all';
    updateTypeFilterTriggerLabel('hwmp-type-filter', wiMsgEntryFilter);

    const term = wiMsgSearchTerm.trim().toLowerCase();
    const rows = inBook.filter(e => (wiMsgEntryFilter === 'all' || e.type === wiMsgEntryFilter)
        && (!term || String(e.name).toLowerCase().includes(term)));

    if (titleEl) titleEl.textContent = '本条世界书条目';

    // 总数显示（与主面板同一格式：总数 + 括号内按类型着色相加）
    let tE = 0, tD = 0, tC = 0;
    rows.forEach(e => {
        if (e.type === 'ejs') tE += e.tokens;
        else if (e.type === 'dynamic') tD += e.tokens;
        else tC += e.tokens;
    });
    if (totalEl) {
        let html = `${tE + tD + tC}`;
        if (tE > 0 || tD > 0 || tC > 0) {
            const parts = [];
            if (tE > 0) parts.push(`<span class="tub-stat-color-ejs">${tE}</span>`);
            if (tD > 0) parts.push(`<span class="tub-stat-color-dynamic">${tD}</span>`);
            if (tC > 0) parts.push(`<span class="tub-stat-color-constant">${tC}</span>`);
            html += ' (' + parts.join(' + ') + ')';
        }
        totalEl.innerHTML = html;
    }

    if (!entries.length) {
        listEl.innerHTML = `<div class="tub-empty-state">这条消息没有可归属的世界书条目。<br>
            文本匹配不到时（条目正文被 Regex 改写 / EJS 未渲染）仍会计入「世界书」——判定走来源槽位，不走文本。</div>`;
        wiMsgRowRecords = new Map();
        return;
    }
    if (!rows.length) {
        listEl.innerHTML = '<div class="tub-empty-state">当前过滤条件下没有条目</div>';
        wiMsgRowRecords = new Map();
        return;
    }

    // 条目行：记录 → 可点击行（点击开条目详情子窗，与主面板一致）
    const records = rows.map(e => ({
        name: e.name, b: e.book, type: e.type, uid: e.uid, tokens: e.tokens,
        matched: true, anchor: e.anchor || null, pos: e.pos ?? null,
        position: e.position ?? null, depth: e.depth ?? null, role: e.role ?? null, order: e.order ?? null,
    }));
    const edges = contextSendableEdges(ctxModel || {});
    // 排序固定「上下文顺序」（同主面板的显示层顺序键：不用锚点里存下的旧 key）
    sortEntriesByMode(records, 'context', edges);
    const absoluteMax = records.length ? Math.max(...records.map(r => r.tokens)) : 1;
    const rowBuilder = createEntryRowBuilder({
        booksCount: books.length, bookFilter: wiMsgBookFilter, absoluteMax, alwaysShowBook: true,
        insertMeta: true, // 第二十七轮 R5：每行第二行显示「插入位置 · 顺序」
        // 第三十二轮（用户口径）：本子窗里条目**全属于同一条消息**，插入位置每行都一样 → 不显示；
        //   只留右侧的顺序 chip。
        insertPos: false,
    });
    listEl.innerHTML = renderContextOrderHtml(records, edges, rowBuilder.html, { markers: false });
    wiMsgRowRecords = rowBuilder.records;

    listEl.querySelectorAll('.tub-entry-clickable').forEach(row => {
        const entry = () => ({
            book: row.getAttribute('data-book'),
            name: row.getAttribute('data-name'),
            uid: row.getAttribute('data-uid'),
        });
        row.onclick = () => {
            const rec = wiMsgRowRecords.get(Number(row.getAttribute('data-rid'))) || null;
            openEntryDetailPopup({ ...entry(), type: row.getAttribute('data-type'), tokens: rec ? rec.tokens : null });
        };
        // 第三十五轮用户口径⑪：行尾的「跳到正文」图标（`.tub-entry-jump`）已删除 —— 这里不再绑事件。
    });
}

// 从「条目来源」子窗跳到内容区里该条目的正文首行（第二十七轮 R2 建议⑥）。
// ⚠️ 第三十五轮：入口（`.tub-entry-jump` 图标）已按用户口径⑪删除，当前**没有 UI 调用点**；
//    函数与其依赖链（closeWiMsgPopup → resumeOutlineMergeAfterChild → jumpContextOutlineToEntry）
//    保留，供控制台 / 夹具与后续新入口复用（删掉会连带破坏那条"挂起中先关子窗"的既有逻辑说明）。
// 成对窗口没开就先开出来；**挂起中**（正在看条目来源）先关掉它、回到成对窗口，再滚到该条目正文。
// ⚠️ 不能"边开着条目来源边把内容窗放回来"：那样屏幕上会同时有目录 / 条目来源 / 内容三个窗，
//    而 layoutChildPair 的成对分支会把当前窗（条目来源）收起 → 三窗全灭（实测踩过）。
async function jumpToMergedFromWiMsg(i, entry) {
    if (i === null || i === undefined) return;
    if (ctxMergeSuspended) closeWiMsgPopup();      // 关掉子窗 → closeChildPopupAt 会 resume 成对窗口
    if (!ctxMergeMode) openContextOutlinePopup();
    await jumpContextOutlineToEntry(i, entry || {});
}

// ==================== 聊天统计 · 上下文目录（目录页）+ 完整上下文（内容区） ====================
// 第二十七轮（用户口径：「目录 = 目录页、右侧 = 内容区」）。
// 第二十九轮（用户口径①：「直接去除点击『总共』出现的 hide-helper-context-viewer 弹窗，直接显示
//   上下文目录和右侧完整上下文弹窗」+ 追问后明确「要去掉的是第一层那个内容重复的『完整上下文』查看器」）：
//   ① **查看器窗口整体删除** —— 点「总共」直接开出这一对窗口：
//      `#hide-helper-ctx-outline-popup`（目录，左）+ `#hide-helper-ctx-merged-popup`（完整上下文，右）；
//   ② 查看器工具栏的**筛选（来源 / 角色）与检索**整套平移到目录窗头部（口径②），目录窗不再有副标题行；
//   ③ 「条目来源」子窗改由**目录里世界书消息行的图标**打开（查看器删了，原来的入口随之消失）；
//      打开它时成对窗口**暂停**（右侧内容窗暂时收起），关掉它再恢复成对窗口。
// ⚠️ 跳转一律走 `scrollIntoViewWithin` / `scrollLayerTo`（只滚我们自己的容器）——
//     用 `scrollIntoView` 会连带滚文档 → 整个插件 UI 跟着整页上移（第二十轮 R1 用户实测）。
const CTX_OUTLINE_MIN_HEIGHT = 420;
let ctxOutlineActiveIndex = null;     // 目录里"最近跳到过"的消息序号（左侧描边；重绘后沿用）
let ctxMergeMode = false;             // 「目录 + 完整上下文」成对模式开着
let ctxMergeViewerSlot = null;        // 这一对的落点（内容窗的槽位；目录贴在它左侧）
let ctxMergeSuspended = false;        // 成对模式暂时让位（从目录里打开「条目来源」时）——关掉子窗后恢复
let ctxSearchRowOpen = false;         // 检索行是否展开（默认收起，点放大镜切换）
// 第二十八轮：项头/分组头的**折叠状态**（点 `hco-head hco-row` 折叠/展开下方列表）。
// 键 = 该项头行的 `data-i`（分组取组首那条）；只在"打开目录"时清零（避免换快照后折叠错项）。
const ctxOutlineCollapsed = new Set();
// 第二十八轮：世界书**条目行**的滚动联动（用户口径"世界书列表的项也要激活"）。
//   · `ctxEntryLayouts`：消息序号 → [{ uid, top }]，top = 该条目正文起点在内容区里的纵坐标（内容坐标系）；
//   · 缓存按 `ctxMergedRenderToken`（内容区渲染代次）失效 —— 内容重画过，量到的坐标全作废；
//   · `ctxOutlineActiveEntry`：当前高亮的条目（`消息序号|uid`），**只有变了才动 DOM**（否则每帧都写会抖）。
let ctxEntryLayoutToken = -1;
const ctxEntryLayouts = new Map();
let ctxOutlineActiveEntry = '';

// 在"发送文本"里定位条目正文的起点（字符偏移；-1 = 没找到）。
// 三级放宽：整段（去掉首尾空白）→ 第一行非空行 → 前 60 个字符 —— 容忍 Regex 改写 / EJS 未渲染造成的差异。
function findEntryOffsetInText(text, content) {
    const hay = String(text ?? '').toLowerCase();
    const raw = String(content ?? '');
    if (!hay || !raw.trim()) return -1;
    const cands = [
        raw.trim(),
        (raw.split(/\r?\n/).find(l => l.trim()) || '').trim(),
        raw.trim().slice(0, 60),
    ];
    for (const cand of cands) {
        if (!cand) continue;
        const at = hay.indexOf(cand.toLowerCase());
        if (at >= 0) return at;
    }
    return -1;
}

function ensureContextOutlinePopup() {
    let el = document.getElementById(CTX_OUTLINE_ID);
    if (el) return el;
    $('body').append(`
        <div id="hide-helper-ctx-outline-popup" class="hide-helper-popup hide-helper-ctx-outline-popup" style="display: none;">
            <button id="hide-helper-ctx-outline-close" class="hide-helper-popup-close-icon" title="关闭">&times;</button>
            <!-- 第三十五轮用户口径⑨：移动端（两窗并排放不下）时，目录左上角多一个「折叠栏」图标，
                 点它把目录收起、回到「完整上下文」；此时本窗右上角的关闭按钮隐藏（关闭交给完整上下文窗）。 -->
            <button type="button" id="hide-helper-ctx-outline-toggle" class="hh-pair-toggle" title="收起上下文目录">${HC_ICON_SIDEBAR}</button>
            <!-- 第二十九轮口径①②：查看器删除后，它的**筛选（来源 / 角色）+ 检索**整套平移到本窗头部；
                 原来的副标题行（.hide-entry-sub / #hco-sub）按用户口径去掉，索引信息挪进标题行的 title。 -->
            <div class="hide-entry-head">
                <div class="hide-entry-name" id="hco-title">上下文目录</div>
                <div class="hc-toolbar" id="hco-toolbar">
                    <div class="hc-filters">
                        <button type="button" class="hc-menu-btn" id="hco-filter-source" title="按来源过滤（只影响下方目录列表）">
                            <span class="hc-menu-btn-label">来源</span><span class="hc-menu-btn-value" id="hco-filter-source-text">全部</span>
                        </button>
                        <button type="button" class="hc-menu-btn" id="hco-filter-role" title="按角色过滤（只影响下方目录列表）">
                            <span class="hc-menu-btn-label">角色</span><span class="hc-menu-btn-value" id="hco-filter-role-text">全部</span>
                        </button>
                        <div class="hc-count" id="hco-count"></div>
                        <button type="button" class="hc-icon-btn hc-search-toggle" id="hco-search-toggle" title="显示/隐藏检索框">${HC_ICON_SEARCH}</button>
                    </div>
                    <div class="hc-search hc-search-row" id="hco-search-row" style="display: none;">
                        <input type="text" id="hco-search-input" class="hc-search-input" placeholder="检索目录（消息正文 / 条目名 / 来源）…">
                        <span class="hc-search-count" id="hco-search-count"></span>
                        <button type="button" class="hc-icon-btn" id="hco-hit-prev" title="上一个命中（Shift+Enter）">${HC_ICON_UP}</button>
                        <button type="button" class="hc-icon-btn" id="hco-hit-next" title="下一个命中（Enter）">${HC_ICON_DOWN}</button>
                        <button type="button" class="hc-icon-btn" id="hco-search-clear" title="清空检索">${HC_ICON_ERASER}</button>
                    </div>
                </div>
            </div>
            <div class="hide-entry-body hco-list" id="hco-body"></div>
        </div>
    `);
    el = document.getElementById(CTX_OUTLINE_ID);
    $('#hide-helper-ctx-outline-close').on('click', () => closeContextOutlinePopup());
    // 第三十五轮用户口径⑨：左上角「折叠栏」图标（仅移动端可见，见 CSS 的 .hh-pair-toggle）→ 收起目录、回到完整上下文
    el.querySelector('#hide-helper-ctx-outline-toggle')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        collapseContextOutlineOnMobile();
    });
    // 滚动条与其余子窗同款（默认隐藏 + 滚动/悬停/拖拽三档显色，见 initHiddenScrollbar 与 CSS 的 .hh-sb-*）
    initHiddenScrollbar(el.querySelector('#hco-body'));
    bindContextOutlineToolbar(el);
    // 键盘导航（↑/↓、J/K、Home/End）：文档级只绑一次（第二十九轮：原来绑在已删除的查看器上，现随工具栏一起搬到本窗）
    if (!ctxHotkeysBound && typeof document.addEventListener === 'function') {
        ctxHotkeysBound = true;
        document.addEventListener('keydown', handleContextHotkeys);
    }
    const theme = extension_settings[extensionName]?.theme || 'light';
    if (theme === 'dark') el.setAttribute('data-theme', 'dark');
    return el;
}

// 目录窗头部的工具栏（第二十九轮：整套从查看器平移过来）。
// 口径：**筛选与检索只作用于左侧目录列表**（右侧完整上下文恒显示全部内容——它是"实际发送的字符"，不该被裁剪）。
function bindContextOutlineToolbar(el) {
    const searchRow = el.querySelector('#hco-search-row');
    const searchToggle = el.querySelector('#hco-search-toggle');
    const searchInput = el.querySelector('#hco-search-input');
    const applySearchRowState = (open) => {
        // 第二十九轮 R1（口径①）：默认收起；点放大镜展开、再点收起。
        // 用 class 驱动（CSS 侧 `.hc-search` 默认 `display:none`，`.hco-search-open` 才 `flex`）——
        // 只写内联 `display` 会被样式表里的 `!important` 压掉（实测：检索行一直展开）。
        if (searchRow) {
            searchRow.style.display = open ? 'flex' : 'none';
            searchRow.classList.toggle('hco-search-open', !!open);
        }
        searchToggle?.classList.toggle('active', open);
        if (open) searchInput?.focus();
        else if (ctxSearchTerm.trim()) {
            if (searchInput) searchInput.value = '';
            ctxSearchTerm = '';
            ctxHitCursor = -1;
            renderContextOutlineList();
        }
    };
    applySearchRowState(ctxSearchRowOpen);
    searchToggle?.addEventListener('click', () => {
        ctxSearchRowOpen = !ctxSearchRowOpen;
        applySearchRowState(ctxSearchRowOpen);
    });
    searchInput?.addEventListener('input', () => {
        ctxSearchTerm = searchInput.value;
        ctxHitCursor = -1;
        renderContextOutlineList();     // 整段重绘：目录行同时就是命中高亮的载体
    });
    searchInput?.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
            ev.preventDefault();
            jumpContextOutlineHit(ev.shiftKey ? -1 : 1);
        } else if (ev.key === 'Escape') {
            ev.preventDefault();
            ev.stopPropagation();       // 别让 Esc 冒到文档上把整个窗口关掉（这是"退出输入"）
            searchInput.value = '';
            ctxSearchTerm = '';
            ctxHitCursor = -1;
            renderContextOutlineList();
        }
    });
    el.querySelector('#hco-hit-prev')?.addEventListener('click', () => jumpContextOutlineHit(-1));
    el.querySelector('#hco-hit-next')?.addEventListener('click', () => jumpContextOutlineHit(1));
    el.querySelector('#hco-search-clear')?.addEventListener('click', () => {
        if (searchInput) { searchInput.value = ''; searchInput.focus(); }
        ctxSearchTerm = '';
        ctxHitCursor = -1;
        renderContextOutlineList();
    });
    el.querySelector('#hco-filter-source')?.addEventListener('click', (ev) => {
        toggleCtxFilterMenu(ev.currentTarget, {
            options: CTX_SOURCE_OPTIONS, current: ctxSourceFilter,
            onPick: (value) => {
                ctxSourceFilter = value; ctxHitCursor = -1;
                syncCtxFilterButtons();
                // 第三十二轮（用户口径）：筛选同时作用于**右侧完整上下文**（内容 / 图例 / 头部计数一起变）
                renderContextOutlineList();
                renderMergedContext();
            },
        });
    });
    el.querySelector('#hco-filter-role')?.addEventListener('click', (ev) => {
        toggleCtxFilterMenu(ev.currentTarget, {
            options: CTX_ROLE_OPTIONS, current: ctxRoleFilter,
            onPick: (value) => {
                ctxRoleFilter = value; ctxHitCursor = -1;
                syncCtxFilterButtons();
                renderContextOutlineList();
                renderMergedContext();   // 同上：右侧内容区跟着筛选结果走
            },
        });
    });
    syncCtxFilterButtons();
}

// 「完整上下文」窗（内容区）：只展示内容，工具栏/导航全在左侧目录里。
// 第二十九轮口径③：头部改成**一行** —— 标题在左、`.hide-entry-sub` 贴标题行**最右侧**（右对齐），
//   图例（`.hcm-legend`）也从副标题行里提上来、同样右对齐（见 renderMergedContext）。
// R1（口径②）：快照信息（`.hide-entry-book`）从副标题里**拆出来**，作为标题行的第二个孩子 ——
//   它现在与「完整上下文」四个字**同一行**（窄窗只省略它自己，不会把整块挤到第二行）。
function ensureContextMergedPopup() {
    let el = document.getElementById(CTX_MERGED_ID);
    if (el) return el;
    $('body').append(`
        <div id="hide-helper-ctx-merged-popup" class="hide-helper-popup hide-helper-ctx-merged-popup" style="display: none;">
            <!-- 第二十七轮 R2 用户口径：桌面端**去掉右上角的关闭按钮**（一对窗口靠"目录的 × / Esc / 再点图标"收起）。
                 第三十五轮用户口径⑨：移动端时这一对窗口改成"一次只显示一个"——此时
                 ① 本窗右上角**显示**关闭按钮；② 左上角显示折叠栏图标，点它把目录展开出来。 -->
            <button type="button" id="hide-helper-ctx-merged-toggle" class="hh-pair-toggle" title="展开上下文目录">${HC_ICON_SIDEBAR}</button>
            <button type="button" id="hide-helper-ctx-merged-close" class="hide-helper-popup-close-icon" title="关闭">&times;</button>
            <div class="hide-entry-head hcm-head">
                <div class="hide-entry-name" id="hcm-title">完整上下文</div>
                <div class="hide-entry-book" id="hcm-book"></div>
                <div class="hide-entry-sub" id="hcm-sub"></div>
            </div>
            <div class="hide-entry-body hcm-body" id="hcm-body"></div>
        </div>
    `);
    el = document.getElementById(CTX_MERGED_ID);
    // 桌面端本窗不设关闭按钮（用户口径），由 CSS 隐藏；移动端才显示（见 .hh-pair-toggle / .hh-pair-close 规则）
    el.querySelector('#hide-helper-ctx-merged-close')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeContextMergedPopup();
    });
    // 移动端：左上角折叠栏图标 → 把目录展开出来（本窗让位）
    el.querySelector('#hide-helper-ctx-merged-toggle')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        expandContextOutlineOnMobile();
    });
    initHiddenScrollbar(el.querySelector('#hcm-body'));
    // 内容区滚动 → 左侧目录跟着滚动/高亮（"目录 = 目录页"的双向联动；见 syncOutlineFromMergedScroll）
    el.querySelector('#hcm-body')?.addEventListener('scroll', scheduleOutlineSpy, { passive: true });
    const theme = extension_settings[extensionName]?.theme || 'light';
    if (theme === 'dark') el.setAttribute('data-theme', 'dark');
    return el;
}

// 进入成对模式：这一对是**顶层的入口窗**（第二十九轮起没有"第一层查看器"了，槽位取主弹窗的槽位）
function enterContextOutlineMergeMode() {
    focusChildPopup(CTX_OUTLINE_ID);
    ctxMergeViewerSlot = captureMainSlot();
    ctxMergeMode = true;
    ctxMergeSuspended = false;
    // 每次打开都从"全展开"开始（折叠状态是临时 UI 偏好，不跨快照沿用；条目坐标缓存一并作废）
    ctxOutlineCollapsed.clear();
    ctxEntryLayouts.clear();
    ctxEntryLayoutToken = -1;
    ctxOutlineActiveEntry = '';
}

// 退出成对模式：状态清掉 + 内容窗收起
function exitContextOutlineMergeMode() {
    if (!ctxMergeMode && !ctxMergeViewerSlot && !ctxMergeSuspended) return;
    closeCtxFilterMenu();   // 窗口收起 = 工具栏也收起 → 菜单不能留在屏幕上
    ctxMergeMode = false;
    ctxMergeSuspended = false;
    ctxMergeViewerSlot = null;
    const mrgEl = document.getElementById(CTX_MERGED_ID);
    if (mrgEl) mrgEl.style.display = 'none';
}

function closeContextOutlinePopup() {
    ctxOutlineActiveIndex = null;
    ctxMergeSuspended = false;
    closeChildPopupAt(CTX_OUTLINE_ID);   // × / Esc：两窗一起收起，回到主弹窗
}

function closeContextMergedPopup() {
    // 「完整上下文」与「目录」是一对：关掉它 = 两窗一起收起
    closeContextOutlinePopup();
}

// 「总共」统计框：点击开/关这一对窗口（第二十九轮：不再有第一层查看器）
// 第三十六轮用户口径②：**统一入口守卫** —— 当前 messageID 没存完整上下文时，统计框（`tub-stat-box-clickable`）
// 与锚定栏图标都走这里，一处判断即可覆盖两个入口（原来只在图标那边判，统计框仍会开出空窗）。
// 关闭方向不拦截（已开着的窗口要能正常收起）。
function toggleContextOutlineFromStats(model) {
    const el = document.getElementById(CTX_OUTLINE_ID);
    if (el && el.style.display !== 'none') {
        closeContextOutlinePopup();
        return;
    }
    // 用 model 反查它在锚定列表里的那一项（isSim 与 index 一起比，模拟锚定的 index 才是哨兵）
    const item = model
        ? getAnchoredStatsList().find(x => x.index === model.index && !!x.isSim === !!model.isSim)
        : null;
    // model 为空（没有锚定）时也按"没有快照"处理：开出来只会是一对空窗
    if (!model || !currentAnchorHasDump(item)) {
        notify('warning', '无该历史请求的完整上下文数据存储');
        return;
    }
    openContextOutlinePopup(model);
}

// 图标点击：开着就收起
function toggleContextOutlinePopup(model) {
    toggleContextOutlineFromStats(model);
}

// 打开这一对窗口。model 用来找到当前锚点对应的快照（含模拟锚定）；
// 不传时沿用 `ctxModel`（从目录里打开「条目来源」再回来时走这条）。
function openContextOutlinePopup(model) {
    const outEl = ensureContextOutlinePopup();
    const mrgEl = ensureContextMergedPopup();
    ensureChildPopupResizeHandler();   // 视口变化时这两个窗要跟着重排（目录居中 / 内容贴右）
    if (model !== undefined && model !== null) loadContextSnapshot(model);
    enterContextOutlineMergeMode();
    renderContextOutlineList();
    renderMergedContext();
    outEl.style.display = 'flex';
    mrgEl.style.display = 'flex';
    layoutChildPair();   // 成对模式：落点由 layoutOutlineMergePair 写（目录在左、完整上下文在右）
}

// 「条目来源」子窗开着时，右侧完整上下文暂时收起（屏幕上只留「目录 | 条目来源」，不再挤第三个窗）；
// 关掉条目来源（或再点它的图标）→ 自动恢复成对窗口。
function suspendOutlineMergeForChild() {
    if (!ctxMergeMode) return;
    ctxMergeSuspended = true;
    const mrgEl = document.getElementById(CTX_MERGED_ID);
    if (mrgEl) mrgEl.style.display = 'none';
}

function resumeOutlineMergeAfterChild() {
    if (!ctxMergeMode || !ctxMergeSuspended) return;
    ctxMergeSuspended = false;
    const mrgEl = ensureContextMergedPopup();
    mrgEl.style.display = 'flex';
    layoutChildPair();
}

// 成对模式的落点（**唯一**写这两窗位置的地方）。
// 用户口径（第三十轮，原话）：「我只是让你把"目录弹窗"放到左边，"上下文"弹窗显示在右侧。
//   你给我瞎改什么间距？」⇒ **两窗并排、间距恒为 PAIR_GAP(12)**，与其它父子窗同一套规则；
//   目录在左、内容在右。**落点不再各自独立计算**（那会让间距变成 130）。
// 规则：
//   ① 整对以"目录 = 主弹窗原槽位"为基准：目录 `slot.left`、内容窗 `slot.left + w + PAIR_GAP`；
//   ② 整对放不下右边距 → **整对一起左移**（不是把某一窗单独钉到边缘），右窗贴 `vw - PAIR_MARGIN`；
//   ③ 整对左移后仍越过左边界 → 整对贴左（`PAIR_MARGIN`）；
//   ④ 只有连"两窗并排"都放不下（`2w + PAIR_GAP > vw - 2*PAIR_MARGIN`）时，才退回"居中叠放"。
//      第三十五轮用户口径⑨：**叠放（= 移动端）时不再两窗同时叠上来**，改为"一次只显示一个"：
//      默认显示「完整上下文」（内容区），点它左上角的折叠栏图标 → 换成目录；点目录左上角的同一图标 → 换回内容。
//      这套「一次一个」完全由 `ctxMobilePane` 驱动（见 `isMobilePairLayout` / `setMobilePairPane`）。
// ⚠️ 历史（别照抄）：第二十九轮 R1 曾改成"目录视口居中 + 内容窗贴右边缘"——两条各自独立算，
//     1536 宽下目录右缘 978、内容窗左 1108 ⇒ 中间空出 **130px**（用户实测点名"间距怎么隔这么远"）。
//     第二十七轮的原始落点是 `目录 558 | 合并内容 990`（间距 12），本轮即恢复到那一套。
function layoutOutlineMergePair() {
    const outEl = document.getElementById(CTX_OUTLINE_ID);
    const mrgEl = document.getElementById(CTX_MERGED_ID);
    // 目录/内容两窗都用进入模式时记下的槽位（主弹窗的尺寸与顶部）
    const slot = ctxMergeViewerSlot || captureMainSlot() || { left: PAIR_MARGIN, top: PAIR_MARGIN, width: 420, height: 480 };
    const vw = window.innerWidth, vh = window.innerHeight;
    // ⚠️ 第三十五轮（实测修复）：槽位是**进入模式那一刻**记下的，视口一变（桌面 1440 → 手机 390）就过期 ——
    //   实测 390 视口下两窗仍是 420 宽，右边缘冲到 942+420=1362，标题行的「共 1576 tokens」与右上角关闭按钮
    //   全被挤出屏幕（用户截图能直接看到）。这里统一把宽高原位钳进视口（两侧各留 PAIR_MARGIN）。
    const fit = pairFittedSlot(slot, vw, vh);
    const w = fit.width, h = fit.height;
    // 本模式里既有子窗可见 → 主弹窗一律让位（屏幕上只有目录 + 完整上下文）
    setMainHiddenForPair(true);
    const clampIn = l => Math.max(PAIR_MARGIN, Math.min(l, Math.max(PAIR_MARGIN, vw - w - PAIR_MARGIN)));
    // 一对窗的总宽（含中间那 12px）：并排放不下才叠放
    const pairWidth = 2 * w + PAIR_GAP;
    const overlay = pairWidth > (vw - 2 * PAIR_MARGIN);
    // ① 基准 = 目录落在主弹窗原槽位；② 整对放不下 → 整对左移，右窗贴右边距；③ 仍越界 → 整对贴左
    let outLeft;
    if (overlay) {
        // ④ 窄屏（移动端）：两窗**同坐标**（一次只显示一个），居中
        outLeft = clampIn(Math.round((vw - w) / 2));
    } else {
        outLeft = slot.left;
        if (outLeft + pairWidth > vw - PAIR_MARGIN) outLeft = vw - PAIR_MARGIN - pairWidth;
        if (outLeft < PAIR_MARGIN) outLeft = PAIR_MARGIN;
        outLeft = Math.round(outLeft);
    }
    // 内容窗永远紧贴目录右侧 `PAIR_GAP`（叠放时同坐标）
    const mrgLeft = overlay ? outLeft : outLeft + w + PAIR_GAP;
    // 顶部同样要钳：视口变矮时（横屏手机 / 小窗）原 top 可能让窗口底边出界
    const top = Math.max(PAIR_MARGIN, Math.min(fit.top, Math.max(PAIR_MARGIN, vh - h - PAIR_MARGIN)));
    if (mrgEl) {
        mrgEl.style.width = w + 'px';
        mrgEl.style.height = h + 'px';
        mrgEl.style.left = mrgLeft + 'px';
        mrgEl.style.top = top + 'px';
    }
    if (!outEl) return;
    const outH = Math.max(h, Math.min(minHeightOf(CTX_OUTLINE_ID) || 0, vh - 2 * PAIR_MARGIN));
    outEl.style.width = w + 'px';
    outEl.style.height = outH + 'px';
    outEl.style.left = outLeft + 'px';
    outEl.style.top = Math.max(PAIR_MARGIN, Math.min(top, Math.max(PAIR_MARGIN, vh - outH - PAIR_MARGIN))) + 'px';
    // 第三十五轮用户口径⑨：移动端「一次只显示一个」+ 只在移动端显示折叠栏/关闭按钮。
    // 桌面端（overlay=false）保持老行为：两窗并排、目录带 ×、内容窗无 ×。
    applyPairMobileChrome(!!overlay);
}

// 把"进入模式那一刻记下的槽位"钳进**当前**视口（第三十五轮修复）。
// 为什么需要：`ctxMergeViewerSlot` 是进入成对模式时抓的主弹窗槽位，之后视口再变（桌面 → 手机、
//   浏览器窗口缩小、平板横竖屏切换）它不会自动更新 —— 实测 1440 记下的 420 宽，在 390 视口里
//   让两窗右缘冲到 1362px，标题行右侧的文字与关闭按钮被挤出屏幕。
// 规则：宽/高各留两侧 `PAIR_MARGIN`；返回新的 { left, top, width, height }，left/top 一并钳进视口。
function pairFittedSlot(slot, vw, vh) {
    const maxW = Math.max(160, vw - 2 * PAIR_MARGIN);
    const maxH = Math.max(160, vh - 2 * PAIR_MARGIN);
    const width = Math.min(Number(slot?.width) || 420, maxW);
    const height = Math.min(Number(slot?.height) || 480, maxH);
    const left = Math.max(PAIR_MARGIN, Math.min(Number(slot?.left) || PAIR_MARGIN, Math.max(PAIR_MARGIN, vw - width - PAIR_MARGIN)));
    const top = Math.max(PAIR_MARGIN, Math.min(Number(slot?.top) || PAIR_MARGIN, Math.max(PAIR_MARGIN, vh - height - PAIR_MARGIN)));
    return { left, top, width, height };
}

// 当前成对窗口是否处于"移动端叠放"档（并排放不下）。
// ⚠️ 第三十五轮（实测修复）：**不要**在这里重算一次 —— `layoutOutlineMergePair` 用的槽位带兜底对象
//   （`ctxMergeViewerSlot || captureMainSlot() || {420×480}`），而这里若只写前两项，槽位为 null 时就会
//   返回 false，于是"折叠栏图标点了没反应"（复现：新开的页面上两个槽位都还是 null，body 已是
//   `hh-pair-mobile`，但点击判定说"不是移动端"）。改为直接读 layout 算出来的档位标志。
function isMobilePairLayout() {
    return !!ctxPairMobile;
}

// layout 最近一次算出的档位（true = 两窗并排放不下，走"一次只显示一个"）
let ctxPairMobile = false;

// 移动端成对窗口"当前显示哪一窗"：'merged'（完整上下文，默认）| 'outline'（上下文目录）。
// 桌面端这个值不会被使用（两窗同时可见）。
let ctxMobilePane = 'merged';

// 按平台档位打/清"移动端双窗"标记类，并同步当前显示哪一窗。
//   · 类挂在 <body> 上（`hh-pair-mobile`）：CSS 据此显示折叠栏图标 / 内容窗的 × / 隐藏目录的 ×；
//   · 类同时挂到两窗自己的 classList（`hh-mobile-pane-merged` / `hh-mobile-pane-outline`），
//     这样"显示哪一窗"可以纯 CSS 用 display 驱动，不必和 JS 里的 inline display 打架。
function applyPairMobileChrome(mobile) {
    ctxPairMobile = !!mobile;
    const body = typeof document !== 'undefined' ? document.body : null;
    body?.classList?.toggle('hh-pair-mobile', !!mobile);
    const outEl = document.getElementById(CTX_OUTLINE_ID);
    const mrgEl = document.getElementById(CTX_MERGED_ID);
    if (!mobile) {
        // 回到桌面档：两窗清掉"单窗"标记（CSS 里两个都正常显示）
        outEl?.classList?.remove('hh-mobile-pane-outline', 'hh-mobile-pane-merged');
        mrgEl?.classList?.remove('hh-mobile-pane-outline', 'hh-mobile-pane-merged');
        return;
    }
    ctxMobilePane = ctxMobilePane === 'outline' ? 'outline' : 'merged';
    const showOutline = ctxMobilePane === 'outline';
    outEl?.classList?.toggle('hh-mobile-pane-outline', showOutline);
    outEl?.classList?.toggle('hh-mobile-pane-merged', !showOutline);
    mrgEl?.classList?.toggle('hh-mobile-pane-merged', !showOutline);
    mrgEl?.classList?.toggle('hh-mobile-pane-outline', showOutline);
}

// 显式切换移动端显示的那一窗（点折叠栏图标时用）。
function setMobilePairPane(pane) {
    if (!isMobilePairLayout()) return;
    ctxMobilePane = pane === 'outline' ? 'outline' : 'merged';
    applyPairMobileChrome(true);
}

// 目录左上角折叠图标：收起目录 → 回到「完整上下文」
function collapseContextOutlineOnMobile() {
    if (!ctxMergeMode) return;
    setMobilePairPane('merged');
}

// 完整上下文左上角折叠图标：把目录展开出来（内容窗让位）
function expandContextOutlineOnMobile() {
    if (!ctxMergeMode) return;
    setMobilePairPane('outline');
}

// 快照/筛选变化后同步目录（只在成对窗口开着时做）
function refreshContextOutlineIfOpen() {
    const el = document.getElementById(CTX_OUTLINE_ID);
    if (el && el.style.display !== 'none') renderContextOutlineList();
}

// 内容区整段重绘：把每条槽位的 text **首尾相接**渲染成一整篇（无标题 / 无边框 / 无间距）——
// 展现在眼前的就是这次真正送出去的完整上下文字符；每个 `<pre data-i>` 只是目录跳转用的定位锚。
// 内容区渲染（第二十七轮 R2 三项改动）：
//   ① 每个 `.hcm-chunk` 带来源 class（`hcm-kind-<kind>`）→ 左边缘一条**来源色条** + 图例（建议①）
//   ② **分批懒渲染**（建议④）：大快照（十几万 tokens）一次性 innerHTML 会卡 —— 先渲染前若干条，
//      其余按 ~40KB / 8 条的批次用 setTimeout(0) 顺序补齐（只追加，已有块的坐标不变；
//      跳转到还没渲染的消息时先 `ensureMergedChunksUpTo(i)` 补齐再跳）
//   ③ 内容仍是"这次真正发送出去的字符"，逐条首尾相接（分块只是定位锚 + 视觉分组）
let ctxMergedRenderToken = 0;     // 每次整段重绘自增；异步批次看到旧 token 就自行退出
let ctxMergedRenderedUpTo = -1;   // 已渲染到的消息序号（跳转前用它判断要不要补渲染）
const HCM_BATCH_CHARS = 40000;    // 每批字符预算
const HCM_BATCH_CHUNKS = 8;       // 每批最少条数（单条很短时别退化成一条一批）

// 第二十七轮 R4（用户口径）：分块色条与图例统一成**三个来源分组**（聊天 / 世界书 / 其他）——
// 与目录的分组口径同一套（`ctxSourceGroupOf`），这样图例的三个色点与分块左边缘的色条一一对应。
// （R2 的 7 种细分 kind 颜色保留在 CSS 里备用，但不再用于分块上色。）
function hcmChunkHtml(m) {
    const grp = ctxSourceGroupOf(String(m?.kind || 'other'));
    const cls = grp === 'chat' ? 'hcm-kind-chat' : (grp === 'wi' ? 'hcm-kind-wi-after' : 'hcm-kind-other');
    return `<pre class="hcm-chunk ${cls}" data-i="${m.i}">${escapeHtmlText(m.text ?? '')}</pre>`;
}

// 目录里"当前可见"的消息（来源 × 角色两维筛选）。
// 第三十二轮（用户口径）：**筛选也作用于右侧「完整上下文」内容区** —— 两个窗口必须同源同口径，
//   否则"左边筛出 2 条、右边还是全部 7 条"会自相矛盾。故抽出这一个入口，目录 / 内容区 / 计数 / 键盘导航
//   全部走它，避免各写一份 `filter(...)` 而漂移。
function ctxVisibleMessages() {
    const all = ctxDump?.messages || [];
    return all.filter(m => ctxMessageVisible(m, { source: ctxSourceFilter, role: ctxRoleFilter }));
}
// 当前是否有生效的筛选（决定内容区要不要在头部提示"已筛选"）
function ctxFilterActive() {
    return ctxSourceFilter !== 'all' || ctxRoleFilter !== 'all';
}

// 内容区图例（第二十七轮 R4 用户口径：固定「聊天 / 世界书 / 其他」三项，每项给出**条数 + tokens 数**）：
//   · 条数：聊天 / 其他 = 消息条数；世界书 = **条目数**（与主面板的"条"同一口径）
//   · tokens：该组消息的 tokens 合计（**不带单位**：上一句"共 N tokens"已交代单位）
//   · title：把两个口径都写全（世界书额外给出消息条数），悬停即可看清
function hcmLegendHtml(messages) {
    const stat = {
        chat: { n: 0, tokens: 0, msgs: 0 },
        wi: { n: 0, tokens: 0, msgs: 0 },
        other: { n: 0, tokens: 0, msgs: 0 },
    };
    for (const m of (messages || [])) {
        const grp = ctxSourceGroupOf(String(m?.kind || 'other'));
        const s = stat[grp] || stat.other;
        s.tokens += Number(m?.tokens) || 0;
        s.msgs += 1;
        if (grp === 'wi') s.n += Array.isArray(m?.wiEntries) ? m.wiEntries.length : 0;
        else s.n += 1;
    }
    const items = [
        { label: '聊天', cls: 'hcm-kind-chat', s: stat.chat },
        { label: '世界书', cls: 'hcm-kind-wi-after', s: stat.wi },
        { label: '其他', cls: 'hcm-kind-other', s: stat.other },
    ];
    return items.map(({ label, cls, s }) => {
        const title = (cls === 'hcm-kind-wi-after')
            ? `${label}：${s.msgs} 条消息、${s.n} 个条目 · 共 ${s.tokens} tokens`
            : `${label}：${s.n} 条消息 · 共 ${s.tokens} tokens`;
        return `<span class="hcm-legend-item" title="${escapeHtmlText(title)}">`
            + `<i class="hcm-legend-dot ${cls}"></i>${label} ${s.n} 条 · ${s.tokens} t`
            + `</span>`;
    }).join('');
}

// 把内容区渲染到"至少包含第 i 条"（跳转前的兜底补渲染；同步，且只补不重绘）
// 第三十二轮：内容区只渲染**筛选后**的消息，故这里也用同一份列表（否则会去补渲染一个根本没渲染的块）。
function ensureMergedChunksUpTo(i) {
    const textEl = document.querySelector('#hcm-body .hcm-text');
    if (!textEl) return;
    const all = ctxVisibleMessages();
    const target = Number(i);
    if (!Number.isFinite(target) || ctxMergedRenderedUpTo >= target) return;
    const token = ctxMergedRenderToken;
    let buf = '', chunkN = 0;
    for (const m of all) {
        if (m.i <= ctxMergedRenderedUpTo) continue;
        buf += hcmChunkHtml(m);
        chunkN += 1;
        ctxMergedRenderedUpTo = m.i;
        if (ctxMergedRenderedUpTo >= target && chunkN >= 1) break;
    }
    if (buf && token === ctxMergedRenderToken) textEl.insertAdjacentHTML('beforeend', buf);
}

// 「完整上下文」头部那句快照来源的前缀（第三十五轮用户口径⑩）。
// 用户原话：「将 `hide-helper-ctx-merged-popup` 中 `hcm-book` 的『模拟发送』字符改为 `模拟 %{messageID}`。」
// ⇒ 模拟快照要让用户看到"这是第几楼的模拟"：
//   · 快照来自模拟发送（`source === 'simulate'`）→ `模拟 N`，N = 该快照对应的 messageID
//     （模拟锚定的显示编号 = 最后一条真实 messageID + 1，与锚定菜单里的 `第 N 楼` 同一套口径）；
//   · 快照来自真实发送 → 仍显示 `实际发送`（不是这次要改的对象，口径不动）。
// 拿不到编号（旧快照 / 没有真实锚点）时退回 `模拟发送`，不显示一个错的楼层号。
function ctxDumpSourceLabel(dump) {
    if (!dump) return '';
    if (dump.source !== 'simulate') return '实际发送';
    const id = simAnchorDisplayIndex(getAnchoredStatsList());
    return Number.isFinite(id) ? `模拟 ${id}` : '模拟发送';
}

function renderMergedContext() {
    const bodyEl = document.getElementById('hcm-body');
    if (!bodyEl) return;
    const subEl = document.getElementById('hcm-sub');
    const bookEl = document.getElementById('hcm-book');
    const all = ctxDump?.messages || [];
    // 第三十二轮（用户口径）：内容区与目录**同源同口径** —— 筛选生效时只显示筛选后的消息与数据
    //   （下面的分块 / 图例 / 头部计数全部基于 `shown`，不再是 `all`）。
    const shown = ctxVisibleMessages();
    const filtering = ctxFilterActive();
    ctxMergedRenderToken += 1;
    ctxMergedRenderedUpTo = -1;
    // 目录与内容区共用这一份"当前可见"映射：跳转 / 条目滚动联动都按它找消息
    ctxVisibleMsgByIndex = new Map(shown.map(m => [m.i, m]));
    // 口径②：快照信息单独占标题行的一个格子（与标题同一行）；图例仍留在副标题行的最右侧。
    // 第三十二轮：筛选生效时头部改报**筛选后**的条数与 tokens（并标出原总数），与右侧实际渲染的内容一致。
    if (bookEl) {
        const shownTokens = shown.reduce((s, m) => s + (Number(m.tokens) || 0), 0);
        const srcLabel = ctxDumpSourceLabel(ctxDump);
        bookEl.textContent = ctxDump
            ? (filtering
                ? `${srcLabel} · 筛选后 ${shown.length} / ${all.length} 条 · 共 ${shownTokens} tokens`
                : `${srcLabel} · ${all.length} 条消息 · 共 ${ctxDump.total} tokens`)
            : '';
        bookEl.title = bookEl.textContent;
    }
    if (subEl) {
        // 第二十九轮口径③：`.hide-entry-sub` 现在贴在标题行**最右侧**（右对齐），
        // 图例也从"副标题里的一串"改成"副标题里的一个右对齐块"（CSS：`.hcm-head` 是 flex + `margin-left:auto`）。
        // 第三十二轮：图例的条数 / tokens 也跟着筛选结果走（否则图例会与下面的正文互相矛盾）。
        subEl.innerHTML = ctxDump
            ? `<span class="hcm-legend">${hcmLegendHtml(shown)}</span>`
            : '';
    }
    if (!shown.length) {
        bodyEl.innerHTML = ctxDump && all.length
            ? `<div class="tub-empty-state">当前筛选条件下没有消息。</div>`
            : `<div class="tub-empty-state">没有可用的完整上下文快照。<br>
            在统计页点「模拟发送」，或用「立即生成快照（模拟发送）」生成即可（**不用重新生成消息**）。</div>`;
        return;
    }
    bodyEl.innerHTML = '<div class="hcm-text"></div>';
    bodyEl.scrollTop = 0;
    const token = ctxMergedRenderToken;
    let idx = 0;
    const flushBatch = () => {
        if (token !== ctxMergedRenderToken) return;      // 期间又重绘过（换快照 / 重开）→ 本批作废
        const textEl = document.querySelector('#hcm-body .hcm-text');
        if (!textEl) return;
        let html = '', chars = 0, n = 0;
        while (idx < shown.length && n < HCM_BATCH_CHUNKS && chars < HCM_BATCH_CHARS) {
            const m = shown[idx];
            html += hcmChunkHtml(m);
            chars += String(m.text ?? '').length;
            ctxMergedRenderedUpTo = m.i;
            idx += 1;
            n += 1;
        }
        textEl.insertAdjacentHTML('beforeend', html);
        if (idx < shown.length) setTimeout(flushBatch, 0);
    };
    flushBatch();
}
// 目录检索：一条消息是否命中（#序号 / 角色 / 来源槽位 / identifier / 正文 / 条目名+书名）。纯函数，便于单测。
function contextOutlineMatch(m, term) {
    const needle = String(term ?? '').trim().toLowerCase();
    if (!needle) return true;
    const parts = [
        String(m?.i ?? ''), `#${m?.i ?? ''}`, String(m?.role ?? ''),
        CONTEXT_KIND_LABELS[m?.kind] || '', String(m?.kind ?? ''),
        String(m?.identifier ?? ''), String(m?.text ?? ''),
    ];
    if (isWiKind(m?.kind) && Array.isArray(m?.wiEntries)) {
        for (const e of m.wiEntries) parts.push(`${e?.name ?? ''} ${e?.book ?? ''}`);
    }
    return parts.join('\n').toLowerCase().includes(needle);
}

// 目录分组（第二十七轮 R2 起分组；R4 用户口径：**「其他」不再与「聊天」归入同一块**）：
//   · 世界书来源的消息各自一项（项内带条目明细）；
//   · 非世界书消息按**来源分组**（聊天 / 其他）各自成连续的 run —— 来源一变就另起一项。
// 纯函数，返回 [{ type: 'wi'|'plain', source?: 'chat'|'other', items: [消息…] }]。
function groupOutlineMessages(messages) {
    const out = [];
    let run = null;
    let runSource = null;
    for (const m of (messages || [])) {
        if (isWiKind(m?.kind)) {
            run = null;
            runSource = null;
            out.push({ type: 'wi', items: [m] });
            continue;
        }
        // ⚠️ R4：按 `ctxSourceGroupOf` 切分 —— 「其他」（main / 出口 / AN…）不再并进「聊天」那一组
        const source = ctxSourceGroupOf(m?.kind) === 'chat' ? 'chat' : 'other';
        if (!run || runSource !== source) {
            run = { type: 'plain', source, items: [] };
            runSource = source;
            out.push(run);
        }
        run.items.push(m);
    }
    return out;
}

// 聊天消息的 **ST messageID**（第二十七轮 R4 用户口径：目录里不再显示"快照序号"，聊天条目改显示 messageID）。
// 依据：ST 把每条待发送的聊天消息**按顺序**塞成一个 `chatHistory-N` 槽位 ⇒ 快照里第 k 条 `kind === 'chat'`
// 就是 `computeSendableChat` 给出的第 k 条待发送楼层，而它的 `floor` 就是聊天数组下标 = messageID。
// ⚠️ 槽位可能被第三方插入 / 正则改写而错位：故先用**文本包含**对齐（`slotContainsChatText`，与"这条槽位
//    是不是聊天楼层"的判定同一套），对不上再退回按序兜底；连聊天都拿不到就返回空表 ——
//    **宁可不显示，也不显示一个错的 messageID**。返回 Map<快照序号, messageID>。
function outlineChatMesids(messages) {
    const map = new Map();
    let chat = null;
    try { chat = getContext?.()?.chat; } catch (e) { chat = null; }
    if (!Array.isArray(chat) || !chat.length) return map;
    const idx = ctxModel?.index;
    const end = (typeof idx === 'number' && idx >= 0 && idx < chat.length) ? idx + 1 : chat.length;
    const sendable = computeSendableChat(chat.slice(0, end), ctxModel?.genType);
    if (!sendable.length) return map;
    let cursor = 0;
    for (const m of (messages || [])) {
        if (m?.kind !== 'chat') continue;
        const text = String(m.text ?? '');
        let picked = -1;
        for (let k = cursor; k < sendable.length; k++) {
            const raw = String(chat[sendable[k].floor]?.mes ?? '');
            if (raw && text && slotContainsChatText(text, raw)) { picked = k; break; }
        }
        if (picked < 0) picked = cursor;          // 对不上（改写过多）→ 退回按序
        if (picked >= sendable.length) break;     // 快照比待发送列表还长（理论上不会）→ 后面的都不标
        map.set(m.i, sendable[picked].floor);
        cursor = picked + 1;
    }
    return map;
}

// 目录整段重绘：世界书消息 = 一项（消息头 + 条目明细）；**同一来源**（聊天 / 其他）的连续消息 = 一项
// （分组头 + 逐条明细）。所有"消息行"统一带 `.hco-row` + `data-i`（跳转 / 高亮 / 滚动联动都按它找）；
// 分组头单独用 `.hco-group-head`（点它跳到该组第一条）。
function renderContextOutlineList() {
    const listEl = document.getElementById('hco-body');
    if (!listEl) return;
    const all = ctxDump?.messages || [];
    // 第二十九轮口径②：目录窗不再有副标题行（`.hide-entry-sub` / `#hco-sub` 已删）——
    // 快照的基本信息挪进标题的 title（悬停可见），不再占一行高度。
    const titleEl = document.getElementById('hco-title');
    if (titleEl) {
        titleEl.textContent = '上下文目录';
        titleEl.title = ctxDump
            ? `${ctxDumpSourceLabel(ctxDump)} · ${all.length} 条消息 · 共 ${ctxDump.total} tokens`
            : '';
    }
    if (!all.length) {
        listEl.innerHTML = `<div class="tub-empty-state">没有可用的完整上下文快照。<br>
            在统计页点「模拟发送」生成即可（**不用重新生成消息**）。</div>`;
        ctxVisibleCount = 0;
        ctxHitCount = 0;
        ctxHitCursor = -1;
        updateCtxCounts();
        return;
    }
    // 第二十九轮：来源 / 角色筛选 + 检索（整套从查看器平移过来）→ 目录只列"当前可见"的消息
    // 第三十二轮：同一份筛选结果也给右侧内容区（见 renderMergedContext 的 ctxVisibleMessages）
    const shown = ctxVisibleMessages();
    ctxVisibleCount = shown.length;
    const edges = contextSendableEdges(ctxModel || {});
    const mesidByIndex = outlineChatMesids(shown);       // 聊天条目的 ST messageID（见该函数注释）
    const wiEntriesAll = shown.flatMap(m => (isWiKind(m.kind) && Array.isArray(m.wiEntries)) ? m.wiEntries : []);
    const booksCount = new Set(wiEntriesAll.map(e => e.book)).size;
    const absoluteMax = wiEntriesAll.length ? Math.max(...wiEntriesAll.map(e => Number(e.tokens) || 0)) : 1;
    // 行构建器与主面板 / 世界书消息条目子窗同一套；条目名后**一律**括号显示来源世界书
    // （本目录跨多条消息，条目来自哪本书必须一眼可见）；行提示语改成"跳到内容区"（本窗已是导航）
    const rowBuilder = createEntryRowBuilder({
        booksCount, bookFilter: 'all', absoluteMax, alwaysShowBook: true,
        rowTitle: '点击跳到右侧内容区里这条条目的正文',
        insertMeta: true,   // 第二十七轮 R5：条目行的第二行显示「插入位置 · 顺序」
    });
    // ── 目录列表的视觉语言（第二十七轮 R3 重排 + R4 加行距；第二十八轮六条口径）──────────────
    // 三层、一眼看出从属关系：
    //   ① 项头 `.hco-head`（一条消息，或同一来源的"连续 N 条"分组头）—— 铺底色的一整行；
    //   ② 子项区 `.hco-kids` —— 左侧一条**树线**，明确"这一项下面还有什么"；
    //   ③ 子行 `.hco-kid`（分组内的消息明细 / 世界书条目明细）—— 统一缩进 + 更小字号。
    // ⚠️ R4：**不再显示 `hco-idx`（快照序号）**：聊天条目显示 ST 的 messageID（`.hco-mesid`），
    //    世界书 / 其他来源本来就没有"消息号"这回事，索性不显示任何序号（宁缺毋滥）。
    // ── 第二十八轮（用户六条口径）────────────────────────────────────────────────────────
    //   ① 项头/分组头**可折叠**（点头 = 折叠/展开下方列表，行首箭头指示状态）；它们右侧的 tokens
    //      **带单位 `t`**，子行/条目行**不带**；行尾加"跳到正文"小图标（折叠后仍能跳到这条消息）；
    //   ② 项头/分组头**不再显示角色 chip**（角色只在聊天子行上出现）；
    //   ③ 聊天子行去掉来源列，中间改显**正文前 N 个字符**（`.hco-preview`，不换行 + 省略号）；
    //      角色 chip 文案 `assistant` → `ai`，且 ai 用浅灰底；
    //   ④ 世界书来源（前置/后置/深度/混入/合并）在来源列里**一律显示"世界书"**，全称留 title；
    //   ⑤ 滚动联动扩到**世界书条目行**（见 `syncOutlineEntryActive`）；
    //   ⑥ 条目行 `.tub-nli-label` 不换行 + `.tub-nli-value` 固定最右（CSS：label 的 flex-basis 归 0，
    //      否则长条目名会把 tokens 挤到第二行左侧 —— 真实 Chromium 实测复现）。
    // ⚠️ 条目行不再用主面板那套"卡片"（渐变底 / 阴影 / hover 上浮）——那是"条目面板"的语言，放目录里就是噪声；
    //    类型改用行首一个小方块（见 CSS 的 `::before` + `data-type`），底色/阴影/位移全部抹平。
    // 角色 chip（仅聊天子行用）：文案与类名统一 —— assistant → **AI**（第三十一轮用户口径：大写）、
    // user → user、其余 → sys。类名保持 `hco-role-ai`（暗色主题 / 离线单测都按它选）。
    const roleChip = (role) => {
        const key = role === 'assistant' ? 'ai' : (role === 'user' ? 'user' : 'sys');
        const label = key === 'ai' ? 'AI' : key;
        return `<span class="hco-role hco-role-${key}">${label}</span>`;
    };
    // 来源列 / 标题：统一走模块级的 ctxSourceTextOf / ctxSourceTitleAttr（第三十五轮抽出）——
    // 「条目来源」子窗头部也要显示同一串，两处必须同源同口径（用户口径⑪）。
    const srcOf = (m) => ctxSourceTextOf(m);
    const srcTitleAttr = (m) => ctxSourceTitleAttr(m);
    // 聊天条目的 messageID 徽标：拿不到就不渲染（见 outlineChatMesids）
    const mesidHtml = (m) => {
        const v = mesidByIndex.get(m.i);
        return Number.isFinite(v) ? `<span class="hco-mesid" title="聊天消息 messageID（酒馆聊天数组下标）">#${v}</span>` : '';
    };
    // 聊天子行的正文预览：前 N 个字符（空白压成单空格）；视觉截断交给 CSS 省略号，全文进 title 悬停可见
    const previewOf = (m) => String(m.text ?? '').replace(/\s+/g, ' ').trim();
    // 第二十九轮：检索命中高亮（从查看器平移过来的整窗检索）。
    // 目录行是"一条消息一行"，所以高亮直接打在行的文本上；每个 <mark> 带全局递增的 data-hit，
    // 上/下一个命中就按这个编号在 DOM 里定位（与旧的整窗检索同一套口径）。
    let hitSeq = 0;
    const mark = (text) => {
        const r = highlightTextHtml(String(text ?? ''), ctxSearchTerm, { attr: 'data-hit', base: hitSeq });
        hitSeq += r.count;
        return r.html;
    };
    // 世界书消息行的「条目来源」图标（第二十九轮新增）：查看器删除后，原来的入口在查看器里；
    // 现在挪到目录里世界书消息的项头行尾，点它开「条目来源」子窗（饼图 / 类型过滤 / 点条目看详情）。
    const srcEntryBtn = (m) => (isWiKind(m.kind)
        ? `<span class="hco-wi-src" title="查看这条世界书消息的条目来源（饼图 + 条目列表）">${HC_ICON_WI}</span>`
        : '');
    // 项头（独立消息 / 世界书消息）：折叠箭头 + messageID + 来源 + （世界书行）条目来源图标 + tokens（带 t）。
    // 第二十八轮口径②：**不带角色 chip**；口径①：点头折叠。
    // 第二十九轮 R1（口径④）：**去掉 `.hco-jump` 图标** —— 项头行本身已经是可点的（点空白处折叠/展开），
    //   行尾那个"跳到正文"小箭头与"点聊天子行/条目行跳转"重复，且挤占 tokens 列，按用户口径删掉。
    // 第三十五轮用户口径⑧：**没有可展开内容的项不显示折叠箭头**（`hco-caret`）——
    //   这类行（没有条目明细的世界书消息 / 单条独立消息）点了也不会展开什么，箭头会误导用户。
    //   判断依据由调用方传入 `hasKids`；为 false 时连 `.hco-collapsible` 类都不加（点击即无折叠行为）。
    const msgHeadHtml = (m, hasKids = false) => `
            <div class="hco-head hco-row${hasKids ? ' hco-collapsible' : ''}" data-i="${m.i}"${hasKids ? ' title="点击折叠/展开下方列表"' : ' title="这条消息没有可展开的明细"'}>
                ${hasKids ? `<span class="hco-caret">${HC_ICON_DOWN}</span>` : ''}
                ${mesidHtml(m)}
                <span class="hco-src"${srcTitleAttr(m)}>${mark(srcOf(m))}</span>
                ${srcEntryBtn(m)}
                <span class="hco-tokens">${Number(m.tokens) || 0} t</span>
            </div>`;
    // 聊天子行（分组里的消息明细）：messageID + 角色 chip + 正文前 N 个字符 + tokens（不带 t）；无来源列
    const msgKidHtml = (m) => {
        const full = previewOf(m);
        return `
            <div class="hco-kid hco-sub hco-row" data-i="${m.i}" title="点击跳到右侧内容区里这条消息的第一行">
                ${mesidHtml(m)}
                ${roleChip(m.role)}
                <span class="hco-preview" title="${escapeHtmlText(full)}">${mark(full.slice(0, OUTLINE_PREVIEW_CHARS))}${full.length > OUTLINE_PREVIEW_CHARS ? '…' : ''}</span>
                <span class="hco-tokens">${Number(m.tokens) || 0}</span>
            </div>`;
    };

    listEl.innerHTML = groupOutlineMessages(shown).map(g => {
        if (g.type === 'wi' || g.items.length === 1) {
            const m = g.items[0];
            const entries = (isWiKind(m.kind) && Array.isArray(m.wiEntries)) ? m.wiEntries : [];
            let entryHtml = '';
            if (entries.length) {
                // 同一条消息里的条目：仍按「上下文顺序」排（与主面板 / 条目来源子窗同一口径）
                const records = entries.map(e => ({
                    name: e.name, b: e.book, type: e.type, uid: e.uid, tokens: e.tokens,
                    matched: true, anchor: e.anchor || null, pos: e.pos ?? null,
                    // 第二十七轮 R5：条目行的第二行要用（见 rowBuilder 的 insertMeta）
                    position: e.position ?? null, depth: e.depth ?? null, role: e.role ?? null, order: e.order ?? null,
                }));
                sortEntriesByMode(records, 'context', edges);
                entryHtml = `<div class="hco-kids hco-entries">${records.map(rowBuilder.html).join('')}</div>`;
            }
            return `<div class="hco-item${ctxOutlineCollapsed.has(m.i) ? ' hco-collapsed' : ''}" data-i="${m.i}">
                ${msgHeadHtml(m, entries.length > 0)}
                ${entryHtml}
            </div>`;
        }
        // 同一来源（聊天 / 其他）里的连续消息：一个分组项（项头 = 分组头，子行 = 逐条消息）
        const first = g.items[0];
        const label = g.source === 'chat' ? '聊天' : '其他';
        let tokensSum = 0;
        for (const m of g.items) tokensSum += Number(m.tokens) || 0;
        const ids = g.items.map(m => mesidByIndex.get(m.i));
        const rangeHtml = (g.source === 'chat' && ids.every(v => Number.isFinite(v)))
            ? `<span class="hco-mesid hco-mesid-range" title="这组聊天消息的 messageID 区间">#${ids[0]}–#${ids[ids.length - 1]}</span>`
            : '';
        // 第三十一轮（用户口径）：**聊天**分组头的 `.hco-pill`（"聊天 N"）去掉 —— 它和
        //   `#首–#末` 区间徽标 + 右侧「连续 N 条」三处说的是同一件事，纯冗余且挤占行宽。
        //   「其他」来源保留 pill（否则那一组就只剩"连续 N 条"，看不出是哪种来源）。
        const pillHtml = (g.source === 'chat')
            ? ''
            : `<span class="hco-pill">${escapeHtmlText(label + ' ' + g.items.length)}</span>`;
        return `<div class="hco-item hco-group${ctxOutlineCollapsed.has(first.i) ? ' hco-collapsed' : ''}" data-i="${first.i}">
                <div class="hco-head hco-group-head hco-collapsible" data-i="${first.i}" title="连续 ${g.items.length} 条「${label}」来源的消息（点击折叠/展开）">
                    <span class="hco-caret">${HC_ICON_DOWN}</span>
                    ${rangeHtml}
                    ${pillHtml}
                    <span class="hco-src">连续 ${g.items.length} 条</span>
                    <span class="hco-tokens">${tokensSum} t</span>
                </div>
                <div class="hco-kids hco-sublist">${g.items.map(m => msgKidHtml(m)).join('')}</div>
            </div>`;
    }).join('');

    // 检索命中计数：渲染时编好的 data-hit 一共多少个（顺序 = DOM 顺序 = 阅读顺序）
    ctxHitCount = ctxSearchTerm.trim() ? listEl.querySelectorAll('mark[data-hit]').length : 0;
    if (ctxHitCursor >= ctxHitCount) ctxHitCursor = ctxHitCount ? ctxHitCount - 1 : -1;
    updateCtxCounts();

    // 交互（第二十八轮口径①；第二十九轮 R1 去掉 `.hco-jump`）：
    //   · 项头 / 分组头（`.hco-collapsible`）→ 点击**折叠/展开**下方列表（不再直接跳转）；
    //   · 世界书消息行尾的「条目来源」图标（`.hco-wi-src`）→ 开「条目来源」子窗；
    //   · 聊天子行（`.hco-kid.hco-row`）→ 点击跳到那条消息的第一行；
    //   · 条目行 → 滚到该条目正文的第一行。
    listEl.querySelectorAll('.hco-item').forEach(item => {
        const i = Number(item.getAttribute('data-i'));
        item.querySelectorAll('.hco-collapsible').forEach(row => {
            const ri = Number(row.getAttribute('data-i'));
            const key = Number.isFinite(ri) ? ri : i;
            row.onclick = () => {
                const nowCollapsed = !ctxOutlineCollapsed.has(key);
                if (nowCollapsed) ctxOutlineCollapsed.add(key); else ctxOutlineCollapsed.delete(key);
                item.classList.toggle('hco-collapsed', nowCollapsed);
            };
        });
        item.querySelectorAll('.hco-wi-src').forEach(icon => {
            icon.onclick = (ev) => {
                ev.stopPropagation();   // 别让父行的"折叠"一起触发
                const row = icon.closest?.('.hco-row');
                const ri = Number(row?.getAttribute?.('data-i'));
                openWiMsgPopup(Number.isFinite(ri) ? ri : i);
            };
        });
        item.querySelectorAll('.hco-kid.hco-row').forEach(row => {
            const ri = Number(row.getAttribute('data-i'));
            row.onclick = () => jumpContextOutlineToMessage(Number.isFinite(ri) ? ri : i);
        });
        item.querySelectorAll('.hco-entries .tub-entry-clickable').forEach(row => {
            row.onclick = () => jumpContextOutlineToEntry(i, {
                book: row.getAttribute('data-book'),
                name: row.getAttribute('data-name'),
                uid: row.getAttribute('data-uid'),
            });
        });
    });
    if (!shown.length) {
        listEl.innerHTML = `<div class="tub-empty-state">当前筛选条件下没有消息。</div>`;
    }
    applyOutlineHitCursor();
    syncOutlineActiveHead();
    refreshOutlineEntryHighlight();   // 重绘后沿用"当前条目"高亮（行是新造的，类没了）
}

// "最近跳到过"的那条：内容区里只留一个高亮（左侧描边，与查看器的 .hc-msg-target 同款）
function markMergedTarget(chunkEl) {
    const bodyEl = document.getElementById('hcm-body');
    if (!bodyEl) return;
    bodyEl.querySelectorAll('.hcm-chunk-target').forEach(el => el.classList.remove('hcm-chunk-target'));
    if (chunkEl && chunkEl.classList) chunkEl.classList.add('hcm-chunk-target');
}

// 把内容区滚到"某条消息的文本里第 offset 个字符"所在的那一行：
// 内容区是整篇纯文本、没有逐条目的 DOM 节点，故用 Range 量出该偏移处的纵坐标再滚（**只滚内容区自己**，不碰文档）。
// ⚠️ 量**两遍**：首次赋值前的那一刻，容器的滚动位置可能刚被"显示/恢复滚动"改过、rect 与 scrollTop 还没对齐
//   （真实 Chromium 实测：目标行会停在容器顶下方 13~33px，再点一次又偏到上方 20px）；
//   第二遍在滚动已生效后重新量残差、把它收掉 → 目标行稳定落在容器顶（留 4px）。
// 环境不支持（Range / 文本节点缺失）时返回 false，调用方退回"滚到这条消息的第一行"。
function scrollMergedToOffset(bodyEl, chunkEl, offset) {
    const node = chunkEl.firstChild;
    const text = (node && node.nodeType === 3) ? String(node.nodeValue ?? '') : '';
    if (!text || offset <= 0 || typeof document.createRange !== 'function') return false;
    try {
        const at = Math.min(offset, text.length - 1);
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, Math.min(at + 1, text.length));
        const maxTop = () => Math.max(0, bodyEl.scrollHeight - bodyEl.clientHeight);
        const pass = () => {
            const r = range.getBoundingClientRect();
            const c = bodyEl.getBoundingClientRect();
            const next = Math.min(maxTop(), Math.max(0, Math.round(bodyEl.scrollTop + (r.top - c.top) - 4)));
            if (next !== bodyEl.scrollTop) bodyEl.scrollTop = next;
            return Math.round(r.top - c.top) - 4;   // 归位后还剩多少偏差（0 = 这一行正好贴在容器顶下方 4px）
        };
        if (Math.abs(pass()) > 1) pass();
        return true;
    } catch (e) {
        return false;
    }
}

// 把内容区滚到"某个定位锚（消息块）的第一行"：与 scrollMergedToOffset 同一套**两遍收敛**思路（只滚内容区自己）。
// ⚠️ 为什么不直接用 scrollIntoViewWithin：它只量一次，而"刚从别处滚过来"时首次量出的 rect 与 scrollTop 还没对齐
//   （真实 Chromium 实测：点目录里的消息行会停在目标行上方/下方一百多像素，第二遍重新量残差就能收干净）。
function scrollMergedToElement(bodyEl, el) {
    if (!bodyEl || !el) return;
    const maxTop = () => Math.max(0, bodyEl.scrollHeight - bodyEl.clientHeight);
    const pass = () => {
        const r = el.getBoundingClientRect();
        const c = bodyEl.getBoundingClientRect();
        const next = Math.min(maxTop(), Math.max(0, Math.round(bodyEl.scrollTop + (r.top - c.top) - 4)));
        if (next !== bodyEl.scrollTop) bodyEl.scrollTop = next;
        return Math.round(r.top - c.top) - 4;
    };
    if (Math.abs(pass()) > 1) pass();
}

// 目录里点一条消息（`hco-item` / `hco-msg-head`）→ 内容区滚到**该条消息的第一行**。
// 只在成对窗口里出现；万一它已被收起（理论到不了），这里直接什么都不做。
function jumpContextOutlineToMessage(i) {
    if (!ctxMergeMode) return;
    const bodyEl = document.getElementById('hcm-body');
    const idx = Number(i);
    if (!bodyEl) return;
    ensureMergedChunksUpTo(idx);   // 懒渲染：目标条可能还没渲染出来（先补齐再跳）
    const chunk = bodyEl.querySelector(`.hcm-chunk[data-i="${idx}"]`);
    if (!chunk) return;
    markMergedTarget(chunk);
    scrollMergedToElement(bodyEl, chunk);
    ctxOutlineSpySuppressUntil = Date.now() + 250;   // 别让 scroll-spy 立刻把目录改回去（点最后一条会被 maxTop 钳住）
    syncOutlineActiveHead(idx);
    syncOutlineEntryActive(idx, chunk);               // 消息行跳转后，条目行高亮也跟着归位
}

// 目录里点一条世界书条目 → 内容区滚到**该条目正文的第一行**（找不到就退回所属消息的第一行 —— "点了总会有反应"）。
async function jumpContextOutlineToEntry(i, { book, name, uid } = {}) {
    const idx = Number(i);
    const bodyEl = document.getElementById('hcm-body');
    if (!bodyEl) return;
    ensureMergedChunksUpTo(idx);   // 懒渲染：先补齐到这条（否则下面取不到锚）
    const text = String((ctxVisibleMsgByIndex.get(idx) || ctxMsgByIndex.get(idx))?.text ?? '');
    let offset = -1;
    try {
        const found = await fetchWorldEntryDetail(book, name, uid);
        offset = findEntryOffsetInText(text, found?.entry?.content);
    } catch (e) {
        offset = -1;
    }
    // 等待期间窗口可能已被关掉 / 换了快照：重新取一次节点再跳
    if (!ctxMergeMode) return;
    const chunk = document.getElementById('hcm-body')?.querySelector(`.hcm-chunk[data-i="${idx}"]`);
    if (!chunk) return;
    markMergedTarget(chunk);
    if (!(offset >= 0 && scrollMergedToOffset(bodyEl, chunk, offset))) {
        scrollMergedToElement(bodyEl, chunk);
    }
    ctxOutlineSpySuppressUntil = Date.now() + 250;   // 同上：程序化跳转后短暂静默
    syncOutlineActiveHead(idx);
    syncOutlineEntryActive(idx, chunk);               // 条目行高亮也跟着跳转更新（落点可能正在某条目正文里）
}

// 目录里"当前选中"的那条消息：重绘后沿用（左侧描边）。
// 第二十七轮 R2：分组后"当前"落在**消息行**（`.hco-row[data-i]`）上，其所在的分组项（`.hco-item`）同时高亮。
function syncOutlineActiveHead(i) {
    if (i !== undefined) ctxOutlineActiveIndex = (i === null) ? null : Number(i);
    const listEl = document.getElementById('hco-body');
    if (!listEl) return;
    listEl.querySelectorAll('.hco-row-active').forEach(el => el.classList.remove('hco-row-active'));
    listEl.querySelectorAll('.hco-item-active').forEach(el => el.classList.remove('hco-item-active'));
    const row = listEl.querySelector(`.hco-row[data-i="${ctxOutlineActiveIndex}"]`);
    if (!row) return;
    row.classList.add('hco-row-active');
    const group = row.closest?.('.hco-item');
    if (group) group.classList.add('hco-item-active');
}

// ── 内容区 → 目录的滚动联动（scroll-spy，第二十七轮 R1 用户口径；第二十八轮扩到世界书条目行）────────
// "在合并内容里滚动到对应的位置时，左侧目录也要滚动显示到对应的选项。"
// 判定：容器顶下方第一条"还没滚过去"的消息块就是当前条；**只有当前条变了**才动目录（否则每帧都滚一下会抖），
// 且只滚目录自己的容器（`scrollIntoViewWithin` → 绝不碰文档）。
// ⚠️ 程序化跳转（点目录）后有 250ms 静默期：点最后一条时滚动被 maxTop 钳住、容器顶可能停在倒数第二条里，
//    没有静默期的话目录会立刻被改回上一条（跟用户刚点的选项打架）。
let ctxOutlineSpyPending = false;
let ctxOutlineSpySuppressUntil = 0;

// ⚠️ rAF **配一个 setTimeout 兜底**（不是"二选一"）：标签页不在前台时 rAF 会被节流/暂停（真实 Chromium 实测
//   后台页里 rAF 不跑、scroll 事件甚至根本不派发），"谁先到算谁" + pending 标志保证只跑一次。
function scheduleOutlineSpy() {
    if (ctxOutlineSpyPending) return;
    ctxOutlineSpyPending = true;
    const run = () => {
        if (!ctxOutlineSpyPending) return;
        ctxOutlineSpyPending = false;
        syncOutlineFromMergedScroll();
    };
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(run);
    setTimeout(run, 60);
}

function syncOutlineFromMergedScroll() {
    if (!ctxMergeMode) return;
    if (Date.now() < ctxOutlineSpySuppressUntil) return;
    const bodyEl = document.getElementById('hcm-body');
    const listEl = document.getElementById('hco-body');
    if (!bodyEl || !listEl) return;
    const chunks = bodyEl.querySelectorAll('.hcm-chunk');
    if (!chunks || !chunks.length) return;
    const top = bodyEl.getBoundingClientRect().top;
    let cur = null;
    for (const c of chunks) {
        if (c.getBoundingClientRect().bottom - top > 4) { cur = c; break; }   // 第一条"还看得见"的消息
    }
    const i = cur ? Number(cur.getAttribute('data-i')) : null;
    if (i === null || Number.isNaN(i)) { syncOutlineEntryActive(null, null); return; }
    // ⚠️ 消息没变**也要**更新条目行：同一条世界书消息里继续往下滚，当前条目是会变的
    //    （旧实现在这里就 return 了，条目行于是永远是"第一个"或"没有"）。
    if (i !== ctxOutlineActiveIndex) {
        syncOutlineActiveHead(i);
        const item = listEl.querySelector(`.hco-row[data-i="${i}"]`);   // 分组后"当前"落在消息行上（第二十七轮 R2）
        if (item) scrollIntoViewWithin(listEl, item, 'nearest');
    }
    syncOutlineEntryActive(i, cur);
}

// 量出某条世界书消息里各条目正文的纵坐标（内容坐标系；量过一次就缓存，代次失效见 ctxEntryLayouts）。
// 依据：快照 `wiEntries[].pos` = `槽位序号 * 1e6 + 该条目第一个行锚点在槽位正文里的字符偏移`
//       ⇒ `pos % 1e6` 就是条目正文起点的字符偏移；用 Range 量出它的纵坐标即可（与 scrollMergedToOffset 同一招）。
// ⚠️ 槽位号与当前消息对不上的条目不参与（那条目在这条消息里没有可定位的正文）—— 宁可不亮，也不亮错。
//
// 第二十九轮（用户口径④"滚动定位还是不够准确，一下就跳好几个世界书条目"）三处修正：
//   ① **逐槽位 pos**（见 computeRenderedStats 的 entrySlotFirstPos）：同一个条目在多条消息里都命中时，
//      旧口径只保留"最早那条消息"的偏移，其他消息里的条目因此全部失去定位 → 剩下几个边界被拉得极开；
//   ② **用锚点文本重新定位**（`wiEntries[].hint`）：pos 记的是"渲染后可见文本"里的偏移，而内容区显示的是
//      **实际发送的字符**（可能被正则改写过）—— 一旦错位，旧代码 `Math.min(off, len-1)` 会把偏移**钳到最后一位**，
//      于是好几条条目拿到同一个纵坐标、把边界抹平，滚动时就"一下跳好几个"。现在优先按锚点文本 indexOf；
//   ③ **单调兜底**：仍然定位不到的条目不再"钳到末尾"，而是**跳过**；另外量出来的 top 必须满足
//      `top >= 上一个条目的 top`，倒挂的一律跳过（倒挂 = 明显错位，宁可少亮一条也不乱亮）。
function ensureEntryLayout(msgIdx) {
    if (!Number.isFinite(msgIdx)) return null;
    if (ctxEntryLayoutToken !== ctxMergedRenderToken) {
        ctxEntryLayouts.clear();
        ctxEntryLayoutToken = ctxMergedRenderToken;
    }
    const cached = ctxEntryLayouts.get(msgIdx);
    if (cached) return cached;
    const out = [];
    const bodyEl = document.getElementById('hcm-body');
    const chunk = bodyEl?.querySelector(`.hcm-chunk[data-i="${msgIdx}"]`);
    const node = chunk?.firstChild;
    const m = ctxVisibleMsgByIndex.get(msgIdx) || ctxMsgByIndex.get(msgIdx);
    if (bodyEl && chunk && node && node.nodeType === 3 && m && Array.isArray(m.wiEntries) && m.wiEntries.length
        && typeof document.createRange === 'function') {
        const text = String(node.nodeValue ?? '');
        const len = text.length;
        const bodyTop = bodyEl.getBoundingClientRect().top;
        const lower = text.toLowerCase();
        // 字符偏移 → 内容区坐标系里的纵坐标（量不到就返回 null）
        const topAt = (at) => {
            if (!(at >= 0) || at >= len) return null;
            try {
                const range = document.createRange();
                range.setStart(node, at);
                range.setEnd(node, Math.min(at + 1, len));
                const r = range.getBoundingClientRect();
                if (!Number.isFinite(r.top)) return null;
                return r.top - bodyTop + bodyEl.scrollTop;
            } catch (err) {
                return null;
            }
        };
        for (const e of m.wiEntries) {
            const pos = Number(e.pos);
            const slot = Number.isFinite(pos) ? Math.floor(pos / 1e6) : null;
            const off = Number.isFinite(pos) ? (pos - slot * 1e6) : null;
            if (slot !== null && slot !== msgIdx) continue;   // 这条条目不属于这条消息
            // ① 先用锚点文本在本条消息的正文里找起点（最可靠：与实际发送的字符逐字对应）
            let at = -1;
            const hint = String(e.hint ?? '').trim();
            if (hint) {
                at = lower.indexOf(hint.toLowerCase());
                if (at < 0) {
                    const firstLine = hint.split(/\r?\n/).map(l => l.trim()).find(Boolean) || '';
                    if (firstLine) at = lower.indexOf(firstLine.toLowerCase());
                }
            }
            // ② 锚点找不到（被正则大幅改写）才退回 pos 偏移；**不再钳到末尾**
            if (at < 0 && Number.isFinite(off) && off < len) at = off;
            if (at < 0) continue;
            const top = topAt(at);
            if (top === null) continue;
            // ③ 单调兜底：与上一条相比倒挂（明显错位）→ 跳过，宁缺毋滥
            if (out.length && top < out[out.length - 1].top) continue;
            out.push({ uid: String(e.uid ?? ''), top });
        }
        out.sort((a, b) => a.top - b.top);
    }
    ctxEntryLayouts.set(msgIdx, out);
    return out;
}

// 世界书**条目行**的滚动联动（第二十八轮用户口径："世界书列表的项也要激活显示"）。
// 判定：容器顶的内容坐标 `body.scrollTop` 落在哪个条目的 [top, 下一个条目 top) 里，就高亮哪个条目行；
//      落在第一个条目之前（= 该消息正文的开头，前面没有条目正文）→ 只亮消息行，不亮任何条目。
// ⚠️ 只有"当前条目"变了才动 DOM（每帧都加/删类会抖）；条目行同样要滚到看得见（scrollIntoViewWithin）。
// 第二十九轮口径④：判定改成"**容器顶下方第一条还没滚过去的条目**"（与消息块用的是同一套语义），
//   并且加了 4px 容差 —— 原来用 `e.top <= st`（st 带 +4 容差）找"最后一个已越过的条目"，
//   在条目边界附近容器顶刚越过某条时就会立刻改亮下一条，滚动一点、跳一条，观感就是"一下跳好几个"。
function syncOutlineEntryActive(i, chunkEl, force = false) {
    const listEl = document.getElementById('hco-body');
    const bodyEl = document.getElementById('hcm-body');
    if (!listEl || !bodyEl) return;
    const layout = (i !== null && Number.isFinite(i)) ? ensureEntryLayout(i) : null;
    let hit = null;
    if (layout && layout.length && chunkEl) {
        const st = bodyEl.scrollTop;
        // 容器顶**已经进入**这条消息的框里（块顶在容器顶上方，允许 4px 入场容差）才判条目
        const inside = chunkEl.getBoundingClientRect().top <= bodyEl.getBoundingClientRect().top + 4;
        if (inside) {
            hit = layout[0];                               // 默认亮第一条（刚滚到消息开头时"有反应"）
            for (const e of layout) {                       // 越过一条就往下推一条
                if (e.top <= st + 4) hit = e; else break;
            }
        }
    }
    const key = hit ? `${i}|${hit.uid}` : '';
    if (!force && key === ctxOutlineActiveEntry) return;
    ctxOutlineActiveEntry = key;
    if (listEl.querySelectorAll) listEl.querySelectorAll('.hco-entry-active').forEach(el => el.classList.remove('hco-entry-active'));
    if (!hit) return;
    const item = listEl.querySelector(`.hco-item[data-i="${i}"]`);
    const rows = item ? Array.from(item.querySelectorAll('.hco-entries .tub-entry-clickable')) : [];
    const row = rows.find(r => r.getAttribute('data-uid') === hit.uid);
    if (!row) return;
    row.classList.add('hco-entry-active');
    scrollIntoViewWithin(listEl, row, 'nearest');
}

// 目录重绘后沿用"当前条目"高亮（行是新造的，类没了；内容区没动过，坐标缓存还有效）
function refreshOutlineEntryHighlight() {
    if (!ctxMergeMode || ctxOutlineActiveIndex === null || ctxOutlineActiveIndex === undefined) return;
    const bodyEl = document.getElementById('hcm-body');
    const chunk = bodyEl?.querySelector(`.hcm-chunk[data-i="${ctxOutlineActiveIndex}"]`);
    if (chunk) syncOutlineEntryActive(ctxOutlineActiveIndex, chunk, true);
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

// 统一关闭日志UI的逻辑（DOM状态 + 设置 + 定时器 + 日志历史）
function disableLogUi(silent = false) {
    clearTimeout(logUiAutoDisableTimer);
    const $toggle = $('#hide-helper-log-ui-toggle');
    if ($toggle.is(':checked')) {
        $toggle.prop('checked', false);
    }
    $('.log-level-selector-wrapper').slideUp(200);
    $('#hide-helper-download-log').fadeOut(200);
    extension_settings[extensionName].logUiVisible = false;
    extension_settings[extensionName].logUiOpenedAt = null;
    extension_settings[extensionName].logLevel = 0;
    applyLogLevel(0);
    saveSettingsDebounced();
    Logger.logHistory = [];
    if (!silent) {
        // toastr.info('为保障性能，显示日志功能已达60分钟上限，已自动关闭并重置日志级别。');
    }
}

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

    // 世界书扫描完成事件：记录本次真正激活的条目，供后续"按实际发送内容折算"使用。
    // 任何来源的扫描都会先记录到这里；真正发往 AI 的那次发送会在 SETTINGS_READY 时刻
    // 把当时的条目集快照为 lockedScanEntries，从而避免其他来源的扫描覆盖归因依据。
    eventSource.on(event_types.WORLDINFO_SCAN_DONE, (data) => {
        if (!data?.activated?.entries) return;
        lastScanEntries = Array.from(data.activated.entries.values()).map(entry => ({
            world: entry.world,
            uid: entry.uid,
            comment: entry.comment,
            constant: !!entry.constant,
            // 位置 / 深度 / 角色 / 出口名：用于"上下文顺序"按真实插入点归组（见 entryContextAnchor）。
            position: Number(entry.position) || 0,
            depth: Number(entry.depth) || 0,
            role: entry.role ?? null,
            outletName: entry.outletName ?? null,
            content: typeof entry.content === 'string' ? entry.content : '',
        }));
        Logger.debug(`【WI扫描】记录本次激活条目 ${lastScanEntries.length} 条`);
    });

    // 世界书更新事件
    if (event_types.WORLDINFO_UPDATED) {
        eventSource.on(event_types.WORLDINFO_UPDATED, () => {
            updateTokenStatsUI();
        });
    }

    // 记录当前前台生成类型，供捕获时过滤后台生成（如剧情总结的 quiet 请求）。
    // 设计要点：
    //  - dryRun 不发 SETTINGS_READY，也不发结束事件，所以直接忽略（置 null）；
    //  - generateRawData 等直连请求不发 GENERATION_STARTED，但会发 SETTINGS_READY，
    //    因此类型值采用"消费一次"语义，SETTINGS_READY 读取后立即清空，
    //    保证过期值不会误配到后续无来源的后台请求上；
    //  - 生成结束/中止/切聊天时一并清空。
    // 变量定义在模块级（见文件顶部），以便模拟发送在 finally 里兜底清理。
    eventSource.on(event_types.GENERATION_STARTED, (type, _options, dryRun) => {
        pendingGenType = dryRun ? null : type;
    });

    // 提示词标识捕获（供槽位来源判定：世界书 前置/后置、深度注入、聊天）：在 GENERATE_AFTER_DATA 采样。
    // 这个时机是实测得到的唯一稳妥点：PROMPT_READY 的所有监听器（含第三方 splice 注入）都已执行完，
    // 而 EJS 渲染尚未开始，因此此刻的 chat 内容仍能与 promptManager 的原文逐条对应。
    // 详见 capturePromptIdentifiers 上方的说明。
    if (event_types.GENERATE_AFTER_DATA) {
        eventSource.on(event_types.GENERATE_AFTER_DATA, (data, dryRun) => {
            if (dryRun || !data) return;
            // openai（Chat Completion）路径下 generate_data.prompt 就是消息数组
            if (Array.isArray(data.prompt)) capturePromptIdentifiers(data.prompt);
        });
    }

    if (event_types.GENERATION_ENDED) {
        eventSource.on(event_types.GENERATION_ENDED, () => {
            pendingGenType = null;
            // normal 的锚定挂在"等待 AI 回复"上：此刻回复应已追加 → 补写；仍未到则回退到触发消息
            flushPendingReplyAnchor('generation-ended', true);
        });
    }
    if (event_types.GENERATION_STOPPED) {
        eventSource.on(event_types.GENERATION_STOPPED, () => {
            pendingGenType = null;
            // 被用户中止：可能没有回复 → 回退写到触发消息上，统计不丢
            flushPendingReplyAnchor('generation-stopped', true);
        });
    }
    // normal 的新回复到达时补写（ST 先发 MESSAGE_RECEIVED 再发 GENERATION_ENDED，两条路都能收尾）
    if (event_types.MESSAGE_RECEIVED) {
        eventSource.on(event_types.MESSAGE_RECEIVED, () => { flushPendingReplyAnchor('message-received', false); });
    }
    // 超时兜底：事件顺序异常（既没有结束事件也没有新消息）时不让统计永久挂起。
    // ⚠️ 生成中（`body.dataset.generating`）跳过——慢速回复可能要几十秒，绝不能提前回退到触发消息。
    setInterval(() => {
        if (!pendingReplyAnchor) return;
        if (document.body?.dataset?.generating === 'true') return;
        flushPendingReplyAnchor('timeout', true);
    }, 2000);

    // 捕获"最终上下文"（EJS 等扩展渲染完成后、实际发送给 AI 的消息）用于准确统计。
    // ST-Prompt-Template 等渲染扩展在本事件的监听器里就地改写 completion.messages，
    // 各扩展按加载顺序依次执行，因此这里拿到的是渲染后的最终内容。
    // 统计结果会锚定到"触发本次发送的那条消息"上，见文件顶部说明。
    eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, (completion) => {
        // 第三十六轮（功能开关）：聊天统计被禁用 → **整条统计链路直接跳过**（不统计、不锚定、不存快照）。
        // ⚠️ 必须放在最前：放在模拟分支之后的话，一次误触发的模拟仍会跑完组装管线并 abort 请求。
        //   放在最前时模拟那次也不例外 —— 此时 `simulateInProgress` 还没被消费，先解掉它，
        //   免得"统计关着 + 点了模拟"留下一个永远清不掉的标志（后续真实发送会被误当成模拟）。
        if (!isFeatureEnabled('stats')) {
            if (simulateInProgress) {
                simulateInProgress = false;
                pendingGenType = null;
                try { getContext()?.stopGeneration?.(); } catch (e) { /* 忽略 */ }
            }
            Logger.debug('【统计】聊天统计功能已禁用，跳过本次最终上下文统计');
            return;
        }
        // 模拟发送：把本次"最终上下文"转入临时锚定，并立即 abort，阻止真正发往 API。
        // 这是唯一能拦住请求的时机（SETTINGS_READY 之后紧接 fetch），且此时 EJS 等已渲染完毕。
        if (simulateInProgress) {
            // 本次模拟的生成类型（快照要用它复刻同一套提示词顺序；随后立即消费掉，避免被后续逻辑误判）
            const simGenType = pendingGenType;
            pendingGenType = null;
            try {
                getContext()?.stopGeneration?.(); // 立即中止，fetch 拿到已 abort 的 signal，不会真正发请求
            } catch (e) {
                Logger.warn('【模拟发送】中止请求失败:', e);
            }
            if (!completion || !Array.isArray(completion.messages) || completion.messages.length === 0) return;
            // 发起模拟时的聊天必须仍是当前聊天，否则统计结果不得写入（模拟锚定会显示在统计页上）
            const simChatIdNow = simulateChatId;
            const simEntries = lastScanEntries; // 本次模拟真正使用的世界书条目集（随任务携带，见 P4-6）
            const simMessages = completion.messages;
            // 提示词标识：用 PROMPT_READY 时刻捕获的"对象引用 → identifier"映射对齐（消费一次）。
            // 必须此刻做完——映射会被后续任何一次生成覆盖，而统计是异步做的。
            const simIdentifiers = alignPromptIdentifiers(simMessages);
            const simKinds = alignPromptKinds(simMessages); // 结构身份（P2-4），与 simIdentifiers 同一次采样
            // 聊天快照必须在"此刻同步"取好：稍后 finally 会移除注入的临时消息，
            // 异步统计时再读聊天就取不到了。快照里含注入的临时消息，
            // computeSendableChat 会把它当作"最新一条聊天消息"参与深度注入插入点计算。
            const simChat = getContext()?.chat;
            const simSnapshot = Array.isArray(simChat) ? simChat.slice() : [];
            // AN（作者注释）的真实落点：此刻 extension_prompts 已是本次组装所用的值（模拟发送结束会还原快照，
            // 所以必须在此同步取好，不能等异步统计时再读）。
            const simAnInfo = captureAnInfo();
            // 提示词顺序快照（用户可随时改 prompt_order，不能写死默认顺序）：必须此刻同步取——
            // 统计是异步做的，期间顺序可能已被改动。
            const simPromptOrder = capturePromptOrderSnapshot(simGenType);
            // 串行队列（P4-6）：统计一次只跑一个；若上一轮未完成则排队等待（不再静默丢弃）。
            enqueueStatsJob({
                label: `模拟发送（${simMessages.length} 条消息）`,
                run: async () => {
                    const stats = await computeRenderedStats(simMessages, {
                        chatSnapshot: simSnapshot,
                        genType: 'simulate',
                        identifiers: simIdentifiers,
                        entries: simEntries,
                        kinds: simKinds,
                        anInfo: simAnInfo,
                        promptOrder: simPromptOrder,
                    });
                    if (!stats) return;
                    if (getContext()?.chatId !== simChatIdNow) {
                        Logger.debug('【模拟发送】锚定丢弃：统计期间聊天已切换');
                        return;
                    }
                    stats.genType = 'simulate';
                    simulateAnchor = stats;
                    // 完整上下文快照（仅内存）：模拟锚定用哨兵 id 入库
                    saveContextDump(simChatIdNow, SIM_ANCHOR_ID, 'simulate', lastContextDump);
                    statsViewMode = 'detail';
                    statsPinnedIndex = null;
                    Logger.debug(`【模拟发送】临时锚定：总计 ${stats.total}（聊天 ${stats.chat} / 世界书 ${stats.wi}）`);
                    updateTokenStatsUI();
                },
                onError: (err) => Logger.warn('模拟发送统计失败:', err),
            });
            return;
        }

        const genType = pendingGenType;
        pendingGenType = null; // 消费一次，防过期值误配
        if (!ANCHORED_GEN_TYPES.has(genType)) {
            Logger.debug(`【统计】跳过非发送类生成(${genType || 'unknown'})，不做锚定`);
            return;
        }

        if (!completion || !Array.isArray(completion.messages) || completion.messages.length === 0) return;

        // 锁定"本次发送"真正使用的世界书条目集：此刻 lastScanEntries 就是本次生成前扫描的结果。
        // 此后归因只读这份快照，避免其他扩展在异步统计学间触发的扫描把它覆盖掉。
        // P4-6：快照同时随任务携带（不再依赖模块级变量——排队期间它可能被后续请求改写）。
        const realEntries = lastScanEntries;

        // 同步取锚定位置：此刻"触发发送的那条消息"就是最后一条。
        // 锚定落点按生成类型解析（用户口径 §2.26：写在**生成出来的那条消息**上，而不是触发它的那条）：
        //   · normal → 先记下触发位置，等 AI 回复追加后再补写（见 flushPendingReplyAnchor）；
        //   · swipe / regenerate / continue → 被重生成的就是末条消息，直接写它（swipe 靠 swipe_info 镜像覆盖各版本）；
        //   · impersonate → 没有消息产出，回退锚在触发消息上。
        const context = getContext();
        if (!context?.chatId || !Array.isArray(context.chat) || context.chat.length === 0) return;
        const anchorIndex = context.chat.length - 1;
        const target = resolveAnchorTarget(genType, context.chat);
        if (!target) return;
        const anchor = {
            chatId: context.chatId,
            index: target.index,
            messageRef: target.messageRef,
            source: 'real',
        };

        // 注意：EJS 等扩展在本事件的监听器里同步改写 completion.messages，
        // 这里必须等它们完成后再读取，因此放到下一个事件循环。
        const messages = completion.messages;
        // 提示词标识：用 PROMPT_READY 时刻捕获的"对象引用 → identifier"映射对齐本次最终消息
        // （消费一次）。此刻做完是因为该映射会被后续生成覆盖。
        const identifiers = alignPromptIdentifiers(messages);
        const kinds = alignPromptKinds(messages); // 结构身份（P2-4），与 identifiers 同一次采样
        // 聊天快照：只取到"触发本次发送的那条消息"为止（后续 AI 回复不属于本次上下文）
        const chatSnapshot = context.chat.slice(0, anchorIndex + 1);
        // AN（作者注释）的真实落点：此刻 extension_prompts 就是本次发送所用的值（同步取，异步统计时可能已被改写）
        const anInfo = captureAnInfo();
        // 提示词顺序快照：与上面同源同刻（异步统计期间 prompt_order 可能已被用户改动）
        const promptOrder = capturePromptOrderSnapshot(genType);
        // 串行队列（P4-6）：与模拟发送共用同一队列；排队等待时不再静默丢锚点（有告警）。
        enqueueStatsJob({
            label: `真实发送（${genType}）`,
            run: async () => {
                const stats = await computeRenderedStats(messages, { chatSnapshot, genType, identifiers, kinds, entries: realEntries, anInfo, promptOrder });
                if (!stats) return; // 统计期间聊天已切换，丢弃结果
                stats.genType = genType; // 记录触发本次发送的生成类型（供对比视图元信息展示；旧锚点无此字段）
                const dump = lastContextDump;
                // normal：生成的是"即将追加的 AI 回复"，此刻可能还没到 → 挂起，等它到达后再补写（见 flushPendingReplyAnchor）；
                // 其余类型生成的就是末条消息本身 → 立即写入。
                if (target.mode === 'reply') {
                    pendingReplyAnchor = { chatId: anchor.chatId, triggerIndex: target.index, stats, dump };
                    // 回复其实已经先到了（事件顺序颠倒的时序）→ 立即补写；否则挂起等待
                    if (flushPendingReplyAnchor('immediate', false)) return;
                    Logger.debug(`【最终上下文】锚定挂起：等待 #${target.index} 的 AI 回复到达`);
                    return;
                }
                if (!writeAnchoredStats(anchor, stats, dump)) return;
                Logger.debug(`【最终上下文】锚定到消息 #${anchor.index}（${genType}）：总计 ${stats.total}（聊天 ${stats.chat} / 世界书 ${stats.wi}）`);
                updateTokenStatsUI();
            },
            onError: (err) => Logger.warn('统计最终上下文失败:', err),
        });
    });

    // --- 聊天统计事件监听结束 ---

    // 模拟发送：入口**不再**是锚定栏上的独立按钮（第三十五轮用户口径②已删除 `#tub-simulate-btn`），
    // 改为锚点菜单里的「模拟发送」动作项，由 bindAnchorMenu 直接调用 triggerSimulate()。
    // 这里保留一条委托兜底：万一旧 DOM / 夹具里还留着那个按钮，点了也能用（无按钮时形同不存在）。
    $(document).off('click.hideSimulate').on('click.hideSimulate', '#tub-simulate-btn', function() {
        triggerSimulate();
    });

    // --- 弹窗和标签页交互 ---

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
        // 第三十六轮（功能开关）：先应用开关状态（隐藏被禁用的标签页），再恢复上次的页。
        // ⚠️ 顺序不能反：如果先把 last_active_tab 亮起来、再隐藏，那一页就成了"看不见却 active"的鬼页，
        //   内容区会停在它上面（用户点任何标签都正常，只有这一页永远空着）。
        applyFeatureToggles();
        let lastActiveTab = extension_settings[extensionName].last_active_tab || 'hide-panel';
        // 上次停留的页正好被禁用 → 落到第一个可用页（applyFeatureToggles 已把 tab_visible 补齐）
        const visNow = extension_settings[extensionName].tab_visible || {};
        const blockedTab = FEATURE_TABS.find(f => f.tab === lastActiveTab && !visNow[f.key]);
        if (blockedTab) lastActiveTab = (FEATURE_TABS.find(f => visNow[f.key])?.tab) || 'instructions-panel';
        $('.tab-button').removeClass('active');
        $(`.tab-button[data-tab="${lastActiveTab}"]`).addClass('active');
        $('.tab-panel').removeClass('active');
        $(`.tab-panel[data-tab="${lastActiveTab}"]`).addClass('active');

        // ---- 【打开弹窗渲染统计】 ----
        // 直接读取消息上锚定的统计数据（上次实际发送时记录的），无任何副作用。
        updateTokenStatsUI();

        const $popup = $('#hide-helper-popup');
        const $backdrop = $('#hide-helper-backdrop');
        $backdrop.show();
        $popup.show();
        centerPopup($popup);
        updateTabIndicator(); // 弹窗显示后再测量，定位滑动下划线
        requestAnimationFrame(() => updateTabIndicator()); // 布局稳定后再校正一次
        $(window).off('resize.hideHelperMain').on('resize.hideHelperMain', () => { centerPopup($popup); updateTabIndicator(); repositionChildPopups(); });

        // 恢复日志UI开关状态
        const logUiVisible = extension_settings[extensionName].logUiVisible || false;
        const logUiOpenedAt = extension_settings[extensionName].logUiOpenedAt || null;
        const LOG_UI_TIMEOUT = 60 * 60 * 1000; // 60分钟

        // 检查是否已超过60分钟熔断时限（跨会话检测）
        if (logUiVisible && logUiOpenedAt && (Date.now() - logUiOpenedAt >= LOG_UI_TIMEOUT)) {
            disableLogUi();
        } else if (logUiVisible) {
            $('#hide-helper-log-ui-toggle').prop('checked', true);
            $('.log-level-selector-wrapper').slideDown(0);
            if (extension_settings[extensionName].logLevel === 3) {
                $('#hide-helper-download-log').show();
            } else {
                $('#hide-helper-download-log').hide();
            }

            // 启动/续期 60 分钟自动关闭熔断器（计算剩余时间）
            clearTimeout(logUiAutoDisableTimer);
            const elapsed = logUiOpenedAt ? Date.now() - logUiOpenedAt : 0;
            const remaining = Math.max(0, LOG_UI_TIMEOUT - elapsed);
            logUiAutoDisableTimer = setTimeout(() => {
                disableLogUi();
            }, remaining);
        } else {
            $('#hide-helper-log-ui-toggle').prop('checked', false);
            $('.log-level-selector-wrapper').slideUp(0);
            $('#hide-helper-download-log').hide();
        }

        // 显示主题提示弹窗（如果是首次打开）
        if (!extension_settings[extensionName].theme_notification_viewed) {
            showThemeNotification();
        }
    });

    // 关闭弹窗的统一处理函数
    function closePopup() {
        Logger.debug('');
        Logger.debug('🚪🚪🚪【关闭弹窗】开始 🚪🚪🚪');
        closeTypeFilterMenu(); // 关弹窗时一并收起类型过滤菜单（它挂在弹窗直下，不随面板重绘消失）

        // 确保输入框的设置已保存
        const $input = $('#hide-last-n');
        const inputVal = $input.val();
        const val = parseInt(inputVal);

        Logger.debug(`【关闭弹窗】📋 输入框状态:`);
        Logger.debug(`【关闭弹窗】   - 原始值: "${inputVal}"`);
        Logger.debug(`【关闭弹窗】   - 解析后: ${val}`);
        Logger.debug(`【关闭弹窗】   - 是否有效: ${!isNaN(val) && val >= 0}`);

        if (!isNaN(val) && val >= 0) {
            Logger.debug(`【关闭弹窗】💾 立即保存隐藏设置，值=${val}`);

            if (val > 0) {
                saveCurrentHideSettings(val);
            } else {
                saveCurrentHideSettings(null);
            }

            updateCurrentHideSettingsDisplay();

            // 立即执行隐藏检查，不使用防抖
            const settings = extension_settings[extensionName];
            if (settings?.enabled && settings?.autoHideEnabled) {
                Logger.debug(`【关闭弹窗】🔍 插件已启用且自动隐藏已开启，立即执行全量隐藏检查`);
                runFullHideCheck();
            } else {
                Logger.debug(`【关闭弹窗】⛔ 插件或自动隐藏未启用，跳过隐藏检查`);
                Logger.debug(`【关闭弹窗】   - enabled: ${settings?.enabled}`);
                Logger.debug(`【关闭弹窗】   - autoHideEnabled: ${settings?.autoHideEnabled}`);
            }
        } else {
            Logger.debug(`【关闭弹窗】⚠️  输入值无效 (${inputVal})，跳过保存`);
        }

        $('#hide-helper-popup').hide();
        $('#hide-helper-backdrop').hide();
        closeEntryPopup(); // 条目详情子弹窗随主弹窗一并关闭
        closeChildStack(); // 主弹窗关闭 = **重置**：整轮层级结束
        $(window).off('resize.hideHelperMain');

        Logger.debug(`【关闭弹窗】✅ 弹窗已关闭`);
        Logger.debug('🚪🚪🚪【关闭弹窗】结束🚪🚪🚪');
        Logger.debug('');
    }

    $('#hide-helper-popup-close-icon').on('click', function() {
        Logger.debug('【事件】点击弹窗关闭图标');
        closePopup();
    });

    // 点击遮罩层关闭弹窗
    $('#hide-helper-backdrop').on('click', function() {
        Logger.debug('【事件】点击遮罩层');
        closePopup();
    });

    // 新增: ESC键快速关闭弹窗
    $(document).off('keydown.hideHelperEsc').on('keydown.hideHelperEsc', function(e) {
        if (e.key !== 'Escape') return;
        // 有子窗开着 → 只关**当前窗**（退一层，父窗留在屏幕上；第二十四轮的"父窗原位"模型下这才符合直觉）；
        // 没有子窗时才关主弹窗。
        if (currentChildId()) {
            Logger.debug('【事件】按下 ESC 键：关闭当前子窗（退回上一层）');
            popChildPopup();
            return;
        }
        if ($('#hide-helper-popup').is(':visible')) {
            Logger.debug('【事件】按下 ESC 键');
            closePopup();
        }
    });

    // --- 主题切换事件 ---
    $(document).on('click', '#hide-helper-theme-toggle', function() {
        const currentTheme = extension_settings[extensionName].theme || 'light';
        const newTheme = currentTheme === 'light' ? 'dark' : 'light';

        // 水波纹切换：从弹窗左下角扩散到右上角
        applyThemeWithRipple(newTheme, {
            afterFinish: () => {
                // 动画结束后重新渲染聊天统计，以更新行内的渐变色
                if ($('.tab-panel[data-tab="token-stats-panel"]').hasClass('active')) {
                    updateTokenStatsUI();
                }
            },
        });
    });

    // --- 功能启用/禁用开关（第三十六轮用户口径①）---
    // 三个复选框：隐藏楼层 / 限制楼层 / 聊天统计。勾上 = 功能可用且标签页可见；
    // 取消 = 隐藏标签页 + 停掉后台功能（写状态、同步限制楼层、必要时切页都在 setFeatureEnabled 里）。
    $(document).on('change', '#hh-feature-toggle-hide, #hh-feature-toggle-limiter, #hh-feature-toggle-stats', function() {
        const id = this.id || '';
        const key = id.replace('hh-feature-toggle-', '');
        if (!['hide', 'limiter', 'stats'].includes(key)) return;
        const on = $(this).is(':checked');
        Logger.debug(`【功能开关】${key} → ${on ? '启用' : '禁用'}`);
        setFeatureEnabled(key, on);
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
        extension_settings[extensionName].theme_notification_viewed = true;
        // 水波纹切换：以当前可见的提示弹窗左下角为圆心
        applyThemeWithRipple('dark', {
            afterFinish: () => {
                closeThemeNotification();

                // 实时重新渲染聊天统计
                if ($('.tab-panel[data-tab="token-stats-panel"]').hasClass('active')) {
                    updateTokenStatsUI();
                }
            },
        });
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

        const $logLevelWrapper = $('.log-level-selector-wrapper');
        const $downloadBtn = $('#hide-helper-download-log');

        if (isVisible) {
            $logLevelWrapper.slideDown(200);
            if (extension_settings[extensionName].logLevel === 3) {
                $downloadBtn.fadeIn(200);
                logEnvironmentDetails();
            }

            // 记录开启时间戳，用于跨会话的60分钟熔断检测
            extension_settings[extensionName].logUiOpenedAt = Date.now();
            saveSettingsDebounced();

            // 启动 60 分钟自动关闭熔断器
            clearTimeout(logUiAutoDisableTimer);
            logUiAutoDisableTimer = setTimeout(() => {
                disableLogUi();
            }, 60 * 60 * 1000); // 60分钟

        } else {
            // UI 关闭时，连带清理所有设置，防止后台吃性能
            $logLevelWrapper.slideUp(200);
            $downloadBtn.fadeOut(200);
            clearTimeout(logUiAutoDisableTimer);

            // 强制重置日志级别为 0 并清空内存
            extension_settings[extensionName].logLevel = 0;
            extension_settings[extensionName].logUiOpenedAt = null;
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
        const prevTab = $('.tab-button.active').data('tab');
        if (prevTab === targetTab) return; // 点当前页不重复动画
        if (prevTab === targetTab) return; // 点当前页不重复动画
        closeTypeFilterMenu(); // 切页时收起可能还开着的类型过滤菜单
        const tabOrder = ['hide-panel', 'limiter-panel', 'token-stats-panel', 'instructions-panel'];
        const forward = tabOrder.indexOf(targetTab) > tabOrder.indexOf(prevTab);
        const dirClass = forward ? 'hh-slide-left' : 'hh-slide-right';

        $('.tab-button').removeClass('active');
        $(this).addClass('active');
        $('.tab-panel').removeClass('active');
        const $panel = $(`.tab-panel[data-tab="${targetTab}"]`);
        // 重新触发滑入动画
        $panel.removeClass('hh-slide-left hh-slide-right');
        void $panel[0]?.offsetWidth;
        $panel.addClass('active ' + dirClass);

        updateTabIndicator(); // 滑动下划线跟随

        // 保存当前选择的标签页
        if (extension_settings[extensionName]) {
            extension_settings[extensionName].last_active_tab = targetTab;
            saveSettingsDebounced();
        }

        // 如果切换到聊天统计标签，直接渲染锚定数据（无副作用）
        if (targetTab === 'token-stats-panel') {
            updateTokenStatsUI();
        }

        // 面板内容切换极可能导致高度发生变化，重新计算定位确保依然完美居中
        centerPopup($('#hide-helper-popup'));

        // 离开聊天统计页时，条目详情子弹窗失去语境，一并关闭
        if (targetTab !== 'token-stats-panel') {
            closeEntryPopup(); // 离开统计页：条目详情失去语境
            closeChildStack(); // 重置：整轮层级结束（不是"退一层"）
        }
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
        const isEnabled = $(this).is(':checked');
        Logger.debug('');
        Logger.debug(`🔧【设置】自动隐藏功能开关: ${isEnabled ? 'ON' : 'OFF'}`);

        extension_settings[extensionName].autoHideEnabled = isEnabled;
        // 第三十六轮：本页这个开关与「使用说明 → 功能启用/禁用」里的「隐藏楼层」是**同一个状态**，
        // 必须同步（否则两处显示会互相打脸）。用 keepTab:true —— 用户正站在这页上配置，
        // 不该因为自己关掉开关就被弹出该页；标签按钮会藏起来，下次进弹窗就看不到它了。
        syncFeatureToggleUI('hide', isEnabled);
        saveSettingsDebounced();
        updateCurrentHideSettingsDisplay();

        if (isEnabled) {
            Logger.debug('🔧【设置】自动隐藏已启用，执行全量隐藏检查');
            runFullHideCheckDebounced();
        } else {
            Logger.debug('🔧【设置】自动隐藏已禁用');
            // 第三十七轮用户口径②：关掉后本页标签会消失 → 提示去哪里重新开启
            showFeatureDisabledHint('隐藏楼层');
        }
        Logger.debug('');
    });

    $('#hide-mode-toggle').on('change', function() {
        const newMode = $(this).is(':checked');
        Logger.debug('');
        Logger.debug(`🔧【设置】模式切换: ${newMode ? '全局模式' : '角色模式'}`);

        if (extension_settings[extensionName]) {
            if (!extension_settings[extensionName].globalHideSettings) {
                extension_settings[extensionName].globalHideSettings = { ...defaultSettings.globalHideSettings };
            }

            extension_settings[extensionName].useGlobalSettings = newMode;
            Logger.debug(`🔧【设置】useGlobalSettings 已更新为: ${newMode}`);
            saveSettingsDebounced();
            updateCurrentHideSettingsDisplay();
            Logger.debug('🔧【设置】执行全量隐藏检查以应用新模式');
            runFullHideCheckDebounced();
            toastr.info(`已切换隐藏范围至${newMode ? '全局' : '角色'}模式`);
        }
        Logger.debug('');
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

                // 第三十六轮：与「使用说明 → 功能启用/禁用」里的「限制楼层」是**同一个状态**，必须同步。
                // keepTab:true —— 用户正站在这页上操作，不该因为关掉就被弹走。
                syncFeatureToggleUI('limiter', isEnabled);

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

                // 第三十七轮用户口径②：关掉后本页标签会消失 → 提示去哪里重新开启
                // （放在 updateCurrentHideSettingsDisplay 之后：先让页内的"已禁用"占位文案就位，再弹提示）
                if (!isEnabled) showFeatureDisabledHint('限制楼层');
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
        Logger.debug('');
        Logger.debug('📢【事件】CHAT_CHANGED - 聊天已切换');
        cachedContext = null; // 清理缓存
        lastScanEntries = [];
        lockedScanEntries = [];
        statsClearedAt = Date.now(); // 统计判废时间戳（锚定数据本身随消息存储，无需清理）
        pendingGenType = null; // 切聊天时清空待匹配的生成类型
        statsPinnedIndex = null; // 重置统计页锚点浏览/对比状态
        statsBaselineIndex = null;
        statsCompareIndex = null;
        statsViewMode = 'detail';
        statsListSortMode = 'default';
        statsListTypeFilter = 'all';
        statsCmpBookFilter = 'all';
        statsCmpTypeFilter = 'all';
        simulateAnchor = null; // 切换聊天丢弃模拟发送的临时结果
        simulateInProgress = false;
        simulateChatId = null;
        simulateContent = '';
        // 完整上下文快照：**不再"切聊天即清空"** —— store 以 `${chatId}|${anchorId}` 为键，切回来还在
        //（第二十六轮：开发期免"重新生成消息"，另见 saveContextDump / loadPersistedContextDumps 的持久副本）
        pendingReplyAnchor = null; // 挂起中的 normal 锚定也不跨聊天
        closeEntryPopup(); // 条目详情子弹窗跟随主弹窗数据，切聊天即关闭
        closeChatStatsPopup(); // 「聊天」统计子弹窗同理
        ctxDump = null; // 完整上下文（目录 + 内容）渲染的是原聊天的快照：切聊天即失效（随 closeChildStack 收起）
        ctxMsgByIndex = new Map();
        wiMsgPopupIndex = null;
        wiMsgPopupMsg = null;
        closeChildStack(); // 切聊天 = **重置**：整轮层级结束（不是"退一层"）

        updateCurrentHideSettingsDisplay(); // 更新所有UI
        updateTokenStatsUI(); // 统计页若开着，立即切换为新聊天的锚定数据

        if (extension_settings[extensionName]?.enabled) {
            Logger.debug('📢【事件】插件已启用，立即执行全量隐藏检查');
            runFullHideCheck(); // 立即执行，非防抖，确保数据最新
        } else {
            Logger.debug('📢【事件】插件未启用，跳过隐藏检查');
        }
        Logger.debug('');
    });

    const handleNewMessage = (eventType) => {
        const context = getContextOptimized();
        const chatLength = context?.chat?.length || 0;
        Logger.debug('');
        Logger.debug(`📨【事件】${eventType} - 新消息事件`);
        Logger.debug(`📨【事件】   当前聊天长度: ${chatLength}`);

        if (extension_settings[extensionName]?.enabled) {
            Logger.debug('📨【事件】插件已启用，100ms 后执行增量隐藏检查');
            setTimeout(() => runIncrementalHideCheck(), 100);
        } else {
            Logger.debug('📨【事件】插件未启用，跳过隐藏检查');
        }
        Logger.debug('');
    };
    eventSource.on(event_types.MESSAGE_RECEIVED, () => handleNewMessage(event_types.MESSAGE_RECEIVED));
    eventSource.on(event_types.MESSAGE_SENT, () => handleNewMessage(event_types.MESSAGE_SENT));

    eventSource.on(event_types.MESSAGE_DELETED, () => {
        Logger.debug('');
        Logger.debug('🗑️【事件】MESSAGE_DELETED - 消息已删除');
        if (extension_settings[extensionName]?.enabled) {
            Logger.debug('🗑️【事件】插件已启用，执行全量隐藏检查');
            runFullHideCheckDebounced();
        } else {
            Logger.debug('🗑️【事件】插件未启用，跳过隐藏检查');
        }
        Logger.debug('');
    });

    // 生成结束事件，确保最终一致性
    const streamEndEvent = event_types.GENERATION_ENDED;
    eventSource.on(streamEndEvent, () => {
        Logger.debug('');
        Logger.debug('🏁【事件】GENERATION_ENDED - 生成已结束');
        // 运行一个完整的检查来纠正任何增量更新中可能出现的问题
        if (extension_settings[extensionName]?.enabled) {
            Logger.debug('🏁【事件】插件已启用，执行全量隐藏检查确保一致性');
            runFullHideCheckDebounced();
        } else {
            Logger.debug('🏁【事件】插件未启用，跳过隐藏检查');
        }
        Logger.debug('');
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
        // 1. 加载设置并触发迁移检查
        loadSettings();
        // 1.5 恢复持久化的「完整上下文」快照（第二十六轮：改完 CSS 刷新页面后可直接复看，不用重新生成消息）
        loadPersistedContextDumps();
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

        // 检测日志UI是否超过60分钟熔断时限（跨会话强制关闭）
        if (settings.logUiVisible) {
            const LOG_UI_TIMEOUT = 60 * 60 * 1000;
            if (!settings.logUiOpenedAt) {
                // 旧版本升级：logUiOpenedAt 缺失，无法确认开启时间，强制关闭
                Logger.warn('日志UI开启时间戳缺失（旧版本升级），初始化时强制关闭');
                disableLogUi();
            } else if (Date.now() - settings.logUiOpenedAt >= LOG_UI_TIMEOUT) {
                Logger.warn('日志UI已超过60分钟熔断时限，初始化时强制关闭');
                disableLogUi();
            }
        }

        Logger.debug('初始设置: 更新当前隐藏设置显示');
        updateCurrentHideSettingsDisplay();

        // 4. 初始加载时执行全量检查 (如果插件启用且当前实体有用户配置)
        if (extension_settings[extensionName]?.enabled) {
            Logger.debug('🎬【初始化】插件已启用，检查是否需要初始全量检查');
            const initialSettings = getCurrentHideSettings();
            Logger.debug('🎬【初始化】当前实体的初始设置:', initialSettings);
            if(initialSettings?.userConfigured === true) {
                Logger.debug('🎬【初始化】✅ 找到用户配置设置 (N=' + initialSettings.hideLastN + ')，运行初始全量隐藏检查');
                runFullHideCheck(); // 直接运行，非防抖
            } else {
                Logger.debug('🎬【初始化】⛔ 未找到用户配置设置 (userConfigured=false)，跳过初始全量检查');
                Logger.debug('🎬【初始化】💡 提示：请在弹窗中设置"保留楼层数 N"以启用自动隐藏功能');
            }
        } else {
            Logger.debug('🎬【初始化】⛔ 插件已禁用，跳过初始全量检查');
        }
        Logger.debug('🎬【初始化】✨ 初始设置任务完成');
        Logger.debug('');
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

    const originalLength = chat.length;
    const targetLength = hideSettings.hideLastN;

    if (originalLength > targetLength) {
        const removedCount = originalLength - targetLength;
        Logger.warn('');
        Logger.warn('🛡️【请求拦截】触发兜底保护机制');
        Logger.warn(`🛡️【请求拦截】⚠️ 检测到 chat 数组长度 (${originalLength}) 超过保留值 (${targetLength})`);
        Logger.warn(`🛡️【请求拦截】🔪 强制移除前 ${removedCount} 条消息，确保只发送最新 ${targetLength} 条`);

        while (chat.length > targetLength) {
            chat.shift();
        }

        Logger.warn(`🛡️【请求拦截】✅ 拦截完成，chat 数组已从 ${originalLength} 截断至 ${chat.length}`);
        Logger.warn(`🛡️【请求拦截】💡 这说明前面的隐藏机制可能失效，此拦截作为最后一道防线`);
        Logger.warn('');
    }
};
