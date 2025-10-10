// ============================================
// app.js - Единая точка входа для SPA
// ============================================

// --- ЭКСПОРТЫ ---
/**
 * Парсит CSV строку в JSON массив объектов
 * @param {string} csvText - CSV текст для парсинга
 * @returns {Array} - Массив объектов
 */
export function parseCSVToJSON(csvText) {
    const lines = csvText.trim().split('\n');
    if (lines.length < 2) {
        throw new Error('CSV должен содержать как минимум заголовок и одну строку данных');
    }
    
    const headers = lines[0].split(',').map(h => h.trim());
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

// --- АСИНХРОННАЯ ЗАГРУЗКА КАТАЛОГА ---
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
    selectors: {
        editorBar: '#editor-bar',
        editorToggle: '#editor-toggle',
        editorPanel: '#editor-panel',
        editorImportInput: '#editor-import-input',
        editorUndo: '[data-editor-action="undo"]',
        editorRedo: '[data-editor-action="redo"]',
        editorExport: '[data-editor-action="export"]',
        editorImport: '[data-editor-action="import"]',
        editorExit: '[data-editor-action="exit"]',
        editable: '.js-editable, [data-editable]',
        dragHandle: '.js-drag',
        groupsContainer: '[data-groups-container="catalog"]',
        app: '#app'
    },
    classes: {
        editorMode: 'editor-mode',
        hidden: 'hidden'
    },
    editor: {
        pinStorageKey: 'editorPin',
        pinMinLength: 4,
        textDebounce: 500,
        orderSaveDelay: 300,
        historyDepth: 50,
        saltBytes: 16
    },
    storage: {
        stateKey: 'site_state_v1',
        backupPrefix: 'site_state_backup_',
        backupOnImport: 'backup:lastImport',
        catalogOrderKey: 'catalogOrder:v1',
        maxBackups: 3
    }
};

// --- РЕНДЕРИНГ ---
function renderHomePage() {
    const app = document.querySelector(CONFIG.selectors.app);
    if (!app) {
        console.error('✗ App container not found');
        return;
    }
    
    app.innerHTML = `
        <div class="container mx-auto px-4 py-8">
            <h1 class="text-4xl font-bold text-center mb-8">СтройМаркет - Каталог</h1>
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6" id="catalog-container">
                ${renderCatalogItems()}
            </div>
        </div>
    `;
}

function renderCatalogItems() {
    if (!window.FULL_CATALOG || window.FULL_CATALOG.length === 0) {
        return '<p class="col-span-full text-center text-gray-500">Каталог пуст</p>';
    }
    
    return window.FULL_CATALOG.map(item => `
        <div class="bg-white rounded-lg shadow-md p-6 hover:shadow-lg transition">
            <h3 class="text-xl font-semibold mb-2">${item.name || 'Без названия'}</h3>
            <p class="text-gray-600 mb-4">${item.description || ''}</p>
            <div class="text-sm text-gray-500">
                <p><strong>Цена:</strong> ${item.price || 'Н/Д'}</p>
                <p><strong>Категория:</strong> ${item.category || 'Н/Д'}</p>
            </div>
        </div>
    `).join('');
}

// --- ПРОВЕРКА РЕЖИМА РЕДАКТИРОВАНИЯ ---
function checkEditMode() {
    const editModeRequested = sessionStorage.getItem('editModeRequested') === '1';
    if (editModeRequested) {
        console.log('✓ Edit mode requested via URL');
        return true;
    }
    return false;
}

function activateEditMode() {
    const editorBar = document.querySelector(CONFIG.selectors.editorBar);
    if (editorBar) {
        editorBar.classList.remove(CONFIG.classes.hidden);
        editorBar.dataset.editorActive = 'true';
        document.body.classList.add(CONFIG.classes.editorMode);
        console.log('✓ Editor mode activated');
    }
}

// --- ИНИЦИАЛИЗАЦИЯ ---
(async function initApp() {
    console.log('✓ App initialization started');
    
    // 1. Загружаем каталог
    await loadCatalogAsync();
    
    // 2. Рендерим основной контент
    renderHomePage();
    
    // 3. Проверяем и активируем режим редактирования при необходимости
    if (checkEditMode()) {
        activateEditMode();
    }
    
    console.log('✓ App initialization completed');
})();
