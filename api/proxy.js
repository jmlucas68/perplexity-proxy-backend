const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();

// --- CONFIGURACIÓN DE SEGURIDAD (CORS) ---
// Reemplaza '<TU-USUARIO-DE-GITHUB>' con tu nombre de usuario real de GitHub.
const allowedOrigins = [`https://<TU-USUARIO-DE-GITHUB>.github.io`];

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

const PERPLEXITY_API_URL = 'https://api.perplexity.ai/chat/completions';

app.post('/api/proxy', async (req, res) => {
  const API_KEY = process.env.PERPLEXITY_API_KEY;

  if (!API_KEY) {
    return res.status(500).json({ error: 'La clave de API de Perplexity no está configurada en el servidor.' });
  }

  const { prompt } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'No se ha proporcionado un \'prompt\'.' });
  }

  try {
    const response = await axios.post(
      PERPLEXITY_API_URL,
      {
        model: 'sonar-medium-online',
        messages: [
          { role: 'system', content: 'Be precise and concise.' },
          { role: 'user', content: prompt },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error('Error calling Perplexity API:', error.response ? error.response.data : error.message);
    res.status(error.response ? error.response.status : 500).json({ error: 'Error contacting Perplexity API.' });
  }
});

// Vercel se encarga de levantar el servidor, solo necesitamos exportar la app.
module.exports = app;
