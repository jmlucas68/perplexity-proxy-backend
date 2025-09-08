const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const stream = require('stream');
const cors = require('cors');

const app = express();
const upload = multer({
    storage: multer.memoryStorage(), // explícito
    limits: { files: 1 }             // solo un archivo permitido
});

app.use(cors());

const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
);

oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
});

const drive = google.drive({
    version: 'v3',
    auth: oauth2Client,
});

app.post('/api/upload', upload.single('ebook'), async (req, res) => {
    if (!req.file) {
        console.warn("⚠️ No se recibió ningún archivo");
        return res.status(400).json({ success: false, error: 'No file uploaded.' });
    }

    // 🔹 Logs de depuración
    console.log("📥 Archivo recibido:");
    console.log(" - Nombre:", req.file.originalname);
    console.log(" - Tipo MIME:", req.file.mimetype);
    console.log(" - Tamaño (bytes):", req.file.size);

    const bufferStream = new stream.PassThrough();
    bufferStream.end(req.file.buffer);

    try {
        const { data } = await drive.files.create({
            media: {
                mimeType: req.file.mimetype,
                body: bufferStream,
            },
            requestBody: {
                name: req.file.originalname,
                parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
            },
            fields: 'id, webViewLink',
        });

        console.log("✅ Subida completada. ID:", data.id, " URL:", data.webViewLink);

        res.status(200).json({ success: true, url: data.webViewLink });
    } catch (error) {
        console.error('❌ Error subiendo a Google Drive:', error);
        res.status(500).json({
            success: false,
            error: 'Error uploading to Google Drive.',
            details: error.message,
        });
    }
});

module.exports = app;
