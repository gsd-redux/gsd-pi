/**
 * remote-notification-from-desktop.test.ts
 *
 * Regression guard: sendDesktopNotification must fire sendRemoteNotification
 * as a fire-and-forget side-effect so that Telegram/Slack/Discord channels
 * receive the same events as native desktop notifications.
 *
 * Testing strategy (behavioral):
 *   Import sendDesktopNotification and the swappable remoteNotificationDispatcher.
 *   Mock the dispatcher's send method, call sendDesktopNotification, and assert
 *   that the dispatcher received the same title/message and that the call is
 *   fire-and-forget (the function returns without awaiting).
 *
 * Relates to #4341.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  sendDesktopNotification,
  remoteNotificationDispatcher,
} from "../notifications.js";

test("sendDesktopNotification calls sendRemoteNotification with title and message", async (t) => {
  const sendMock = t.mock.method(remoteNotificationDispatcher, "send", async () => {});

  sendDesktopNotification("Test Title", "Test Message");

  assert.equal(sendMock.mock.callCount(), 1);
  assert.deepEqual(sendMock.mock.calls[0].arguments, ["Test Title", "Test Message"]);
});

test("sendDesktopNotification does not await the remote notification", async (t) => {
  const sendMock = t.mock.method(remoteNotificationDispatcher, "send", async () => {});

  const result = sendDesktopNotification("Async Title", "Async Message");

  assert.equal(result, undefined, "sendDesktopNotification must return void");
  assert.equal(sendMock.mock.callCount(), 1);
});

test("sendDesktopNotification fires remote notification even when desktop notifications are disabled", async (t) => {
  const sendMock = t.mock.method(remoteNotificationDispatcher, "send", async () => {});

  sendDesktopNotification(
    "Remote Title",
    "Remote Message",
    "info",
    "complete",
    undefined,
    { notifications: { enabled: false } },
  );

  assert.equal(sendMock.mock.callCount(), 1);
  assert.deepEqual(sendMock.mock.calls[0].arguments, ["Remote Title", "Remote Message"]);
});
