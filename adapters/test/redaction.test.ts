import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { redactDeep, redactMessage, redactText } from '../src/index.js';

/**
 * Redaction: secrets referenced by name and location, never captured.
 *
 * Two failure modes are being guarded against at once, and they pull in opposite directions.
 * A redactor that misses a credential puts it in a call log, an excerpt or an error someone
 * later pastes into a ticket. A redactor that fires on ordinary source turns the excerpts it
 * was protecting into unusable evidence. So every pattern below matches a shape that *is* a
 * credential, and the last suite is the one that keeps it honest.
 */

const WHERE = 'repo.read_file src/config.ts';

describe('what is redacted', () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ['a personal access token', 'token = ghp_abcdefghijklmnopqrstuvwxyz01', 'vcs_personal_token'],
    ['a chat bot token', 'xoxb-1111111111-abcdefghijkl', 'chat_bot_token'],
    ['a cloud access key id', 'AKIAIOSFODNN7EXAMPLE', 'cloud_access_key_id'],
    [
      'a bearer header',
      'Authorization: Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'bearer_token',
    ],
    [
      'credentials embedded in a URL',
      'postgres://appuser:s3cretpassword@db.internal/app',
      'url_embedded_credentials',
    ],
  ];

  for (const [name, input, expected] of cases) {
    test(`${name} is replaced by a named placeholder`, () => {
      const result = redactText(input, WHERE);
      assert.doesNotMatch(result.text, /ghp_abcdefghijklmnopqrstuvwxyz01|xoxb-1111111111|AKIAIOSFODNN7EXAMPLE|s3cretpassword/);
      assert.equal(result.hits.length >= 1, true);
      assert.equal(result.hits[0]?.name, expected);
      assert.equal(
        result.hits[0]?.location, WHERE,
        'a redaction leaves behind what was found and where, so a human can go and look',
      );
    });
  }

  test('a private key block is replaced whole', () => {
    const input = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA0000000000',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const result = redactText(input, WHERE);
    assert.doesNotMatch(result.text, /MIIEowIBAAKCAQEA/);
    assert.match(result.text, /\[redacted:private_key_block@/);
  });

  test('an assigned secret keeps its key and separator so the file still reads', () => {
    const result = redactText('api_key = "hunter2hunter2"', WHERE);
    assert.match(result.text, /^api_key = \[redacted:api_key@/);
    assert.doesNotMatch(result.text, /hunter2/);
  });

  test('a JSON web token is redacted', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r';
    const result = redactText(`token: ${jwt}`, WHERE);
    assert.doesNotMatch(result.text, /dBjftJeZ4CVPmB92K27uhbUJU1p1r/);
  });
});

describe('what is not redacted', () => {
  const untouched: readonly string[] = [
    'export function readPassword(): string { return prompt(); }',
    'const tokens = source.split(" ");',
    '// the API key is stored in the secret manager, not here',
    'import { createHash } from "node:crypto";',
    'if (user.password === undefined) throw new Error("no password set");',
  ];

  for (const source of untouched) {
    test(`ordinary source is left alone: ${source.slice(0, 40)}`, () => {
      const result = redactText(source, WHERE);
      assert.equal(
        result.text, source,
        'a redactor that mangles source code makes the excerpts it protects useless as '
        + 'evidence',
      );
      assert.equal(result.hits.length, 0);
    });
  }
});

describe('redaction reaches everything an adapter returns', () => {
  test('strings nested in objects and arrays are redacted', () => {
    const value = {
      files: [
        { path: 'a.env.example', content: 'API_KEY = "abcdefghijklmnop"' },
        { path: 'b.ts', content: 'const x = 1;' },
      ],
      meta: { note: 'see ghp_abcdefghijklmnopqrstuvwxyz01' },
    };
    const result = redactDeep(value, WHERE);
    const rendered = JSON.stringify(result.value);
    assert.doesNotMatch(rendered, /abcdefghijklmnop"/);
    assert.doesNotMatch(rendered, /ghp_abcdefghijklmnopqrstuvwxyz01/);
    assert.match(rendered, /const x = 1;/, 'ordinary content survives');
    assert.equal(result.hits.length, 2);
  });

  test('non-string values pass through unchanged', () => {
    const result = redactDeep({ n: 5, b: true, nil: null }, WHERE);
    assert.deepEqual(result.value, { n: 5, b: true, nil: null });
  });

  test('a pathologically nested value is truncated rather than followed forever', () => {
    let deep: unknown = 'ghp_abcdefghijklmnopqrstuvwxyz01';
    for (let i = 0; i < 40; i += 1) deep = { inner: deep };
    const rendered = JSON.stringify(redactDeep(deep, WHERE).value);
    assert.doesNotMatch(rendered, /ghp_abcdefghijklmnopqrstuvwxyz01/);
    assert.match(rendered, /undescendable_depth/);
  });

  test('redactMessage is the same rule applied to an error', () => {
    const message = redactMessage('failed with Bearer aaaaaaaaaaaaaaaaaaaaaaaa', WHERE);
    assert.doesNotMatch(message, /aaaaaaaaaaaaaaaaaaaaaaaa/);
    assert.match(message, /\[redacted:bearer_token@/);
  });
});
