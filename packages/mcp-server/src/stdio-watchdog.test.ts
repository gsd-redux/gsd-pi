import { once } from 'node:events';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { createActivityTrackingInput } from './stdio-watchdog.js';

describe('createActivityTrackingInput', () => {
  test('buffers stdin chunks for the transport while tracking activity', async () => {
    const source = new PassThrough();
    let now = 100;
    const tracked = createActivityTrackingInput(source, () => now);

    source.write('{"jsonrpc":"2.0","method":"initialize"}\n');
    now = 250;
    source.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    source.end();

    const received: Buffer[] = [];
    tracked.input.on('data', (chunk) => received.push(Buffer.from(chunk)));
    await once(tracked.input, 'end');

    assert.equal(
      Buffer.concat(received).toString('utf8'),
      '{"jsonrpc":"2.0","method":"initialize"}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n',
    );
    assert.equal(tracked.lastActivityAt(), 250);
    tracked.close();
  });

  test('pauses stdin while the transport buffer is backpressured, then resumes on drain', async () => {
    const source = new PassThrough();
    const tracked = createActivityTrackingInput(source);

    source.write(Buffer.alloc(1024 * 1024, 'x'));

    assert.equal(source.isPaused(), true);

    const drained = once(tracked.input, 'drain');
    tracked.input.resume();
    await drained;

    assert.equal(source.isPaused(), false);
    tracked.close();
  });
});
