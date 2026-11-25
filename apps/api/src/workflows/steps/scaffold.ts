import { eq } from 'drizzle-orm';
import { scaffoldServiceSchema } from '@forgeflow/shared-types';
import { db } from '../../db/client.js';
import { services, templates } from '../../db/schema.js';
import { GitHubError, type GitHubClient, type GitHubRepository } from '../../github/types.js';
import { isTemplateAvailable } from '../../templates/registry.js';
import { renderTemplate } from '../../templates/engine.js';
import type { Step } from '../executor.js';

export const SCAFFOLD_STEP_DEFINITIONS: ReadonlyArray<{ key: string; name: string }> = [
  { key: 'validate', name: 'Validate configuration & repository availability' },
  { key: 'generate', name: 'Generate service files from template' },
  { key: 'create_repository', name: 'Create GitHub repository' },
  { key: 'push_files', name: 'Commit and verify scaffold files' },
];

export interface ScaffoldStepsDeps {
  getGitHubClient: () => GitHubClient | null;
  getGitHubOrg: () => string | null;
}

export function buildOwnershipMarker(serviceId: string): string {
  const compact = serviceId.replace(/-/g, '').slice(0, 12);
  return `[forgeflow:${compact}]`;
}

function hasOwnershipMarker(description: string | null | undefined, serviceId: string): boolean {
  if (!description) return false;
  return description.trim().endsWith(buildOwnershipMarker(serviceId));
}

function foreignRepoError(repoName: string, org: string): Error {
  return new Error(
    `A repository named ${repoName} already exists in ${org} that this service did not create. Choose a different service name.`
  );
}

interface TemplateResourceMeta {
  slug: string;
  version: string;
  fileCount: number;
}

interface RepositoryResourceMeta {
  fullName: string;
  url: string;
  defaultBranch: string;
  private: boolean;
}

interface CommitResourceMeta {
  sha: string;
  url: string;
}

export function createScaffoldSteps(deps: ScaffoldStepsDeps): Step[] {
  return [
    {
      key: 'validate',
      name: SCAFFOLD_STEP_DEFINITIONS[0].name,
      run: async (ctx) => {
        if (!ctx.service) {
          throw new Error(`Service '${ctx.run.service_id}' not found`);
        }

        const parsed = scaffoldServiceSchema.safeParse(ctx.input);
        if (!parsed.success) {
          const msg = parsed.error.issues.map((i) => i.message).join('; ');
          throw new Error(`Invalid scaffold input: ${msg}`);
        }

        const tpl = await db.query.templates.findFirst({
          where: eq(templates.id, parsed.data.templateId),
        });
        if (!tpl || !isTemplateAvailable(tpl.slug)) {
          throw new Error(`Template '${parsed.data.templateId}' is not available`);
        }

        const client = deps.getGitHubClient();
        const org = deps.getGitHubOrg();
        if (!client || !org) {
          throw new Error('GitHub App integration is not configured');
        }

        const info = await client.getInstallationInfo();
        if (info.accountLogin.toLowerCase() !== org.toLowerCase()) {
          throw new Error(
            `GitHub App installation account '${info.accountLogin}' does not match configured org '${org}'`
          );
        }

        await ctx.log('info', `Checking availability of ${org}/${ctx.service.slug}`);
        try {
          const existingRepo = await client.getRepository(ctx.service.slug);
          if (hasOwnershipMarker(existingRepo.description, ctx.service.id)) {
            await ctx.log(
              'info',
              `Repository ${existingRepo.fullName} already exists with matching ownership marker; resuming`
            );
          } else {
            throw foreignRepoError(ctx.service.slug, org);
          }
        } catch (err) {
          if (err instanceof GitHubError && err.code === 'NOT_FOUND') {
            await ctx.log('info', `Repository name ${org}/${ctx.service.slug} is available`);
            return;
          }
          throw err;
        }
      },
    },
    {
      key: 'generate',
      name: SCAFFOLD_STEP_DEFINITIONS[1].name,
      run: async (ctx) => {
        if (!ctx.service) {
          throw new Error(`Service '${ctx.run.service_id}' not found`);
        }

        const templateId =
          (ctx.input.templateId as string | undefined) ?? ctx.service.template_id ?? '';
        const tpl = await db.query.templates.findFirst({
          where: eq(templates.id, templateId),
        });
        if (!tpl || !isTemplateAvailable(tpl.slug)) {
          throw new Error(`Template '${templateId}' is not available`);
        }

        const description = (ctx.input.description as string | undefined) ?? '';
        const rendered = renderTemplate(tpl.slug, {
          serviceName: ctx.service.slug,
          description,
          templateVersion: tpl.version,
        });

        await ctx.saveResource('template', {
          slug: tpl.slug,
          version: tpl.version,
          fileCount: rendered.length,
        } satisfies TemplateResourceMeta);

        await ctx.log(
          'info',
          `Generated ${rendered.length} files from template ${tpl.slug}@${tpl.version}`
        );
      },
    },
    {
      key: 'create_repository',
      name: SCAFFOLD_STEP_DEFINITIONS[2].name,
      run: async (ctx) => {
        if (!ctx.service) {
          throw new Error(`Service '${ctx.run.service_id}' not found`);
        }

        const client = deps.getGitHubClient();
        const org = deps.getGitHubOrg();
        if (!client || !org) {
          throw new Error('GitHub App integration is not configured');
        }

        const existingMeta = ctx.resources.repository as RepositoryResourceMeta | undefined;
        if (existingMeta?.fullName) {
          const verified = await client.getRepository(ctx.service.slug);
          await db
            .update(services)
            .set({ repository_url: verified.url, updated_at: new Date() })
            .where(eq(services.id, ctx.service.id));
          await ctx.log('info', `Verified existing repository ${verified.fullName}`);
          return;
        }

        const userDesc = ((ctx.input.description as string | undefined) ?? '').trim().slice(0, 300);
        const marker = buildOwnershipMarker(ctx.service.id);
        const repoDescription = userDesc ? `${userDesc} ${marker}` : marker;
        const isPrivate = ctx.input.repositoryVisibility !== 'public';

        let repo: GitHubRepository;
        try {
          repo = await client.createRepository({
            name: ctx.service.slug,
            description: repoDescription,
            private: isPrivate,
          });
          await ctx.log('info', `Created repository ${repo.fullName}`);
        } catch (err) {
          if (err instanceof GitHubError && err.code === 'NAME_TAKEN') {
            const existingRepo = await client.getRepository(ctx.service.slug);
            if (hasOwnershipMarker(existingRepo.description, ctx.service.id)) {
              repo = existingRepo;
              await ctx.log('info', `Adopted existing repository ${repo.fullName}`);
            } else {
              throw foreignRepoError(ctx.service.slug, org);
            }
          } else {
            throw err;
          }
        }

        await ctx.saveResource('repository', {
          fullName: repo.fullName,
          url: repo.url,
          defaultBranch: repo.defaultBranch,
          private: repo.private,
        } satisfies RepositoryResourceMeta);

        await db
          .update(services)
          .set({ repository_url: repo.url, updated_at: new Date() })
          .where(eq(services.id, ctx.service.id));
      },
    },
    {
      key: 'push_files',
      name: SCAFFOLD_STEP_DEFINITIONS[3].name,
      run: async (ctx) => {
        if (!ctx.service) {
          throw new Error(`Service '${ctx.run.service_id}' not found`);
        }

        const client = deps.getGitHubClient();
        if (!client) {
          throw new Error('GitHub App integration is not configured');
        }

        const repoMeta = ctx.resources.repository as RepositoryResourceMeta | undefined;
        const tplMeta = ctx.resources.template as TemplateResourceMeta | undefined;
        if (!repoMeta || !tplMeta) {
          throw new Error('Missing repository or template metadata in workflow resources');
        }

        const trailer = `ForgeFlow-Workflow: ${ctx.run.id}`;
        const existingCommit = ctx.resources.commit as CommitResourceMeta | undefined;

        const head = await client.getHeadCommit(ctx.service.slug, repoMeta.defaultBranch);

        if (existingCommit && head.sha === existingCommit.sha) {
          await db
            .update(services)
            .set({ template_version: tplMeta.version, updated_at: new Date() })
            .where(eq(services.id, ctx.service.id));
          await ctx.log('info', `Verified existing commit ${head.sha.slice(0, 7)}`);
          return;
        }

        if (head.message.includes(trailer)) {
          await ctx.saveResource('commit', {
            sha: head.sha,
            url: head.url,
          } satisfies CommitResourceMeta);
          await db
            .update(services)
            .set({ template_version: tplMeta.version, updated_at: new Date() })
            .where(eq(services.id, ctx.service.id));
          await ctx.log('info', `Adopted existing scaffold commit ${head.sha.slice(0, 7)}`);
          return;
        }

        const description = (ctx.input.description as string | undefined) ?? '';
        const files = renderTemplate(tplMeta.slug, {
          serviceName: ctx.service.slug,
          description,
          templateVersion: tplMeta.version,
        });

        const message = `Initial scaffold from ForgeFlow template ${tplMeta.slug}@${tplMeta.version}\n\n${trailer}`;
        const commit = await client.createCommitWithFiles({
          repo: ctx.service.slug,
          branch: repoMeta.defaultBranch,
          files,
          message,
        });

        // Read the branch head back and verify its sha equals the new commit
        const verifiedHead = await client.getHeadCommit(ctx.service.slug, repoMeta.defaultBranch);
        if (verifiedHead.sha !== commit.sha) {
          throw new Error(
            `Commit verification failed: expected branch head ${commit.sha}, got ${verifiedHead.sha}`
          );
        }

        await ctx.saveResource('commit', {
          sha: commit.sha,
          url: commit.url,
        } satisfies CommitResourceMeta);

        await db
          .update(services)
          .set({ template_version: tplMeta.version, updated_at: new Date() })
          .where(eq(services.id, ctx.service.id));

        await ctx.log(
          'info',
          `Committed ${files.length} files to ${repoMeta.fullName}@${repoMeta.defaultBranch} (${commit.sha.slice(0, 7)})`
        );
      },
    },
  ];
}
