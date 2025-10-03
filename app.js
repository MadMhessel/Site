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
        generate: '/api/generate',
        health: '/api/health',
        timeout: 20000,
    },
};

const GEMINI_PROXY_ENDPOINT = CONFIG.api.generate;
const LOGO_URL = 'https://i.imgur.com/RXyoozd.png';
const PLACEHOLDER_IMAGE = 'https://placehold.co/600x400/e2e8f0/475569?text=No+Image';
const FALLBACK_PRODUCTS = [
    {
        id: 'demo-1',
        name: 'Пеноблок D600 (600x200x300)',
        price: 350,
        unit: 'шт',
        category: 'Демо-товары',
        description: 'Легкий и прочный пеноблок.',
        image: 'https://placehold.co/400x300/4a7a9c/ffffff?text=Пеноблок',
    },
];
const VIEW_ROUTES = {
    home: '',
    catalog: 'catalog',
    cart: 'cart',
    checkout: 'checkout',
    admin: 'admin',
    'online-calc': 'online-calc',
    payment: 'payment',
    delivery: 'delivery',
    about: 'about',
    contacts: 'contacts',
};

const EDIT_QUERY_PARAM = 'edit';

function isTruthyEditValue(rawValue) {
    if (rawValue === null || rawValue === undefined) {
        return true;
    }
    const normalized = String(rawValue).trim().toLowerCase();
    return normalized === ''
        || normalized === '1'
        || normalized === 'true'
        || normalized === 'on';
}

function getEditFlag() {
    if (typeof window === 'undefined') {
        return false;
    }

    if (window.EditorSession && typeof window.EditorSession.isEditModeRequested === 'function') {
        try {
            const requested = window.EditorSession.isEditModeRequested();
            if (typeof requested === 'boolean') {
                return requested;
            }
            return Boolean(requested);
        } catch (error) {
            console.warn('[EDITOR:FLAG]', 'session-read', error);
        }
    }

    try {
        const params = new URLSearchParams(window.location.search || '');
        if (params.has(EDIT_QUERY_PARAM)) {
            const value = params.get(EDIT_QUERY_PARAM);
            return isTruthyEditValue(value);
        }
    } catch (error) {
        console.warn('[EDITOR:FLAG]', 'search-parse', error);
    }

    const hash = window.location.hash || '';
    if (!hash) {
        return false;
    }
    const match = hash.match(/[?#&]edit(?:=([^&#]+))?/i);
    if (!match) {
        return false;
    }
    const [, hashValue] = match;
    return isTruthyEditValue(hashValue);
}

const STATE_STORAGE_KEY = CONFIG.storage.stateKey;
const STATE_BACKUP_PREFIX = CONFIG.storage.backupPrefix;
const MAX_STATE_BACKUPS = CONFIG.storage.maxBackups;
const STATE_SAVE_DEBOUNCE = 500;
const EDITOR_PIN_STORAGE_KEY = CONFIG.editor.pinStorageKey;
const EDITOR_PIN_DIGEST_PREFIX = 'sha256:';
const CATALOG_ORDER_STORAGE_KEY = CONFIG.storage.catalogOrderKey;
const CATALOG_ORDER_VERSION = 1;
const SNAPSHOT_VERSION = 1;

var UNDO_STACK_LIMIT = typeof UNDO_STACK_LIMIT === 'number' ? UNDO_STACK_LIMIT : CONFIG.editor.historyDepth;
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

const editorInputTimers = new Map();

function flushEditorDebounceKey(key) {
    const entry = editorInputTimers.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    editorInputTimers.delete(key);
    if (typeof entry.flush === 'function') {
        entry.flush();
    }
}

function flushAllEditorDebounceKeys() {
    Array.from(editorInputTimers.keys()).forEach((key) => flushEditorDebounceKey(key));
}

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
        stopSlider();
        render();
        if (state.layout.view === 'home') {
            startSlider();
        }
        if (window.editorMode) {
            window.editorMode.refresh();
            refreshCatalogSortables();
        }
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

function bufferToHex(buffer) {
    return Array.from(buffer).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBuffer(hex) {
    if (typeof hex !== 'string' || !hex.trim()) {
        return new Uint8Array(0);
    }
    const sanitized = hex.trim().replace(/[^0-9a-f]/gi, '');
    if (sanitized.length % 2 !== 0) {
        return new Uint8Array(0);
    }
    const bytes = new Uint8Array(sanitized.length / 2);
    for (let index = 0; index < sanitized.length; index += 2) {
        bytes[index / 2] = parseInt(sanitized.slice(index, index + 2), 16);
    }
    return bytes;
}

function fallbackHash(value) {
    const normalized = typeof value === 'string' ? value : String(value ?? '');
    if (!normalized) return '';
    let hash = 0;
    for (let index = 0; index < normalized.length; index += 1) {
        hash = ((hash << 5) - hash) + normalized.charCodeAt(index);
        hash |= 0; // eslint-disable-line no-bitwise
    }
    return Math.abs(hash).toString(16);
}

async function digestLegacyPin(pin) {
    const normalized = typeof pin === 'string' ? pin.trim() : '';
    if (!normalized) {
        return '';
    }
    if (typeof window !== 'undefined' && window.crypto?.subtle && typeof TextEncoder !== 'undefined') {
        const encoder = new TextEncoder();
        const data = encoder.encode(normalized);
        const digest = await window.crypto.subtle.digest('SHA-256', data);
        return bufferToHex(new Uint8Array(digest));
    }
    return fallbackHash(normalized);
}

async function digestPinWithSalt(pin, saltBytes) {
    const normalized = typeof pin === 'string' ? pin.trim() : '';
    if (!normalized) {
        return '';
    }
    const saltHex = bufferToHex(saltBytes);
    if (typeof window !== 'undefined' && window.crypto?.subtle && typeof TextEncoder !== 'undefined') {
        const encoder = new TextEncoder();
        const payload = encoder.encode(`${normalized}:${saltHex}`);
        const digest = await window.crypto.subtle.digest('SHA-256', payload);
        return bufferToHex(new Uint8Array(digest));
    }
    return fallbackHash(`${saltHex}:${normalized}`);
}

async function createPinRecord(pin) {
    const salt = new Uint8Array(CONFIG.editor.saltBytes);
    if (typeof window !== 'undefined' && window.crypto?.getRandomValues) {
        window.crypto.getRandomValues(salt);
    } else {
        for (let index = 0; index < salt.length; index += 1) {
            salt[index] = Math.floor(Math.random() * 256);
        }
    }
    const hash = await digestPinWithSalt(pin, salt);
    if (!hash) {
        return null;
    }
    return {
        version: 1,
        algo: 'SHA-256',
        salt: bufferToHex(salt),
        hash,
    };
}

async function verifyPinRecord(pin, record) {
    if (!record) {
        return false;
    }
    if (typeof record === 'string') {
        const normalizedStored = record.startsWith(EDITOR_PIN_DIGEST_PREFIX)
            ? record.slice(EDITOR_PIN_DIGEST_PREFIX.length)
            : record;
        const computed = await digestLegacyPin(pin);
        return Boolean(computed) && computed === normalizedStored;
    }
    if (typeof record === 'object' && record.hash && record.salt) {
        const saltBytes = hexToBuffer(record.salt);
        if (!saltBytes.length) {
            return false;
        }
        const computed = await digestPinWithSalt(pin, saltBytes);
        return Boolean(computed) && computed === record.hash;
    }
    return false;
}

async function ensureEditorPin({ allowCreate = true } = {}) {
    if (typeof window === 'undefined') {
        return false;
    }

    const storage = getSafeLocalStorage();
    if (!storage) {
        return window.confirm('Локальное хранилище недоступно. Продолжить без проверки PIN?');
    }

    const storedValue = storage.getItem(EDITOR_PIN_STORAGE_KEY);
    if (!storedValue) {
        if (!allowCreate) {
            return false;
        }
        const shouldCreate = window.confirm('Для работы редактора необходимо создать локальный PIN. Продолжить?');
        if (!shouldCreate) {
            return false;
        }
        const firstPin = window.prompt('Введите новый PIN (минимум 4 символа):');
        if (!firstPin || firstPin.trim().length < CONFIG.editor.pinMinLength) {
            window.alert('PIN должен содержать минимум 4 символа.');
            return false;
        }
        const confirmation = window.prompt('Повторите PIN для подтверждения:');
        if (confirmation !== firstPin) {
            window.alert('PIN не совпадает.');
            return false;
        }
        const record = await createPinRecord(firstPin);
        if (!record) {
            window.alert('Не удалось сохранить PIN. Попробуйте снова.');
            return false;
        }
        storage.setItem(EDITOR_PIN_STORAGE_KEY, JSON.stringify(record));
        return true;
    }

    let storedRecord = null;
    try {
        storedRecord = JSON.parse(storedValue);
    } catch (error) {
        storedRecord = storedValue;
    }

    const pin = window.prompt('Введите PIN редактора:');
    if (pin === null) {
        return false;
    }
    if (!pin.trim()) {
        window.alert('PIN не может быть пустым.');
        return false;
    }
    const success = await verifyPinRecord(pin, storedRecord);
    if (success && typeof storedRecord === 'string') {
        const upgraded = await createPinRecord(pin);
        if (upgraded) {
            storage.setItem(EDITOR_PIN_STORAGE_KEY, JSON.stringify(upgraded));
        }
    }
    if (!success) {
        window.alert('Неверный PIN.');
    }
    return success;
}


const Editor = (() => {
    const state = {
        isEnabled: false,
        isActive: false,
        isAuthorized: false,
        authorizationPromise: null,
        button: null,
        panel: null,
        undoButton: null,
        redoButton: null,
        exportButton: null,
        importButton: null,
        importInput: null,
        healthIndicator: null,
        healthText: null,
        handlers: new WeakMap(),
        boundListeners: [],
        initialized: false,
    };

    const documentAvailable = typeof document !== 'undefined';

    const bind = (target, type, handler, options) => {
        if (!target || typeof target.addEventListener !== 'function') return;
        target.addEventListener(type, handler, options);
        state.boundListeners.push({ target, type, handler, options });
    };

    const unbindAll = () => {
        state.boundListeners.forEach(({ target, type, handler, options }) => {
            target.removeEventListener(type, handler, options);
        });
        state.boundListeners.length = 0;
    };

    const emitEditorChanged = (element, trigger) => {
        const text = element.textContent ?? '';
        element.textContent = text;
        if (typeof computeEditorKey === 'function') {
            computeEditorKey(element);
        }
        const event = new CustomEvent('editor:changed', {
            bubbles: true,
            detail: { text, trigger },
        });
        element.dispatchEvent(event);
    };

    const detachHandler = (element) => {
        const handler = state.handlers.get(element);
        if (!handler) return;
        element.removeEventListener('input', handler);
        element.removeEventListener('blur', handler);
        state.handlers.delete(element);
    };

    const attachHandler = (element) => {
        if (state.handlers.has(element)) return;
        const listener = (event) => emitEditorChanged(element, event.type);
        element.addEventListener('input', listener);
        element.addEventListener('blur', listener);
        state.handlers.set(element, listener);
    };

    const updateToggleVisibility = () => {
        if (!state.button) return;
        const shouldShow = Boolean(state.isEnabled);
        state.button.style.display = shouldShow ? 'inline-flex' : 'none';
        state.button.hidden = !shouldShow;
        state.button.setAttribute('aria-hidden', shouldShow ? 'false' : 'true');
    };

    const updateButtonState = () => {
        if (!state.button) return;
        const label = state.isActive ? 'Выключить редактирование' : 'Редактировать';
        state.button.textContent = label;
        state.button.setAttribute('aria-pressed', String(state.isActive));
        state.button.setAttribute('aria-label', state.isActive ? 'Выключить режим редактирования' : 'Включить режим редактирования');
    };

    const updateBodyClass = () => {
        if (!documentAvailable || !document.body) return;
        document.body.classList.toggle(CONFIG.classes.editorMode, Boolean(state.isEnabled && state.isActive));
    };

    const updatePanelVisibility = () => {
        if (!state.panel) return;
        const shouldShow = Boolean(state.isEnabled && state.isActive);
        state.panel.style.display = shouldShow ? 'flex' : 'none';
        state.panel.hidden = !shouldShow;
        state.panel.setAttribute('aria-hidden', shouldShow ? 'false' : 'true');
    };

    const applyEditableState = () => {
        if (!documentAvailable) return;
        const elements = document.querySelectorAll(CONFIG.selectors.editable);
        elements.forEach((element) => {
            if (!state.isActive || !state.isEnabled) {
                detachHandler(element);
                if (element.hasAttribute('contenteditable')) {
                    element.removeAttribute('contenteditable');
                }
                element.removeAttribute('aria-live');
                return;
            }
            attachHandler(element);
            if (typeof computeEditorKey === 'function') {
                computeEditorKey(element);
            }
            element.setAttribute('contenteditable', 'plaintext-only');
            if (element.contentEditable !== 'plaintext-only') {
                element.setAttribute('contenteditable', 'true');
            }
            element.setAttribute('aria-live', 'polite');
        });
        if (state.isActive && state.isEnabled) {
            syncEditableContent({ captureMissing: true });
        }
        updatePanelVisibility();
        refreshCatalogSortables();
    };

    const flushPendingEdits = () => {
        if (typeof flushAllEditorDebounceKeys === 'function') {
            flushAllEditorDebounceKeys();
        }
    };

    const handleUndoClick = (event) => {
        event.preventDefault();
        if (!state.isActive || !state.isEnabled) return;
        undoStateChange();
    };

    const handleRedoClick = (event) => {
        event.preventDefault();
        if (!state.isActive || !state.isEnabled) return;
        redoStateChange();
    };

    const handleExportClick = (event) => {
        event.preventDefault();
        if (!state.isActive || !state.isEnabled) return;
        exportStateSnapshot();
    };

    const handleImportClick = (event) => {
        event.preventDefault();
        if (!state.isActive || !state.isEnabled || !state.importInput) return;
        if (typeof window !== 'undefined') {
            const confirmed = window.confirm('Импорт заменит текущее состояние. Продолжить?');
            if (!confirmed) {
                return;
            }
        }
        state.importInput.value = '';
        state.importInput.click();
    };

    const handleImportChange = async (event) => {
        const input = event?.target;
        const selectedFile = input?.files?.[0];
        if (selectedFile) {
            await importStateFromFile(selectedFile);
        }
        if (input) {
            input.value = '';
        }
    };

    const initializePanel = () => {
        if (!documentAvailable || !state.panel) return;
        state.undoButton = state.panel.querySelector(CONFIG.selectors.editorUndo);
        state.redoButton = state.panel.querySelector(CONFIG.selectors.editorRedo);
        state.exportButton = state.panel.querySelector(CONFIG.selectors.editorExport);
        state.importButton = state.panel.querySelector(CONFIG.selectors.editorImport);
        state.importInput = document.querySelector(CONFIG.selectors.editorImportInput);
        state.healthIndicator = state.panel.querySelector(CONFIG.selectors.editorHealthIndicator);
        state.healthText = state.panel.querySelector(CONFIG.selectors.editorHealthText);

        if (state.undoButton) bind(state.undoButton, 'click', handleUndoClick);
        if (state.redoButton) bind(state.redoButton, 'click', handleRedoClick);
        if (state.exportButton) bind(state.exportButton, 'click', handleExportClick);
        if (state.importButton) bind(state.importButton, 'click', handleImportClick);
        if (state.importInput) bind(state.importInput, 'change', handleImportChange);
    };

    const requestAuthorization = async () => {
        if (state.isAuthorized) {
            return true;
        }
        if (state.authorizationPromise) {
            return state.authorizationPromise;
        }
        const promise = ensureEditorPin({ allowCreate: true })
            .then((authorized) => {
                state.authorizationPromise = null;
                if (authorized) {
                    state.isAuthorized = true;
                }
                return authorized;
            })
            .catch((error) => {
                state.authorizationPromise = null;
                console.error('[EDITOR:AUTH]', error);
                return false;
            });
        state.authorizationPromise = promise;
        return promise;
    };

    const activate = async () => {
        state.isEnabled = true;
        updateToggleVisibility();
        const authorized = await requestAuthorization();
        if (!authorized) {
            return false;
        }
        state.isActive = true;
        updateBodyClass();
        updateButtonState();
        applyEditableState();
        updatePanelVisibility();
        updateEditorHistoryButtons();
        return true;
    };

    const deactivate = () => {
        if (!state.isActive) return;
        flushPendingEdits();
        state.isActive = false;
        updateBodyClass();
        applyEditableState();
        updateButtonState();
        updatePanelVisibility();
        updateEditorHistoryButtons();
    };

    const toggle = async () => {
        if (state.isActive) {
            deactivate();
            return;
        }
        await activate();
    };

    const handleToggleClick = async (event) => {
        event.preventDefault();
        await toggle();
    };

    const handleKeydown = async (event) => {
        if (event.defaultPrevented) return;
        const key = event.key?.toLowerCase?.() || event.key;
        if ((event.ctrlKey || event.metaKey) && key === 'e') {
            event.preventDefault();
            if (!state.isEnabled) {
                state.isEnabled = true;
                updateToggleVisibility();
            }
            await toggle();
        } else if (event.key === 'Escape' && state.isActive) {
            event.preventDefault();
            deactivate();
        }
    };

    const refreshHealthIndicator = (ok, message = '') => {
        if (!state.healthIndicator) return;
        state.healthIndicator.classList.remove('bg-green-500', 'bg-red-500', 'bg-gray-300');
        const statusClass = ok === true ? 'bg-green-500' : ok === false ? 'bg-red-500' : 'bg-gray-300';
        state.healthIndicator.classList.add(statusClass);
        if (state.healthText) {
            state.healthText.textContent = ok ? 'Онлайн' : 'Нет связи';
            if (message) {
                state.healthText.setAttribute('title', message);
            } else {
                state.healthText.removeAttribute('title');
            }
        }
    };

    const refresh = () => {
        state.isEnabled = state.isEnabled || getEditFlag();
        updateToggleVisibility();
        updateButtonState();
        updateBodyClass();
        applyEditableState();
        updatePanelVisibility();
        updateEditorHistoryButtons();
    };

    const init = () => {
        if (!documentAvailable || state.initialized) return;
        state.isEnabled = getEditFlag();
        state.button = document.querySelector(CONFIG.selectors.editorToggle);
        state.panel = document.querySelector(CONFIG.selectors.editorPanel);
        if (state.panel) {
            initializePanel();
        }
        updateToggleVisibility();
        updateButtonState();
        updatePanelVisibility();
        if (state.button) {
            bind(state.button, 'click', handleToggleClick);
        }
        bind(document, 'keydown', handleKeydown);
        state.initialized = true;
        refresh();
        if (window.App?.Api?.checkHealth) {
            window.App.Api.checkHealth()
                .then((result) => {
                    const ok = result?.ok !== false;
                    refreshHealthIndicator(ok, result?.message || '');
                })
                .catch((error) => {
                    refreshHealthIndicator(false, error.message || 'Ошибка подключения');
                });
        }
    };

    const destroy = () => {
        if (!state.initialized) return;
        deactivate();
        unbindAll();
        const elements = documentAvailable ? document.querySelectorAll(CONFIG.selectors.editable) : [];
        elements.forEach((element) => detachHandler(element));
        state.initialized = false;
        state.button = null;
        state.panel = null;
        state.isEnabled = false;
        state.isAuthorized = false;
        state.authorizationPromise = null;
        updateToggleVisibility();
        updatePanelVisibility();
    };

    return {
        state,
        init,
        setup: init,
        refresh,
        toggle: () => toggle(),
        enter: () => activate(),
        exit: () => deactivate(),
        destroy,
        updateHealthStatus: refreshHealthIndicator,
    };
})();

window.editorMode = Editor;
updateEditorHistoryButtons();

function getHashForView(view) {
    const segment = VIEW_ROUTES[view] ?? '';
    return segment ? `#/${segment}` : '#/';
}

function buildProductHash(slug) {
    const safeSlug = slug ? encodeURIComponent(slug) : '';
    return safeSlug ? `#/product/${safeSlug}` : '#/';
}

function buildCategoryHash(slug) {
    const safeSlug = slug ? encodeURIComponent(slug) : '';
    return safeSlug ? `#/category/${safeSlug}` : getHashForView('catalog');
}

function buildSubcategoryHash(categorySlug, subcategorySlug) {
    const categoryPart = categorySlug ? encodeURIComponent(categorySlug) : '';
    const subcategoryPart = subcategorySlug ? encodeURIComponent(subcategorySlug) : '';
    if (!categoryPart || !subcategoryPart) {
        return getHashForView('catalog');
    }
    return `#/category/${categoryPart}/subcategory/${subcategoryPart}`;
}

function getCurrentHashSegment() {
    const hash = window.location.hash || '';
    return hash.replace(/^#\/?/, '').replace(/\/+$/, '');
}

function getViewFromSegment(segment) {
    const normalized = (segment || '').toLowerCase();
    if (!normalized) {
        return { view: 'home', matched: true };
    }
    for (const [view, route] of Object.entries(VIEW_ROUTES)) {
        if (route === normalized) {
            return { view, matched: true };
        }
    }
    return { view: 'home', matched: false };
}

function updateHash(targetHash, { replace = false } = {}) {
    const normalizedHash = targetHash || '#/';
    if (replace) {
        const { pathname, search } = window.location;
        history.replaceState(null, '', `${pathname}${search}${normalizedHash}`);
        return;
    }
    if (window.location.hash === normalizedHash) {
        return;
    }
    window.location.hash = normalizedHash;
}

// --- Нормализация каталога и безопасность контента ---
const CYRILLIC_MAP = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
    й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
    у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ы: 'y', э: 'e', ю: 'yu',
    я: 'ya', ь: '', ъ: '',
};

const ALLOWED_TAGS = new Set(['p', 'ul', 'ol', 'li', 'h2', 'h3', 'strong', 'em', 'br', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a']);
const ALLOWED_ATTRIBUTES = {
    a: ['href', 'title'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan'],
    table: ['summary'],
};

function slugify(value) {
    const lower = String(value || '').trim().toLowerCase();
    if (!lower) return '';
    let slug = '';
    for (const char of lower) {
        if (/[a-z0-9]/.test(char)) {
            slug += char;
            continue;
        }
        if (CYRILLIC_MAP[char]) {
            slug += CYRILLIC_MAP[char];
            continue;
        }
        if (/[\s_-]+/.test(char)) {
            if (!slug.endsWith('-')) slug += '-';
        }
    }
    slug = slug.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
    return slug;
}

function ensureUniqueSlug(baseSlug, fallbackSlug, usedSlugs) {
    const safeBase = baseSlug || fallbackSlug || '';
    let candidate = safeBase || `product-${Date.now()}`;
    let counter = 1;
    while (usedSlugs.has(candidate)) {
        candidate = `${safeBase}-${counter++}`;
    }
    usedSlugs.add(candidate);
    return candidate;
}

/**
 * Санитизирует HTML описаний с белым списком тегов и минимальными классами для таблиц.
 */
function sanitizeHtml(html) {
    if (!html) return '';
    const doc = document.implementation.createHTMLDocument('');
    doc.body.innerHTML = html;

    const cleanseNode = (node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
            const tag = node.tagName.toLowerCase();
            if (!ALLOWED_TAGS.has(tag)) {
                const fragment = doc.createDocumentFragment();
                while (node.firstChild) fragment.appendChild(node.firstChild);
                node.replaceWith(fragment);
                Array.from(fragment.childNodes).forEach(child => cleanseNode(child));
                return;
            }

            [...node.attributes].forEach(attr => {
                const name = attr.name.toLowerCase();
                const value = attr.value;
                if (name.startsWith('on') || name === 'style') {
                    node.removeAttribute(attr.name);
                    return;
                }
                const allowedForTag = ALLOWED_ATTRIBUTES[tag] || [];
                if (!allowedForTag.includes(name)) {
                    node.removeAttribute(attr.name);
                    return;
                }
                if (tag === 'a' && name === 'href') {
                    const sanitizedHref = value ? value.trim() : '';
                    if (/^javascript:/i.test(sanitizedHref)) {
                        node.removeAttribute(attr.name);
                    }
                }
            });

            if (tag === 'a') {
                if (!node.getAttribute('href')) node.removeAttribute('href');
                node.setAttribute('rel', 'noopener noreferrer');
                node.setAttribute('target', '_blank');
            }

            if (tag === 'table') {
                node.className = 'block overflow-x-auto whitespace-nowrap border border-gray-200 rounded-lg text-sm min-w-full';
            }

            if (tag === 'thead') {
                node.className = 'bg-gray-50';
            }

            if (tag === 'tbody') {
                node.className = '';
            }

            if (tag === 'tr') {
                node.className = 'border-b border-gray-200';
            }

            if (tag === 'th' || tag === 'td') {
                node.className = 'border border-gray-200 px-3 py-2 text-left align-top';
            }
        }

        let child = node.firstChild;
        while (child) {
            const next = child.nextSibling;
            cleanseNode(child);
            child = next;
        }
    };

    Array.from(doc.body.childNodes).forEach(child => cleanseNode(child));
    return doc.body.innerHTML;
}

/**
 * Извлекает чистый текст из HTML-описания для полнотекстового поиска.
 */
function extractText(html) {
    if (!html) return '';
    const temp = document.createElement('div');
    temp.innerHTML = sanitizeHtml(html);
    return temp.textContent.replace(/\s+/g, ' ').trim();
}

/**
 * Приводит экспортированный каталог к унифицированной схеме с валидацией и метаданными.
 */
function normalizeCatalog(raw = window.FULL_CATALOG) {
    const source = Array.isArray(raw) ? raw : [];
    const normalized = [];
    const usedSlugs = new Set();

    source.forEach((item, index) => {
        const rawId = item?.id ?? item?.ID ?? item?.sku ?? item?.product_id ?? index;
        if (rawId === undefined || rawId === null) {
            console.warn('[CATALOG:SKIP]', 'unknown', 'Нет идентификатора товара');
            return;
        }
        const id = String(rawId).trim();
        if (!id) {
            console.warn('[CATALOG:SKIP]', rawId, 'Пустой идентификатор после приведения к строке');
            return;
        }

        const name = String(item?.name ?? item?.title ?? '').trim();
        if (!name) {
            console.warn('[CATALOG:SKIP]', id, 'Отсутствует название товара');
            return;
        }

        const priceValue = item?.price ?? item?.regular_price ?? item?.sale_price ?? null;
        const numericPrice = priceValue === null || priceValue === undefined
            ? null
            : Number(String(priceValue).replace(/\s+/g, '').replace(',', '.'));
        const hasPrice = Number.isFinite(numericPrice) && numericPrice > 0;
        const price = hasPrice ? Number(numericPrice) : null;

        let unit = String(item?.unit ?? item?.measurement ?? 'шт').trim();
        if (!unit || ['null', 'undefined', 'none'].includes(unit.toLowerCase())) unit = 'шт';

        let category = String(item?.category ?? item?.categories ?? '').trim();
        if (category) {
            category = category.replace(/\\+$/g, '').trim();
            if (['null', 'undefined', 'none'].includes(category.toLowerCase())) {
                category = '';
            }
        }
        if (!category) category = 'Без категории';

        const imageSource = item?.image ?? item?.images?.[0]?.src ?? item?.images?.[0]?.url ?? '';
        const rawImage = imageSource ? String(imageSource).trim() : '';
        const image = rawImage && !['null', 'undefined'].includes(rawImage.toLowerCase()) ? rawImage : '';

        let descriptionHtml = String(item?.description ?? item?.descriptionHtml ?? item?.short_description ?? item?.content ?? '').trim();
        if (['null', 'undefined'].includes(descriptionHtml.toLowerCase())) {
            descriptionHtml = '';
        }
        const descriptionText = extractText(descriptionHtml);
        const hasTable = /<table[\s>]/i.test(descriptionHtml);

        const providedSlug = item?.slug ? slugify(item.slug) : '';
        const baseSlug = providedSlug || slugify(name);
        const fallbackSlug = slugify(id);
        const slug = ensureUniqueSlug(baseSlug, fallbackSlug, usedSlugs);

        const product = {
            id,
            name,
            price,
            hasPrice,
            unit,
            category,
            image: image || PLACEHOLDER_IMAGE,
            descriptionHtml,
            descriptionText,
            slug,
            badges: {},
        };

        if (!product.hasPrice) {
            product.badges.noPrice = true;
        }
        if (hasTable) {
            product.badges.hasTable = true;
        }

        normalized.push(product);
    });

    return normalized;
}

function escapeHtmlAttribute(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeHtml(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildEditorInputId(prefix, value) {
    return `${prefix}-${String(value)}`.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function resolveProductImage(product, { fallbackWidth = 400, fallbackHeight = 160 } = {}) {
    if (!product) {
        return PLACEHOLDER_IMAGE;
    }
    const override = state.items?.[product.id]?.img;
    if (override) {
        return override;
    }
    if (product.image) {
        return product.image;
    }
    return `https://placehold.co/${fallbackWidth}x${fallbackHeight}/2563eb/ffffff?text=${String(product.name || '').substring(0, 10)}`;
}

// --- Глобальное Состояние ---
const legacyDefaultState = {
    products: [],
    cartItems: {},
    view: 'home', // 'home', 'catalog', 'cart', 'checkout', 'admin', 'details', 'online-calc', 'payment', 'delivery', 'about', 'contacts'
    selectedProductId: null,
    lastViewBeforeDetails: 'catalog',
    message: '',
    searchTerm: '',
    sortBy: 'name-asc',
    onlyWithPrice: false,
    isMenuOpen: false,
    isCatalogMenuOpen: false,
    selectedCategorySlug: null,
    selectedSubcategorySlug: null,
    activeSlide: 0,
    slides: [
        { image: 'https://i.imgur.com/YDb3Aq1.jpeg' },
        { image: 'https://i.imgur.com/FvJgTnS.jpeg' },
        { image: 'https://i.imgur.com/RTedE0r.jpeg' },
        { image: 'https://i.imgur.com/UpOzPlt.jpeg' },
        { image: 'https://i.imgur.com/we90y0H.jpeg' },
        { image: 'https://i.imgur.com/nK2SB1P.jpeg' },
        { image: 'https://i.imgur.com/mnezRSJ.jpeg' }
    ],
    catalogCategories: [
        {
            icon: 'fa-ruler-combined',
            title: 'Кровельные материалы',
            slug: 'krovelnye-materialy',
            image: 'https://i.imgur.com/YDb3Aq1.jpeg',
            description: 'Готовые решения для монтажа и ремонта кровель: от мембран и черепицы до аксессуаров, обеспечивающих герметичность и долговечность кровельного пирога.',
            keywords: ['кровель', 'черепиц', 'воронк', 'мембран', 'кровля'],
            subcategories: [
                {
                    title: 'Рулонная кровля',
                    slug: 'rulonnaya-krovlya',
                    description: 'Битумные и полимерные рулонные материалы для устройства надежного кровельного ковра.',
                    keywords: ['рулонн', 'рубероид', 'техноэласт', 'унифлекс', 'бикрост', 'биполь', 'бризол'],
                },
                {
                    title: 'Гибкая черепица',
                    slug: 'gibkaya-cherepica',
                    description: 'Битумная гибкая черепица и доборные элементы для сложных архитектурных форм.',
                    keywords: ['черепиц', 'гибкая черепиц', 'shinglas', 'katepal', 'гонт', 'roofshield'],
                },
                {
                    title: 'Комплектующие',
                    slug: 'krovelnye-komplektuyushchie',
                    description: 'Коньки, планки примыкания, вентиляционные элементы и другие аксессуары для кровли.',
                    keywords: ['комплектующ', 'конек', 'ендов', 'планка', 'капельник', 'мастер флеш'],
                },
                {
                    title: 'Инструменты',
                    slug: 'krovelnye-instrumenty',
                    description: 'Паяльные фены, ножи, валики и другой инструмент для монтажа кровельных материалов.',
                    keywords: ['инструмент', 'нож', 'горелк', 'валик', 'ролик', 'фен'],
                },
                {
                    title: 'Кровельные ограждения',
                    slug: 'krovelnye-ograzhdeniya',
                    description: 'Системы безопасности кровли: ограждения, лестницы, переходные мостики.',
                    keywords: ['огражден', 'лестниц', 'кровельн огражден', 'снегозадержател', 'перила'],
                },
                {
                    title: 'Антисептики для кровли',
                    slug: 'antiseptiki-dlya-krovli',
                    description: 'Защитные составы для обработки деревянных и металлических кровельных конструкций.',
                    keywords: ['антисепт', 'кровл', 'биозащит', 'fungicid', 'пропитка'],
                },
                {
                    title: 'ПВХ и ТПО мембраны',
                    slug: 'pvh-i-tpo-membrany',
                    description: 'Полимерные мембраны и комплектующие для плоских кровель.',
                    keywords: ['пвх мембран', 'тпо мембран', 'logicroof', 'sintofoil', 'fatra', 'membrane'],
                },
            ],
            links: ['Рулонная кровля', 'Гибкая черепица', 'Комплектующие', 'Инструменты', 'Кровельные ограждения', 'Антисептики для кровли', 'ПВХ и ТПО мембраны'],
        },
        {
            icon: 'fa-thermometer-half',
            title: 'Изоляция',
            slug: 'izolyaciya',
            image: 'https://i.imgur.com/FvJgTnS.jpeg',
            description: 'Материалы для защиты конструкций от влаги, шума и перепадов температур, включая мастики, праймеры и комплектующие.',
            keywords: ['изоляц', 'шумоизоляц', 'праймер', 'мастик'],
            subcategories: [
                {
                    title: 'Праймеры',
                    slug: 'prajmery',
                    description: 'Битумные и полимерные праймеры для подготовки оснований под гидроизоляцию.',
                    keywords: ['праймер', 'primer', 'битумн праймер', 'грунтовка битумная'],
                },
                {
                    title: 'Мастики',
                    slug: 'mastiki',
                    description: 'Готовые мастики для ремонта и устройства кровель и гидроизоляции.',
                    keywords: ['мастик', 'мастика', 'битумн мастик', 'полимерн мастик'],
                },
                {
                    title: 'Герметики',
                    slug: 'izolyaciya-germetiki',
                    description: 'Герметики для стыков и деформационных швов, обеспечивающие герметичность конструкций.',
                    keywords: ['герметик', 'sealant', 'полиуретановый герметик', 'силикон'],
                },
                {
                    title: 'Звукоизоляция',
                    slug: 'zvukoizolyaciya',
                    description: 'Материалы для защиты помещений от внешнего шума и вибраций.',
                    keywords: ['звуко', 'шумо', 'акуст', 'шумозащит'],
                },
                {
                    title: 'Комплектующие',
                    slug: 'izolyaciya-komplektuyushchie',
                    description: 'Ленты, скотчи и дополнительные элементы для монтажа изоляционных систем.',
                    keywords: ['комплектующ', 'скотч', 'лента', 'уплотнител', 'соединител'],
                },
            ],
            links: ['Праймеры', 'Мастики', 'Герметики', 'Звукоизоляция', 'Комплектующие'],
        },
        {
            icon: 'fa-water',
            title: 'Гидроизоляция',
            slug: 'gidroizolyaciya',
            image: 'https://i.imgur.com/RTedE0r.jpeg',
            description: 'Современные решения для защиты от влаги и протечек: рулонная и обмазочная гидроизоляция, профилированные мембраны и оборудование.',
            keywords: ['гидроизоляц', 'жидкая резина', 'профилированные мембраны'],
            subcategories: [
                {
                    title: 'Рулонная гидроизоляция',
                    slug: 'rulonnaya-gidroizolyaciya',
                    description: 'Рулонные гидроизоляционные материалы для кровель и подземных конструкций.',
                    keywords: ['гидроизоляц', 'рулонн', 'битумн', 'гидростеклоизол', 'техноэласт'],
                },
                {
                    title: 'Профилированные мембраны',
                    slug: 'profilnye-membrany',
                    description: 'Дренажные и защитные профилированные мембраны для фундаментов и кровель.',
                    keywords: ['профилированная мембрана', 'профмембрана', 'platon', 'delta'],
                },
                {
                    title: 'Инструменты',
                    slug: 'gidroinstrumenty',
                    description: 'Специализированный инструмент для монтажа гидроизоляционных систем.',
                    keywords: ['инструмент', 'шпатель', 'распылител', 'аппарат'],
                },
                {
                    title: 'Обмазочная гидроизоляция',
                    slug: 'obmazochnaya-gidroizolyaciya',
                    description: 'Обмазочные составы и полимерцементные смеси для защиты от влаги.',
                    keywords: ['обмазоч', 'полимерцементн', 'мастика гидроизоляционная', 'кистев'],
                },
                {
                    title: 'Жидкая резина',
                    slug: 'zhidkaya-rezina',
                    description: 'Бесшовные покрытия на основе жидкой резины для кровель и фундаментов.',
                    keywords: ['жидкая резина', 'liquid rubber', 'резин'],
                },
                {
                    title: 'Промоборудование',
                    slug: 'promoborudovanie',
                    description: 'Оборудование и агрегаты для профессионального нанесения гидроизоляции.',
                    keywords: ['оборудование', 'установка', 'насос', 'агрегат', 'аппарат'],
                },
            ],
            links: ['Рулонная гидроизоляция', 'Профилированные мембраны', 'Инструменты', 'Обмазочная гидроизоляция', 'Жидкая резина', 'Промоборудование'],
        },
        {
            icon: 'fa-tv',
            title: 'Теплоизоляция',
            slug: 'teploizolyaciya',
            image: 'https://i.imgur.com/UpOzPlt.jpeg',
            description: 'Широкий выбор материалов для утепления кровли, фасадов и перекрытий: от экструдированного пенополистирола до напыляемых систем.',
            keywords: ['теплоизоляц', 'утепл', 'пенополистирол', 'минераловат'],
            subcategories: [
                {
                    title: 'Стекловата',
                    slug: 'steklovata',
                    description: 'Минеральные утеплители из стекловолокна для кровель и перегородок.',
                    keywords: ['стекловат', 'стекловолок', 'ursa', 'isover', 'knauf insulation'],
                },
                {
                    title: 'Напыляемый утеплитель',
                    slug: 'napylaemyj-uteplitel',
                    description: 'Пена ППУ и другие напыляемые материалы для бесшовного утепления.',
                    keywords: ['напыляемый утеплитель', 'ппу', 'пенополиуретан', 'spray foam', 'isollat'],
                },
                {
                    title: 'Пенопласт',
                    slug: 'penoplast',
                    description: 'Плиты из пенополистирола для утепления стен и перекрытий.',
                    keywords: ['пенопласт', 'псб', 'eps', 'пенополистирол'],
                },
                {
                    title: 'Вспененный полиэтилен',
                    slug: 'vspenennyi-polietilen',
                    description: 'Теплоизоляционные материалы из вспененного полиэтилена с фольгой и без.',
                    keywords: ['вспененный полиэтилен', 'фольг', 'пенофол', 'izolon'],
                },
                {
                    title: 'Крепеж для теплоизоляции',
                    slug: 'krepezh-dlya-teploizolyacii',
                    description: 'Дюбели, анкеры и другие элементы крепления утеплителей.',
                    keywords: ['крепеж', 'дюбель тарельчатый', 'парасоль', 'грибок', 'анкера теплоизоляция'],
                },
            ],
            links: ['Стекловата', 'Напыляемый утеплитель', 'Пенопласт', 'Вспененный полиэтилен', 'Крепеж для теплоизоляции'],
        },
        {
            icon: 'fa-building',
            title: 'Фасадные материалы',
            slug: 'fasadnye-materialy',
            image: 'https://i.imgur.com/we90y0H.jpeg',
            description: 'Комплексные решения для облицовки и защиты фасадов: панели, плиты и штукатурно-клеевые системы.',
            keywords: ['фасад', 'облицовк', 'панел', 'фасадные'],
            subcategories: [
                {
                    title: 'Фасадные плиты',
                    slug: 'fasadnye-plity',
                    description: 'Системы навесных фасадов и плиты для облицовки зданий.',
                    keywords: ['фасадн плита', 'плита фасадная', 'керамогранит', 'cement board', 'hpl'],
                },
                {
                    title: 'Композитные панели',
                    slug: 'kompozitnye-paneli',
                    description: 'АЛЮКОБОНД, ACM и другие композитные панели для современного фасада.',
                    keywords: ['композитн панел', 'acp', 'алюкобонд', 'кассет фасад'],
                },
                {
                    title: 'Штукатурно-клеевые смеси',
                    slug: 'shtukaturno-kleevye-smesi',
                    description: 'Клей и армирующие составы для фасадных систем утепления.',
                    keywords: ['штукатурно-клеев', 'клеев фасад', 'армирующ клей', 'ceresit ct85'],
                },
                {
                    title: 'Фасадные штукатурки',
                    slug: 'fasadnye-shtukaturki',
                    description: 'Декоративные и защитные штукатурки для наружных работ.',
                    keywords: ['фасадн штукатур', 'декоративн штукатурка', 'короед', 'барашек'],
                },
            ],
            links: ['Фасадные плиты', 'Композитные панели', 'Штукатурно-клеевые смеси', 'Фасадные штукатурки'],
        },
        {
            icon: 'fa-tools',
            title: 'Стройматериалы',
            slug: 'stroymaterialy',
            image: 'https://i.imgur.com/nK2SB1P.jpeg',
            description: 'Базовые строительные материалы для возведения и ремонта: от цемента и арматуры до листовых и плитных изделий.',
            keywords: ['строител', 'строиматериал', 'цемент', 'арматур', 'гипсокартон'],
            subcategories: [
                {
                    title: 'Цемент, кладка и сыпучие',
                    slug: 'cement-kladka-sypuchie',
                    description: 'Сыпучие материалы, цемент и сухие смеси для кладочных работ.',
                    keywords: ['цемент', 'кладочн', 'песок', 'щебень', 'цементно-песчан'],
                },
                {
                    title: 'Монтажные клеи',
                    slug: 'montazhnye-klei',
                    description: 'Монтажные клеи и клей-пены для быстрого монтажа конструкций.',
                    keywords: ['монтажн клей', 'liquid nails', 'клей герметик', 'клей пена'],
                },
                {
                    title: 'Древесно-плитные материалы',
                    slug: 'drevlesnie-plity',
                    description: 'OSB, ДСП, МДФ и другие листовые материалы на древесной основе.',
                    keywords: ['osb', 'дсп', 'мдф', 'фанера', 'древесно-плит'],
                },
                {
                    title: 'Гипсокартон и листовые',
                    slug: 'gipsokarton-i-listovye',
                    description: 'ГКЛ, ГКЛВ и другие листовые материалы для отделки.',
                    keywords: ['гипсокартон', 'гкл', 'лист гипсовый', 'суперлист'],
                },
                {
                    title: 'Строительные сетки',
                    slug: 'stroitelnie-setki',
                    description: 'Армирующие, кладочные и штукатурные сетки.',
                    keywords: ['сетка', 'армирующ', 'малярн', 'рабица', 'серпянка'],
                },
                {
                    title: 'Стеклопластиковая арматура',
                    slug: 'stekloplastikovaya-armatura',
                    description: 'Композитная арматура и комплектующие для железобетона.',
                    keywords: ['стеклопластиковая арматура', 'gfrp', 'композитн арматур', 'basalt'],
                },
                {
                    title: 'Шифер',
                    slug: 'shifer',
                    description: 'Асбестоцементный и полимерный шифер для кровель.',
                    keywords: ['шифер', 'волнистый лист', 'асбестоцемент', 'ondulin'],
                },
            ],
            links: ['Цемент, кладка и сыпучие', 'Монтажные клеи', 'Древесно-плитные материалы', 'Гипсокартон и листовые', 'Строительные сетки', 'Стеклопластиковая арматура', 'Шифер'],
        },
        {
            icon: 'fa-tint',
            title: 'Водосточные системы',
            slug: 'vodostochnye-sistemy',
            image: 'https://i.imgur.com/mnezRSJ.jpeg',
            description: 'Пластиковые и металлические системы водоотведения для надежной защиты кровли и фасадов от осадков.',
            keywords: ['водосточ', 'водоотведен', 'дренаж', 'желоб'],
            subcategories: [
                {
                    title: 'ПВХ системы',
                    slug: 'pvh-sistemy',
                    description: 'Пластиковые водосточные системы и комплектующие.',
                    keywords: ['пвх водосток', 'пластиковый желоб', 'docke', 'nicoll', 'profiline'],
                },
                {
                    title: 'Металлические системы',
                    slug: 'metallicheskie-sistemy',
                    description: 'Металлические желоба, трубы и аксессуары для водостока.',
                    keywords: ['металл водосток', 'оцинк', 'металлический желоб', 'galeco'],
                },
            ],
            links: ['ПВХ системы', 'Металлические системы'],
        },
        {
            icon: 'fa-box',
            title: 'Сухие смеси',
            slug: 'suhie-smesi',
            image: 'https://placehold.co/150x100/cccccc/969696?text=Сухие+смеси',
            description: 'Штукатурки, шпаклевки, наливные полы и другие смеси для внутренней и наружной отделки.',
            keywords: ['сухие смеси', 'шпатлев', 'штукатур', 'наливн', 'смесь'],
            subcategories: [
                {
                    title: 'Полимерные клеи',
                    slug: 'polimernye-klei',
                    description: 'Клеевые смеси и составы на полимерной основе для облицовки и монтажа.',
                    keywords: ['полимерн клей', 'клей плиточный', 'эластичный клей', 'ceresit cm'],
                },
                {
                    title: 'Штукатурки',
                    slug: 'shtukaturki',
                    description: 'Цементные и гипсовые штукатурные составы для внутренних и внешних работ.',
                    keywords: ['штукатурк', 'plaster', 'штукатурная смесь'],
                },
                {
                    title: 'Шпатлевки',
                    slug: 'shpatlevki',
                    description: 'Финишные и выравнивающие шпатлевки для гладких поверхностей.',
                    keywords: ['шпатлевк', 'шпаклевк', 'finish putty'],
                },
                {
                    title: 'Наливные полы',
                    slug: 'nalivnye-poly',
                    description: 'Самовыравнивающиеся смеси и ровнители для полов.',
                    keywords: ['наливн пол', 'ровнитель', 'self-leveling', 'nivelir'],
                },
                {
                    title: 'Кладочные смеси',
                    slug: 'kladochnye-smesi',
                    description: 'Готовые составы для кладки блоков и кирпича.',
                    keywords: ['кладочн смесь', 'раствор кладочный', 'masonry'],
                },
                {
                    title: 'Грунтовки',
                    slug: 'gruntovki',
                    description: 'Грунтовки глубокого проникновения и специальные составы для подготовки оснований.',
                    keywords: ['грунтовк', 'primer', 'бетонконтакт'],
                },
            ],
            links: ['Полимерные клеи', 'Штукатурки', 'Шпатлевки', 'Наливные полы', 'Кладочные смеси', 'Грунтовки'],
        },
        {
            icon: 'fa-home',
            title: 'Готовые домокомплекты',
            slug: 'gotovye-domokomplekty',
            image: 'https://placehold.co/150x100/cccccc/969696?text=Дома',
            description: 'Проектные решения для быстрого возведения домов и хозпостроек с полным набором элементов.',
            keywords: ['домокомплект', 'дом', 'каркас', 'модульный дом'],
            subcategories: [
                {
                    title: 'Садовые домики',
                    slug: 'sadovye-domiki',
                    description: 'Компактные садовые домики и бытовки для сезонного проживания.',
                    keywords: ['садовый домик', 'garden house', 'бытовка', 'домик садовый'],
                },
                {
                    title: 'Хозблоки',
                    slug: 'hozbloki',
                    description: 'Хозяйственные блоки и модульные постройки для хранения инвентаря.',
                    keywords: ['хозблок', 'хозпостройка', 'сарай', 'бытовка'],
                },
                {
                    title: 'Беседки',
                    slug: 'besedki',
                    description: 'Каркасные беседки, перголы и павильоны для отдыха.',
                    keywords: ['беседк', 'пергола', 'pavilion', 'альтанка'],
                },
                {
                    title: 'Гаражи',
                    slug: 'garazhi',
                    description: 'Сборные гаражи и боксы под автомобили и спецтехнику.',
                    keywords: ['гараж', 'бокс', 'металлический гараж', 'каркасный гараж'],
                },
            ],
            links: ['Садовые домики', 'Хозблоки', 'Беседки', 'Гаражи'],
        },
        {
            icon: 'fa-spray-can',
            title: 'Герметики и пены',
            slug: 'germetiki-i-peny',
            image: 'https://placehold.co/150x100/cccccc/969696?text=Пены',
            description: 'Монтажные пены, герметики и сопутствующие материалы для надежной герметизации швов и стыков.',
            keywords: ['герметик', 'монтажная пена', 'герметики', 'пены'],
            subcategories: [
                {
                    title: 'Монтажные пены',
                    slug: 'montazhnye-peny',
                    description: 'Профессиональные и бытовые монтажные пены для заполнения швов.',
                    keywords: ['монтажная пена', 'foam', 'penosil', 'soudal', 'kudo'],
                },
                {
                    title: 'Герметики',
                    slug: 'germetiki',
                    description: 'Силиконовые, полиуретановые и акриловые герметики.',
                    keywords: ['герметик', 'sealant', 'силикон', 'полиуретан'],
                },
                {
                    title: 'Очистители пены',
                    slug: 'ochistiteli-peny',
                    description: 'Средства для удаления свежей монтажной пены и очистки инструмента.',
                    keywords: ['очиститель пены', 'foam cleaner', 'очистка пены'],
                },
                {
                    title: 'Лента герметик',
                    slug: 'lenta-germetik',
                    description: 'Герметизирующие ленты и уплотнители для стыков и примыканий.',
                    keywords: ['лента герметик', 'бутилкаучуковая лента', 'уплотнитель', 'герметизирующая лента'],
                },
            ],
            links: ['Монтажные пены', 'Герметики', 'Очистители пены', 'Лента герметик'],
        },
        {
            icon: 'fa-leaf',
            title: 'Пароизоляция',
            slug: 'paroizolyaciya',
            image: 'https://placehold.co/150x100/cccccc/969696?text=Пленки',
            description: 'Пленки и мембраны для защиты утеплителя и конструкций от влаги и конденсата.',
            keywords: ['пароизоляц', 'паробарьер', 'мембран'],
            subcategories: [
                {
                    title: 'Паро-ветрозащитные пленки',
                    slug: 'paro-vetrozashchitnye-plenki',
                    description: 'Пароизоляционные и ветрозащитные пленки для кровель и стен.',
                    keywords: ['пароизоляц', 'ветрозащит', 'изоспан', 'паробарьер'],
                },
                {
                    title: 'Диффузионные мембраны',
                    slug: 'diffuzionnye-membrany',
                    description: 'Супердиффузионные мембраны для защиты утеплителя и вывода влаги.',
                    keywords: ['диффузионная мембрана', 'супердиффузионная', 'tyvek', 'delta vent'],
                },
            ],
            links: ['Паро-ветрозащитные пленки', 'Диффузионные мембраны'],
        },
        {
            icon: 'fa-flask',
            title: 'Строительная химия',
            slug: 'stroitelnaia-himiya',
            image: 'https://placehold.co/150x100/cccccc/969696?text=Химия',
            description: 'Составы для защиты и обслуживания конструкций: антисептики, отбеливатели, огнебиозащита.',
            keywords: ['строительная хим', 'антисепт', 'огнебиозащ', 'химия'],
            subcategories: [
                {
                    title: 'Антисептики для древесины',
                    slug: 'antiseptiki-dlya-drevesiny',
                    description: 'Средства защиты древесины от грибка, плесени и насекомых.',
                    keywords: ['антисептик', 'деревн', 'биозащита', 'пропитка'],
                },
                {
                    title: 'Отбеливатели для древесины',
                    slug: 'otbelivateli-dlya-drevesiny',
                    description: 'Составы для удаления потемнений и высолов на древесине.',
                    keywords: ['отбеливатель древесины', 'осветлитель', 'отбеливатель'],
                },
                {
                    title: 'Огнебиозащита',
                    slug: 'ognebiozashchita',
                    description: 'Комплексные огнезащитные и биозащитные пропитки для конструкций.',
                    keywords: ['огнебиозащита', 'огнезащит', 'антипирен'],
                },
                {
                    title: 'Удалители высолов',
                    slug: 'udaliteli-vysolov',
                    description: 'Очистители для удаления высолов и солевых пятен с фасадов и кладки.',
                    keywords: ['удалитель высолов', 'антисоль', 'очиститель кирпича', 'сольвывод'],
                },
            ],
            links: ['Антисептики для древесины', 'Отбеливатели для древесины', 'Огнебиозащита', 'Удалители высолов'],
        },
    ],
    checkoutState: {
        customerType: 'physical',
        deliveryMethod: 'company',
        paymentMethod: 'cash'
    }
};

const DEFAULT_CHECKOUT_STATE = {
    customerType: 'physical',
    deliveryMethod: 'company',
    paymentMethod: 'cash',
};

function cloneCatalogCategory(category) {
    if (!category || typeof category !== 'object') return null;
    const cloned = { ...category };
    cloned.keywords = Array.isArray(category.keywords) ? [...category.keywords] : [];
    cloned.links = Array.isArray(category.links) ? [...category.links] : [];
    cloned.subcategories = Array.isArray(category.subcategories)
        ? category.subcategories.map((sub) => ({
            ...sub,
            keywords: Array.isArray(sub.keywords) ? [...sub.keywords] : [],
        }))
        : [];
    return cloned;
}

function createDefaultState() {
    const base = legacyDefaultState;
    const catalogCategories = Array.isArray(base.catalogCategories)
        ? base.catalogCategories.map((category) => cloneCatalogCategory(category) || null).filter(Boolean)
        : [];
    const defaultGroupsOrder = catalogCategories
        .map((category) => String(category?.slug || '').trim())
        .filter(Boolean);
    const defaultItemsOrder = {};
    catalogCategories.forEach((category) => {
        const groupSlug = String(category?.slug || '').trim();
        if (!groupSlug) return;
        defaultItemsOrder[groupSlug] = Array.isArray(category?.subcategories)
            ? category.subcategories
                .map((sub) => String(sub?.slug || '').trim())
                .filter(Boolean)
            : [];
    });
    return {
        texts: {},
        groups: {
            catalogCategories,
        },
        items: {
            products: Array.isArray(base.products) ? [...base.products] : [],
            cartItems: base.cartItems ? { ...base.cartItems } : {},
        },
        layout: {
            view: base.view || 'home',
            selectedProductId: base.selectedProductId || null,
            lastViewBeforeDetails: base.lastViewBeforeDetails || 'catalog',
            isMenuOpen: Boolean(base.isMenuOpen),
            isCatalogMenuOpen: Boolean(base.isCatalogMenuOpen),
            selectedCategorySlug: base.selectedCategorySlug || null,
            selectedSubcategorySlug: base.selectedSubcategorySlug || null,
            activeSlide: Number.isFinite(base.activeSlide) ? base.activeSlide : 0,
            slides: Array.isArray(base.slides) ? base.slides.map((slide) => ({ ...slide })) : [],
            groupsOrder: defaultGroupsOrder,
            itemsOrderByGroup: defaultItemsOrder,
        },
        meta: {
            message: base.message || '',
            searchTerm: base.searchTerm || '',
            sortBy: base.sortBy || 'name-asc',
            onlyWithPrice: Boolean(base.onlyWithPrice),
            checkoutState: { ...DEFAULT_CHECKOUT_STATE, ...(base.checkoutState || {}) },
        },
    };
}

let state = createDefaultState();
if (typeof window !== 'undefined') {
    window.state = state;
}

let sliderInterval;
let catalogMenuTimeout; // Для задержки закрытия меню

let stateSaveTimeoutId = null;
let localforageLoaderPromise = null;
let catalogGroupsSortable = null;
const catalogItemSortables = new Map();

const STATE_KEY_PATHS = {
    products: ['items', 'products'],
    cartItems: ['items', 'cartItems'],
    view: ['layout', 'view'],
    selectedProductId: ['layout', 'selectedProductId'],
    lastViewBeforeDetails: ['layout', 'lastViewBeforeDetails'],
    isMenuOpen: ['layout', 'isMenuOpen'],
    isCatalogMenuOpen: ['layout', 'isCatalogMenuOpen'],
    selectedCategorySlug: ['layout', 'selectedCategorySlug'],
    selectedSubcategorySlug: ['layout', 'selectedSubcategorySlug'],
    activeSlide: ['layout', 'activeSlide'],
    slides: ['layout', 'slides'],
    groupsOrder: ['layout', 'groupsOrder'],
    itemsOrderByGroup: ['layout', 'itemsOrderByGroup'],
    message: ['meta', 'message'],
    searchTerm: ['meta', 'searchTerm'],
    sortBy: ['meta', 'sortBy'],
    onlyWithPrice: ['meta', 'onlyWithPrice'],
    checkoutState: ['meta', 'checkoutState'],
};

function ensureLocalforage() {
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
            console.warn('[STATE:SKIP]', 'storage', 'Не удалось загрузить localForage');
            resolve(null);
        };
        document.head.appendChild(script);
    });
    return localforageLoaderPromise;
}

async function getStateStorage() {
    try {
        const lf = await ensureLocalforage();
        return lf || null;
    } catch (error) {
        console.warn('[STATE:SKIP]', 'storage', `Ошибка при инициализации localForage: ${error.message}`);
        return null;
    }
}

async function pruneStateBackups(storage) {
    if (!storage || typeof storage.keys !== 'function') return;
    try {
        const keys = await storage.keys();
        const backupKeys = keys.filter((key) => key.startsWith(STATE_BACKUP_PREFIX));
        if (backupKeys.length <= MAX_STATE_BACKUPS) return;
        const sorted = backupKeys.sort((a, b) => b.localeCompare(a));
        const excess = sorted.slice(MAX_STATE_BACKUPS);
        await Promise.all(excess.map((key) => storage.removeItem(key)));
    } catch (error) {
        console.warn('[STATE:SKIP]', 'storage', `Не удалось очистить старые резервные копии: ${error.message}`);
    }
}

function cloneStateSnapshot() {
    return JSON.parse(JSON.stringify(state));
}

function buildStateExportFileName() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    return `site-snapshot-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.json`;
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

function buildSnapshotPayload() {
    const defaults = createDefaultState();
    const categories = Array.isArray(state.groups?.catalogCategories)
        ? state.groups.catalogCategories.map((category) => cloneCatalogCategory(category) || null).filter(Boolean)
        : [];
    const products = Array.isArray(state.items?.products)
        ? state.items.products.map((product) => {
            try {
                return JSON.parse(JSON.stringify(product));
            } catch (error) {
                return { ...product };
            }
        })
        : [];
    const order = {
        groups: Array.isArray(state.layout?.groupsOrder) ? [...state.layout.groupsOrder] : [],
        itemsByGroup: state.layout?.itemsOrderByGroup
            ? Object.fromEntries(
                Object.entries(state.layout.itemsOrderByGroup).map(([group, value]) => [group, Array.isArray(value) ? [...value] : []]),
            )
            : {},
    };
    const texts = state.texts ? { ...state.texts } : {};
    const layout = {
        view: state.layout?.view || defaults.layout.view,
        slides: Array.isArray(state.layout?.slides)
            ? state.layout.slides.map((slide) => ({ ...slide }))
            : defaults.layout.slides.map((slide) => ({ ...slide })),
    };
    const meta = {
        searchTerm: state.meta?.searchTerm || defaults.meta.searchTerm,
        onlyWithPrice: Boolean(state.meta?.onlyWithPrice),
        sortBy: state.meta?.sortBy || defaults.meta.sortBy,
    };
    return {
        version: SNAPSHOT_VERSION,
        timestamp: new Date().toISOString(),
        catalog: { categories, products, order },
        texts,
        layout,
        meta,
    };
}

let catalogOrderSaveTimeoutId = null;

async function persistCatalogOrderSnapshot() {
    const storage = await getStateStorage();
    if (!storage) return;
    const payload = {
        version: CATALOG_ORDER_VERSION,
        timestamp: new Date().toISOString(),
        groupsOrder: Array.isArray(state.layout?.groupsOrder) ? [...state.layout.groupsOrder] : [],
        itemsOrderByGroup: state.layout?.itemsOrderByGroup
            ? Object.fromEntries(
                Object.entries(state.layout.itemsOrderByGroup).map(([group, order]) => [group, Array.isArray(order) ? [...order] : []]),
            )
            : {},
    };
    try {
        await storage.setItem(CATALOG_ORDER_STORAGE_KEY, payload);
    } catch (error) {
        console.warn('[STATE:ORDER]', 'save', error.message || error);
    }
}

function scheduleCatalogOrderSave() {
    if (catalogOrderSaveTimeoutId) {
        clearTimeout(catalogOrderSaveTimeoutId);
    }
    catalogOrderSaveTimeoutId = setTimeout(() => {
        catalogOrderSaveTimeoutId = null;
        persistCatalogOrderSnapshot();
    }, CONFIG.editor.orderSaveDelay);
}

async function loadCatalogOrderFromStorage() {
    const storage = await getStateStorage();
    if (!storage) return;
    try {
        const snapshot = await storage.getItem(CATALOG_ORDER_STORAGE_KEY);
        if (!snapshot || typeof snapshot !== 'object') {
            return;
        }
        if (snapshot.version && snapshot.version !== CATALOG_ORDER_VERSION) {
            return;
        }
        if (Array.isArray(snapshot.groupsOrder)) {
            state.layout.groupsOrder = snapshot.groupsOrder.filter(Boolean);
        }
        if (snapshot.itemsOrderByGroup && typeof snapshot.itemsOrderByGroup === 'object') {
            const normalized = {};
            Object.entries(snapshot.itemsOrderByGroup).forEach(([group, order]) => {
                normalized[group] = Array.isArray(order) ? order.filter(Boolean) : [];
            });
            state.layout.itemsOrderByGroup = normalized;
        }
    } catch (error) {
        console.warn('[STATE:ORDER]', 'load', error.message || error);
    }
}

async function backupCurrentStateForImport() {
    const storage = await getStateStorage();
    if (!storage) return;
    try {
        const payload = {
            version: SNAPSHOT_VERSION,
            timestamp: new Date().toISOString(),
            snapshot: buildSnapshotPayload(),
        };
        await storage.setItem(CONFIG.storage.backupOnImport, payload);
    } catch (error) {
        console.warn('[STATE:BACKUP]', 'import', error.message || error);
    }
}

function apiRequest(url, options = {}) {
    const { timeout = CONFIG.api.timeout, ...fetchOptions } = options;
    if (typeof AbortController === 'undefined') {
        return fetch(url, fetchOptions);
    }
    const controller = new AbortController();
    const signal = controller.signal;
    const timer = setTimeout(() => controller.abort(), timeout);
    return fetch(url, { ...fetchOptions, signal })
        .catch((error) => {
            if (error.name === 'AbortError') {
                const timeoutError = new Error('Превышено время ожидания ответа от сервера.');
                timeoutError.code = 'timeout';
                throw timeoutError;
            }
            throw error;
        })
        .finally(() => {
            clearTimeout(timer);
        });
}

async function checkApiHealth() {
    try {
        const response = await apiRequest(CONFIG.api.health, { method: 'GET' });
        if (!response.ok) {
            return { ok: false, message: `Статус ${response.status}` };
        }
        return { ok: true };
    } catch (error) {
        if (error.code === 'timeout') {
            return { ok: false, message: 'Превышено время ожидания ответа.' };
        }
        return { ok: false, message: error.message || 'Недоступен сервер.' };
    }
}

function exportStateSnapshot() {
    try {
        const snapshot = buildSnapshotPayload();
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
    if (snapshot.version) {
        if (snapshot.version !== SNAPSHOT_VERSION) {
            throw new Error(`Неподдерживаемая версия схемы: ${snapshot.version}`);
        }
        if (!snapshot.catalog || typeof snapshot.catalog !== 'object') {
            throw new Error('Отсутствует раздел catalog.');
        }
        if (!Array.isArray(snapshot.catalog.categories)) {
            throw new Error('Поле "catalog.categories" должно быть массивом.');
        }
        if (!Array.isArray(snapshot.catalog.products)) {
            throw new Error('Поле "catalog.products" должно быть массивом.');
        }
        if (!snapshot.catalog.order || typeof snapshot.catalog.order !== 'object') {
            throw new Error('Поле "catalog.order" должно быть объектом.');
        }
        if (!snapshot.texts || typeof snapshot.texts !== 'object') {
            throw new Error('Поле "texts" должно быть объектом.');
        }
        const defaults = createDefaultState();
        const normalizedLayout = {
            ...defaults.layout,
            ...(snapshot.layout || {}),
            groupsOrder: Array.isArray(snapshot.catalog.order.groups) ? snapshot.catalog.order.groups : [],
            itemsOrderByGroup: snapshot.catalog.order.itemsByGroup && typeof snapshot.catalog.order.itemsByGroup === 'object'
                ? snapshot.catalog.order.itemsByGroup
                : {},
        };
        const normalizedMeta = {
            ...defaults.meta,
            ...(snapshot.meta || {}),
        };
        return {
            items: { products: snapshot.catalog.products },
            groups: { catalogCategories: snapshot.catalog.categories },
            layout: normalizedLayout,
            texts: snapshot.texts || {},
            meta: normalizedMeta,
        };
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

async function applyImportedSnapshot(importedState) {
    const defaults = createDefaultState();
    const merged = mergeState(defaults, importedState);
    const normalizedProducts = normalizeCatalog(
        Array.isArray(merged.items?.products) ? merged.items.products : []
    );
    merged.items.products = normalizedProducts.length
        ? normalizedProducts
        : normalizeCatalog(FALLBACK_PRODUCTS);

    if (Array.isArray(merged.groups?.catalogCategories)) {
        merged.groups.catalogCategories = merged.groups.catalogCategories.map(
            (category) => cloneCatalogCategory(category) || null
        ).filter(Boolean);
    }

    const undoSnapshot = prepareUndoSnapshot();
    state = merged;
    if (typeof window !== 'undefined') {
        window.state = state;
    }

    activeTextEditKeys.clear();
    commitUndoSnapshot(undoSnapshot);

    ensureLayoutOrdering();
    await persistCatalogOrderSnapshot();

    if (stateSaveTimeoutId) {
        clearTimeout(stateSaveTimeoutId);
        stateSaveTimeoutId = null;
    }

    destroyCatalogSortables();
    stopSlider();
    render();
    if (state.layout.view === 'home') {
        startSlider();
    }

    if (window.editorMode) {
        window.editorMode.refresh();
        refreshCatalogSortables();
    }

    await saveStateSnapshot(true);
    setMessage('Состояние успешно импортировано.');
}

async function importStateFromFile(file) {
    try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const snapshot = validateImportedSnapshot(parsed);
        await backupCurrentStateForImport();
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

    const currentGroupOrder = Array.isArray(state.layout?.groupsOrder)
        ? state.layout.groupsOrder
        : [];
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
        const savedOrder = Array.isArray(currentItemsOrder[groupSlug])
            ? currentItemsOrder[groupSlug]
            : [];
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
        scheduleCatalogOrderSave();
    }

    return groupsChanged || itemsChanged;
}

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

async function saveStateSnapshot(immediate = false) {
    const generation = markStateDirty();
    const storage = await getStateStorage();
    if (!storage) return;
    const persist = async () => {
        try {
            const current = await storage.getItem(STATE_STORAGE_KEY);
            if (current) {
                const backupKey = `${STATE_BACKUP_PREFIX}${Date.now()}`;
                await storage.setItem(backupKey, current);
                await pruneStateBackups(storage);
            }
            await storage.setItem(STATE_STORAGE_KEY, cloneStateSnapshot());
            markStateSaved(generation);
        } catch (error) {
            console.warn('[STATE:SKIP]', 'storage', `Не удалось сохранить состояние: ${error.message}`);
        }
    };
    if (immediate) {
        if (stateSaveTimeoutId) {
            clearTimeout(stateSaveTimeoutId);
            stateSaveTimeoutId = null;
        }
        await persist();
        return;
    }
    if (stateSaveTimeoutId) {
        clearTimeout(stateSaveTimeoutId);
    }
    stateSaveTimeoutId = window.setTimeout(() => {
        stateSaveTimeoutId = null;
        persist();
    }, STATE_SAVE_DEBOUNCE);
}

function scheduleStateSave() {
    return saveStateSnapshot(false);
}

function applyStatePatch(partial = {}) {
    const changedKeys = [];
    for (const [key, value] of Object.entries(partial)) {
        const path = STATE_KEY_PATHS[key];
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
        const nextValue = value;
        const hasChanged = JSON.stringify(previous) !== JSON.stringify(nextValue);
        if (hasChanged) {
            target[lastKey] = nextValue;
            changedKeys.push(key);
        }
    }
    return changedKeys;
}

function mergeState(defaultState, storedState) {
    if (!storedState || typeof storedState !== 'object') {
        return defaultState;
    }
    const merged = createDefaultState();
    merged.texts = { ...defaultState.texts, ...(storedState.texts || {}) };
    merged.groups.catalogCategories = Array.isArray(storedState.groups?.catalogCategories) && storedState.groups.catalogCategories.length
        ? storedState.groups.catalogCategories.map((category) => cloneCatalogCategory(category) || null).filter(Boolean)
        : defaultState.groups.catalogCategories.map((category) => cloneCatalogCategory(category) || null).filter(Boolean);
    merged.items.products = Array.isArray(storedState.items?.products) && storedState.items.products.length
        ? storedState.items.products
        : defaultState.items.products;
    merged.items.cartItems = storedState.items?.cartItems ? { ...storedState.items.cartItems } : { ...defaultState.items.cartItems };
    if (storedState.items && typeof storedState.items === 'object') {
        for (const [key, value] of Object.entries(storedState.items)) {
            if (key === 'products' || key === 'cartItems') continue;
            try {
                merged.items[key] = JSON.parse(JSON.stringify(value));
            } catch (error) {
                merged.items[key] = value;
            }
        }
    }
    merged.layout = {
        ...defaultState.layout,
        ...(storedState.layout || {}),
        slides: Array.isArray(storedState.layout?.slides) && storedState.layout.slides.length
            ? storedState.layout.slides.map((slide) => ({ ...slide }))
            : defaultState.layout.slides.map((slide) => ({ ...slide })),
    };
    merged.meta = {
        ...defaultState.meta,
        ...(storedState.meta || {}),
        checkoutState: {
            ...defaultState.meta.checkoutState,
            ...(storedState.meta?.checkoutState || {}),
        },
    };
    return merged;
}

async function initializeState() {
    const defaults = createDefaultState();
    let storedState = null;
    const storage = await getStateStorage();
    if (storage) {
        try {
            storedState = await storage.getItem(STATE_STORAGE_KEY);
        } catch (error) {
            console.warn('[STATE:SKIP]', 'storage', `Не удалось загрузить состояние: ${error.message}`);
        }
    }
    state = mergeState(defaults, storedState);
    const normalizedProducts = normalizeCatalog(state.items.products.length ? state.items.products : window.FULL_CATALOG);
    state.items.products = normalizedProducts;
    if (!state.items.products.length) {
        state.items.products = normalizeCatalog(FALLBACK_PRODUCTS);
    }
    if (!state.groups.catalogCategories.length) {
        state.groups.catalogCategories = defaults.groups.catalogCategories;
    }
    if (!state.layout.slides.length) {
        state.layout.slides = defaults.layout.slides;
    }
    await loadCatalogOrderFromStorage();
    ensureLayoutOrdering({ persist: true });
    if (storage && !storedState) {
        await saveStateSnapshot(true);
    }
}

function computeEditorKey(element) {
    if (!element || typeof element !== 'object') return null;
    if (element.dataset && element.dataset.editKey) {
        return element.dataset.editKey;
    }
    if (typeof document === 'undefined') return null;
    const path = [];
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
        path.unshift(`${node.tagName.toLowerCase()}:${index}`);
        node = node.parentElement;
    }
    const key = path.join('/');
    if (element.dataset) {
        element.dataset.editKey = key;
    }
    return key;
}

function applyStoredTextsToElement(element) {
    const key = computeEditorKey(element);
    if (!key) return;
    if (Object.prototype.hasOwnProperty.call(state.texts, key)) {
        const targetText = state.texts[key];
        if (element.textContent !== targetText) {
            element.textContent = targetText;
        }
    }
}

function captureMissingText(element) {
    const key = computeEditorKey(element);
    if (!key) return false;
    if (!Object.prototype.hasOwnProperty.call(state.texts, key)) {
        state.texts[key] = element.textContent ?? '';
        return true;
    }
    return false;
}

function syncEditableContent({ captureMissing = false } = {}) {
    if (typeof document === 'undefined') return false;
    const elements = document.querySelectorAll('.js-editable');
    let stateChanged = false;
    elements.forEach((element) => {
        if (captureMissing) {
            const added = captureMissingText(element);
            stateChanged = stateChanged || added;
        }
        applyStoredTextsToElement(element);
    });
    if (stateChanged) {
        scheduleStateSave();
    }
    return stateChanged;
}

function commitEditorTextChange(element, key) {
    const text = element.textContent ?? '';
    const previousText = state.texts[key];
    if (previousText === text) {
        return false;
    }
    state.texts[key] = text;
    scheduleStateSave();
    return true;
}

function handleEditorChanged(event) {
    const element = event?.target;
    if (!element || typeof element !== 'object') return;
    const key = computeEditorKey(element);
    if (!key) return;
    const trigger = event?.detail?.trigger || event.type || null;
    const currentText = element.textContent ?? '';
    const previousText = state.texts[key];

    if (trigger === 'blur') {
        if (editorInputTimers.has(key)) {
            flushEditorDebounceKey(key);
        } else if (previousText !== currentText) {
            if (commitEditorTextChange(element, key)) {
                updateEditorHistoryButtons();
            }
            activeTextEditKeys.delete(key);
        } else {
            activeTextEditKeys.delete(key);
        }
        return;
    }

    if (previousText === currentText) {
        return;
    }

    if (!activeTextEditKeys.has(key)) {
        const snapshot = prepareUndoSnapshot();
        commitUndoSnapshot(snapshot);
        activeTextEditKeys.add(key);
    }

    const flushCallback = () => {
        if (commitEditorTextChange(element, key)) {
            updateEditorHistoryButtons();
        }
        activeTextEditKeys.delete(key);
    };

    if (editorInputTimers.has(key)) {
        clearTimeout(editorInputTimers.get(key).timer);
    }

    const timer = setTimeout(() => {
        editorInputTimers.delete(key);
        flushCallback();
    }, CONFIG.editor.textDebounce);

    editorInputTimers.set(key, { timer, flush: flushCallback });
}

if (typeof document !== 'undefined') {
    const globalObject = typeof window !== 'undefined' ? window : null;
    if (globalObject && !globalObject.__editorChangeListenerAttached) {
        document.addEventListener('editor:changed', handleEditorChanged);
        globalObject.__editorChangeListenerAttached = true;
    } else if (!globalObject) {
        document.addEventListener('editor:changed', handleEditorChanged);
    }
}

if (typeof window !== 'undefined') {
    window.applyStatePatch = applyStatePatch;
    window.scheduleStateSave = scheduleStateSave;
    window.syncEditableContent = syncEditableContent;
    window.computeEditorKey = computeEditorKey;
    window.initializeSiteState = initializeState;
    window.saveStateSnapshot = saveStateSnapshot;
    window.ensureLocalforage = ensureLocalforage;
    window.isStateDirty = isStateDirty;
    window.generateDescription = generateDescription;
}

// Внутреннее состояние формы администратора
window.adminState = {
    productName: '', productPrice: '', productUnit: 'шт',
    productImage: 'https://placehold.co/400x300/e2e8f0/94a3b8?text=Стройматериал',
    productDescription: '', isGenerating: false, jsonInput: '', apiError: null,
};

// --- Утилиты ---

function navigateToRoute(view, { replace = false, categorySlug = null, subcategorySlug = null } = {}) {
    let hash;
    if (view === 'category') {
        hash = buildCategoryHash(categorySlug || state.layout.selectedCategorySlug);
    } else if (view === 'subcategory') {
        const targetCategory = categorySlug || state.layout.selectedCategorySlug;
        const targetSubcategory = subcategorySlug || state.layout.selectedSubcategorySlug;
        hash = buildSubcategoryHash(targetCategory, targetSubcategory);
    } else {
        hash = getHashForView(view);
    }
    if (!hash) return;
    if (replace) {
        updateHash(hash, { replace: true });
        return;
    }
    if (window.location.hash !== hash) {
        updateHash(hash);
    }
}

function applyInitialRoute() {
    const hashSegment = getCurrentHashSegment();
    const normalizedSegment = hashSegment.toLowerCase();
    if (normalizedSegment.startsWith('product/')) {
        const slug = decodeURIComponent(hashSegment.slice(hashSegment.indexOf('/') + 1));
        const product = state.items.products.find(p => p.slug === slug);
        if (product) {
            showDetails(product.id, { skipHistory: true, lastViewOverride: 'catalog' });
            updateHash(buildProductHash(product.slug), { replace: true });
            return;
        }
        console.warn('[ROUTER:SKIP]', slug, 'Товар по указанному slug не найден, переход к каталогу');
        setView('catalog', { skipHistory: true, replaceHistory: true });
        updateHash(getHashForView('catalog'), { replace: true });
        return;
    }

    if (normalizedSegment.startsWith('category/')) {
        const parts = hashSegment.split('/');
        const hasSubcategory = parts.length >= 4 && parts[2].toLowerCase() === 'subcategory';
        if (hasSubcategory) {
            const categorySlug = decodeURIComponent(parts[1] || '');
            const subSlug = decodeURIComponent(parts.slice(3).join('/') || '');
            const result = findSubcategoryBySlug(subSlug, categorySlug);
            if (result) {
                setView('subcategory', {
                    skipHistory: true,
                    replaceHistory: true,
                    categorySlug: result.category.slug,
                    subcategorySlug: result.subcategory.slug,
                });
                updateHash(buildSubcategoryHash(result.category.slug, result.subcategory.slug), { replace: true });
                return;
            }
            console.warn('[ROUTER:SKIP]', subSlug || parts[3], 'Подкатегория не найдена, переход к родительской категории');
            const fallbackCategory = findCategoryBySlug(categorySlug);
            if (fallbackCategory) {
                setView('category', { skipHistory: true, replaceHistory: true, categorySlug: fallbackCategory.slug });
                updateHash(buildCategoryHash(fallbackCategory.slug), { replace: true });
            } else {
                setView('catalog', { skipHistory: true, replaceHistory: true });
                updateHash(getHashForView('catalog'), { replace: true });
            }
            return;
        }

        const slugPart = hashSegment.slice(hashSegment.indexOf('/') + 1);
        const slug = decodeURIComponent(slugPart || '');
        const category = findCategoryBySlug(slug);
        if (category) {
            setView('category', { skipHistory: true, replaceHistory: true, categorySlug: category.slug });
            updateHash(buildCategoryHash(category.slug), { replace: true });
            return;
        }
        console.warn('[ROUTER:SKIP]', slug || slugPart, 'Категория не найдена, возврат к каталогу');
        setView('catalog', { skipHistory: true, replaceHistory: true });
        updateHash(getHashForView('catalog'), { replace: true });
        return;
    }

    const { view, matched } = getViewFromSegment(normalizedSegment);
    if (!matched && normalizedSegment) {
        console.warn('[ROUTER:SKIP]', hashSegment, 'Неизвестный маршрут, переход на главную');
        setView('home', { skipHistory: true, replaceHistory: true });
        updateHash(getHashForView('home'), { replace: true });
        return;
    }

    setView(view, { skipHistory: true, replaceHistory: true });
    updateHash(getHashForView(view), { replace: true });
}

function handleHashChange() {
    const hashSegment = getCurrentHashSegment();
    const normalizedSegment = hashSegment.toLowerCase();
    if (normalizedSegment.startsWith('product/')) {
        const slug = decodeURIComponent(hashSegment.slice(hashSegment.indexOf('/') + 1));
        const product = state.items.products.find(p => p.slug === slug);
        if (product) {
            showDetails(product.id, { skipHistory: true });
            return;
        }
        console.warn('[ROUTER:SKIP]', slug, 'Slug не найден при hashchange, возврат в каталог');
        updateHash(getHashForView('catalog'), { replace: true });
        setView('catalog', { skipHistory: true, replaceHistory: true });
        return;
    }

    if (normalizedSegment.startsWith('category/')) {
        const parts = hashSegment.split('/');
        const hasSubcategory = parts.length >= 4 && parts[2].toLowerCase() === 'subcategory';
        if (hasSubcategory) {
            const categorySlug = decodeURIComponent(parts[1] || '');
            const subSlug = decodeURIComponent(parts.slice(3).join('/') || '');
            const result = findSubcategoryBySlug(subSlug, categorySlug);
            if (result) {
                setView('subcategory', {
                    skipHistory: true,
                    replaceHistory: true,
                    categorySlug: result.category.slug,
                    subcategorySlug: result.subcategory.slug,
                });
                return;
            }
            console.warn('[ROUTER:SKIP]', subSlug || parts[3], 'Подкатегория не найдена при hashchange, возврат к каталогу');
            updateHash(getHashForView('catalog'), { replace: true });
            setView('catalog', { skipHistory: true, replaceHistory: true });
            return;
        }

        const slugPart = hashSegment.slice(hashSegment.indexOf('/') + 1);
        const slug = decodeURIComponent(slugPart || '');
        const category = findCategoryBySlug(slug);
        if (category) {
            setView('category', { skipHistory: true, replaceHistory: true, categorySlug: category.slug });
            return;
        }
        console.warn('[ROUTER:SKIP]', slug || slugPart, 'Категория не найдена при hashchange, возврат к каталогу');
        updateHash(getHashForView('catalog'), { replace: true });
        setView('catalog', { skipHistory: true, replaceHistory: true });
        return;
    }

    const { view, matched } = getViewFromSegment(normalizedSegment);
    if (!matched && normalizedSegment) {
        console.warn('[ROUTER:SKIP]', hashSegment, 'Неизвестный маршрут при hashchange, переход на главную');
        updateHash(getHashForView('home'), { replace: true });
        setView('home', { skipHistory: true, replaceHistory: true });
        return;
    }

    setView(view, { skipHistory: true, replaceHistory: true });
}


// --- Управление Состоянием ---

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
    if (changedKeys.some((key) => key === 'groupsOrder' || key === 'itemsOrderByGroup')) {
        scheduleCatalogOrderSave();
    }
    render();
    if (callback) callback();
}

function setMessage(text) {
    setState({ message: text });
    setTimeout(() => setState({ message: '' }), 4000);
}

function setView(newView, options = {}) {
    const statePatch = {
        view: newView,
        message: '',
        isCatalogMenuOpen: false,
    };

    if (newView === 'category') {
        const categorySlug = options.categorySlug || state.layout.selectedCategorySlug || null;
        statePatch.selectedCategorySlug = categorySlug;
        statePatch.selectedSubcategorySlug = null;
        statePatch.searchTerm = '';
    } else if (newView === 'subcategory') {
        const categorySlug = options.categorySlug || state.layout.selectedCategorySlug || null;
        const subcategorySlug = options.subcategorySlug || state.layout.selectedSubcategorySlug || null;
        statePatch.selectedCategorySlug = categorySlug;
        statePatch.selectedSubcategorySlug = subcategorySlug;
        statePatch.searchTerm = '';
    } else if (!options.preserveCategory) {
        statePatch.selectedCategorySlug = null;
        statePatch.selectedSubcategorySlug = null;
    }

    if (options.selectedProductId !== undefined) {
        statePatch.selectedProductId = options.selectedProductId;
    } else if (!options.preserveProduct) {
        statePatch.selectedProductId = null;
    }

    if (newView !== 'details') {
        statePatch.lastViewBeforeDetails = newView;
    }

    setState(statePatch, () => {
        if (newView !== 'details' && !options.skipHistory) {
            const navigationOptions = { replace: options.replaceHistory };
            if (newView === 'category') {
                navigationOptions.categorySlug = statePatch.selectedCategorySlug || state.layout.selectedCategorySlug;
            }
            if (newView === 'subcategory') {
                navigationOptions.categorySlug = statePatch.selectedCategorySlug || state.layout.selectedCategorySlug;
                navigationOptions.subcategorySlug = statePatch.selectedSubcategorySlug || state.layout.selectedSubcategorySlug;
            }
            navigateToRoute(newView, navigationOptions);
        }
    });
}

function showDetails(productId, options = {}) {
    const product = state.items.products.find(p => String(p.id) === String(productId));
    if (!product) {
        console.warn('[CATALOG:SKIP]', productId, 'Продукт не найден при открытии карточки');
        return;
    }

    const detailState = { view: 'details', selectedProductId: product.id };
    if (Object.prototype.hasOwnProperty.call(options, 'lastViewOverride')) {
        detailState.lastViewBeforeDetails = options.lastViewOverride;
    } else if (state.layout.view !== 'details') {
        detailState.lastViewBeforeDetails = state.layout.view;
    }

    if (!options.skipHistory) {
        const targetHash = buildProductHash(product.slug);
        if (options.replaceHistory) {
            updateHash(targetHash, { replace: true });
        } else {
            updateHash(targetHash);
        }
    }

    setState(detailState, options.callback || null);
}

function exitProductDetails() {
    const targetView = state.layout.lastViewBeforeDetails || 'catalog';
    setView(targetView, { replaceHistory: true });
}

function toggleMenu() {
    setState({ isMenuOpen: !state.layout.isMenuOpen });
}

function setCatalogMenu(isOpen) {
    clearTimeout(catalogMenuTimeout);
    if (isOpen) {
        if (!state.layout.isCatalogMenuOpen) {
            setState({ isCatalogMenuOpen: true });
        }
    } else {
        catalogMenuTimeout = setTimeout(() => {
            setState({ isCatalogMenuOpen: false });
        }, 200);
    }
}

// --- Функции для оформления заказа и поиска ---
function handleCategoryClick(categorySlug) {
    const category = findCategoryBySlug(categorySlug);
    if (!category) {
        console.warn('[CATEGORY:SKIP]', categorySlug, 'Категория не найдена, используем поиск по каталогу');
        const fallbackTerm = String(categorySlug || '').replace(/[-_]+/g, ' ').trim();
        handleSearch(fallbackTerm || categorySlug);
        return;
    }
    setView('category', { categorySlug: category.slug });
}

function handleSubcategoryClick(categorySlug, subcategorySlug) {
    const result = findSubcategoryBySlug(subcategorySlug, categorySlug);
    if (!result) {
        console.warn('[SUBCATEGORY:SKIP]', subcategorySlug, 'Подкатегория не найдена, выполняем поиск по каталогу');
        const fallbackTerm = String(subcategorySlug || '').replace(/[-_]+/g, ' ').trim();
        handleSearch(fallbackTerm || subcategorySlug);
        return;
    }
    setView('subcategory', {
        categorySlug: result.category.slug,
        subcategorySlug: result.subcategory.slug,
    });
}

function handleSearch(term) {
    const changed = applyStatePatch({ searchTerm: term });
    if (changed.length) {
        scheduleStateSave();
    }
    if (state.layout.view !== 'catalog') {
        setView('catalog');
    } else {
        renderProductGridOnly(); // Только перерисовываем товары, а не всю страницу
    }
}

function setOnlyWithPrice(isChecked) {
    const newValue = Boolean(isChecked);
    if (state.meta.onlyWithPrice === newValue) return;
    if (state.layout.view === 'catalog') {
        const changed = applyStatePatch({ onlyWithPrice: newValue });
        if (changed.length) {
            scheduleStateSave();
        }
        renderProductGridOnly();
    } else {
        setState({ onlyWithPrice: newValue });
    }
}

function handleCheckoutChange(field, value) {
    const newCheckoutState = { ...state.meta.checkoutState, [field]: value };
    const changed = applyStatePatch({ checkoutState: newCheckoutState });
    if (changed.length) {
        scheduleStateSave();
    }
    renderCheckoutPage(true);
}


function handlePlaceOrder(event) {
    event.preventDefault();
    setState({ cartItems: {} }); // Очищаем корзину
    setMessage('Ваш заказ успешно оформлен! Менеджер скоро свяжется с вами.');
    setTimeout(() => setView('home'), 1000);
}


// --- Логика Слайдера ---
function startSlider() {
    stopSlider();
    sliderInterval = setInterval(() => {
        const nextSlide = (state.layout.activeSlide + 1) % state.layout.slides.length;
        setState({ activeSlide: nextSlide });
    }, 5000);
}

function stopSlider() {
    if (sliderInterval) {
        clearInterval(sliderInterval);
    }
}

function setActiveSlide(index) {
    setState({ activeSlide: index });
    startSlider(); // Reset interval on manual change
}


// --- Логика Фильтрации и Сортировки ---

/**
 * Возвращает список товаров с учётом поиска, фильтра «Только с ценой» и сортировки.
 */
function getVisibleProducts() {
    const searchTerm = state.meta.searchTerm.trim().toLowerCase();
    let filteredProducts = [...state.items.products];

    if (state.meta.onlyWithPrice) {
        filteredProducts = filteredProducts.filter(product => product.hasPrice);
    }

    if (searchTerm) {
        filteredProducts = filteredProducts.filter(product => {
            const nameMatch = product.name.toLowerCase().includes(searchTerm);
            const categoryMatch = product.category.toLowerCase().includes(searchTerm);
            const descriptionMatch = (product.descriptionText || '').toLowerCase().includes(searchTerm);
            return nameMatch || categoryMatch || descriptionMatch;
        });
    }

    const locale = 'ru';
    const sortedProducts = [...filteredProducts];

    const pushNullPricesToEnd = (a, b) => {
        if (!a.hasPrice && !b.hasPrice) return a.name.localeCompare(b.name, locale);
        if (!a.hasPrice) return 1;
        if (!b.hasPrice) return -1;
        return 0;
    };

    switch (state.meta.sortBy) {
        case 'price-asc':
            sortedProducts.sort((a, b) => {
                const nullCheck = pushNullPricesToEnd(a, b);
                if (nullCheck !== 0) return nullCheck;
                return a.price - b.price || a.name.localeCompare(b.name, locale);
            });
            break;
        case 'price-desc':
            sortedProducts.sort((a, b) => {
                const nullCheck = pushNullPricesToEnd(a, b);
                if (nullCheck !== 0) return nullCheck;
                return b.price - a.price || a.name.localeCompare(b.name, locale);
            });
            break;
        case 'name-desc':
            sortedProducts.sort((a, b) => b.name.localeCompare(a.name, locale));
            break;
        case 'name-asc':
        default:
            sortedProducts.sort((a, b) => a.name.localeCompare(b.name, locale));
            break;
    }

    return sortedProducts;
}

// --- Утилиты Расчетов ---
function formatCurrency(amount) {
    if (typeof amount !== 'number' || Number.isNaN(amount)) return '0 ₽';
    return amount.toLocaleString('ru-RU', { style: 'currency', currency: 'RUB', minimumFractionDigits: 0 });
}

function getProductPriceLabel(product) {
    if (!product?.hasPrice) return 'Цена по запросу';
    return formatCurrency(product.price);
}

function formatProductCount(count) {
    const number = Math.abs(Number(count) || 0);
    const lastTwo = number % 100;
    const last = number % 10;
    if (lastTwo > 10 && lastTwo < 20) return `${count} товаров`;
    if (last > 1 && last < 5) return `${count} товара`;
    if (last === 1) return `${count} товар`;
    return `${count} товаров`;
}

function calculateTotalCost() {
    return Object.values(state.items.cartItems).reduce((sum, item) => {
        if (!item || typeof item.price !== 'number' || Number.isNaN(item.price)) return sum;
        return sum + (item.quantity * item.price);
    }, 0);
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

    const targetId = String(productId);
    const productIndex = state.items.products.findIndex((product) => String(product.id) === targetId);
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

    const storedItem = state.items[targetId] && typeof state.items[targetId] === 'object'
        ? { ...state.items[targetId] }
        : {};
    storedItem.img = dataUrl;
    state.items[targetId] = storedItem;

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

// --- Функции Корзины ---
function updateCartItemQuantity(productId, change) {
    const product = state.items.products.find(p => String(p.id) === String(productId));
    if (!product) { setMessage('Продукт не найден.'); return; }
    if (!product.hasPrice) { setMessage('Для этого товара требуется запрос цены.'); return; }
    const newCartItems = { ...state.items.cartItems };
    const newQuantity = (newCartItems[productId]?.quantity || 0) + change;
    if (newQuantity <= 0) delete newCartItems[productId];
    else newCartItems[productId] = { ...product, quantity: newQuantity };
    setState({ cartItems: newCartItems });
}
function addToCart(productId) {
    const product = state.items.products.find(p => String(p.id) === String(productId));
    if (!product) { setMessage('Продукт не найден.'); return; }
    if (!product.hasPrice) { setMessage('Для этого товара требуется запрос цены.'); return; }
    updateCartItemQuantity(productId, 1);
    setMessage("Товар добавлен в корзину!");
}
function removeFromCart(productId) {
    const newCartItems = { ...state.items.cartItems };
    delete newCartItems[productId];
    setState({ cartItems: newCartItems });
}

function requestPrice(productId) {
    const product = state.items.products.find(p => String(p.id) === String(productId));
    if (!product) { setMessage('Продукт не найден.'); return; }
    setMessage(`Запрос по товару "${product.name}" отправлен. Менеджер свяжется с вами.`);
}

// --- Функции Админа ---
async function generateDescription(productName) {
    const normalizedName = typeof productName === 'string' ? productName.trim() : '';
    if (!normalizedName) {
        return 'Введите название продукта для генерации описания.';
    }

    try {
        const response = await apiRequest(GEMINI_PROXY_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ productName: normalizedName }),
        });

        if (response.status === 429) {
            throw new Error('Лимит запросов к генератору исчерпан. Попробуйте позже.');
        }
        if (!response.ok) {
            let errorMessage = `Сервер вернул статус ${response.status}`;
            try {
                const errorBody = await response.json();
                if (errorBody?.error?.message) {
                    errorMessage = errorBody.error.message;
                }
            } catch (parseError) {
                console.error('[GEMINI_ERROR_PARSE]', parseError);
            }
            throw new Error(errorMessage);
        }

        const payload = await response.json();
        const description = typeof payload?.description === 'string'
            ? payload.description.trim()
            : '';
        return description || 'Не удалось сгенерировать описание.';
    } catch (error) {
        console.error('[GEMINI_PROXY_REQUEST_ERROR]', error);
        if (error.code === 'timeout') {
            throw new Error('Превышено время ожидания ответа от сервера (20 секунд). Попробуйте повторить запрос.');
        }
        if (error.name === 'TypeError') {
            throw new Error('Не удалось подключиться к серверу. Проверьте интернет-соединение.');
        }
        throw new Error(error.message || 'Не удалось получить ответ от сервера.');
    }
}

async function handleAddProduct(productData) {
    const rawProduct = {
        id: productData.id || `prod-${Date.now()}`,
        name: productData.name,
        price: productData.price,
        unit: productData.unit,
        category: productData.category || 'Без категории',
        description: productData.description,
        image: productData.image,
    };
    const normalized = normalizeCatalog([rawProduct]);
    if (!normalized.length) {
        setMessage('Не удалось добавить продукт: проверьте корректность данных.');
        return;
    }
    const [newProduct] = normalized;
    setState({ products: [...state.items.products, newProduct] }, () => setMessage(`Продукт "${newProduct.name}" добавлен.`));
}

function handleFileChange(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
        try {
            const content = event.target.result;
            const parsedData = file.name.endsWith('.csv') ? parseCSVToJSON(content) : JSON.parse(content);
            window.adminState.jsonInput = JSON.stringify(parsedData, null, 2);
            renderAdminContent();
        } catch (e) { setMessage(`Ошибка чтения файла: ${e.message}`); }
    };
    reader.readAsText(file);
}

function handleBulkImport(jsonString) {
    try {
        const productsToImport = JSON.parse(jsonString);
        if (!Array.isArray(productsToImport)) throw new Error("Данные должны быть массивом.");
        const preparedProducts = productsToImport.map((product, index) => ({
            id: product?.id || `import-${Date.now()}-${index}`,
            ...product,
        }));
        const normalized = normalizeCatalog(preparedProducts);
        if (!normalized.length) {
            setMessage('Ни один товар не прошёл нормализацию.');
            return;
        }
        setState({ products: [...state.items.products, ...normalized] });
        setMessage(`Импортировано ${normalized.length} продуктов.`);
    } catch (e) { setMessage(`Ошибка импорта: ${e.message}`); }
}


function findCategoryBySlug(slug) {
    if (!slug) return null;
    const normalizedSlug = String(slug).trim().toLowerCase();
    return state.groups.catalogCategories.find(cat => String(cat.slug || '').toLowerCase() === normalizedSlug) || null;
}

function findSubcategoryBySlug(subcategorySlug, categorySlug = null) {
    if (!subcategorySlug) return null;
    const normalizedSub = String(subcategorySlug).trim().toLowerCase();
    const normalizedCategory = categorySlug ? String(categorySlug).trim().toLowerCase() : null;
    for (const category of state.groups.catalogCategories) {
        if (normalizedCategory && String(category.slug || '').toLowerCase() !== normalizedCategory) continue;
        const subcategories = getOrderedSubcategories(category);
        const subcategory = subcategories.find(sub => String(sub.slug || '').toLowerCase() === normalizedSub);
        if (subcategory) {
            return { category, subcategory };
        }
    }
    return null;
}

function getOrderedCategories() {
    ensureLayoutOrdering();
    const categories = Array.isArray(state.groups.catalogCategories) ? state.groups.catalogCategories : [];
    const order = Array.isArray(state.layout?.groupsOrder) ? state.layout.groupsOrder : [];
    const map = new Map();
    categories.forEach((category) => {
        const slug = String(category?.slug || '').trim();
        if (slug) {
            map.set(slug, category);
        }
    });
    const ordered = [];
    order.forEach((slug) => {
        const normalizedSlug = String(slug || '').trim();
        if (!normalizedSlug) return;
        const category = map.get(normalizedSlug);
        if (category) {
            ordered.push(category);
            map.delete(normalizedSlug);
        }
    });
    map.forEach((category) => ordered.push(category));
    return ordered;
}

function getOrderedSubcategories(category) {
    const subcategories = getCategorySubcategories(category);
    const groupSlug = String(category?.slug || '').trim();
    if (!groupSlug) return subcategories;
    const savedOrder = state.layout?.itemsOrderByGroup && Array.isArray(state.layout.itemsOrderByGroup[groupSlug])
        ? state.layout.itemsOrderByGroup[groupSlug]
        : [];
    if (!savedOrder.length) {
        return subcategories;
    }
    const map = new Map();
    subcategories.forEach((subcategory) => {
        const slug = String(subcategory?.slug || '').trim();
        if (slug) {
            map.set(slug, subcategory);
        }
    });
    const ordered = [];
    savedOrder.forEach((slug) => {
        const normalizedSlug = String(slug || '').trim();
        if (!normalizedSlug) return;
        const subcategory = map.get(normalizedSlug);
        if (subcategory) {
            ordered.push(subcategory);
            map.delete(normalizedSlug);
        }
    });
    map.forEach((subcategory) => ordered.push(subcategory));
    return ordered;
}

function getCategorySubcategories(category) {
    if (!category) return [];
    if (Array.isArray(category.subcategories) && category.subcategories.length) {
        return category.subcategories;
    }
    if (Array.isArray(category.links) && category.links.length) {
        return category.links.map(linkTitle => ({
            title: linkTitle,
            slug: slugify(linkTitle),
            keywords: [linkTitle],
        }));
    }
    return [];
}

function getSubcategoryKeywords(subcategory, category) {
    if (!subcategory) return [];
    const keywordSources = [
        subcategory.title,
        ...(Array.isArray(subcategory.keywords) ? subcategory.keywords : []),
    ];
    if (category?.title) keywordSources.push(category.title);
    return keywordSources
        .map(keyword => String(keyword || '').trim().toLowerCase())
        .filter(Boolean);
}

function getCategoryKeywords(category) {
    if (!category) return [];
    const subcategories = getOrderedSubcategories(category);
    const keywordSources = [
        category.title,
        ...(Array.isArray(category.keywords) ? category.keywords : []),
        ...subcategories.map(sub => sub.title),
        ...subcategories.flatMap(sub => Array.isArray(sub.keywords) ? sub.keywords : []),
    ];
    return keywordSources
        .map(keyword => String(keyword || '').trim().toLowerCase())
        .filter(Boolean);
}

function getProductsForCategory(category) {
    if (!category) return [];
    const keywords = getCategoryKeywords(category);
    if (!keywords.length) return [];
    const seenIds = new Set();
    const matched = state.items.products.filter(product => {
        const productId = String(product.id || '');
        if (seenIds.has(productId)) return false;
        const productCategory = String(product.category || '').toLowerCase().replace(/\\+/g, ' ');
        const productName = String(product.name || '').toLowerCase();
        const matches = keywords.some(keyword => productCategory.includes(keyword) || productName.includes(keyword));
        if (matches) {
            seenIds.add(productId);
            return true;
        }
        return false;
    });
    return state.meta.onlyWithPrice ? matched.filter(product => product.hasPrice) : matched;
}

function getProductsForSubcategory(subcategory, category = null, { respectPriceFilter = true } = {}) {
    if (!subcategory) return [];
    const keywords = getSubcategoryKeywords(subcategory, category);
    if (!keywords.length) return [];
    const seenIds = new Set();
    const matched = state.items.products.filter(product => {
        const productId = String(product.id || '');
        if (seenIds.has(productId)) return false;
        const productCategory = String(product.category || '').toLowerCase().replace(/\\+/g, ' ');
        const productName = String(product.name || '').toLowerCase();
        const matches = keywords.some(keyword => productCategory.includes(keyword) || productName.includes(keyword));
        if (matches) {
            seenIds.add(productId);
            return true;
        }
        return false;
    });
    if (respectPriceFilter && state.meta.onlyWithPrice) {
        return matched.filter(product => product.hasPrice);
    }
    return matched;
}


// --- Компоненты Рендеринга ---

function renderSubcategoryPreview(category, subcategory) {
    const hash = buildSubcategoryHash(category.slug, subcategory.slug);
    const previewProducts = getProductsForSubcategory(subcategory, category, { respectPriceFilter: false }).slice(0, 3);
    const productsList = previewProducts.length
        ? `<ul class="mt-1 space-y-1 text-xs text-gray-500">${previewProducts.map(product => {
                const productHash = buildProductHash(product.slug);
                return `<li><a href="${productHash}" onclick="event.preventDefault(); showDetails('${product.id}')" class="hover:text-yellow-600">${escapeHtml(product.name)}</a></li>`;
            }).join('')}</ul>`
        : `<p class="mt-1 text-xs text-gray-400">Товары скоро появятся</p>`;
    const itemSlug = escapeHtmlAttribute(subcategory.slug);
    return `
        <li class="pb-2 border-b border-gray-100 last:border-b-0 last:pb-0 flex items-start gap-2" data-item-id="${itemSlug}">
            <button type="button" class="editor-only js-drag text-gray-400 hover:text-gray-600 mt-1" aria-label="Переместить подкатегорию">
                <i class="fas fa-grip-vertical"></i>
            </button>
            <div class="flex-1">
                <a href="${hash}" onclick="event.preventDefault(); handleSubcategoryClick('${category.slug}', '${subcategory.slug}')" class="text-sm font-medium text-gray-700 hover:text-[#fcc521]">${escapeHtml(subcategory.title)}</a>
                ${productsList}
            </div>
        </li>
    `;
}

function renderCatalogDropdown() {
    const categories = getOrderedCategories();
    return `
        <div onmouseenter="setCatalogMenu(true)" onmouseleave="setCatalogMenu(false)" class="absolute top-full left-0 w-max max-w-7xl bg-white text-gray-700 shadow-2xl rounded-b-lg p-8 grid grid-cols-4 gap-x-12 gap-y-6 z-50">
            ${categories.map(cat => `
                <div class="space-y-3">
                    <h3 class="font-bold text-md flex items-center gap-3 cursor-pointer" onclick="handleCategoryClick('${cat.slug}')">
                        <i class="fas ${cat.icon} text-[#fcc521] w-5 text-center"></i>
                        <span>${escapeHtml(cat.title)}</span>
                    </h3>
                    <ul class="space-y-2 text-sm">
                        ${getOrderedSubcategories(cat).map(sub => {
                            const hash = buildSubcategoryHash(cat.slug, sub.slug);
                            return `<li><a href="${hash}" onclick="event.preventDefault(); handleSubcategoryClick('${cat.slug}', '${sub.slug}')" class="hover:text-[#fcc521] hover:underline">${escapeHtml(sub.title)}</a></li>`;
                        }).join('')}
                    </ul>
                </div>
            `).join('')}
        </div>
    `;
}

function renderCategoryPage(slug) {
    const category = findCategoryBySlug(slug);
    if (!category) {
        const fallbackContent = `<p>Запрошенная категория недоступна. Вернитесь в <a href="${getHashForView('catalog')}" class="text-yellow-600 hover:underline">каталог</a> и выберите другой раздел.</p>`;
        return renderStaticPage('Категория не найдена', fallbackContent);
    }

    const categoryTitle = escapeHtml(category.title);
    const description = escapeHtml(category.description || '');
    const catalogHash = getHashForView('catalog');
    const homeHash = getHashForView('home');
    const products = getProductsForCategory(category);
    const productCountLabel = formatProductCount(products.length);
    const subcategories = getOrderedSubcategories(category);
    const subcategoryChipsHtml = subcategories
        .map(sub => {
            const totalProducts = getProductsForSubcategory(sub, category, { respectPriceFilter: false }).length;
            const countBadge = totalProducts ? `<span class="ml-2 text-xs font-semibold text-gray-500 bg-white/60 px-2 py-0.5 rounded-full">${totalProducts}</span>` : '';
            const hash = buildSubcategoryHash(category.slug, sub.slug);
            return `<a href="${hash}" onclick="event.preventDefault(); handleSubcategoryClick('${category.slug}', '${sub.slug}')" class="inline-flex items-center gap-2 px-3 py-1 bg-yellow-100 text-yellow-700 rounded-full text-sm hover:bg-yellow-200 transition">${escapeHtml(sub.title)}${countBadge}</a>`;
        })
        .join('');
    const productsHtml = products.length
        ? products.map(renderProductCard).join('')
        : `<p class="col-span-full text-center text-gray-500 py-10">Товары этой категории скоро появятся в каталоге.</p>`;

    return `
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 space-y-10">
            <nav class="text-sm text-gray-500 flex items-center gap-2">
                <a href="${homeHash}" class="hover:text-[#fcc521]">Главная</a>
                <span>/</span>
                <a href="${catalogHash}" class="hover:text-[#fcc521]">Каталог</a>
                <span>/</span>
                <span class="text-gray-700">${categoryTitle}</span>
            </nav>

            <div class="grid grid-cols-1 lg:grid-cols-3 gap-8 items-start">
                <div class="lg:col-span-2">
                    <h1 class="text-4xl font-bold text-gray-800 mb-6">${categoryTitle}</h1>
                    ${description ? `<p class="text-lg text-gray-600 leading-relaxed mb-6">${description}</p>` : ''}
                    ${subcategoryChipsHtml ? `<div class="flex flex-wrap gap-2">${subcategoryChipsHtml}</div>` : ''}
                </div>
                <aside class="bg-white rounded-lg shadow-md overflow-hidden">
                    <img src="${category.image}" alt="${categoryTitle}" class="w-full h-48 object-cover"/>
                    <div class="p-6 space-y-4">
                        <p class="text-gray-600 text-sm leading-relaxed">Подберём оптимальное решение, рассчитаем объем материалов и организуем доставку на объект.</p>
                        <button onclick="setView('catalog')" class="inline-flex items-center gap-2 px-4 py-2 bg-[#fcc521] text-gray-900 font-semibold rounded-md shadow hover:bg-yellow-400 transition-colors">
                            <i class="fas fa-list"></i>
                            <span>Вернуться в общий каталог</span>
                        </button>
                    </div>
                </aside>
            </div>

            <section class="bg-white rounded-lg shadow-md p-6">
                <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-6">
                    <div>
                        <h2 class="text-2xl font-bold text-gray-800">Товары категории</h2>
                        <p class="text-sm text-gray-500">${productCountLabel}</p>
                    </div>
                    <button onclick="setOnlyWithPrice(!state.meta.onlyWithPrice)" class="self-start md:self-auto inline-flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-md text-sm text-gray-700 hover:border-yellow-400 hover:text-yellow-600 transition-colors">
                        <i class="fas fa-ruble-sign"></i>
                        <span>${state.meta.onlyWithPrice ? 'Показать все предложения' : 'Только товары с ценой'}</span>
                    </button>
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-6">
                    ${productsHtml}
                </div>
            </section>
        </div>
    `;
}

function renderSubcategoryPage(subcategorySlug, categorySlug) {
    const result = findSubcategoryBySlug(subcategorySlug, categorySlug);
    if (!result) {
        const fallbackContent = `<p>Запрошенная подкатегория временно недоступна. Вернитесь в <a href="${getHashForView('catalog')}" class="text-yellow-600 hover:underline">каталог</a> и выберите другой раздел.</p>`;
        return renderStaticPage('Подкатегория не найдена', fallbackContent);
    }

    const { category, subcategory } = result;
    const homeHash = getHashForView('home');
    const catalogHash = getHashForView('catalog');
    const categoryHash = buildCategoryHash(category.slug);
    const categoryTitle = escapeHtml(category.title);
    const subcategoryTitle = escapeHtml(subcategory.title);
    const description = escapeHtml(subcategory.description || '');
    const products = getProductsForSubcategory(subcategory, category);
    const productCountLabel = formatProductCount(products.length);
    const productsHtml = products.length
        ? products.map(renderProductCard).join('')
        : `<p class="col-span-full text-center text-gray-500 py-10">Для подкатегории пока нет опубликованных товаров. Свяжитесь с нашим менеджером для индивидуального предложения.</p>`;

    const siblingSubcategories = getOrderedSubcategories(category);
    const siblingListHtml = siblingSubcategories
        .map(sub => {
            const isActive = String(sub.slug) === String(subcategory.slug);
            const hash = buildSubcategoryHash(category.slug, sub.slug);
            const count = getProductsForSubcategory(sub, category, { respectPriceFilter: false }).length;
            const countLabel = count ? `<span class="text-xs text-gray-500">${count}</span>` : '';
            const baseClasses = 'flex items-center justify-between px-3 py-2 rounded-md text-sm transition-colors';
            const stateClasses = isActive ? 'bg-yellow-100 text-yellow-700 font-semibold cursor-default' : 'text-gray-600 hover:bg-gray-100';
            const action = isActive ? '' : `onclick="event.preventDefault(); handleSubcategoryClick('${category.slug}', '${sub.slug}')"`;
            return `<li><a href="${hash}" ${action} class="${baseClasses} ${stateClasses}"><span>${escapeHtml(sub.title)}</span>${countLabel}</a></li>`;
        })
        .join('');

    return `
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 space-y-10">
            <nav class="text-sm text-gray-500 flex items-center gap-2">
                <a href="${homeHash}" class="hover:text-[#fcc521]">Главная</a>
                <span>/</span>
                <a href="${catalogHash}" class="hover:text-[#fcc521]">Каталог</a>
                <span>/</span>
                <a href="${categoryHash}" class="hover:text-[#fcc521]">${categoryTitle}</a>
                <span>/</span>
                <span class="text-gray-700">${subcategoryTitle}</span>
            </nav>

            <div class="grid grid-cols-1 lg:grid-cols-3 gap-8 items-start">
                <div class="lg:col-span-2">
                    <h1 class="text-4xl font-bold text-gray-800 mb-4">${subcategoryTitle}</h1>
                    ${description ? `<p class="text-lg text-gray-600 leading-relaxed mb-6">${description}</p>` : ''}
                    <div class="flex items-center gap-3 text-sm text-gray-500">
                        <span>Подкатегория раздела</span>
                        <a href="${categoryHash}" onclick="event.preventDefault(); handleCategoryClick('${category.slug}')" class="inline-flex items-center gap-2 text-yellow-700 font-semibold hover:underline">
                            <i class="fas fa-folder-open"></i>
                            <span>${categoryTitle}</span>
                        </a>
                    </div>
                </div>
                <aside class="bg-white rounded-lg shadow-md overflow-hidden">
                    <img src="${category.image}" alt="${subcategoryTitle}" class="w-full h-48 object-cover"/>
                    <div class="p-6 space-y-4">
                        <p class="text-gray-600 text-sm leading-relaxed">Предложим оптимальные материалы под задачу и организуем доставку на объект.</p>
                        ${siblingListHtml ? `<div><h3 class="text-sm font-semibold text-gray-700 mb-2">Другие подкатегории</h3><ul class="space-y-1">${siblingListHtml}</ul></div>` : ''}
                        <div class="flex flex-col gap-2">
                            <button onclick="handleCategoryClick('${category.slug}')" class="inline-flex items-center gap-2 px-4 py-2 bg-[#fcc521] text-gray-900 font-semibold rounded-md shadow hover:bg-yellow-400 transition-colors">
                                <i class="fas fa-layer-group"></i>
                                <span>К разделу "${categoryTitle}"</span>
                            </button>
                            <button onclick="setView('catalog')" class="inline-flex items-center gap-2 px-4 py-2 border border-gray-300 text-sm text-gray-700 rounded-md hover:border-yellow-400 hover:text-yellow-600 transition-colors">
                                <i class="fas fa-list"></i>
                                <span>Вернуться в каталог</span>
                            </button>
                        </div>
                    </div>
                </aside>
            </div>

            <section class="bg-white rounded-lg shadow-md p-6">
                <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-6">
                    <div>
                        <h2 class="text-2xl font-bold text-gray-800">Товары подкатегории</h2>
                        <p class="text-sm text-gray-500">${productCountLabel}</p>
                    </div>
                    <button onclick="setOnlyWithPrice(!state.meta.onlyWithPrice)" class="self-start md:self-auto inline-flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-md text-sm text-gray-700 hover:border-yellow-400 hover:text-yellow-600 transition-colors">
                        <i class="fas fa-ruble-sign"></i>
                        <span>${state.meta.onlyWithPrice ? 'Показать все предложения' : 'Только товары с ценой'}</span>
                    </button>
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-6">
                    ${productsHtml}
                </div>
            </section>
        </div>
    `;
}

function renderHeader() {
    return `
        <header class="bg-white sticky top-0 z-50 shadow-sm">
            <!-- Top Bar -->
            <div class="border-b">
                <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex justify-between items-center py-2 text-sm text-gray-600">
                    <div class="flex items-center gap-6">
                        <div class="flex items-center gap-2 cursor-pointer hover:text-[#fcc521]">
                            <i class="fas fa-map-marker-alt"></i>
                            <span class="js-editable">Ваш город:</span>
                            <strong class="js-editable">Москва</strong>
                            <i class="fas fa-chevron-down text-xs"></i>
                        </div>
                    </div>
                    <div class="flex items-center gap-6">
                         <a href="#" class="hover:text-[#fcc521]"><i class="fas fa-phone-alt mr-1"></i> <strong class="js-editable">8 (800) 201-85-86</strong></a>
                         <a href="#" class="hidden lg:inline hover:text-[#fcc521]"><span class="js-editable">Заказать звонок</span></a>
                         <a href="#" class="hidden md:inline hover:text-[#fcc521]"><i class="fas fa-user mr-1"></i> <span class="js-editable">Войти</span></a>
                    </div>
                </div>
            </div>

            <!-- Main Header -->
            <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                <div class="flex justify-between items-center py-4">
                    <!-- Logo -->
                    <div class="flex items-center cursor-pointer" onclick="setView('home')">
                        <img src="${LOGO_URL}" alt="АРТ-СТРОЙ Логотип" class="h-12"/>
                    </div>

                    <!-- Search Bar -->
                    <div class="hidden lg:flex flex-grow max-w-lg mx-4">
                        <input type="text" placeholder="Поиск" oninput="handleSearch(this.value)" value="${state.meta.searchTerm}" class="w-full border border-gray-300 px-4 py-2 focus:ring-2 focus:ring-[#fcc521] focus:outline-none"/>
                        <button onclick="handleSearch(document.querySelector('input[placeholder=\\'Поиск\\']').value)" class="bg-[#fcc521] text-gray-800 font-bold px-4 hover:bg-yellow-500">
                            <i class="fas fa-search"></i>
                        </button>
                    </div>

                    <!-- Right Icons -->
                    <div class="flex items-center gap-4">
                        <button onclick="setView('cart')" class="flex items-center gap-2 text-gray-700 hover:text-[#fcc521]">
                           <i class="fas fa-shopping-cart text-2xl relative">
                             ${calculateCartCount() > 0 ? `<span class="absolute -top-1 -right-2 bg-red-500 text-white text-xs font-bold w-4 h-4 flex items-center justify-center rounded-full">${calculateCartCount()}</span>` : ''}
                           </i>
                           <span class="hidden md:inline">Корзина</span>
                        </button>
                        <button onclick="toggleMenu()" class="lg:hidden text-gray-600 hover:text-[#fcc521]">
                            <i class="fas fa-bars text-2xl"></i>
                        </button>
                    </div>
                </div>
            </div>
            
            <!-- Navigation Menu -->
            <nav class="bg-gray-800 text-white">
                <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                     <div class="hidden lg:flex items-center gap-8 h-12">
                        <div class="relative h-full" onmouseenter="setCatalogMenu(true)" onmouseleave="setCatalogMenu(false)">
                            <button onclick="setView('catalog')" class="hover:bg-gray-700 h-full px-3 transition-colors flex items-center cursor-pointer gap-2">
                                <i class="fas fa-bars"></i>
                                <span class="js-editable">Каталог</span>
                            </button>
                            ${state.layout.isCatalogMenuOpen ? renderCatalogDropdown() : ''}
                        </div>
                        <button onclick="setView('online-calc')" class="hover:bg-gray-700 h-full px-3 flex items-center transition-colors">
                            <span class="js-editable">Онлайн-расчеты</span>
                        </button>
                        <button onclick="setView('payment')" class="hover:bg-gray-700 h-full px-3 flex items-center transition-colors">
                            <span class="js-editable">Оплата</span>
                        </button>
                        <button onclick="setView('delivery')" class="hover:bg-gray-700 h-full px-3 flex items-center transition-colors">
                            <span class="js-editable">Доставка</span>
                        </button>
                        <button onclick="setView('about')" class="hover:bg-gray-700 h-full px-3 flex items-center transition-colors">
                            <span class="js-editable">О компании</span>
                        </button>
                        <button onclick="setView('contacts')" class="hover:bg-gray-700 h-full px-3 flex items-center transition-colors">
                            <span class="js-editable">Контакты</span>
                        </button>
                     </div>
                </div>
            </nav>
        </header>
    `;
}

function renderHomeView() {
    const slide = state.layout.slides[state.layout.activeSlide];
    const infoItems = [
        { icon: 'fa-shield-alt', title: 'Широкий ассортимент', text: 'Ведущие поставщики строительных материалов' },
        { icon: 'fa-warehouse', title: '13 000 м² складских помещений', text: 'Большое количество товара в наличии и под заказ' },
        { icon: 'fa-globe-europe', title: 'Федеральная компания', text: 'Сеть удобно расположенных офисов и филиалов по России' },
        { icon: 'fa-truck', title: 'Собственная доставка', text: 'Просто оформите доставку по телефону или на сайте' }
    ];

    return `
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <!-- Hero Slider -->
            <div class="relative w-full overflow-hidden my-8" onmouseenter="stopSlider()" onmouseleave="startSlider()">
                <div class="flex transition-transform duration-700 ease-in-out" style="transform: translateX(-${state.layout.activeSlide * 100}%)">
                    ${state.layout.slides.map(s => `
                        <div class="w-full flex-shrink-0">
                            <div class="relative w-full h-[450px]">
                                <img src="${s.image}" class="w-full h-full object-cover rounded-lg" alt="Слайд карусели"/>
                                <div class="absolute inset-0 flex justify-center items-end pb-12 rounded-lg">
                                    <button class="bg-[#fcc521] text-gray-800 font-bold py-3 px-8 hover:bg-yellow-400 transition-colors text-lg rounded-md">
                                        <span class="js-editable">Узнать больше</span>
                                    </button>
                                </div>
                            </div>
                        </div>
                    `).join('')}
                </div>

                <!-- Slider Dots -->
                <div class="absolute bottom-4 left-1/2 -translate-x-1/2 flex space-x-2">
                    ${state.layout.slides.map((_, index) => `
                        <button onclick="setActiveSlide(${index})" class="w-3 h-3 rounded-full ${state.layout.activeSlide === index ? 'bg-white' : 'bg-white/50'}"></button>
                    `).join('')}
                </div>
            </div>
        </div>

        <!-- Info Bar -->
        <div class="bg-white">
            <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8 py-10">
                ${infoItems.map(item => `
                        <div class="flex items-center gap-4">
                            <i class="fas ${item.icon} text-3xl text-[#fcc521]"></i>
                            <div>
                                <h4 class="js-editable font-bold text-gray-800">${item.title}</h4>
                                <p class="js-editable text-sm text-gray-500">${item.text}</p>
                            </div>
                        </div>
                `).join('')}
            </div>
        </div>
        
        <!-- Promo Banners -->
        <div class="bg-gray-100 py-10">
            <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 grid grid-cols-1 md:grid-cols-3 gap-8">
                 <div class="bg-yellow-400 p-6 rounded-lg text-gray-800 cursor-pointer hover:shadow-xl transition-shadow">
                    <h3 class="js-editable text-xl font-bold">КОРПОРАТИВНЫМ КЛИЕНТАМ</h3>
                    <p class="js-editable text-3xl font-extrabold">СПЕЦИАЛЬНЫЕ УСЛОВИЯ</p>
                 </div>
                 <div class="bg-yellow-400 p-6 rounded-lg text-gray-800 cursor-pointer hover:shadow-xl transition-shadow">
                     <h3 class="js-editable text-xl font-bold"><i class="fas fa-arrow-down"></i> СКИДКА 3%</h3>
                     <p class="js-editable">на следующий заказ: оформи заказ прямо сейчас на сайте и получи скидку на следующий заказ</p>
                 </div>
                 <div class="bg-yellow-400 p-6 rounded-lg text-gray-800 cursor-pointer hover:shadow-xl transition-shadow">
                     <h3 class="js-editable text-xl font-bold">СКИДКИ ДЛЯ ВСЕХ</h3>
                 </div>
            </div>
        </div>
    `;
}

function renderAboutPage() {
    const stats = [
        { value: '200', label: 'сотрудников в штате', text: 'Все наши сотрудники профессионалы своего дела. Мы готовы оказать высокий уровень сервиса на всех этапах поставки стройматериалов.'},
        { value: '1500', label: 'кв.м. офисных помещений', text: 'Каждый офис оснащен всем необходимым чтобы сделать Ваш визит максимально полезным и приятным, включая шоурум с образцами.'},
        { value: '15000', label: 'кв.м. складских площадей', text: 'Располагаем всеми типами складских площадей: открытые, закрытые, отапливаемые, "холодные", что позволяет поддерживать большой ассортимент в наличии.'}
    ];
    
    const content = `
        <p class="js-editable text-lg text-gray-600 mb-8">Принимая решение о покупке в интернет-магазине мы часто задаем себе вопрос, а что скрывается за красочной интернет-витриной? Надежна ли организация у которой мы хотим совершить покупку? Можем ли мы рассчитывать на качественный товар и высокий уровень сервиса которые обещает нам продавец?</p>
        <p class="js-editable text-lg text-gray-600 mb-12">В этом разделе Вы найдете информацию, которая позволит сформировать первое впечатление о холдинге компаний "АРТ-СТРОЙ", ответит на вопросы которые мы сформулировали ранее, поможет принять решение о сотрудничестве с нами.</p>

        <h2 class="text-3xl font-bold text-gray-800 mb-8 border-b pb-4">Холдинг "АРТ-СТРОЙ" в цифрах</h2>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-8 mb-12">
            ${stats.map(s => `
                <div class="bg-gray-50 p-6 rounded-lg text-center">
                    <p class="text-5xl font-extrabold text-[#fcc521]">${s.value}</p>
                    <p class="text-md font-semibold text-gray-700 mt-2">${s.label}</p>
                    <p class="text-sm text-gray-500 mt-2">${s.text}</p>
                </div>
            `).join('')}
        </div>

        <h2 class="text-3xl font-bold text-gray-800 mb-8 border-b pb-4">Наши партнеры</h2>
        <p class="js-editable text-lg text-gray-600 mb-8">Холдинг компаний "АРТ-СТРОЙ" осуществляет деятельность на рынке строительных материалов с 2002 года. За это время нами были налажены партнерские отношения с ведущими поставщиками, мы являемся дилерами высшей категории многих производителей.</p>
        <div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-8 items-center mb-12">
            <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/a/a2/TechnoNicol_logo.svg/1200px-TechnoNicol_logo.svg.png" alt="Технониколь" class="h-12 mx-auto grayscale hover:grayscale-0 transition-all"/>
            <img src="https://www.penoplex.ru/images/logo-site.svg" alt="Пеноплэкс" class="h-16 mx-auto grayscale hover:grayscale-0 transition-all"/>
            <img src="https://upload.wikimedia.org/wikipedia/commons/4/4e/LUKOIL_logo.svg" alt="Лукойл" class="h-12 mx-auto grayscale hover:grayscale-0 transition-all"/>
            <img src="https://kreisel.ru/wp-content/uploads/2021/11/logo_kreisel.svg" alt="KREISEL" class="h-16 mx-auto grayscale hover:grayscale-0 transition-all"/>
            <img src="https://termoclip.ru/local/templates/termoclip/img/logo.svg" alt="TERMOCLIP" class="h-12 mx-auto grayscale hover:grayscale-0 transition-all"/>
             <img src="https://upload.wikimedia.org/wikipedia/ru/thumb/9/9f/Knauf_Insulation_logo.svg/1200px-Knauf_Insulation_logo.svg.png" alt="Knauf" class="h-12 mx-auto grayscale hover:grayscale-0 transition-all"/>
        </div>

        <h2 class="text-3xl font-bold text-gray-800 mb-8 border-b pb-4">Наша миссия: "МЫ ПОМОГАЕМ СТРОИТЬ..."</h2>
        <ul class="space-y-4 text-lg text-gray-700">
            <li><i class="fas fa-check-circle text-yellow-500 mr-2"></i> ...ДОМА: обеспечивая людей уютным, качественным и недорогим жильем;</li>
            <li><i class="fas fa-check-circle text-yellow-500 mr-2"></i> ...ОКРУЖАЮЩУЮ СРЕДУ: предлагая экологически чистые стройматериалы;</li>
            <li><i class="fas fa-check-circle text-yellow-500 mr-2"></i> ...ЗДОРОВОЕ ОБЩЕСТВО: поддерживая спортивные и благотворительные мероприятия;</li>
            <li><i class="fas fa-check-circle text-yellow-500 mr-2"></i> ...БЛАГОПОЛУЧНОЕ ОБЩЕСТВО: честно платим налоги и заработную плату;</li>
            <li><i class="fas fa-check-circle text-yellow-500 mr-2"></i> ...МЫСЛЯЩЕЕ ОБЩЕСТВО: вкладываем средства в обучение сотрудников и клиентов.</li>
        </ul>
    `;
    return renderStaticPage('О компании', content);
}

function renderDeliveryPage() {
    const content = `
        <p class="js-editable text-lg text-gray-600 mb-8">Интернет-магазин предлагает несколько вариантов доставки:</p>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div class="bg-gray-50 p-6 rounded-lg border">
                <img src="https://i.imgur.com/z7v9g8b.jpeg" alt="Доставка транспортом компании" class="w-full h-48 object-cover rounded-md mb-4"/>
                <h3 class="text-2xl font-bold text-gray-800 mb-4 flex items-center"><i class="fas fa-truck text-[#fcc521] mr-3"></i>Доставка транспортом компании</h3>
                <p class="mb-6">Доставка платная. Стоимость рассчитывается в зависимости от типа транспорта и расстояния.</p>
                
                <div class="space-y-4">
                    <div class="p-4 border-l-4 border-yellow-400 bg-yellow-50">
                        <h4 class="font-bold">CITROEN BERLINGO</h4>
                        <ul class="list-disc list-inside text-gray-700 mt-2">
                            <li>Грузоподъемность: до 700 кг</li>
                            <li>Полезный объем: до 2 куб.м.</li>
                            <li>Стоимость: 100 руб/км (мин. 1000 руб.)</li>
                        </ul>
                    </div>
                    <div class="p-4 border-l-4 border-yellow-400 bg-yellow-50">
                        <h4 class="font-bold">MITSUBISHI FUSO</h4>
                        <ul class="list-disc list-inside text-gray-700 mt-2">
                            <li>Грузоподъемность: 5 тонн</li>
                            <li>Полезный объем: 38 куб.м.</li>
                            <li>Стоимость: 120 руб/км (мин. 5500 руб.)</li>
                        </ul>
                    </div>
                </div>
            </div>

            <div class="bg-gray-50 p-6 rounded-lg border">
                <img src="https://i.imgur.com/w7Dkio0.jpeg" alt="Самовывоз со склада" class="w-full h-48 object-cover rounded-md mb-4"/>
                <h3 class="text-2xl font-bold text-gray-800 mb-4 flex items-center"><i class="fas fa-warehouse text-[#fcc521] mr-3"></i>Самовывоз со склада</h3>
                <p class="mb-4">Вы можете забрать товар самостоятельно с нашего склада. Услуга бесплатная.</p>
                
                <div class="space-y-4">
                     <div>
                        <h4 class="font-semibold text-lg">Адрес склада:</h4>
                        <p>Московская обл., г. Люберцы, Котельнический проезд, 14</p>
                        <p class="text-sm text-gray-500">GPS: 55.6644, 37.8871</p>
                    </div>
                    <div>
                        <h4 class="font-semibold text-lg">Режим работы:</h4>
                        <p>Будни: 8:00 - 18:00</p>
                        <p>Суббота: 8:00 - 15:00</p>
                        <p>Воскресенье: выходной</p>
                    </div>
                    <div>
                        <h4 class="font-semibold text-lg">Перед визитом:</h4>
                        <ol class="list-decimal list-inside text-gray-700">
                           <li>Уточните наличие товара по телефону.</li>
                           <li>По прибытии сообщите номер заказа.</li>
                        </ol>
                    </div>
                </div>
            </div>
        </div>
    `;
    return renderStaticPage('Условия доставки', content);
}

function renderPaymentPage() {
    const content = `
        <p class="js-editable text-lg text-gray-600 mb-8">При оформлении заказа на нашем сайте, Вы можете выбрать один из следующих вариантов оплаты:</p>
        <div class="space-y-10">
            <div class="bg-gray-50 p-6 rounded-lg border flex flex-col md:flex-row gap-6 items-start">
                <div class="text-4xl text-[#fcc521] pt-1"><i class="fas fa-money-bill-wave"></i></div>
                <div>
                    <h3 class="text-2xl font-bold text-gray-800 mb-4">Оплата наличными</h3>
                    <p class="mb-4">Оплату наличными Вы можете осуществить в любом офисе продаж либо при получении товаров на доставке.</p>
                    <p class="mb-4">При получении товаров на доставке, покупатель осматривает товар на предмет повреждений, проверяет состав заказа по количеству и номенклатуре.</p>
                    <p class="mb-4">После завершения осмотра, покупатель осуществляет оплату водителю, получает документ подтверждающий факт оплаты заказа.</p>
                    <p class="font-semibold text-gray-800 bg-yellow-100 border-l-4 border-yellow-400 p-3 rounded">Передача товара от продавца покупателю возможна только после оплаты 100% стоимости заказа.</p>
                </div>
            </div>

            <div class="bg-gray-50 p-6 rounded-lg border flex flex-col md:flex-row gap-6 items-start">
                 <div class="text-4xl text-[#fcc521] pt-1"><i class="fas fa-credit-card"></i></div>
                 <div>
                    <h3 class="text-2xl font-bold text-gray-800 mb-4">Оплата банковской картой</h3>
                    <p class="mb-4">При оформлении заказа в интернет-магазине, в корзине вы можете выбрать вариант оплата банковской картой. Чтобы оплатить покупку, вас перенаправит на сервер платежного шлюза, где вы должны ввести номер карты, срок действия, имя держателя.</p>
                    <p class="mb-2 font-semibold">Вам могут отказать от авторизации в случае:</p>
                    <ul class="list-disc list-inside text-gray-700 space-y-1 mb-4">
                        <li>на карте недостаточно средств для покупки;</li>
                        <li>банк не поддерживает услугу платежей в интернете;</li>
                        <li>истекло время ожидания ввода данных;</li>
                        <li>в данных была допущена ошибка.</li>
                    </ul>
                    <p>В этом случае вы можете повторить авторизацию, воспользоваться другой картой или обратиться в свой банк для решения вопроса.</p>
                </div>
            </div>
        </div>
    `;
    return renderStaticPage('Условия оплаты', content);
}

function renderContactsPage() {
    const content = `
        <div class="mb-12">
            <iframe 
                src="https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d2249.770992385848!2d37.8863603159275!3d55.6635306805303!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x414ab6e0239c44c9%3A0x6b1f1e31351114b0!2z0JrQvtGC0LXQu9GM0L3QuNGB0YHRjyDRg9C70LjRhtCwLCAxNCwg0JrQvtGC0LXQu9GM0Y_QutCwLCDQnNC-0YHQutCy0L7RgNC-0YDRgdC60LDRjyDQvtCx0LsuLCAxNDA3MDE!5e0!3m2!1sru!2sru!4v1664716768822!5m2!1sru!2sru" 
                width="100%" 
                height="450" 
                style="border:0;" 
                allowfullscreen="" 
                loading="lazy" 
                referrerpolicy="no-referrer-when-downgrade"
                class="rounded-lg shadow-md"
            ></iframe>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-8">
            <div class="md:col-span-1 bg-gray-50 p-6 rounded-lg">
                <h3 class="text-2xl font-bold mb-4">Центральный офис</h3>
                <div class="space-y-3">
                    <p><i class="fas fa-map-marker-alt w-6 text-[#fcc521]"></i> Московская обл., г. Люберцы, Котельнический проезд, 14</p>
                    <p><i class="fas fa-phone w-6 text-[#fcc521]"></i> 8 (800) 201-85-86</p>
                    <p><i class="fas fa-envelope w-6 text-[#fcc521]"></i> popovichus@arttn.ru</p>
                </div>
                 <h4 class="font-bold mt-6 mb-2">Отделы:</h4>
                 <ul class="text-sm space-y-1 text-gray-600">
                    <li>Отдел продаж: +7 (960) 172-12-12</li>
                    <li>Отдел снабжения: +7 (985) 871-82-62</li>
                    <li>Отдел логистики: +7 (985) 191-86-80</li>
                    <li>Бухгалтерия: +7 (910) 793-15-85</li>
                 </ul>
            </div>
            <div class="md:col-span-2 space-y-6">
                <h3 class="text-2xl font-bold mb-4">Наши представительства</h3>
                <div class="bg-white p-4 rounded-lg shadow-sm border">
                    <h4 class="font-bold">База «АРТ-СТРОЙ Москва»</h4>
                    <p class="text-sm">Московская обл., г. Люберцы, Котельнический проезд, 14</p>
                    <p class="text-sm text-gray-500">Пн-Пт: 8:00-17:00; Сб: 8:00-15:00</p>
                </div>
                 <div class="bg-white p-4 rounded-lg shadow-sm border">
                    <h4 class="font-bold">Офис «АРТ-Строй Техно»</h4>
                    <p class="text-sm">г. Москва, ул. Горбунова, д. 2, стр. 3, Гранд Сетунь Плаза</p>
                    <p class="text-sm text-gray-500">Пн-Пт: 8:00-18:00</p>
                </div>
                 <div class="bg-white p-4 rounded-lg shadow-sm border">
                    <h4 class="font-bold">База «РУФСТРОЙ НН»</h4>
                    <p class="text-sm">г. Москва, ул. Судакова, 10</p>
                    <p class="text-sm text-gray-500">Пн-Пт: 8:00-17:00</p>
                </div>
                 <div class="bg-white p-4 rounded-lg shadow-sm border">
                    <h4 class="font-bold text-green-600">Представительство в Казахстане</h4>
                    <p class="text-sm">г. Шымкент, Енбекшинский район, улица Акназар хана, 138а</p>
                    <p class="text-sm text-gray-500">Пн-Пт: 9:00-18:00; Сб: 9:00-15:00</p>
                </div>
            </div>
        </div>
    `;
    return renderStaticPage('Контакты', content);
}


function renderCheckoutPage(isUpdate = false) {
    const checkoutContent = document.getElementById('checkout-content');
    
    if (calculateCartCount() === 0 && !isUpdate) {
        return `
            <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
                <div class="text-center py-16 bg-white rounded-lg shadow-md">
                    <i class="fas fa-shopping-basket text-5xl text-gray-300 mb-4"></i>
                    <p class="text-xl text-gray-600 mb-4">Ваша корзина пуста для оформления заказа</p>
                    <button onclick="setView('catalog')" class="bg-[#fcc521] hover:bg-yellow-500 text-gray-800 font-bold px-6 py-2 rounded-lg transition">Перейти в каталог</button>
                </div>
            </div>
        `;
    }

    const totalCost = calculateTotalCost();
    const { customerType, deliveryMethod, paymentMethod } = state.meta.checkoutState;

    const pageHtml = `
         <h1 class="text-4xl font-bold text-gray-800 mb-6">Оформление заказа</h1>
         <form onsubmit="handlePlaceOrder(event)">
            <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <div class="lg:col-span-2 space-y-6">
                    <!-- Customer Type -->
                    <div class="bg-white p-6 rounded-lg shadow-md">
                        <h2 class="text-xl font-bold mb-4">1. Тип покупателя и регион доставки</h2>
                        <div class="flex items-center space-x-8 mb-4">
                            <label class="flex items-center"><input type="radio" name="customer_type" onchange="handleCheckoutChange('customerType', 'physical')" ${customerType === 'physical' ? 'checked' : ''} class="h-4 w-4 text-yellow-500 border-gray-300 focus:ring-yellow-400"> <span class="ml-2">Физическое лицо</span></label>
                            <label class="flex items-center"><input type="radio" name="customer_type" onchange="handleCheckoutChange('customerType', 'legal')" ${customerType === 'legal' ? 'checked' : ''} class="h-4 w-4 text-yellow-500 border-gray-300 focus:ring-yellow-400"> <span class="ml-2">Юридическое лицо</span></label>
                        </div>
                        <div>
                             <label class="block text-sm font-medium text-gray-700">Местоположение*</label>
                             <input type="text" value="Москва, Московская область, Центр, Россия" class="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-yellow-400 focus:border-yellow-400" required>
                        </div>
                    </div>
                    <!-- Delivery/Payment -->
                    <div class="bg-white p-6 rounded-lg shadow-md">
                        <h2 class="text-xl font-bold mb-4">2. Способ доставки и оплаты</h2>
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div class="space-y-2">
                                <label class="p-4 border rounded-lg flex items-start cursor-pointer ${deliveryMethod === 'company' ? 'border-yellow-500 bg-yellow-50' : ''}">
                                    <input type="radio" name="delivery" onchange="handleCheckoutChange('deliveryMethod', 'company')" ${deliveryMethod === 'company' ? 'checked' : ''} class="h-4 w-4 text-yellow-500 border-gray-300 focus:ring-yellow-400 mt-1">
                                    <div class="ml-3">
                                        <span class="font-bold">Доставка транспортом компании</span>
                                        <p class="text-sm text-gray-500">Стоимость: по запросу</p>
                                    </div>
                                </label>
                                 <label class="p-4 border rounded-lg flex items-start cursor-pointer ${deliveryMethod === 'pickup' ? 'border-yellow-500 bg-yellow-50' : ''}">
                                    <input type="radio" name="delivery" onchange="handleCheckoutChange('deliveryMethod', 'pickup')" ${deliveryMethod === 'pickup' ? 'checked' : ''} class="h-4 w-4 text-yellow-500 border-gray-300 focus:ring-yellow-400 mt-1">
                                    <div class="ml-3">
                                        <span class="font-bold">Самовывоз</span>
                                        <p class="text-sm text-gray-500">Стоимость: бесплатно</p>
                                    </div>
                                </label>
                            </div>
                            <div class="space-y-2">
                                <label class="p-4 border rounded-lg flex items-start cursor-pointer ${paymentMethod === 'cash' ? 'border-yellow-500 bg-yellow-50' : ''}">
                                    <input type="radio" name="payment" onchange="handleCheckoutChange('paymentMethod', 'cash')" ${paymentMethod === 'cash' ? 'checked' : ''} class="h-4 w-4 text-yellow-500 border-gray-300 focus:ring-yellow-400 mt-1">
                                    <div class="ml-3">
                                        <span class="font-bold">Наличные курьеру</span>
                                        <p class="text-sm text-gray-500">Оплата при получении заказа</p>
                                    </div>
                                </label>
                            </div>
                        </div>
                    </div>
                     <!-- Buyer Info -->
                    <div class="bg-white p-6 rounded-lg shadow-md">
                        <h2 class="text-xl font-bold mb-4">3. Покупатель</h2>
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                           <div>
                                <label class="block text-sm font-medium text-gray-700">Ваше Имя*</label>
                                <input type="text" class="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-yellow-400 focus:border-yellow-400" required>
                           </div>
                           <div>
                                <label class="block text-sm font-medium text-gray-700">Телефон*</label>
                                <input type="tel" class="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-yellow-400 focus:border-yellow-400" required>
                           </div>
                           <div class="md:col-span-2">
                                <label class="block text-sm font-medium text-gray-700">E-Mail</label>
                                <input type="email" class="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-yellow-400 focus:border-yellow-400">
                           </div>
                           <div class="md:col-span-2">
                                <label class="block text-sm font-medium text-gray-700">Адрес доставки</label>
                                <textarea rows="3" class="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-yellow-400 focus:border-yellow-400"></textarea>
                           </div>
                            <div class="md:col-span-2">
                                <label class="block text-sm font-medium text-gray-700">Комментарии к заказу</label>
                                <textarea rows="3" class="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-yellow-400 focus:border-yellow-400"></textarea>
                           </div>
                        </div>
                    </div>

                </div>
                <!-- Order Summary -->
                <div class="lg:col-span-1">
                     <div class="bg-white p-6 rounded-lg shadow-md sticky top-28">
                        <div class="flex justify-between items-center mb-4">
                             <h2 class="text-xl font-bold">Ваш заказ</h2>
                             <button type="button" onclick="setView('cart')" class="text-sm text-yellow-600 hover:underline">Изменить</button>
                        </div>
                        <div class="space-y-2 border-b pb-4 mb-4">
                            <div class="flex justify-between"><span>Товаров на:</span> <span class="font-medium">${formatCurrency(totalCost)}</span></div>
                            <div class="flex justify-between"><span>Доставка:</span> <span class="font-medium">по запросу</span></div>
                        </div>
                        <div class="flex justify-between font-bold text-xl">
                            <span>Итого:</span>
                            <span>${formatCurrency(totalCost)}</span>
                        </div>
                        <div class="mt-6">
                            <label class="flex items-start">
                                <input type="checkbox" required class="h-4 w-4 text-yellow-500 border-gray-300 rounded focus:ring-yellow-400 mt-1">
                                <span class="ml-2 text-sm text-gray-600">Я согласен на обработку персональных данных</span>
                            </label>
                        </div>
                        <button type="submit" class="w-full mt-4 bg-[#fcc521] hover:bg-yellow-500 text-gray-800 font-bold py-3 rounded-lg text-lg transition shadow-lg">Оформить заказ</button>
                     </div>
                </div>
            </div>
            </form>
    `;

    if (isUpdate && checkoutContent) {
        checkoutContent.innerHTML = pageHtml;
        if (window.editorMode) {
            window.editorMode.refresh();
        }
    } else {
        return `<div id="checkout-content" class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">${pageHtml}</div>`;
    }
}



function renderStaticPage(title, content) {
    return `
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
            <div class="bg-white p-8 rounded-lg shadow-md">
                <h1 class="js-editable text-4xl font-bold text-gray-800 mb-6">${title}</h1>
                <div class="prose max-w-none">${content}</div>
            </div>
        </div>
    `;
}


function renderCatalogPage() {
    const categories = getOrderedCategories();
    const content = `
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        <h1 class="text-4xl font-bold text-gray-800 mb-6">Каталог</h1>
        <div class="grid grid-cols-1 md:grid-cols-4 gap-8">
            <aside class="md:col-span-1">
                <ul class="space-y-2 bg-white p-4 rounded-lg shadow-md">
                    ${categories.map(cat => `
                        <li>
                            <a href="#" onclick="event.preventDefault(); handleCategoryClick('${cat.slug}')" class="flex items-center p-2 text-gray-700 rounded-lg hover:bg-gray-100 hover:text-[#fcc521]">
                                <i class="fas ${cat.icon} w-6 text-center"></i>
                                <span class="ml-3">${escapeHtml(cat.title)}</span>
                            </a>
                        </li>
                    `).join('')}
                </ul>
            </aside>
            <main class="md:col-span-3">
                 <div class="grid grid-cols-1 lg:grid-cols-2 gap-8" data-groups-container="catalog">
                    ${categories.map(cat => {
                        const orderedSubcategories = getOrderedSubcategories(cat);
                        const hasSubcategories = orderedSubcategories.length > 0;
                        const subcategoriesHtml = hasSubcategories
                            ? orderedSubcategories.map(sub => renderSubcategoryPreview(cat, sub)).join('')
                            : '<li class="text-xs text-gray-400">Подкатегории в разработке</li>';
                        return `
                            <div class="bg-white p-4 rounded-lg shadow-md flex gap-4 relative" data-group-id="${escapeHtmlAttribute(cat.slug)}">
                                <button type="button" class="editor-only js-drag text-gray-400 hover:text-gray-600 absolute top-3 right-3" aria-label="Переместить категорию">
                                    <i class="fas fa-grip-vertical"></i>
                                </button>
                                <img src="${cat.image}" alt="${escapeHtml(cat.title)}" class="w-24 h-24 object-cover rounded-md"/>
                                <div class="pr-6">
                                    <h3 class="font-bold text-lg cursor-pointer" onclick="handleCategoryClick('${cat.slug}')">${escapeHtml(cat.title)}</h3>
                                    <ul class="text-sm mt-2 space-y-2" data-items-container="${escapeHtmlAttribute(cat.slug)}">
                                        ${subcategoriesHtml}
                                    </ul>
                                </div>
                            </div>
                        `;
                    }).join('')}
                 </div>
            </main>
        </div>
    </div>
    `;
    return content;
}

function renderProductGridOnly() {
    const container = document.getElementById('product-grid-container');
    if (container) {
        const visibleProducts = getVisibleProducts();
        container.innerHTML = visibleProducts.length > 0 
            ? visibleProducts.map(renderProductCard).join('') 
            : `<p class="col-span-full text-center text-gray-500 py-10">Товары не найдены по вашему запросу.</p>`;
    }
}


/**
 * Отрисовывает страницу списка товаров вместе с фильтрами и сортировкой.
 */
function renderProductList() {
    const visibleProducts = getVisibleProducts();

    return `
        ${renderCatalogPage()}
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 mt-[-2rem] mb-8">
            <div class="bg-gray-100 p-4 md:p-6 rounded-lg">
                <div class="flex flex-col md:flex-row gap-4 items-center">
                     <h2 class="text-2xl font-bold text-gray-800">Все товары</h2>
                    <div class="flex-grow"></div>
                    <div class="flex items-center gap-4">
                        <label class="flex items-center gap-2 text-sm text-gray-700 bg-white px-3 py-2 rounded-lg shadow-sm">
                            <input type="checkbox" ${state.meta.onlyWithPrice ? 'checked' : ''} onchange="setOnlyWithPrice(this.checked)" class="h-4 w-4 text-[#fcc521] border-gray-300 rounded focus:ring-[#fcc521]"/>
                            <span>Только с ценой</span>
                        </label>
                        <select onchange="setState({ sortBy: this.value })" class="w-full md:w-auto px-4 py-2 border border-gray-300 rounded-lg bg-white focus:ring-2 focus:ring-[#fcc521] focus:outline-none">
                            <option value="name-asc" ${state.meta.sortBy === 'name-asc' ? 'selected' : ''}>По названию (А-Я)</option>
                            <option value="name-desc" ${state.meta.sortBy === 'name-desc' ? 'selected' : ''}>По названию (Я-А)</option>
                            <option value="price-asc" ${state.meta.sortBy === 'price-asc' ? 'selected' : ''}>Сначала дешевле</option>
                            <option value="price-desc" ${state.meta.sortBy === 'price-desc' ? 'selected' : ''}>Сначала дороже</option>
                        </select>
                    </div>
                </div>
            </div>
            <div id="product-grid-container" class="grid-container grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-6">
                ${visibleProducts.length > 0 ? visibleProducts.map((product, index) => renderProductCard(product, index)).join('') : `<p class="col-span-full text-center text-gray-500 py-10">Товары не найдены.</p>`}
            </div>
        </div>`;
}

/**
 * Рендерит карточку товара в списке с учётом цены, бейджей и безопасного изображения.
 */
function renderProductCard(product, index = 0) {
    const itemInCart = state.items.cartItems[product.id];
    const priceLabel = getProductPriceLabel(product);
    const unitLabel = product.hasPrice ? `<span class="text-sm font-normal text-gray-500"> / ${escapeHtml(product.unit)}</span>` : '';
    const titleAttr = escapeHtmlAttribute(product.name);
    const nameText = escapeHtml(product.name);
    const categoryText = escapeHtml(product.category);
    const productImage = resolveProductImage(product);
    const replacePhotoInputId = buildEditorInputId('replace-photo-card', `${product.id}-${index}`);
    const actionHtml = product.hasPrice
        ? (!itemInCart
            ? `<button onclick="addToCart('${product.id}')" class="bg-[#fcc521] hover:bg-yellow-500 text-gray-800 font-bold px-4 py-2 rounded-md transition-colors duration-200">В корзину</button>`
            : `<div class="flex items-center rounded-lg border border-gray-300">
                                    <button onclick="updateCartItemQuantity('${product.id}', -1)" class="px-3 py-1 text-lg hover:bg-gray-100 rounded-l-lg">-</button>
                                    <span class="px-3 font-medium">${itemInCart.quantity}</span>
                                    <button onclick="updateCartItemQuantity('${product.id}', 1)" class="px-3 py-1 text-lg hover:bg-gray-100 rounded-r-lg">+</button>
                                </div>`)
        : `<button onclick="requestPrice('${product.id}')" class="bg-gray-200 hover:bg-gray-300 text-gray-700 font-semibold px-4 py-2 rounded-md transition-colors duration-200">Запросить цену</button>`;
    return `
        <div class="bg-white rounded-lg shadow-md overflow-hidden transform hover:-translate-y-1 transition-transform duration-300 flex flex-col group border">
            <div class="relative h-48 bg-gray-200 cursor-pointer" onclick="showDetails('${product.id}')">
                <img src="${productImage}" alt="${titleAttr}" class="w-full h-full object-cover" onerror="this.onerror=null; this.src='${PLACEHOLDER_IMAGE}'"/>
                ${product.badges.noPrice ? `<span class="absolute top-3 left-3 bg-amber-500 text-white text-xs font-semibold px-2 py-1 rounded">Цена по запросу</span>` : ''}
            </div>
            <div class="p-4 flex-grow flex flex-col gap-3">
                <h3 class="text-md font-semibold text-gray-800 cursor-pointer hover:text-yellow-500" onclick="showDetails('${product.id}')" title="${titleAttr}" style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">
                    ${nameText}
                </h3>
                <p class="text-sm text-gray-500">${categoryText}</p>
                <p class="text-lg font-bold text-gray-900">${priceLabel}${unitLabel}</p>
                <div class="mt-auto flex flex-col gap-3">
                    ${actionHtml}
                    <div class="editor-only space-y-2">
                        <label for="${replacePhotoInputId}" class="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white shadow transition hover:bg-slate-800">
                            <i class="fas fa-camera-retro text-xs"></i>
                            <span>Заменить фото</span>
                        </label>
                        <input
                            id="${replacePhotoInputId}"
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
        </div>`;
}

function renderCartView() {
    const totalCost = calculateTotalCost();
    return `
        <div class="max-w-4xl mx-auto p-4 sm:p-6">
            <h2 class="text-3xl font-bold text-gray-800 mb-6">Корзина</h2>
             ${calculateCartCount() === 0 ? `
                <div class="text-center py-16 bg-white rounded-lg shadow-md">
                    <i class="fas fa-shopping-basket text-5xl text-gray-300 mb-4"></i>
                    <p class="text-xl text-gray-600 mb-4">Ваша корзина пуста</p>
                    <button onclick="setView('catalog')" class="bg-[#fcc521] hover:bg-yellow-500 text-gray-800 font-bold px-6 py-2 rounded-lg transition">Перейти в каталог</button>
                </div>` : `
                <div class="space-y-4">${Object.entries(state.items.cartItems).map(([productId, item]) => {
                    const itemName = escapeHtml(item.name);
                    const itemUnit = escapeHtml(item.unit);
                    return `
                    <div class="flex flex-col sm:flex-row items-center bg-white p-4 rounded-lg shadow-sm gap-4">
                        <div class="flex-grow w-full"><h3 class="text-lg font-semibold text-gray-800">${itemName}</h3><p class="text-sm text-gray-500">${formatCurrency(item.price)} / ${itemUnit}</p></div>
                        <div class="flex items-center gap-4">
                            <div class="flex items-center border border-gray-300 rounded-md">
                                <button onclick="updateCartItemQuantity('${productId}', -1)" class="px-3 py-1 text-lg hover:bg-gray-100 rounded-l-md">-</button>
                                <span class="px-4 font-medium">${item.quantity}</span>
                                <button onclick="updateCartItemQuantity('${productId}', 1)" class="px-3 py-1 text-lg hover:bg-gray-100 rounded-r-md">+</button>
                            </div>
                            <div class="font-bold text-lg text-gray-800 w-32 text-right">${formatCurrency(item.quantity * item.price)}</div>
                            <button onclick="removeFromCart('${productId}')" class="text-gray-400 hover:text-red-500 transition"><i class="fas fa-trash-alt"></i></button>
                        </div>
                    </div>`;}).join('')}
                </div>
                <div class="mt-6 p-6 bg-white rounded-lg shadow-md flex justify-between items-center">
                    <span class="text-xl font-bold text-gray-800">Итого:</span>
                    <span class="text-2xl font-extrabold text-gray-800">${formatCurrency(totalCost)}</span>
                </div>
                <button onclick="setView('checkout')" class="w-full mt-4 bg-[#fcc521] hover:bg-yellow-500 text-gray-800 font-bold py-3 rounded-lg text-lg transition shadow-lg">Оформить заказ</button>
            `}
        </div>`;
}

/**
 * Отрисовывает карточку товара с безопасным описанием и адаптированными действиями.
 */
function renderProductDetails() {
    const product = state.items.products.find(p => String(p.id) === String(state.layout.selectedProductId));
    if (!product) return `<div class="p-10 text-center text-red-600">Продукт не найден.</div>`;
    const itemInCart = state.items.cartItems[product.id];
    const sanitizedDescription = sanitizeHtml(product.descriptionHtml);
    const descriptionBlock = sanitizedDescription
        ? `<div class="prose max-w-none space-y-4 product-description">${sanitizedDescription}</div>`
        : '<p class="text-gray-500">Описание временно недоступно.</p>';
    const priceLabel = getProductPriceLabel(product);
    const unitText = escapeHtml(product.unit);
    const unitLabel = product.hasPrice ? `<span class="text-lg font-normal text-gray-500">/ ${unitText}</span>` : '';
    const badges = [
        product.badges?.noPrice ? '<span class="bg-amber-500 text-white text-xs font-semibold px-3 py-1 rounded-full">Цена по запросу</span>' : '',
        product.badges?.hasTable ? '<span class="bg-blue-100 text-blue-700 text-xs font-semibold px-3 py-1 rounded-full">Таблица в описании</span>' : '',
    ].filter(Boolean).join(' ');
    const titleAttr = escapeHtmlAttribute(product.name);
    const nameText = escapeHtml(product.name);
    const categoryText = escapeHtml(product.category);
    const productImage = resolveProductImage(product, { fallbackWidth: 800, fallbackHeight: 600 });
    const detailInputId = buildEditorInputId('replace-photo-detail', product.id);

    return `
        <div class="max-w-5xl mx-auto p-4 sm:p-6 bg-white my-8 rounded-lg shadow-xl">
            <button onclick="exitProductDetails()" class="mb-6 text-gray-600 hover:text-[#fcc521] hover:underline flex items-center transition">
                <i class="fas fa-arrow-left mr-2"></i> Назад в каталог
            </button>
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
                <div class="flex flex-col gap-4">
                    <div class="bg-gray-100 rounded-lg flex items-center justify-center p-4">
                        <img src="${productImage}" alt="${titleAttr}" class="max-h-96 w-auto object-contain" onerror="this.onerror=null; this.src='${PLACEHOLDER_IMAGE}'"/>
                    </div>
                    <div class="editor-only space-y-2">
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
                <div class="space-y-4">
                    <div class="space-y-2">
                        <h2 class="text-3xl font-bold text-gray-900">${nameText}</h2>
                        <p class="text-sm text-gray-500">Категория: ${categoryText}</p>
                        ${badges ? `<div class="flex flex-wrap gap-2">${badges}</div>` : ''}
                    </div>
                    <p class="text-3xl font-bold text-gray-800">${priceLabel}${unitLabel}</p>
                    <div class="space-y-3">
                        <h3 class="text-lg font-semibold text-gray-800 border-b pb-2">Описание</h3>
                        ${descriptionBlock}
                    </div>
                    <div class="pt-4">
                        ${product.hasPrice ? (
                            !itemInCart
                                ? `<button onclick="addToCart('${product.id}')" class="w-full sm:w-auto bg-[#fcc521] hover:bg-yellow-500 text-gray-800 font-bold px-8 py-3 rounded-lg text-lg transition shadow-lg">
                                        <i class="fas fa-cart-plus mr-2"></i>Добавить в корзину
                                   </button>`
                                : `<div class="flex flex-col sm:flex-row sm:items-center sm:space-x-4 space-y-4 sm:space-y-0">
                                        <div class="flex items-center rounded-lg border-2 border-[#fcc521] text-lg">
                                            <button onclick="updateCartItemQuantity('${product.id}', -1)" class="px-4 py-2 hover:bg-gray-100 rounded-l-md">-</button>
                                            <span class="px-5 font-bold">${itemInCart.quantity} ${unitText}</span>
                                            <button onclick="updateCartItemQuantity('${product.id}', 1)" class="px-4 py-2 hover:bg-gray-100 rounded-r-md">+</button>
                                        </div>
                                        <button onclick="removeFromCart('${product.id}')" class="text-red-500 hover:underline">Удалить из корзины</button>
                                   </div>`
                        ) : `<button onclick="requestPrice('${product.id}')" class="w-full sm:w-auto bg-gray-200 hover:bg-gray-300 text-gray-700 font-semibold px-8 py-3 rounded-lg text-lg transition">Запросить цену</button>`}
                    </div>
                </div>
            </div>
        </div>`;
}

function renderAdminPanel() {
    const adminContentElement = document.getElementById('admin-content');
    if (!adminContentElement) return;

    const {
        productName,
        productPrice,
        productUnit,
        productImage,
        productDescription,
        jsonInput,
        isGenerating,
        apiError,
    } = window.adminState;

    const sanitizedName = escapeHtmlAttribute(productName);
    const sanitizedPrice = escapeHtmlAttribute(productPrice);
    const sanitizedUnit = escapeHtmlAttribute(productUnit);
    const sanitizedImage = escapeHtmlAttribute(productImage);
    const sanitizedDescription = escapeHtml(productDescription);
    const sanitizedJson = escapeHtml(jsonInput);
    const generateButtonLabel = isGenerating ? 'Генерация…' : 'Сгенерировать описание';
    const generateButtonDisabled = isGenerating || !String(productName || '').trim();

    adminContentElement.innerHTML = `
        <div class="max-w-3xl mx-auto p-6 space-y-8">
            <h2 class="text-3xl font-bold text-gray-800">Панель Администратора</h2>
            <div class="bg-white p-6 rounded-lg shadow-md space-y-4">
                 <h3 class="text-xl font-semibold text-gray-700">Массовый Импорт (JSON / CSV)</h3>
                 <input type="file" id="json-file-upload" accept=".json, .csv" class="w-full border p-2 rounded"/>
                 <textarea id="jsonInput" rows="6" placeholder="Вставьте JSON или загрузите файл..." class="w-full border p-2 rounded">${sanitizedJson}</textarea>
                 <button id="import-json" class="w-full bg-indigo-600 text-white py-2 rounded-lg hover:bg-indigo-700">Импортировать</button>
            </div>
             <form id="singleProductForm" class="bg-white p-6 rounded-lg shadow-md space-y-4">
                 <h3 class="text-xl font-semibold text-gray-700">Добавить продукт</h3>
                 <input type="text" id="name" value="${sanitizedName}" placeholder="Название" class="w-full border p-2 rounded" required/>
                 <div class="flex gap-4">
                    <input type="number" id="price" value="${sanitizedPrice}" placeholder="Цена" class="w-1/2 border p-2 rounded" required min="0.01" step="0.01"/>
                    <input type="text" id="unit" value="${sanitizedUnit}" placeholder="Ед. изм." class="w-1/2 border p-2 rounded"/>
                 </div>
                 <input type="text" id="image" value="${sanitizedImage}" placeholder="URL изображения" class="w-full border p-2 rounded"/>
                 <div class="space-y-3">
                     <div class="flex items-center justify-between">
                         <label for="description" class="text-sm font-medium text-gray-700">Описание</label>
                         <button type="button" id="generate-description" class="text-sm font-semibold text-indigo-600 hover:text-indigo-500 disabled:opacity-60" ${generateButtonDisabled ? 'disabled' : ''}>${generateButtonLabel}</button>
                     </div>
                     <textarea id="description" rows="4" placeholder="Описание" class="w-full border p-2 rounded" required>${sanitizedDescription}</textarea>
                 </div>
                 ${apiError ? `<div class="flex items-start justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-700" role="alert"><span class="flex-1">${escapeHtml(apiError.message || 'Неизвестная ошибка')}</span><button type="button" data-admin-action="retry-generation" class="shrink-0 rounded-md border border-amber-500 px-3 py-1 text-xs font-semibold text-amber-700 transition hover:bg-amber-100">Повторить</button></div>` : ''}
                 <button type="submit" class="w-full bg-gray-800 hover:bg-gray-700 text-white py-2 rounded-lg">Добавить товар</button>
             </form>
        </div>`;

    const fileInput = adminContentElement.querySelector('#json-file-upload');
    if (fileInput) {
        fileInput.addEventListener('change', (event) => {
            const file = event?.target?.files?.[0];
            if (file) handleFileChange(file);
        });
    }

    const jsonTextarea = adminContentElement.querySelector('#jsonInput');
    if (jsonTextarea) {
        jsonTextarea.addEventListener('input', (event) => {
            window.adminState.jsonInput = event.target.value;
        });
    }

    const importButton = adminContentElement.querySelector('#import-json');
    if (importButton) {
        importButton.addEventListener('click', (event) => {
            event.preventDefault();
            handleBulkImport(window.adminState.jsonInput);
        });
    }

    const form = adminContentElement.querySelector('#singleProductForm');
    if (form) {
        const nameInput = form.querySelector('#name');
        const priceInput = form.querySelector('#price');
        const unitInput = form.querySelector('#unit');
        const imageInput = form.querySelector('#image');
        const descriptionInput = form.querySelector('#description');
        const generateButton = form.querySelector('#generate-description');

        if (nameInput) {
            nameInput.addEventListener('input', (event) => {
                window.adminState.productName = event.target.value;
                window.adminState.apiError = null;
            });
        }
        if (priceInput) {
            priceInput.addEventListener('input', (event) => {
                window.adminState.productPrice = event.target.value;
            });
        }
        if (unitInput) {
            unitInput.addEventListener('input', (event) => {
                window.adminState.productUnit = event.target.value;
            });
        }
        if (imageInput) {
            imageInput.addEventListener('input', (event) => {
                window.adminState.productImage = event.target.value;
            });
        }
        if (descriptionInput) {
            descriptionInput.addEventListener('input', (event) => {
                window.adminState.productDescription = event.target.value;
            });
        }
        const runGeneration = async () => {
            if (window.adminState.isGenerating || !window.adminState.productName.trim()) {
                return;
            }
            window.adminState.isGenerating = true;
            window.adminState.apiError = null;
            renderAdminContent();
            try {
                const desc = await generateDescription(window.adminState.productName);
                window.adminState.productDescription = desc;
            } catch (error) {
                window.adminState.apiError = { message: error.message || 'Не удалось выполнить запрос.' };
            } finally {
                window.adminState.isGenerating = false;
                renderAdminContent();
            }
        };

        if (generateButton) {
            generateButton.addEventListener('click', runGeneration);
        }

        const retryButton = form.querySelector('[data-admin-action="retry-generation"]');
        if (retryButton) {
            retryButton.addEventListener('click', (event) => {
                event.preventDefault();
                runGeneration();
            });
        }

        form.addEventListener('submit', (event) => {
            event.preventDefault();
            handleAddProduct({
                name: window.adminState.productName,
                price: window.adminState.productPrice,
                unit: window.adminState.productUnit,
                description: window.adminState.productDescription,
                image: window.adminState.productImage,
            });
            window.adminState = {
                ...window.adminState,
                productName: '',
                productPrice: '',
                productUnit: 'шт',
                productDescription: '',
                productImage: 'https://placehold.co/400x300/e2e8f0/94a3b8?text=Стройматериал',
                apiError: null,
            };
            renderAdminContent();
        });
    }
}

function renderAdminContent() {
    if (state.layout.view === 'admin') setTimeout(renderAdminPanel, 0);
}

function renderMessageModal() {
    if (!state.meta.message) return '';
    const safeMessage = escapeHtml(state.meta.message);
    return `<div class="fixed top-5 right-5 bg-gray-800 text-white py-3 px-5 rounded-lg shadow-xl z-50 animate-fade-in-down"><p><i class="fas fa-check-circle mr-2"></i>${safeMessage}</p></div>`;
}

function renderFooter() {
    return `<footer class="bg-gray-800 text-white mt-auto"><div class="max-w-7xl mx-auto py-8 px-4 sm:px-6 lg:px-8 text-center"><p>&copy; 2024 АРТ-СТРОЙ. Все права защищены.</p><p class="text-gray-400 text-sm mt-1">Демо-версия интернет-магазина.</p></div></footer>`;
}

function renderMobileMenu() {
    if (!state.layout.isMenuOpen) return '';
    return `
        <div class="fixed inset-0 bg-black bg-opacity-60 z-[70]" onclick="toggleMenu()">
            <div class="fixed top-0 left-0 h-full w-72 bg-white shadow-xl p-6 transform transition-transform duration-300 ${state.layout.isMenuOpen ? 'translate-x-0' : '-translate-x-full'}" onclick="event.stopPropagation()">
                 <button onclick="toggleMenu()" class="absolute top-4 right-4 text-gray-500 hover:text-gray-800"><i class="fas fa-times text-2xl"></i></button>
                 <nav class="flex flex-col space-y-5 mt-10">
                    <button onclick="setView('catalog'); toggleMenu();" class="text-lg text-gray-700 hover:text-[#fcc521] text-left p-2 rounded-md hover:bg-gray-100 flex items-center"><i class="fas fa-bars w-6 mr-3"></i>Каталог</button>
                    <button onclick="setView('admin'); toggleMenu();" class="text-lg text-gray-700 hover:text-[#fcc521] text-left p-2 rounded-md hover:bg-gray-100 flex items-center"><i class="fas fa-user-shield w-6 mr-3"></i>Админ</button>
                    <hr/>
                    <button onclick="setView('online-calc'); toggleMenu();" class="text-lg text-gray-700 hover:text-[#fcc521] text-left p-2 rounded-md hover:bg-gray-100 flex items-center">Онлайн-расчеты</button>
                    <button onclick="setView('payment'); toggleMenu();" class="text-lg text-gray-700 hover:text-[#fcc521] text-left p-2 rounded-md hover:bg-gray-100 flex items-center">Оплата</button>
                    <button onclick="setView('delivery'); toggleMenu();" class="text-lg text-gray-700 hover:text-[#fcc521] text-left p-2 rounded-md hover:bg-gray-100 flex items-center">Доставка</button>
                    <button onclick="setView('about'); toggleMenu();" class="text-lg text-gray-700 hover:text-[#fcc521] text-left p-2 rounded-md hover:bg-gray-100 flex items-center">О компании</button>
                    <button onclick="setView('contacts'); toggleMenu();" class="text-lg text-gray-700 hover:text-[#fcc521] text-left p-2 rounded-md hover:bg-gray-100 flex items-center">Контакты</button>
                 </nav>
            </div>
        </div>
    `;
}

// --- Главная Функция Рендеринга ---

function render() {
    const appContainer = document.getElementById('app');
    if (state.layout.view === 'checkout') {
         // Для страницы оформления заказа мы не хотим полного перерендера
         if (!document.getElementById('checkout-content')) {
            const checkoutHtml = renderCheckoutPage();
            appContainer.innerHTML = `
                <div class="flex flex-col min-h-screen bg-gray-100">
                    ${renderHeader()}
                    <main class="flex-grow">${checkoutHtml}</main>
                    ${renderFooter()}
                </div>
                ${renderMobileMenu()}
                <div id="modal-container">${renderMessageModal()}</div>`;
            syncEditableContent({ captureMissing: true });
         } else {
            syncEditableContent({ captureMissing: true });
         }
        if (window.editorMode) {
            window.editorMode.refresh();
            refreshCatalogSortables();
        }
        return; // Предотвращаем полный ререндер
    }

    let contentHtml = '';
    switch (state.layout.view) {
        case 'category': contentHtml = renderCategoryPage(state.layout.selectedCategorySlug); break;
        case 'subcategory': contentHtml = renderSubcategoryPage(state.layout.selectedSubcategorySlug, state.layout.selectedCategorySlug); break;
        case 'catalog': contentHtml = renderProductList(); break;
        case 'cart': contentHtml = renderCartView(); break;
        case 'details': contentHtml = renderProductDetails(); break;
        case 'checkout': contentHtml = renderCheckoutPage(); break;
        case 'admin': contentHtml = `<div id="admin-content"></div>`; break;
        case 'online-calc': contentHtml = renderStaticPage('Онлайн-расчеты', '<p>Здесь будет калькулятор для онлайн-расчетов строительных материалов.</p>'); break;
        case 'payment': contentHtml = renderPaymentPage(); break;
        case 'delivery': contentHtml = renderDeliveryPage(); break;
        case 'about': contentHtml = renderAboutPage(); break;
        case 'contacts': contentHtml = renderContactsPage(); break;
        default: contentHtml = renderHomeView();
    }
    appContainer.innerHTML = `
        <div class="flex flex-col min-h-screen bg-gray-100">
            ${renderHeader()}
            <main class="flex-grow">${contentHtml}</main>
            ${renderFooter()}
        </div>
        ${renderMobileMenu()}
        <div id="modal-container">${renderMessageModal()}</div>`;
    syncEditableContent({ captureMissing: true });
    if (window.editorMode) {
        window.editorMode.refresh();
        refreshCatalogSortables();
    }
    if (state.layout.view === 'admin') renderAdminContent();
}

// --- Инициализация ---
const CatalogModule = {
    refreshSortables: refreshCatalogSortables,
    destroySortables: destroyCatalogSortables,
    ensureLayoutOrdering,
    scheduleOrderSave: scheduleCatalogOrderSave,
    persistOrder: persistCatalogOrderSnapshot,
    loadOrder: loadCatalogOrderFromStorage,
};

const HistoryModule = {
    undo: undoStateChange,
    redo: redoStateChange,
    prepareSnapshot: prepareUndoSnapshot,
    commitSnapshot: commitUndoSnapshot,
    pushRedoSnapshot,
};

const StorageModule = {
    getStateStorage,
    saveStateSnapshot,
    scheduleStateSave,
    backupForImport: backupCurrentStateForImport,
};

const ApiModule = {
    request: apiRequest,
    checkHealth: checkApiHealth,
    generateDescription,
};

const UiModule = {
    render,
    startSlider,
    stopSlider,
    syncEditableContent,
    setView,
};

window.App = {
    CONFIG,
    Editor,
    Catalog: CatalogModule,
    History: HistoryModule,
    Storage: StorageModule,
    Api: ApiModule,
    Ui: UiModule,
};

window.setView = setView;
window.showDetails = showDetails;
window.addToCart = addToCart;
window.updateCartItemQuantity = updateCartItemQuantity;
window.removeFromCart = removeFromCart;
window.requestPrice = requestPrice;
window.exitProductDetails = exitProductDetails;
window.handleBulkImport = handleBulkImport;
window.handleFileChange = handleFileChange;
window.handleProductImageReplace = handleProductImageReplace;
window.setState = setState;
window.toggleMenu = toggleMenu;
window.setActiveSlide = setActiveSlide;
window.setCatalogMenu = setCatalogMenu;
window.handleCategoryClick = handleCategoryClick;
window.handleSubcategoryClick = handleSubcategoryClick;
window.handlePlaceOrder = handlePlaceOrder;
window.handleCheckoutChange = handleCheckoutChange;
window.handleSearch = handleSearch;
window.setOnlyWithPrice = setOnlyWithPrice;
window.undoStateChange = undoStateChange;
window.redoStateChange = redoStateChange;

async function bootstrapApplication() {
    await initializeState();
    applyInitialRoute();
    render();
    if (window.editorMode) {
        window.editorMode.setup();
        window.editorMode.refresh();
        refreshCatalogSortables();
    }
    window.addEventListener('hashchange', handleHashChange);
    if (state.layout.view === 'home') {
        startSlider();
    }
}

window.addEventListener('load', () => {
    bootstrapApplication().catch((error) => {
        console.error('[APP:INIT]', error);
    });
});

window.onbeforeunload = () => {
    stopSlider();
};

// --- Тест-кейсы ---
// 1. URL "/?edit=1#/catalog" → плавающая кнопка редактирования видна.
// 2. URL "/#/catalog?edit=1" → кнопка также доступна (параметр читается из hash).
// 3. Ввод PIN короче 4 символов → система отклоняет ввод и показывает предупреждение.
// 4. Успешное включение режима → <body> получает класс .editor-mode, а элементы .js-editable становятся contenteditable.
// 5. Перетаскивание элементов каталога → порядок сохраняется и восстанавливается после перезагрузки страницы.
// 6. Undo/Redo отражают изменения текста и сортировки (кнопки в панели становятся активными/неактивными корректно).
// 7. Экспорт JSON → скачивается файл вида site-snapshot-YYYYMMDD-HHMMSS.json с актуальной схемой и временной меткой.
// 8. Импорт некорректного JSON → показывается понятное сообщение об ошибке, состояние не изменяется.
// 9. /api/health недоступен → индикатор панели становится красным, запрос к /api/generate с ошибкой показывает сообщение и кнопку «Повторить».

