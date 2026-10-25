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

// 日志级别定义
const LogLevel = {
    NONE: 0,      // 零日志 - 无任何输出
    CORE: 1,      // 核心日志 - error + warn
    RUNTIME: 2,   // 运行日志 - error + warn + info + success
    FULL: 3       // 完整日志 - 所有日志包括 debug
};

class Logger {
    // 当前日志级别（默认为零日志）
    static currentLevel = LogLevel.NONE;
    // 日志历史记录数组，用于导出
    static logHistory = [];

    // 将日志推送到内存中（严格限制：仅在完整日志级别3时才执行，保障性能）
    static pushToHistory(levelName, ...args) {
        if (this.currentLevel !== LogLevel.FULL) return;

        const timestamp = new Date().toLocaleString('zh-CN', { hour12: false });
        const message = args.map(arg => {
            if (typeof arg === 'object') {
                try {
                    return JSON.stringify(arg, (key, value) => {
                        if (key === 'parent' || key === 'dom' || key === 'collection') return '[已省略嵌套对象]';
                        return value;
                    });
                } catch(e) { return '[复杂对象/解析失败]'; }
            }
            return String(arg);
        }).join(' ');

        this.logHistory.push(`[${timestamp}] [${levelName}] ${message}`);

        // 限制内存中最多保存最近 500 条日志
        if (this.logHistory.length > 500) {
            this.logHistory.shift();
        }
    }

    // 导出并下载日志
    static exportLogs() {
        if (this.logHistory.length === 0) return false;
        const blob = new Blob([this.logHistory.join('\n')], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `HideHelper_DebugLog_${new Date().getTime()}.log`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        return true;
    }

    // 设置日志级别
    static setLogLevel(level) {
        if (level in LogLevel) {
            this.currentLevel = LogLevel[level];
        } else if (typeof level === 'number' && level >= 0 && level <= 3) {
            this.currentLevel = level;
        }
    }

    // 获取日志级别
    static getLogLevel() {
        return this.currentLevel;
    }

    // 检查是否应该输出日志
    static shouldLog(level) {
        return this.currentLevel >= level;
    }

    // 错误提示（级别 1 - 核心日志）
    static error(...args) {
        this.pushToHistory('ERROR', ...args);
        if (this.shouldLog(LogLevel.CORE)) console.error(PREFIX, STYLES.error, ...args);
    }

    // 警告提示（级别 1 - 核心日志）
    static warn(...args) {
        this.pushToHistory('WARN', ...args);
        if (this.shouldLog(LogLevel.CORE)) console.warn(PREFIX, STYLES.warn, ...args);
    }

    // 基础信息（级别 2 - 运行日志）
    static info(...args) {
        this.pushToHistory('INFO', ...args);
        if (this.shouldLog(LogLevel.RUNTIME)) console.log(PREFIX, STYLES.info, ...args);
    }

    // 成功提示（级别 2 - 运行日志）
    static success(...args) {
        this.pushToHistory('SUCCESS', ...args);
        if (this.shouldLog(LogLevel.RUNTIME)) console.log(PREFIX, STYLES.success, ...args);
    }

    // 调试信息（级别 3 - 完整日志）
    static debug(...args) {
        this.pushToHistory('DEBUG', ...args);
        if (this.shouldLog(LogLevel.FULL)) console.debug(PREFIX, STYLES.debug, ...args);
    }
}

// 导出日志级别常量，供外部使用
Logger.LogLevel = LogLevel;

export default Logger;
