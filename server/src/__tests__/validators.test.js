const { decodeBase64, isEmailString } = require('../utils/validators');

describe('validators utils', () => {
  describe('decodeBase64', () => {
    it('decodes a base64 string', () => {
      const encoded = Buffer.from('hello@example.com').toString('base64');
      expect(decodeBase64(encoded)).toBe('hello@example.com');
    });

    it('returns empty-ish result for invalid input', () => {
      expect(decodeBase64('!!not-base64')).toEqual(expect.any(String));
      expect(decodeBase64(null)).toBe('');
      expect(decodeBase64('')).toBe('');
    });
  });

  describe('isEmailString', () => {
    it('returns true for valid emails', () => {
      expect(isEmailString('a@b.com')).toBe(true);
    });

    it('returns false for invalid emails', () => {
      expect(isEmailString('not-an-email')).toBe(false);
      expect(isEmailString('')).toBe(false);
      expect(isEmailString(null)).toBe(false);
    });
  });
});
