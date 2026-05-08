import test from "node:test";
import assert from "node:assert/strict";
import {
  _captureProjectRootEnvForTest,
  _restoreProjectRootEnvForTest,
} from "../auto.ts";

test.afterEach(() => {
  _restoreProjectRootEnvForTest();
});

test("auto-mode project-root env capture sets GSD_PROJECT_ROOT and restores an existing value", () => {
  process.env.GSD_PROJECT_ROOT = "/before";

  _captureProjectRootEnvForTest("/project");
  assert.equal(process.env.GSD_PROJECT_ROOT, "/project");

  _restoreProjectRootEnvForTest();
  assert.equal(process.env.GSD_PROJECT_ROOT, "/before");
  delete process.env.GSD_PROJECT_ROOT;
});

test("auto-mode project-root env restore deletes GSD_PROJECT_ROOT when it was initially absent", () => {
  delete process.env.GSD_PROJECT_ROOT;

  _captureProjectRootEnvForTest("/project");
  assert.equal(process.env.GSD_PROJECT_ROOT, "/project");

  _restoreProjectRootEnvForTest();
  assert.equal(process.env.GSD_PROJECT_ROOT, undefined);
});
