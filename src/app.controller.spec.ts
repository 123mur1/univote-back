import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('reports the API as healthy', () => {
    const response = new HealthController().getHealth();
    expect(response.status).toBe('ok');
    expect(response.service).toBe('univote-api');
    expect(Number.isNaN(Date.parse(response.timestamp))).toBe(false);
  });
});
