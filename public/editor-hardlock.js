(function () {
    'use strict';

    const doc = document;
    const BODY_CLASS = 'editor-mode';
    const EDITABLE_SELECTOR = '.js-editable, [data-editable]';
    const MODE_STORAGE_KEY = 'editorHardlock:mode';
    const SEARCH_STORAGE_KEY = 'editorHardlock:search';
    const FALLBACK_SESSION_KEY = 'editModeRequested';
    const SEARCH_SELECTORS = [
        '#site-search',
        'input[type="search"][name="q"]',
        '.js-site-search',
        'input[type="search"]',
        'input[placeholder="Поиск"]',
    ];
    const SEARCH_HANDLER_KEY = '__editorHardlockHandlers__';

    const defaultSearchState = {
        value: '',
        selectionStart: null,
        selectionEnd: null,
        focused: false,
    };

    const storedSearchState = readSearchState();
    let searchState = storedSearchState ? { ...defaultSearchState, ...storedSearchState } : { ...defaultSearchState };
    let hardLockActive = false;
    let enforceScheduled = false;
    let observer = null;
    let searchInput = null;
    let wrapRetryTimer = null;

    loadInitialHardLockState();
    monkeyPatchClassList();

    if (doc.readyState === 'complete') {
        init();
    } else {
        window.addEventListener('load', init, { once: true });
    }

    function init() {
        if (!wrapEditorMode()) {
            wrapRetryTimer = window.setInterval(() => {
                if (wrapEditorMode()) {
                    window.clearInterval(wrapRetryTimer);
                    wrapRetryTimer = null;
                    scheduleEnforce();
                }
            }, 50);
            window.setTimeout(() => {
                if (wrapRetryTimer) {
                    window.clearInterval(wrapRetryTimer);
                    wrapRetryTimer = null;
                }
            }, 5000);
        }

        ensureSearchBinding();
        startObserver();
        document.addEventListener('selectionchange', handleDocumentSelectionChange, true);
        scheduleEnforce();
    }

    function loadInitialHardLockState() {
        const stored = safeSessionGet(MODE_STORAGE_KEY);
        if (stored === '1') {
            hardLockActive = true;
            return;
        }
        if (stored === '0') {
            hardLockActive = false;
            safeSessionSet(MODE_STORAGE_KEY, null);
            return;
        }
        const requested = safeSessionGet(FALLBACK_SESSION_KEY) === '1';
        hardLockActive = requested;
        if (hardLockActive) {
            safeSessionSet(MODE_STORAGE_KEY, '1');
        }
    }

    function isHardLockActive() {
        return hardLockActive;
    }

    function setHardLockState(active) {
        const desired = Boolean(active);
        if (hardLockActive === desired) {
            return;
        }
        hardLockActive = desired;
        if (desired) {
            safeSessionSet(MODE_STORAGE_KEY, '1');
        } else {
            safeSessionSet(MODE_STORAGE_KEY, null);
        }
    }

    function monkeyPatchClassList() {
        const proto = DOMTokenList.prototype;
        if (proto.remove.__editorHardlockPatched) {
            return;
        }
        const originalRemove = proto.remove;
        const patchedRemove = function (...tokens) {
            if (this === doc.body?.classList && isHardLockActive() && tokens && tokens.length) {
                const filtered = tokens.filter((token) => token !== BODY_CLASS);
                if (filtered.length !== tokens.length) {
                    if (!filtered.length) {
                        return;
                    }
                    return originalRemove.apply(this, filtered);
                }
            }
            return originalRemove.apply(this, tokens);
        };
        Object.defineProperty(patchedRemove, '__editorHardlockPatched', { value: true });
        proto.remove = patchedRemove;
    }

    function wrapEditorMode() {
        const editor = window.editorMode;
        if (!editor || wrapEditorMode.__wrapped) {
            return Boolean(editor);
        }
        wrapEditorMode.__wrapped = true;

        if (typeof editor.enter === 'function') {
            const originalEnter = editor.enter.bind(editor);
            editor.enter = async function (...args) {
                const result = await originalEnter(...args);
                if (result !== false) {
                    setHardLockState(true);
                }
                scheduleEnforce();
                return result;
            };
        }

        if (typeof editor.exit === 'function') {
            const originalExit = editor.exit.bind(editor);
            editor.exit = function (...args) {
                const wasLocked = isHardLockActive();
                if (wasLocked) {
                    setHardLockState(false);
                }
                const result = originalExit.apply(this, args);
                if (wasLocked && doc.body && doc.body.classList.contains(BODY_CLASS)) {
                    setHardLockState(true);
                }
                scheduleEnforce();
                return result;
            };
        }

        if (typeof editor.toggle === 'function') {
            const originalToggle = editor.toggle.bind(editor);
            editor.toggle = async function (...args) {
                const result = await originalToggle(...args);
                const hasClass = doc.body && doc.body.classList.contains(BODY_CLASS);
                setHardLockState(Boolean(hasClass));
                scheduleEnforce();
                return result;
            };
        }

        if (typeof editor.refresh === 'function') {
            const originalRefresh = editor.refresh.bind(editor);
            editor.refresh = function (...args) {
                const refreshResult = originalRefresh.apply(this, args);
                if (isHardLockActive()) {
                    applyEditableFallback();
                }
                return refreshResult;
            };
        }

        return true;
    }

    function startObserver() {
        if (observer || !doc.body) {
            return;
        }
        observer = new MutationObserver(() => {
            scheduleEnforce();
        });
        observer.observe(doc.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class'],
        });
    }

    function scheduleEnforce() {
        if (enforceScheduled) {
            return;
        }
        enforceScheduled = true;
        window.requestAnimationFrame(() => {
            enforceScheduled = false;
            enforceEditorState();
            ensureSearchBinding();
        });
    }

    function enforceEditorState() {
        if (!isHardLockActive()) {
            return;
        }
        if (doc.body && !doc.body.classList.contains(BODY_CLASS)) {
            doc.body.classList.add(BODY_CLASS);
        }
        if (window.editorMode && typeof window.editorMode.refresh === 'function') {
            try {
                window.editorMode.refresh();
            } catch (error) {
                applyEditableFallback();
            }
        } else {
            applyEditableFallback();
        }
    }

    function applyEditableFallback() {
        if (!isHardLockActive()) {
            return;
        }
        const elements = doc.querySelectorAll(EDITABLE_SELECTOR);
        elements.forEach((element) => {
            if (!element.isContentEditable) {
                element.setAttribute('contenteditable', 'plaintext-only');
                if (element.contentEditable !== 'plaintext-only') {
                    element.setAttribute('contenteditable', 'true');
                }
            }
        });
    }

    function ensureSearchBinding() {
        if (searchInput && (!doc.body || !doc.body.contains(searchInput))) {
            unbindSearchInput(searchInput);
            searchInput = null;
        }
        const candidate = findSearchInput();
        if (!candidate) {
            return;
        }
        if (candidate === searchInput) {
            return;
        }
        if (candidate[SEARCH_HANDLER_KEY]) {
            searchInput = candidate;
            restoreSearchState(candidate);
            return;
        }
        if (searchInput) {
            unbindSearchInput(searchInput);
        }
        searchInput = candidate;
        bindSearchInput(candidate);
        restoreSearchState(candidate);
    }

    function findSearchInput() {
        for (const selector of SEARCH_SELECTORS) {
            const element = doc.querySelector(selector);
            if (element instanceof HTMLInputElement) {
                return element;
            }
        }
        return null;
    }

    function bindSearchInput(element) {
        if (!element) {
            return;
        }
        const handlers = {
            input(event) {
                updateSearchStateFromElement(event.currentTarget);
            },
            focus(event) {
                const target = event.currentTarget;
                updateSearchStateFromElement(target);
                updateSearchState({ focused: true });
            },
            blur(event) {
                const target = event.currentTarget;
                updateSearchStateFromElement(target);
                window.requestAnimationFrame(() => {
                    if (!doc.body || !doc.body.contains(target)) {
                        updateSearchState({ focused: true });
                        return;
                    }
                    if (doc.activeElement !== target) {
                        updateSearchState({ focused: false });
                    }
                });
            },
            keyup(event) {
                if (doc.activeElement === event.currentTarget) {
                    updateSearchStateFromElement(event.currentTarget);
                }
            },
            mouseup(event) {
                if (doc.activeElement === event.currentTarget) {
                    updateSearchStateFromElement(event.currentTarget);
                }
            },
        };

        element.addEventListener('input', handlers.input);
        element.addEventListener('focus', handlers.focus);
        element.addEventListener('blur', handlers.blur);
        element.addEventListener('keyup', handlers.keyup);
        element.addEventListener('mouseup', handlers.mouseup);
        element[SEARCH_HANDLER_KEY] = handlers;
    }

    function unbindSearchInput(element) {
        const handlers = element && element[SEARCH_HANDLER_KEY];
        if (!handlers) {
            return;
        }
        element.removeEventListener('input', handlers.input);
        element.removeEventListener('focus', handlers.focus);
        element.removeEventListener('blur', handlers.blur);
        element.removeEventListener('keyup', handlers.keyup);
        element.removeEventListener('mouseup', handlers.mouseup);
        try {
            delete element[SEARCH_HANDLER_KEY];
        } catch (error) {
            element[SEARCH_HANDLER_KEY] = undefined;
        }
    }

    function restoreSearchState(element) {
        if (!element || !searchState) {
            return;
        }
        if (typeof searchState.value === 'string' && element.value !== searchState.value) {
            element.value = searchState.value;
            element.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const applySelection = () => {
            if (typeof searchState.selectionStart === 'number' && typeof searchState.selectionEnd === 'number') {
                const max = element.value.length;
                const start = clamp(searchState.selectionStart, 0, max);
                const end = clamp(searchState.selectionEnd, 0, max);
                try {
                    element.setSelectionRange(start, end);
                } catch (error) {
                    /* ignore selection errors */
                }
            }
        };
        if (searchState.focused) {
            window.requestAnimationFrame(() => {
                if (!doc.body || !doc.body.contains(element)) {
                    return;
                }
                if (doc.activeElement !== element) {
                    try {
                        element.focus({ preventScroll: true });
                    } catch (error) {
                        element.focus();
                    }
                }
                applySelection();
            });
        } else {
            applySelection();
        }
    }

    function handleDocumentSelectionChange() {
        if (!searchInput) {
            return;
        }
        if (doc.activeElement === searchInput) {
            updateSearchStateFromElement(searchInput);
        }
    }

    function updateSearchStateFromElement(element) {
        if (!element || !(element instanceof HTMLInputElement)) {
            return;
        }
        const partial = {
            value: element.value || '',
        };
        if (typeof element.selectionStart === 'number' && typeof element.selectionEnd === 'number') {
            partial.selectionStart = element.selectionStart;
            partial.selectionEnd = element.selectionEnd;
        }
        updateSearchState(partial);
    }

    function updateSearchState(partial) {
        searchState = { ...searchState, ...partial };
        persistSearchState();
    }

    function persistSearchState() {
        try {
            const isDefault = searchState.value === ''
                && searchState.focused === false
                && (searchState.selectionStart === null || searchState.selectionStart === 0)
                && (searchState.selectionEnd === null || searchState.selectionEnd === 0);
            if (isDefault) {
                sessionStorage.removeItem(SEARCH_STORAGE_KEY);
            } else {
                sessionStorage.setItem(SEARCH_STORAGE_KEY, JSON.stringify(searchState));
            }
        } catch (error) {
            /* ignore storage errors */
        }
    }

    function readSearchState() {
        try {
            const raw = sessionStorage.getItem(SEARCH_STORAGE_KEY);
            if (!raw) {
                return null;
            }
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') {
                return null;
            }
            return {
                value: typeof parsed.value === 'string' ? parsed.value : '',
                selectionStart: typeof parsed.selectionStart === 'number' ? parsed.selectionStart : null,
                selectionEnd: typeof parsed.selectionEnd === 'number' ? parsed.selectionEnd : null,
                focused: Boolean(parsed.focused),
            };
        } catch (error) {
            return null;
        }
    }

    function safeSessionGet(key) {
        try {
            return sessionStorage.getItem(key);
        } catch (error) {
            return null;
        }
    }

    function safeSessionSet(key, value) {
        try {
            if (value == null) {
                sessionStorage.removeItem(key);
            } else {
                sessionStorage.setItem(key, value);
            }
        } catch (error) {
            /* ignore storage errors */
        }
    }

    function clamp(value, min, max) {
        if (typeof value !== 'number' || Number.isNaN(value)) {
            return min;
        }
        return Math.min(Math.max(value, min), max);
    }
})();
