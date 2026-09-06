import type { VercelRequest, VercelResponse } from '@vercel/node';
import { google } from 'googleapis';
import crypto from 'node:crypto';

const VAULT_ROOT_ID = '1moV9p3h2UNaZ0hu2CuPuED_NymsgRMfV';
const FOLDER = 'application/vnd.google-apps.folder';

function authorized(req: VercelRequest) {
  const expected = process.env.BOVEDA_PROXY_TOKEN;
  return expected && req.headers.authorization === `Bearer ${expected}`;
}

function sessionToken() {
  const expires = Date.now() + 12 * 60 * 60 * 1000;
  const payload = String(expires);
  const secret = process.env.BOVEDA_PROXY_TOKEN || 'boveda-session';
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${signature}`;
}

function validSession(req: VercelRequest) {
  const token = req.headers['x-boveda-session'];
  if (typeof token !== 'string') return false;
  const [expires, signature] = token.split('.');
  if (!expires || !signature || Number(expires) < Date.now()) return false;
  const secret = process.env.BOVEDA_PROXY_TOKEN || 'boveda-session';
  const expected = crypto.createHmac('sha256', secret).update(expires).digest('hex');
  return signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function driveClient() {
  const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.drive({ version: 'v3', auth });
}

function serviceDriveClient() {
  const raw = process.env.GOOGLE_DRIVE_CREDENTIALS;
  if (!raw) throw new Error('No service account configured');
  const credentials = JSON.parse(raw.startsWith('base64:') ? Buffer.from(raw.slice(7), 'base64').toString('utf8') : raw);
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
  return google.drive({ version: 'v3', auth });
}

async function children(drive: ReturnType<typeof driveClient>, folderId: string) {
  const files: any[] = [];
  let pageToken: string | undefined;
  do {
    const response = await drive.files.list({
      q: `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false`,
      fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,parents)',
      orderBy: 'folder,name_natural',
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    files.push(...(response.data.files || []));
    pageToken = response.data.nextPageToken || undefined;
  } while (pageToken);
  return files;
}

async function indexVault(drive: ReturnType<typeof driveClient>) {
  const queue = [VAULT_ROOT_ID];
  const files: any[] = [];
  while (queue.length) {
    const batch = await children(drive, queue.shift()!);
    files.push(...batch);
    queue.push(...batch.filter(file => file.mimeType === FOLDER).map(file => file.id!));
  }
  return files;
}

async function readText(drive: ReturnType<typeof driveClient>, id: string) {
  const file = await drive.files.get({ fileId: id, alt: 'media' }, { responseType: 'arraybuffer' });
  return Buffer.from(file.data as ArrayBuffer).toString('utf8');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (req.method !== 'GET' && !(req.method === 'POST' && req.query.action === 'login')) return res.status(405).end();
  try {
    if (req.method === 'POST' && req.query.action === 'login') {
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      if (!process.env.BOVEDA_WEB_PASSWORD || password !== process.env.BOVEDA_WEB_PASSWORD) return res.status(401).json({ success: false });
      return res.status(200).json({ success: true, session: sessionToken() });
    }
    const drive = serviceDriveClient();
    if (!validSession(req)) return res.status(401).json({ error: 'Login required' });
    if (req.query.action === 'index') {
      const files = await indexVault(drive);
      return res.status(200).json({ rootId: VAULT_ROOT_ID, files });
    }
    if (req.query.action === 'backlinks' && typeof req.query.id === 'string') {
      const files = await indexVault(drive);
      const target = files.find(file => file.id === req.query.id);
      if (!target) return res.status(404).json({ error: 'Note not found' });
      const targetName = target.name.replace(/\.(md|markdown)$/i, '').trim().toLocaleLowerCase();
      const notes = files.filter(file => /\.(md|markdown)$/i.test(file.name));
      const matches: any[] = [];
      const contents = await Promise.all(notes.map(async file => ({ file, text: await readText(drive, file.id) })));
      for (const { file, text } of contents) {
        const found = [...text.matchAll(/!?\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)].some(match => match[1].trim().replace(/\.md$/i, '').toLocaleLowerCase() === targetName);
        if (found && file.id !== target.id) matches.push(file);
      }
      return res.status(200).json({ files: matches });
    }
    if (req.query.action === 'content' && typeof req.query.id === 'string') {
      const metadata = await drive.files.get({ fileId: req.query.id, fields: 'mimeType' });
      const file = await drive.files.get({ fileId: req.query.id, alt: 'media' }, { responseType: 'arraybuffer' });
      res.setHeader('Content-Type', metadata.data.mimeType || 'application/octet-stream');
      return res.status(200).send(Buffer.from(file.data as ArrayBuffer));
    }
    return res.status(400).json({ error: 'Unknown request' });
  } catch (error) {
    console.error('Vault API error', error);
    return res.status(502).json({ error: 'Google Drive request failed' });
  }
}
