import express from 'express';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import fetch from 'node-fetch';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT ?? 3000);
const GEMINI_ENDPOINT = process.env.GEMINI_ENDPOINT ?? 'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? '';

const app = express();
app.use(express.json({ limit: '1mb' }));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', limiter);

const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

/**
 * Reads JSON catalog file.
 */
app.get('/api/catalog', async (_req, res) => {
  try {
    const filePath = path.join(__dirname, 'data', 'catalog.json');
    const data = await readFile(filePath, 'utf-8');
    res.json(JSON.parse(data));
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Не удалось загрузить каталог' });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/generate', async (req, res) => {
  if (!GEMINI_API_KEY) {
    res.status(400).json({ message: 'API ключ не задан' });
    return;
  }
  const prompt = String(req.body?.prompt ?? '').slice(0, 500);
  const context = String(req.body?.context ?? '').slice(0, 1000);
  if (!prompt) {
    res.status(400).json({ message: 'Пустой запрос' });
    return;
  }
  try {
    const response = await fetch(`${GEMINI_ENDPOINT}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { text: `${prompt}\nКонтекст: ${context}` }
            ]
          }
        ]
      })
    });
    if (!response.ok) {
      const errorBody = await response.text();
      console.error('Gemini error', errorBody);
      res.status(502).json({ message: 'Сервис генерации недоступен' });
      return;
    }
    const data = (await response.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    res.json({ text });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Ошибка генерации' });
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server started on http://localhost:${PORT}`);
});
