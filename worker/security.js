// Request checks shared by the routes (pure: node --test imports this file).

/** A browser's Origin must be this site (or a local dev server). No Origin: not a browser, nothing to protect. */
export function originOk(request, url, env = {}) {
  const o = request.headers.get('Origin');
  if (!o) return true;
  if (o === url.origin) return true;
  try {
    const u = new URL(o);
    if ((u.hostname === 'localhost' || u.hostname === '127.0.0.1') && (u.protocol === 'http:' || u.protocol === 'https:')) return true;
  } catch { return false; }
  return String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean).includes(o);
}

/** The JSON body of a request, at most `max` characters; null if it is too big or not a JSON object. */
export async function readBody(request, max) {
  const len = +request.headers.get('content-length');
  if (len > max) return null;
  const text = await request.text();
  if (text.length > max) return null;
  if (!text.trim()) return {};
  try {
    const b = JSON.parse(text);
    return b && typeof b === 'object' && !Array.isArray(b) ? b : null;
  } catch { return null; }
}
