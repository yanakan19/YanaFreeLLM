import { describe, it, expect } from 'vitest';
import { validateChatRequest } from '../server/index.js';

const err = (body) => validateChatRequest(body).error;

describe('validateChatRequest', () => {
  it('accepts a valid message and trims it', () => {
    expect(validateChatRequest({ message: '  hello  ' })).toEqual({ message: 'hello' });
  });

  it('rejects non-object bodies', () => {
    for (const body of [null, undefined, 'str', 42, [1, 2]]) {
      expect(err(body)?.status).toBe(400);
      expect(err(body)?.body.error).toBe('invalid_body');
    }
  });

  it('rejects a missing or non-string message', () => {
    for (const body of [{}, { message: 123 }, { message: null }, { message: { a: 1 } }, { message: ['x'] }]) {
      expect(err(body).status).toBe(400);
      expect(err(body).body.error).toBe('invalid_message');
    }
  });

  it('rejects a whitespace-only message', () => {
    expect(err({ message: '   \n\t ' }).body.error).toBe('empty_message');
    expect(err({ message: '   ' }).status).toBe(400);
  });

  it('rejects an over-long message with 413', () => {
    const e = err({ message: 'x'.repeat(4001) });
    expect(e.status).toBe(413);
    expect(e.body.error).toBe('message_too_long');
    expect(e.body.message).toMatch(/4000/);
  });

  it('accepts a message exactly at the limit', () => {
    expect(validateChatRequest({ message: 'x'.repeat(4000) }).error).toBeUndefined();
  });

  it('ignores extra fields', () => {
    expect(validateChatRequest({ message: 'hi', evil: true })).toEqual({ message: 'hi' });
  });
});
