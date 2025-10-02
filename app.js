// --- КОНФИГУРАЦИЯ ---
const APP_ID = 'art-stroy-clone';
const SCHEMA_VERSION = 1;
const PRODUCTS_STORAGE_KEY = 'art-stroy-clone_products_v1';
const CART_STORAGE_KEY = `${APP_ID}_cart`;
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=';
const GEMINI_API_KEY = ""; // Вставьте ваш API-ключ Gemini
const LOGO_URL = 'https://i.imgur.com/RXyoozd.png';
const PLACEHOLDER_IMAGE = 'https://placehold.co/600x400/e2e8f0/475569?text=No+Image';
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

function getHashForView(view) {
    const segment = VIEW_ROUTES[view] ?? '';
    return segment ? `#/${segment}` : '#/';
}

function buildProductHash(slug) {
    const safeSlug = slug ? encodeURIComponent(slug) : '';
    return safeSlug ? `#/product/${safeSlug}` : '#/';
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

// --- Глобальное Состояние ---
let appState = {
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
        { icon: 'fa-ruler-combined', title: 'Кровельные материалы', image: 'https://i.imgur.com/YDb3Aq1.jpeg', links: ['Рулонная кровля', 'Гибкая черепица', 'Комплектующие', 'Инструменты', 'Кровельные ограждения', 'Антисептики для кровли', 'ПВХ и ТПО мембраны'] },
        { icon: 'fa-thermometer-half', title: 'Изоляция', image: 'https://i.imgur.com/FvJgTnS.jpeg', links: ['Праймеры', 'Мастики', 'Герметики', 'Звукоизоляция', 'Комплектующие'] },
        { icon: 'fa-water', title: 'Гидроизоляция', image: 'https://i.imgur.com/RTedE0r.jpeg', links: ['Рулонная гидроизоляция', 'Профилированные мембраны', 'Инструменты', 'Обмазочная гидроизоляция', 'Жидкая резина', 'Промоборудование'] },
        { icon: 'fa-tv', title: 'Теплоизоляция', image: 'https://i.imgur.com/UpOzPlt.jpeg', links: ['Экструзионный пенополистирол', 'Стекловата', 'Напыляемый утеплитель', 'Пенопласт', 'Вспененный полиэтилен', 'Крепеж для теплоизоляции'] },
        { icon: 'fa-building', title: 'Фасадные материалы', image: 'https://i.imgur.com/we90y0H.jpeg', links: ['Фасадные плиты', 'Композитные панели', 'Штукатурно-клеевые смеси', 'Фасадные штукатурки'] },
        { icon: 'fa-tools', title: 'Стройматериалы', image: 'https://i.imgur.com/nK2SB1P.jpeg', links: ['Цемент, кладка и сыпучие', 'Монтажные клеи', 'Древесно-плитные материалы', 'Гипсокартон и листовые', 'Строительные сетки', 'Стеклопластиковая арматура', 'Шифер'] },
        { icon: 'fa-tint', title: 'Водосточные системы', image: 'https://i.imgur.com/mnezRSJ.jpeg', links: ['ПВХ системы', 'Металлические системы'] },
        { icon: 'fa-box', title: 'Сухие смеси', image: 'https://placehold.co/150x100/cccccc/969696?text=Сухие+смеси', links: ['Полимерные клеи', 'Штукатурки', 'Шпатлевки', 'Наливные полы', 'Кладочные смеси', 'Грунтовки'] },
        { icon: 'fa-home', title: 'Готовые домокомплекты', image: 'https://placehold.co/150x100/cccccc/969696?text=Дома', links: ['Садовые домики', 'Хозблоки', 'Беседки', 'Гаражи'] },
        { icon: 'fa-spray-can', title: 'Герметики и пены', image: 'https://placehold.co/150x100/cccccc/969696?text=Пены', links: ['Монтажные пены', 'Герметики', 'Очистители пены', 'Лента герметик'] },
        { icon: 'fa-leaf', title: 'Пароизоляция', image: 'https://placehold.co/150x100/cccccc/969696?text=Пленки', links: ['Паро-ветрозащитные пленки', 'Диффузионные мембраны'] },
        { icon: 'fa-flask', title: 'Строительная химия', image: 'https://placehold.co/150x100/cccccc/969696?text=Химия', links: ['Антисептики для древесины', 'Отбеливатели для древесины', 'Огнебиозащита', 'Удалители высолов'] },
    ],
    checkoutState: {
        customerType: 'physical',
        deliveryMethod: 'company',
        paymentMethod: 'cash'
    }
};

let sliderInterval;
let catalogMenuTimeout; // Для задержки закрытия меню

// Внутреннее состояние формы администратора
window.adminState = {
    productName: '', productPrice: '', productUnit: 'шт',
    productImage: 'https://placehold.co/400x300/e2e8f0/94a3b8?text=Стройматериал',
    productDescription: '', isGenerating: false, jsonInput: '',
};

// --- Утилиты ---

function persistProducts(products) {
    try {
        localStorage.setItem(PRODUCTS_STORAGE_KEY, JSON.stringify({ schemaVersion: SCHEMA_VERSION, products }));
    } catch (error) {
        console.warn('[CATALOG:SKIP]', 'storage', `Не удалось сохранить каталог: ${error.message}`);
    }
}

function navigateToRoute(view, { replace = false } = {}) {
    const hash = getHashForView(view);
    if (!hash) return;
    if (replace) {
        updateHash(hash, { replace: true });
        return;
    }
    if (window.location.hash !== hash) {
        updateHash(hash);
    }
}

/**
 * Загружает товары и корзину, учитывая актуальную схему данных и резервный каталог.
 */
function loadState() {
    let products = [];

    try {
        const stored = localStorage.getItem(PRODUCTS_STORAGE_KEY);
        if (stored) {
            const parsed = JSON.parse(stored);
            if (parsed?.schemaVersion === SCHEMA_VERSION && Array.isArray(parsed.products)) {
                const normalizedStored = normalizeCatalog(parsed.products);
                if (normalizedStored.length > 0) {
                    products = normalizedStored;
                }
            }
        }
    } catch (error) {
        console.warn('[CATALOG:SKIP]', 'storage', `Ошибка чтения каталога из localStorage: ${error.message}`);
    }

    if (!products.length) {
        const sourceCatalog = Array.isArray(window.FULL_CATALOG) && window.FULL_CATALOG.length
            ? normalizeCatalog(window.FULL_CATALOG)
            : [];
        if (sourceCatalog.length) {
            products = sourceCatalog;
        } else {
            products = normalizeCatalog([
                {
                    id: 'demo-1',
                    name: 'Пеноблок D600 (600x200x300)',
                    price: 350,
                    unit: 'шт',
                    category: 'Демо-товары',
                    description: 'Легкий и прочный пеноблок.',
                    image: 'https://placehold.co/400x300/4a7a9c/ffffff?text=Пеноблок',
                },
            ]);
        }
        persistProducts(products);
    }

    appState.products = products;

    try {
        const storedCart = localStorage.getItem(CART_STORAGE_KEY);
        if (storedCart) {
            const parsedCart = JSON.parse(storedCart);
            if (parsedCart && typeof parsedCart === 'object') {
                const cleanedCart = {};
                Object.entries(parsedCart).forEach(([key, item]) => {
                    const product = products.find(p => String(p.id) === String(key));
                    if (!product || !product.hasPrice) return;
                    const quantity = Number(item.quantity) || 0;
                    if (quantity <= 0) return;
                    cleanedCart[key] = {
                        id: product.id,
                        name: product.name,
                        price: product.price,
                        unit: product.unit,
                        quantity,
                    };
                });
                appState.cartItems = cleanedCart;
            }
        }
    } catch (error) {
        console.warn('[CATALOG:SKIP]', 'cart', `Ошибка чтения корзины: ${error.message}`);
    }

    persistProducts(appState.products);
}

function saveState() {
    persistProducts(appState.products);
    try {
        localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(appState.cartItems));
    } catch (error) {
        console.warn('[CATALOG:SKIP]', 'cart', `Не удалось сохранить корзину: ${error.message}`);
    }
}

function applyInitialRoute() {
    const hashSegment = getCurrentHashSegment();
    const normalizedSegment = hashSegment.toLowerCase();
    if (normalizedSegment.startsWith('product/')) {
        const slug = decodeURIComponent(hashSegment.slice(hashSegment.indexOf('/') + 1));
        const product = appState.products.find(p => p.slug === slug);
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
        const product = appState.products.find(p => p.slug === slug);
        if (product) {
            showDetails(product.id, { skipHistory: true });
            return;
        }
        console.warn('[ROUTER:SKIP]', slug, 'Slug не найден при hashchange, возврат в каталог');
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
    Object.assign(appState, newState);
    saveState();
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

    if (options.selectedProductId !== undefined) {
        statePatch.selectedProductId = options.selectedProductId;
    } else if (!options.preserveProduct) {
        statePatch.selectedProductId = null;
    }

    if (newView !== 'details') {
        appState.lastViewBeforeDetails = newView;
    }

    setState(statePatch, () => {
        if (newView !== 'details' && !options.skipHistory) {
            navigateToRoute(newView, { replace: options.replaceHistory });
        }
    });
}

function showDetails(productId, options = {}) {
    const product = appState.products.find(p => String(p.id) === String(productId));
    if (!product) {
        console.warn('[CATALOG:SKIP]', productId, 'Продукт не найден при открытии карточки');
        return;
    }

    if (Object.prototype.hasOwnProperty.call(options, 'lastViewOverride')) {
        appState.lastViewBeforeDetails = options.lastViewOverride;
    } else if (appState.view !== 'details') {
        appState.lastViewBeforeDetails = appState.view;
    }

    if (!options.skipHistory) {
        const targetHash = buildProductHash(product.slug);
        if (options.replaceHistory) {
            updateHash(targetHash, { replace: true });
        } else {
            updateHash(targetHash);
        }
    }

    setState({ view: 'details', selectedProductId: product.id }, options.callback || null);
}

function exitProductDetails() {
    const targetView = appState.lastViewBeforeDetails || 'catalog';
    setView(targetView, { replaceHistory: true });
}

function toggleMenu() {
    setState({ isMenuOpen: !appState.isMenuOpen });
}

function setCatalogMenu(isOpen) {
    clearTimeout(catalogMenuTimeout);
    if (isOpen) {
        if (!appState.isCatalogMenuOpen) {
            setState({ isCatalogMenuOpen: true });
        }
    } else {
        catalogMenuTimeout = setTimeout(() => {
            setState({ isCatalogMenuOpen: false });
        }, 200);
    }
}

// --- Функции для оформления заказа и поиска ---
function handleCategoryClick(categoryName) {
    appState.searchTerm = categoryName; // Устанавливаем поисковый запрос равным категории
    setView('catalog');
}

function handleSearch(term) {
    appState.searchTerm = term;
    if (appState.view !== 'catalog') {
        setView('catalog');
    } else {
        renderProductGridOnly(); // Только перерисовываем товары, а не всю страницу
    }
}

function setOnlyWithPrice(isChecked) {
    appState.onlyWithPrice = Boolean(isChecked);
    renderProductGridOnly();
}

function handleCheckoutChange(field, value) {
    const newCheckoutState = { ...appState.checkoutState, [field]: value };
    appState.checkoutState = newCheckoutState;
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
        const nextSlide = (appState.activeSlide + 1) % appState.slides.length;
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
    const searchTerm = appState.searchTerm.trim().toLowerCase();
    let filteredProducts = [...appState.products];

    if (appState.onlyWithPrice) {
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

    switch (appState.sortBy) {
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

function calculateTotalCost() {
    return Object.values(appState.cartItems).reduce((sum, item) => {
        if (!item || typeof item.price !== 'number' || Number.isNaN(item.price)) return sum;
        return sum + (item.quantity * item.price);
    }, 0);
}
function calculateCartCount() {
    return Object.values(appState.cartItems).reduce((sum, item) => sum + item.quantity, 0);
}

// --- Функции Корзины ---
function updateCartItemQuantity(productId, change) {
    const product = appState.products.find(p => String(p.id) === String(productId));
    if (!product) { setMessage('Продукт не найден.'); return; }
    if (!product.hasPrice) { setMessage('Для этого товара требуется запрос цены.'); return; }
    const newCartItems = { ...appState.cartItems };
    const newQuantity = (newCartItems[productId]?.quantity || 0) + change;
    if (newQuantity <= 0) delete newCartItems[productId];
    else newCartItems[productId] = { ...product, quantity: newQuantity };
    setState({ cartItems: newCartItems });
}
function addToCart(productId) {
    const product = appState.products.find(p => String(p.id) === String(productId));
    if (!product) { setMessage('Продукт не найден.'); return; }
    if (!product.hasPrice) { setMessage('Для этого товара требуется запрос цены.'); return; }
    updateCartItemQuantity(productId, 1);
    setMessage("Товар добавлен в корзину!");
}
function removeFromCart(productId) {
    const newCartItems = { ...appState.cartItems };
    delete newCartItems[productId];
    setState({ cartItems: newCartItems });
}

function requestPrice(productId) {
    const product = appState.products.find(p => String(p.id) === String(productId));
    if (!product) { setMessage('Продукт не найден.'); return; }
    setMessage(`Запрос по товару "${product.name}" отправлен. Менеджер свяжется с вами.`);
}

// --- Функции Админа (без изменений) ---
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
    setState({ products: [...appState.products, newProduct] }, () => setMessage(`Продукт "${newProduct.name}" добавлен.`));
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
        setState({ products: [...appState.products, ...normalized] });
        setMessage(`Импортировано ${normalized.length} продуктов.`);
    } catch (e) { setMessage(`Ошибка импорта: ${e.message}`); }
}


// --- Компоненты Рендеринга ---

function renderCatalogDropdown() {
    return `
        <div onmouseenter="setCatalogMenu(true)" onmouseleave="setCatalogMenu(false)" class="absolute top-full left-0 w-max max-w-7xl bg-white text-gray-700 shadow-2xl rounded-b-lg p-8 grid grid-cols-4 gap-x-12 gap-y-6 z-50">
            ${appState.catalogCategories.map(cat => `
                <div class="space-y-3">
                    <h3 class="font-bold text-md flex items-center gap-3 cursor-pointer" onclick="handleCategoryClick('${cat.title}')">
                        <i class="fas ${cat.icon} text-[#fcc521] w-5 text-center"></i>
                        <span>${cat.title}</span>
                    </h3>
                    <ul class="space-y-2 text-sm">
                        ${cat.links.map(link => `<li><a href="#" onclick="event.preventDefault(); handleCategoryClick('${link}')" class="hover:text-[#fcc521] hover:underline">${link}</a></li>`).join('')}
                    </ul>
                </div>
            `).join('')}
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
                            <span>Ваш город: <strong>Москва</strong> <i class="fas fa-chevron-down text-xs"></i></span>
                        </div>
                    </div>
                    <div class="flex items-center gap-6">
                         <a href="#" class="hover:text-[#fcc521]"><i class="fas fa-phone-alt mr-1"></i> <strong>8 (800) 201-85-86</strong></a>
                         <a href="#" class="hidden lg:inline hover:text-[#fcc521]">Заказать звонок</a>
                         <a href="#" class="hidden md:inline hover:text-[#fcc521]"><i class="fas fa-user mr-1"></i> Войти</a>
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
                        <input type="text" placeholder="Поиск" oninput="handleSearch(this.value)" value="${appState.searchTerm}" class="w-full border border-gray-300 px-4 py-2 focus:ring-2 focus:ring-[#fcc521] focus:outline-none"/>
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
                            <button onclick="setView('catalog')" class="hover:bg-gray-700 h-full px-3 transition-colors flex items-center cursor-pointer">
                                <i class="fas fa-bars mr-2"></i> Каталог
                            </button>
                            ${appState.isCatalogMenuOpen ? renderCatalogDropdown() : ''}
                        </div>
                        <button onclick="setView('online-calc')" class="hover:bg-gray-700 h-full px-3 flex items-center transition-colors">Онлайн-расчеты</button>
                        <button onclick="setView('payment')" class="hover:bg-gray-700 h-full px-3 flex items-center transition-colors">Оплата</button>
                        <button onclick="setView('delivery')" class="hover:bg-gray-700 h-full px-3 flex items-center transition-colors">Доставка</button>
                        <button onclick="setView('about')" class="hover:bg-gray-700 h-full px-3 flex items-center transition-colors">О компании</button>
                        <button onclick="setView('contacts')" class="hover:bg-gray-700 h-full px-3 flex items-center transition-colors">Контакты</button>
                     </div>
                </div>
            </nav>
        </header>
    `;
}

function renderHomeView() {
    const slide = appState.slides[appState.activeSlide];
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
                <div class="flex transition-transform duration-700 ease-in-out" style="transform: translateX(-${appState.activeSlide * 100}%)">
                    ${appState.slides.map(s => `
                        <div class="w-full flex-shrink-0">
                            <div class="relative w-full h-[450px]">
                                <img src="${s.image}" class="w-full h-full object-cover rounded-lg" alt="Слайд карусели"/>
                                <div class="absolute inset-0 flex justify-center items-end pb-12 rounded-lg">
                                    <button class="bg-[#fcc521] text-gray-800 font-bold py-3 px-8 hover:bg-yellow-400 transition-colors text-lg rounded-md">Узнать больше</button>
                                </div>
                            </div>
                        </div>
                    `).join('')}
                </div>

                <!-- Slider Dots -->
                <div class="absolute bottom-4 left-1/2 -translate-x-1/2 flex space-x-2">
                    ${appState.slides.map((_, index) => `
                        <button onclick="setActiveSlide(${index})" class="w-3 h-3 rounded-full ${appState.activeSlide === index ? 'bg-white' : 'bg-white/50'}"></button>
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
                            <h4 class="font-bold text-gray-800">${item.title}</h4>
                            <p class="text-sm text-gray-500">${item.text}</p>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
        
        <!-- Promo Banners -->
        <div class="bg-gray-100 py-10">
            <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 grid grid-cols-1 md:grid-cols-3 gap-8">
                 <div class="bg-yellow-400 p-6 rounded-lg text-gray-800 cursor-pointer hover:shadow-xl transition-shadow">
                    <h3 class="text-xl font-bold">КОРПОРАТИВНЫМ КЛИЕНТАМ</h3>
                    <p class="text-3xl font-extrabold">СПЕЦИАЛЬНЫЕ УСЛОВИЯ</p>
                 </div>
                 <div class="bg-yellow-400 p-6 rounded-lg text-gray-800 cursor-pointer hover:shadow-xl transition-shadow">
                     <h3 class="text-xl font-bold"><i class="fas fa-arrow-down"></i> СКИДКА 3%</h3>
                     <p>на следующий заказ: оформи заказ прямо сейчас на сайте и получи скидку на следующий заказ</p>
                 </div>
                 <div class="bg-yellow-400 p-6 rounded-lg text-gray-800 cursor-pointer hover:shadow-xl transition-shadow">
                     <h3 class="text-xl font-bold">СКИДКИ ДЛЯ ВСЕХ</h3>
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
        <p class="text-lg text-gray-600 mb-8">Принимая решение о покупке в интернет-магазине мы часто задаем себе вопрос, а что скрывается за красочной интернет-витриной? Надежна ли организация у которой мы хотим совершить покупку? Можем ли мы рассчитывать на качественный товар и высокий уровень сервиса которые обещает нам продавец?</p>
        <p class="text-lg text-gray-600 mb-12">В этом разделе Вы найдете информацию, которая позволит сформировать первое впечатление о холдинге компаний "АРТ-СТРОЙ", ответит на вопросы которые мы сформулировали ранее, поможет принять решение о сотрудничестве с нами.</p>

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
        <p class="text-lg text-gray-600 mb-8">Холдинг компаний "АРТ-СТРОЙ" осуществляет деятельность на рынке строительных материалов с 2002 года. За это время нами были налажены партнерские отношения с ведущими поставщиками, мы являемся дилерами высшей категории многих производителей.</p>
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
        <p class="text-lg text-gray-600 mb-8">Интернет-магазин предлагает несколько вариантов доставки:</p>
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
        <p class="text-lg text-gray-600 mb-8">При оформлении заказа на нашем сайте, Вы можете выбрать один из следующих вариантов оплаты:</p>
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
    const { customerType, deliveryMethod, paymentMethod } = appState.checkoutState;

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
    } else {
        return `<div id="checkout-content" class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">${pageHtml}</div>`;
    }
}



function renderStaticPage(title, content) {
    return `
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
            <div class="bg-white p-8 rounded-lg shadow-md">
                <h1 class="text-4xl font-bold text-gray-800 mb-6">${title}</h1>
                <div class="prose max-w-none">${content}</div>
            </div>
        </div>
    `;
}


function renderCatalogPage() {
    const content = `
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        <h1 class="text-4xl font-bold text-gray-800 mb-6">Каталог</h1>
        <div class="grid grid-cols-1 md:grid-cols-4 gap-8">
            <aside class="md:col-span-1">
                <ul class="space-y-2 bg-white p-4 rounded-lg shadow-md">
                    ${appState.catalogCategories.map(cat => `
                        <li>
                            <a href="#" onclick="event.preventDefault(); handleCategoryClick('${cat.title}')" class="flex items-center p-2 text-gray-700 rounded-lg hover:bg-gray-100 hover:text-[#fcc521]">
                                <i class="fas ${cat.icon} w-6 text-center"></i>
                                <span class="ml-3">${cat.title}</span>
                            </a>
                        </li>
                    `).join('')}
                </ul>
            </aside>
            <main class="md:col-span-3">
                 <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
                    ${appState.catalogCategories.map(cat => `
                        <div class="bg-white p-4 rounded-lg shadow-md flex gap-4">
                            <img src="${cat.image}" alt="${cat.title}" class="w-24 h-24 object-cover rounded-md"/>
                            <div>
                                <h3 class="font-bold text-lg cursor-pointer" onclick="handleCategoryClick('${cat.title}')">${cat.title}</h3>
                                <ul class="text-sm mt-2 space-y-1">
                                    ${cat.links.slice(0, 5).map(link => `<li><a href="#" onclick="event.preventDefault(); handleCategoryClick('${link}')" class="hover:text-[#fcc521] hover:underline">${link}</a></li>`).join('')}
                                    ${cat.links.length > 5 ? `<li><a href="#" onclick="event.preventDefault(); handleCategoryClick('${cat.title}')" class="text-yellow-600 hover:underline">Все товары...</a></li>` : ''}
                                </ul>
                            </div>
                        </div>
                    `).join('')}
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
                            <input type="checkbox" ${appState.onlyWithPrice ? 'checked' : ''} onchange="setOnlyWithPrice(this.checked)" class="h-4 w-4 text-[#fcc521] border-gray-300 rounded focus:ring-[#fcc521]"/>
                            <span>Только с ценой</span>
                        </label>
                        <select onchange="setState({ sortBy: this.value })" class="w-full md:w-auto px-4 py-2 border border-gray-300 rounded-lg bg-white focus:ring-2 focus:ring-[#fcc521] focus:outline-none">
                            <option value="name-asc" ${appState.sortBy === 'name-asc' ? 'selected' : ''}>По названию (А-Я)</option>
                            <option value="name-desc" ${appState.sortBy === 'name-desc' ? 'selected' : ''}>По названию (Я-А)</option>
                            <option value="price-asc" ${appState.sortBy === 'price-asc' ? 'selected' : ''}>Сначала дешевле</option>
                            <option value="price-desc" ${appState.sortBy === 'price-desc' ? 'selected' : ''}>Сначала дороже</option>
                        </select>
                    </div>
                </div>
            </div>
            <div id="product-grid-container" class="grid-container grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-6">
                ${visibleProducts.length > 0 ? visibleProducts.map(renderProductCard).join('') : `<p class="col-span-full text-center text-gray-500 py-10">Товары не найдены.</p>`}
            </div>
        </div>`;
}

/**
 * Рендерит карточку товара в списке с учётом цены, бейджей и безопасного изображения.
 */
function renderProductCard(product) {
    const itemInCart = appState.cartItems[product.id];
    const priceLabel = getProductPriceLabel(product);
    const unitLabel = product.hasPrice ? `<span class="text-sm font-normal text-gray-500"> / ${escapeHtml(product.unit)}</span>` : '';
    const titleAttr = escapeHtmlAttribute(product.name);
    const nameText = escapeHtml(product.name);
    const categoryText = escapeHtml(product.category);
    return `
        <div class="bg-white rounded-lg shadow-md overflow-hidden transform hover:-translate-y-1 transition-transform duration-300 flex flex-col group border">
            <div class="relative h-48 bg-gray-200 cursor-pointer" onclick="showDetails('${product.id}')">
                <img src="${product.image}" alt="${titleAttr}" class="w-full h-full object-cover" onerror="this.onerror=null; this.src='${PLACEHOLDER_IMAGE}'"/>
                ${product.badges.noPrice ? `<span class="absolute top-3 left-3 bg-amber-500 text-white text-xs font-semibold px-2 py-1 rounded">Цена по запросу</span>` : ''}
            </div>
            <div class="p-4 flex-grow flex flex-col gap-2">
                <h3 class="text-md font-semibold text-gray-800 cursor-pointer hover:text-yellow-500" onclick="showDetails('${product.id}')" title="${titleAttr}" style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">
                    ${nameText}
                </h3>
                <p class="text-sm text-gray-500">${categoryText}</p>
                <p class="text-lg font-bold text-gray-900">${priceLabel}${unitLabel}</p>
                <div class="mt-auto flex items-center justify-between gap-3">
                    ${product.hasPrice ? (
                        !itemInCart
                            ? `<button onclick="addToCart('${product.id}')" class="bg-[#fcc521] hover:bg-yellow-500 text-gray-800 font-bold px-4 py-2 rounded-md transition-colors duration-200">В корзину</button>`
                            : `<div class="flex items-center rounded-lg border border-gray-300">
                                    <button onclick="updateCartItemQuantity('${product.id}', -1)" class="px-3 py-1 text-lg hover:bg-gray-100 rounded-l-lg">-</button>
                                    <span class="px-3 font-medium">${itemInCart.quantity}</span>
                                    <button onclick="updateCartItemQuantity('${product.id}', 1)" class="px-3 py-1 text-lg hover:bg-gray-100 rounded-r-lg">+</button>
                                </div>`
                    ) : `<button onclick="requestPrice('${product.id}')" class="bg-gray-200 hover:bg-gray-300 text-gray-700 font-semibold px-4 py-2 rounded-md transition-colors duration-200">Запросить цену</button>`}
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
                <div class="space-y-4">${Object.entries(appState.cartItems).map(([productId, item]) => {
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
    const product = appState.products.find(p => String(p.id) === String(appState.selectedProductId));
    if (!product) return `<div class="p-10 text-center text-red-600">Продукт не найден.</div>`;
    const itemInCart = appState.cartItems[product.id];
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

    return `
        <div class="max-w-5xl mx-auto p-4 sm:p-6 bg-white my-8 rounded-lg shadow-xl">
            <button onclick="exitProductDetails()" class="mb-6 text-gray-600 hover:text-[#fcc521] hover:underline flex items-center transition">
                <i class="fas fa-arrow-left mr-2"></i> Назад в каталог
            </button>
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
                <div class="bg-gray-100 rounded-lg flex items-center justify-center p-4">
                    <img src="${product.image}" alt="${titleAttr}" class="max-h-96 w-auto object-contain" onerror="this.onerror=null; this.src='${PLACEHOLDER_IMAGE}'"/>
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
    adminContentElement.innerHTML = `
        <div class="max-w-3xl mx-auto p-6 space-y-8">
            <h2 class="text-3xl font-bold text-gray-800">Панель Администратора</h2>
            <div class="bg-white p-6 rounded-lg shadow-md space-y-4">
                 <h3 class="text-xl font-semibold text-gray-700">Массовый Импорт (JSON / CSV)</h3>
                 <input type="file" id="json-file-upload" accept=".json, .csv" onchange="handleFileChange(this.files[0])" class="w-full border p-2 rounded"/>
                 <textarea id="jsonInput" oninput="window.adminState.jsonInput = this.value;" rows="6" placeholder="Вставьте JSON или загрузите файл..." class="w-full border p-2 rounded">${window.adminState.jsonInput}</textarea>
                 <button onclick="handleBulkImport(window.adminState.jsonInput)" class="w-full bg-indigo-600 text-white py-2 rounded-lg hover:bg-indigo-700">Импортировать</button>
            </div>
             <form id="singleProductForm" class="bg-white p-6 rounded-lg shadow-md space-y-4">
                 <h3 class="text-xl font-semibold text-gray-700">Добавить продукт</h3>
                 <input type="text" id="name" value="${window.adminState.productName}" oninput="window.adminState.productName = this.value;" placeholder="Название" class="w-full border p-2 rounded" required/>
                 <div class="flex gap-4">
                    <input type="number" id="price" value="${window.adminState.productPrice}" oninput="window.adminState.productPrice = this.value;" placeholder="Цена" class="w-1/2 border p-2 rounded" required/>
                    <input type="text" id="unit" value="${window.adminState.productUnit}" oninput="window.adminState.productUnit = this.value;" placeholder="Ед. изм." class="w-1/2 border p-2 rounded"/>
                 </div>
                 <input type="text" id="image" value="${window.adminState.productImage}" oninput="window.adminState.productImage = this.value;" placeholder="URL изображения" class="w-full border p-2 rounded"/>
                 <textarea id="description" oninput="window.adminState.productDescription = this.value;" rows="4" placeholder="Описание" class="w-full border p-2 rounded" required>${window.adminState.productDescription}</textarea>
                 <button type="submit" class="w-full bg-gray-800 hover:bg-gray-700 text-white py-2 rounded-lg">Добавить товар</button>
             </form>
        </div>`;
    
    document.getElementById('singleProductForm').onsubmit = (e) => {
        e.preventDefault();
        handleAddProduct({ name: window.adminState.productName, price: window.adminState.productPrice, unit: window.adminState.productUnit, description: window.adminState.productDescription, image: window.adminState.productImage });
        window.adminState = {...window.adminState, productName: '', productPrice: '', productUnit: 'шт', productDescription: '', productImage: 'https://placehold.co/400x300/e2e8f0/94a3b8?text=Стройматериал'};
        renderAdminContent();
    };
}

function renderAdminContent() {
    if (appState.view === 'admin') setTimeout(renderAdminPanel, 0);
}

function renderMessageModal() {
    if (!appState.message) return '';
    const safeMessage = escapeHtml(appState.message);
    return `<div class="fixed top-5 right-5 bg-gray-800 text-white py-3 px-5 rounded-lg shadow-xl z-50 animate-fade-in-down"><p><i class="fas fa-check-circle mr-2"></i>${safeMessage}</p></div>`;
}

function renderFooter() {
    return `<footer class="bg-gray-800 text-white mt-auto"><div class="max-w-7xl mx-auto py-8 px-4 sm:px-6 lg:px-8 text-center"><p>&copy; 2024 АРТ-СТРОЙ. Все права защищены.</p><p class="text-gray-400 text-sm mt-1">Демо-версия интернет-магазина.</p></div></footer>`;
}

function renderMobileMenu() {
    if (!appState.isMenuOpen) return '';
    return `
        <div class="fixed inset-0 bg-black bg-opacity-60 z-[70]" onclick="toggleMenu()">
            <div class="fixed top-0 left-0 h-full w-72 bg-white shadow-xl p-6 transform transition-transform duration-300 ${appState.isMenuOpen ? 'translate-x-0' : '-translate-x-full'}" onclick="event.stopPropagation()">
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
    if (appState.view === 'checkout') {
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
         }
         return; // Предотвращаем полный ререндер
    }

    let contentHtml = '';
    switch (appState.view) {
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
    if (appState.view === 'admin') renderAdminContent();
}

// --- Инициализация ---
window.setView = setView;
window.showDetails = showDetails;
window.addToCart = addToCart;
window.updateCartItemQuantity = updateCartItemQuantity;
window.removeFromCart = removeFromCart;
window.requestPrice = requestPrice;
window.exitProductDetails = exitProductDetails;
window.handleBulkImport = handleBulkImport;
window.handleFileChange = handleFileChange;
window.setState = setState;
window.toggleMenu = toggleMenu;
window.setActiveSlide = setActiveSlide;
window.setCatalogMenu = setCatalogMenu;
window.handleCategoryClick = handleCategoryClick;
window.handlePlaceOrder = handlePlaceOrder;
window.handleCheckoutChange = handleCheckoutChange;
window.handleSearch = handleSearch;
window.setOnlyWithPrice = setOnlyWithPrice;

window.onload = () => {
    loadState();
    applyInitialRoute();
    render();
    window.addEventListener('hashchange', handleHashChange);
    if (appState.view === 'home') {
        startSlider();
    }
};

window.onbeforeunload = () => {
    stopSlider();
};

