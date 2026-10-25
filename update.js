// update.js - 自动检测更新功能模块
import Logger from "./Logger.js";
import { getRequestHeaders } from '../../../../script.js';

// 远程仓库配置 - 需要根据实际仓库地址修改
const REPO_ROOT = "https://raw.githubusercontent.com/uhhhh15/hide/main";
const MANIFEST_URL = `${REPO_ROOT}/manifest.json`;
const CHANGELOG_URL = `${REPO_ROOT}/CHANGELOG.md`;

const extensionName = "hide";
const KEY_LAST_CHECK = `${extensionName}_last_update_check`;
const KEY_UPDATE_INFO = `${extensionName}_update_info`;

/**
 * 异步获取本地插件版本
 */
async function getLocalVersion() {
    try {
        // 1. 调用后端 API 发现所有插件
        const discoverResponse = await fetch('/api/extensions/discover');
        if (!discoverResponse.ok) return "Error (API)";

        const installedExtensions = await discoverResponse.json();

        // 2. 并发读取 manifest
        const manifestPromises = installedExtensions.map(async (ext) => {
            try {
                const res = await fetch(`/scripts/extensions/${ext.name}/manifest.json`);
                if (res.ok) {
                    const json = await res.json();
                    return {
                        manifest: json,
                        folderPath: ext.name
                    };
                }
            } catch (e) {}
            return null;
        });

        const results = await Promise.all(manifestPromises);
        const validResults = results.filter(r => r !== null);

        // 3. 匹配逻辑
        const target = validResults.find(item => {
            const m = item.manifest;
            const folder = item.folderPath;

            if (m.display_name === "隐藏助手") return true;

            // 只要路径以 /hide 结尾，或者就是 hide
            if (folder === "hide" || folder.endsWith("/hide") || folder.endsWith("/hide-extension")) {
                return true;
            }

            return false;
        });

        if (target) {
            Logger.info(`发现本地插件: ${target.folderPath}, 版本: ${target.manifest.version}`);
            return target.manifest.version || "No Version";
        }

        return "Unknown";

    } catch (error) {
        Logger.error('本地版本检查失败:', error);
        return "Error";
    }
}

/**
 * 版本比较函数
 * @param {string} v1 - 版本1
 * @param {string} v2 - 版本2
 * @returns {number} 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 */
function compareVersions(v1, v2) {
    if (!v1 || !v2) return 0;
    const p1 = v1.replace(/^v/, '').split('.').map(Number);
    const p2 = v2.replace(/^v/, '').split('.').map(Number);
    const len = Math.max(p1.length, p2.length);
    for (let i = 0; i < len; i++) {
        const n1 = p1[i] || 0;
        const n2 = p2[i] || 0;
        if (n1 > n2) return 1;
        if (n1 < n2) return -1;
    }
    return 0;
}

/**
 * 获取远程版本
 */
async function getRemoteVersion() {
    try {
        const response = await fetch(MANIFEST_URL + `?t=${Date.now()}`);
        if (!response.ok) return null;
        const data = await response.json();
        return data.version;
    } catch (error) {
        Logger.error('获取远程版本失败:', error);
        return null;
    }
}

/**
 * 检查更新
 * @param {boolean} force - 是否强制检查（忽略缓存）
 * @returns {Promise<Object>} 更新信息对象
 */
export async function checkForUpdates(force = false) {
    const now = Date.now();
    const lastCheck = localStorage.getItem(KEY_LAST_CHECK);

    // 1. 每次都实时获取本地版本
    const localVer = await getLocalVersion();

    let remoteVer = null;
    let usedCache = false;

    // 2. 尝试获取远程版本
    // 如果不是强制刷新，且缓存未过期(24h)，则尝试从缓存中提取远程版本号
    if (!force && lastCheck && (now - parseInt(lastCheck) < 86400000)) {
        const cachedStr = localStorage.getItem(KEY_UPDATE_INFO);
        if (cachedStr) {
            try {
                const cachedObj = JSON.parse(cachedStr);
                if (cachedObj && cachedObj.latestVersion && cachedObj.latestVersion !== "Check Failed") {
                    remoteVer = cachedObj.latestVersion;
                    usedCache = true;
                }
            } catch (e) {
                // JSON 解析失败，忽略缓存
            }
        }
    }

    // 3. 如果没有命中缓存（或强制刷新），则请求 GitHub
    if (!remoteVer) {
        remoteVer = await getRemoteVersion();

        // 只有成功获取到远程版本才更新时间戳
        if (remoteVer) {
            localStorage.setItem(KEY_LAST_CHECK, now.toString());
        }
    }

    // 4. 实时进行版本比对
    const hasUpdate = (remoteVer && localVer !== "Unknown" && localVer !== "Error")
        ? compareVersions(remoteVer, localVer) > 0
        : false;

    // 构建结果对象
    const result = {
        hasUpdate: hasUpdate,
        latestVersion: remoteVer || "Check Failed",
        localVersion: localVer,
        checkedAt: usedCache ? parseInt(lastCheck || now) : now
    };

    // 5. 更新缓存内容
    if (remoteVer) {
        localStorage.setItem(KEY_UPDATE_INFO, JSON.stringify(result));
    }

    return result;
}

/**
 * 获取更新日志
 */
export async function getChangelog() {
    try {
        const response = await fetch(CHANGELOG_URL + `?t=${Date.now()}`);
        return await response.text();
    } catch (e) {
        Logger.error('获取更新日志失败:', e);
        return "无法获取更新日志。";
    }
}

/**
 * 执行更新
 */
export async function performUpdate() {
    try {
        // 重新执行查找逻辑以获取准确的 folderPath
        const discoverResponse = await fetch('/api/extensions/discover');
        const extensions = await discoverResponse.json();
        let targetFolder = null;
        let isGlobal = false;

        // 简单的遍历查找
        for (const ext of extensions) {
            try {
                const res = await fetch(`/scripts/extensions/${ext.name}/manifest.json`);
                if (res.ok) {
                    const m = await res.json();
                    // 同样的匹配逻辑
                    if (m.display_name === "隐藏助手" ||
                        ext.name.endsWith("/hide") ||
                        ext.name === "hide") {
                        targetFolder = ext.name; // 这里会是 "third-party/QR"
                        isGlobal = ext.type === 'global'; // 捕获扩展类型
                        break;
                    }
                }
            } catch(e) {}
        }

        if (!targetFolder) {
            Logger.error('未找到扩展文件夹，无法更新');
            return { ok: false };
        }

        Logger.info(`正在更新扩展: ${targetFolder}`);

        // 后端 API 需要剥离 "third-party/" 前缀的短名称，并显式传递 global 参数
        const shortName = targetFolder.replace(/^third-party\//, '');

        // 使用 getRequestHeaders() 替代手动拼凑
        // getRequestHeaders() 会自动返回 { 'Content-Type': 'application/json', 'X-CSRF-Token': '...' }
        return await fetch('/api/extensions/update', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                extensionName: shortName,
                global: isGlobal
            })
        });
    } catch (e) {
        Logger.error('更新失败:', e);
        return { ok: false };
    }
}

/**
 * 初始化更新检测（在页面加载时自动调用）
 */
export async function initUpdateCheck() {
    try {
        const updateInfo = await checkForUpdates(false);

        if (updateInfo.hasUpdate) {
            Logger.info(`发现新版本: ${updateInfo.localVersion} -> ${updateInfo.latestVersion}`);
            // 可以在这里显示通知或标记UI
            return updateInfo;
        } else {
            Logger.debug('当前已是最新版本');
            return updateInfo;
        }
    } catch (e) {
        Logger.error('初始化更新检测失败:', e);
        return null;
    }
}
