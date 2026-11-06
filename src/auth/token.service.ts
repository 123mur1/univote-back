import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { UserRole } from '@prisma/client';
import type { TokenPayload } from './auth.types';

const TOKEN_TTL_SECONDS = 60 * 60;

@Injectable()
export class TokenService {
  private readonly secret = process.env.AUTH_TOKEN_SECRET ?? '';

  constructor() {
    if (this.secret.length < 32) throw new Error('AUTH_TOKEN_SECRET must be set to at least 32 characters.');
  }

  issue(userId: string, role: UserRole) {
    const payload: TokenPayload = { sub: userId, role, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const nonce = randomBytes(16).toString('base64url');
    const unsigned = `${body}.${nonce}`;
    return { accessToken: `${unsigned}.${this.sign(unsigned)}`, tokenType: 'Bearer', expiresIn: TOKEN_TTL_SECONDS };
  }

  verify(token: string): TokenPayload {
    const [body, nonce, signature, ...extra] = token.split('.');
    if (!body || !nonce || !signature || extra.length) throw new UnauthorizedException('Invalid access token.');
    const expected = Buffer.from(this.sign(`${body}.${nonce}`));
    const provided = Buffer.from(signature);
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) throw new UnauthorizedException('Invalid access token.');
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
      if (!payload.sub || !payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) throw new UnauthorizedException('Access token has expired.');
      return payload;
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException('Invalid access token.');
    }
  }

  private sign(value: string) {
    return createHmac('sha256', this.secret).update(value).digest('base64url');
  }
}
