// --- КОНФИГУРАЦИЯ ---
const APP_ID = 'stroy-market-local'; 

// LLM API Configuration (для генерации описаний)
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=';

// ВАШ КЛЮЧ GEMINI
// Вставьте сюда ваш API-ключ Gemini, чтобы работала функция генерации описаний.
const GEMINI_API_KEY = ""; 
// ---------------------

// --- Глобальное Состояние ---
let appState = {
    products: [],
    cartItems: {}, // { productId: { quantity, name, price, unit } }
    view: 'home', // 'home', 'cart', 'admin', 'details'
    selectedProductId: null, // ID для детальной страницы
    message: ''
};

// Внутреннее состояние формы администратора (для сохранения введенных данных)
window.adminState = {
    productName: '', productPrice: '', productUnit: 'шт', 
    productImage: 'https://placehold.co/400x160/2563eb/ffffff?text=Material', 
    productDescription: '', isGenerating: false, jsonInput: '',
};

// --- Утилиты для работы с localStorage ---

function loadState() {
    const storedProducts = localStorage.getItem(`${APP_ID}_products`);
    const storedCart = localStorage.getItem(`${APP_ID}_cart`);
    
    if (storedProducts) {
        appState.products = JSON.parse(storedProducts);
    } else {
        appState.products = [{
            id: 'demo-1', name: 'Пеноблок D600 (600x200x300)', price: 350, unit: 'шт', 
            description: 'Легкий и прочный пеноблок для строительства наружных стен и перегородок. Высокие теплоизоляционные свойства. Идеально подходит для малоэтажного и частного строительства, обеспечивая отличную звукоизоляцию и минимальные теплопотери.',
            image: 'https://placehold.co/400x160/2563eb/ffffff?text=Пеноблок'
        }];
    }

    if (storedCart) {
        appState.cartItems = JSON.parse(storedCart);
    }
}

function saveState() {
    localStorage.setItem(`${APP_ID}_products`, JSON.stringify(appState.products));
    localStorage.setItem(`${APP_ID}_cart`, JSON.stringify(appState.cartItems));
}

// --- Управление Состоянием (ГЛОБАЛЬНЫЕ ФУНКЦИИ) ---

function setState(newState, callback = null) {
    Object.assign(appState, newState);
    saveState(); 
    render(); 
    if (callback) callback();
}

function setMessage(text) {
    setState({ message: text });
    setTimeout(() => setState({ message: '' }), 5000);
}

function setView(newView) {
    setState({ view: newView, selectedProductId: null, message: '' });
}

function showDetails(productId) {
    setState({ view: 'details', selectedProductId: productId });
}

// --- Утилиты Расчетов ---

function formatCurrency(amount) {
    return amount.toLocaleString('ru-RU', { minimumFractionDigits: 0 }) + ' ₽';
}

function calculateTotalCost() {
    return Object.values(appState.cartItems).reduce((sum, item) => 
        sum + (item.quantity * item.price), 0);
}

function calculateCartCount() {
    return Object.values(appState.cartItems).reduce((sum, item) => sum + item.quantity, 0);
}

// --- Функции Корзины (ГЛОБАЛЬНЫЕ) ---

function updateCartItemQuantity(productId, change) {
    const currentItem = appState.cartItems[productId] || {};
    const product = appState.products.find(p => p.id === productId);

    if (!product) {
        setMessage('Продукт не найден.');
        return;
    }

    const newQuantity = (currentItem.quantity || 0) + change;
    const newCartItems = { ...appState.cartItems };

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
    const item = appState.cartItems[productId];
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
    
    const newProducts = [...appState.products, newProduct];
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
        const newProducts = [...appState.products];

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
                        class="text-lg font-medium transition duration-150 p-2 rounded-lg ${appState.view === 'home' || appState.view === 'details' ? 'text-yellow-400 bg-blue-700/50' : 'text-white hover:text-yellow-200 hover:bg-blue-700/50'}"
                    >
                        Каталог
                    </button>
                    <button 
                        onclick="setView('admin')" 
                        class="text-lg font-medium transition duration-150 p-2 rounded-lg ${appState.view === 'admin' ? 'text-yellow-400 bg-blue-700/50' : 'text-white hover:text-yellow-200 hover:bg-blue-700/50'} hidden sm:block"
                    >
                        Админ
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

function renderProductCard(product) {
    const itemInCart = appState.cartItems[product.id];
    const priceHtml = formatCurrency(product.price);

    return `
        <div class="bg-white rounded-xl shadow-xl overflow-hidden transform hover:scale-[1.02] transition duration-300 flex flex-col cursor-pointer" onclick="showDetails('${product.id}')">
            <div class="h-40 bg-gray-200 flex items-center justify-center overflow-hidden">
                <img
                    src="${product.image || 'https://placehold.co/400x160/2563eb/ffffff?text=' + product.name.substring(0, 10)}"
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
                </div>
            </div>
        </div>
    `;
}

function renderProductList() {
    const productCards = appState.products.map(renderProductCard).join('');
    
    return `
        <div class="grid-container">
            ${appState.products.length === 0 ? `
                <p class="col-span-full text-center text-gray-500 py-10">
                    Каталог пуст. Перейдите в "Админ" для добавления продуктов.
                </p>
            ` : productCards}
        </div>
    `;
}

function renderProductDetails() {
    const product = appState.products.find(p => p.id === appState.selectedProductId);
    
    if (!product) {
        return `<div class="p-10 text-center text-red-600">Продукт не найден.</div>`;
    }

    const itemInCart = appState.cartItems[product.id];
    const priceHtml = formatCurrency(product.price);
    const descriptionHtml = product.description.replace(/\n/g, '<br>');

    return `
        <div class="max-w-5xl mx-auto p-6 bg-white rounded-xl shadow-2xl">
            <button onclick="setView('home')" class="mb-6 text-blue-600 hover:text-blue-800 flex items-center transition">
                <svg class="w-5 h-5 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18"></path></svg>
                Назад в Каталог
            </button>

            <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
                <!-- Image Area -->
                <div class="relative bg-gray-100 rounded-lg overflow-hidden h-96">
                    <img
                        src="${product.image || 'https://placehold.co/800x600/2563eb/ffffff?text=' + product.name}"
                        alt="${product.name}"
                        class="w-full h-full object-cover"
                        onerror="this.onerror=null; this.src='https://placehold.co/800x600/2563eb/ffffff?text=${product.name}';"
                    />
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

    const cartItemsHtml = Object.entries(appState.cartItems).map(([productId, item]) => `
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
    if (!appState.message) return '';
    
    return `
        <div id="message-modal" class="modal fixed inset-0 bg-gray-600 bg-opacity-50 flex items-center justify-center z-50 p-4">
            <div class="bg-white rounded-xl shadow-2xl p-6 max-w-sm w-full transform transition-all">
                <p class="text-gray-800 font-medium mb-4">${appState.message}</p>
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

    switch (appState.view) {
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
    
    if (appState.view === 'admin') {
        renderAdminContent();
    }
}

function renderAdminContent() {
     if (appState.view === 'admin') {
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
window.generateDescription = generateDescription; // Сделаем генерацию глобальной для тестов

// Инициализация при загрузке страницы
window.onload = function() {
    loadState();
    render();
}
