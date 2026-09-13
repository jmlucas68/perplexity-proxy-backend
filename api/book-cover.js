const crypto = require('crypto');
const axios = require('axios');
const cors = require('cors');
const multer = require('multer');
const stream = require('stream');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
});
const allowedOrigins = [
    'https://jmlucas68.github.io',
    'https://jmlucas68.github.io/Biblioteca',
    'http://127.0.0.1:5500',
    'http://localhost:3000',
];

function isValidAdminToken(authorization) {
    const token = String(authorization || '').replace(/^Bearer\s+/i, '');
    const [payload, signature] = token.split('.');
    const secret = process.env.BIBLIOTECA_ADMIN_TOKEN_SECRET || process.env.BIBLIOTECA_ADMIN;
    if (!payload || !signature || !secret) return false;
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
    try {
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        return data.role === 'Bibliotecario' && Number.isFinite(data.exp) && data.exp > Date.now();
    } catch {
        return false;
    }
}

async function driveClient() {
    const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI,
    );
    oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
    const { credentials } = await oauth2Client.refreshAccessToken();
    oauth2Client.setCredentials(credentials);
    return google.drive({ version: 'v3', auth: oauth2Client });
}

function safeFileName(name) {
    return String(name || 'portada.jpg').replace(/[\\/:*?"<>|\r\n]/g, '-').slice(0, 180);
}

async function saveCover({ bookId, buffer, mimeType, fileName }) {
    if (!process.env.GOOGLE_DRIVE_FOLDER_ID || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        throw new Error('El servidor no tiene configurado el almacenamiento de portadas.');
    }
    const drive = await driveClient();
    const body = new stream.PassThrough();
    body.end(buffer);
    const created = await drive.files.create({
        requestBody: { name: safeFileName(fileName), parents: [process.env.GOOGLE_DRIVE_FOLDER_ID] },
        media: { mimeType: mimeType || 'image/jpeg', body },
        fields: 'id',
    });
    if (!created.data.id) throw new Error('Google Drive no devolvió el identificador de la portada.');

    const viewUrl = `https://drive.google.com/file/d/${created.data.id}/view?usp=drivesdk`;
    const downloadUrl = `https://drive.google.com/uc?id=${created.data.id}&export=download`;
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { error } = await supabase
        .from('books')
        .update({ url_portada: viewUrl, url_download_portada: downloadUrl })
        .eq('id', bookId);
    if (error) throw new Error(`No se ha podido guardar la portada en la ficha: ${error.message}`);
    return { viewUrl, downloadUrl };
}

async function findCoverImage(title, author) {
    const query = [title && `intitle:${title}`, author && `inauthor:${author}`].filter(Boolean).join('+');
    if (!query) throw new Error('Indica al menos el título para buscar una portada.');
    const { data } = await axios.get('https://www.googleapis.com/books/v1/volumes', {
        params: { q: query, maxResults: 10, printType: 'books' },
        timeout: 15000,
    });
    const volume = (data.items || []).find(item => item.volumeInfo?.imageLinks);
    const links = volume?.volumeInfo?.imageLinks;
    const imageUrl = links?.extraLarge || links?.large || links?.medium || links?.thumbnail || links?.smallThumbnail;
    if (!imageUrl) throw new Error('No se ha encontrado una portada para este libro.');
    const image = await axios.get(String(imageUrl).replace(/^http:/, 'https:'), {
        responseType: 'arraybuffer',
        timeout: 15000,
        maxContentLength: 10 * 1024 * 1024,
    });
    const mimeType = String(image.headers['content-type'] || 'image/jpeg').split(';')[0];
    if (!mimeType.startsWith('image/')) throw new Error('La imagen encontrada no tiene un formato válido.');
    return { buffer: Buffer.from(image.data), mimeType, sourceTitle: volume.volumeInfo?.title || title };
}

const express = require('express');
const app = express();
app.use(cors({ origin: (origin, callback) => callback(null, allowedOrigins.includes(origin) || !origin) }));
app.use(express.json());

app.post('/api/book-cover', upload.single('image'), async (req, res) => {
    if (!isValidAdminToken(req.headers.authorization)) return res.status(401).json({ error: 'La sesión de bibliotecario ha caducado. Vuelve a iniciar sesión.' });
    const bookId = Number(req.body?.bookId);
    if (!Number.isInteger(bookId) || bookId < 1) return res.status(400).json({ error: 'Identificador de libro no válido.' });
    try {
        if (req.body?.action === 'upload') {
            if (!req.file || !String(req.file.mimetype || '').startsWith('image/')) return res.status(400).json({ error: 'Selecciona una imagen válida para la portada.' });
            const cover = await saveCover({ bookId, buffer: req.file.buffer, mimeType: req.file.mimetype, fileName: req.file.originalname });
            return res.status(200).json(cover);
        }
        if (req.body?.action === 'search') {
            const found = await findCoverImage(String(req.body?.titulo || '').trim(), String(req.body?.autor || '').trim());
            const cover = await saveCover({ bookId, ...found, fileName: `${found.sourceTitle}-portada.jpg` });
            return res.status(200).json(cover);
        }
        return res.status(400).json({ error: 'Acción de portada no válida.' });
    } catch (error) {
        console.error('Error al actualizar portada:', error);
        return res.status(500).json({ error: error.message || 'No se ha podido actualizar la portada.' });
    }
});

app.options('/api/book-cover', (_, res) => res.status(204).end());
module.exports = app;
