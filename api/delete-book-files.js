const crypto = require('crypto');
const cors = require('cors');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

const allowedOrigins = [
    'https://jmlucas68.github.io',
    'https://jmlucas68.github.io/Biblioteca',
    'http://127.0.0.1:5500',
    'http://localhost:3000',
];

const corsOptions = {
    origin: (origin, callback) => callback(null, allowedOrigins.includes(origin) || !origin),
};

function extractDriveId(value) {
    if (typeof value !== 'string') return null;
    const query = value.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (query?.[1]) return query[1];
    const path = value.match(/\/file\/d\/([a-zA-Z0-9_-]+)(?:\/|$)/);
    return path?.[1] || null;
}

function isValidAdminToken(authorization) {
    const token = String(authorization || '').replace(/^Bearer\s+/i, '');
    const [payload, signature] = token.split('.');
    if (!payload || !signature) return false;

    const secret = process.env.BIBLIOTECA_ADMIN_TOKEN_SECRET || process.env.BIBLIOTECA_ADMIN;
    if (!secret) return false;
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;

    try {
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        return data.role === 'Bibliotecario' && Number.isFinite(data.exp) && data.exp > Date.now();
    } catch {
        return false;
    }
}

function driveClient() {
    const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI,
    );
    oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
    return { oauth2Client, drive: google.drive({ version: 'v3', auth: oauth2Client }) };
}

module.exports = async (req, res) => {
    cors(corsOptions)(req, res, async () => {
        if (req.method === 'OPTIONS') return res.status(204).end();
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
        if (!isValidAdminToken(req.headers.authorization)) return res.status(401).json({ error: 'No autorizado.' });

        const bookId = Number(req.body?.bookId);
        if (!Number.isInteger(bookId) || bookId < 1) return res.status(400).json({ error: 'Identificador de libro no válido.' });
        const deleteDriveFiles = req.body?.deleteDriveFiles === true;
        if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
            return res.status(500).json({ error: 'Falta configurar Supabase en el proxy.' });
        }

        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

        try {
            const { data: formats, error: formatsReadError } = await supabase
                .from('book_formats')
                .select('url,url_download')
                .eq('book_id', bookId);
            if (formatsReadError) throw formatsReadError;

            const ids = [...new Set((formats || [])
                .flatMap(format => [extractDriveId(format.url), extractDriveId(format.url_download)])
                .filter(Boolean))];

            if (deleteDriveFiles && ids.length) {
                const libraryFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
                if (!libraryFolderId) return res.status(500).json({ error: 'Falta configurar GOOGLE_DRIVE_FOLDER_ID en el proxy.' });

                const { oauth2Client, drive } = driveClient();
                const { credentials } = await oauth2Client.refreshAccessToken();
                oauth2Client.setCredentials(credentials);
                for (const fileId of ids) {
                    const metadata = await drive.files.get({ fileId, fields: 'id,parents,trashed', supportsAllDrives: true });
                    if (metadata.data.trashed) continue;
                    if (!(metadata.data.parents || []).includes(libraryFolderId)) {
                        return res.status(403).json({ error: 'Uno de los ficheros no pertenece a la carpeta de la biblioteca.' });
                    }
                }
                await Promise.all(ids.map(fileId => drive.files.delete({ fileId, supportsAllDrives: true })));
            }

            const { error: formatsDeleteError } = await supabase.from('book_formats').delete().eq('book_id', bookId);
            if (formatsDeleteError) throw formatsDeleteError;
            const { error: bookDeleteError } = await supabase.from('books').delete().eq('id', bookId);
            if (bookDeleteError) throw bookDeleteError;
            return res.status(200).json({ success: true, deletedFiles: deleteDriveFiles ? ids.length : 0 });
        } catch (error) {
            console.error('Error deleting Drive files:', error);
            const status = error.code === 401 || error.code === 403 ? 403 : 500;
            return res.status(status).json({ error: 'No se pudieron borrar los ficheros de Google Drive.' });
        }
    });
};
