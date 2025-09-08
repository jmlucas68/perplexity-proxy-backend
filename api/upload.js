const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const stream = require('stream');
const cors = require('cors');

const app = express();

// CORS configuration - SOLO UNA configuración
app.use(cors({
    origin: [
        'https://jmlucas68.github.io',
        'http://localhost:3000',
        'http://127.0.0.1:5500',
        'http://localhost:5500'
    ],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));

// Handle preflight requests explicitly
app.options('*', cors());

// Logging middleware
app.use((req, res, next) => {
    console.log('📝 Request details:');
    console.log(' - Method:', req.method);
    console.log(' - Origin:', req.headers.origin);
    console.log(' - Content-Type:', req.headers['content-type']);
    console.log(' - Content-Length:', req.headers['content-length']);
    next();
});

// Configure multer
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { 
        fileSize: 100 * 1024 * 1024, // 100MB limit
        files: 1 
    },
    fileFilter: (req, file, cb) => {
        console.log('🔍 File filter check:');
        console.log(' - Field name:', file.fieldname);
        console.log(' - Original name:', file.originalname);
        console.log(' - MIME type:', file.mimetype);
        cb(null, true);
    }
});

// Google OAuth configuration
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

// Upload endpoint
app.post('/api/upload', (req, res) => {
    console.log('📨 Upload request received');
    
    const uploadMiddleware = upload.any(); // Accept any field names
    
    uploadMiddleware(req, res, async (err) => {
        if (err) {
            console.error('❌ Multer error:', err);
            return res.status(400).json({ 
                success: false, 
                error: 'Multer error: ' + err.message,
                details: err.toString()
            });
        }

        // Check if we have any files
        if (!req.files || req.files.length === 0) {
            console.warn("⚠️ No files received");
            console.log('Request body keys:', Object.keys(req.body));
            return res.status(400).json({ 
                success: false, 
                error: 'No file uploaded.',
                receivedFields: Object.keys(req.body)
            });
        }

        const file = req.files[0]; // Take the first file regardless of field name
        
        console.log("📥 File received:");
        console.log(" - Field name:", file.fieldname);
        console.log(" - Original name:", file.originalname);
        console.log(" - MIME type:", file.mimetype);
        console.log(" - Size (bytes):", file.size);

        const bufferStream = new stream.PassThrough();
        bufferStream.end(file.buffer);

        try {
            const { data } = await drive.files.create({
                media: {
                    mimeType: file.mimetype,
                    body: bufferStream,
                },
                requestBody: {
                    name: file.originalname,
                    parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
                },
                fields: 'id, webViewLink',
            });

            console.log("✅ Upload completed. ID:", data.id, " URL:", data.webViewLink);

            res.status(200).json({ 
                success: true, 
                url: data.webViewLink,
                fileId: data.id
            });
        } catch (error) {
            console.error('❌ Error uploading to Google Drive:', error);
            res.status(500).json({
                success: false,
                error: 'Error uploading to Google Drive.',
                details: error.message,
            });
        }
    });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Test CORS endpoint
app.get('/api/test-cors', (req, res) => {
    res.json({ 
        message: 'CORS working!', 
        origin: req.headers.origin,
        timestamp: new Date().toISOString() 
    });
});

module.exports = app;