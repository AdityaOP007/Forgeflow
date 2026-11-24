import fs from 'fs';
import path from 'path';
import { serviceNameSchema } from '@forgeflow/shared-types';
import { getTemplateEntry, resolveTemplateDirectory } from './registry.js';

export const MAX_TEMPLATE_FILES = 100;
export const MAX_TEMPLATE_FILE_BYTES = 256 * 1024; // 256 KB
export const MAX_DESCRIPTION_LENGTH = 300;

// Disallow all ASCII control chars (0x00-0x1F, 0x7F) EXCEPT tab (0x09) and newline (0x0A)
// eslint-disable-next-line no-control-regex
const DISALLOWED_CONTROL_CHARS = /[\x00-\x08\x0B-\x1F\x7F]/;
const TOKEN_PATTERN = /__[A-Z][A-Z0-9_]*__/g;

export interface RenderTemplateVars {
  serviceName: string;
  description?: string;
  templateVersion: string;
}

export interface RenderedFile {
  path: string;
  content: string;
}

export interface RenderTemplateOptions {
  /** Override template directory (primarily for unit tests with temp dirs). */
  templateDir?: string;
}

export class TemplateRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateRenderError';
  }
}

function validateVars(vars: RenderTemplateVars): {
  serviceName: string;
  description: string;
  templateVersion: string;
} {
  const parsedName = serviceNameSchema.safeParse(vars.serviceName);
  if (!parsedName.success) {
    const msg = parsedName.error.issues.map((i) => i.message).join('; ');
    throw new TemplateRenderError(`Invalid serviceName: ${msg}`);
  }

  const description = vars.description ?? '';
  if (typeof description !== 'string') {
    throw new TemplateRenderError('Description must be a string');
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new TemplateRenderError(
      `Description must be at most ${MAX_DESCRIPTION_LENGTH} characters (got ${description.length})`
    );
  }
  if (DISALLOWED_CONTROL_CHARS.test(description)) {
    throw new TemplateRenderError(
      'Description contains disallowed control characters (only newline is permitted)'
    );
  }

  if (!vars.templateVersion || typeof vars.templateVersion !== 'string') {
    throw new TemplateRenderError('templateVersion is required');
  }

  return {
    serviceName: parsedName.data,
    description,
    templateVersion: vars.templateVersion,
  };
}

function normalizeAndValidateOutputPath(relTmplPath: string): string {
  // Convert any OS separator to POSIX for checks
  const posixPath = relTmplPath.split(path.sep).join('/');

  if (path.posix.isAbsolute(posixPath) || posixPath.startsWith('/')) {
    throw new TemplateRenderError(`Absolute template path is not allowed: '${posixPath}'`);
  }

  const segments = posixPath.split('/');
  if (segments.some((seg) => seg === '..' || seg === '')) {
    throw new TemplateRenderError(`Invalid template path traversal or empty segment: '${posixPath}'`);
  }

  if (!posixPath.endsWith('.tmpl')) {
    throw new TemplateRenderError(`Template file must end with '.tmpl': '${posixPath}'`);
  }

  const stripped = posixPath.slice(0, -'.tmpl'.length);
  const normalized = path.posix.normalize(stripped);

  if (
    !normalized ||
    normalized === '.' ||
    path.posix.isAbsolute(normalized) ||
    normalized.startsWith('..') ||
    normalized.split('/').includes('..')
  ) {
    throw new TemplateRenderError(`Output path leaves template root: '${stripped}'`);
  }

  return normalized;
}

interface CollectedTemplateFile {
  relTmplPath: string;
  outputPath: string;
  absPath: string;
  size: number;
}

function collectTemplateFiles(rootDir: string): CollectedTemplateFile[] {
  const rootStat = fs.lstatSync(rootDir);
  if (rootStat.isSymbolicLink()) {
    throw new TemplateRenderError(`Template root cannot be a symlink: '${rootDir}'`);
  }
  if (!rootStat.isDirectory()) {
    throw new TemplateRenderError(`Template directory does not exist: '${rootDir}'`);
  }

  const collected: CollectedTemplateFile[] = [];
  const seenOutputPaths = new Set<string>();

  function walk(currentDir: string, relBase: string) {
    const entries = fs.readdirSync(currentDir).sort();
    for (const entryName of entries) {
      const absPath = path.join(currentDir, entryName);
      const stat = fs.lstatSync(absPath);

      if (stat.isSymbolicLink()) {
        throw new TemplateRenderError(`Symlinks are not allowed in templates: '${absPath}'`);
      }

      const relPath = relBase ? `${relBase}/${entryName}` : entryName;

      if (stat.isDirectory()) {
        walk(absPath, relPath);
      } else if (stat.isFile()) {
        if (collected.length >= MAX_TEMPLATE_FILES) {
          throw new TemplateRenderError(
            `Template exceeds maximum file count of ${MAX_TEMPLATE_FILES}`
          );
        }

        if (stat.size > MAX_TEMPLATE_FILE_BYTES) {
          throw new TemplateRenderError(
            `Template file '${relPath}' exceeds maximum size of ${MAX_TEMPLATE_FILE_BYTES} bytes`
          );
        }

        const outputPath = normalizeAndValidateOutputPath(relPath);
        if (seenOutputPaths.has(outputPath)) {
          throw new TemplateRenderError(`Duplicate output path in template: '${outputPath}'`);
        }
        seenOutputPaths.add(outputPath);

        collected.push({
          relTmplPath: relPath,
          outputPath,
          absPath,
          size: stat.size,
        });
      } else {
        throw new TemplateRenderError(`Unsupported file type in template: '${relPath}'`);
      }
    }
  }

  walk(rootDir, '');
  return collected;
}

/**
 * Render a template into an in-memory sorted array of UTF-8 { path, content } files.
 */
export function renderTemplate(
  slug: string,
  vars: RenderTemplateVars,
  opts: RenderTemplateOptions = {}
): RenderedFile[] {
  const validated = validateVars(vars);

  let templateDir = opts.templateDir;
  if (!templateDir) {
    const entry = getTemplateEntry(slug);
    if (!entry) {
      throw new TemplateRenderError(`Unknown template slug '${slug}'`);
    }
    if (!entry.available) {
      throw new TemplateRenderError(`Template '${slug}' is not available`);
    }
    templateDir = resolveTemplateDirectory(entry);
  }

  const files = collectTemplateFiles(templateDir);

  const tokenMap: Record<string, string> = {
    __SERVICE_NAME__: validated.serviceName,
    __SERVICE_DB_NAME__: validated.serviceName.replace(/-/g, '_'),
    __SERVICE_DESCRIPTION__: validated.description,
    __TEMPLATE_VERSION__: validated.templateVersion,
    __TEMPLATE_SLUG__: slug,
  };

  const renderedFiles: RenderedFile[] = files.map((file) => {
    const rawContent = fs.readFileSync(file.absPath, 'utf8');

    // __SERVICE_DESCRIPTION__ may appear ONLY in README.md.tmpl
    if (file.relTmplPath !== 'README.md.tmpl' && rawContent.includes('__SERVICE_DESCRIPTION__')) {
      throw new TemplateRenderError(
        `__SERVICE_DESCRIPTION__ is only allowed in README.md.tmpl (found in '${file.relTmplPath}')`
      );
    }

    // Single-pass token replacement: substituted values are never re-scanned
    const content = rawContent.replace(TOKEN_PATTERN, (token) => {
      if (Object.prototype.hasOwnProperty.call(tokenMap, token)) {
        return tokenMap[token];
      }
      throw new TemplateRenderError(
        `Unknown or leftover template token '${token}' in '${file.relTmplPath}'`
      );
    });

    // Extra safety check for leftover tokens in all non-README files
    if (file.relTmplPath !== 'README.md.tmpl') {
      TOKEN_PATTERN.lastIndex = 0;
      const leftover = TOKEN_PATTERN.exec(content);
      if (leftover) {
        throw new TemplateRenderError(
          `Leftover template token '${leftover[0]}' in rendered '${file.outputPath}'`
        );
      }
    }

    return {
      path: file.outputPath,
      content,
    };
  });

  // Deterministic ordering by POSIX path
  renderedFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return renderedFiles;
}

