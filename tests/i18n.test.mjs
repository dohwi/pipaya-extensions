import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLanguage, setLanguage, t } from '../src/i18n.mjs';

test('auto follows the program language: first supported wins, unsupported -> en, unknown -> ko', () => {
  assert.equal(resolveLanguage('auto', ['ko-KR', 'en']), 'ko');
  assert.equal(resolveLanguage(undefined, ['en-US']), 'en');
  assert.equal(resolveLanguage('auto', ['fr', 'en-GB']), 'en');
  assert.equal(resolveLanguage('auto', ['fr-FR']), 'en');
  assert.equal(resolveLanguage('auto', []), 'ko');
});

test('an explicit choice overrides the program language', () => {
  assert.equal(resolveLanguage('ko', ['en-US']), 'ko');
  assert.equal(resolveLanguage('en', ['ko-KR']), 'en');
  assert.equal(resolveLanguage('bogus', ['en-US']), 'en');
});

test('messages interpolate and fall back to Korean then the key', () => {
  setLanguage('en', []);
  assert.equal(t('remainingOf', { name: 'GPT' }), 'GPT remaining');
  setLanguage('ko', []);
  assert.equal(t('remainingOf', { name: 'GPT' }), 'GPT 잔량');
  assert.equal(t('nope'), 'nope');
});
