import bcrypt from 'bcryptjs';
import Sortable from 'sortablejs';
import { createToastElement, debounce, sanitizeHtml } from './utils.js';
import type { CatalogState, Snapshot } from './types.js';
import { StorageService } from './storage.js';

const HASHED_PIN = '$2a$10$ZxJkqJxL6vNq4W6vL5n8Oe3S4V3JvV0m0nFaV7Qb0f6C8epm6vVUi'; // PIN: 2468

/**
 * Handles edit mode, inline content editing and drag-and-drop.
 */
export class Editor {
  private isEditMode = false;

  private readonly storage: StorageService;

  private contentMap: Record<string, string> = {};

  private modal: HTMLDialogElement | null = null;

  private toggleButton: HTMLButtonElement | null = null;

  private sortableInstances: Sortable[] = [];

  private readonly debouncedPersist = debounce(() => void this.persistContent(), 400);

  public constructor(storage: StorageService) {
    this.storage = storage;
  }

  /**
   * Initializes editor module.
   * @param catalog - Current catalog for drag-and-drop binding.
   */
  public async init(catalog: CatalogState): Promise<void> {
    this.modal = document.querySelector<HTMLDialogElement>('.js-modal');
    this.toggleButton = document.querySelector<HTMLButtonElement>('.js-toggle-edit');
    this.contentMap = await this.storage.loadContent();
    this.applyContent();
    this.bindToggle();
    this.bindKeyboardShortcuts();
    this.attachDragAndDrop();
    if (new URLSearchParams(window.location.search).get('edit') === '1') {
      this.enableEditMode();
    }
    document.addEventListener('catalog:updated', (event) => {
      const detail = (event as CustomEvent<CatalogState>).detail;
      this.attachDragAndDrop(detail);
    });
    this.attachDragAndDrop(catalog);
  }

  /**
   * Enables edit mode and prepares editable elements.
   */
  public enableEditMode(): void {
    if (this.isEditMode) {
      return;
    }
    this.isEditMode = true;
    document.body.classList.add('edit-mode');
    this.toggleButton?.setAttribute('aria-pressed', 'true');
    this.prepareEditableElements();
  }

  /**
   * Disables edit mode.
   */
  public disableEditMode(): void {
    if (!this.isEditMode) {
      return;
    }
    this.isEditMode = false;
    document.body.classList.remove('edit-mode');
    this.toggleButton?.setAttribute('aria-pressed', 'false');
    document.querySelectorAll<HTMLElement>('[contenteditable="true"]').forEach((element) => {
      element.setAttribute('contenteditable', 'false');
      element.removeEventListener('input', this.handleInput as EventListener);
    });
  }

  /**
   * Returns edit mode flag.
   * @returns True when edit mode is active.
   */
  public isEnabled(): boolean {
    return this.isEditMode;
  }

  /**
   * Binds edit mode toggle button and authentication modal.
   */
  private bindToggle(): void {
    if (!this.toggleButton) {
      return;
    }
    this.toggleButton.addEventListener('click', () => {
      if (this.isEditMode) {
        this.disableEditMode();
        return;
      }
      this.openModal();
    });
    this.modal?.addEventListener('close', () => {
      const input = this.modal?.querySelector<HTMLInputElement>('#pin-input');
      if (!input) {
        return;
      }
      const value = input.value.trim();
      input.value = '';
      if (!value) {
        return;
      }
      if (bcrypt.compareSync(value, HASHED_PIN)) {
        this.enableEditMode();
      } else {
        this.showToast('Неверный PIN-код', 'error');
      }
    });
  }

  /**
   * Opens authentication dialog and focuses input.
   */
  private openModal(): void {
    if (!this.modal) {
      return;
    }
    const input = this.modal.querySelector<HTMLInputElement>('#pin-input');
    this.modal.showModal();
    if (input) {
      input.focus();
    }
  }

  /**
   * Enables contenteditable on marked nodes and binds listeners.
   */
  private prepareEditableElements(): void {
    document.querySelectorAll<HTMLElement>('.js-editable').forEach((element, index) => {
      const identifier = this.ensureElementId(element, index);
      element.setAttribute('contenteditable', 'true');
      element.setAttribute('role', 'textbox');
      element.dataset.editId = identifier;
      element.addEventListener('focus', () => element.classList.add('editable-active'));
      element.addEventListener('blur', () => element.classList.remove('editable-active'));
      element.addEventListener('input', this.handleInput as EventListener);
    });
  }

  /**
   * Ensures each editable element has stable identifier.
   * @param element - Target element.
   * @param index - Position index.
   * @returns Identifier string.
   */
  private ensureElementId(element: HTMLElement, index: number): string {
    const existing = element.dataset.editId;
    if (existing) {
      return existing;
    }
    const slug = element.textContent ? element.textContent.slice(0, 32) : `editable-${index}`;
    const safe = slug.replace(/\s+/g, '-').toLowerCase();
    const identifier = `${safe}-${index}`;
    element.dataset.editId = identifier;
    return identifier;
  }

  /**
   * Processes contenteditable input changes.
   * @param event - Input event reference.
   */
  private handleInput = (event: Event): void => {
    const target = event.currentTarget as HTMLElement;
    const id = target.dataset.editId;
    if (!id) {
      return;
    }
    const sanitized = sanitizeHtml(target.innerHTML);
    target.innerHTML = sanitized;
    this.contentMap[id] = sanitized;
    this.debouncedPersist();
    const snapshot: Snapshot = {
      timestamp: Date.now(),
      catalog: { products: [], categories: [] },
      content: { ...this.contentMap }
    };
    this.storage.pushSnapshot(snapshot);
  };

  /**
   * Applies stored editable content to DOM.
   */
  private applyContent(): void {
    document.querySelectorAll<HTMLElement>('.js-editable').forEach((element, index) => {
      const id = this.ensureElementId(element, index);
      if (this.contentMap[id]) {
        element.innerHTML = this.contentMap[id];
      }
    });
  }

  /**
   * Registers keyboard shortcuts for undo/redo.
   */
  private bindKeyboardShortcuts(): void {
    document.addEventListener('keydown', (event) => {
      if (!this.isEditMode) {
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) {
          this.restoreFromSnapshot(this.storage.popRedo());
        } else {
          this.restoreFromSnapshot(this.storage.popUndo());
        }
      }
    });
  }

  /**
   * Restores content from snapshot instance.
   * @param snapshot - Snapshot to restore.
   */
  private restoreFromSnapshot(snapshot: Snapshot | null): void {
    if (!snapshot) {
      return;
    }
    this.contentMap = snapshot.content;
    this.applyContent();
    void this.persistContent();
  }

  /**
   * Persists current editable content to storage.
   */
  private async persistContent(): Promise<void> {
    await this.storage.saveContent(this.contentMap);
    this.showToast('Содержимое сохранено', 'success');
  }

  /**
   * Enables drag and drop sorting for product lists.
   * @param catalog - Catalog to sync ordering.
   */
  private attachDragAndDrop(catalog?: CatalogState): void {
    this.sortableInstances.forEach((instance) => instance.destroy());
    this.sortableInstances = [];
    if (!catalog) {
      return;
    }
    document.querySelectorAll<HTMLElement>('.js-draggable-list').forEach((element) => {
      const sortable = Sortable.create(element, {
        animation: 150,
        handle: '.js-drag-handle',
        onEnd: () => {
          const orderIds = Array.from(element.children).map((child) => child.getAttribute('data-id'));
          const filtered = orderIds.filter((value): value is string => Boolean(value));
          if (!filtered.length) {
            return;
          }
          const sorted = filtered
            .map((id) => catalog.products.find((product) => product.id === id))
            .filter((product): product is NonNullable<typeof product> => Boolean(product));
          document.dispatchEvent(
            new CustomEvent<CatalogState>('catalog:reordered', {
              detail: { products: sorted, categories: catalog.categories }
            })
          );
        }
      });
      this.sortableInstances.push(sortable);
    });
  }

  /**
   * Displays toast notification.
   * @param message - Text to display.
   * @param type - Toast status.
   */
  private showToast(message: string, type: 'info' | 'success' | 'error'): void {
    const toast = createToastElement(message, type);
    document.body.append(toast);
    window.setTimeout(() => toast.remove(), 2200);
  }
}
