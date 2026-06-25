export const config = { 
  runtime: "edge" 
};

// ==========================================
// CONFIGURATION: ADD YOUR ALLOWED WEBSITES HERE
// ==========================================
const ALLOWED_ORIGINS = [
  "https://kaizokutv.me",
  "https://another-website.com",
  "https://kaizoku.rf.gd" // Remember: No trailing slash (/) at the end
];

const UPSTREAM_HEADERS = {
  Referer: "https://executeandship.com/",
  Origin: "https://executeandship.com",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0",
  Accept: "*/*",
};

function resolveUrl(base, relative) {
  if (/^https?:\/\//i.test(relative)) return relative;
  
  const baseUrlObj = new URL(base);
  const baseDir = baseUrlObj.pathname.endsWith("/") 
    ? baseUrlObj.pathname 
    : baseUrlObj.pathname.replace(/\/[^/]*$/, "/");
  
  const resolvedUrl = new URL(relative, baseUrlObj.origin + baseDir);
  
  if (!resolvedUrl.search && baseUrlObj.search) {
    resolvedUrl.search = baseUrlObj.search;
  }
  
  return resolvedUrl.href;
}

function proxyUrl(proxyOrigin, target) {
  return `${proxyOrigin}/api/hls?url=${encodeURIComponent(target)}`;
}

function rewriteManifest(text, sourceUrl, proxyOrigin) {
  const urlObj = new URL(sourceUrl);
  const base = urlObj.origin + (urlObj.pathname.endsWith("/") ? urlObj.pathname : urlObj.pathname.replace(/\/[^/]*$/, "/")) + urlObj.search;

  let out = text.replace(/URI="([^"]+)"/gi, (_m, uri) => {
    const resolved = resolveUrl(base, uri);
    return `URI="${proxyUrl(proxyOrigin, resolved)}"`;
  });

  out = out.replace(/URI='([^']+)'/gi, (_m, uri) => {
    const resolved = resolveUrl(base, uri);
    return `URI='${proxyUrl(proxyOrigin, resolved)}'`;
  });

  return out
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trimEnd();
      if (!trimmed || trimmed.startsWith("#")) return trimmed;
      return proxyUrl(proxyOrigin, resolveUrl(base, trimmed));
    })
    .join("\n");
}

function isManifestUrl(url) {
  try {
    const path = new URL(url).pathname;
    return /\.m3u8?/i.test(path);
  } catch {
    return /\.m3u8?(\?|$)/i.test(url);
  }
}

export default async function handler(request) {
  const requestOrigin = request.headers.get("origin");
  const requestReferer = request.headers.get("referer");

  // SECURITY CHECK: Match incoming traffic against your list of allowed sites
  const isAllowedOrigin = ALLOWED_ORIGINS.includes(requestOrigin);
  const isAllowedReferer = ALLOWED_ORIGINS.some(domain => requestReferer && requestReferer.startsWith(domain));

  if (!isAllowedOrigin && !isAllowedReferer) {
    return new Response("Forbidden: Access Denied", { 
      status: 403, 
      headers: { "Content-Type": "text/plain" } 
    });
  }

  // Handle CORS Preflight Options Request
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(requestOrigin),
    });
  }

  const reqUrl = new URL(request.url);
  let target = reqUrl.searchParams.get("url");
  
  if (reqUrl.search.includes("?url=")) {
    const rawTarget = reqUrl.search.split("?url=")[1];
    if (rawTarget) target = decodeURIComponent(rawTarget);
  }

  if (!target) {
    return new Response("Missing url", { status: 400, headers: corsHeaders(requestOrigin) });
  }

  let finalTarget = target;
  try {
    const targetUrlObj = new URL(target);
    if (target.includes("|")) {
      finalTarget = target.split("|")[0];
    }
  } catch (e) {}

  const upstreamHeaders = { ...UPSTREAM_HEADERS };
  const range = request.headers.get("range");
  if (range) upstreamHeaders.Range = range;

  let upstream;
  try {
    upstream = await fetch(finalTarget, {
      headers: upstreamHeaders,
      redirect: "follow",
    });
  } catch (err) {
    return new Response(`Proxy fetch failed: ${err.message}`, {
      status: 502,
      headers: corsHeaders(requestOrigin),
    });
  }

  if (!upstream.ok) {
    return new Response(`Upstream returned status ${upstream.status}`, {
      status: upstream.status,
      headers: corsHeaders(requestOrigin),
    });
  }

  const proxyOrigin = reqUrl.origin;

  if (isManifestUrl(finalTarget)) {
    const text = await upstream.text();
    if (text.trim().startsWith("#EXTM3U")) {
      return new Response(rewriteManifest(text, finalTarget, proxyOrigin), {
        status: 200,
        headers: {
          ...corsHeaders(requestOrigin),
          "Content-Type": "application/vnd.apple.mpegurl",
          "Cache-Control": "no-store",
        },
      });
    }
  }

  const headers = {
    ...corsHeaders(requestOrigin),
    "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
    "Cache-Control": "no-store",
  };

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}

// MODIFIED: Dynamically checks and returns the correct header based on the valid incoming origin
function corsHeaders(requestOrigin) {
  const originToAllow = ALLOWED_ORIGINS.includes(requestOrigin) ? requestOrigin : ALLOWED_ORIGINS[0];

  return {
    "Access-Control-Allow-Origin": originToAllow,
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Content-Type",
  };
}
