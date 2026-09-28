import { scanCaptureText, SCAN_LIMITS } from '../src/scan.mjs';
import { PRESETS } from './samples.mjs';

const byId = id => document.getElementById(id);
const input = byId('capture-input');
const fileInput = byId('capture-file');
const runButton = byId('run-button');
const downloadButton = byId('download-button');
const presets = [...document.querySelectorAll('input[name="preset"]')];
const utf8 = new TextEncoder();
let generation = 0;
let currentReport = null;

function showInputState(message, tone = 'neutral') {
  byId('input-state').textContent = message;
  byId('input-state').dataset.tone = tone;
}

function updateSize() {
  const size = input.value.length > SCAN_LIMITS.inputBytes ? SCAN_LIMITS.inputBytes + 1 : utf8.encode(input.value).length;
  byId('input-size').textContent = size > SCAN_LIMITS.inputBytes ? 'Over the 1 MiB limit' : `${size.toLocaleString('en-US')} bytes`;
}

function setSummary(tag, tone, heading, description) {
  byId('result-tag').textContent = tag;
  byId('result-tag').dataset.tone = tone;
  byId('result-heading').textContent = heading;
  byId('result-description').textContent = description;
}

function invalidate(message) {
  generation += 1;
  currentReport = null;
  downloadButton.disabled = true;
  runButton.disabled = false;
  byId('findings-body').replaceChildren();
  byId('findings-area').hidden = true;
  byId('empty-findings').hidden = true;
  byId('coverage-reasons').replaceChildren();
  byId('coverage-reasons').hidden = true;
  byId('coverage-value').textContent = 'Not evaluated';
  setSummary('Ready', 'neutral', 'See where test values appear.', 'Run the analysis for the current input. Findings from an earlier input are cleared.');
  showInputState(message);
}

function loadPreset(name) {
  invalidate('Synthetic example ready. Run the analysis to inspect it.');
  input.value = PRESETS[name].text;
  fileInput.value = '';
  for (const radio of presets) radio.checked = radio.value === name;
  byId('preset-description').textContent = PRESETS[name].description;
  updateSize();
}

const reasonText = {
  missing_required_surface: 'A required capture surface is missing.',
  declared_incomplete: 'At least one capture is declared incomplete.',
  capture_overflow: 'A capture exceeds 128 KiB. Only its retained prefix was inspected.',
};

function renderReport(report) {
  const count = report.findings.length;
  const found = `${count} ${count === 1 ? 'finding' : 'findings'}`;
  const states = {
    findings: ['Findings', 'finding', `${found} in supplied captures.`, 'Registered test values appeared in the supported representations below. Their contents are omitted from this result.'],
    no_findings: ['No findings', 'clear', 'No registered canary findings.', 'No full registered values appeared in the supported representations within the supplied, caller-declared complete captures. Unobserved data remains unknown.'],
    incomplete: ['Incomplete', 'incomplete', `Incomplete capture. ${found} retained.`, 'The supplied evidence is incomplete. Findings already observed still count; missing or discarded data cannot be treated as clear.'],
    invalid: ['Invalid input', 'error', 'This input could not be analyzed.', 'Use valid UTF-8 JSON in the capture format, within the 1 MiB input limit. Check the allowed fields, surfaces, and required properties.'],
  };
  setSummary(...states[report.status]);
  byId('coverage-value').textContent = report.coverage.status === 'declared_complete' ? 'Caller-declared complete' : 'Incomplete';
  for (const reason of report.coverage.reasons) {
    if (!reasonText[reason]) continue;
    const item = document.createElement('li');
    item.textContent = reasonText[reason];
    byId('coverage-reasons').append(item);
  }
  byId('coverage-reasons').hidden = byId('coverage-reasons').childElementCount === 0;
  for (const finding of report.findings) {
    const row = document.createElement('tr');
    for (const key of ['field', 'surface', 'encoding']) {
      const cell = document.createElement('td');
      cell.textContent = finding[key];
      row.append(cell);
    }
    byId('findings-body').append(row);
  }
  byId('findings-caption').textContent = `${found} · values redacted`;
  byId('findings-area').hidden = count === 0;
  if (!count && report.status !== 'invalid') {
    byId('empty-findings').textContent = report.status === 'incomplete' ? 'No findings in the available text. Coverage is still incomplete.' : 'No matches in supplied captures.';
    byId('empty-findings').hidden = false;
  }
  currentReport = report;
  downloadButton.disabled = false;
  showInputState(report.status === 'invalid' ? 'Input rejected. No captured values appear in the report.' : 'Current input analyzed locally. No capture data was sent.', report.status === 'invalid' ? 'error' : 'neutral');
}

for (const radio of presets) radio.addEventListener('change', () => loadPreset(radio.value));
input.addEventListener('input', () => {
  invalidate('Input changed. Run again to produce a current result.');
  for (const radio of presets) radio.checked = false;
  byId('preset-description').textContent = 'Custom capture. Register synthetic test values and supply the text your harness observed.';
  updateSize();
});
byId('reset-button').addEventListener('click', () => loadPreset('leaky'));
byId('import-button').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  fileInput.value = '';
  if (!file) return;
  invalidate('Reading local file…');
  const selectedGeneration = generation;
  runButton.disabled = true;
  input.value = '';
  updateSize();
  for (const radio of presets) radio.checked = false;
  byId('preset-description').textContent = 'Local capture import. Review the JSON, then run the analysis.';
  try {
    if (file.size > SCAN_LIMITS.inputBytes) throw new Error('invalid_capture_file');
    const bytes = await file.arrayBuffer();
    if (selectedGeneration !== generation) return;
    if (bytes.byteLength > SCAN_LIMITS.inputBytes) throw new Error('invalid_capture_file');
    input.value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    updateSize();
    showInputState('Local file loaded. Run the analysis to validate and inspect it.');
  } catch {
    if (selectedGeneration !== generation) return;
    showInputState('File not loaded. Choose UTF-8 JSON within the 1 MiB limit.', 'error');
    setSummary('Import error', 'error', 'The local file could not be read.', 'No analysis was produced. Choose UTF-8 JSON within the 1 MiB limit, or start with a synthetic example.');
  } finally {
    if (selectedGeneration === generation) runButton.disabled = false;
  }
});
runButton.addEventListener('click', () => {
  invalidate('Analyzing current input…');
  renderReport(scanCaptureText(input.value));
});
downloadButton.addEventListener('click', () => {
  if (!currentReport) return;
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(currentReport, null, 2)}\n`], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'shieldcheck-scan-report.json';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

loadPreset('leaky');
setSummary('Ready', 'neutral', 'See where test values appear.', 'Run the leaky example to find its memo and receipt in process output and telemetry.');
