import { eq, isNotNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { environments } from '../db/schema.js';

export const NODE_PORT_MIN = 30080;
export const NODE_PORT_MAX = 30089;

/**
 * Ensures an environment has an assigned NodePort in [30080, 30089] and matching url.
 * Reuses an existing assignment if already set.
 */
export async function allocateEnvironmentNodePort(
  environmentId: string
): Promise<{ nodePort: number; url: string }> {
  const [env] = await db
    .select()
    .from(environments)
    .where(eq(environments.id, environmentId))
    .limit(1);

  if (!env) {
    throw new Error(`Environment '${environmentId}' not found`);
  }

  if (env.node_port !== null && env.node_port !== undefined) {
    const url = env.url ?? `http://127.0.0.1:${env.node_port}`;
    if (!env.url) {
      await db.update(environments).set({ url }).where(eq(environments.id, environmentId));
    }
    return { nodePort: env.node_port, url };
  }

  const usedRows = await db
    .select({ node_port: environments.node_port })
    .from(environments)
    .where(isNotNull(environments.node_port));

  const usedSet = new Set<number>(
    usedRows.map((r) => r.node_port).filter((p): p is number => typeof p === 'number')
  );

  for (let port = NODE_PORT_MIN; port <= NODE_PORT_MAX; port++) {
    if (usedSet.has(port)) continue;
    const url = `http://127.0.0.1:${port}`;
    try {
      await db
        .update(environments)
        .set({ node_port: port, url })
        .where(eq(environments.id, environmentId));
      return { nodePort: port, url };
    } catch (err) {
      // Unique violation (23505) from concurrent allocation -> try next port
      const pgCode =
        (err as { code?: string; cause?: { code?: string } })?.code ??
        (err as { cause?: { code?: string } })?.cause?.code;
      if (pgCode === '23505') continue;
      throw err;
    }
  }

  throw new Error(
    `All NodePorts (${NODE_PORT_MIN}-${NODE_PORT_MAX}) are in use; undeploy an existing service first.`
  );
}
