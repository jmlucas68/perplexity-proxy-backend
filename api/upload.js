const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const stream = require('stream');
const cors = require('cors');

const app = express();
const upload = multer();

app.use(cors());

app.post('/api/upload', upload.single('ebook'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, error: 'No file uploaded.' });
    }

    try {
        const credentials = JSON.parse(process.env.GOOGLE_DRIVE_CREDENTIALS);
        const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/drive.file'],
        });

        const drive = google.drive({ version: 'v3', auth });

        const bufferStream = new stream.PassThrough();
        bufferStream.end(req.file.buffer);

        const { data } = await drive.files.create({
            media: {
                mimeType: req.file.mimetype,
                body: bufferStream,
            },
            requestBody: {
                name: req.file.originalname,
            },
            fields: 'id',
        });

        res.status(200).json({ success: true, fileId: data.id });
    } catch (error) {
        console.error('Error uploading to Google Drive:', error);
        res.status(500).json({ success: false, error: 'Error uploading to Google Drive.', details: error.message });
    }
});

module.exports = app;