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
    console.log('🔍 Request details:');
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

// Helper function to parse Google credentials if they're in JSON format
function parseGoogleCredentials() {
    let clientId = process.env.GOOGLE_CLIENT_ID;
    let clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    
    // If GOOGLE_CLIENT_SECRET is a JSON string, parse it
    if (clientSecret && clientSecret.startsWith('{')) {
        try {
            const credentialsJson = JSON.parse(clientSecret);
            if (credentialsJson.web) {
                clientId = credentialsJson.web.client_id || clientId;
                clientSecret = credentialsJson.web.client_secret;
            } else if (credentialsJson.installed) {
                clientId = credentialsJson.installed.client_id || clientId;
                clientSecret = credentialsJson.installed.client_secret;
            }
        } catch (error) {
            console.error('❌ Error parsing Google credentials JSON:', error.message);
        }
    }
    
    return { clientId, clientSecret };
}

// Parse credentials
const { clientId, clientSecret } = parseGoogleCredentials();

// Google OAuth configuration
const oauth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    process.env.GOOGLE_REDIRECT_URI
);

console.log('🔍 OAuth Configuration Check:');
console.log(' - Client ID exists:', !!clientId);
console.log(' - Client Secret exists:', !!clientSecret);
console.log(' - Redirect URI exists:', !!process.env.GOOGLE_REDIRECT_URI);
console.log(' - Refresh Token exists:', !!process.env.GOOGLE_REFRESH_TOKEN);
console.log(' - Drive Folder ID exists:', !!process.env.GOOGLE_DRIVE_FOLDER_ID);

// Si quieres ver los primeros caracteres (sin exponer las credenciales completas):
console.log(' - Client ID preview:', clientId?.substring(0, 10) + '...');
console.log(' - Client Secret preview:', clientSecret?.substring(0, 10) + '...');
console.log(' - Refresh Token preview:', process.env.GOOGLE_REFRESH_TOKEN?.substring(0, 10) + '...');

// Función para probar las credenciales antes de subir archivos
async function testGoogleAuth() {
    try {
        console.log('🧪 Testing Google Drive authentication...');
        
        // Intentar obtener información sobre el usuario autenticado
        const auth = await oauth2Client.getAccessToken();
        console.log('✅ Access token obtained successfully');
        
        // Intentar hacer una petición simple a Drive API
        const driveTest = google.drive({ version: 'v3', auth: oauth2Client });
        const response = await driveTest.about.get({ fields: 'user' });
        console.log('✅ Drive API test successful, user:', response.data.user?.displayName);
        
        return true;
    } catch (error) {
        console.error('❌ Google Auth test failed:', error.message);
        return false;
    }
}

oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
});

const drive = google.drive({
    version: 'v3',
    auth: oauth2Client,
});

async function diagnoseDriveFolder() {
    try {
        console.log('🔍 Diagnosing Drive folder access...');
        
        // 1. Verificar autenticación
        const auth = await oauth2Client.getAccessToken();
        console.log('✅ Authentication successful');
        
        // 2. Obtener información del usuario actual
        const driveTest = google.drive({ version: 'v3', auth: oauth2Client });
        const aboutResponse = await driveTest.about.get({ fields: 'user' });
        console.log('👤 Current user:', aboutResponse.data.user?.displayName);
        console.log('📧 User email:', aboutResponse.data.user?.emailAddress);
        
        // 3. Intentar obtener información de la carpeta específica
        const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
        console.log('📁 Testing folder ID:', folderId);
        
        try {
            const folderResponse = await driveTest.files.get({
                fileId: folderId,
                fields: 'id, name, parents, permissions, capabilities'
            });
            
            console.log('✅ Folder found!');
            console.log(' - Name:', folderResponse.data.name);
            console.log(' - ID:', folderResponse.data.id);
            console.log(' - Can create files:', folderResponse.data.capabilities?.canCreateFiles);
            console.log(' - Can list children:', folderResponse.data.capabilities?.canListChildren);
            
        } catch (folderError) {
            console.error('❌ Folder access failed:', folderError.message);
            
            if (folderError.code === 404) {
                console.log('💡 Possible solutions:');
                console.log(' 1. Check if folder ID is correct');
                console.log(' 2. Verify the user has access to this folder');
                console.log(' 3. Make sure folder exists and wasn\'t deleted');
            }
            
            // 4. Listar carpetas accesibles como alternativa
            console.log('\n📂 Listing accessible folders in root:');
            try {
                const listResponse = await driveTest.files.list({
                    q: "mimeType='application/vnd.google-apps.folder'",
                    fields: 'files(id, name, parents)'
                });
                
                listResponse.data.files?.forEach(folder => {
                    console.log(` - ${folder.name} (ID: ${folder.id})`);
                });
            } catch (listError) {
                console.error('❌ Could not list folders:', listError.message);
            }
        }
        
    } catch (error) {
        console.error('❌ Diagnosis failed:', error.message);
    }
}

// Upload endpoint
app.post('/api/upload', async (req, res) => {
    console.log('📨 Upload request received');
    
    diagnoseDriveFolder();

    // Validación temprana de variables de entorno requeridas
    const missingEnv = [];
    if (!clientId) missingEnv.push('GOOGLE_CLIENT_ID');
    if (!clientSecret) missingEnv.push('GOOGLE_CLIENT_SECRET');
    if (!process.env.GOOGLE_REDIRECT_URI) missingEnv.push('GOOGLE_REDIRECT_URI');
    if (!process.env.GOOGLE_REFRESH_TOKEN) missingEnv.push('GOOGLE_REFRESH_TOKEN');
    if (!process.env.GOOGLE_DRIVE_FOLDER_ID) missingEnv.push('GOOGLE_DRIVE_FOLDER_ID');
    if (missingEnv.length > 0) {
        return res.status(500).json({
            success: false,
            error: 'Missing Google OAuth environment variables',
            details: `Missing: ${missingEnv.join(', ')}`
        });
    }
    
    // Probar auth antes de procesar archivos (descomenta si quieres usarlo)
    /*
    const authValid = await testGoogleAuth();
    if (!authValid) {
        return res.status(500).json({
            success: false,
            error: 'Google authentication failed',
            details: 'Check your Google OAuth credentials in environment variables'
        });
    }*/

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