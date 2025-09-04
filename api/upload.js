const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const stream = require('stream');
const cors = require('cors');

const app = express();
const upload = multer();

app.use(cors());

// Configure Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

app.post('/api/upload', upload.single('ebook'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, error: 'No file uploaded.' });
    }

    const uploadStream = cloudinary.uploader.upload_stream(
        { resource_type: 'raw' },
        (error, result) => {
            if (error) {
                console.error('Error uploading to Cloudinary:', error);
                return res.status(500).json({ success: false, error: 'Error uploading to Cloudinary.', details: error.message });
            }
            res.status(200).json({ success: true, url: result.secure_url });
        }
    );

    const bufferStream = new stream.PassThrough();
    bufferStream.end(req.file.buffer);
    bufferStream.pipe(uploadStream);
});

module.exports = app;
