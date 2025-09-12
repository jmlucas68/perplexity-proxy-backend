
const express = require('express');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const { EPub } = require('epub-parser');
const { PDFDocument } = require('pdf-lib');
const { createCanvas, loadImage } = require('canvas');
const stream = require('stream');

// Initialize Express app
const app = express();

// Supabase configuration - Use environment variables in Vercel
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY; // Use the service role key for admin tasks
const supabase = createClient(supabaseUrl, supabaseKey);

// Multer configuration for in-memory file storage
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Helper to convert stream to buffer
function streamToBuffer(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
    });
}

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

    try {
        // --- Process EPUB ---
        if (req.file.mimetype === 'application/epub+zip') {
            const epub = new EPub(req.file.buffer);
            await epub.parse();

            const coverImage = epub.getCoverImage();
            if (coverImage) {
                imageBuffer = coverImage.data;
                imageMimeType = coverImage.mediaType;
            } else {
                return res.status(404).send('No cover image found in EPUB metadata.');
            }
        }
        // --- Process PDF ---
        else if (req.file.mimetype === 'application/pdf') {
            const pdfDoc = await PDFDocument.load(req.file.buffer);
            const firstPage = pdfDoc.getPages()[0];
            
            // This part is tricky as pdf-lib doesn't render pages.
            // We will try to find the first large image on the first page as a proxy for the cover.
            // This is a heuristic and might not always work.
            const imageObjects = await firstPage.getImages();
            if (imageObjects.length > 0) {
                // Assume the first image is the cover
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
    }
});

// Export the app for Vercel
module.exports = app;
