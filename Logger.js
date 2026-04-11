// Logger.js
const PREFIX = '%c[隐藏助手]';
const BASE_STYLE = 'font-weight: bold; padding: 2px 4px; border-radius: 3px; margin-right: 4px;';

const STYLES = {
    info:    `${BASE_STYLE} color: white; background-color: #17a2b8;`, // 蓝色 - 普通信息
    success: `${BASE_STYLE} color: white; background-color: #28a745;`, // 绿色 - 成功操作
    warn:    `${BASE_STYLE} color: #333; background-color: #ffc107;`,  // 橙黄 - 警告
    error:   `${BASE_STYLE} color: white; background-color: #dc3545;`, // 红色 - 错误
    debug:   `${BASE_STYLE} color: #6c757d; background-color: #f8f9fa; border: 1px solid #dee2e6;` // 灰色 - 调试
};

class Logger {
    // 基础信息
    static info(...args) { console.log(PREFIX, STYLES.info, ...args); }
    // 成功提示
    static success(...args) { console.log(PREFIX, STYLES.success, ...args); }
    // 警告提示
    static warn(...args) { console.warn(PREFIX, STYLES.warn, ...args); }
    // 错误提示
    static error(...args) { console.error(PREFIX, STYLES.error, ...args); }
    // 调试信息（默认静默，需在控制台输入 window.HideHelperDebug = true 开启）
    static debug(...args) {
        if (window.HideHelperDebug) {
            console.debug(PREFIX, STYLES.debug, ...args);
        }
    }
}

export default Logger;
