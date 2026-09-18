const { google } = require('googleapis');
const cors = require('cors');
const stream = require('stream');
const { pathToFileURL } = require('url');
const { createExtractorFromData } = require('node-unrar-js');

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

const CBR_IMAGE_TYPES = new Map([
    ['jpg', 'image/jpeg'],
    ['jpeg', 'image/jpeg'],
    ['png', 'image/png'],
    ['gif', 'image/gif'],
    ['webp', 'image/webp'],
    ['avif', 'image/avif'],
]);

function getFileExtension(fileName) {
    return String(fileName || '').split('.').pop().toLowerCase();
}

async function uploadCover(drive, parentId, coverName, mimeType, imageBuffer) {
    const imageStream = new stream.PassThrough();
    imageStream.end(imageBuffer);

    const uploaded = await drive.files.create({
        requestBody: { name: coverName, parents: [parentId] },
        media: { mimeType, body: imageStream },
        fields: 'id',
    });
    const coverId = uploaded.data.id;
    if (!coverId) throw new Error('Drive no devolvió el identificador de la portada.');

    return {
        id: coverId,
        viewUrl: `https://drive.google.com/file/d/${coverId}/view?usp=drivesdk`,
        downloadUrl: `https://drive.google.com/uc?id=${coverId}&export=download`,
    };
}

/**
 * Rasteriza la primera página de un PDF de Drive. Se carga bajo demanda para
 * no penalizar el registro de formatos que no son PDF.
 */
async function extractPdfCover(drive, fileId, fileName, parentId) {
    const [{ getDocument, GlobalWorkerOptions }, { createCanvas }] = await Promise.all([
        import('pdfjs-dist/legacy/build/pdf.mjs'),
        Promise.resolve(require('@napi-rs/canvas')),
    ]);
    // En producción el worker no se resuelve automáticamente desde el módulo
    // principal. require.resolve también permite a Vercel incluirlo al trazar
    // las dependencias de esta función.
    GlobalWorkerOptions.workerSrc = pathToFileURL(
        require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
    ).href;
    const download = await drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'arraybuffer' }
    );
    const pdf = await getDocument({ data: new Uint8Array(download.data) }).promise;

    try {
        const page = await pdf.getPage(1);
        const naturalViewport = page.getViewport({ scale: 1 });
        // Limita el lado mayor para mantener la portada nítida sin generar
        // imágenes innecesariamente grandes en la función serverless.
        const scale = Math.min(2, 1600 / Math.max(naturalViewport.width, naturalViewport.height));
        const viewport = page.getViewport({ scale });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const context = canvas.getContext('2d');

        await page.render({ canvasContext: context, viewport }).promise;
        const imageBuffer = canvas.toBuffer('image/jpeg', 90);
        const baseName = String(fileName || 'ebook').replace(/\.[^.]+$/, '');
        const coverName = `${baseName}_portada.jpg`;
        return uploadCover(drive, parentId, coverName, 'image/jpeg', imageBuffer);
    } finally {
        await pdf.destroy();
    }
}

/**
 * Extrae la primera página de imagen de un CBR y la guarda como portada en
 * Drive. Solo se descomprime esa página, aunque el archivo CBR completo se
 * descarga para poder leer su índice RAR.
 */
async function extractCbrCover(drive, fileId, fileName, parentId) {
    const download = await drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'arraybuffer' }
    );
    const data = download.data instanceof ArrayBuffer
        ? download.data
        : Uint8Array.from(download.data).buffer;
    const extractor = await createExtractorFromData({ data });
    const { fileHeaders } = extractor.getFileList();
    const firstImage = [...fileHeaders].find(file =>
        !file.flags.directory && CBR_IMAGE_TYPES.has(getFileExtension(file.name))
    );

    if (!firstImage) {
        throw new Error('El archivo CBR no contiene ninguna página de imagen compatible.');
    }

    const { files } = extractor.extract({ files: [firstImage.name] });
    const [extracted] = [...files];
    if (!extracted?.extraction) {
        throw new Error('No se pudo extraer la primera página del archivo CBR.');
    }

    const extension = getFileExtension(firstImage.name);
    const baseName = String(fileName || 'comic').replace(/\.[^.]+$/, '');
    const coverName = `${baseName}_portada.${extension}`;
    return uploadCover(
        drive,
        parentId,
        coverName,
        CBR_IMAGE_TYPES.get(extension),
        Buffer.from(extracted.extraction)
    );
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

            const extension = getFileExtension(file.name);
            if (!['pdf', 'epub', 'mobi', 'azw3', 'cbr'].includes(extension)) {
                return sendError(res, 400, 'Solo se pueden registrar archivos PDF, EPUB, MOBI, AZW3 o CBR.');
            }

            const parents = file.parents || [];
            const isInPendingFolder = parents.includes(pendingFolderId);
            const isAlreadyInLibrary = parents.includes(libraryFolderId);
            if (!isInPendingFolder && !isAlreadyInLibrary) {
                return sendError(res, 403, 'El archivo debe estar en la carpeta de Drive Pendientes antes de registrarlo.');
            }

            // Las portadas se guardan como imágenes independientes junto al
            // libro: se rasteriza la primera página del PDF y se extrae la
            // primera página de imagen del CBR.
            const cover = extension === 'pdf'
                ? await extractPdfCover(drive, fileId, file.name, libraryFolderId)
                : extension === 'cbr'
                    ? await extractCbrCover(drive, fileId, file.name, libraryFolderId)
                    : null;

            if (isInPendingFolder && !isAlreadyInLibrary) {
                await drive.files.update({
                    fileId,
                    addParents: libraryFolderId,
                    removeParents: pendingFolderId,
                    fields: 'id,parents',
                });
            }

            return res.status(200).json({
                success: true,
                fileId,
                name: file.name,
                size: file.size || null,
                viewUrl: `https://drive.google.com/file/d/${fileId}/view?usp=drivesdk`,
                downloadUrl: `https://drive.google.com/uc?id=${fileId}&export=download`,
                coverViewUrl: cover?.viewUrl ?? null,
                coverDownloadUrl: cover?.downloadUrl ?? null,
            });
        } catch (error) {
            console.error('Error registering Drive file:', error);
            const status = error.code === 404 ? 404 : error.code === 401 || error.code === 403 ? 403 : 500;
            return sendError(res, status, error.code === 404 ? 'No se encontró el archivo en Google Drive.' : 'No se pudo registrar el archivo de Drive.');
        }
    });
};
