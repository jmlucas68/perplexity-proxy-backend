const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { google } = require('googleapis');
const multer = require('multer');
const stream = require('stream');

const app = express();

// --- CONFIGURACIÓN DE SEGURIDAD (CORS) ---
const allowedOrigins = [
    `https://jmlucas68.github.io`,
    'http://127.0.0.1:5500',
    'http://localhost:3000',
    null
];

const corsOptions = {
  origin: (origin, callback) => {
    if (allowedOrigins.includes(origin) || !origin) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
};

app.use(cors(corsOptions));
app.use(express.json());

// --- CONFIGURACIÓN DE GOOGLE DRIVE ---
const DRIVE_FOLDER_ID = '1tHLaiZsReRqCrHT1Izfb6RwQpiYnkK3M'; // ID de la carpeta que me diste
const driveCredentials = process.env.GOOGLE_DRIVE_CREDENTIALS;
let drive;

if (driveCredentials) {
    try {
        const parsedCredentials = JSON.parse(driveCredentials);
        const auth = new google.auth.GoogleAuth({
            credentials: parsedCredentials,
            scopes: ['https://www.googleapis.com/auth/drive']
        });
        drive = google.drive({ version: 'v3', auth });
        console.log('✅ Google Drive client initialized successfully.');
    } catch (error) {
        console.error('❌ Error initializing Google Drive client:', error);
    }
} else {
    console.log('⚠️ Google Drive credentials not found. Upload endpoint will not work.');
}


// --- CONFIGURACIÓN DE MULTER (para subida de archivos) ---
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 50 * 1024 * 1024, // Límite de 50 MB por archivo
    },
});

// --- RUTA PARA SUBIR ARCHIVOS ---
app.post('/api/upload', upload.single('ebook'), async (req, res) => {
    if (!drive) {
        return res.status(500).json({ error: 'Google Drive client is not initialized on the server.' });
    }
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded.' });
    }

    try {
        const bufferStream = new stream.PassThrough();
        bufferStream.end(req.file.buffer);

        const { data } = await drive.files.create({
            media: {
                mimeType: req.file.mimetype,
                body: bufferStream,
            },
            requestBody: {
                name: req.file.originalname,
                parents: [DRIVE_FOLDER_ID],
            },
            fields: 'id,name,webViewLink,webContentLink',
        });

        console.log(`File uploaded successfully: ${data.name} (ID: ${data.id})`);
        res.status(200).json({ success: true, file: data });

    } catch (error) {
        console.error('Error uploading to Google Drive:', error);
        res.status(500).json({ error: 'Failed to upload file to Google Drive.', details: error.message });
    }
});


// --- LÓGICA PARA LA API DE GEMINI (sin cambios) ---
app.post('/api/proxy', async (req, res) => {
  const API_KEY = process.env.GEMINI_API_KEY;

  if (!API_KEY) {
    return res.status(500).json({ error: 'La clave de API de Gemini no está configurada en el servidor.' });
  }

  const { action, prompt, password } = req.body;

  // --- VALIDACIÓN DE CONTRASEÑA DE ADMIN ---
  if (action === 'validate_password') {
    const ADMIN_PASSWORD = process.env.BIBLIOTECA_ADMIN;
    if (!ADMIN_PASSWORD) {
        return res.status(500).json({ error: 'Admin password not configured on server.' });
    }
    if (password === ADMIN_PASSWORD) {
        return res.status(200).json({ success: true });
    } else {
        return res.status(401).json({ success: false, error: 'Invalid password.' });
    }
  }
  
  // --- LLAMADA A GEMINI ---
  if (!prompt) {
    return res.status(400).json({ error: 'No se ha proporcionado un \'prompt\'.' });
  }

  const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${API_KEY}`;

  try {
    const payload = {
      contents: [{ parts: [{ text: prompt }] }]
    };

    const response = await axios.post(GEMINI_API_URL, payload, {
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.data.candidates || !response.data.candidates[0] || !response.data.candidates[0].content) {
      return res.status(500).json({ error: 'Respuesta inesperada de la API de Gemini' });
    }

    const geminiText = response.data.candidates[0].content.parts[0].text;

    res.json({
      choices: [{ message: { content: geminiText } }],
    });

  } catch (error) {
    console.error('Error calling Gemini API:', error.response ? error.response.data : error.message);
    const status = error.response ? error.response.status : 500;
    const errorData = error.response ? error.response.data : { error: { message: error.message } };
    res.status(status).json({ error: `API Error: ${errorData.error.message}` });
  }
});

// --- INICIO DEL SERVIDOR LOCAL ---
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Servidor proxy escuchando en el puerto ${PORT}`);
    console.log('Variables de entorno requeridas: GEMINI_API_KEY, ADMIN_PASSWORD, GOOGLE_DRIVE_CREDENTIALS');
  });
}

module.exports = app;
