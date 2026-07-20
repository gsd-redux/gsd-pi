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

const CONTEXT: CloudFsContext = { deviceId: "device-abc", projectAlias: "alpha" };

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

  test("readdir issues a GET with op, device, project, and path query params", async () => {
    const calls: FetchCall[] = [];
    const entries = await cloudFsReaddir(CONTEXT, "src/lib", okFetch({ entries: [{ name: "a.ts", type: "file" }] }, calls));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.method, "GET");
    const url = new URL(calls[0].url);
    assert.equal(url.origin, "http://gateway-internal:9100");
    assert.equal(url.pathname, "/internal/fs");
    assert.equal(url.searchParams.get("deviceId"), "device-abc");
    assert.equal(url.searchParams.get("projectAlias"), "alpha");
    assert.equal(url.searchParams.get("op"), "readdir");
    assert.equal(url.searchParams.get("path"), "src/lib");
    assert.deepEqual(entries, [{ name: "a.ts", type: "file" }]);
  });

  test("requests carry the internal token as a Bearer header", async () => {
    const calls: FetchCall[] = [];
    await cloudFsStat(CONTEXT, "", okFetch({ size: 0, isDirectory: true, isFile: false }, calls));

    const headers = new Headers(calls[0].init.headers);
    assert.equal(headers.get("authorization"), "Bearer internal-token-123");
  });

  test("readdir returns an empty list when entries is missing", async () => {
    const calls: FetchCall[] = [];
    const entries = await cloudFsReaddir(CONTEXT, "", okFetch({}, calls));
    assert.deepEqual(entries, []);
  });

  test("read returns the content string", async () => {
    const calls: FetchCall[] = [];
    const content = await cloudFsReadFile(CONTEXT, "README.md", okFetch({ content: "hello\n" }, calls));

    assert.equal(content, "hello\n");
    const url = new URL(calls[0].url);
    assert.equal(url.searchParams.get("op"), "read");
    assert.equal(url.searchParams.get("path"), "README.md");
  });

  test("read throws when the response is missing content", async () => {
    const calls: FetchCall[] = [];
    await assert.rejects(
      () => cloudFsReadFile(CONTEXT, "README.md", okFetch({}, calls)),
      /missing content/,
    );
  });

  test("stat returns the parsed stat payload", async () => {
    const calls: FetchCall[] = [];
    const stat = await cloudFsStat(CONTEXT, "package.json", okFetch({ size: 512, isDirectory: false, isFile: true }, calls));

    assert.deepEqual(stat, { size: 512, isDirectory: false, isFile: true });
    const url = new URL(calls[0].url);
    assert.equal(url.searchParams.get("op"), "stat");
  });

  test("write issues a POST with a JSON body", async () => {
    const calls: FetchCall[] = [];
    await cloudFsWriteFile(CONTEXT, "notes/todo.md", "# todo\n", okFetch({ success: true }, calls));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.method, "POST");
    const url = new URL(calls[0].url);
    assert.equal(url.pathname, "/internal/fs");
    assert.equal(url.search, "");
    const headers = new Headers(calls[0].init.headers);
    assert.equal(headers.get("authorization"), "Bearer internal-token-123");
    assert.equal(headers.get("content-type"), "application/json");
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
      deviceId: "device-abc",
      projectAlias: "alpha",
      op: "write",
      path: "notes/todo.md",
      content: "# todo\n",
    });
  });

  test("non-2xx responses throw with the HTTP status attached", async () => {
    const calls: FetchCall[] = [];
    const error = await cloudFsReadFile(CONTEXT, "nope.txt", fakeFetch(404, {}, calls)).then(
      () => null,
      (err: Error & { status?: number }) => err,
    );

    assert.ok(error);
    assert.equal(error.status, 404);
    assert.match(error.message, /HTTP 404/);
  });

  test("error body message is preferred over the HTTP status", async () => {
    const calls: FetchCall[] = [];
    const error = await cloudFsWriteFile(CONTEXT, "x", "y", fakeFetch(403, { error: "viewer role cannot write" }, calls)).then(
      () => null,
      (err: Error & { status?: number }) => err,
    );

    assert.ok(error);
    assert.equal(error.status, 403);
    assert.equal(error.message, "viewer role cannot write");
  });

  test("unparseable error bodies fall back to the HTTP status message", async () => {
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
      () => cloudFsReaddir(CONTEXT, "", okFetch({ entries: [] }, calls)),
      /GATEWAY_INTERNAL_TOKEN/,
    );
    assert.equal(calls.length, 0);
  });

  describe("buildCloudFsTree", () => {
    /** Fake fetch driven by a map of path → entries (missing path → 404). */
    function treeFetch(dirs: Record<string, Array<{ name: string; type: "file" | "directory" }>>): typeof fetch {
      return (async (url: string | URL | Request) => {
        const path = new URL(String(url)).searchParams.get("path") ?? "";
        const entries = dirs[path];
        if (!entries) {
          return new Response(JSON.stringify({ error: "not found" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ entries }), {
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

    test("propagates non-404 errors", async () => {
      const failing = (async () => new Response(JSON.stringify({ error: "boom" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
      await assert.rejects(() => buildCloudFsTree(CONTEXT, "", {}, failing), /boom/);
    });
  });
});
