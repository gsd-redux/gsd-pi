import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const ROOT = new URL("../../../../../", import.meta.url);

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('node:')) {
    return { url: specifier, format: 'builtin', shortCircuit: true };
  }

  // 1. Redirect all workspace package bare imports to source.
  //    CI portability runs don't build any packages/ dist artifacts, so every
  //    @gsd/* specifier (including transitive ones pulled in by pi-coding-agent
  //    source itself) must resolve to the TypeScript source entrypoint.
  if (specifier === "../../packages/pi-coding-agent/src/index.js") {
    specifier = new URL("packages/pi-coding-agent/src/index.ts", ROOT).href;
  } else if (specifier === "@gsd/pi-coding-agent" || specifier === "@earendil-works/pi-coding-agent") {
    specifier = new URL("packages/pi-coding-agent/src/index.ts", ROOT).href;
  } else if (specifier.startsWith("@gsd/pi-coding-agent/") || specifier.startsWith("@earendil-works/pi-coding-agent/")) {
    const subpath = specifier.replace(/^@[^/]+\/pi-coding-agent\//, "").replace(/\.js$/, ".ts");
    specifier = new URL(`packages/pi-coding-agent/src/${subpath}`, ROOT).href;
  } else if (specifier === "@earendil-works/pi-ai/oauth" || specifier === "@gsd/pi-ai/oauth") {
    specifier = new URL("packages/pi-ai/src/utils/oauth/index.ts", ROOT).href;
  } else if (
    specifier === "@earendil-works/pi-ai" ||
    specifier === "@gsd/pi-ai" ||
    specifier === "@earendil-works/pi-ai/dist/index.js" ||
    specifier === "@gsd/pi-ai/dist/index.js"
  ) {
    specifier = new URL("packages/pi-ai/src/index.ts", ROOT).href;
  } else if (specifier.startsWith("@earendil-works/pi-ai/") || specifier.startsWith("@gsd/pi-ai/")) {
    const subpath = specifier.replace(/^@[^/]+\/pi-ai\//, "").replace(/\.js$/, ".ts");
    specifier = new URL(`packages/pi-ai/src/${subpath}`, ROOT).href;
  } else if (specifier === "@earendil-works/pi-tui" || specifier === "@gsd/pi-tui") {
    specifier = new URL("packages/pi-tui/src/index.ts", ROOT).href;
  } else if (specifier.startsWith("@earendil-works/pi-tui/") || specifier.startsWith("@gsd/pi-tui/")) {
    const subpath = specifier.replace(/^@[^/]+\/pi-tui\//, "").replace(/\.js$/, ".ts");
    specifier = new URL(`packages/pi-tui/src/${subpath}`, ROOT).href;
  } else if (specifier === "@earendil-works/pi-agent-core" || specifier === "@gsd/pi-agent-core") {
    specifier = new URL("packages/pi-agent-core/src/index.ts", ROOT).href;
  } else if (specifier.startsWith("@earendil-works/pi-agent-core/") || specifier.startsWith("@gsd/pi-agent-core/")) {
    const subpath = specifier.replace(/^@[^/]+\/pi-agent-core\//, "").replace(/\.js$/, ".ts");
    specifier = new URL(`packages/pi-agent-core/src/${subpath}`, ROOT).href;
  } else if (specifier === "@gsd/native") {
    specifier = new URL("packages/native/src/index.ts", ROOT).href;
  } else if (specifier.startsWith("@gsd/native/")) {
    // Sub-path imports like @gsd/native/fd, @gsd/native/text, etc.
    const subpath = specifier.slice("@gsd/native/".length);
    specifier = new URL(`packages/native/src/${subpath}/index.ts`, ROOT).href;
  }
  // 2. Broken/partial dist artifacts (e.g. jiti CJS) may still import ./foo.ts — map to src/.
  else if (
    context.parentURL &&
    context.parentURL.includes('/packages/') &&
    context.parentURL.includes('/dist/') &&
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    (specifier.endsWith('.ts') || specifier.endsWith('.js'))
  ) {
    const srcParent = context.parentURL.replace(/\/dist\//, '/src/');
    const srcSpec = specifier.replace(/\.js$/, '.ts');
    specifier = new URL(srcSpec, srcParent).href;
  }
  // 3. Redirect packages/*/src/ relative .js → .ts for strip-types
  else if (specifier.endsWith('.js') && (specifier.startsWith('./') || specifier.startsWith('../'))) {
    if (
      context.parentURL &&
      context.parentURL.startsWith(ROOT.href) &&
      !context.parentURL.includes('/node_modules/') &&
      context.parentURL.includes('/src/')
    ) {
      if (specifier.includes('/dist/')) {
        specifier = specifier.replace('/dist/', '/src/').replace(/\.js$/, '.ts');
      } else {
        const candidate = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
        if (existsSync(fileURLToPath(candidate))) {
          specifier = candidate.href;
        }
      }
    }
  }
  // 4. Extensionless relative imports from web/ (Next.js convention).
  //    Transpiled .tsx files emit extensionless imports — try .ts then .tsx.
  else if (
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    !specifier.match(/\.\w+$/) &&
    context.parentURL &&
    context.parentURL.includes('/web/')
  ) {
    const baseUrl = new URL(specifier, context.parentURL);
    for (const ext of ['.ts', '.tsx']) {
      const candidate = fileURLToPath(baseUrl) + ext;
      if (existsSync(candidate)) {
        specifier = baseUrl.href + ext;
        break;
      }

    }
  }

  return nextResolve(specifier, context);
}

export function load(url, context, nextLoad) {
  if (url.startsWith('node:') || context.format === 'builtin') {
    return { format: 'builtin', source: '', shortCircuit: true };
  }

  // jiti/CJS may still enter through stale packages/*/dist/index.js — redirect to src.
  if (url.includes('/packages/pi-ai/dist/index.js')) {
    url = url.replace('/dist/index.js', '/src/index.ts');
  } else if (url.includes('/packages/pi-coding-agent/dist/index.js')) {
    url = url.replace('/dist/index.js', '/src/index.ts');
  } else if (url.includes('/packages/pi-agent-core/dist/index.js')) {
    url = url.replace('/dist/index.js', '/src/index.ts');
  } else if (url.includes('/packages/pi-tui/dist/index.js')) {
    url = url.replace('/dist/index.js', '/src/index.ts');
  }

  // Node's --experimental-strip-types handles plain .ts but not .tsx and not
  // all TypeScript syntax used by workspace packages (parameter properties,
  // decorators, etc.). Transpile all workspace package source files and .tsx
  // files through TypeScript's transpileModule to avoid those crashes.
  const shouldTranspileWithTypeScript =
    url.endsWith('.tsx') ||
    (url.endsWith('.ts') && url.includes('/packages/') && url.includes('/src/'));

  if (shouldTranspileWithTypeScript) {
    const ts = require('typescript');
    const source = readFileSync(fileURLToPath(url), 'utf-8');
    const { outputText } = ts.transpileModule(source, {
      fileName: fileURLToPath(url),
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ESNext,
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
      },
    });
    // Inject CJS-compatible globals (__dirname, __filename, require) so that
    // workspace packages compiled as ESM can still use them.  This avoids the
    // need for import.meta.url behind indirect invocation patterns that fail in
    // CJS and in dynamically-created scopes.
    // Only inject globals that the source file doesn't already declare itself.
    const preambleLines = [
      'import { fileURLToPath as __preamble_fUTP } from "node:url";',
      'import { dirname as __preamble_dn } from "node:path";',
      'import { createRequire as __preamble_cR } from "node:module";',
    ];
    if (!outputText.includes('const __filename') && !outputText.includes('let __filename')) {
      preambleLines.push('const __filename = __preamble_fUTP(import.meta.url);');
    }
    if (!outputText.includes('const __dirname') && !outputText.includes('let __dirname')) {
      preambleLines.push('const __dirname = __preamble_dn(__preamble_fUTP(import.meta.url));');
    }
    if (!outputText.includes('const require') && !outputText.includes('let require')) {
      preambleLines.push('const require = __preamble_cR(import.meta.url);');
    }
    return { format: 'module', source: preambleLines.join('\n') + '\n' + outputText, shortCircuit: true };
  }
  return nextLoad(url, context);
}
