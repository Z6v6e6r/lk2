import { TextDecoder } from 'node:util';

export class StrictJsonError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'StrictJsonError';
    this.reason = reason;
  }
}

function reject(reason) {
  throw new StrictJsonError(reason);
}

export function decodeJsonUtf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    reject('malformed_utf8');
  }
}

export function parseStrictJson(input) {
  const text = typeof input === 'string' ? input : decodeJsonUtf8(input);
  let offset = 0;

  function whitespace() {
    while (offset < text.length && /[\u0009\u000a\u000d\u0020]/u.test(text[offset])) offset += 1;
  }

  function string() {
    if (text[offset] !== '"') reject('invalid_json');
    const start = offset;
    offset += 1;
    while (offset < text.length) {
      const character = text[offset];
      if (character === '"') {
        offset += 1;
        try {
          return JSON.parse(text.slice(start, offset));
        } catch {
          reject('invalid_string');
        }
      }
      if (character < '\u0020') reject('invalid_string');
      if (character === '\\') {
        offset += 1;
        const escape = text[offset];
        if (escape === 'u') {
          if (!/^[0-9a-fA-F]{4}$/u.test(text.slice(offset + 1, offset + 5)))
            reject('invalid_string');
          offset += 4;
        } else if (!'"\\/bfnrt'.includes(escape)) {
          reject('invalid_string');
        }
      }
      offset += 1;
    }
    reject('invalid_string');
  }

  function number() {
    const match = text
      .slice(offset)
      .match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u);
    if (!match) reject('invalid_number');
    offset += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) reject('invalid_number');
    return value;
  }

  function value() {
    whitespace();
    const character = text[offset];
    if (character === '"') return string();
    if (character === '{') return object();
    if (character === '[') return array();
    for (const [token, result] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ]) {
      if (text.startsWith(token, offset)) {
        offset += token.length;
        return result;
      }
    }
    return number();
  }

  function object() {
    const result = {};
    const keys = new Set();
    offset += 1;
    whitespace();
    if (text[offset] === '}') {
      offset += 1;
      return result;
    }
    while (offset < text.length) {
      whitespace();
      const key = string();
      if (keys.has(key)) reject('duplicate_key');
      keys.add(key);
      whitespace();
      if (text[offset] !== ':') reject('invalid_json');
      offset += 1;
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: value(),
        writable: true,
      });
      whitespace();
      if (text[offset] === '}') {
        offset += 1;
        return result;
      }
      if (text[offset] !== ',') reject('invalid_json');
      offset += 1;
    }
    reject('invalid_json');
  }

  function array() {
    const result = [];
    offset += 1;
    whitespace();
    if (text[offset] === ']') {
      offset += 1;
      return result;
    }
    while (offset < text.length) {
      result.push(value());
      whitespace();
      if (text[offset] === ']') {
        offset += 1;
        return result;
      }
      if (text[offset] !== ',') reject('invalid_json');
      offset += 1;
    }
    reject('invalid_json');
  }

  whitespace();
  if (offset === text.length) reject('invalid_json');
  const result = value();
  whitespace();
  if (offset !== text.length) reject('trailing_content');
  return result;
}
