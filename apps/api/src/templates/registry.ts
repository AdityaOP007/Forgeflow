import path from 'path';
import { fileURLToPath } from 'url';

export interface TemplateRegistryEntry {
  slug: string;
  directory: string;
  version: string;
  available: boolean;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Resolve monorepo root from apps/api/src/templates/registry.ts
const REPO_ROOT = path.resolve(__dirname, '../../../../');

export const TEMPLATE_REGISTRY: ReadonlyMap<string, TemplateRegistryEntry> = new Map([
  [
    'python-fastapi',
    {
      slug: 'python-fastapi',
      directory: 'templates/fastapi-service',
      version: '1.0.0',
      available: true,
    },
  ],
  [
    'node-express',
    {
      slug: 'node-express',
      directory: 'templates/node-service',
      version: '1.0.0',
      available: false,
    },
  ],
]);

export function getTemplateEntry(slug: string): TemplateRegistryEntry | undefined {
  return TEMPLATE_REGISTRY.get(slug);
}

export function isTemplateAvailable(slug: string): boolean {
  return TEMPLATE_REGISTRY.get(slug)?.available ?? false;
}

export function resolveTemplateDirectory(entry: TemplateRegistryEntry): string {
  return path.resolve(REPO_ROOT, entry.directory);
}

