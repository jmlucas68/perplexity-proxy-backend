const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { google } = require("googleapis");
const { createClient } = require("@supabase/supabase-js");
const multer = require("multer");
const stream = require("stream");

const app = express();

// --- CONFIGURACIÓN DE SEGURIDAD (CORS) ---
const allowedOrigins = [
    'https://jmlucas68.github.io',
    'http://127.0.0.1:5500',
    'http://localhost:3000'
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Middleware para parsear JSON
app.use(express.json());

// --- LÓGICA DE IMPORTACIÓN (antes en import.js) ---

// Configuración de Multer
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

// Funciones de ayuda para la importación
function getEnv() {
  const env = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_KEY: process.env.SUPABASE_KEY,
    GOOGLE_SERVICE_ACCOUNT: process.env.GOOGLE_SERVICE_ACCOUNT,
    GOOGLE_DRIVE_FOLDER_ID: process.env.GOOGLE_DRIVE_FOLDER_ID,
    GOOGLE_CLIENT_EMAIL: process.env.GOOGLE_CLIENT_EMAIL,
    GOOGLE_PRIVATE_KEY: process.env.GOOGLE_PRIVATE_KEY,
  };
  for (const [key, value] of Object.entries(env)) {
      if (!value && key !== 'GOOGLE_CLIENT_EMAIL' && key !== 'GOOGLE_PRIVATE_KEY') { // Las credenciales de gogle pueden venir de otra forma
          throw new Error(`Falta variable de entorno: ${key}`);
      }
  }
  const haveJson = !!env.GOOGLE_SERVICE_ACCOUNT;
  const havePair = !!(env.GOOGLE_CLIENT_EMAIL && env.GOOGLE_PRIVATE_KEY);
  if (!haveJson && !havePair) {
    throw new Error("Faltan credenciales de Google: GOOGLE_SERVICE_ACCOUNT o GOOGLE_CLIENT_EMAIL+GOOGLE_PRIVATE_KEY");
  }
  return env;
}

function parseServiceAccount(serviceAccountJson, fallbackEmail, fallbackKey) {
  let creds;
  let raw = serviceAccountJson?.trim();
  if (raw?.startsWith("base64:")) {
    raw = Buffer.from(raw.slice("base64:".length), "base64").toString("utf8");
  }
  try {
    creds = raw ? JSON.parse(raw) : {};
  } catch (e) {
    throw new Error(`GOOGLE_SERVICE_ACCOUNT no es JSON válido: ${e.message}`);
  }
  if (fallbackEmail) creds.client_email = fallbackEmail;
  if (fallbackKey) creds.private_key = fallbackKey.replace(/\\n/g, "\n");
  if (typeof creds?.private_key === "string") {
    creds.private_key = creds.private_key.replace(/\\n/g, "\n");
  }
  if (!creds?.client_email) throw new Error('Service Account sin client_email.');
  return creds;
}

function getDriveClient(serviceAccountJson, email, privateKey) {
  const creds = parseServiceAccount(serviceAccountJson, email, privateKey);
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/drive.file"] });
  return google.drive({ version: "v3", auth });
}

// Manejador de la ruta de importación
const importHandler = async (req, res) => {
  try {
    const env = getEnv();
    const file = req.file;
    if (!file) return res.status(400).json({ error: "Archivo 'file' es requerido" });

    const fields = req.body;
    const drive = getDriveClient(env.GOOGLE_SERVICE_ACCOUNT, env.GOOGLE_CLIENT_EMAIL, env.GOOGLE_PRIVATE_KEY);
    const bufferStream = new stream.PassThrough().end(file.buffer);

    const uploadRes = await drive.files.create({
      requestBody: { name: file.originalname, parents: [env.GOOGLE_DRIVE_FOLDER_ID] },
      media: { mimeType: file.mimetype, body: bufferStream },
      fields: "id, webViewLink, size",
    });

    const sizeBytes = Number(uploadRes.data.size);
    const tamanio_total = !isNaN(sizeBytes) ? `${(sizeBytes / (1024 * 1024)).toFixed(2)} MB` : null;

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_KEY);
    const insertPayload = [{
      titulo: fields.titulo || file.originalname, autor: fields.autor || "Desconocido",
      isbn: fields.isbn || null, editorial: fields.editorial || null, fecha_publicacion: fields.fecha_publicacion || null,
      idioma: fields.idioma || "es", descripcion: fields.descripcion || null, genero: fields.genero || null,
      serie: fields.serie || null, numero_serie: fields.numero_serie || null, carpeta_autor: fields.autor || null,
      carpeta_obra: fields.titulo || null, url_download_portada: uploadRes.data.webViewLink ?? null, tamanio_total,
    }];

    const { error: supabaseError } = await supabase.from("books").insert(insertPayload);
    if (supabaseError) {
      await drive.files.delete({ fileId: uploadRes.data.id });
      throw new Error(`Error al insertar en Supabase: ${supabaseError.message}`);
    }

    res.status(200).json({ status: "success", drive_id: uploadRes.data.id, file_url: uploadRes.data.webViewLink, metadata: insertPayload[0] });
  } catch (e) {
    console.error("Error en /api/import:", e);
    res.status(500).json({ error: "Error al importar libro", details: e.message });
  }
};

// --- DEFINICIÓN DE RUTAS ---

// Ruta para importar libros (usa multer)
app.post('/import', upload.single('file'), importHandler);

// Ruta para el proxy de Gemini y validación de contraseña
app.post('/proxy', async (req, res) => {
  try {
    const { action, password, prompt } = req.body;

    if (action === 'validate_password') {
      const ADMIN_PASSWORD = process.env.BIBLIOTECA_ADMIN;
      if (!ADMIN_PASSWORD) return res.status(500).json({ error: 'Admin password not configured on server.' });
      if (password === ADMIN_PASSWORD) return res.status(200).json({ isValid: true });
      return res.status(401).json({ isValid: false, error: 'Invalid password.' });
    }

    const API_KEY = process.env.GEMINI_API_KEY;
    if (!API_KEY) return res.status(500).json({ error: 'La clave de API de Gemini no está configurada en el servidor.' });
    if (!prompt) return res.status(400).json({ error: 'No se ha proporcionado un \'prompt\'.'});

    const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${API_KEY}`;
    const payload = { contents: [{ parts: [{ text: prompt }] }] };
    const response = await axios.post(GEMINI_API_URL, payload, { headers: { 'Content-Type': 'application/json' } });

    if (!response.data.candidates?.[0]?.content) {
      return res.status(500).json({ error: 'Respuesta inesperada de la API de Gemini' });
    }
    const geminiText = response.data.candidates[0].content.parts[0].text;
    res.json({ choices: [{ message: { content: geminiText } }] });

  } catch (error) {
    console.error('Error in /api/proxy:', error.response ? error.response.data : error.message);
    const status = error.response?.status || 500;
    res.status(status).json({ error: `Error interno o de la API externa: ${error.message}` });
  }
});

// --- EXPORTACIÓN PARA VERCEL ---
module.exports = app;