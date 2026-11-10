import type { UserRole } from '@prisma/client';
import type { Request } from 'express';

export type AuthenticatedUser = {
  id: string;
  role: UserRole;
  name: string;
  email: string | null;
  registrationNumber: string | null;
  // Set when an administrator is signed in as this user.
  impersonatorId?: string;
};

export type RequestWithUser = Request & { user: AuthenticatedUser };

export type TokenType = 'access' | 'refresh';

export type TokenPayload = {
  sub: string;
  exp: number;
  role: UserRole;
  typ?: TokenType;
  ver?: number;
  imp?: string;
};
