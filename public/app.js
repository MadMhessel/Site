// --- УТИЛИТЫ ---
/**
 * Парсит CSV строку в JSON массив объектов
 * @param {string} csvText - CSV текст для парсинга
 * @returns {Array} - Массив объектов
 */
function parseCSVToJSON(csvText) {
    const lines = csvText.trim().split('\n');
    if (lines.length < 2) {
        throw new Error('CSV должен содержать как минимум заголовок и одну строку данных');
    }
    
    // Парсим заголовки
    const headers = lines[0].split(',').map(h => h.trim());
    
    // Парсим данные
    const result = [];
    for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split(',').map(v => v.trim());
        if (values.length !== headers.length) {
            console.warn(`Строка ${i} имеет неправильное количество колонок, пропускаем`);
            continue;
        }
        
        const obj = {};
        headers.forEach((header, index) => {
            obj[header] = values[index];
        });
        result.push(obj);
    }
    
    return result;
}

// Асинхронная загрузка каталога
async function loadCatalogAsync() {
  try {
    const catalogModule = await import('./catalog.js');
    window.FULL_CATALOG = catalogModule.default || [];
    console.log('✓ Catalog loaded:', window.FULL_CATALOG.length, 'items');
    return window.FULL_CATALOG;
  } catch (error) {
    console.error('✗ Failed to load catalog:', error);
    window.FULL_CATALOG = [];
    return [];
  }
}

// --- КОНФИГУРАЦИЯ ---
const CONFIG = {
    // Селекторы и имена классов, которые используются во всех модулях
    selectors: {
        editorToggle: '#editor-toggle',
        editorPanel: '#editor-panel',
        editorImportInput: '#editor-import-input',
        editorUndo: '[data-editor-action="undo"]',
        editorRedo: '[data-editor-action="redo"]',
        editorExport: '[data-editor-action="export"]',
        editorImport: '[data-editor-action="import"]',
        editorHealthIndicator: '[data-editor-health-indicator]',
        editorHealthText: '[data-editor-health-text]',
        editable: '.js-editable, [data-editable]',
        dragHandle: '.js-drag',
        groupsContainer: '[data-groups-container="catalog"]',
    },
    classes: {
        editorMode: 'editor-mode',
    },
    editor: {
        pinStorageKey: 'editorPin',
        pinMinLength: 4,
        textDebounce: 500,
        orderSaveDelay: 300,
        historyDepth: 50,
        saltBytes: 16,
    },
    storage: {
        stateKey: 'site_state_v1',
        backupPrefix: 'site_state_backup_',
        backupOnImport: 'backup:lastImport',
        catalogOrderKey: 'catalogOrder:v1',
        maxBackups: 3,
    },
    api: {
    }
};

// Инициализация приложения
(async function init() {
    // Загружаем каталог перед инициализацией
    await loadCatalogAsync();
    
    // Здесь будет основной код инициализации приложения
    console.log('✓ App initialized');
})();
