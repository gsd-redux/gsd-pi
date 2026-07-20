import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCloudFsTree,
  cloudFsReadFile,
  cloudFsReaddir,
  cloudFsStat,
  cloudFsWriteFile,
  type CloudFsContext,
} from "../cloud-fs.ts";

const CONTEXT: CloudFsContext = { owner: "user-owner-1", deviceId: "device-abc", projectAlias: "alpha" };

const ENV_KEYS = ["GSD_CLOUD_MODE", "GATEWAY_INTERNAL_URL", "GATEWAY_INTERNAL_TOKEN", "APP_BRIDGE_SECRET"] as const;

type FetchCall = { url: string; init: RequestInit };

function fakeFetch(status: number, body: unknown, calls: FetchCall[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function okFetch(body: unknown, calls: FetchCall[]): typeof fetch {
  return fakeFetch(200, body, calls);
}

/** Parse the /internal/fs request envelope from a recorded fetch call. */
function requestEnvelope(call: FetchCall): {
  userId: string;
  runtimeId: string;
  projectAlias: string;
  message: Record<string, unknown>;
} {
  return JSON.parse(String(call.init.body));
}

describe("cloud-fs", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.GSD_CLOUD_MODE = "1";
    process.env.GATEWAY_INTERNAL_URL = "http://gateway-internal:9100";
    process.env.GATEWAY_INTERNAL_TOKEN = "internal-token-123";
    process.env.APP_BRIDGE_SECRET = "app-bridge-secret";
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  test("readdir posts the fs.readdir envelope to /internal/fs and unwraps result", async () => {
    const calls: FetchCall[] = [];
    const entries = await cloudFsReaddir(
      CONTEXT,
      "src/lib",
      okFetch(
        { result: { type: "fs.readdir.result", requestId: "r1", entries: [{ name: "a.ts", type: "file", size: 3, mtime: 10, hidden: false }] } },
        calls,
      ),
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.method, "POST");
    const url = new URL(calls[0].url);
    assert.equal(url.origin, "http://gateway-internal:9100");
    assert.equal(url.pathname, "/internal/fs");
    assert.equal(url.search, "");

    const envelope = requestEnvelope(calls[0]);
    assert.equal(envelope.userId, "user-owner-1");
    assert.equal(envelope.runtimeId, "device-abc");
    assert.equal(envelope.projectAlias, "alpha");
    assert.equal(envelope.message.channel, "fs");
    assert.equal(envelope.message.type, "fs.readdir");
    assert.equal(envelope.message.path, "src/lib");
    assert.equal(envelope.message.showHidden, false);
    assert.equal(typeof envelope.message.requestId, "string");
    assert.ok((envelope.message.requestId as string).length > 0);
    assert.deepEqual(entries, [{ name: "a.ts", type: "file" }]);
  });

  test("requests carry the internal token as a Bearer header", async () => {
    const calls: FetchCall[] = [];
    await cloudFsStat(CONTEXT, "", okFetch({ result: { type: "fs.stat.result", exists: true, fileType: "directory", size: 0, mtime: 0 } }, calls));

    const headers = new Headers(calls[0].init.headers);
    assert.equal(headers.get("authorization"), "Bearer internal-token-123");
    assert.equal(headers.get("content-type"), "application/json");
  });

  test("readdir returns an empty list when entries is missing", async () => {
    const calls: FetchCall[] = [];
    const entries = await cloudFsReaddir(CONTEXT, "", okFetch({ result: { type: "fs.readdir.result" } }, calls));
    assert.deepEqual(entries, []);
  });

  test("readdir renders symlinks as files", async () => {
    const calls: FetchCall[] = [];
    const entries = await cloudFsReaddir(
      CONTEXT,
      "",
      okFetch(
        {
          result: {
            type: "fs.readdir.result",
            entries: [
              { name: "real.txt", type: "file", size: 1, mtime: 2, hidden: false },
              { name: "linked", type: "symlink", size: 0, mtime: 2, hidden: false, symlinkTarget: "/etc", symlinkOutsideRoot: true },
              { name: "sub", type: "directory", size: 0, mtime: 2, hidden: false },
            ],
          },
        },
        calls,
      ),
    );

    assert.deepEqual(entries, [
      { name: "real.txt", type: "file" },
      { name: "linked", type: "file" },
      { name: "sub", type: "directory" },
    ]);
  });

  test("read returns content with the mtime from the wire", async () => {
    const calls: FetchCall[] = [];
    const read = await cloudFsReadFile(
      CONTEXT,
      "README.md",
      okFetch({ result: { type: "fs.read.result", content: "hello\n", mtime: 1234, size: 6, language: "markdown" } }, calls),
    );

    assert.deepEqual(read, { content: "hello\n", mtime: 1234 });
    const envelope = requestEnvelope(calls[0]);
    assert.equal(envelope.message.type, "fs.read");
    assert.equal(envelope.message.path, "README.md");
  });

  test("read tolerates a missing mtime", async () => {
    const calls: FetchCall[] = [];
    const read = await cloudFsReadFile(CONTEXT, "README.md", okFetch({ result: { type: "fs.read.result", content: "x" } }, calls));
    assert.deepEqual(read, { content: "x", mtime: null });
  });

  test("read throws when the response is missing content", async () => {
    const calls: FetchCall[] = [];
    await assert.rejects(
      () => cloudFsReadFile(CONTEXT, "README.md", okFetch({ result: { type: "fs.read.result" } }, calls)),
      /missing content/,
    );
  });

  test("stat maps fileType to isDirectory/isFile", async () => {
    const calls: FetchCall[] = [];
    const dir = await cloudFsStat(CONTEXT, "src", okFetch({ result: { type: "fs.stat.result", exists: true, fileType: "directory", size: 0, mtime: 10 } }, calls));
    assert.deepEqual(dir, { size: 0, isDirectory: true, isFile: false });

    const file = await cloudFsStat(CONTEXT, "a.ts", okFetch({ result: { type: "fs.stat.result", exists: true, fileType: "file", size: 12, mtime: 10 } }, calls));
    assert.deepEqual(file, { size: 12, isDirectory: false, isFile: true });

    const link = await cloudFsStat(CONTEXT, "ln", okFetch({ result: { type: "fs.stat.result", exists: true, fileType: "symlink", size: 5, mtime: 10 } }, calls));
    assert.deepEqual(link, { size: 5, isDirectory: false, isFile: false });

    const envelope = requestEnvelope(calls[0]);
    assert.equal(envelope.message.type, "fs.stat");
  });

  test("stat throws a 404 error when exists is false", async () => {
    const calls: FetchCall[] = [];
    const error = await cloudFsStat(
      CONTEXT,
      "nope",
      okFetch({ result: { type: "fs.stat.result", exists: false, fileType: null, size: null, mtime: null } }, calls),
    ).then(
      () => null,
      (err: Error & { status?: number }) => err,
    );

    assert.ok(error);
    assert.equal(error.status, 404);
  });

  test("write posts fs.write with content and expectedMtime, returning the result", async () => {
    const calls: FetchCall[] = [];
    const result = await cloudFsWriteFile(
      CONTEXT,
      "notes/todo.md",
      "# todo\n",
      111,
      okFetch({ result: { type: "fs.write.result", success: true, conflict: false, currentContent: null, currentMtime: null } }, calls),
    );

    assert.deepEqual(result, { success: true, conflict: false, currentContent: null, currentMtime: null });
    const envelope = requestEnvelope(calls[0]);
    assert.equal(envelope.message.type, "fs.write");
    assert.equal(envelope.message.path, "notes/todo.md");
    assert.equal(envelope.message.content, "# todo\n");
    assert.equal(envelope.message.expectedMtime, 111);
    assert.equal(envelope.message.expectedSize, null);
  });

  test("write defaults expectedMtime to null", async () => {
    const calls: FetchCall[] = [];
    await cloudFsWriteFile(
      CONTEXT,
      "new.md",
      "x",
      null,
      okFetch({ result: { type: "fs.write.result", success: true, conflict: false, currentContent: null, currentMtime: null } }, calls),
    );

    const envelope = requestEnvelope(calls[0]);
    assert.equal(envelope.message.expectedMtime, null);
  });

  test("write returns conflict details instead of throwing", async () => {
    const calls: FetchCall[] = [];
    const result = await cloudFsWriteFile(
      CONTEXT,
      "notes/todo.md",
      "# todo\n",
      111,
      okFetch({ result: { type: "fs.write.result", success: false, conflict: true, currentContent: "changed on disk", currentMtime: 222 } }, calls),
    );

    assert.deepEqual(result, { success: false, conflict: true, currentContent: "changed on disk", currentMtime: 222 });
  });

  test("fs.error for a missing file throws with status 404", async () => {
    const calls: FetchCall[] = [];
    const error = await cloudFsReadFile(
      CONTEXT,
      "nope.txt",
      okFetch({ result: { type: "fs.error", error: "ENOENT: no such file or directory, stat '/data/nope.txt'" } }, calls),
    ).then(
      () => null,
      (err: Error & { status?: number }) => err,
    );

    assert.ok(error);
    assert.equal(error.status, 404);
    assert.match(error.message, /ENOENT/);
  });

  test("fs.error for other daemon failures throws with status 500", async () => {
    const calls: FetchCall[] = [];
    const error = await cloudFsReadFile(
      CONTEXT,
      "blob.bin",
      okFetch({ result: { type: "fs.error", error: "Binary file cannot be displayed" } }, calls),
    ).then(
      () => null,
      (err: Error & { status?: number }) => err,
    );

    assert.ok(error);
    assert.equal(error.status, 500);
    assert.equal(error.message, "Binary file cannot be displayed");
  });

  test("a 200 response without a result field throws", async () => {
    const calls: FetchCall[] = [];
    await assert.rejects(() => cloudFsReaddir(CONTEXT, "", okFetch({}, calls)), /missing result/);
  });

  test("gateway 502 messages pass through with their status", async () => {
    const calls: FetchCall[] = [];
    const error = await cloudFsReadFile(CONTEXT, "x", fakeFetch(502, { error: "device offline" }, calls)).then(
      () => null,
      (err: Error & { status?: number }) => err,
    );

    assert.ok(error);
    assert.equal(error.status, 502);
    assert.equal(error.message, "device offline");
  });

  test("non-2xx responses without a body message fall back to the HTTP status", async () => {
    const calls: FetchCall[] = [];
    const badFetch = (async () => new Response("not json", { status: 500 })) as typeof fetch;
    const error = await cloudFsStat(CONTEXT, "", badFetch).then(
      () => null,
      (err: Error & { status?: number }) => err,
    );

    assert.ok(error);
    assert.equal(error.status, 500);
    assert.match(error.message, /HTTP 500/);
    assert.equal(calls.length, 0);
  });

  test("throws a clear error when cloud env vars are missing", async () => {
    delete process.env.GATEWAY_INTERNAL_TOKEN;
    const calls: FetchCall[] = [];
    await assert.rejects(
      () => cloudFsReaddir(CONTEXT, "", okFetch({ result: { entries: [] } }, calls)),
      /GATEWAY_INTERNAL_TOKEN/,
    );
    assert.equal(calls.length, 0);
  });

  describe("buildCloudFsTree", () => {
    /** Fake fetch driven by a map of path → entries (missing path → fs.error ENOENT). */
    function treeFetch(dirs: Record<string, Array<{ name: string; type: "file" | "directory" | "symlink" }>>): typeof fetch {
      return (async (_url: string | URL | Request, init?: RequestInit) => {
        const { message } = JSON.parse(String(init?.body)) as { message: { path: string } };
        const entries = dirs[message.path];
        if (!entries) {
          return new Response(
            JSON.stringify({ result: { type: "fs.error", error: `ENOENT: no such file or directory, scandir '${message.path}'` } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ result: { type: "fs.readdir.result", entries } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;
    }

    test("builds a nested tree, skipping dotfiles and sorting directories first", async () => {
      const tree = await buildCloudFsTree(CONTEXT, "", {}, treeFetch({
        "": [
          { name: "zeta.txt", type: "file" },
          { name: "src", type: "directory" },
          { name: ".hidden", type: "file" },
          { name: "alpha.md", type: "file" },
        ],
        src: [
          { name: "index.ts", type: "file" },
          { name: "lib", type: "directory" },
        ],
        "src/lib": [{ name: "util.ts", type: "file" }],
      }));

      assert.deepEqual(tree, [
        {
          name: "src",
          type: "directory",
          children: [
            {
              name: "lib",
              type: "directory",
              children: [{ name: "util.ts", type: "file" }],
            },
            { name: "index.ts", type: "file" },
          ],
        },
        { name: "alpha.md", type: "file" },
        { name: "zeta.txt", type: "file" },
      ]);
    });

    test("does not recurse into symlinked directories", async () => {
      const tree = await buildCloudFsTree(CONTEXT, "", {}, treeFetch({
        "": [
          { name: "linked-dir", type: "symlink" },
          { name: "real", type: "directory" },
        ],
        real: [{ name: "main.ts", type: "file" }],
      }));

      assert.deepEqual(tree, [
        { name: "real", type: "directory", children: [{ name: "main.ts", type: "file" }] },
        { name: "linked-dir", type: "file" },
      ]);
    });

    test("skips configured directory names at every level", async () => {
      const tree = await buildCloudFsTree(CONTEXT, "", { skipDirs: new Set(["node_modules"]) }, treeFetch({
        "": [
          { name: "node_modules", type: "directory" },
          { name: "app", type: "directory" },
        ],
        app: [
          { name: "node_modules", type: "directory" },
          { name: "main.ts", type: "file" },
        ],
      }));

      assert.deepEqual(tree, [
        { name: "app", type: "directory", children: [{ name: "main.ts", type: "file" }] },
      ]);
    });

    test("returns an empty tree when the root directory is missing", async () => {
      const tree = await buildCloudFsTree(CONTEXT, ".gsd", {}, treeFetch({}));
      assert.deepEqual(tree, []);
    });

    test("honors the depth cap", async () => {
      const dirs: Record<string, Array<{ name: string; type: "file" | "directory" }>> = {};
      let path = "";
      for (let i = 0; i < 10; i++) {
        dirs[path] = [{ name: `d${i}`, type: "directory" }, { name: `f${i}.txt`, type: "file" }];
        path = path ? `${path}/d${i}` : `d${i}`;
      }
      dirs[path] = [];

      const tree = await buildCloudFsTree(CONTEXT, "", { maxDepth: 3 }, treeFetch(dirs));

      let node = tree.find((n) => n.type === "directory");
      let depth = 1;
      while (node?.children?.some((n) => n.type === "directory")) {
        node = node.children.find((n) => n.type === "directory");
        depth++;
      }
      assert.equal(depth, 3);
      assert.deepEqual(node?.children, []);
    });

    test("propagates gateway-level errors", async () => {
      const failing = (async () => new Response(JSON.stringify({ error: "boom" }), {
        status: 502,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
      await assert.rejects(() => buildCloudFsTree(CONTEXT, "", {}, failing), /boom/);
    });

    test("propagates non-ENOENT daemon errors", async () => {
      const failing = (async (_url: string | URL | Request) => new Response(
        JSON.stringify({ result: { type: "fs.error", error: "permission denied" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
      await assert.rejects(() => buildCloudFsTree(CONTEXT, "", {}, failing), /permission denied/);
    });
  });
});
