import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';

if (!GEMINI_API_KEY) {
    console.warn('[SERVER] GEMINI_API_KEY не задан. Генерация описаний будет недоступна.');
}

app.use(express.json());

app.post('/api/generate', async (req, res) => {
    if (!GEMINI_API_KEY) {
        return res.status(503).json({ error: { message: 'GEMINI_API_KEY не настроен на сервере.' } });
    }

    const { productName } = req.body;
    if (!productName || typeof productName !== 'string') {
        return res.status(400).json({ error: { message: 'Некорректный параметр productName.' } });
    }

    const systemPrompt = `Ты — профессиональный писатель-копирайтер. Твоя задача — создавать краткие, понятные и привлекательные описания товаров для интернет-магазина строительных материалов.

Правила:
• Описание должно быть от 50 до 150 символов.
• Текст простой, без излишней технической сложности.
• Без заголовков, без символов форматирования (**, *, # и т.п.).
• Только текст описания.
• Не повторяй название товара в описании.
• Фокусируйся на практической пользе и преимуществах.`;

    try {
        const payload = {
            contents: [
                {
                    role: 'user',
                    parts: [{ text: `Product Name: ${productName}` }],
                },
            ],
            systemInstruction: {
                role: 'system',
                parts: [{ text: systemPrompt }],
            },
        };

        const response = await fetch(`${GEMINI_API_URL}?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            let errorMessage = `${response.status} ${response.statusText}`;
            try {
                const errorBody = await response.json();
                console.error('[GEMINI_PROXY_ERROR]', errorBody);
                if (errorBody?.error?.message) {
                    errorMessage = errorBody.error.message;
                }
            } catch (parseError) {
                console.error('[GEMINI_PROXY_ERROR_PARSE]', parseError);
            }
            return res.status(response.status).json({ error: { message: errorMessage } });
        }

        const data = await response.json();
        const description = data?.candidates?.[0]?.content?.parts
            ?.map((part) => (typeof part?.text === 'string' ? part.text : ''))
            .filter(Boolean)
            .join('\n')
            .trim();

        res.json({ description: description || 'Не удалось сгенерировать описание.' });
    } catch (error) {
        console.error('[GEMINI_PROXY_REQUEST]', error);
        res.status(502).json({ error: { message: 'Не удалось выполнить запрос к Gemini API.' } });
    }
});

app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
});

app.use(express.static('.'));

// For local development
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`[SERVER] Запущен на порту ${PORT}`);
    });
}

// Export for Vercel serverless functions
export default app;
