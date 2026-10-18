export const config = {
  runtime: 'edge',
};

export default async function handler(req) {
  const { searchParams, origin } = new URL(req.url);
  
  // Get the raw url param, decode it if necessary
  let target = searchParams.get('url');
  
  if (!target) {
    return new Response(JSON.stringify({ error: 'Missing ?url= parameter' }), { 
      status: 400, headers: { 'Content-Type': 'application/json' } 
    });
  }

  // Ensure the target URL is valid
  let parsed;
  try {
    parsed = new URL(target);
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid URL format. Make sure to encode it.' }), { 
      status: 400, headers: { 'Content-Type': 'application/json' } 
    });
  }

  // IPTV Xtream servers block Vercel. We must spoof a player User-Agent.
  // Common working UAs: 'VLC/3.0.18 LibVLC/3.0.18', 'TiviMate/4.7.0', 'IPTVSmarters'
  const headers = {
    'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20', 
    'Accept': '*/*',
    'Connection': 'keep-alive',
  };

  // Forward Range header for .ts segment seeking
  const range = req.headers.get('range');
  if (range) headers['Range'] = range;

  let upstream;
  try {
    upstream = await fetch(target, {
      method: req.method, // Support GET and HEAD
      headers,
      redirect: 'follow',
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Upstream fetch failed', detail: err.message }), { 
      status: 502, headers: { 'Content-Type': 'application/json' } 
    });
  }

  // If the upstream returns an error (like 403 from Xtream block), pass it through
  if (!upstream.ok && upstream.status !== 206) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('content-type') || 'text/plain',
        'Access-Control-Allow-Origin': '*',
      }
    });
  }

  const contentType = upstream.headers.get('content-type') || '';
  const isM3U8 = target.includes('.m3u8') || contentType.includes('mpegurl') || contentType.includes('vnd.apple');

  const responseHeaders = new Headers();
  for (const [k, v] of upstream.headers) {
    const lower = k.toLowerCase();
    if (['content-encoding', 'transfer-encoding', 'connection', 'content-length'].includes(lower)) continue;
    responseHeaders.set(k, v);
  }
  
  // CORS headers so web players work
  responseHeaders.set('Access-Control-Allow-Origin', '*');
  responseHeaders.set('Access-Control-Allow-Headers', '*');
  responseHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: responseHeaders });
  }

  if (isM3U8) {
    const text = await upstream.text();
    // Use the proxy base URL to rewrite nested URLs
    const proxyBase = `${origin}/api/proxy?url=`;
    const rewritten = rewriteM3U8(text, target, proxyBase);
    return new Response(rewritten, {
      status: upstream.status,
      headers: responseHeaders,
    });
  }

  // Stream segments
  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

function rewriteM3U8(content, baseUrl, proxyBase) {
  const base = new URL(baseUrl);
  const wrap = (abs) => `${proxyBase}${encodeURIComponent(abs)}`;

  return content
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();

      // Handle URI="..." (keys, media)
      if (trimmed.includes('URI="')) {
        return line.replace(/URI="([^"]+)"/g, (_m, uri) => {
          try {
            // If it's an absolute URL, use it. If relative, resolve against base.
            const abs = uri.startsWith('http') ? uri : new URL(uri, base).href;
            return `URI="${wrap(abs)}"`;
          } catch {
            return _m;
          }
        });
      }

      if (trimmed === '' || trimmed.startsWith('#')) return line;

      // Handle segment URLs
      try {
        const abs = trimmed.startsWith('http') ? trimmed : new URL(trimmed, base).href;
        return wrap(abs);
      } catch {
        return line;
      }
    })
    .join('\n');
}
