const leaky = {
  schema: 'shieldcheck-capture/v1',
  canaries: [
    { field: 'memo', value: 'synthetic memo /+' },
    { field: 'receipt', value: 'synthetic receipt /+' },
  ],
  requiredSurfaces: ['stdout', 'stderr', 'telemetry_url', 'telemetry_body'],
  captures: [
    { surface: 'stdout', text: 'memo=synthetic memo /+', complete: true },
    { surface: 'stderr', text: '', complete: true },
    { surface: 'telemetry_url', text: '/collect?memo=synthetic%20memo%20%2F%2B', complete: true },
    { surface: 'telemetry_body', text: '{"receipt":"synthetic receipt /+","payload":"c3ludGhldGljIHJlY2VpcHQgLys="}', complete: true },
  ],
};
const corrected = structuredClone(leaky);
corrected.captures = corrected.captures.map(({ surface }) => ({ surface, text: surface === 'stdout' ? 'checkout completed' : '', complete: true }));
const incomplete = structuredClone(leaky);
incomplete.captures = incomplete.captures.filter(capture => capture.surface !== 'telemetry_body');
incomplete.captures[0].complete = false;

export const PRESETS = Object.freeze({
  leaky: Object.freeze({ text: JSON.stringify(leaky, null, 2), description: 'Memo and receipt values appear in process output and telemetry. All required surfaces are supplied.' }),
  corrected: Object.freeze({ text: JSON.stringify(corrected, null, 2), description: 'The same registered test values are absent from the supplied captures. All required surfaces are supplied.' }),
  incomplete: Object.freeze({ text: JSON.stringify(incomplete, null, 2), description: 'Telemetry body is missing and process output is declared incomplete. The observed memo findings still count.' }),
});
