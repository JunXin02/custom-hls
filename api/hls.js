export const config = { 
  runtime: "edge" // Restricts your function execution to Mumbai (crucial for SonyLIV)
};

const UPSTREAM_HEADERS = {
  Referer: "https://www.livetvpro.site/",
  Origin: "https://www.livetvpro.site",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0",
  Accept: "*/*",
};

// MODIFIED: Preserves existing query strings from the master file if chunks don't have them
function resolveUrl(base, relative) {
  if (/^https?:\/\//i.test(relative)) return relative;
  
  const baseUrlObj = new URL(base);
  const baseDir = baseUrlObj.pathname.endsWith("/") 
    ? baseUrlObj.pathname 
    : baseUrlObj.pathname.replace(/\/[^/]*$/, "/");
  
  // Resolve the relative path against the base origin and directory
  const resolvedUrl = new URL(relative, baseUrlObj.origin + baseDir);
  
  // If the relative segment doesn't have its own queries, pass down the parent's queries
  if (!resolvedUrl.search && baseUrlObj.search) {
    resolvedUrl.search = baseUrlObj.search;
  }
  
  return resolvedUrl.href;
}

function proxyUrl(proxyOrigin, target) {
  return `${proxyOrigin}/api/hls?url=${encodeURIComponent(target)}`;
}

function rewriteManifest(text, sourceUrl, proxyOrigin) {
  // Modified to handle stripping queries safely for base calculation
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
  // Extract path to strip query params before matching regex extension
  try {
    const path = new URL(url).pathname;
    return /\.m3u8?/i.test(path);
  } catch {
    return /\.m3u8?(\?|$)/i.test(url);
  }
}

export default async function handler(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }

  const reqUrl = new URL(request.url);
  
  // CRITICAL FIX: Capture the ENTIRE rest of the query string target
  // searchParams.get('url') might cut off if the stream link itself has unencoded '&' signs
  let target = reqUrl.searchParams.get("url");
  
  // Fallback: if the link was passed raw and contains multiple unencoded ampersands
  if (reqUrl.search.includes("?url=")) {
    const rawTarget = reqUrl.search.split("?url=")[1];
    if (rawTarget) target = decodeURIComponent(rawTarget);
  }

  if (!target) {
    return new Response("Missing url", { status: 400, headers: corsHeaders() });
  }

  // Parse custom queries directly out of the target URL to forward them natively if needed
  let finalTarget = target;
  try {
    const targetUrlObj = new URL(target);
    // If the link uses syntax like link|User-Agent=..., parse out the actual URL
    if (target.includes("|")) {
      finalTarget = target.split("|")[0];
    }
  } catch (e) {
    // Keep fallback target
  }

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
      headers: corsHeaders(),
    });
  }

  if (!upstream.ok) {
    return new Response(`Upstream returned status ${upstream.status}`, {
      status: upstream.status,
      headers: corsHeaders(),
    });
  }

  const proxyOrigin = reqUrl.origin;

  if (isManifestUrl(finalTarget)) {
    const text = await upstream.text();
    if (text.trim().startsWith("#EXTM3U")) {
      return new Response(rewriteManifest(text, finalTarget, proxyOrigin), {
        status: 200,
        headers: {
          ...corsHeaders(),
          "Content-Type": "application/vnd.apple.mpegurl",
          "Cache-Control": "no-store",
        },
      });
    }
  }

  const headers = {
    ...corsHeaders(),
    "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
    "Cache-Control": "no-store",
  };

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Content-Type",
  };
}
