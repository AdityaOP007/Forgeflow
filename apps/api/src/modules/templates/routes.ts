import { Router } from 'express';
import type { Request, Response } from 'express';
import type { TemplateItem } from '@forgeflow/shared-types';
import { db } from '../../db/client.js';
import { templates } from '../../db/schema.js';
import { asc } from 'drizzle-orm';
import { isTemplateAvailable } from '../../templates/registry.js';

export const templatesRouter = Router();

templatesRouter.get('/', async (_req: Request, res: Response<TemplateItem[]>) => {
  const rows = await db.select().from(templates).orderBy(asc(templates.name));
  const result: TemplateItem[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    language: r.language,
    framework: r.framework,
    version: r.version,
    sourceLocation: r.source_location,
    available: isTemplateAvailable(r.slug),
    createdAt: r.created_at.toISOString(),
  }));
  res.json(result);
});
