const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');
const stream = require('stream');
const EPub = require('epub');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

// Initialize Express app
const app = express();

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

// --- Supabase and Google Drive Clients ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

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

// Multer configuration for in-memory file storage
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

app.post('/api/extract-cover', upload.any(), async (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).send('No file uploaded.');
    }
    const ebookFile = req.files[0]; // Use the first file found

    const bookId = req.body.bookId;
    if (!bookId) {
        return res.status(400).send('No book ID provided.');
    }

    let imageBuffer;
    let imageMimeType;
    let tempFilePath;

    try {
        // --- Extract cover image from file ---
        if (ebookFile.mimetype === 'application/epub+zip') {
            tempFilePath = path.join(os.tmpdir(), `ebook-${Date.now()}.epub`);
            await fs.writeFile(tempFilePath, ebookFile.buffer);
            const epub = new EPub(tempFilePath);
            await new Promise((resolve, reject) => {
                epub.on('end', () => {
                    epub.getCover(async (err, data, mimeType) => {
                        if (err) return reject(err);
                        imageBuffer = data;
                        imageMimeType = mimeType;
                        resolve();
                    });
                });
                epub.on('error', reject);
                epub.parse();
            });
        } else {
            // NOTE: PDF extraction logic was removed in a previous step by mistake.
            // This version focuses on the EPUB path as requested.
            return res.status(415).send('Unsupported file type for cover extraction. Only EPUB is currently supported.');
        }

        if (!imageBuffer) {
            return res.status(500).send('Could not extract cover image from EPUB.');
        }

        // --- Upload cover to Google Drive ---
        const coverBufferStream = new stream.PassThrough();
        coverBufferStream.end(imageBuffer);

        const coverFileName = `${path.parse(ebookFile.originalname).name}_cover.jpg`;

        const coverUploadRes = await drive.files.create({
            media: {
                mimeType: imageMimeType,
                body: coverBufferStream,
            },
            requestBody: {
                name: coverFileName,
                parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
            },
            fields: 'id',
        });

        const fileId = coverUploadRes.data.id;
        if (!fileId) {
            throw new Error('Google Drive upload did not return a file ID.');
        }

        // Make the file publicly readable
        await drive.permissions.create({
            fileId: fileId,
            requestBody: {
                role: 'reader',
                type: 'anyone',
            },
        });
        
        const publicUrl = `https://drive.google.com/uc?id=${fileId}`;

        // --- Update Supabase DB with the new Google Drive URL ---
        const { error: updateError } = await supabase
            .from('books')
            .update({ url_portada: publicUrl })
            .eq('id', bookId);

        if (updateError) {
            throw updateError;
        }

        res.status(200).json({ message: 'Cover extracted and uploaded to Google Drive.', coverUrl: publicUrl });

    } catch (error) {
        console.error('Error processing file:', error);
        res.status(500).json({ error: error.message });
    } finally {
        if (tempFilePath) {
            try {
                await fs.unlink(tempFilePath);
            } catch (cleanupError) {
                console.error('Error cleaning up temporary file:', cleanupError);
            }
        }
    }
});

module.exports = app;