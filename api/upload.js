const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const stream = require('stream');
const cors = require('cors');

const app = express();
const upload = multer().single('ebook');

// --- CORS Configuration ---
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

// --- Google Drive Client ---
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
);

// Set initial credentials with the refresh token
oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
});

// Listen for 'tokens' event to catch any updates to access or refresh tokens
oauth2Client.on('tokens', (tokens) => {
    if (tokens.refresh_token) {
        // This indicates a new refresh token was issued.
        // In a real application, you would save this to a persistent store (e.g., database).
        console.log('New Google Refresh Token obtained:', tokens.refresh_token);
        // You might want to update your environment variable or database here.
        // For a serverless function, this might mean re-deploying with the new token
        // or storing it in a persistent key-value store.
    }
    console.log('New Google Access Token obtained:', tokens.access_token);
});

const drive = google.drive({
    version: 'v3',
    auth: oauth2Client,
});

app.post('/api/upload', (req, res) => {
    upload(req, res, async (err) => {
        if (err) {
            console.error('Multer file upload error:', err);
            return res.status(500).json({ success: false, error: 'File upload error', details: err.message });
        }

        const ebookFile = req.file;
        if (!ebookFile) {
            return res.status(400).json({ success: false, error: 'No ebook file uploaded.' });
        }

        const ebookBufferStream = new stream.PassThrough();
        ebookBufferStream.end(ebookFile.buffer);

        let drive;
        try {
            drive = await getAuthenticatedDriveClient();
        } catch (authError) {
            console.error('Authentication error before Google Drive operation:', authError.message);
            return res.status(500).json({ success: false, error: 'Authentication error', details: authError.message });
        }

        try {
            // 1. Upload ebook file
            const ebookUploadRes = await drive.files.create({
                media: {
                    mimeType: ebookFile.mimetype,
                    body: ebookBufferStream,
                },
                requestBody: {
                    name: ebookFile.originalname,
                    parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
                },
                fields: 'id',
            });

            const fileId = ebookUploadRes.data.id;
            if (!fileId) {
                throw new Error('Google Drive upload did not return a file ID.');
            }

            // 2. Make file publicly readable
            await drive.permissions.create({
                fileId: fileId,
                requestBody: {
                    role: 'reader',
                    type: 'anyone',
                },
            });

            // 3. Construct both URLs
            const viewUrl = `https://drive.google.com/file/d/${fileId}/view?usp=drivesdk`;
            const downloadUrl = `https://drive.google.com/uc?id=${fileId}&export=download`;

            // 4. Return both URLs to the frontend
            res.status(200).json({
                success: true,
                viewUrl: viewUrl,
                downloadUrl: downloadUrl,
            });

        } catch (error) {
            console.error('Error during Google Drive upload process:', error);
            // Check for specific Google API errors
            if (error.code === 401 || error.code === 403) {
                return res.status(401).json({ success: false, error: 'Google Drive API authentication/permission error.', details: error.message });
            }
            res.status(500).json({ success: false, error: 'Error during upload process.', details: error.message });
        }
    });
});

module.exports = app;