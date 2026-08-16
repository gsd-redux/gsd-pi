// Project/App: gsd-pi
// File Purpose: Unit tests for hasBrowserRequiredText heading-depth section guard.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { hasBrowserRequiredText } from '../browser-evidence.ts';

describe('hasBrowserRequiredText', () => {
  test('detects browser requirement in a plain test-cases section', () => {
    const text = [
      '## Test Cases',
      '',
      '1. Open index.html in a browser and navigate to /dashboard.',
      '',
    ].join('\n');
    assert.ok(hasBrowserRequiredText(text), 'plain browser step should be detected');
  });

  test('ignores browser mention under a top-level non-requirement heading', () => {
    const text = [
      '## Not Proven',
      '',
      '- Keyboard usability through a real browser.',
      '- Browser console cleanliness.',
      '',
    ].join('\n');
    assert.ok(!hasBrowserRequiredText(text), 'browser mention under "Not Proven" should be ignored');
  });

  test('sub-heading inside a non-requirement section does not re-enable detection', () => {
    // BUG (pre-fix): ### sub-heading under ## Not Proven resets inNonRequirementSection
    // to false, causing subsequent lines to be detected as browser requirements.
    const text = [
      '## Not Proven By This UAT',
      '',
      '- No live browser session was used.',
      '',
      '### Visual Checks',
      '',
      '- Browser visual polish deferred to next slice.',
      '- Keyboard interaction in a real browser is not proven here.',
      '',
    ].join('\n');
    assert.ok(
      !hasBrowserRequiredText(text),
      'sub-heading under a non-requirement section must not re-enable browser detection',
    );
  });

  test('requirement-level heading after non-requirement section re-enables detection', () => {
    const text = [
      '## Not Proven',
      '',
      '- Browser polish deferred.',
      '',
      '## Test Cases',
      '',
      '1. Launch browser and open localhost.',
      '',
    ].join('\n');
    assert.ok(
      hasBrowserRequiredText(text),
      'browser step under "Test Cases" (same depth as "Not Proven") must still be detected',
    );
  });

  test('deferred sub-heading inside a requirement section scopes exclusion to its own block', () => {
    const text = [
      '## Test Cases',
      '',
      '1. Open browser at localhost.',
      '',
      '### Deferred: keyboard check',
      '',
      '- Keyboard UAT deferred to next slice.',
      '',
      '### Step 2: Verify DOM',
      '',
      '1. Navigate to /dashboard in the browser.',
      '',
    ].join('\n');
    assert.ok(
      hasBrowserRequiredText(text),
      'browser step under "Step 2" sub-heading must be detected after a sibling "Deferred" sub-heading',
    );
  });

  test('deferred sub-heading at same depth as test cases does not escape to parent', () => {
    const text = [
      '## Test Cases',
      '',
      '### Deferred: responsive layout',
      '',
      '- Responsive layout check is deferred to S02.',
      '',
    ].join('\n');
    assert.ok(
      !hasBrowserRequiredText(text),
      'content under a "Deferred" sub-heading should be excluded from detection',
    );
  });

  test('detects browser requirement written only in a heading', () => {
    // Regression: the line-by-line scan previously skip-continued past headings,
    // missing browser obligations expressed only in heading text.
    const text = '## Open browser session at localhost\n';
    assert.ok(hasBrowserRequiredText(text), 'browser requirement in heading text must be detected');
  });

  test('heading that opens a non-requirement section is not itself detected as a requirement', () => {
    const text = '## Not Proven\n\n- Some note.\n';
    assert.ok(
      !hasBrowserRequiredText(text),
      'a non-requirement section heading should not trigger browser detection',
    );
  });

  test('returns false for empty text', () => {
    assert.ok(!hasBrowserRequiredText(''), 'empty string returns false');
  });

  test('notes-for-tester heading with sub-headings stays non-requirement', () => {
    const text = [
      '## Notes for Tester',
      '',
      '### Browser Setup',
      '',
      '- Run this spec without a browser; a DOM harness is sufficient.',
      '- Browser-based visual checks are deferred.',
      '',
      '### Follow-up Items',
      '',
      '- Track browser session evidence in S02.',
      '',
    ].join('\n');
    assert.ok(
      !hasBrowserRequiredText(text),
      'sub-headings under "Notes for Tester" should not re-enable browser detection',
    );
  });
});

describe('hasBrowserRequiredText — negated browser mentions', () => {
  // Acceptance run 7: a slice that writes two text files declared
  // "UAT mode: artifact-driven" and explained why. complete-slice rejected it with
  // "UAT requires browser verification". The rationale line read
  // "...no runtime behavior, server, UI, or browser interaction is involved" — the
  // negator sits several list items away from "browser", so the adjacency-based
  // negation guard missed it and `browser interaction` matched as a requirement.
  test('a negated list mentioning browser is not a browser requirement', () => {
    const text = [
      '## UAT Type',
      '',
      '- UAT mode: artifact-driven',
      '- Why this mode is sufficient: slice deliverables are static text files with exact',
      '  required content; no runtime behavior, server, UI, or browser interaction is involved.',
    ].join('\n');
    assert.ok(!hasBrowserRequiredText(text), 'negated browser mention must not escalate');
  });

  test('adjacent negations still pass', () => {
    assert.ok(!hasBrowserRequiredText('- No browser interaction is required.'));
    assert.ok(!hasBrowserRequiredText('- Verified without a browser session.'));
  });

  test('a real requirement in a later clause still counts', () => {
    // The negation guard is clause-bounded, so it must not swallow the sentence after it.
    const text = [
      '## Test Cases',
      '',
      '1. No seeded data is needed. Open the page at localhost:3000 and screenshot it.',
    ].join('\n');
    assert.ok(hasBrowserRequiredText(text), 'a genuine browser step must still be detected');
  });
});
