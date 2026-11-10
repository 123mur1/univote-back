import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { UserRole } from '@prisma/client';
import type { TokenPayload, TokenType } from './auth.types';

// Short-lived access token, renewed silently with a longer-lived refresh token. A user who
// comes back after the access token expired gets a new one instead of an "invalid token" error.
export const ACCESS_TOKEN_TTL_SECONDS = 30 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
// Impersonation sessions are deliberately short and cannot be refreshed.
const IMPERSONATION_TTL_SECONDS = 30 * 60;

@Injectable()
export class TokenService {
  private readonly secret = process.env.AUTH_TOKEN_SECRET ?? '';

  constructor() {
    if (this.secret.length < 32)
      throw new Error(
        'AUTH_TOKEN_SECRET must be set to at least 32 characters.',
      );
  }

  issue(
    user: { id: string; role: UserRole; sessionVersion: number },
    options: { impersonatorId?: string } = {},
  ) {
    const now = Math.floor(Date.now() / 1000);
    const base = { sub: user.id, role: user.role, ver: user.sessionVersion };
    if (options.impersonatorId) {
      const accessToken = this.sign({
        ...base,
        typ: 'access',
        imp: options.impersonatorId,
        exp: now + IMPERSONATION_TTL_SECONDS,
      });
      return {
        accessToken,
        refreshToken: null,
        tokenType: 'Bearer',
        expiresIn: IMPERSONATION_TTL_SECONDS,
        refreshExpiresIn: 0,
      };
    }
    return {
      accessToken: this.sign({
        ...base,
        typ: 'access',
        exp: now + ACCESS_TOKEN_TTL_SECONDS,
      }),
      refreshToken: this.sign({
        ...base,
        typ: 'refresh',
        exp: now + REFRESH_TOKEN_TTL_SECONDS,
      }),
      tokenType: 'Bearer',
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      refreshExpiresIn: REFRESH_TOKEN_TTL_SECONDS,
    };
  }

  verify(token: string, expected: TokenType = 'access'): TokenPayload {
    const [body, nonce, signature, ...extra] = token.split('.');
    if (!body || !nonce || !signature || extra.length)
      throw new UnauthorizedException('Invalid access token.');
    const wanted = Buffer.from(this.hmac(`${body}.${nonce}`));
    const provided = Buffer.from(signature);
    if (wanted.length !== provided.length || !timingSafeEqual(wanted, provided))
      throw new UnauthorizedException('Invalid access token.');
    let payload: TokenPayload;
    try {
      payload = JSON.parse(
        Buffer.from(body, 'base64url').toString('utf8'),
      ) as TokenPayload;
    } catch {
      throw new UnauthorizedException('Invalid access token.');
    }
    // Tokens issued before refresh support have no type; treat them as access tokens.
    const type = payload.typ ?? 'access';
    if (!payload.sub || !payload.exp || type !== expected)
      throw new UnauthorizedException('Invalid access token.');
    if (payload.exp <= Math.floor(Date.now() / 1000))
      throw new UnauthorizedException(
        expected === 'refresh'
          ? 'Your session has expired. Please sign in again.'
          : 'Access token has expired.',
      );
    return payload;
  }

  private sign(payload: TokenPayload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const nonce = randomBytes(16).toString('base64url');
    const unsigned = `${body}.${nonce}`;
    return `${unsigned}.${this.hmac(unsigned)}`;
  }

  private hmac(value: string) {
    return createHmac('sha256', this.secret).update(value).digest('base64url');
  }
}
