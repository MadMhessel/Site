(function () {
    const EDIT_PARAM = 'edit';
    const SESSION_STORAGE_KEY = 'editor:mode:requested';
    const BUTTON_ID = 'editor-toggle';
    const PANEL_ID = 'editor-panel';
    const BUTTON_CLASSES = 'fixed top-4 right-4 z-50 inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-2 rounded-md bg-gray-900 px-4 py-2 text-white shadow-lg';
    const BUTTON_DEFAULT_LABEL = 'Редактировать';

    const state = {
        requested: false,
        button: null,
        initialized: false,
    };

    const safeWindow = typeof window !== 'undefined' ? window : null;

    function isTruthyEditValue(rawValue) {
        if (rawValue === undefined || rawValue === null) {
            return true;
        }
        const normalized = String(rawValue).trim().toLowerCase();
        if (!normalized) return true;
        return normalized === '1'
            || normalized === 'true'
            || normalized === 'yes'
            || normalized === 'on';
    }

    function readSessionFlag() {
        if (!safeWindow || !safeWindow.sessionStorage) {
            return false;
        }
        try {
            return safeWindow.sessionStorage.getItem(SESSION_STORAGE_KEY) === '1';
        } catch (error) {
            console.warn('[editor:session] read failed', error);
            return false;
        }
    }

    function writeSessionFlag(value) {
        if (!safeWindow || !safeWindow.sessionStorage) {
            return;
        }
        try {
            if (value) {
                safeWindow.sessionStorage.setItem(SESSION_STORAGE_KEY, '1');
            } else {
                safeWindow.sessionStorage.removeItem(SESSION_STORAGE_KEY);
            }
        } catch (error) {
            console.warn('[editor:session] write failed', error);
        }
    }

    function detectEditFromSearch() {
        if (!safeWindow) {
            return { found: false, value: false };
        }
        try {
            const params = new URLSearchParams(safeWindow.location.search || '');
            if (!params.has(EDIT_PARAM)) {
                return { found: false, value: false };
            }
            const raw = params.get(EDIT_PARAM);
            return { found: true, value: isTruthyEditValue(raw) };
        } catch (error) {
            console.warn('[editor:detect] search parse failed', error);
            return { found: false, value: false };
        }
    }

    function detectEditFromHash() {
        if (!safeWindow) {
            return { found: false, value: false };
        }
        const hash = safeWindow.location.hash || '';
        if (!hash) {
            return { found: false, value: false };
        }
        const match = hash.match(/[?&]edit(?:=([^&#]*))?/i);
        if (!match) {
            return { found: false, value: false };
        }
        try {
            const raw = match[1] ? decodeURIComponent(match[1]) : '';
            return { found: true, value: isTruthyEditValue(raw) };
        } catch (error) {
            console.warn('[editor:detect] hash parse failed', error);
            return { found: true, value: true };
        }
    }

    function detectEditFromLocation() {
        const fromSearch = detectEditFromSearch();
        if (fromSearch.found) {
            return fromSearch;
        }
        const fromHash = detectEditFromHash();
        if (fromHash.found) {
            return fromHash;
        }
        return { found: false, value: false };
    }

    function ensureButtonMounted() {
        if (!safeWindow || !safeWindow.document || !safeWindow.document.body) {
            return;
        }
        let button = safeWindow.document.getElementById(BUTTON_ID);
        if (!button) {
            button = safeWindow.document.createElement('button');
            button.id = BUTTON_ID;
            button.type = 'button';
            button.className = BUTTON_CLASSES;
            button.hidden = true;
            button.setAttribute('aria-controls', PANEL_ID);
            button.setAttribute('aria-label', 'Переключить режим редактирования');
            button.setAttribute('aria-pressed', 'false');
            button.textContent = BUTTON_DEFAULT_LABEL;
            button.dataset.editorFloating = 'true';
            safeWindow.document.body.appendChild(button);
        } else if (button.parentElement !== safeWindow.document.body) {
            safeWindow.document.body.appendChild(button);
        }
        state.button = button;
    }

    function notifyConsumers() {
        if (safeWindow && safeWindow.editorMode && typeof safeWindow.editorMode.refresh === 'function') {
            safeWindow.editorMode.refresh();
        }
        if (safeWindow) {
            const event = new CustomEvent('editor:request-changed', {
                detail: { requested: state.requested },
            });
            safeWindow.dispatchEvent(event);
        }
    }

    function updateButtonVisibility() {
        if (!state.button) return;
        state.button.hidden = !state.requested;
        state.button.setAttribute('aria-hidden', state.requested ? 'false' : 'true');
        state.button.dataset.editorRequested = state.requested ? 'true' : 'false';
        if (!state.button.textContent || !state.button.textContent.trim()) {
            state.button.textContent = BUTTON_DEFAULT_LABEL;
        }
    }

    function setRequested(value, { persist = true, notify = true } = {}) {
        const normalized = Boolean(value);
        if (persist) {
            writeSessionFlag(normalized);
        }
        const changed = state.requested !== normalized;
        state.requested = normalized;
        updateButtonVisibility();
        if (changed && notify) {
            notifyConsumers();
        }
        return state.requested;
    }

    function syncFromLocation({ reason = 'navigation' } = {}) {
        const detection = detectEditFromLocation();
        if (detection.found) {
            return setRequested(detection.value, { persist: true, notify: true });
        }
        if (reason === 'init') {
            writeSessionFlag(false);
            return setRequested(false, { persist: false, notify: true });
        }
        const stored = readSessionFlag();
        return setRequested(stored, { persist: false, notify: true });
    }

    function handleLocationChange(event) {
        syncFromLocation({ reason: event?.type || 'navigation' });
    }

    function init() {
        if (state.initialized) return;
        ensureButtonMounted();
        syncFromLocation({ reason: 'init' });
        updateButtonVisibility();
        if (safeWindow) {
            safeWindow.addEventListener('hashchange', handleLocationChange);
            safeWindow.addEventListener('popstate', handleLocationChange);
        }
        state.initialized = true;
    }

    const api = {
        isEditModeRequested() {
            return Boolean(state.requested);
        },
        setEditModeRequested(value, options) {
            return setRequested(value, options);
        },
        syncFromLocation,
        readSessionFlag,
    };

    if (safeWindow) {
        safeWindow.EditorSession = api;
    }

    if (safeWindow && safeWindow.document) {
        if (safeWindow.document.readyState === 'loading') {
            safeWindow.document.addEventListener('DOMContentLoaded', init, { once: true });
        } else {
            init();
        }
    }
})();
