// ============================================
// editor.js - Режим редактирования (единая точка входа)
// ============================================

// --- ИМПОРТЫ ---
import { parseCSVToJSON } from './app.js';

// --- КОНСТАНТЫ ---
const EDITOR_BAR_SELECTOR = '#editor-bar';
const EDITOR_ACTIONS = {
    EXIT: 'exit',
    UNDO: 'undo',
    REDO: 'redo',
    EXPORT: 'export',
    IMPORT: 'import'
};

// --- СОСТОЯНИЕ ---
const state = {
    history: [],
    historyIndex: -1,
    maxHistory: 50
};

// --- ИНИЦИАЛИЗАЦИЯ EditorSession НА window ---
if (!window.EditorSession) {
    window.EditorSession = {
        isEditModeRequested() {
            return sessionStorage.getItem('editModeRequested') === '1';
        },
        setEditModeRequested(value) {
            if (value) {
                sessionStorage.setItem('editModeRequested', '1');
            } else {
                sessionStorage.removeItem('editModeRequested');
            }
            return value;
        },
        exit() {
            this.setEditModeRequested(false);
            window.location.reload();
        }
    };
}

// --- ФУНКЦИИ РЕДАКТИРОВАНИЯ ---
function saveToHistory(action, data) {
    // Удаляем всё после текущего индекса
    state.history = state.history.slice(0, state.historyIndex + 1);
    
    // Добавляем новое действие
    state.history.push({ action, data, timestamp: Date.now() });
    
    // Ограничиваем размер истории
    if (state.history.length > state.maxHistory) {
        state.history = state.history.slice(-state.maxHistory);
    }
    
    state.historyIndex = state.history.length - 1;
    updateUndoRedoButtons();
}

function undo() {
    if (state.historyIndex > 0) {
        state.historyIndex--;
        applyHistoryState(state.history[state.historyIndex]);
        updateUndoRedoButtons();
    }
}

function redo() {
    if (state.historyIndex < state.history.length - 1) {
        state.historyIndex++;
        applyHistoryState(state.history[state.historyIndex]);
        updateUndoRedoButtons();
    }
}

function applyHistoryState(historyItem) {
    console.log('✓ Applying history state:', historyItem);
    // Здесь будет логика применения состояния
}

function updateUndoRedoButtons() {
    const undoBtn = document.querySelector(`[data-editor-action="${EDITOR_ACTIONS.UNDO}"]`);
    const redoBtn = document.querySelector(`[data-editor-action="${EDITOR_ACTIONS.REDO}"]`);
    
    if (undoBtn) {
        undoBtn.disabled = state.historyIndex <= 0;
    }
    if (redoBtn) {
        redoBtn.disabled = state.historyIndex >= state.history.length - 1;
    }
}

function exportState() {
    const exportData = {
        catalog: window.FULL_CATALOG || [],
        history: state.history,
        timestamp: Date.now()
    };
    
    const dataStr = JSON.stringify(exportData, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `site-export-${Date.now()}.json`;
    a.click();
    
    URL.revokeObjectURL(url);
    console.log('✓ State exported');
}

function importState() {
    const input = document.getElementById('editor-import-input');
    if (!input) {
        console.error('✗ Import input not found');
        return;
    }
    
    input.click();
}

function handleImportFile(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const importedData = JSON.parse(e.target.result);
            
            if (importedData.catalog) {
                window.FULL_CATALOG = importedData.catalog;
                console.log('✓ Catalog imported:', window.FULL_CATALOG.length, 'items');
            }
            
            if (importedData.history) {
                state.history = importedData.history;
                state.historyIndex = state.history.length - 1;
                updateUndoRedoButtons();
            }
            
            // Перезагружаем страницу для обновления интерфейса
            window.location.reload();
        } catch (error) {
            console.error('✗ Failed to import state:', error);
            alert('Ошибка импорта: ' + error.message);
        }
    };
    reader.readAsText(file);
}

function exitEditorMode() {
    if (window.EditorSession) {
        window.EditorSession.exit();
    }
}

// --- ПОДКЛЮЧЕНИЕ ОБРАБОТЧИКОВ ---
function attachEditorHandlers() {
    const editorBar = document.querySelector(EDITOR_BAR_SELECTOR);
    if (!editorBar) {
        console.warn('⚠ Editor bar not found');
        return;
    }
    
    // Обработчик кликов по кнопкам редактора
    editorBar.addEventListener('click', (e) => {
        const button = e.target.closest('[data-editor-action]');
        if (!button) return;
        
        const action = button.dataset.editorAction;
        
        switch (action) {
            case EDITOR_ACTIONS.EXIT:
                exitEditorMode();
                break;
            case EDITOR_ACTIONS.UNDO:
                undo();
                break;
            case EDITOR_ACTIONS.REDO:
                redo();
                break;
            case EDITOR_ACTIONS.EXPORT:
                exportState();
                break;
            case EDITOR_ACTIONS.IMPORT:
                importState();
                break;
            default:
                console.warn('⚠ Unknown editor action:', action);
        }
    });
    
    // Обработчик импорта файла
    const importInput = document.getElementById('editor-import-input');
    if (importInput) {
        importInput.addEventListener('change', handleImportFile);
    }
    
    console.log('✓ Editor handlers attached');
}

// --- ИНИЦИАЛИЗАЦИЯ ---
function initEditor() {
    // Проверяем, активен ли режим редактирования
    if (!window.EditorSession || !window.EditorSession.isEditModeRequested()) {
        console.log('✓ Editor mode not requested, skipping initialization');
        return;
    }
    
    console.log('✓ Initializing editor mode');
    
    // Подключаем обработчики
    attachEditorHandlers();
    
    // Инициализируем кнопки undo/redo
    updateUndoRedoButtons();
    
    console.log('✓ Editor mode initialized');
}

// --- ЗАПУСК ---
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initEditor);
} else {
    initEditor();
}
