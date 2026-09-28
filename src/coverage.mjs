import { findDisclosures } from './disclosures.mjs';

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
    return findDisclosures(this.text(), this.surface, canaries);
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
