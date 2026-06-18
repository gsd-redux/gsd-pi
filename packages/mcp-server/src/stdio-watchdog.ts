import { PassThrough, type Readable } from 'node:stream';

export interface ActivityTrackingInput {
  input: Readable;
  lastActivityAt(): number;
  close(): void;
}

export function createActivityTrackingInput(
  source: Readable,
  now: () => number = () => Date.now(),
): ActivityTrackingInput {
  const input = new PassThrough();
  let lastActivity = now();

  function onDrain(): void {
    source.resume();
  }

  function onData(chunk: Buffer | string): void {
    lastActivity = now();
    if (!input.write(chunk)) {
      source.pause();
    }
  }

  function onEnd(): void {
    input.end();
  }

  function onError(error: Error): void {
    input.destroy(error);
  }

  input.on('drain', onDrain);
  source.on('data', onData);
  source.on('end', onEnd);
  source.on('error', onError);

  return {
    input,
    lastActivityAt() {
      return lastActivity;
    },
    close() {
      input.off('drain', onDrain);
      source.off('data', onData);
      source.off('end', onEnd);
      source.off('error', onError);
      if (source.isPaused()) source.resume();
      input.destroy();
    },
  };
}
