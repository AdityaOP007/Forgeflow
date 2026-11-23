import { Router } from 'express';
import type { Request, Response } from 'express';
import type { UserProfile } from '@forgeflow/shared-types';

export const meRouter = Router();

meRouter.get('/', (req: Request, res: Response<UserProfile>) => {
  if (!req.auth?.userId) {
    res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
    } as unknown as UserProfile);
    return;
  }

  res.json({
    id: req.auth.userId,
    clerkId: req.auth.clerkId,
    name: req.auth.name,
    email: req.auth.email,
    role: req.auth.role!,
    createdAt: new Date().toISOString(),
  });
});
