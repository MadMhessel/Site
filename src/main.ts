import type { CatalogState } from './types.js';
import { StorageService } from './storage.js';
import { Router } from './routing.js';
import { UIController } from './ui.js';
import { Editor } from './editor.js';

/**
 * Root application class.
 */
class App {
  private readonly storage = new StorageService();

  private readonly router = new Router();

  private readonly ui = new UIController();

  private readonly editor = new Editor(this.storage);

  /**
   * Bootstraps SPA.
   */
  public async init(): Promise<void> {
    const catalog = await this.loadCatalog();
    const cart = await this.storage.loadCart();
    await this.editor.init(catalog);
    this.router.init();
    this.ui.init({ catalog, cart, router: this.router, storage: this.storage });
  }

  /**
   * Loads catalog from cache or network.
   * @returns Catalog state.
   */
  private async loadCatalog(): Promise<CatalogState> {
    const cached = await this.storage.loadCatalog();
    if (cached) {
      return cached;
    }
    const response = await fetch('/api/catalog');
    if (!response.ok) {
      throw new Error('Не удалось загрузить каталог');
    }
    const products = (await response.json()) as CatalogState['products'];
    const categories = Array.from(new Set(products.map((product) => product.category)));
    const catalog: CatalogState = { products, categories };
    await this.storage.saveCatalog(catalog);
    return catalog;
  }
}

void new App().init();
