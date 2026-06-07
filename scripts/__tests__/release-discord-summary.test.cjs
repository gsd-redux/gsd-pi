'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const {
  buildDiscordReleasePayload,
  cleanBullet,
  collectSections,
  extractInstallCommand,
} = require('../release-discord-summary.cjs');

const sampleRelease = {
  tagName: 'v1.3.0',
  name: 'v1.3.0',
  isPrerelease: false,
  url: 'https://github.com/open-gsd/gsd-pi/releases/tag/v1.3.0',
  body: [
    '## Install',
    '',
    '```bash',
    'npm i @opengsd/gsd-pi@1.3.0',
    '```',
    '',
    '### Added',
    '- feat(cli): add release smoke check by @trek-e in https://github.com/open-gsd/gsd-pi/pull/10',
    '- feat(web): add dashboard export by @trek-e in https://github.com/open-gsd/gsd-pi/pull/11',
    '- feat(agent): add planner mode by @trek-e in https://github.com/open-gsd/gsd-pi/pull/12',
    '- feat(native): add signed binary probe by @trek-e in https://github.com/open-gsd/gsd-pi/pull/13',
    '- feat(hooks): add release hook by @trek-e in https://github.com/open-gsd/gsd-pi/pull/14',
    '',
    '### Fixed',
    '- fix(release): keep [#8](https://github.com/open-gsd/gsd-pi/issues/8) visible by @trek-e in https://github.com/open-gsd/gsd-pi/pull/15',
    '',
    '**Full Changelog**: https://github.com/open-gsd/gsd-pi/compare/v1.2.0...v1.3.0',
  ].join('\n'),
};

describe('release Discord summary', () => {
  test('builds a payload with a preserved full changelog URL', () => {
    const payload = buildDiscordReleasePayload({
      release: {
        ...sampleRelease,
        html_url: sampleRelease.url,
        url: 'https://api.github.com/repos/open-gsd/gsd-pi/releases/123',
      },
      packageName: '@opengsd/gsd-pi',
      maxContent: 1850,
    });

    assert.equal(payload.username, 'GSD Releases');
    assert.match(payload.content, /\*\*@opengsd\/gsd-pi v1\.3\.0 is out\*\*/);
    assert.match(payload.content, /`npm i @opengsd\/gsd-pi@1\.3\.0`/);
    assert.match(payload.content, /Full changelog: https:\/\/github\.com\/open-gsd\/gsd-pi\/releases\/tag\/v1\.3\.0/);
    assert.doesNotMatch(payload.content, /\*\*Full Changelog\*\*:\s*$/m);
    assert.match(payload.content, /add release smoke check \(#10\)/);
    assert.match(payload.content, /\.\.\.and 1 more added/);
    assert.equal(payload.embeds[0].fields[1].value, '`latest`');
    assert.ok(payload.content.length <= 1850);
  });

  test('summarizes auto-generated What Changed bullets', () => {
    const sections = collectSections([
      '## What\'s Changed',
      '* feat: add thing by @trek-e in https://github.com/open-gsd/gsd-pi/pull/20',
      '* fix: repair thing by @trek-e in https://github.com/open-gsd/gsd-pi/pull/21',
      '* docs: explain thing by @trek-e in https://github.com/open-gsd/gsd-pi/pull/22',
    ].join('\n'));

    assert.deepEqual(sections.get('Added'), ['add thing (#20)']);
    assert.deepEqual(sections.get('Fixed'), ['repair thing (#21)']);
    assert.deepEqual(sections.get('Changed'), ['explain thing (#22)']);
  });

  test('cleans common GitHub release-note link noise without deleting issue references', () => {
    assert.equal(
      cleanBullet('* fix: repair [#8](https://github.com/open-gsd/gsd-pi/issues/8) by @trek-e in https://github.com/open-gsd/gsd-pi/pull/15'),
      'repair #8 (#15)'
    );
    assert.equal(
      cleanBullet('- **issue**: [Bug]: Auto-mode re-dispatch loop'),
      'Auto-mode re-dispatch loop'
    );
  });

  test('falls back to the release channel when no install block exists', () => {
    assert.equal(
      extractInstallCommand('', '@opengsd/gsd-pi', { tagName: 'v1.4.0-rc.1', isPrerelease: true }),
      'npm i @opengsd/gsd-pi@next'
    );
    assert.equal(
      extractInstallCommand('', '@opengsd/gsd-pi', { tagName: 'v1.4.0', isPrerelease: false }),
      'npm i @opengsd/gsd-pi@latest'
    );
  });
});
