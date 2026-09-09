const { google } = require('googleapis');
const cors = require('cors');

const allowedOrigins = [
    'https://jmlucas68.github.io',
    'https://jmlucas68.github.io/Biblioteca',
    'http://127.0.0.1:5500',
    'http://localhost:3000',
];

const corsOptions = {
    origin: (origin, callback) => callback(null, allowedOrigins.includes(origin) || !origin),
};

const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

function extractDriveId(inputUrl) {
    if (!inputUrl || typeof inputUrl !== 'string') return null;
    const byQuery = inputUrl.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (byQuery?.[1]) return byQuery[1];
    const byPath = inputUrl.match(/\/file\/d\/([a-zA-Z0-9_-]+)(?:\/|$)/);
    return byPath?.[1] || null;
}

function sendError(res, status, error) {
    return res.status(status).json({ success: false, error });
}

module.exports = async (req, res) => {
    cors(corsOptions)(req, res, async () => {
        if (req.method === 'OPTIONS') return res.status(204).end();
        if (req.method !== 'POST') return sendError(res, 405, 'Method Not Allowed');

        const fileId = extractDriveId(req.body?.fileUrl);
        if (!fileId) return sendError(res, 400, 'El enlace de Google Drive no contiene un identificador de archivo válido.');

        const pendingFolderId = process.env.GOOGLE_DRIVE_PENDING_FOLDER_ID;
        const libraryFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
        if (!pendingFolderId) {
            return sendError(res, 500, 'Falta configurar GOOGLE_DRIVE_PENDING_FOLDER_ID en el proxy.');
        }
        if (!libraryFolderId) {
            return sendError(res, 500, 'Falta configurar GOOGLE_DRIVE_FOLDER_ID en el proxy.');
        }
        if (pendingFolderId === libraryFolderId) {
            return sendError(res, 500, 'Las carpetas Pendientes y Biblioteca deben ser distintas.');
        }

        try {
            const { credentials } = await oauth2Client.refreshAccessToken();
            oauth2Client.setCredentials(credentials);
            const drive = google.drive({ version: 'v3', auth: oauth2Client });
            const metadataResponse = await drive.files.get({
                fileId,
                fields: 'id,name,mimeType,size,parents,trashed',
            });
            const file = metadataResponse.data;
            if (file.trashed) return sendError(res, 400, 'El archivo está en la papelera de Drive.');

            const extension = String(file.name || '').split('.').pop().toLowerCase();
            if (!['pdf', 'epub', 'mobi', 'azw3'].includes(extension)) {
                return sendError(res, 400, 'Solo se pueden registrar archivos PDF, EPUB, MOBI o AZW3.');
            }

            const parents = file.parents || [];
            const isInPendingFolder = parents.includes(pendingFolderId);
            const isAlreadyInLibrary = parents.includes(libraryFolderId);
            if (!isInPendingFolder && !isAlreadyInLibrary) {
                return sendError(res, 403, 'El archivo debe estar en la carpeta de Drive Pendientes antes de registrarlo.');
            }

            if (isInPendingFolder && !isAlreadyInLibrary) {
                await drive.files.update({
                    fileId,
                    addParents: libraryFolderId,
                    removeParents: pendingFolderId,
                    fields: 'id,parents',
                });
            }

            const permissionsResponse = await drive.permissions.list({
                fileId,
                fields: 'permissions(id,type,role)',
            });
            const isPublic = (permissionsResponse.data.permissions || []).some(
                (permission) => permission.type === 'anyone' && permission.role === 'reader'
            );
            if (!isPublic) {
                await drive.permissions.create({
                    fileId,
                    requestBody: { role: 'reader', type: 'anyone' },
                });
            }

            return res.status(200).json({
                success: true,
                fileId,
                name: file.name,
                size: file.size || null,
                viewUrl: `https://drive.google.com/file/d/${fileId}/view?usp=drivesdk`,
                downloadUrl: `https://drive.google.com/uc?id=${fileId}&export=download`,
            });
        } catch (error) {
            console.error('Error registering Drive file:', error);
            const status = error.code === 404 ? 404 : error.code === 401 || error.code === 403 ? 403 : 500;
            return sendError(res, status, error.code === 404 ? 'No se encontró el archivo en Google Drive.' : 'No se pudo registrar el archivo de Drive.');
        }
    });
};
