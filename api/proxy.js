const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();

// --- CONFIGURACIÓN DE SEGURIDAD (CORS) ---
// Reemplaza '<TU-USUARIO-DE-GITHUB>' con tu nombre de usuario real de GitHub.
const allowedOrigins = [
    `https://jmlucas68.github.io`,
    `https://jmlucas68.github.io/Biblioteca`,
    'http://127.0.0.1:5500',
    'http://localhost:3000'
];

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
  try {
    console.log('Request received:', req.body);
    console.log('BIBLIOTECA_ADMIN env var:', process.env.BIBLIOTECA_ADMIN ? 'Set' : 'Not Set');
    console.log('GEMINI_API_KEY env var:', process.env.GEMINI_API_KEY ? 'Set' : 'Not Set');

    const { action, password, prompt } = req.body;

    if (action === 'validate_password') {
      const adminPassword = process.env.BIBLIOTECA_ADMIN;
      if (!adminPassword) {
        console.error('BIBLIOTECA_ADMIN environment variable is not set.');
        return res.status(500).json({ error: 'La contraseña de administrador no está configurada en el servidor.' });
      }
      if (password === adminPassword) {
        return res.json({ isValid: true });
      } else {
        return res.json({ isValid: false });
      }
    }

    const API_KEY = process.env.GEMINI_API_KEY; // Variable de entorno para Gemini

    if (!API_KEY) {
      console.error('GEMINI_API_KEY environment variable is not set.');
      return res.status(500).json({ error: 'La clave de API de Gemini no está configurada en el servidor.' });
    }

    if (!prompt) {
      return res.status(400).json({ error: 'No se ha proporcionado un \'prompt\'.' });
    }

    const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${API_KEY}`;
    console.log('Calling URL:', GEMINI_API_URL.replace(API_KEY, 'HIDDEN_KEY'));

    const payload = {
      contents: [
        {
          parts: [
            {
              text: prompt
            }
          ]
        }
      ]
    };

    const response = await axios.post(GEMINI_API_URL, payload, {
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Verificamos que la respuesta tenga la estructura esperada
    if (!response.data.candidates || !response.data.candidates[0] || !response.data.candidates[0].content) {
      return res.status(500).json({ error: 'Respuesta inesperada de la API de Gemini' });
    }

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
    console.error('Error in /api/proxy:', error.response ? error.response.data : error.message);
    console.error('Full error object:', error);
    
    // Mejor manejo de errores específicos
    if (error.response) {
      const status = error.response.status;
      const errorData = error.response.data;
      
      console.error('Error status:', status);
      console.error('Error data:', errorData);
      
      if (status === 400 && errorData.error && errorData.error.message.includes('API key not valid')) {
        return res.status(400).json({ error: 'Clave API de Gemini no válida. Verifica tu configuración.' });
      }
      
      return res.status(status).json({
        error: `Error de la API de Gemini (${status}): ${errorData.error ? errorData.error.message : JSON.stringify(errorData)}`
      });
    }
    
    // Error sin respuesta (conexión, timeout, etc.)
    if (error.code) {
      return res.status(500).json({ error: `Error de conexión: ${error.code} - ${error.message}` });
    }
    
    res.status(500).json({ error: `Error interno: ${error.message}` });
  }
});

// --- INICIO DEL SERVIDOR LOCAL ---
// Vercel ignora este bloque, pero es necesario para pruebas locales.
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Servidor proxy escuchando en el puerto ${PORT}`);
    console.log('Recuerda establecer la variable de entorno GEMINI_API_KEY');
    
    // Debug: Verificar si la API key está configurada (solo en desarrollo)
    if (process.env.GEMINI_API_KEY) {
      console.log('✅ Variable GEMINI_API_KEY configurada correctamente');
    } else {
      console.log('❌ Variable GEMINI_API_KEY NO configurada');
    }
  });
}

// Vercel se encarga de levantar el servidor, solo necesitamos exportar la app.
module.exports = app;
