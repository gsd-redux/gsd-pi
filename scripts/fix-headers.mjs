import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, extname, basename } from 'node:path';

const SRC_DIR = new URL('../src', import.meta.url).pathname;
const PROJECT_NAME = 'GSD2';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-test', 'coverage', '.git']);

function shouldSkip(path) {
  return SKIP_DIRS.has(path);
}

function getFiles(dir, files = []) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory() && !shouldSkip(entry.name)) {
      getFiles(fullPath, files);
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function toTitleCase(str) {
  return str.replace(/[-_](\w)/g, (_, c) => ' ' + c.toUpperCase())
    .replace(/^./, s => s.toUpperCase())
    .replace(/Ts$/, ' TS')
    .replace(/Api$/, ' API')
    .replace(/Id$/, ' ID')
    .replace(/Db$/, ' DB')
    .replace(/Ui$/, ' UI')
    .replace(/Url$/, ' URL');
}

function generatePurpose(filePath, content) {
  const fileName = basename(filePath, extname(filePath));

  if (fileName.endsWith('.test')) {
    const baseName = fileName.replace('.test', '');
    return `Tests for ${toTitleCase(baseName)}`;
  }

  const name = toTitleCase(fileName);

  const lines = content.split('\n').filter(l => l.trim());

  const firstMeaningfulLine = lines.find(l =>
    !l.startsWith('import ') &&
    !l.startsWith('export ') &&
    !l.startsWith('/*') &&
    !l.startsWith('*') &&
    !l.startsWith('//') &&
    !l.startsWith("'") &&
    !l.startsWith('"')
  );

  if (firstMeaningfulLine) {
    const trimmed = firstMeaningfulLine.trim();
    if (trimmed.startsWith('interface ')) {
      const match = trimmed.match(/^interface\s+(\w+)/);
      if (match) return `${name} — ${toTitleCase(match[1])} interface`;
    }
    if (trimmed.startsWith('type ')) {
      const match = trimmed.match(/^type\s+(\w+)/);
      if (match) return `${name} — ${toTitleCase(match[1])} type`;
    }
    if (trimmed.startsWith('class ')) {
      const match = trimmed.match(/^class\s+(\w+)/);
      if (match) return `${name} — ${toTitleCase(match[1])} class`;
    }
    if (trimmed.startsWith('function ') || trimmed.startsWith('export function ')) {
      const match = trimmed.match(/(?:export\s+)?function\s+(\w+)/);
      if (match) return `${name} — ${match[1]}()`;
    }
    if (trimmed.startsWith('const ') || trimmed.startsWith('export const ')) {
      const match = trimmed.match(/(?:export\s+)?const\s+(\w+)/);
      if (match) return `${name} — ${match[1]} constant`;
    }
    if (trimmed.startsWith('export {') || trimmed.startsWith('export {')) {
      return `${name} — barrel export`;
    }
  }

  if (content.includes("'use server'") || content.includes('"use server"')) {
    return `${name} — server action`;
  }

  if (content.includes('interface ') && content.includes('type ')) {
    return `${name} — types and interfaces`;
  }

  if (fileName.endsWith('.test') && content.includes('describe(')) {
    return `Tests for ${name.replace('.test', '')}`;
  }

  if (fileName.includes('-') || fileName.includes('_')) {
    return `${name}`;
  }

  return `${name}`;
}

function extractPurposeFromBlockComment(content) {
  const match = content.match(/^\/\*\*\s*\n([\s\S]*?)\*\/\n?/);
  if (match) {
    const body = match[1];
    const lines = body.split('\n').map(l => l.replace(/^\s*\*\s?/, '').trim()).filter(l => !/copyright|©/i.test(l));
    if (lines.length > 0) {
      let purpose = lines.join('\n');
      purpose = purpose.replace(/^GSD2\s*[-—–]\s*/i, '');
      return purpose;
    }
  }
  return null;
}

function extractPurposeFromLineComment(content) {
  const lines = content.split('\n');
  for (const line of lines) {
    if (line.startsWith('//')) {
      if (/^\/\/\s*GSD(?:\s|$)/.test(line)) {
        const matchWithDash = line.match(/^\/\/\s*GSD\s*[-—–]\s*(.+)$/);
        if (matchWithDash) {
          return matchWithDash[1].trim().replace(/^GSD2\s*[-—–]\s*/i, '');
        }
        const matchWithWordsAndDash = line.match(/^\/\/\s*GSD\s+(\w+(?:\s+\w+)*)\s*[-—–]\s*(.+)$/);
        if (matchWithWordsAndDash) {
          return `${matchWithWordsAndDash[1]} — ${matchWithWordsAndDash[2].trim()}`.replace(/^GSD2\s*[-—–]\s*/i, '');
        }
        const matchWithoutDash = line.match(/^\/\/\s*GSD\s+(.+)$/);
        if (matchWithoutDash && !matchWithoutDash[1].match(/[-—–]/)) {
          return matchWithoutDash[1].trim().replace(/^GSD2\s*[-—–]\s*/i, '');
        }
        return null;
      }
      const match = line.match(/^\/\/\s*(.+)$/);
      if (match && match[1].length > 3) {
        return match[1].trim().replace(/^GSD2\s*[-—–]\s*/i, '');
      }
    } else if (line.trim() && !line.trim().startsWith('#!')) {
      break;
    }
  }
  return null;
}

function removeCopyright(content) {
  return content.replace(/^.*(?:Copyright|©).*$/gm, '');
}

function processFile(filePath) {
  let content = readFileSync(filePath, 'utf8');
  const originalContent = content;

  if (content.startsWith('/**')) {
    let purpose = extractPurposeFromBlockComment(content);
    if (!purpose) {
      purpose = generatePurpose(filePath, content);
    }

    content = removeCopyright(content);
    const bodyLines = purpose.split('\n');
    const formattedBody = bodyLines.map((l, i) => {
      const stripped = l.trim();
      if (stripped === '') return ' *';
      if (i === 0) return ` * ${PROJECT_NAME} — ${stripped}`;
      return ` * ${stripped}`;
    }).join('\n');

    const newHeader = `/**\n${formattedBody}\n */\n`;
    const afterBlock = content.replace(/^\/\*\*[\s\S]*?\*\/\n?/, '');
    content = newHeader + afterBlock;
  } else if (content.startsWith('//') || content.trim().startsWith('#!')) {
    let purpose = extractPurposeFromLineComment(content);
    if (!purpose) {
      purpose = generatePurpose(filePath, content);
    }

    content = removeCopyright(content);
    const lines = content.split('\n');
    let endIndex = 0;
    let i = 0;
    while (i < lines.length && (lines[i].startsWith('//') || lines[i].trim() === '' || lines[i].trim().startsWith('#!'))) {
      endIndex += lines[i].length + 1;
      i++;
    }
    content = content.substring(endIndex);

    content = `// ${PROJECT_NAME} — ${purpose}\n` + content;
  } else {
    const purpose = generatePurpose(filePath, content);
    content = `// ${PROJECT_NAME} — ${purpose}\n` + content;
  }

  content = content.replace(/\n{3,}/g, '\n\n');

  if (content !== originalContent) {
    writeFileSync(filePath, content);
    return true;
  }
  return false;
}

const files = getFiles(SRC_DIR);
let updated = 0;
let skipped = 0;

for (const file of files) {
  try {
    if (processFile(file)) {
      updated++;
    } else {
      skipped++;
    }
  } catch (e) {
    console.error(`Error processing ${file}: ${e.message}`);
  }
}

console.log(`Updated ${updated} files, skipped ${skipped} (no changes needed)`);