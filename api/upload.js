const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const stream = require('stream');
const cors = require('cors');

const app = express();
const upload = multer();

// --- CONFIGURACIÓN DE SEGURIDAD (CORS) ---
const allowedOrigins = [
    `https://jmlucas68.github.io`,
    'http://127.0.0.1:5500',
    'http://localhost:3000',
    'https://jmlucas68.github.io/Biblioteca'
];
const corsOptions = {
    origin: (origin, callback) => {
        if (allowedOrigins.includes(origin) || !origin) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    }
};
app.use(cors(corsOptions));
app.use(express.json());

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

app.post('/api/upload', upload.fields([{ name: 'ebook', maxCount: 1 }, { name: 'coverUrl', maxCount: 1 }]), async (req, res) => {
    const ebookFile = req.files['ebook'] ? req.files['ebook'][0] : null;
    const coverUrl = req.body.coverUrl; // Access coverUrl from req.body

    if (!ebookFile) {
        return res.status(400).json({ success: false, error: 'No ebook file uploaded.' });
    }

    const ebookBufferStream = new stream.PassThrough();
    ebookBufferStream.end(ebookFile.buffer);

    try {
        // Upload ebook file
        const ebookUploadRes = await drive.files.create({
            media: {
                mimeType: ebookFile.mimetype,
                body: ebookBufferStream,
            },
            requestBody: {
                name: ebookFile.originalname,
                parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
            },
            fields: 'id, webViewLink',
        });

        let coverWebViewLink = null;
        if (coverUrl) {
            // Convert data URL to buffer
            const base64Data = coverUrl.replace(/^data:image\/(png|jpeg|jpg);base64,/, '');
            const coverBuffer = Buffer.from(base64Data, 'base64');
            const coverBufferStream = new stream.PassThrough();
            coverBufferStream.end(coverBuffer);

            // Upload cover image
            const coverUploadRes = await drive.files.create({
                media: {
                    mimeType: 'image/png', // Assuming PNG from data URL
                    body: coverBufferStream,
                },
                requestBody: {
                    name: `${ebookFile.originalname}_cover.png`,
                    parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
                },
                fields: 'id, webViewLink',
            });
            coverWebViewLink = coverUploadRes.data.webViewLink;
        }

        res.status(200).json({
            success: true,
            ebookUrl: ebookUploadRes.data.webViewLink,
            coverUrl: coverWebViewLink // Include cover URL in response
        });

    } catch (error) {
        console.error('Error during upload process:', error);
        res.status(500).json({ success: false, error: 'Error during upload process.', details: error.message });
    }
});

module.exports = app;