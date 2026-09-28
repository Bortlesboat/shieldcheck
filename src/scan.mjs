import { findDisclosures } from './disclosures.mjs';

export const CAPTURE_FIELDS = Object.freeze(['memo', 'receipt', 'ock', 'recipient', 'capability']);
export const CAPTURE_SURFACES = Object.freeze(['stdout', 'stderr', 'telemetry_url', 'telemetry_body']);
export const SCAN_LIMITS = Object.freeze({ inputBytes: 1048576, captureBytes: 131072, canaryBytes: 4096, canaries: 5, captures: 4 });
const utf8 = new TextEncoder();
const fail = () => { throw new Error('invalid_capture_input'); };

function record(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length) fail();
  const result = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
    result[key] = descriptor.value;
  }
  return result;
}

function list(value, minimum, maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < minimum || value.length > maximum) fail();
  if (Reflect.ownKeys(value).length !== value.length + 1) fail();
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
    return descriptor.value;
  });
}

function bytes(value, maximum) {
  if (typeof value !== 'string' || value.length > maximum || !value.isWellFormed()) fail();
  const encoded = utf8.encode(value);
  if (encoded.length > maximum) fail();
  return encoded;
}

function uniqueAllowed(values, allowed) {
  if (values.some(value => !allowed.includes(value)) || new Set(values).size !== values.length) fail();
}

function report(status, findings, coverage) {
  return { schema: 'shieldcheck-scan-report/v1', status, provenance: 'unverified', nativeSettlement: 'not_evaluated', findings, coverage };
}

function invalidReport() {
  return { ...report('invalid', [], { status: 'incomplete', reasons: ['invalid_input'], requiredSurfaces: [], suppliedSurfaces: [] }), error: 'invalid_capture_input' };
}

export function scanCaptures(document) {
  try {
    const input = record(document, ['schema', 'canaries', 'requiredSurfaces', 'captures']);
    if (input.schema !== 'shieldcheck-capture/v1') fail();
    const canaries = list(input.canaries, 1, SCAN_LIMITS.canaries).map(value => record(value, ['field', 'value']));
    uniqueAllowed(canaries.map(canary => canary.field), CAPTURE_FIELDS);
    for (const canary of canaries) if (!bytes(canary.value, SCAN_LIMITS.canaryBytes).length) fail();
    const required = list(input.requiredSurfaces, 1, CAPTURE_SURFACES.length);
    uniqueAllowed(required, CAPTURE_SURFACES);
    const captures = list(input.captures, 0, SCAN_LIMITS.captures).map(value => record(value, ['surface', 'text', 'complete']));
    uniqueAllowed(captures.map(capture => capture.surface), CAPTURE_SURFACES);
    for (const capture of captures) {
      if (typeof capture.complete !== 'boolean') fail();
      bytes(capture.text, SCAN_LIMITS.inputBytes);
    }
    // Serialize only reconstructed data properties, never a caller's toJSON.
    bytes(JSON.stringify({ schema: input.schema, canaries, requiredSurfaces: required, captures }), SCAN_LIMITS.inputBytes);
    const requiredSurfaces = CAPTURE_SURFACES.filter(surface => required.includes(surface));
    const suppliedSurfaces = CAPTURE_SURFACES.filter(surface => captures.some(capture => capture.surface === surface));
    const reasons = [];
    if (requiredSurfaces.some(surface => !suppliedSurfaces.includes(surface))) reasons.push('missing_required_surface');
    if (captures.some(capture => !capture.complete)) reasons.push('declared_incomplete');
    const orderedCanaries = CAPTURE_FIELDS.flatMap(field => canaries.filter(canary => canary.field === field).map(canary => ({ name: field, value: canary.value })));
    const findings = [];
    let overflow = false;
    for (const surface of suppliedSurfaces) {
      const capture = captures.find(item => item.surface === surface);
      const encoded = utf8.encode(capture.text);
      let text = capture.text;
      if (encoded.length > SCAN_LIMITS.captureBytes) {
        overflow = true;
        // Streaming decode omits a split trailing code point; it must not
        // invent a replacement-character canary at the truncation boundary.
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(encoded.subarray(0, SCAN_LIMITS.captureBytes), { stream: true });
      }
      findings.push(...findDisclosures(text, surface, orderedCanaries));
    }
    if (overflow) reasons.push('capture_overflow');
    return report(reasons.length ? 'incomplete' : findings.length ? 'findings' : 'no_findings', findings, {
      status: reasons.length ? 'incomplete' : 'declared_complete', reasons, requiredSurfaces, suppliedSurfaces,
    });
  } catch { return invalidReport(); }
}

export function scanCaptureText(text) {
  try {
    bytes(text, SCAN_LIMITS.inputBytes);
    return scanCaptures(JSON.parse(text));
  } catch { return invalidReport(); }
}
