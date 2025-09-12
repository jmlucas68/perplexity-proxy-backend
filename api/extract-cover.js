const express = require('express');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const EPub = require('epub'); // Replaced epub-parser with epub
const { PDFDocument } = require('pdf-lib');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

// Initialize Express app
const app = express();

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
            const pdfDoc = await PDFDocument.load(req.file.buffer);
            const firstPage = pdfDoc.getPages()[0];
            
            const imageObjects = await firstPage.getImages();
            if (imageObjects.length > 0) {
                const image = imageObjects[0];
                const imageBytes = await image.embed();
                imageBuffer = imageBytes.buffer;
                imageMimeType = imageBytes.mimeType || 'image/jpeg';
            } else {
                 return res.status(404).send('No image found on the first page of the PDF.');
            }
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