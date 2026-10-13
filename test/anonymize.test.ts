import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { anonymizeCode, anonymizeName, anonymizePath, restoreNames, VOCAB_VERSION } from '../src/anonymize';

test('anonymisation removes business names, comments and email but retains security signals', () => {
  const source = `async function AcmeRefund(request) {
    // Acme customer confidential refund procedure
    const acme_refund = "SELECT * FROM AcmeLedger WHERE user_id = ?";
    const email = "finance@acme.example";
    return stripe.refunds.create({ amount: 98345678, auth: request.headers.authorization });
  }`;
  const result = anonymizeCode(source, 'typescript');
  assert.doesNotMatch(result.code, /Acme|acme|Ledger|confidential|procedure|finance@|98345678/);
  for (const signal of ['Refund', 'request', 'SELECT', 'FROM', 'WHERE', 'user_id', 'stripe.refunds.create', 'auth', 'authorization']) {
    assert.ok(result.code.includes(signal), signal);
  }
  assert.equal(anonymizeCode(result.code, 'typescript').code, result.code);
  assert.equal(VOCAB_VERSION, 1);
});

test('fresh deterministic numbering, word casing, repeated values and restoration', () => {
  const source = 'AcmeRefund(acme_refund, ACME_REFUND, 987654321, 987654321, "helloZorple")';
  const result = anonymizeCode(source);
  assert.equal(result.code, 'Nm1Refund(nm2_refund, NM3_REFUND, 100001, 100001, "nm4Nm5")');
  assert.equal(restoreNames(result.code, result.names), source);
  assert.equal(anonymizeCode(result.code).code, result.code);
  assert.equal(anonymizeCode(source).code, result.code);
  assert.equal(anonymizeName('AcmeRefund'), 'Nm1Refund');
});

test('secrets redact inline and placeholders survive second pass and restore', () => {
  const source = 'const password = "hunter2"; const token = "sk_live_abcdefghijklmnopqrstuv"; const email = "eoin@acme.example";';
  const result = anonymizeCode(source, 'javascript');
  assert.doesNotMatch(result.code, /hunter2|abcdefghijklmnopqrstuv|eoin@/);
  assert.equal(anonymizeCode(result.code, 'javascript').code, result.code);
  assert.equal(restoreNames(result.code, result.names), source);
  assert.equal(anonymizeCode('Nm1 nm2 NM3 seg4 REDACTED_SECRET_5').code, 'Nm1 nm2 NM3 seg4 REDACTED_SECRET_5');
});

test('language-specific comments leave quoted markers and token separation intact', () => {
  const c = anonymizeCode('return/* private */request; const url = "https://api/auth"; // confidential', 'typescript').code;
  assert.doesNotMatch(c, /private|confidential/);
  assert.match(c, /return\s+request/);
  assert.match(c, /https:\/\/api\/auth/);
  const py = anonymizeCode('url = "https://api/#auth" # confidential\nvalue = request // 2', 'python').code;
  assert.match(py, /https:\/\/api\/#auth/);
  assert.match(py, /request \/\/ 2/);
  assert.doesNotMatch(py, /confidential/);
  const lua = anonymizeCode('local value = "--auth" -- confidential\n--[=[ confidential ]=]\nreturn [=[https://api/auth]=]', 'lua').code;
  assert.doesNotMatch(lua, /confidential/);
  assert.match(lua, /"--auth"/);
  assert.match(lua, /\[=\[https:\/\/api\/auth\]=\]/);
  assert.equal(anonymizeCode(lua, 'lua').code, lua);
});

test('paths preserve known directories, extensions and framework syntax', () => {
  const result = anonymizePath('src/routes/(Acme)/[...merchant]/+server.ts');
  assert.equal(result, 'src/routes/(seg1)/[...seg2]/+server.ts');
  assert.equal(anonymizePath(result), result);
  assert.equal(anonymizePath('src\\Acme\\Acme.ts'), 'src/seg1/seg1.ts');
  assert.equal(anonymizePath('src/auth/request-handler.test.ts'), 'src/auth/request-handler.test.ts');
});
