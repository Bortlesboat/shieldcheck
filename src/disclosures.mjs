const utf8 = new TextEncoder();

function binaryString(bytes) {
  let result = '';
  for (let offset = 0; offset < bytes.length; offset += 4096) {
    result += String.fromCharCode(...bytes.subarray(offset, offset + 4096));
  }
  return result;
}

function decodedBase64Tokens(captured) {
  const decoded = [];
  // Non-overlapping tokens are bounded by the capture. Re-encoding rejects
  // truncated tokens and nonzero padding bits; decoding is single-layer only.
  for (const match of captured.matchAll(/[A-Za-z0-9+/]+={0,2}/g)) {
    const token = match[0];
    if (token.length % 4 !== 0 || captured[match.index + token.length] === '=') continue;
    const bytes = atob(token);
    if (btoa(bytes) === token) decoded.push(bytes);
  }
  return decoded;
}

function uriPatterns(value, surface) {
  const patterns = new Set([encodeURIComponent(value)]);
  if (surface === 'telemetry_url') {
    patterns.add(new URLSearchParams({ canary: value }).toString().slice('canary='.length));
    // A URL parser removes these characters. Never register that partial value.
    if (!/[\t\r\n]/.test(value)) {
      const url = new URL('http://127.0.0.1/');
      url.search = `?canary=${value}`;
      patterns.add(url.search.slice('?canary='.length));
    }
  }
  patterns.delete(value);
  return patterns;
}

// Native Capture owns its lifecycle. The supplied-capture API owns validation
// and bounds. This shared matcher performs only full-canary comparisons.
export function findDisclosures(captured, surface, canaries) {
  const decoded = decodedBase64Tokens(captured);
  const findings = [];
  for (const { name, value } of canaries) {
    if (!value) continue;
    if (captured.includes(value)) findings.push({ surface, field: name, encoding: 'raw' });
    if ([...uriPatterns(value, surface)].some(pattern => captured.includes(pattern))) findings.push({ surface, field: name, encoding: 'uri' });
    // Binary strings compare UTF-8 bytes exactly, including canaries embedded
    // in decoded envelopes, without a quadratic JavaScript byte-search loop.
    const bytes = binaryString(utf8.encode(value));
    if (decoded.some(token => token.includes(bytes))) findings.push({ surface, field: name, encoding: 'base64' });
  }
  return findings;
}
