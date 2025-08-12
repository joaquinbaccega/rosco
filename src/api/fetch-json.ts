import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const raw = String(req.query.url || '');
    if (!raw) return res.status(400).json({ error: 'Falta ?url=' });

    // Seguridad básica: sólo http(s)
    if (!/^https?:\/\//i.test(raw)) {
      return res.status(400).json({ error: 'URL inválida (debe ser http/https)' });
    }

    const r = await fetch(raw, { cache: 'no-store' });
    if (!r.ok) return res.status(r.status).json({ error: `HTTP ${r.status}` });

    // Opcional: verificar content-type
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      // igual intentamos parsear por si es raw con el header mal puesto
      try {
        const text = await r.text();
        const data = JSON.parse(text);
        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.status(200).json(data);
      } catch {
        return res.status(415).json({ error: 'El recurso no es JSON' });
      }
    }

    const data = await r.json();
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json(data);
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'Error' });
  }
}
