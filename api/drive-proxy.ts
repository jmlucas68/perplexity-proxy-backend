import type { VercelRequest, VercelResponse } from '@vercel/node';

function extractDriveId(inputUrl: string | null): string | null {
  if (!inputUrl) return null;
  const p = inputUrl.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (p?.[1]) return p[1];
  const d = inputUrl.match(/\/file\/d\/([a-zA-Z0-9_-]+)\//);
  return d?.[1] || null;
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

  const downloadUrl = `https://drive.google.com/uc?export=download&id=${driveId}`;
  const range = req.headers.range;

  const upstream = await fetch(downloadUrl, {
    redirect: 'follow',
    headers: range ? { Range: range } : undefined,
  });

  const contentType = upstream.headers.get('content-type') || '';
  if (!upstream.ok && upstream.status !== 206) {
    return res.status(502).send(`Upstream error: ${upstream.status}`);
  }

  // If Google returns an HTML page, try to extract the real download link.
  if (contentType.includes('text/html')) {
    const html = await upstream.text();
    const actionMatch = html.match(/<form id="download-form" [^>]*action="([^"\]+)"/);

    if (!actionMatch || !actionMatch[1]) {
      // DEBUG: Return the HTML to see why parsing failed.
      res.setHeader('Content-Type', 'text/plain');
      return res.status(502).send(html);
    }
    
    let finalUrl = actionMatch[1].replace(/&amp;/g, '&');

    const secondUpstream = await fetch(finalUrl, {
      redirect: 'follow',
      headers: range ? { Range: range } : undefined,
    });

    if (!secondUpstream.ok && secondUpstream.status !== 206) {
      return res.status(502).send(`Upstream error on second request: ${secondUpstream.status}`);
    }
    
    const finalContentType = secondUpstream.headers.get('content-type') || 'application/epub+zip';
    const finalContentRange = secondUpstream.headers.get('content-range');
    const finalAb = await secondUpstream.arrayBuffer();

    if (finalContentRange) res.setHeader('Content-Range', finalContentRange);
    res.setHeader('Content-Type', finalContentType);
    
    const finalStatus = finalContentRange ? 206 : 200;
    return res.status(finalStatus).send(Buffer.from(finalAb));
  }

  // If it's not HTML, proceed as normal
  const ab = await upstream.arrayBuffer();

  const contentRange = upstream.headers.get('content-range');
  if (contentRange) res.setHeader('Content-Range', contentRange);

  res.setHeader('Content-Type', contentType || 'application/epub+zip');

  const status = contentRange ? 206 : 200;
  return res.status(status).send(Buffer.from(ab));
}