import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types, characters, this_chid } from "../../../../script.js";
import { Popup, POPUP_TYPE } from '../../../popup.js';
import { loadWorldInfo, saveWorldInfo, world_info, world_names, displayWorldEntries, createWorldInfoEntry, getFreeWorldEntryUid, newWorldInfoEntryTemplate, deleteWorldInfoEntry, getWorldEntry, setWIOriginalDataValue, deleteWIOriginalDataValue, originalWIDataKeyMap, sortWorldInfoEntries, worldInfoFilter } from "../../../world-info.js"; // 导入大量 WI 函数
import { parseJsonFile, download, getSanitizedFilename, debounce, showLoader, hideLoader } from "../../../utils.js";
import { t } from "../../../i18n.js"; // 导入翻译函数

const extensionName = "wi-entry-importer-exporter"; // 插件文件夹名称
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
const extensionSettings = extension_settings[extensionName];
const defaultSettings = {}; // 可以添加设置，例如默认导出文件名格式等

// 用于存储当前书籍选中的 UID
const selectedEntryUIDs = new Set();
let currentBookName = null; // 当前编辑器加载的书籍名称

async function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    Object.assign(extension_settings[extensionName], { ...defaultSettings, ...extension_settings[extensionName] });
    // console.log(`${extensionName} settings loaded:`, extensionSettings);
}

// -- 核心功能 --

/**
 * 处理导入按钮点击
 */
function handleImportClick() {
    if (!currentBookName) {
        toastr.warning(t("请先在编辑器中加载一个 World Info 文件。"));
        return;
    }
    // 触发隐藏的文件输入
    $('#wi_import_file_input').trigger('click');
}

/**
 * 处理文件选择和导入逻辑
 * @param {Event} event
 */
async function handleFileSelected(event) {
    const file = event.target.files[0];
    if (!file) {
        return;
    }
    // 清空文件输入，以便可以再次选择同一个文件
    event.target.value = '';

    if (!currentBookName) {
        toastr.error(t("无法确定要导入到的 World Info 文件。"));
        return;
    }

    showLoader(t("正在导入条目..."));

    try {
        const importedEntries = await parseJsonFile(file);

        if (!Array.isArray(importedEntries)) {
            throw new Error(t("文件格式无效，需要包含一个 JSON 数组。"));
        }
        if (importedEntries.length === 0) {
            toastr.info(t("导入的文件不包含任何条目。"));
            hideLoader();
            return;
        }

        console.log(`[${extensionName}] Importing ${importedEntries.length} entries into '${currentBookName}'`);

        // 加载目标 WI Book 数据
        const targetBookData = await loadWorldInfo(currentBookName);
        if (!targetBookData || !targetBookData.entries) {
            throw new Error(t("无法加载目标 World Info 文件数据: ") + currentBookName);
        }

        let importCount = 0;
        for (const importedEntryData of importedEntries) {
            if (typeof importedEntryData !== 'object' || importedEntryData === null) {
                console.warn(`[${extensionName}] Skipping invalid entry data:`, importedEntryData);
                continue;
            }

            // 1. 创建新条目 (获取新 UID)
            const newEntry = createWorldInfoEntry(currentBookName, targetBookData);
            if (!newEntry) {
                console.error(`[${extensionName}] Failed to create new entry slot in '${currentBookName}'`);
                continue; // 跳过这个条目
            }

            // 2. 复制数据 (排除 uid)
            // 遍历 newWorldInfoEntryTemplate 中的所有键，以及 'extensions' (如果存在)
            const keysToCopy = [...Object.keys(newWorldInfoEntryTemplate), 'extensions'];
            for (const key of keysToCopy) {
                if (key === 'uid') continue; // 绝不复制 UID

                if (importedEntryData.hasOwnProperty(key)) {
                    // 深拷贝复杂对象/数组，以防万一
                    if (typeof importedEntryData[key] === 'object' && importedEntryData[key] !== null) {
                        newEntry[key] = structuredClone(importedEntryData[key]);
                    } else {
                        newEntry[key] = importedEntryData[key];
                    }
                }
                // else: 如果导入的数据中没有该字段，则保留新条目的默认值
            }

            // 特殊处理：确保导入条目的 displayIndex 不会过于离谱 (可选，但建议)
            // 如果不设置，它会是新UID；如果设置了，可能需要重新计算或保持原样
            // 这里我们选择保留导入的值（如果存在）
            if (importedEntryData.hasOwnProperty('displayIndex')) {
                 newEntry.displayIndex = importedEntryData.displayIndex;
            } else {
                 // 如果导入数据没有 displayIndex，可以考虑设置为新 UID 或其他默认值
                 newEntry.displayIndex = newEntry.uid;
            }


            // 3. 更新 originalData (如果存在)
            // 这一步是为了 Character Book v2 导出兼容性，需要将新条目的数据写入
            if (targetBookData.originalData && Array.isArray(targetBookData.originalData.entries)) {
                 // 需要找到原始数据中对应的条目（刚创建时可能还没有），或者添加一个新的
                 // 最简单的方法是：保存前重新生成 originalData？或者手动添加
                 // 为了简化，我们假设 saveWorldInfo 会处理 originalData 的同步，
                 // 或者，我们在这里手动设置每个字段的 originalData 值：
                 for (const [templateKey, originalKey] of Object.entries(originalWIDataKeyMap)) {
                     if (newEntry.hasOwnProperty(templateKey)) {
                         setWIOriginalDataValue(targetBookData, newEntry.uid, originalKey, newEntry[templateKey]);
                     }
                 }
                 // 注意：setWIOriginalDataValue 可能需要调整以处理新创建的条目
                 // 一个更稳妥（但可能效率较低）的方法是在导入循环 *之后*，保存 *之前*，
                 // 完全基于当前的 targetBookData.entries 重新构建 targetBookData.originalData
            }


            console.log(`[${extensionName}] Imported entry data into new entry UID: ${newEntry.uid}`);
            importCount++;
        }

        // 4. 保存 World Info
        await saveWorldInfo(currentBookName, targetBookData, true); // 立即保存

        // 5. 刷新编辑器
        // 获取 displayWorldEntries 内部的 updateEditor 函数引用来刷新
        // (这是一个技巧，需要确保 displayWorldEntries 已经被调用过一次以设置 updateEditor)
        // 更好的方法是直接再次调用 displayWorldEntries 加载数据
        const updatedData = await loadWorldInfo(currentBookName); // 重新加载以获取最新状态
        displayWorldEntries(currentBookName, updatedData, 'previous'); // 使用 'previous' 或 'none' 导航选项刷新

        toastr.success(t("成功导入 {count} 个条目到 '{bookName}'。", { count: importCount, bookName: currentBookName }));

    } catch (error) {
        console.error(`[${extensionName}] Error importing entries:`, error);
        toastr.error(t("导入条目时出错: ") + error.message);
    } finally {
        hideLoader();
    }
}

/**
 * 处理导出按钮点击
 */
async function handleExportClick() {
    if (selectedEntryUIDs.size === 0) {
        toastr.info(t("请先选择要导出的条目。"));
        return;
    }
    if (!currentBookName) {
        toastr.error(t("无法确定当前编辑的 World Info 文件。"));
        return;
    }

    showLoader(t("正在导出条目..."));

    try {
        // 加载当前 WI Book 数据
        const currentBookData = await loadWorldInfo(currentBookName);
        if (!currentBookData || !currentBookData.entries) {
            throw new Error(t("无法加载当前 World Info 文件数据: ") + currentBookName);
        }

        const entriesToExport = [];
        for (const uid of selectedEntryUIDs) {
            const entry = currentBookData.entries[uid];
            if (entry) {
                // 创建条目的深拷贝以供导出
                const entryCopy = structuredClone(entry);
                // 可以选择性地移除一些运行时可能不需要的内部字段（如果存在）
                // delete entryCopy._someInternalField;
                entriesToExport.push(entryCopy);
            } else {
                console.warn(`[${extensionName}] Selected entry UID ${uid} not found in current book data.`);
            }
        }

        if (entriesToExport.length === 0) {
            toastr.warning(t("没有找到选中的有效条目进行导出。"));
            hideLoader();
            return;
        }

        // 生成文件名
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `${getSanitizedFilename(currentBookName)}_entries_${timestamp}.json`;

        // 创建 JSON 数据并下载
        const jsonData = JSON.stringify(entriesToExport, null, 4); // pretty print JSON
        download(jsonData, filename, 'application/json');

        console.log(`[${extensionName}] Exported ${entriesToExport.length} entries to ${filename}`);
        toastr.success(t("成功导出 {count} 个条目。", { count: entriesToExport.length }));

    } catch (error) {
        console.error(`[${extensionName}] Error exporting entries:`, error);
        toastr.error(t("导出条目时出错: ") + error.message);
    } finally {
        hideLoader();
    }
}


/**
 * 处理单个复选框状态变化
 * @param {Event} event
 */
function handleCheckboxChange(event) {
    const checkbox = $(event.target);
    const uid = parseInt(checkbox.data('uid'));
    if (isNaN(uid)) return;

    if (checkbox.prop('checked')) {
        selectedEntryUIDs.add(uid);
    } else {
        selectedEntryUIDs.delete(uid);
    }
    // console.log('Selected UIDs:', Array.from(selectedEntryUIDs));
    updateSelectAllCheckboxState(); // 更新全选复选框状态
}

/**
 * 处理全选复选框状态变化
 * @param {Event} event
 */
function handleSelectAllChange(event) {
    const isChecked = $(event.target).prop('checked');
    // 获取当前页面所有可见条目的复选框
    $('#world_popup_entries_list .wi-entry-export-checkbox').each((index, element) => {
        const checkbox = $(element);
        const uid = parseInt(checkbox.data('uid'));
        if (isNaN(uid)) return;

        checkbox.prop('checked', isChecked); // 同步状态
        if (isChecked) {
            selectedEntryUIDs.add(uid);
        } else {
            selectedEntryUIDs.delete(uid);
        }
    });
    // console.log('Selected UIDs after Select All:', Array.from(selectedEntryUIDs));
}

/**
 * 更新全选复选框的状态（半选或全选）
 */
function updateSelectAllCheckboxState() {
     const selectAllCheckbox = $('#wi_select_all_checkbox');
     if (!selectAllCheckbox.length) return;

     const visibleCheckboxes = $('#world_popup_entries_list .wi-entry-export-checkbox');
     const totalVisible = visibleCheckboxes.length;
     if (totalVisible === 0) {
         selectAllCheckbox.prop('checked', false);
         selectAllCheckbox.prop('indeterminate', false);
         return;
     }

     let checkedCount = 0;
     visibleCheckboxes.each((index, element) => {
         if ($(element).prop('checked')) {
             checkedCount++;
         }
     });

     if (checkedCount === 0) {
         selectAllCheckbox.prop('checked', false);
         selectAllCheckbox.prop('indeterminate', false);
     } else if (checkedCount === totalVisible) {
         selectAllCheckbox.prop('checked', true);
         selectAllCheckbox.prop('indeterminate', false);
     } else {
         selectAllCheckbox.prop('checked', false); // 或者 true，取决于你希望半选状态时主复选框的行为
         selectAllCheckbox.prop('indeterminate', true);
     }
}


// -- UI 修改与注入 --

/**
 * 向 World Info 编辑器添加批量操作控件
 */
function addControlsToEditor() {
    // 防止重复添加
    if ($('#wi_batch_controls').length > 0) {
        return;
    }

    const controlsHtml = `
        <div id="wi_batch_controls" class="wi-batch-controls">
            <label class="select-all-label" title="${t('全选/取消全选当前页条目')}">
                <input type="checkbox" id="wi_select_all_checkbox" />
                <span>${t('全选')}</span>
            </label>
            <button id="wi_export_selected_button" class="menu_button ui-button ui-widget ui-state-default ui-corner-all ui-button-text-only" title="${t('导出选中的条目')}">
                <span class="ui-button-text">${t('导出选中')}</span>
            </button>
            <button id="wi_import_entries_button" class="menu_button ui-button ui-widget ui-state-default ui-corner-all ui-button-text-only" title="${t('导入条目到当前书籍')}">
                <span class="ui-button-text">${t('导入条目')}</span>
            </button>
            <input type="file" id="wi_import_file_input" accept=".json" />
        </div>
    `;

    // 将控件添加到分页控件的下方
    $(controlsHtml).insertAfter('#world_info_pagination');

    // 绑定事件
    $('#wi_export_selected_button').on('click', handleExportClick);
    $('#wi_import_entries_button').on('click', handleImportClick);
    $('#wi_import_file_input').on('change', handleFileSelected);
    $('#wi_select_all_checkbox').on('change', handleSelectAllChange);
}

/**
 * 向单个条目元素添加复选框
 * @param {JQuery<HTMLElement>} entryElement - 条目的 JQuery 元素
 * @param {object} entryData - 条目的数据
 */
function addCheckboxToEntry(entryElement, entryData) {
    const uid = entryData.uid;
    // 检查是否已存在复选框
    if (entryElement.find(`.wi-entry-export-checkbox[data-uid="${uid}"]`).length > 0) {
        return;
    }

    const isChecked = selectedEntryUIDs.has(uid);
    const checkboxHtml = `<input type="checkbox" class="wi-entry-export-checkbox" data-uid="${uid}" ${isChecked ? 'checked' : ''} title="${t('选择此条目进行导出')}">`;

    // 将复选框添加到条目标题行的最前面
    entryElement.find('.world_entry_header > .flex-container').first().prepend(checkboxHtml);

    // 绑定事件
    entryElement.find(`.wi-entry-export-checkbox[data-uid="${uid}"]`).on('change', handleCheckboxChange);
}

// -- 监听与初始化 --

// 使用 MutationObserver 监控条目列表的变化，以便在条目被添加/删除/重新排序时添加复选框
// 或者，更简单的方式是：在 displayWorldEntries 的 callback 中处理
let originalDisplayWorldEntriesCallback = null;

function enhanceDisplayWorldEntries() {
    // Monkey-patching displayWorldEntries 并不理想，因为它依赖内部实现。
    // 更好的方法是利用 pagination 的回调函数。

    // 监听分页控件的 afterPaging 事件，此时 DOM 已更新
    $('#world_info_pagination').on('jqPagination.afterPaging', () => {
        // console.log('Pagination afterPaging triggered');
        $('#world_popup_entries_list .world_entry').each((index, element) => {
            const entryElement = $(element);
            const uid = entryElement.data('uid');
            // 需要从当前加载的数据中找到对应的 entryData，这有点麻烦
            // 或者，可以直接在添加元素时就加上复选框

            // 我们尝试在 displayWorldEntries 的 callback 里做
        });
        updateSelectAllCheckboxState(); // 页面切换后更新全选状态
    });


    // 修改 pagination 的 callback 来注入复选框
    const paginationInstance = $('#world_info_pagination').data('jqPagination');
    if (paginationInstance && paginationInstance.settings && paginationInstance.settings.callback) {
        originalDisplayWorldEntriesCallback = paginationInstance.settings.callback;

        paginationInstance.settings.callback = async (pageData) => {
            // 先调用原始的回调来渲染条目
            if (typeof originalDisplayWorldEntriesCallback === 'function') {
                await originalDisplayWorldEntriesCallback(pageData);
            }

            // 原始回调执行完后，条目 DOM 应该已经生成
            // 此时为每个条目添加复选框
            $('#world_popup_entries_list .world_entry').each((index, element) => {
                const entryElement = $(element);
                const uid = entryElement.data('uid');

                // 找到对应的 entryData (pageData 是当前页的数据)
                const entryData = pageData.find(entry => entry.uid === uid);
                if (entryData) {
                    addCheckboxToEntry(entryElement, entryData);
                } else {
                     console.warn(`Could not find entry data for UID ${uid} in paged data.`);
                }
            });
             updateSelectAllCheckboxState(); // 渲染完后更新全选状态
        };
    } else {
         console.warn(`[${extensionName}] Could not find pagination callback to enhance.`);
         // 备用方案：使用 MutationObserver (更复杂)
    }


}


jQuery(async () => {
    await loadSettings();

    // 监听编辑器选择变化，更新当前书名并清空选中状态
    $('#world_editor_select').on('change', async () => {
        const selectedIndex = String($('#world_editor_select').find(':selected').val());
        selectedEntryUIDs.clear(); // 切换书籍时清空选择

        if (selectedIndex !== '' && world_names[selectedIndex]) {
            currentBookName = world_names[selectedIndex];
            addControlsToEditor(); // 确保控件已添加
            enhanceDisplayWorldEntries(); // 确保分页回调被增强
            updateSelectAllCheckboxState(); // 更新（此时应为未选）
        } else {
            currentBookName = null;
            $('#wi_batch_controls').remove(); // 如果没有书籍加载，移除控件
        }
        console.log(`[${extensionName}] Switched to book: ${currentBookName}`);
    });

    // 初始化时，如果已有书籍被选中，则触发一次 change 来设置状态
    if ($('#world_editor_select').val() !== '') {
        $('#world_editor_select').trigger('change');
    }

    console.log(`[${extensionName}] Extension loaded.`);
});
