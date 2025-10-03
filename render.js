// --- КОНФИГУРАЦИЯ ---
const STATE_STORAGE_KEY = 'site_state_v1';
const STATE_BACKUP_PREFIX = 'site_state_backup_';
const MAX_STATE_BACKUPS = 3;
const STATE_SAVE_DEBOUNCE = 500;
const EDITOR_PIN_STORAGE_KEY = 'site_editor_pin_hash';
const EDITOR_PIN_DIGEST_PREFIX = 'sha256:';

var UNDO_STACK_LIMIT = typeof UNDO_STACK_LIMIT === 'number' ? UNDO_STACK_LIMIT : 50;
var HISTORY_TRACKED_KEYS = (typeof HISTORY_TRACKED_KEYS !== 'undefined' && HISTORY_TRACKED_KEYS instanceof Set)
    ? HISTORY_TRACKED_KEYS
    : new Set();
['products', 'cartItems', 'slides', 'groupsOrder', 'itemsOrderByGroup', 'checkoutState']
    .forEach((key) => HISTORY_TRACKED_KEYS.add(key));

var editorHistoryStore = (() => {
    const scope = typeof window !== 'undefined' ? window : globalThis;
    if (!scope.__editorHistory) {
        scope.__editorHistory = {
            undoStack: [],
            redoStack: [],
            activeTextEditKeys: new Set(),
            isUndoRedoInProgress: false,
        };
    }
    return scope.__editorHistory;
})();

const activeTextEditKeys = editorHistoryStore.activeTextEditKeys;

const dirtyStateManager = (() => {
    const scope = typeof window !== 'undefined' ? window : globalThis;
    const existing = scope.__editorDirtyState;
    if (existing && typeof existing.markDirty === 'function' && typeof existing.markSaved === 'function' && typeof existing.isDirty === 'function') {
        if (typeof existing.attachBeforeUnload === 'function') {
            existing.attachBeforeUnload();
        }
        if (typeof window !== 'undefined') {
            window.isStateDirty = () => existing.isDirty();
        }
        return existing;
    }

    const manager = {
        generation: 0,
        lastSavedGeneration: 0,
        dirty: false,
        beforeUnloadAttached: false,
        beforeUnloadHandler: null,
        markDirty() {
            manager.generation += 1;
            manager.dirty = true;
            manager.attachBeforeUnload();
            return manager.generation;
        },
        markSaved(generation) {
            if (typeof generation !== 'number') return;
            if (generation > manager.lastSavedGeneration) {
                manager.lastSavedGeneration = generation;
            }
            if (manager.lastSavedGeneration >= manager.generation && manager.dirty) {
                manager.dirty = false;
            }
        },
        isDirty() {
            return manager.dirty;
        },
        attachBeforeUnload() {
            if (manager.beforeUnloadAttached || typeof window === 'undefined') return;
            const handler = (event) => {
                if (!manager.dirty) {
                    return undefined;
                }
                event.preventDefault();
                event.returnValue = '';
                return '';
            };
            window.addEventListener('beforeunload', handler);
            manager.beforeUnloadAttached = true;
            manager.beforeUnloadHandler = handler;
        },
    };

    scope.__editorDirtyState = manager;
    if (typeof window !== 'undefined') {
        window.isStateDirty = () => manager.isDirty();
    }
    manager.attachBeforeUnload();
    return manager;
})();

const markStateDirty = () => dirtyStateManager.markDirty();
const markStateSaved = (generation) => dirtyStateManager.markSaved(generation);
const isStateDirty = () => dirtyStateManager.isDirty();

function updateEditorHistoryButtons() {
    if (typeof document === 'undefined') return;
    const editorState = window.editorMode?.state;
    if (!editorState) return;
    const canUndo = editorHistoryStore.undoStack.length > 0;
    const canRedo = editorHistoryStore.redoStack.length > 0;
    if (editorState.undoButton) {
        editorState.undoButton.disabled = !canUndo;
        editorState.undoButton.setAttribute('aria-disabled', String(!canUndo));
    }
    if (editorState.redoButton) {
        editorState.redoButton.disabled = !canRedo;
        editorState.redoButton.setAttribute('aria-disabled', String(!canRedo));
    }
}

function prepareUndoSnapshot() {
    if (editorHistoryStore.isUndoRedoInProgress) return null;
    return cloneStateSnapshot();
}

function commitUndoSnapshot(snapshot) {
    if (!snapshot) return;
    editorHistoryStore.undoStack.push(snapshot);
    if (editorHistoryStore.undoStack.length > UNDO_STACK_LIMIT) {
        editorHistoryStore.undoStack.splice(0, editorHistoryStore.undoStack.length - UNDO_STACK_LIMIT);
    }
    editorHistoryStore.redoStack.length = 0;
    updateEditorHistoryButtons();
}

function pushRedoSnapshot(snapshot) {
    if (!snapshot) return;
    editorHistoryStore.redoStack.push(snapshot);
    if (editorHistoryStore.redoStack.length > UNDO_STACK_LIMIT) {
        editorHistoryStore.redoStack.splice(0, editorHistoryStore.redoStack.length - UNDO_STACK_LIMIT);
    }
    updateEditorHistoryButtons();
}

async function applyHistorySnapshot(snapshot) {
    if (!snapshot) return;
    editorHistoryStore.isUndoRedoInProgress = true;
    activeTextEditKeys.clear();
    try {
        state = JSON.parse(JSON.stringify(snapshot));
        if (typeof window !== 'undefined') {
            window.state = state;
        }
        ensureLayoutOrdering();
        destroyCatalogSortables();
        render();
        await saveStateSnapshot(true);
    } finally {
        editorHistoryStore.isUndoRedoInProgress = false;
        updateEditorHistoryButtons();
    }
}

async function undoStateChange() {
    if (!editorHistoryStore.undoStack.length) return;
    const previousSnapshot = editorHistoryStore.undoStack.pop();
    const currentSnapshot = prepareUndoSnapshot();
    if (currentSnapshot) {
        pushRedoSnapshot(currentSnapshot);
    }
    await applyHistorySnapshot(previousSnapshot);
}

async function redoStateChange() {
    if (!editorHistoryStore.redoStack.length) return;
    const nextSnapshot = editorHistoryStore.redoStack.pop();
    const currentSnapshot = prepareUndoSnapshot();
    if (currentSnapshot) {
        editorHistoryStore.undoStack.push(currentSnapshot);
        if (editorHistoryStore.undoStack.length > UNDO_STACK_LIMIT) {
            editorHistoryStore.undoStack.splice(0, editorHistoryStore.undoStack.length - UNDO_STACK_LIMIT);
        }
    }
    await applyHistorySnapshot(nextSnapshot);
}

function getSafeLocalStorage() {
    if (typeof window === 'undefined') {
        return null;
    }
    try {
        return window.localStorage;
    } catch (error) {
        console.warn('LocalStorage is not available for editor PIN protection.', error);
        return null;
    }
}

function normalizeEditorPinHash(value) {
    if (typeof value !== 'string') {
        return '';
    }
    return value.startsWith(EDITOR_PIN_DIGEST_PREFIX)
        ? value.slice(EDITOR_PIN_DIGEST_PREFIX.length)
        : value;
}

async function hashEditorPin(pin) {
    const normalized = typeof pin === 'string' ? pin.trim() : '';
    if (!normalized) {
        return null;
    }
    if (typeof window !== 'undefined' && window.crypto?.subtle && typeof TextEncoder !== 'undefined') {
        const encoder = new TextEncoder();
        const data = encoder.encode(normalized);
        const digest = await window.crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(digest));
        const hex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
        return `${EDITOR_PIN_DIGEST_PREFIX}${hex}`;
    }

    let hash = 0;
    for (let index = 0; index < normalized.length; index += 1) {
        hash = ((hash << 5) - hash) + normalized.charCodeAt(index);
        hash |= 0; // eslint-disable-line no-bitwise
    }
    const fallbackHex = Math.abs(hash).toString(16);
    return `${EDITOR_PIN_DIGEST_PREFIX}${fallbackHex}`;
}

async function ensureEditorPin({ allowCreate = true } = {}) {
    if (typeof window === 'undefined') {
        return false;
    }

    const storage = getSafeLocalStorage();
    if (!storage) {
        return window.confirm('Локальное хранилище недоступно. Продолжить без проверки PIN?');
    }

    const storedHash = storage.getItem(EDITOR_PIN_STORAGE_KEY);
    if (!storedHash) {
        if (!allowCreate) {
            return false;
        }
        const shouldCreate = window.confirm('Для работы редактора необходимо создать локальный PIN. Продолжить?');
        if (!shouldCreate) {
            return false;
        }
        const firstPin = window.prompt('Введите новый PIN (минимум 4 символа):');
        if (!firstPin || firstPin.trim().length < 4) {
            window.alert('PIN должен содержать минимум 4 символа.');
            return false;
        }
        const confirmation = window.prompt('Повторите PIN для подтверждения:');
        if (confirmation !== firstPin) {
            window.alert('PIN не совпадает.');
            return false;
        }
        const hashed = await hashEditorPin(firstPin);
        if (!hashed) {
            window.alert('Не удалось сохранить PIN. Попробуйте снова.');
            return false;
        }
        storage.setItem(EDITOR_PIN_STORAGE_KEY, hashed);
        return true;
    }

    const pin = window.prompt('Введите PIN редактора:');
    if (pin === null) {
        return false;
    }
    const hashed = await hashEditorPin(pin);
    if (!hashed) {
        window.alert('PIN не может быть пустым.');
        return false;
    }
    if (normalizeEditorPinHash(hashed) === normalizeEditorPinHash(storedHash)) {
        return true;
    }
    window.alert('Неверный PIN.');
    return false;
}

// LLM API Configuration (для генерации описаний)
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=';

// ВАШ КЛЮЧ GEMINI
// Вставьте сюда ваш API-ключ Gemini, чтобы работала функция генерации описаний.
const GEMINI_API_KEY = ""; 
// ---------------------

const DEFAULT_PRODUCTS = [
    {
        id: 'demo-1',
        name: 'Пеноблок D600 (600x200x300)',
        price: 350,
        unit: 'шт',
        description: 'Легкий и прочный пеноблок для строительства наружных стен и перегородок. Высокие теплоизоляционные свойства.',
        image: 'https://placehold.co/400x160/2563eb/ffffff?text=Material',
    },
];

function createDefaultRenderState() {
    return {
        texts: {},
        groups: { catalogCategories: [] },
        items: {
            products: DEFAULT_PRODUCTS.map((product) => ({ ...product })),
            cartItems: {},
        },
        layout: {
            view: 'home',
            selectedProductId: null,
            lastViewBeforeDetails: 'home',
            groupsOrder: [],
            itemsOrderByGroup: {},
        },
        meta: {
            message: '',
            searchTerm: '',
            sortBy: 'name-asc',
            onlyWithPrice: false,
        },
    };
}

const sharedState = typeof window !== 'undefined' && window.state ? window.state : null;
let state = sharedState ? window.state : createDefaultRenderState();
if (!sharedState && typeof window !== 'undefined') {
    window.state = state;
}

let localStateSaveTimeoutId = null;
let localforageLoaderPromise = null;

const LOCAL_STATE_KEY_PATHS = {
    products: ['items', 'products'],
    cartItems: ['items', 'cartItems'],
    view: ['layout', 'view'],
    selectedProductId: ['layout', 'selectedProductId'],
    lastViewBeforeDetails: ['layout', 'lastViewBeforeDetails'],
    groupsOrder: ['layout', 'groupsOrder'],
    itemsOrderByGroup: ['layout', 'itemsOrderByGroup'],
    message: ['meta', 'message'],
};

const applyStatePatch = typeof window !== 'undefined' && typeof window.applyStatePatch === 'function'
    ? window.applyStatePatch
    : function renderApplyStatePatch(partial = {}) {
        const changedKeys = [];
        for (const [key, value] of Object.entries(partial)) {
            const path = LOCAL_STATE_KEY_PATHS[key];
            if (!path) continue;
            let target = state;
            for (let i = 0; i < path.length - 1; i += 1) {
                if (!target[path[i]]) {
                    target[path[i]] = {};
                }
                target = target[path[i]];
            }
            const lastKey = path[path.length - 1];
            const previous = target[lastKey];
            const hasChanged = JSON.stringify(previous) !== JSON.stringify(value);
            if (hasChanged) {
                target[lastKey] = value;
                changedKeys.push(key);
            }
        }
        return changedKeys;
    };

const computeEditorKey = typeof window !== 'undefined' && typeof window.computeEditorKey === 'function'
    ? window.computeEditorKey
    : function renderComputeEditorKey(element) {
        if (!element || typeof element !== 'object' || typeof document === 'undefined') return null;
        if (element.dataset && element.dataset.editKey) {
            return element.dataset.editKey;
        }
        const segments = [];
        let node = element;
        while (node && node !== document.body) {
            let index = 0;
            let sibling = node.previousElementSibling;
            while (sibling) {
                if (sibling.tagName === node.tagName) {
                    index += 1;
                }
                sibling = sibling.previousElementSibling;
            }
            segments.unshift(`${node.tagName.toLowerCase()}:${index}`);
            node = node.parentElement;
        }
        const key = segments.join('/');
        if (element.dataset) {
            element.dataset.editKey = key;
        }
        return key;
    };

const syncEditableContent = typeof window !== 'undefined' && typeof window.syncEditableContent === 'function'
    ? window.syncEditableContent
    : function renderSyncEditableContent({ captureMissing = false } = {}) {
        if (typeof document === 'undefined') return false;
        const elements = document.querySelectorAll('.js-editable');
        let stateChanged = false;
        elements.forEach((element) => {
            const key = computeEditorKey(element);
            if (!key) return;
            if (captureMissing && !Object.prototype.hasOwnProperty.call(state.texts, key)) {
                state.texts[key] = element.textContent ?? '';
                stateChanged = true;
            }
            if (Object.prototype.hasOwnProperty.call(state.texts, key)) {
                const storedText = state.texts[key];
                if (element.textContent !== storedText) {
                    element.textContent = storedText;
                }
            }
        });
        if (stateChanged) {
            scheduleStateSave();
        }
        return stateChanged;
    };

function cloneStateSnapshot() {
    return JSON.parse(JSON.stringify(state));
}

function buildStateExportFileName() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    return `site-state-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.json`;
}

function downloadJsonFile(fileName, jsonString) {
    if (typeof document === 'undefined' || !document.body) return;
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
}

function exportStateSnapshot() {
    try {
        const snapshot = cloneStateSnapshot();
        const jsonString = JSON.stringify(snapshot, null, 2);
        downloadJsonFile(buildStateExportFileName(), jsonString);
    } catch (error) {
        console.error('[EDITOR:EXPORT]', error);
        setMessage('Не удалось экспортировать состояние.');
    }
}

function validateImportedSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
        throw new Error('Некорректный JSON-файл.');
    }
    const requiredKeys = ['items', 'groups', 'layout', 'texts'];
    const missing = requiredKeys.filter((key) => !Object.prototype.hasOwnProperty.call(snapshot, key));
    if (missing.length) {
        throw new Error(`Отсутствуют обязательные поля: ${missing.join(', ')}`);
    }
    if (typeof snapshot.items !== 'object' || snapshot.items === null) {
        throw new Error('Поле "items" должно быть объектом.');
    }
    if (typeof snapshot.groups !== 'object' || snapshot.groups === null) {
        throw new Error('Поле "groups" должно быть объектом.');
    }
    if (typeof snapshot.layout !== 'object' || snapshot.layout === null) {
        throw new Error('Поле "layout" должно быть объектом.');
    }
    if (typeof snapshot.texts !== 'object' || snapshot.texts === null) {
        throw new Error('Поле "texts" должно быть объектом.');
    }
    return snapshot;
}

function mergeImportedRenderState(defaultState, importedState) {
    const merged = createDefaultRenderState();
    const snapshot = importedState && typeof importedState === 'object' ? importedState : {};
    merged.texts = { ...merged.texts, ...(snapshot.texts || {}) };
    const catalogCategories = Array.isArray(snapshot.groups?.catalogCategories)
        ? snapshot.groups.catalogCategories.map((category) => ({ ...category }))
        : defaultState.groups.catalogCategories.map((category) => ({ ...category }));
    merged.groups = {
        ...merged.groups,
        ...(snapshot.groups || {}),
        catalogCategories,
    };
    merged.items = {
        ...merged.items,
        ...(snapshot.items || {}),
        products: Array.isArray(snapshot.items?.products)
            ? snapshot.items.products.map((product) => ({ ...product }))
            : defaultState.items.products.map((product) => ({ ...product })),
        cartItems: snapshot.items?.cartItems
            ? { ...snapshot.items.cartItems }
            : { ...defaultState.items.cartItems },
    };
    merged.layout = {
        ...merged.layout,
        ...(snapshot.layout || {}),
    };
    merged.meta = {
        ...merged.meta,
        ...(snapshot.meta || {}),
    };
    return merged;
}

async function applyImportedSnapshot(importedState) {
    const defaults = createDefaultRenderState();
    const merged = mergeImportedRenderState(defaults, importedState);

    if (!Array.isArray(merged.items.products) || !merged.items.products.length) {
        merged.items.products = defaults.items.products.map((product) => ({ ...product }));
    }

    const undoSnapshot = prepareUndoSnapshot();
    state = merged;
    if (typeof window !== 'undefined') {
        window.state = state;
    }

    activeTextEditKeys.clear();
    commitUndoSnapshot(undoSnapshot);

    ensureLayoutOrdering();

    if (localStateSaveTimeoutId) {
        clearTimeout(localStateSaveTimeoutId);
        localStateSaveTimeoutId = null;
    }

    destroyCatalogSortables();
    render();
    await saveStateSnapshot(true);
    setMessage('Состояние успешно импортировано.');
}

async function importStateFromFile(file) {
    try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const snapshot = validateImportedSnapshot(parsed);
        await applyImportedSnapshot(snapshot);
    } catch (error) {
        console.error('[EDITOR:IMPORT]', error);
        setMessage(`Ошибка импорта: ${error.message}`);
    }
}

function arraysEqual(first, second) {
    if (first === second) return true;
    if (!Array.isArray(first) || !Array.isArray(second)) return false;
    if (first.length !== second.length) return false;
    for (let index = 0; index < first.length; index += 1) {
        if (first[index] !== second[index]) {
            return false;
        }
    }
    return true;
}

function ensureLayoutOrdering({ persist = false } = {}) {
    const categories = Array.isArray(state.groups?.catalogCategories)
        ? state.groups.catalogCategories
        : [];
    const categorySlugs = categories
        .map((category) => String(category?.slug || '').trim())
        .filter(Boolean);
    const currentGroupOrder = Array.isArray(state.layout?.groupsOrder) ? state.layout.groupsOrder : [];
    const sanitizedGroupOrder = currentGroupOrder.filter((slug) => categorySlugs.includes(slug));
    let groupsChanged = sanitizedGroupOrder.length !== currentGroupOrder.length;
    categorySlugs.forEach((slug) => {
        if (!sanitizedGroupOrder.includes(slug)) {
            sanitizedGroupOrder.push(slug);
            groupsChanged = true;
        }
    });

    const currentItemsOrder = state.layout?.itemsOrderByGroup && typeof state.layout.itemsOrderByGroup === 'object'
        ? state.layout.itemsOrderByGroup
        : {};
    const nextItemsOrder = {};
    let itemsChanged = false;

    categories.forEach((category) => {
        const groupSlug = String(category?.slug || '').trim();
        if (!groupSlug) return;
        const subcategorySlugs = Array.isArray(category?.subcategories)
            ? category.subcategories.map((sub) => String(sub?.slug || '').trim()).filter(Boolean)
            : [];
        const savedOrder = Array.isArray(currentItemsOrder[groupSlug]) ? currentItemsOrder[groupSlug] : [];
        const sanitizedItems = savedOrder.filter((slug) => subcategorySlugs.includes(slug));
        if (sanitizedItems.length !== savedOrder.length) {
            itemsChanged = true;
        }
        subcategorySlugs.forEach((slug) => {
            if (!sanitizedItems.includes(slug)) {
                sanitizedItems.push(slug);
                itemsChanged = true;
            }
        });
        nextItemsOrder[groupSlug] = sanitizedItems;
    });

    const existingGroupKeys = Object.keys(currentItemsOrder);
    const nextGroupKeys = Object.keys(nextItemsOrder);
    if (!itemsChanged && existingGroupKeys.length !== nextGroupKeys.length) {
        itemsChanged = true;
    }
    if (!itemsChanged) {
        itemsChanged = nextGroupKeys.some((key) => !arraysEqual(currentItemsOrder[key] || [], nextItemsOrder[key] || []));
    }

    if (!arraysEqual(sanitizedGroupOrder, state.layout.groupsOrder || [])) {
        groupsChanged = true;
    }

    if (groupsChanged) {
        state.layout.groupsOrder = sanitizedGroupOrder;
    }
    if (itemsChanged) {
        state.layout.itemsOrderByGroup = nextItemsOrder;
    }

    if ((groupsChanged || itemsChanged) && persist) {
        scheduleStateSave();
    }

    return groupsChanged || itemsChanged;
}

let catalogGroupsSortable = null;
const catalogItemSortables = new Map();

function destroyCatalogSortables() {
    if (catalogGroupsSortable) {
        catalogGroupsSortable.destroy();
        catalogGroupsSortable = null;
    }
    catalogItemSortables.forEach((instance) => instance.destroy());
    catalogItemSortables.clear();
}

function refreshCatalogSortables() {
    if (typeof document === 'undefined') return;
    const editorState = window.editorMode?.state;
    const isEditorActive = Boolean(editorState?.isEnabled && editorState.isActive);
    if (!isEditorActive || typeof Sortable === 'undefined' || state.layout.view !== 'catalog') {
        destroyCatalogSortables();
        return;
    }

    const groupsContainer = document.querySelector('[data-groups-container="catalog"]');
    if (!groupsContainer) {
        destroyCatalogSortables();
        return;
    }

    destroyCatalogSortables();

    catalogGroupsSortable = new Sortable(groupsContainer, {
        animation: 150,
        handle: '.js-drag',
        fallbackOnBody: true,
        draggable: '[data-group-id]',
        onEnd: () => {
            const nextOrder = Array.from(groupsContainer.querySelectorAll('[data-group-id]'))
                .map((element) => element.getAttribute('data-group-id'))
                .filter(Boolean);
            if (!arraysEqual(nextOrder, state.layout.groupsOrder || [])) {
                setState({ groupsOrder: nextOrder });
            }
        },
    });

    const itemsContainers = groupsContainer.querySelectorAll('[data-items-container]');
    itemsContainers.forEach((container) => {
        const groupId = container.getAttribute('data-items-container');
        if (!groupId) return;
        const sortableInstance = new Sortable(container, {
            animation: 150,
            handle: '.js-drag',
            fallbackOnBody: true,
            draggable: '[data-item-id]',
            onEnd: () => {
                const nextItemsOrder = Array.from(container.querySelectorAll('[data-item-id]'))
                    .map((element) => element.getAttribute('data-item-id'))
                    .filter(Boolean);
                const currentOrder = state.layout.itemsOrderByGroup?.[groupId] || [];
                if (!arraysEqual(nextItemsOrder, currentOrder)) {
                    const existing = state.layout.itemsOrderByGroup && typeof state.layout.itemsOrderByGroup === 'object'
                        ? state.layout.itemsOrderByGroup
                        : {};
                    setState({ itemsOrderByGroup: { ...existing, [groupId]: nextItemsOrder } });
                }
            },
        });
        catalogItemSortables.set(groupId, sortableInstance);
    });
}

const ensureLocalforage = typeof window !== 'undefined' && window.ensureLocalforage
    ? window.ensureLocalforage
    : function renderEnsureLocalforage() {
        if (typeof window !== 'undefined' && window.localforage) {
            return Promise.resolve(window.localforage);
        }
        if (localforageLoaderPromise) {
            return localforageLoaderPromise;
        }
        if (typeof document === 'undefined') {
            return Promise.resolve(null);
        }
        localforageLoaderPromise = new Promise((resolve) => {
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/localforage@1.10.0/dist/localforage.min.js';
            script.async = true;
            script.onload = () => resolve(window.localforage || null);
            script.onerror = () => {
                console.warn('[STATE:SKIP]', 'render-storage', 'Не удалось загрузить localForage');
                resolve(null);
            };
            document.head.appendChild(script);
        });
        return localforageLoaderPromise;
    };

const scheduleStateSave = typeof window !== 'undefined' && typeof window.scheduleStateSave === 'function'
    ? window.scheduleStateSave
    : function renderScheduleStateSave() {
        return saveStateSnapshot();
    };

async function saveStateSnapshot(immediate = false) {
    const generation = markStateDirty();
    const lf = await ensureLocalforage();
    if (!lf) return;
    const persist = async () => {
        try {
            const current = await lf.getItem(STATE_STORAGE_KEY);
            if (current) {
                const backupKey = `${STATE_BACKUP_PREFIX}${Date.now()}`;
                await lf.setItem(backupKey, current);
                const keys = await lf.keys();
                const backups = keys.filter((key) => key.startsWith(STATE_BACKUP_PREFIX));
                if (backups.length > MAX_STATE_BACKUPS) {
                    const sorted = backups.sort((a, b) => b.localeCompare(a));
                    const excess = sorted.slice(MAX_STATE_BACKUPS);
                    await Promise.all(excess.map((key) => lf.removeItem(key)));
                }
            }
            await lf.setItem(STATE_STORAGE_KEY, JSON.parse(JSON.stringify(state)));
            markStateSaved(generation);
        } catch (error) {
            console.warn('[STATE:SKIP]', 'render-storage', `Не удалось сохранить состояние: ${error.message}`);
        }
    };
    if (immediate) {
        if (localStateSaveTimeoutId) {
            clearTimeout(localStateSaveTimeoutId);
            localStateSaveTimeoutId = null;
        }
        await persist();
        return;
    }
    if (localStateSaveTimeoutId) {
        clearTimeout(localStateSaveTimeoutId);
    }
    localStateSaveTimeoutId = window.setTimeout(() => {
        localStateSaveTimeoutId = null;
        persist();
    }, STATE_SAVE_DEBOUNCE);
}

const initializeState = typeof window !== 'undefined' && typeof window.initializeSiteState === 'function'
    ? window.initializeSiteState
    : async function renderInitializeState() {
        const lf = await ensureLocalforage();
        const defaults = createDefaultRenderState();
        if (lf) {
            try {
                const stored = await lf.getItem(STATE_STORAGE_KEY);
                if (stored && typeof stored === 'object') {
                    state = {
                        ...defaults,
                        ...stored,
                        items: {
                            ...defaults.items,
                            ...(stored.items || {}),
                        },
                        layout: {
                            ...defaults.layout,
                            ...(stored.layout || {}),
                        },
                        meta: {
                            ...defaults.meta,
                            ...(stored.meta || {}),
                        },
                    };
                    if (typeof window !== 'undefined') {
                        window.state = state;
                    }
                }
            } catch (error) {
                console.warn('[STATE:SKIP]', 'render-storage', `Не удалось загрузить состояние: ${error.message}`);
            }
        }
        if (!state.items.products.length) {
            state.items.products = defaults.items.products.map((product) => ({ ...product }));
        }
        ensureLayoutOrdering({ persist: true });
        if (lf) {
            await saveStateSnapshot(true);
        }
    };

if (typeof document !== 'undefined') {
    const globalObject = typeof window !== 'undefined' ? window : null;
    if (!globalObject || !globalObject.__editorChangeListenerAttached) {
        document.addEventListener('editor:changed', (event) => {
            const element = event?.target;
            if (!element || typeof element !== 'object') return;
            const key = computeEditorKey(element);
            if (!key) return;
            const text = element.textContent ?? '';
            const trigger = event?.detail?.trigger || null;
            const previousText = state.texts[key];

            if (previousText === text) {
                if (trigger === 'blur') {
                    activeTextEditKeys.delete(key);
                }
                return;
            }

            if (!activeTextEditKeys.has(key)) {
                const snapshot = prepareUndoSnapshot();
                commitUndoSnapshot(snapshot);
                activeTextEditKeys.add(key);
            }

            state.texts[key] = text;
            scheduleStateSave();

            if (trigger === 'blur') {
                activeTextEditKeys.delete(key);
            }
        });
        if (globalObject) {
            globalObject.__editorChangeListenerAttached = true;
        }
    }
}

if (typeof window !== 'undefined') {
    if (!window.applyStatePatch) window.applyStatePatch = applyStatePatch;
    if (!window.scheduleStateSave) window.scheduleStateSave = scheduleStateSave;
    if (!window.syncEditableContent) window.syncEditableContent = syncEditableContent;
    if (!window.computeEditorKey) window.computeEditorKey = computeEditorKey;
    if (!window.initializeSiteState) window.initializeSiteState = initializeState;
    if (!window.isStateDirty) window.isStateDirty = isStateDirty;
}

// Внутреннее состояние формы администратора (для сохранения введенных данных)
window.adminState = {
    productName: '', productPrice: '', productUnit: 'шт',
    productImage: 'https://placehold.co/400x160/2563eb/ffffff?text=Material',
    productDescription: '', isGenerating: false, jsonInput: '',
};

const EDIT_QUERY_PARAM = 'edit';

if (!window.editorMode) {
    const searchParams = new URLSearchParams(window.location.search);
    const isEnabled = searchParams.get(EDIT_QUERY_PARAM) === '1';
    const handlers = new WeakMap();
    const documentAvailable = typeof document !== 'undefined';
    const getBodyElement = () => (documentAvailable ? document.body : null);
    const state = {
        isEnabled,
        isActive: false,
        isAuthorized: false,
        authorizationPromise: null,
        button: null,
        initialized: false,
        handlers,
        panel: null,
        panelInitialized: false,
        exportButton: null,
        importButton: null,
        importInput: null,
        undoButton: null,
        redoButton: null,
    };

    const initialBody = getBodyElement();
    if (initialBody) {
        initialBody.classList.toggle('editor-mode', state.isActive);
    }

    const emitEditorChanged = (element, trigger) => {
        const text = element.textContent ?? '';
        element.textContent = text;
        if (typeof computeEditorKey === 'function') {
            computeEditorKey(element);
        }
        element.dispatchEvent(new CustomEvent('editor:changed', {
            bubbles: true,
            detail: { text, trigger },
        }));
    };

    const detachHandler = (element) => {
        const handler = state.handlers.get(element);
        if (!handler) return;
        element.removeEventListener('input', handler);
        element.removeEventListener('blur', handler);
        state.handlers.delete(element);
    };

    const createHandler = (element) => (event) => {
        emitEditorChanged(element, event.type);
    };

    const updatePanelVisibility = () => {
        if (!state.panel) return;
        const shouldShow = state.isEnabled && state.isActive;
        state.panel.style.display = shouldShow ? 'flex' : 'none';
        state.panel.setAttribute('aria-hidden', shouldShow ? 'false' : 'true');
    };

    const initializeEditorPanel = () => {
        if (!documentAvailable || state.panelInitialized) return;
        const panel = document.getElementById('editor-panel');
        if (!panel) return;

        const undoButton = panel.querySelector('[data-editor-action="undo"]');
        const redoButton = panel.querySelector('[data-editor-action="redo"]');
        const exportButton = panel.querySelector('[data-editor-action="export"]');
        const importButton = panel.querySelector('[data-editor-action="import"]');
        const importInput = document.getElementById('editor-import-input')
            || panel.querySelector('input[type="file"]');

        if (undoButton) {
            undoButton.addEventListener('click', () => {
                if (!state.isEnabled || !state.isActive) return;
                undoStateChange();
            });
        }

        if (redoButton) {
            redoButton.addEventListener('click', () => {
                if (!state.isEnabled || !state.isActive) return;
                redoStateChange();
            });
        }

        if (exportButton) {
            exportButton.addEventListener('click', () => {
                if (!state.isEnabled || !state.isActive) return;
                exportStateSnapshot();
            });
        }

        if (importButton && importInput) {
            importButton.addEventListener('click', () => {
                if (!state.isEnabled || !state.isActive) return;
                if (typeof window !== 'undefined') {
                    const confirmed = window.confirm('Импорт заменит текущее состояние. Продолжить?');
                    if (!confirmed) return;
                }
                importInput.value = '';
                importInput.click();
            });

            importInput.addEventListener('change', async (event) => {
                const input = event.target;
                const selectedFile = input.files && input.files[0];
                if (selectedFile) {
                    await importStateFromFile(selectedFile);
                }
                input.value = '';
            });
        }

        state.panel = panel;
        state.exportButton = exportButton;
        state.importButton = importButton;
        state.importInput = importInput;
        state.undoButton = undoButton;
        state.redoButton = redoButton;
        state.panelInitialized = true;
        updatePanelVisibility();
        updateEditorHistoryButtons();
    };

    const applyEditableState = () => {
        if (!documentAvailable) return;
        initializeEditorPanel();
        const elements = document.querySelectorAll('.js-editable');
        elements.forEach((element) => {
            const handler = state.handlers.get(element);
            if (!state.isEnabled || !state.isActive) {
                if (handler) {
                    detachHandler(element);
                }
                if (element.hasAttribute('contenteditable')) {
                    element.removeAttribute('contenteditable');
                }
                return;
            }

            if (!handler) {
                const listener = createHandler(element);
                element.addEventListener('input', listener);
                element.addEventListener('blur', listener);
                state.handlers.set(element, listener);
            }

            if (typeof computeEditorKey === 'function') {
                computeEditorKey(element);
            }
            element.setAttribute('contenteditable', 'plaintext-only');
        });
        updatePanelVisibility();
        refreshCatalogSortables();
    };

    const updateButtonState = () => {
        if (!state.button) return;
        const label = state.isActive ? 'Завершить редактирование' : 'Редактировать';
        state.button.textContent = label;
        state.button.setAttribute('aria-pressed', String(state.isActive));
        state.button.setAttribute('aria-label', state.isActive ? 'Выключить режим редактирования' : 'Включить режим редактирования');
    };

    const updateBodyClass = () => {
        const body = getBodyElement();
        if (body) {
            body.classList.toggle('editor-mode', Boolean(state.isEnabled && state.isActive));
        }
    };

    const requestEditorAuthorization = async () => {
        if (state.isAuthorized) {
            return true;
        }
        if (state.authorizationPromise) {
            return state.authorizationPromise;
        }
        const promise = ensureEditorPin({ allowCreate: true }).then((authorized) => {
            state.authorizationPromise = null;
            if (authorized) {
                state.isAuthorized = true;
            }
            return authorized;
        });
        state.authorizationPromise = promise;
        return promise;
    };

    const setupEditorButton = () => {
        if (state.initialized) {
            updateButtonState();
            updateBodyClass();
            applyEditableState();
            return;
        }

        state.initialized = true;
        state.button = documentAvailable ? document.getElementById('editor-toggle') : null;
        initializeEditorPanel();

        if (!state.button) {
            applyEditableState();
            return;
        }

        if (!state.isEnabled) {
            state.button.style.display = 'none';
            state.isActive = false;
            state.isAuthorized = false;
            state.authorizationPromise = null;
            const body = getBodyElement();
            if (body) {
                body.classList.remove('editor-mode');
            }
            updatePanelVisibility();
            updateBodyClass();
            applyEditableState();
            return;
        }

        state.button.style.display = 'block';
        updateButtonState();
        updateBodyClass();

        state.button.addEventListener('click', async () => {
            if (!state.isActive) {
                const authorized = await requestEditorAuthorization();
                if (!authorized) {
                    return;
                }
                state.isActive = true;
            } else {
                state.isActive = false;
            }
            updateBodyClass();
            updateButtonState();
            applyEditableState();
        });

        applyEditableState();
    };

    window.editorMode = {
        state,
        refresh: applyEditableState,
        setup: setupEditorButton,
    };
    updateEditorHistoryButtons();
}

// --- Управление Состоянием (ГЛОБАЛЬНЫЕ ФУНКЦИИ) ---

function setState(newState, callback = null) {
    const undoSnapshot = prepareUndoSnapshot();
    const changedKeys = applyStatePatch(newState || {});
    if (!changedKeys.length) {
        if (callback) callback();
        return;
    }
    if (changedKeys.some((key) => HISTORY_TRACKED_KEYS.has(key))) {
        commitUndoSnapshot(undoSnapshot);
    }
    scheduleStateSave();
    render();
    if (callback) callback();
}

function setMessage(text) {
    setState({ message: text });
    setTimeout(() => setState({ message: '' }), 5000);
}

function setView(newView) {
    const patch = { view: newView, selectedProductId: null, message: '' };
    if (newView !== 'details') {
        patch.lastViewBeforeDetails = newView;
    }
    setState(patch);
}

function showDetails(productId) {
    const patch = {
        view: 'details',
        selectedProductId: productId,
    };
    if (state.layout.view !== 'details') {
        patch.lastViewBeforeDetails = state.layout.view;
    }
    setState(patch);
}

// --- Утилиты Расчетов ---

function formatCurrency(amount) {
    return amount.toLocaleString('ru-RU', { minimumFractionDigits: 0 }) + ' ₽';
}

function calculateTotalCost() {
    return Object.values(state.items.cartItems).reduce((sum, item) => 
        sum + (item.quantity * item.price), 0);
}

function calculateCartCount() {
    return Object.values(state.items.cartItems).reduce((sum, item) => sum + item.quantity, 0);
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Не удалось прочитать файл.'));
        reader.readAsDataURL(file);
    });
}

function applyProductImageDataUrl(productId, dataUrl) {
    if (!productId || typeof dataUrl !== 'string') {
        return;
    }
    const productIndex = state.items.products.findIndex((product) => product.id === productId);
    if (productIndex === -1) {
        setMessage('Товар не найден. Обновление изображения невозможно.');
        return;
    }

    const undoSnapshot = prepareUndoSnapshot();
    const updatedProducts = [...state.items.products];
    updatedProducts[productIndex] = {
        ...updatedProducts[productIndex],
        image: dataUrl,
    };
    state.items.products = updatedProducts;

    const storedItem = state.items[productId] && typeof state.items[productId] === 'object'
        ? { ...state.items[productId] }
        : {};
    storedItem.img = dataUrl;
    state.items[productId] = storedItem;

    if (undoSnapshot) {
        commitUndoSnapshot(undoSnapshot);
    }

    scheduleStateSave();
    setMessage('Фото товара обновлено. Размер сохранённого состояния увеличится из-за хранения dataURL.');
}

async function handleProductImageReplace(event, productId) {
    if (event && typeof event.stopPropagation === 'function') {
        event.stopPropagation();
    }
    const input = event?.target;
    if (!input || !productId) return;

    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;

    if (file.type && !file.type.startsWith('image/')) {
        setMessage('Пожалуйста, выберите файл изображения.');
        return;
    }

    try {
        const dataUrl = await readFileAsDataUrl(file);
        if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image')) {
            setMessage('Не удалось получить dataURL изображения.');
            return;
        }
        applyProductImageDataUrl(productId, dataUrl);
    } catch (error) {
        console.error('[EDITOR:IMAGE]', error);
        setMessage('Не удалось загрузить изображение. Попробуйте другой файл.');
    }
}

// --- Функции Корзины (ГЛОБАЛЬНЫЕ) ---

function updateCartItemQuantity(productId, change) {
    const currentItem = state.items.cartItems[productId] || {};
    const product = state.items.products.find(p => p.id === productId);

    if (!product) {
        setMessage('Продукт не найден.');
        return;
    }

    const newQuantity = (currentItem.quantity || 0) + change;
    const newCartItems = { ...state.items.cartItems };

    if (newQuantity <= 0) {
        delete newCartItems[productId];
    } else {
        newCartItems[productId] = {
            quantity: newQuantity,
            name: product.name,
            price: product.price,
            unit: product.unit,
        };
    }
    setState({ cartItems: newCartItems });
}

function addToCart(productId) {
    updateCartItemQuantity(productId, 1);
}

function removeFromCart(productId) {
    const item = state.items.cartItems[productId];
    if (item) {
        updateCartItemQuantity(productId, -item.quantity);
    }
}

// --- Функции Админа ---

async function handleAddProduct(productData) {
    const newProduct = {
        id: `prod-${Date.now()}`,
        name: productData.name,
        description: productData.description,
        price: parseFloat(productData.price) || 0,
        unit: productData.unit,
        image: productData.image,
        createdAt: new Date().toISOString(),
    };
    
    const newProducts = [...state.items.products, newProduct];
    setState({ products: newProducts }, () => {
        setMessage(`Продукт "${newProduct.name}" успешно добавлен.`);
    });
}

async function generateDescription(productName) {
    if (!productName) return "Введите название продукта для генерации описания.";
    if (!GEMINI_API_KEY) return "API ключ Gemini не задан. Вставьте ключ в секцию КОНФИГУРАЦИЯ.";

    const systemPrompt = "You are a professional copywriter for a construction materials e-commerce site. Write a concise, engaging, and professional product description (max 4 sentences) for the following product name, focusing on quality, use cases, and key benefits. Respond only with the description text.";
    const userQuery = `Product Name: ${productName}`;
    
    try {
        const payload = {
            contents: [{ parts: [{ text: userQuery }] }],
            systemInstruction: { parts: [{ text: systemPrompt }] },
            tools: [{ "google_search": {} }],
        };
        
        const response = await fetch(`${GEMINI_API_URL}${GEMINI_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        if (!response.ok) {
             const errorBody = await response.json();
             console.error("API error:", errorBody);
             return "Ошибка генерации описания (API). Проверьте ключ.";
        }
        
        const result = await response.json();
        return result.candidates?.[0]?.content?.parts?.[0]?.text || "Не удалось сгенерировать описание.";

    } catch (e) {
        console.error("Error calling Gemini API:", e);
        return "Ошибка генерации описания (Сеть/Парсинг).";
    }
}

const parseCSVToJSON = (csvString) => {
    // [ОГРАНИЧЕНО] - Логика парсинга CSV/JSON (полностью рабочая)
    const lines = csvString.split('\n').filter(line => line.trim() !== '');
    if (lines.length <= 1) return [];

    const HEADER_MAP = {
        'имя': 'name', 'name': 'name', 'базовая цена': 'price_base', 'regular price': 'price_base', 'цена': 'price_base',
        'акционная цена': 'price_sale', 'promotion price': 'price_sale', 'акция': 'price_sale', 'описание': 'description',
        'краткое описание': 'description', 'short description': 'description', 'изображения': 'image', 'images': 'image', 
        'изображение': 'image', 'image url': 'image', 'ед': 'unit', 'unit': 'unit', 'единица измерения': 'unit', 'артикул': 'sku', 'sku': 'sku',
    };
    
    const normalizeHeader = (header) => header.toLowerCase().replace(/[^\w\sа-яё]/gi, '').replace(/\s+/g, ' ').trim();

    const splitCsvLine = (line) => {
        const result = [];
        let current = '';
        let inQuote = false;
        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            if (char === '"') { inQuote = !inQuote; } 
            else if (char === ',' && !inQuote) {
                result.push(current.trim().replace(/^"|"$/g, ''));
                current = '';
            } else { current += char; }
        }
        result.push(current.trim().replace(/^"|"$/g, ''));
        return result;
    };

    const rawHeaders = splitCsvLine(lines[0]); 
    const headers = rawHeaders.map(header => normalizeHeader(header));
    const products = [];
    
    for (let i = 1; i < lines.length; i++) {
        const currentLine = lines[i];
        if (!currentLine.trim()) continue;

        const values = splitCsvLine(currentLine);
        if (values.length !== headers.length) continue;

        let product = { unit: 'шт', description: 'Описание отсутствует', price_base: 0, price_sale: 0 };
        
        for (let j = 0; j < headers.length; j++) {
            const header = headers[j];
            const value = values[j];
            const mappedKey = HEADER_MAP[header] || header;
            
            if (mappedKey.startsWith('price')) {
                let cleanPrice = String(value).replace(/[^\d.,]/g, '').replace(',', '.');
                product[mappedKey] = parseFloat(cleanPrice) || 0;
            } else if (mappedKey === 'name') {
                product.name = value;
            } else if (mappedKey === 'unit') {
                product.unit = value || product.unit; 
            } else if (mappedKey === 'description') {
                const cleanValue = value.replace(/<\/?[^>]+(>|$)/g, "").replace(/\\r\\n/g, ' ').trim();
                if (cleanValue.length > product.description.length && cleanValue.length > 5) {
                    product.description = cleanValue;
                } else if (product.description === 'Описание отсутствует') {
                    product.description = cleanValue;
                }
            } else if (mappedKey === 'image' && value) {
                const imageUrls = value.split('|').map(url => url.trim());
                product.image = imageUrls[0] || '';
            } else {
                product[mappedKey] = value;
            }
        }
        
        const finalPrice = product.price_sale > 0 ? product.price_sale : product.price_base;
        
        if (product.name && finalPrice > 0) {
            products.push({
                id: `prod-${Date.now()}-${i}`,
                name: product.name,
                price: finalPrice,
                unit: product.unit,
                description: product.description,
                image: product.image,
                sku: product.sku || null, 
            });
        }
    }
    return products;
};

// Bulk Import Logic (ГЛОБАЛЬНАЯ)
function handleBulkImport(jsonString) {
    if (!jsonString || jsonString.trim() === '') {
        setMessage("Нет данных для импорта. Вставьте JSON или загрузите файл.");
        return;
    }

    try {
        const productsToImport = JSON.parse(jsonString);
        
        if (!Array.isArray(productsToImport)) {
            setMessage("Ошибка: Данные должны быть массивом JSON.");
            return;
        }
        
        let importCount = 0;
        const newProducts = [...state.items.products];

        productsToImport.forEach(product => {
            if (typeof product === 'object' && product !== null && product.name && product.price > 0 && product.unit) {
                const newProduct = {
                    id: `prod-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
                    name: String(product.name),
                    description: String(product.description || 'Описание отсутствует'),
                    price: parseFloat(product.price) || 0,
                    unit: String(product.unit),
                    image: String(product.image || `https://placehold.co/400x160/2563eb/ffffff?text=${String(product.name).substring(0, 10)}`),
                    createdAt: new Date().toISOString(),
                };
                newProducts.push(newProduct);
                importCount++;
            }
        });
        
        setState({ products: newProducts });
        setMessage(`Успешно импортировано ${importCount} продуктов!`);

    } catch (e) {
        console.error("Критическая ошибка парсинга JSON/импорта:", e);
        setMessage(`Критическая ошибка импорта: Неверный JSON. ${e.message}`);
    }
}

// Отдельная функция для обработки загрузки файла (CSV/JSON)
function handleFileChange(file) {
    if (!file) {
        setMessage("Файл не выбран.");
        window.adminState.jsonInput = '';
        renderAdminContent();
        return;
    }

    const isJson = file.name.endsWith('.json');
    const isCsv = file.name.endsWith('.csv');
    
    if (!isJson && !isCsv) {
        setMessage("Пожалуйста, выберите файл в формате JSON или CSV.");
        window.adminState.jsonInput = '';
        renderAdminContent();
        return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
        const fileContent = event.target.result;
        let parsedData = [];
        
        try {
            if (isJson) {
                parsedData = JSON.parse(fileContent);
                setMessage(`Файл ${file.name} (JSON) успешно загружен. ${parsedData.length} элементов.`);
            } else if (isCsv) {
                parsedData = parseCSVToJSON(fileContent);
                setMessage(`Файл ${file.name} (CSV) успешно преобразован. ${parsedData.length} элементов.`);
            }
            
            window.adminState.jsonInput = JSON.stringify(parsedData, null, 2); 
            renderAdminContent();

        } catch (error) {
            setMessage(`Ошибка парсинга файла: ${error.message}. Проверьте формат данных.`);
            window.adminState.jsonInput = '';
            renderAdminContent();
        }
    };
    reader.readAsText(file);
    
    const fileInput = document.getElementById('json-file-upload');
    if (fileInput) {
        fileInput.value = null;
    }
}


// --- Компоненты Рендеринга ---

function renderHeader() {
    const cartCount = calculateCartCount();
    return `
        <header class="bg-blue-800 shadow-lg sticky top-0 z-40">
            <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex justify-between items-center py-4">
                <h1 class="text-3xl font-bold text-white tracking-wider cursor-pointer" onclick="setView('home')">
                    Строй<span class="text-yellow-400">Маркет</span>
                </h1>
                <nav class="flex items-center space-x-4">
                    <button
                        onclick="setView('home')"
                        class="text-lg font-medium transition duration-150 p-2 rounded-lg ${state.layout.view === 'home' || state.layout.view === 'details' ? 'text-yellow-400 bg-blue-700/50' : 'text-white hover:text-yellow-200 hover:bg-blue-700/50'}"
                    >
                        <span class="js-editable">Каталог</span>
                    </button>
                    <button
                        onclick="setView('admin')"
                        class="text-lg font-medium transition duration-150 p-2 rounded-lg ${state.layout.view === 'admin' ? 'text-yellow-400 bg-blue-700/50' : 'text-white hover:text-yellow-200 hover:bg-blue-700/50'} hidden sm:block"
                    >
                        <span class="js-editable">Админ</span>
                    </button>
                    <button 
                        onclick="setView('cart')" 
                        class="relative p-2 bg-blue-700 rounded-lg hover:bg-blue-600 transition duration-150"
                        aria-label="Корзина"
                    >
                        <svg class="w-6 h-6 text-white" fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewBox="0 0 24 24" stroke="currentColor">
                            <path d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z"></path>
                        </svg>
                        ${calculateCartCount() > 0 ? `
                            <span class="absolute -top-1 -right-1 bg-red-500 text-white text-xs font-bold w-5 h-5 flex items-center justify-center rounded-full border-2 border-blue-800">
                                ${calculateCartCount()}
                            </span>
                        ` : ''}
                    </button>
                </nav>
            </div>
        </header>
    `;
}

function buildEditorInputId(prefix, value) {
    return `${prefix}-${String(value)}`.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function resolveProductImage(product, { fallbackWidth = 400, fallbackHeight = 160 } = {}) {
    const fallback = `https://placehold.co/${fallbackWidth}x${fallbackHeight}/2563eb/ffffff?text=${(product?.name || '').substring(0, 10)}`;
    const override = state.items?.[product.id]?.img;
    const baseImage = product?.image || fallback;
    return override || baseImage || fallback;
}

function renderProductCard(product, index = 0) {
    const itemInCart = state.items.cartItems[product.id];
    const priceHtml = formatCurrency(product.price);
    const productImage = resolveProductImage(product);
    const inputId = buildEditorInputId('replace-photo-card', `${product.id}-${index}`);

    return `
        <div class="bg-white rounded-xl shadow-xl overflow-hidden transform hover:scale-[1.02] transition duration-300 flex flex-col cursor-pointer" onclick="showDetails('${product.id}')">
            <div class="h-40 bg-gray-200 flex items-center justify-center overflow-hidden">
                <img
                    src="${productImage}"
                    alt="${product.name}"
                    class="h-full w-full object-cover"
                    onerror="this.onerror=null; this.src='https://placehold.co/400x160/2563eb/ffffff?text=${product.name.substring(0, 10)}';"
                />
            </div>
            <div class="p-4 flex-grow flex flex-col justify-between">
                <div>
                    <h3 class="text-xl font-semibold text-gray-800 mb-2">${product.name}</h3>
                    <p class="text-sm text-gray-500 mb-3 line-clamp-3">${product.description || "Описание временно отсутствует."}</p>
                </div>
                <div class="mt-4">
                    <p class="text-2xl font-bold text-blue-600">
                        ${priceHtml} <span class="text-sm font-normal text-gray-500">/ ${product.unit}</span>
                    </p>
                    ${!itemInCart ? `
                        <button
                            onclick="event.stopPropagation(); addToCart('${product.id}')"
                            class="mt-3 w-full bg-green-500 text-white py-2 rounded-lg font-semibold hover:bg-green-600 transition duration-150 shadow-md"
                        >
                            В корзину
                        </button>
                    ` : `
                        <div class="mt-3 flex justify-between items-center bg-green-100 rounded-lg p-2">
                            <button
                                onclick="event.stopPropagation(); updateCartItemQuantity('${product.id}', -1)"
                                class="text-xl w-8 h-8 rounded-full bg-green-500 text-white hover:bg-green-600 transition"
                            >
                                -
                            </button>
                            <span class="text-lg font-bold text-green-700 mx-3">${itemInCart.quantity} ${product.unit}</span>
                            <button
                                onclick="event.stopPropagation(); updateCartItemQuantity('${product.id}', 1)"
                                class="text-xl w-8 h-8 rounded-full bg-green-500 text-white hover:bg-green-600 transition"
                            >
                                +
                            </button>
                        </div>
                    `}
                    <div class="editor-only mt-4 space-y-2" onclick="event.stopPropagation()">
                        <label for="${inputId}" class="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white shadow transition hover:bg-slate-800">
                            <i class="fas fa-camera-retro text-xs"></i>
                            <span>Заменить фото</span>
                        </label>
                        <input
                            id="${inputId}"
                            type="file"
                            accept="image/*"
                            class="hidden"
                            onchange="handleProductImageReplace(event, ${JSON.stringify(product.id)})"
                        />
                        <p class="text-xs leading-snug text-amber-600">
                            Изображение сохраняется в состоянии как dataURL и может значительно увеличить размер сохранения.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function renderProductList() {
    const productCards = state.items.products.map((product, index) => renderProductCard(product, index)).join('');
    
    return `
        <div class="grid-container">
            ${state.items.products.length === 0 ? `
                <p class="col-span-full text-center text-gray-500 py-10">
                    Каталог пуст. Перейдите в "Админ" для добавления продуктов.
                </p>
            ` : productCards}
        </div>
    `;
}

function renderProductDetails() {
    const product = state.items.products.find(p => p.id === state.layout.selectedProductId);

    if (!product) {
        return `<div class="p-10 text-center text-red-600">Продукт не найден.</div>`;
    }

    const itemInCart = state.items.cartItems[product.id];
    const priceHtml = formatCurrency(product.price);
    const descriptionHtml = product.description.replace(/\n/g, '<br>');
    const productImage = resolveProductImage(product, { fallbackWidth: 800, fallbackHeight: 600 });
    const detailInputId = buildEditorInputId('replace-photo-detail', product.id);

    return `
        <div class="max-w-5xl mx-auto p-6 bg-white rounded-xl shadow-2xl">
            <button onclick="setView('home')" class="mb-6 text-blue-600 hover:text-blue-800 flex items-center transition">
                <svg class="w-5 h-5 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18"></path></svg>
                Назад в Каталог
            </button>

            <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
                <!-- Image Area -->
                <div class="flex flex-col gap-4">
                    <div class="relative bg-gray-100 rounded-lg overflow-hidden h-96">
                        <img
                            src="${productImage}"
                            alt="${product.name}"
                            class="w-full h-full object-cover"
                            onerror="this.onerror=null; this.src='https://placehold.co/800x600/2563eb/ffffff?text=${product.name}';"
                        />
                    </div>
                    <div class="editor-only space-y-2" onclick="event.stopPropagation()">
                        <label for="${detailInputId}" class="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white shadow transition hover:bg-slate-800">
                            <i class="fas fa-camera-retro text-xs"></i>
                            <span>Заменить фото</span>
                        </label>
                        <input
                            id="${detailInputId}"
                            type="file"
                            accept="image/*"
                            class="hidden"
                            onchange="handleProductImageReplace(event, ${JSON.stringify(product.id)})"
                        />
                        <p class="text-xs leading-snug text-amber-600">
                            Изображение сохраняется в состоянии как dataURL и может значительно увеличить размер сохранения.
                        </p>
                    </div>
                </div>

                <!-- Details Area -->
                <div>
                    <h2 class="text-4xl font-extrabold text-gray-900 mb-3">${product.name}</h2>
                    <p class="text-3xl font-bold text-red-600 mb-6">
                        ${priceHtml} <span class="text-lg font-normal text-gray-500">/ ${product.unit}</span>
                    </p>

                    <h3 class="text-xl font-semibold text-gray-700 border-b pb-1 mb-3">Описание</h3>
                    <p class="text-gray-600 mb-6 leading-relaxed">${descriptionHtml}</p>

                    <!-- Add to Cart / Quantity Control -->
                    ${!itemInCart ? `
                        <button 
                            onclick="addToCart('${product.id}')"
                            class="mt-4 w-full sm:w-2/3 bg-green-600 text-white py-3 rounded-xl text-xl font-semibold hover:bg-green-700 transition duration-150 shadow-lg"
                        >
                            Добавить в корзину
                        </button>
                    ` : `
                        <div class="mt-4 flex flex-col sm:flex-row items-center space-y-3 sm:space-y-0 sm:space-x-4">
                            <div class="flex items-center border border-gray-300 rounded-xl bg-green-50 p-1 w-full sm:w-auto">
                                <button
                                    onclick="updateCartItemQuantity('${product.id}', -1)"
                                    class="text-2xl w-10 h-10 text-green-700 hover:bg-green-100 rounded-lg transition"
                                >
                                    −
                                </button>
                                <span class="text-xl font-bold text-green-800 mx-4">${itemInCart.quantity} ${product.unit}</span>
                                <button
                                    onclick="updateCartItemQuantity('${product.id}', 1)"
                                    class="text-2xl w-10 h-10 text-green-700 hover:bg-green-100 rounded-lg transition"
                                >
                                    +
                                </button>
                            </div>
                            <button
                                onclick="removeFromCart('${product.id}')"
                                class="text-sm text-red-500 hover:text-red-700 transition underline p-2"
                            >
                                Удалить из корзины
                            </button>
                        </div>
                    `}
                </div>
            </div>
        </div>
    `;
}

function renderCartView() {
    const totalCost = calculateTotalCost();

    const cartItemsHtml = Object.entries(state.items.cartItems).map(([productId, item]) => `
        <div class="flex items-center bg-white p-4 rounded-xl shadow-lg border-l-4 border-blue-500">
            <div class="flex-grow">
                <h3 class="text-xl font-semibold text-gray-800">${item.name}</h3>
                <p class="text-gray-500">${formatCurrency(item.price)} / ${item.unit}</p>
            </div>
            <div class="flex items-center space-x-4">
                <div class="flex items-center border border-gray-300 rounded-lg">
                    <button
                        onclick="updateCartItemQuantity('${productId}', -1)"
                        class="text-lg px-3 py-1 text-red-500 hover:bg-gray-100 rounded-l-lg transition"
                    >
                        -
                    </button>
                    <span class="text-lg font-medium px-4 border-l border-r">${item.quantity}</span>
                    <button
                        onclick="updateCartItemQuantity('${productId}', 1)"
                        class="text-lg px-3 py-1 text-green-500 hover:bg-gray-100 rounded-r-lg transition"
                    >
                        +
                    </button>
                </div>
                <button
                    onclick="removeFromCart('${productId}')"
                    class="text-red-500 hover:text-red-700 transition"
                    title="Удалить"
                >
                    <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                </button>
            </div>
            <div class="ml-8 text-lg font-bold text-blue-700 w-28 text-right">
                ${formatCurrency(item.quantity * item.price)}
            </div>
        </div>
    `).join('');

    return `
        <div class="max-w-4xl mx-auto p-6">
            <h2 class="text-4xl font-bold text-gray-800 mb-8 border-b pb-2">Ваша Корзина</h2>
            
            ${calculateCartCount() === 0 ? `
                <div class="text-center py-20 bg-gray-50 rounded-xl shadow-inner">
                    <p class="text-xl text-gray-600 mb-4">Ваша корзина пуста.</p>
                    <button 
                        onclick="setView('home')" 
                        class="bg-blue-600 text-white px-6 py-3 rounded-lg text-lg font-semibold hover:bg-blue-700 transition duration-150"
                    >
                        Начать покупки
                    </button>
                </div>
            ` : `
                <div class="space-y-6">
                    ${cartItemsHtml}
                    
                    <div class="mt-8 pt-6 border-t-2 border-dashed border-gray-300 flex justify-between items-center bg-white p-6 rounded-xl shadow-xl">
                        <span class="text-2xl font-bold text-gray-700">Итого:</span>
                        <span class="text-3xl font-extrabold text-red-600">
                            ${formatCurrency(totalCost)}
                        </span>
                    </div>
                    <button 
                        onclick="setMessage('Это демо-версия. Оплата не производится. Спасибо за покупки!')"
                        class="w-full bg-green-600 text-white py-3 rounded-xl text-xl font-bold hover:bg-green-700 transition duration-150 shadow-lg mt-4"
                    >
                        Оформить заказ
                    </button>
                </div>
            `}
        </div>
    `;
}

function renderAdminPanel() {
    let adminState = window.adminState;

    async function handleGenerateClick() {
        if (!window.adminState.productName) return;
        window.adminState.isGenerating = true;
        renderAdminContent(); // Показываем "Генерация..."
        
        const desc = await generateDescription(window.adminState.productName);
        
        window.adminState.productDescription = desc;
        window.adminState.isGenerating = false;
        renderAdminContent(); // Обновляем поле описания и кнопку
    }

    const singleFormHtml = `
        <form id="singleProductForm" class="bg-white p-8 rounded-xl shadow-2xl space-y-6">
            <h3 class="text-2xl font-semibold text-blue-600 mb-4">Добавить Новый Продукт (По одному)</h3>

            <div>
                <label for="name" class="block text-sm font-medium text-gray-700 mb-1">Название Продукта (обязательно)</label>
                <input
                    type="text"
                    id="name"
                    value="${adminState.productName}"
                    oninput="window.adminState.productName = this.value; renderAdminContent();"
                    class="w-full border border-gray-300 rounded-lg p-3 focus:ring-blue-500 focus:border-blue-500 transition"
                    required
                />
            </div>
            
            <div class="flex space-x-4">
                <div class="w-1/2">
                    <label for="price" class="block text-sm font-medium text-gray-700 mb-1">Цена (₽)</label>
                    <input
                        type="number"
                        id="price"
                        value="${adminState.productPrice}"
                        oninput="window.adminState.productPrice = this.value; renderAdminContent();"
                        class="w-full border border-gray-300 rounded-lg p-3 focus:ring-blue-500 focus:border-blue-500 transition"
                        required
                        min="0.01"
                        step="any"
                    />
                </div>
                <div class="w-1/2">
                    <label for="unit" class="block text-sm font-medium text-gray-700 mb-1">Единица измерения</label>
                    <select
                        id="unit"
                        onchange="window.adminState.productUnit = this.value; renderAdminContent();"
                        class="w-full border border-gray-300 rounded-lg p-3 focus:ring-blue-500 focus:border-blue-500 transition bg-white"
                    >
                        ${['шт', 'м²', 'кг', 'м³', 'уп'].map(u => `<option value="${u}" ${adminState.productUnit === u ? 'selected' : ''}>${u}</option>`).join('')}
                    </select>
                </div>
            </div>
            
            <div>
                <label for="image" class="block text-sm font-medium text-gray-700 mb-1">URL Изображения (Placehold)</label>
                <input
                    type="text"
                    id="image"
                    value="${adminState.productImage}"
                    oninput="window.adminState.productImage = this.value; renderAdminContent();"
                    class="w-full border border-gray-300 rounded-lg p-3 focus:ring-blue-500 focus:border-blue-500 transition"
                />
            </div>

            <div>
                <label for="description" class="block text-sm font-medium text-gray-700 mb-1">Описание Продукта (обязательно)</label>
                <div class="flex space-x-2">
                    <textarea
                        id="description"
                        oninput="window.adminState.productDescription = this.value; renderAdminContent();"
                        rows="4"
                        class="flex-grow border border-gray-300 rounded-lg p-3 focus:ring-blue-500 focus:border-blue-500 transition"
                        required
                    >${adminState.productDescription}</textarea>
                    <button
                        type="button"
                        onclick="handleGenerateClick()"
                        disabled="${adminState.isGenerating || !adminState.productName}"
                        class="self-start px-4 py-3 rounded-lg text-white font-semibold transition duration-150 ${
                            adminState.isGenerating || !adminState.productName ? 'bg-gray-400 cursor-not-allowed' : 'bg-purple-600 hover:bg-purple-700'
                        }"
                    >
                        ${adminState.isGenerating ? 'Генерация...' : 'Сгенерировать (Gemini)'}
                    </button>
                </div>
                <p class="mt-2 text-xs text-gray-500">Используйте Gemini для создания продающего описания.</p>
            </div>

            <button
                type="submit"
                class="w-full py-3 rounded-lg text-white text-xl font-bold transition duration-150 shadow-md bg-blue-600 hover:bg-blue-700"
            >
                Добавить Продукт в Каталог
            </button>
        </form>
    `;
    
    const adminContentElement = document.getElementById('admin-content');
    
    if (!adminContentElement) {
        return; 
    }
    
    adminContentElement.innerHTML = `
        <div class="max-w-3xl mx-auto p-6 space-y-10">
            <h2 class="text-4xl font-bold text-gray-800 border-b pb-2">Панель Администратора</h2>

            <!-- 1. Bulk Import Section -->
            <div class="bg-white p-8 rounded-xl shadow-2xl space-y-4">
                <h3 class="text-2xl font-semibold text-purple-600 mb-4">Массовый Импорт Каталога (JSON / CSV)</h3>
                <p class="text-gray-600 text-sm">Данные импортируются в локальное хранилище браузера (localStorage).</p>
                
                <div class="border-2 border-dashed border-gray-300 rounded-lg p-4 bg-gray-50 hover:bg-gray-100 transition duration-150">
                    <label for="json-file-upload" class="block text-sm font-medium text-gray-700 mb-2">Загрузить файл каталога (.json, .csv)</label>
                    <input
                        type="file"
                        id="json-file-upload"
                        accept=".json, .csv"
                        onchange="handleFileChange(this.files[0])"
                        class="w-full text-sm text-gray-500
                            file:mr-4 file:py-2 file:px-4
                            file:rounded-full file:border-0
                            file:text-sm file:font-semibold
                            file:bg-purple-100 file:text-purple-700
                            hover:file:bg-purple-200"
                    />
                </div>
                
                <div class="relative">
                    <textarea
                        id="jsonInput"
                        oninput="window.adminState.jsonInput = this.value; renderAdminContent();"
                        rows="8"
                        placeholder="Вставьте JSON-массив или содержимое CSV-файла сюда..."
                        class="w-full border border-gray-300 rounded-lg p-3 focus:ring-purple-500 focus:border-purple-500 transition"
                    >${adminState.jsonInput}</textarea>
                </div>


                <button
                    onclick="handleBulkImport(window.adminState.jsonInput)"
                    class="w-full py-3 rounded-lg text-white text-xl font-bold transition duration-150 shadow-md ${
                        !adminState.jsonInput ? 'bg-gray-500 cursor-not-allowed' : 'bg-purple-600 hover:bg-purple-700'
                    }"
                >
                    Загрузить Каталог (Пакетно)
                </button>
            </div>
            
            <!-- 2. Single Product Addition Section -->
            ${singleFormHtml}
        </div>
    `;

    if (window.editorMode) {
        window.editorMode.refresh();
        refreshCatalogSortables();
    }

    const form = document.getElementById('singleProductForm');
    if (form) {
        form.onsubmit = function(e) {
            e.preventDefault();
            if (!adminState.productName || !adminState.productPrice || !adminState.productDescription) {
                setMessage("Пожалуйста, заполните все обязательные поля (Название, Цена, Описание).");
                return;
            }
            handleAddProduct({
                name: adminState.productName,
                price: adminState.productPrice,
                unit: adminState.productUnit,
                description: adminState.productDescription,
                image: adminState.productImage,
            });
            window.adminState = {
                productName: '', productPrice: '', productUnit: 'шт', 
                productImage: 'https://placehold.co/400x160/2563eb/ffffff?text=Material', 
                productDescription: '', isGenerating: false, jsonInput: adminState.jsonInput
            };
            renderAdminContent(); 
        };
    }
}

function renderMessageModal() {
    if (!state.meta.message) return '';
    
    return `
        <div id="message-modal" class="modal fixed inset-0 bg-gray-600 bg-opacity-50 flex items-center justify-center z-50 p-4">
            <div class="bg-white rounded-xl shadow-2xl p-6 max-w-sm w-full transform transition-all">
                <p class="text-gray-800 font-medium mb-4">${state.meta.message}</p>
                <button
                    onclick="setState({ message: '' })"
                    class="w-full bg-blue-600 text-white py-2 rounded-lg hover:bg-blue-700 transition duration-150"
                >
                    Закрыть
                </button>
            </div>
        </div>
    `;
}

// --- Главная Функция Рендеринга ---

function render() {
    const appContainer = document.getElementById('app');
    let contentHtml = '';

    switch (state.layout.view) {
        case 'cart':
            contentHtml = renderCartView();
            break;
        case 'details':
            contentHtml = renderProductDetails();
            break;
        case 'admin':
            contentHtml = `<div id="admin-content" class="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8"></div>`;
            break;
        case 'home':
        default:
            contentHtml = renderProductList();
    }

    appContainer.innerHTML = `
        ${renderHeader()}
        <main class="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
            ${contentHtml}
        </main>
        ${renderMessageModal()}
    `;

    syncEditableContent({ captureMissing: true });

    if (state.layout.view === 'admin') {
        renderAdminContent();
    }

    if (window.editorMode) {
        window.editorMode.refresh();
        refreshCatalogSortables();
    }
}

function renderAdminContent() {
     if (state.layout.view === 'admin') {
        setTimeout(renderAdminPanel, 0);
     }
}

// Привязываем функции к window для доступа из HTML
window.setState = setState;
window.setMessage = setMessage;
window.setView = setView;
window.showDetails = showDetails;
window.addToCart = addToCart;
window.updateCartItemQuantity = updateCartItemQuantity;
window.removeFromCart = removeFromCart;
window.handleBulkImport = handleBulkImport;
window.handleAddProduct = handleAddProduct;
window.handleFileChange = handleFileChange;
window.renderAdminContent = renderAdminContent;
window.handleProductImageReplace = handleProductImageReplace;
window.generateDescription = generateDescription; // Сделаем генерацию глобальной для тестов
if (!window.undoStateChange) window.undoStateChange = undoStateChange;
if (!window.redoStateChange) window.redoStateChange = redoStateChange;

// Инициализация при загрузке страницы
window.addEventListener('load', () => {
    initializeState()
        .catch((error) => {
            console.error('[RENDER:INIT]', error);
        })
        .finally(() => {
            render();
            if (window.editorMode) {
                window.editorMode.setup();
                window.editorMode.refresh();
                refreshCatalogSortables();
            }
        });
});
