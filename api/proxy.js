export const config = {
  runtime: 'edge', // fast, works great for streaming
};

const PROXY_PATH = '/api/proxy';

export default async function handler(req) {
  const { searchParams, origin } = new URL(req.url);
  const target = searchParams.get('url');

  if (!target) {
    return json({ error: 'Missing ?url= parameter' }, 400);
  }

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return json({ error: 'Invalid URL' }, 400);
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return json({ error: 'Only http/https allowed' }, 400);
  }

  // Optional host whitelist — remove to allow anything
  const ALLOWED_HOSTS = null; // e.g. ['example.com', 'cdn.example.com']
  if (ALLOWED_HOSTS && !ALLOWED_HOSTS.includes(parsed.hostname)) {
    return json({ error: 'Host not allowed' }, 403);
  }

  const headers = {
    'User-Agent':
      req.headers.get('user-agent') ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    Referer: parsed.origin + '/',
    Origin: parsed.origin,
    Accept: '*/*',
  };

  const range = req.headers.get('range');
  if (range) headers['Range'] = range;

  let upstream;
  try {
    upstream = await fetch(target, {
      method: 'GET',
      headers,
      redirect: 'follow',
    });
  } catch (err) {
    return json({ error: 'Upstream fetch failed', detail: err.message }, 502);
  }

  const contentType = upstream.headers.get('content-type') || '';
  const isM3U8 =
    target.includes('.m3u8') ||
    contentType.includes('mpegurl') ||
    contentType.includes('vnd.apple');

  const responseHeaders = new Headers();
  for (const [k, v] of upstream.headers) {
    const lower = k.toLowerCase();
    if (['content-encoding', 'transfer-encoding', 'connection', 'content-length'].includes(lower))
      continue;
    responseHeaders.set(k, v);
  }
  responseHeaders.set('Access-Control-Allow-Origin', '*');
  responseHeaders.set('Access-Control-Allow-Headers', '*');
  responseHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: responseHeaders });
  }

  if (isM3U8) {
    const text = await upstream.text();
    const rewritten = rewriteM3U8(text, target, origin + PROXY_PATH);
    return new Response(rewritten, {
      status: upstream.status,
      headers: responseHeaders,
    });
  }

  // Stream segments / keys / everything else
  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

function rewriteM3U8(content, baseUrl, proxyEndpoint) {
  const base = new URL(baseUrl);
  const wrap = (abs) => `${proxyEndpoint}?url=${encodeURIComponent(abs)}`;

  return content
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();

      if (trimmed.includes('URI="')) {
        return line.replace(/URI="([^"]+)"/g, (_m, uri) => {
          try {
            return `URI="${wrap(new URL(uri, base).href)}"`;
          } catch {
            return _m;
          }
        });
      }

      if (trimmed === '' || trimmed.startsWith('#')) return line;

      try {
        return wrap(new URL(trimmed, base).href);
      } catch {
        return line;
      }
    })
    .join('\n');
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
