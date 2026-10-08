import { isIos } from './browser';

afterEach(() => vi.unstubAllGlobals());

test.each([
  ['iPhone', 1, true],
  ['iPad', 5, true],
  ['Macintosh', 5, true],
  ['Macintosh', 0, false],
  ['Android', 5, false],
])('detects the native HLS path for %s with %i touch points', (userAgent, touchPoints, expected) => {
  vi.stubGlobal('navigator', { userAgent, maxTouchPoints: touchPoints });
  expect(isIos()).toBe(expected);
});
