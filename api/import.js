const { google } = require("googleapis");
const { createClient } = require("@supabase/supabase-js");
const multer = require("multer");
const stream = require("stream");

// Configuración de Multer para procesar el archivo en memoria
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }, // Límite de 500 MB
});

// --- Funciones de Ayuda (copiadas y adaptadas de la versión de Next.js) ---

function getEnv() {
  const env = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_KEY: process.env.SUPABASE_KEY,
    GOOGLE_SERVICE_ACCOUNT: process.env.GOOGLE_SERVICE_ACCOUNT,
    GOOGLE_DRIVE_FOLDER_ID: process.env.GOOGLE_DRIVE_FOLDER_ID,
    GOOGLE_CLIENT_EMAIL: process.env.GOOGLE_CLIENT_EMAIL,
    GOOGLE_PRIVATE_KEY: process.env.GOOGLE_PRIVATE_KEY,
  };
  if (!env.SUPABASE_URL) throw new Error("Falta variable de entorno: SUPABASE_URL");
  if (!env.SUPABASE_KEY) throw new Error("Falta variable de entorno: SUPABASE_KEY");
  if (!env.GOOGLE_DRIVE_FOLDER_ID) throw new Error("Falta variable de entorno: GOOGLE_DRIVE_FOLDER_ID");
  const haveJson = !!env.GOOGLE_SERVICE_ACCOUNT;
  const havePair = !!(env.GOOGLE_CLIENT_EMAIL && env.GOOGLE_PRIVATE_KEY);
  if (!haveJson && !havePair) {
    throw new Error("Faltan credenciales: GOOGLE_SERVICE_ACCOUNT o GOOGLE_CLIENT_EMAIL+GOOGLE_PRIVATE_KEY");
  }
  return env;
}

function parseServiceAccount(serviceAccountJson, fallbackEmail, fallbackKey) {
  let creds;
  let raw = serviceAccountJson?.trim();
  if (raw?.startsWith("base64:")) {
    const b64 = raw.slice("base64:".length);
    raw = Buffer.from(b64, "base64").toString("utf8");
  }
  try {
    creds = raw ? JSON.parse(raw) : {};
  } catch (_e) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT no es JSON válido");
  }

  if (fallbackEmail) creds.client_email = fallbackEmail;
  if (fallbackKey) creds.private_key = fallbackKey;

  if (typeof creds?.private_key === "string") {
    creds.private_key = creds.private_key.replace(/\\n/g, "\n");
  }

  if (!creds?.client_email) {
    const keys = creds && typeof creds === "object" ? Object.keys(creds) : [];
    throw new Error(`Service Account sin client_email. Claves presentes: ${keys.join(",")}`);
  }
  return creds;
}

function getDriveClient(serviceAccountJson, email, privateKey) {
  const creds = parseServiceAccount(serviceAccountJson, email, privateKey);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/drive.file"],
  });
  return google.drive({ version: "v3", auth });
}

// --- Manejador Principal de la Ruta ---

const handler = async (req, res) => {
  try {
    const { SUPABASE_URL, SUPABASE_KEY, GOOGLE_SERVICE_ACCOUNT, GOOGLE_DRIVE_FOLDER_ID, GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY } = getEnv();

    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: "Archivo 'file' es requerido" });
    }

    const fields = req.body;

    // Subir a Google Drive
    const drive = getDriveClient(GOOGLE_SERVICE_ACCOUNT, GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY);
    
    // Crear un stream legible desde el buffer del archivo
    const bufferStream = new stream.PassThrough();
    bufferStream.end(file.buffer);

    const uploadRes = await drive.files.create({
      requestBody: { name: file.originalname, parents: [GOOGLE_DRIVE_FOLDER_ID] },
      media: { mimeType: file.mimetype, body: bufferStream },
      fields: "id, webViewLink, size",
    });

    const sizeBytes = uploadRes.data.size ? Number(uploadRes.data.size) : undefined;
    const tamanio_total = typeof sizeBytes === "number" ? `${(sizeBytes / (1024 * 1024)).toFixed(2)} MB` : null;

    // Guardar en Supabase
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const insertPayload = [{
      titulo: fields.titulo || file.originalname,
      autor: fields.autor || "Desconocido",
      isbn: fields.isbn || null,
      editorial: fields.editorial || null,
      fecha_publicacion: fields.fecha_publicacion || null,
      idioma: fields.idioma || "es",
      descripcion: fields.descripcion || null,
      genero: fields.genero || null,
      serie: fields.serie || null,
      numero_serie: fields.numero_serie || null,
      carpeta_autor: fields.autor || null,
      carpeta_obra: fields.titulo || null,
      url_download_portada: uploadRes.data.webViewLink ?? null,
      tamanio_total,
    }];

    const { error: supabaseError } = await supabase.from("books").insert(insertPayload);
    if (supabaseError) {
        // Si falla Supabase, intentar borrar el archivo de Drive para no dejar huérfanos
        await drive.files.delete({ fileId: uploadRes.data.id });
        throw new Error(`Error al insertar en Supabase: ${supabaseError.message}`);
    }

    res.status(200).json({
      status: "success",
      drive_id: uploadRes.data.id,
      file_url: uploadRes.data.webViewLink,
      metadata: {
        titulo: insertPayload[0].titulo,
        autor: insertPayload[0].autor,
        idioma: insertPayload[0].idioma,
        tamanio_total,
      },
    });

  } catch (e) {
    console.error("Error en /api/import:", e);
    res.status(500).json({ error: "Error al importar libro", details: e.message });
  }
};

// Exportar el middleware de multer y el manejador
// El middleware se usará antes del manejador en la definición de la ruta principal
module.exports = { upload, handler };
