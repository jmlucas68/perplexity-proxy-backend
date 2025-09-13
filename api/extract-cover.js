const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const EPub = require('epub'); // Replaced epub-parser with epub

const fs = require('fs/promises');
const os = require('os');
const path = require('path');

// Initialize Express app
const app = express();

// --- CONFIGURACIÓN DE SEGURIDAD (CORS) ---
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

// Supabase configuration - Use environment variables in Vercel
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY; // Use the service role key for admin tasks
const supabase = createClient(supabaseUrl, supabaseKey);

// Multer configuration for in-memory file storage
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

app.post('/api/extract-cover', upload.single('ebookFile'), async (req, res) => {
    if (!req.file) {
        return res.status(400).send('No file uploaded.');
    }

    const bookId = req.body.bookId;
    if (!bookId) {
        return res.status(400).send('No book ID provided.');
    }

    let imageBuffer;
    let imageMimeType;
    let tempFilePath;

    try {
        // --- Process EPUB ---
        if (req.file.mimetype === 'application/epub+zip') {
            // The 'epub' library needs a file path, so we write the buffer to a temp file
            tempFilePath = path.join(os.tmpdir(), `ebook-${Date.now()}.epub`);
            await fs.writeFile(tempFilePath, req.file.buffer);

            const epub = new EPub(tempFilePath);

            // The library is event-based, so we wrap it in a promise
            await new Promise((resolve, reject) => {
                epub.on('end', () => {
                    epub.getCover(async (err, data, mimeType) => {
                        if (err) {
                            return reject(err);
                        }
                        imageBuffer = data;
                        imageMimeType = mimeType;
                        resolve();
                    });
                });
                epub.on('error', reject);
                epub.parse();
            });

        }
        // --- Process PDF ---
        else if (req.file.mimetype === 'application/pdf') {
            // Polyfills para APIs del navegador en entorno de servidor
            if (typeof global.DOMMatrix === 'undefined') {
                global.DOMMatrix = class DOMMatrix {
                    constructor(init) {
                        this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0;
                        if (init) {
                            if (typeof init === 'string') {
                                const values = init.match(/-?[\d.]+/g);
                                if (values && values.length >= 6) {
                                    this.a = parseFloat(values[0]); this.b = parseFloat(values[1]);
                                    this.c = parseFloat(values[2]); this.d = parseFloat(values[3]);
                                    this.e = parseFloat(values[4]); this.f = parseFloat(values[5]);
                                }
                            } else if (Array.isArray(init) && init.length >= 6) {
                                this.a = init[0]; this.b = init[1]; this.c = init[2];
                                this.d = init[3]; this.e = init[4]; this.f = init[5];
                            }
                        }
                    }
                    multiply(other) { return new DOMMatrix(); }
                    translate(x, y) { return new DOMMatrix(); }
                    scale(sx, sy) { return new DOMMatrix(); }
                    rotate(angle) { return new DOMMatrix(); }
                    transformPoint(point) { return { x: point.x, y: point.y }; }
                };
            }

            // Polyfill para URL.createObjectURL si no existe
            if (typeof global.URL === 'undefined' || !global.URL.createObjectURL) {
                global.URL = global.URL || {};
                global.URL.createObjectURL = () => 'blob:mock-url';
                global.URL.revokeObjectURL = () => {};
            }

            const { default: pdfjsLib } = await import('pdfjs-dist');
            
            // Configurar worker para entorno de servidor usando CDN
            pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.js`;

            const loadingTask = pdfjsLib.getDocument({ data: req.file.buffer });
            const pdfDoc = await loadingTask.promise;

            if (pdfDoc.numPages === 0) {
                return res.status(404).send('No pages found in the PDF.');
            }

            const firstPage = await pdfDoc.getPage(1);
            const operatorList = await firstPage.getOperatorList();

            let largestImage = null;
            let maxArea = 0;

            for (let i = 0; i < operatorList.fnArray.length; i++) {
                const fn = operatorList.fnArray[i];
                if (fn === pdfjsLib.OPS.paintImageXObject) {
                    const imgKey = operatorList.argsArray[i][0];
                    const img = await firstPage.objs.get(imgKey);

                    if (img && img.width && img.height) {
                        const area = img.width * img.height;
                        if (area > maxArea) {
                            maxArea = area;
                            largestImage = img;
                        }
                    }
                }
            }

            if (!largestImage) {
                return res.status(404).send('No image found in the PDF.');
            }

            imageBuffer = Buffer.from(largestImage.data);
            imageMimeType = 'image/jpeg'; // pdf.js doesn't always provide a mime type, so we default to jpeg
        } else {
            return res.status(415).send('Unsupported file type.');
        }

        if (!imageBuffer) {
            return res.status(500).send('Could not extract cover image.');
        }

        // --- Upload cover to Supabase Storage ---
        const coverFileName = `public/${bookId}.jpg`;
        const { data: uploadData, error: uploadError } = await supabase.storage
            .from('portadas')
            .upload(coverFileName, imageBuffer, {
                contentType: imageMimeType,
                upsert: true, // Overwrite if exists
            });

        if (uploadError) {
            throw uploadError;
        }

        // --- Get public URL and update book table ---
        const { data: urlData } = supabase.storage
            .from('portadas')
            .getPublicUrl(coverFileName);

        if (!urlData.publicUrl) {
            throw new Error('Could not get public URL for the cover.');
        }

        const { error: updateError } = await supabase
            .from('books')
            .update({ url_portada: urlData.publicUrl })
            .eq('id', bookId);

        if (updateError) {
            throw updateError;
        }

        res.status(200).json({ message: 'Cover extracted and updated successfully.', coverUrl: urlData.publicUrl });

    } catch (error) {
        console.error('Error processing file:', error);
        res.status(500).json({ error: error.message });
    } finally {
        // --- Clean up temporary file ---
        if (tempFilePath) {
            try {
                await fs.unlink(tempFilePath);
            } catch (cleanupError) {
                console.error('Error cleaning up temporary file:', cleanupError);
            }
        }
    }
});

// Export the app for Vercel
module.exports = app;