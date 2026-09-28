function decodedBase64Tokens(captured) {
  const decoded = [];
  // Non-overlapping tokens and their decoded bytes are bounded by the capture.
  // Canonical re-encoding rejects truncated tokens and nonzero padding bits.
  for (const match of captured.matchAll(/[A-Za-z0-9+/]+={0,2}/g)) {
    const token = match[0];
    if (token.length % 4 !== 0 || captured[match.index + token.length] === '=') continue;
    const bytes = Buffer.from(token, 'base64');
    if (bytes.toString('base64') === token) decoded.push(bytes);
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

export class Capture {
  constructor(surface, limit = 131072) {
    this.surface = surface;
    this.limit = limit;
    this.bytes = 0;
    this.overflow = false;
    this.chunks = [];
  }

  append(value) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    this.bytes += chunk.length;
    if (this.bytes > this.limit) { this.overflow = true; return; }
    this.chunks.push(chunk);
  }

  text() { return Buffer.concat(this.chunks).toString('utf8'); }

  findings(canaries) {
    const captured = this.text();
    const decoded = decodedBase64Tokens(captured);
    const findings = [];
    for (const { name, value } of canaries) {
      if (!value) continue;
      if (captured.includes(value)) findings.push({ surface: this.surface, field: name, encoding: 'raw' });
      if ([...uriPatterns(value, this.surface)].some(pattern => captured.includes(pattern))) findings.push({ surface: this.surface, field: name, encoding: 'uri' });
      const bytes = Buffer.from(value);
      if (decoded.some(token => token.includes(bytes))) findings.push({ surface: this.surface, field: name, encoding: 'base64' });
    }
    return findings;
  }
}

export function evaluateCoverage(state, captures) {
  const reasons = [];
  if (!state.childReady) reasons.push('missing_child_ready');
  if (!state.childFinished) reasons.push('missing_child_completion');
  if (state.exitCode !== 0) reasons.push('child_failed');
  if (state.timedOut) reasons.push('timeout');
  if (state.observedRequests !== state.expectedRequests) reasons.push('missing_or_extra_telemetry');
  if (state.droppedRequests !== 0) reasons.push('dropped_telemetry');
  if (captures.some(capture => capture.overflow)) reasons.push('capture_overflow');
  return { status: reasons.length ? 'incomplete' : 'complete', reasons, observedRequests: state.observedRequests, expectedRequests: state.expectedRequests };
}
