import { parseNodeInfo, isValidIP } from '../src/utils/helpers';

describe('Helpers', () => {
  describe('parseNodeInfo', () => {
    it('should parse valid trace output', () => {
      const trace = `ip=1.2.3.4\nloc=US\ncity=New York\nregion=NY\ncountry=US`;
      const result = parseNodeInfo(trace);
      
      expect(result).toBeDefined();
      expect(result?.ip).toBe('1.2.3.4');
      expect(result?.country).toBe('US');
    });

    it('should return null for invalid input', () => {
      const result = parseNodeInfo('invalid input');
      expect(result).toBeNull();
    });
  });

  describe('isValidIP', () => {
    it('should validate IPv4 addresses', () => {
      expect(isValidIP('192.168.1.1')).toBe(true);
      expect(isValidIP('1.2.3.4')).toBe(true);
    });

    it('should invalidate invalid IPs', () => {
      expect(isValidIP('256.1.1.1')).toBe(false);
      expect(isValidIP('not.an.ip')).toBe(false);
      expect(isValidIP('')).toBe(false);
    });
  });
});
