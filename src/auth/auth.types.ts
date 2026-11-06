import type { UserRole } from '@prisma/client';
import type { Request } from 'express';

export type AuthenticatedUser = {
  id: string;
  role: UserRole;
  name: string;
  email: string | null;
  registrationNumber: string | null;
};

export type RequestWithUser = Request & { user: AuthenticatedUser };

export type TokenPayload = {
  sub: string;
  exp: number;
  role: UserRole;
};
