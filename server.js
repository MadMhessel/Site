import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
    console.warn('[GEMINI_PROXY]', 'Переменная окружения GEMINI_API_KEY не задана. Генерация описаний будет недоступна.');
}

app.use(express.json({ limit: '1mb' }));

app.post('/api/generate', async (req, res) => {
    const productName = typeof req.body?.productName === 'string' ? req.body.productName.trim() : '';
    const systemPrompt = typeof req.body?.systemPrompt === 'string' && req.body.systemPrompt.trim()
        ? req.body.systemPrompt.trim()
        : 'You are a professional copywriter for a construction materials e-commerce site. Write a concise, engaging, and professional product description (max 4 sentences) for the provided product name, focusing on quality, use cases, and key benefits.';

    if (!productName) {
        return res.status(400).json({ error: { message: 'Поле productName обязательно.' } });
    }

    if (!GEMINI_API_KEY) {
        return res.status(500).json({ error: { message: 'Сервер не настроен: отсутствует GEMINI_API_KEY.' } });
    }

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

app.listen(PORT, () => {
    console.log(`[SERVER] Запущен на порту ${PORT}`);
});
