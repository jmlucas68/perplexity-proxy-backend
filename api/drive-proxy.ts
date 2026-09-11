import type { VercelRequest, VercelResponse } from '@vercel/node';
import { google } from 'googleapis';

function extractDriveId(inputUrl: string | null): string | null {
  if (!inputUrl) return null;
  const p = inputUrl.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (p?.[1]) return p[1];
  const d = inputUrl.match(/\/file\/d\/([a-zA-Z0-9_-]+)\//);
  return d?.[1] || null;
}

function serviceDriveClient() {
  // Misma cuenta de servicio que utiliza Bóveda Web en este backend.
  const raw = process.env.GOOGLE_DRIVE_CREDENTIALS;
  if (!raw) throw new Error('Missing Google Drive service-account credentials');
  const json = raw.startsWith('base64:')
    ? Buffer.from(raw.slice('base64:'.length), 'base64').toString('utf8')
    : raw;
  const credentials = JSON.parse(json);
  if (typeof credentials.private_key === 'string') credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
  if (!credentials.client_email || !credentials.private_key) throw new Error('Invalid Google Drive service-account credentials');
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  return google.drive({ version: 'v3', auth });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Set CORS headers for all responses
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'GET') {
    return res.status(405).end('Method Not Allowed');
  }

  const id = (req.query.id as string) || null;
  const url = (req.query.url as string) || null;
  const driveId = id || extractDriveId(url);
  if (!driveId) return res.status(400).send('Missing Google Drive file id or url');

  try {
    const drive = serviceDriveClient();
    const metadata = await drive.files.get({
      fileId: driveId,
      fields: 'name,mimeType',
      supportsAllDrives: true,
    });
    const file = await drive.files.get(
      { fileId: driveId, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' },
    );
    const contentType = metadata.data.mimeType || 'application/octet-stream';
    const fileName = (metadata.data.name || 'download').replace(/["\r\n]/g, '_');
    const inline = String(req.query.inline || '') === '1' && contentType.startsWith('image/');

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${fileName}"`);
    return res.status(200).send(Buffer.from(file.data as ArrayBuffer));
  } catch (error: any) {
    console.error('Drive proxy error:', error?.message || error);
    const status = error?.code === 404 ? 404 : error?.code === 401 || error?.code === 403 ? 403 : 502;
    return res.status(status).send('Google Drive file is not available to the library service account.');
  }
}
