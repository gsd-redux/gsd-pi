// Project/App: gsd-pi
// File Purpose: Binary frame encode/decode for terminal I/O over WebSocket relay (D-04-09).
// Frame layout: [1 byte: channel length][N bytes: channel UTF-8][remaining: payload]

/**
 * Size of the header-length prefix in bytes.
 * The first byte of every binary frame stores the length of the channel name.
 */
export const HEADER_LENGTH_SIZE = 1;

/**
 * Encodes a binary frame with a channel header for relay multiplexing.
 *
 * Layout: [1 byte: channel-name length][N bytes: channel UTF-8][remaining: payload]
 *
 * @throws If channel name exceeds 255 bytes when UTF-8 encoded.
 */
export function encodeBinaryFrame(channel: string, data: Buffer): Buffer {
  const channelBuf = Buffer.from(channel, "utf8");
  if (channelBuf.length > 255) {
    throw new Error(`Channel name exceeds 255 bytes: ${channelBuf.length}`);
  }
  const frame = Buffer.allocUnsafe(HEADER_LENGTH_SIZE + channelBuf.length + data.length);
  frame[0] = channelBuf.length;
  channelBuf.copy(frame, HEADER_LENGTH_SIZE);
  data.copy(frame, HEADER_LENGTH_SIZE + channelBuf.length);
  return frame;
}

/**
 * Decodes a binary frame, extracting the channel name and payload.
 *
 * @returns The channel name and remaining payload data.
 */
export function decodeBinaryFrame(frame: Buffer): { channel: string; data: Buffer } {
  if (frame.length < HEADER_LENGTH_SIZE) {
    throw new Error(`Binary frame too short: ${frame.length} byte(s), need at least ${HEADER_LENGTH_SIZE}`);
  }
  const headerLen = frame[0]!;
  if (frame.length < HEADER_LENGTH_SIZE + headerLen) {
    throw new Error(
      `Binary frame truncated: channel length ${headerLen} but only ${frame.length - HEADER_LENGTH_SIZE} channel byte(s) available`,
    );
  }
  const channel = frame.subarray(HEADER_LENGTH_SIZE, HEADER_LENGTH_SIZE + headerLen).toString("utf8");
  const data = frame.subarray(HEADER_LENGTH_SIZE + headerLen);
  return { channel, data };
}
