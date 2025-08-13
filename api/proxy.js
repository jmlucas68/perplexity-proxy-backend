const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();

// --- CONFIGURACIÓN DE SEGURIDAD (CORS) ---
// Reemplaza '<TU-USUARIO-DE-GITHUB>' con tu nombre de usuario real de GitHub.
const allowedOrigins = [`https://jmlucas68.github.io`];

// También puedes añadir 'http://127.0.0.1:5500' a la lista para pruebas locales
// Ejemplo: const allowedOrigins = [`https://juanma-dev.github.io`, 'http://127.0.0.1:5500'];

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

// --- LÓGICA PARA LA API DE GEMINI ---

app.post('/api/proxy', async (req, res) => {
  const API_KEY = process.env.GEMINI_API_KEY; // Variable de entorno para Gemini

  if (!API_KEY) {
    return res.status(500).json({ error: 'La clave de API de Gemini no está configurada en el servidor.' });
  }

  const { prompt } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'No se ha proporcionado un \'prompt\'.' });
  }

  const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${API_KEY}`;

  try {
    const payload = {
      contents: [{ parts: [{ text: prompt }] }],
    };

    const response = await axios.post(GEMINI_API_URL, payload, {
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Extraemos el texto de la respuesta de Gemini
    const geminiText = response.data.candidates[0].content.parts[0].text;

    // Devolvemos una estructura similar a la de OpenAI/Perplexity para no cambiar el frontend
    res.json({
      choices: [
        {
          message: {
            content: geminiText,
          },
        },
      ],
    });

  } catch (error) {
    console.error('Error calling Gemini API:', error.response ? error.response.data : error.message);
    console.error('Detalles del error de Gemini:', JSON.stringify(error.response ? error.response.data : error.message, null, 2));
    res.status(error.response ? error.response.status : 500).json({ error: 'Error contacting Gemini API.' });
  }
});

// Vercel se encarga de levantar el servidor, solo necesitamos exportar la app.
module.exports = app;
