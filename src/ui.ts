import type { CatalogState, CartState, FilterCriteria, Product, View } from './types.js';
import { formatCurrency, createToastElement, readFileAsText } from './utils.js';
import { StorageService } from './storage.js';
import { Router } from './routing.js';

interface InitOptions {
  catalog: CatalogState;
  cart: CartState;
  router: Router;
  storage: StorageService;
}

/**
 * Handles rendering and UI interactions.
 */
export class UIController {
  private root: HTMLElement | null = null;

  private catalog: CatalogState = { products: [], categories: [] };

  private cart: CartState = { items: [] };

  private filter: FilterCriteria = { query: '', category: null, priceMin: null, priceMax: null };

  private router: Router | null = null;

  private storage: StorageService | null = null;

  /**
   * Initializes the UI controller.
   * @param options - Dependencies and initial state.
   */
  public init(options: InitOptions): void {
    this.root = document.querySelector<HTMLElement>('#app');
    this.catalog = options.catalog;
    this.cart = options.cart;
    this.router = options.router;
    this.storage = options.storage;
    this.router.onChange((view) => this.render(view));
    document.addEventListener('catalog:reordered', (event) => {
      const detail = (event as CustomEvent<CatalogState>).detail;
      this.catalog.products = detail.products;
      this.catalog.categories = detail.categories;
      void this.persistCatalog();
      this.render(this.router?.getCurrentView() ?? 'home');
    });
    this.render(this.router.getCurrentView());
    this.updateCartCounter();
  }

  /**
   * Renders view matching router state.
   * @param view - Target view identifier.
   */
  private render(view: View): void {
    if (!this.root) {
      return;
    }
    if (view === 'catalog') {
      this.renderCatalog();
    } else if (view === 'cart') {
      this.renderCart();
    } else {
      this.renderHome();
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
    document.body.dispatchEvent(new CustomEvent('ui:rendered'));
    document.dispatchEvent(new CustomEvent('catalog:updated', { detail: this.catalog }));
  }

  /**
   * Renders home section.
   */
  private renderHome(): void {
    if (!this.root) {
      return;
    }
    this.root.innerHTML = `
      <section class="section" aria-labelledby="intro-title">
        <div class="section__header">
          <h2 id="intro-title" class="section__title js-editable" tabindex="0">
            Добро пожаловать в «СтройПрофКаталог»
          </h2>
        </div>
        <p class="js-editable" tabindex="0">
          Используйте каталог, чтобы подобрать оптимальные материалы для вашего проекта. В режиме
          редактирования можно настраивать описания, порядок и изображения, а также генерировать
          тексты с помощью искусственного интеллекта.
        </p>
      </section>
    `;
  }

  /**
   * Renders catalog with applied filters.
   */
  private renderCatalog(): void {
    if (!this.root) {
      return;
    }
    const categories = ['Все категории', ...this.catalog.categories];
    const products = this.applyFilters(this.catalog.products);
    const template = document.querySelector<HTMLTemplateElement>('#product-card-template');
    const listMarkup = products
      .map((product) => {
        if (!template) {
          return '';
        }
        const fragment = template.content.cloneNode(true) as DocumentFragment;
        const article = fragment.querySelector<HTMLElement>('.product-card');
        if (article) {
          article.dataset.id = product.id;
          article.querySelector<HTMLImageElement>('.product-card__image')!.src = `${product.image}&auto=format&fit=crop&w=400&q=80`;
          article.querySelector<HTMLImageElement>('.product-card__image')!.alt = product.name;
          article.querySelector<HTMLElement>('.product-card__title')!.textContent = product.name;
          article.querySelector<HTMLElement>('.product-card__description')!.textContent = product.description;
          article
            .querySelector<HTMLElement>('.product-card__price')!
            .textContent = `${formatCurrency(product.price)} / ${product.unit}`;
        }
        return fragment.firstElementChild?.outerHTML ?? '';
      })
      .join('');

    this.root.innerHTML = `
      <section class="section" aria-labelledby="catalog-title">
        <div class="section__header">
          <h2 id="catalog-title" class="section__title">Каталог</h2>
          <div class="section__controls">
            <form class="search-form" aria-label="Фильтры каталога">
              <input
                type="search"
                name="query"
                placeholder="Поиск по названию"
                value="${this.filter.query}"
                aria-label="Поиск по названию"
              />
              <select name="category" aria-label="Фильтр по категории">
                ${categories
                  .map((category) => `<option value="${category}">${category}</option>`)
                  .join('')}
              </select>
              <input
                type="number"
                name="priceMin"
                min="0"
                placeholder="Мин. цена"
                value="${this.filter.priceMin ?? ''}"
              />
              <input
                type="number"
                name="priceMax"
                min="0"
                placeholder="Макс. цена"
                value="${this.filter.priceMax ?? ''}"
              />
              <button class="button" type="submit">Применить</button>
            </form>
            <div class="section__controls">
              <button class="button button--secondary js-export-json" type="button">Экспорт JSON</button>
              <button class="button button--secondary js-export-csv" type="button">Экспорт CSV</button>
              <label class="button button--icon" aria-label="Импорт каталога из файла">
                Импорт
                <input class="visually-hidden js-import-input" type="file" accept=".json,.csv" />
              </label>
            </div>
          </div>
        </div>
        <div class="product-grid js-draggable-list" aria-live="polite">${listMarkup}</div>
      </section>
    `;
    const select = this.root.querySelector<HTMLSelectElement>('select[name="category"]');
    if (select) {
      select.value = this.filter.category ?? 'Все категории';
    }
    this.bindCatalogInteractions();
  }

  /**
   * Renders shopping cart summary.
   */
  private renderCart(): void {
    if (!this.root) {
      return;
    }
    const items = this.cart.items
      .map((item) => {
        const product = this.catalog.products.find((entry) => entry.id === item.productId);
        if (!product) {
          return null;
        }
        return `
          <div class="cart-item" data-id="${product.id}">
            <div>
              <p class="cart-item__name">${product.name}</p>
              <p>${formatCurrency(product.price)} / ${product.unit}</p>
            </div>
            <div class="cart-item__controls">
              <button class="button button--icon js-decrease" type="button" aria-label="Убавить">
                −
              </button>
              <span aria-live="polite">${item.quantity}</span>
              <button class="button button--icon js-increase" type="button" aria-label="Добавить">
                +
              </button>
              <button class="button button--icon js-remove" type="button" aria-label="Удалить">×</button>
            </div>
          </div>
        `;
      })
      .filter(Boolean)
      .join('');

    const total = this.cart.items.reduce((sum, item) => {
      const product = this.catalog.products.find((entry) => entry.id === item.productId);
      if (!product) {
        return sum;
      }
      return sum + product.price * item.quantity;
    }, 0);

    this.root.innerHTML = `
      <section class="section" aria-labelledby="cart-title">
        <div class="section__header">
          <h2 id="cart-title" class="section__title">Корзина</h2>
          <button class="button js-checkout" type="button">Оформить заказ</button>
        </div>
        <div class="cart-list">${items || '<p>Корзина пуста</p>'}</div>
        <div class="cart-summary">
          <p>Итого: <strong>${formatCurrency(total)}</strong></p>
          <button class="button button--secondary js-clear-cart" type="button">Очистить</button>
        </div>
      </section>
    `;
    this.bindCartInteractions();
  }

  /**
   * Binds interactions for catalog view (filters, AI, import/export).
   */
  private bindCatalogInteractions(): void {
    const form = this.root?.querySelector<HTMLFormElement>('.search-form');
    form?.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!form) {
        return;
      }
      const formData = new FormData(form);
      this.filter.query = String(formData.get('query') ?? '');
      const categoryValue = String(formData.get('category') ?? 'Все категории');
      this.filter.category = categoryValue === 'Все категории' ? null : categoryValue;
      const minValue = Number(formData.get('priceMin'));
      const maxValue = Number(formData.get('priceMax'));
      this.filter.priceMin = Number.isFinite(minValue) && minValue > 0 ? minValue : null;
      this.filter.priceMax = Number.isFinite(maxValue) && maxValue > 0 ? maxValue : null;
      this.render('catalog');
    });

    this.root?.querySelectorAll<HTMLButtonElement>('.js-add-to-cart').forEach((button) => {
      button.addEventListener('click', () => {
        const article = button.closest<HTMLElement>('.product-card');
        const id = article?.dataset.id;
        if (!id) {
          return;
        }
        this.addToCart(id);
      });
    });

    this.root?.querySelectorAll<HTMLButtonElement>('.js-generate').forEach((button) => {
      button.addEventListener('click', async () => {
        const article = button.closest<HTMLElement>('.product-card');
        if (!article) {
          return;
        }
        const product = this.catalog.products.find((entry) => entry.id === article.dataset.id);
        if (!product) {
          return;
        }
        await this.generateDescription(product, button);
      });
    });

    this.root?.querySelector('.js-export-json')?.addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(this.catalog.products, null, 2)], {
        type: 'application/json;charset=utf-8'
      });
      this.downloadFile(blob, 'catalog.json');
    });

    this.root?.querySelector('.js-export-csv')?.addEventListener('click', () => {
      const csv = this.toCsv(this.catalog.products);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      this.downloadFile(blob, 'catalog.csv');
    });

    this.root?.querySelector<HTMLInputElement>('.js-import-input')?.addEventListener('change', async (event) => {
      const input = event.currentTarget as HTMLInputElement;
      const file = input.files?.[0];
      if (!file) {
        return;
      }
      try {
        const content = await readFileAsText(file);
        if (file.name.endsWith('.csv')) {
          this.catalog.products = this.fromCsv(content);
        } else {
          this.catalog.products = JSON.parse(content) as Product[];
        }
        this.catalog.categories = Array.from(new Set(this.catalog.products.map((product) => product.category)));
        await this.persistCatalog();
        this.render('catalog');
        this.showToast('Каталог обновлён', 'success');
      } catch (error) {
        console.error(error);
        this.showToast('Не удалось импортировать файл', 'error');
      } finally {
        input.value = '';
      }
    });
  }

  /**
   * Binds interactions for cart view.
   */
  private bindCartInteractions(): void {
    this.root?.querySelectorAll<HTMLButtonElement>('.js-increase').forEach((button) => {
      button.addEventListener('click', () => {
        const id = button.closest<HTMLElement>('.cart-item')?.dataset.id;
        if (!id) {
          return;
        }
        this.changeQuantity(id, 1);
      });
    });
    this.root?.querySelectorAll<HTMLButtonElement>('.js-decrease').forEach((button) => {
      button.addEventListener('click', () => {
        const id = button.closest<HTMLElement>('.cart-item')?.dataset.id;
        if (!id) {
          return;
        }
        this.changeQuantity(id, -1);
      });
    });
    this.root?.querySelectorAll<HTMLButtonElement>('.js-remove').forEach((button) => {
      button.addEventListener('click', () => {
        const id = button.closest<HTMLElement>('.cart-item')?.dataset.id;
        if (!id) {
          return;
        }
        this.removeFromCart(id);
      });
    });
    this.root?.querySelector('.js-clear-cart')?.addEventListener('click', () => {
      this.cart.items = [];
      void this.persistCart();
      this.render('cart');
      this.updateCartCounter();
    });
    this.root?.querySelector('.js-checkout')?.addEventListener('click', () => {
      this.simulateCheckout();
    });
  }

  /**
   * Adds product to cart and persists state.
   * @param productId - Identifier of product to add.
   */
  private addToCart(productId: string): void {
    const item = this.cart.items.find((entry) => entry.productId === productId);
    if (item) {
      item.quantity += 1;
    } else {
      this.cart.items.push({ productId, quantity: 1 });
    }
    void this.persistCart();
    this.updateCartCounter();
    this.showToast('Добавлено в корзину', 'success');
  }

  /**
   * Changes quantity of product in cart.
   * @param productId - Product identifier.
   * @param delta - Quantity delta.
   */
  private changeQuantity(productId: string, delta: number): void {
    const item = this.cart.items.find((entry) => entry.productId === productId);
    if (!item) {
      return;
    }
    item.quantity += delta;
    if (item.quantity <= 0) {
      this.removeFromCart(productId);
      return;
    }
    void this.persistCart();
    this.render('cart');
  }

  /**
   * Removes product from cart.
   * @param productId - Product identifier to remove.
   */
  private removeFromCart(productId: string): void {
    this.cart.items = this.cart.items.filter((entry) => entry.productId !== productId);
    void this.persistCart();
    this.render('cart');
    this.updateCartCounter();
  }

  /**
   * Updates counter badge in header.
   */
  private updateCartCounter(): void {
    const count = this.cart.items.reduce((total, item) => total + item.quantity, 0);
    const counter = document.querySelector<HTMLElement>('.js-cart-count');
    if (counter) {
      counter.textContent = String(count);
    }
  }

  /**
   * Applies filters to product collection.
   * @param products - Source product list.
   * @returns Filtered array.
   */
  private applyFilters(products: Product[]): Product[] {
    return products.filter((product) => {
      const matchQuery = product.name.toLowerCase().includes(this.filter.query.toLowerCase());
      const matchCategory = !this.filter.category || product.category === this.filter.category;
      const matchMin = !this.filter.priceMin || product.price >= this.filter.priceMin;
      const matchMax = !this.filter.priceMax || product.price <= this.filter.priceMax;
      return matchQuery && matchCategory && matchMin && matchMax;
    });
  }

  /**
   * Requests AI description and updates product card.
   * @param product - Product entity.
   * @param button - Button triggering generation.
   */
  private async generateDescription(product: Product, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    const initialText = button.textContent;
    button.textContent = 'Генерация...';
    try {
      const response = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: `Сгенерируй краткое описание строительного материала: ${product.name}.`,
          context: product.description
        })
      });
      if (!response.ok) {
        throw new Error('Ошибка генерации');
      }
      const data = await response.json();
      const description = String(data.text ?? '').trim();
      if (!description) {
        throw new Error('Пустой ответ');
      }
      product.description = description;
      await this.persistCatalog();
      this.render('catalog');
      this.showToast('Описание обновлено', 'success');
    } catch (error) {
      console.error(error);
      this.showToast('Не удалось получить описание', 'error');
    } finally {
      button.disabled = false;
      button.textContent = initialText;
    }
  }

  /**
   * Persists catalog state in storage.
   */
  private async persistCatalog(): Promise<void> {
    if (!this.storage) {
      return;
    }
    await this.storage.saveCatalog(this.catalog);
  }

  /**
   * Persists cart state in storage.
   */
  private async persistCart(): Promise<void> {
    if (!this.storage) {
      return;
    }
    await this.storage.saveCart(this.cart);
  }

  /**
   * Displays toast notification.
   * @param message - Text to display.
   * @param type - Toast type.
   */
  private showToast(message: string, type: 'info' | 'success' | 'error'): void {
    const toast = createToastElement(message, type);
    document.body.append(toast);
    window.setTimeout(() => toast.remove(), 2200);
  }

  /**
   * Triggers download for generated file.
   * @param blob - Blob to download.
   * @param filename - Target filename.
   */
  private downloadFile(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  /**
   * Converts catalog to CSV string.
   * @param products - List of products.
   * @returns CSV content.
   */
  private toCsv(products: Product[]): string {
    const header = 'id;name;description;price;image;unit;category';
    const rows = products.map((product) =>
      [
        product.id,
        product.name,
        product.description.replace(/\n/g, ' '),
        product.price,
        product.image,
        product.unit,
        product.category
      ]
        .map((value) => `"${String(value).replace(/"/g, '""')}"`)
        .join(';')
    );
    return [header, ...rows].join('\n');
  }

  /**
   * Creates product list from CSV content.
   * @param csv - CSV string.
   * @returns Parsed products.
   */
  private fromCsv(csv: string): Product[] {
    const [headerLine, ...lines] = csv.trim().split(/\r?\n/);
    if (!headerLine) {
      return [];
    }
    return lines
      .map((line) => line.match(/(?:"([^"]*(?:""[^"]*)*)"|[^;]+)/g))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .map((columns) => columns.map((column) => column.replace(/^"|"$/g, '').replace(/""/g, '"')))
      .map((fields) => ({
        id: fields[0] ?? '',
        name: fields[1] ?? '',
        description: fields[2] ?? '',
        price: Number(fields[3] ?? 0),
        image: fields[4] ?? '',
        unit: fields[5] ?? '',
        category: fields[6] ?? ''
      }));
  }

  /**
   * Simulates checkout workflow and clears cart.
   */
  private simulateCheckout(): void {
    if (!this.cart.items.length) {
      this.showToast('Корзина пуста', 'info');
      return;
    }
    this.showToast('Заявка отправлена! Менеджер свяжется с вами.', 'success');
    this.cart.items = [];
    void this.persistCart();
    this.render('cart');
    this.updateCartCounter();
  }
}
