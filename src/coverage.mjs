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
    const findings = [];
    for (const { name, value } of canaries) {
      if (!value) continue;
      const patterns = new Map([
        ['raw', value], ['uri', encodeURIComponent(value)], ['base64', Buffer.from(value).toString('base64')],
      ]);
      const seen = new Set();
      for (const [encoding, pattern] of patterns) {
        if (!seen.has(pattern) && captured.includes(pattern)) findings.push({ surface: this.surface, field: name, encoding });
        seen.add(pattern);
      }
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
