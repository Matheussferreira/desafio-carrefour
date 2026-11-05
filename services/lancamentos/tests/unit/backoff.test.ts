import { backoffDelay } from '../../src/backoff';

describe('backoffDelay', () => {
  it('cresce de forma exponencial até o teto, sem jitter extra', () => {
    const maximo = () => 1;
    expect([0, 1, 2, 3].map(t => backoffDelay(t, 500, 15_000, maximo))).toEqual([500, 1000, 2000, 4000]);
    expect(backoffDelay(10, 500, 15_000, maximo)).toBe(15_000);
  });

  it('com jitter mínimo devolve metade do teto', () => {
    expect(backoffDelay(2, 500, 15_000, () => 0)).toBe(1000);
  });

  it('nunca ultrapassa o teto', () => {
    for (let t = 0; t < 30; t++) {
      expect(backoffDelay(t)).toBeLessThanOrEqual(15_000);
    }
  });
});
