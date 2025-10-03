import localforage from 'localforage';
import { compressToUTF16, decompressFromUTF16 } from 'lz-string';
import type { CartState, CatalogState, Snapshot } from './types.js';

const SNAPSHOT_LIMIT = 50;

/**
 * Provides persistent storage helpers using localForage.
 */
export class StorageService {
  private undoStack: Snapshot[] = [];

  private redoStack: Snapshot[] = [];

  private readonly catalogKey = 'catalog-state';

  private readonly cartKey = 'cart-state';

  private readonly contentKey = 'editable-content';

  public constructor() {
    localforage.config({
      name: 'construction-catalog-spa',
      storeName: 'catalog'
    });
  }

  /**
   * Loads catalog state from cache.
   * @returns Catalog state or null.
   */
  public async loadCatalog(): Promise<CatalogState | null> {
    const stored = await localforage.getItem<string>(this.catalogKey);
    if (!stored) {
      return null;
    }
    const parsed = decompressFromUTF16(stored);
    if (!parsed) {
      return null;
    }
    return JSON.parse(parsed) as CatalogState;
  }

  /**
   * Persists catalog state in storage.
   * @param catalog - Catalog data to store.
   */
  public async saveCatalog(catalog: CatalogState): Promise<void> {
    const payload = compressToUTF16(JSON.stringify(catalog));
    await localforage.setItem(this.catalogKey, payload);
  }

  /**
   * Loads cart state from storage.
   * @returns Cart state or default value.
   */
  public async loadCart(): Promise<CartState> {
    const stored = await localforage.getItem<string>(this.cartKey);
    if (!stored) {
      return { items: [] };
    }
    const parsed = decompressFromUTF16(stored);
    if (!parsed) {
      return { items: [] };
    }
    return JSON.parse(parsed) as CartState;
  }

  /**
   * Persists cart state.
   * @param cart - Cart state to store.
   */
  public async saveCart(cart: CartState): Promise<void> {
    const payload = compressToUTF16(JSON.stringify(cart));
    await localforage.setItem(this.cartKey, payload);
  }

  /**
   * Saves editable content map.
   * @param content - Editable fields keyed by selector.
   */
  public async saveContent(content: Record<string, string>): Promise<void> {
    const payload = compressToUTF16(JSON.stringify(content));
    await localforage.setItem(this.contentKey, payload);
  }

  /**
   * Loads editable content map.
   * @returns Editable content record.
   */
  public async loadContent(): Promise<Record<string, string>> {
    const stored = await localforage.getItem<string>(this.contentKey);
    if (!stored) {
      return {};
    }
    const parsed = decompressFromUTF16(stored);
    if (!parsed) {
      return {};
    }
    return JSON.parse(parsed) as Record<string, string>;
  }

  /**
   * Stores snapshot for undo stack.
   * @param snapshot - Snapshot to store.
   */
  public pushSnapshot(snapshot: Snapshot): void {
    this.undoStack = [snapshot, ...this.undoStack].slice(0, SNAPSHOT_LIMIT);
    this.redoStack = [];
  }

  /**
   * Pops snapshot for undo.
   * @returns Previous snapshot or null.
   */
  public popUndo(): Snapshot | null {
    const snapshot = this.undoStack.shift() ?? null;
    if (snapshot) {
      this.redoStack = [snapshot, ...this.redoStack].slice(0, SNAPSHOT_LIMIT);
    }
    return this.undoStack.length ? this.undoStack[0] : null;
  }

  /**
   * Pops snapshot for redo.
   * @returns Snapshot or null.
   */
  public popRedo(): Snapshot | null {
    const snapshot = this.redoStack.shift() ?? null;
    if (snapshot) {
      this.undoStack = [snapshot, ...this.undoStack].slice(0, SNAPSHOT_LIMIT);
    }
    return snapshot;
  }

  /**
   * Clears snapshot stacks.
   */
  public clearSnapshots(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
