import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

// Initialize Supabase client
const supabase = createClient(supabaseUrl as string, supabaseAnonKey as string);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method === 'GET') {
    const { book_id } = req.query;

    if (!book_id) {
      return res.status(400).json({ error: 'Book ID is required' });
    }

    const { data, error } = await supabase
      .from('annotations')
      .select('id, cfi_range, highlighted_text, color, note_content')
      .eq('book_id', book_id);

    if (error) {
      console.error('Supabase GET error:', error);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json(data);
  }

  if (req.method === 'POST') {
    const { book_id, cfi_range, highlighted_text, color, note_content } = req.body;

    if (!book_id || !cfi_range) {
      return res.status(400).json({ error: 'Book ID and CFI range are required' });
    }

    const { data, error } = await supabase
      .from('annotations')
      .insert([
        {
          book_id,
          cfi_range,
          highlighted_text,
          color: color || 'yellow',
          note_content,
        },
      ])
      .select(); // Return the inserted data

    if (error) {
      console.error('Supabase POST error:', error);
      return res.status(500).json({ error: error.message });
    }

    return res.status(201).json(data[0]);
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
}
