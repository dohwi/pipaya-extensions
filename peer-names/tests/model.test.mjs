import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labelsOf, mentionsOf } from '../src/model.mjs';

const overview = {
  sessions: [
    { id: 's1', name: '미나', title: 'Docs', purpose: 'writes docs', cwd: '/w/pipaya/app' },
    { id: 's2', name: '지우', title: 'New session', purpose: '', cwd: '/w/x' },
    { id: 's3', name: '', title: 'closed', purpose: '', cwd: '/w' }
  ],
  groups: [{ name: 'Fan Out', handle: 'Fan-Out', sessionIds: ['s1', 's2', 'gone'] }, { name: 'Empty', handle: 'Empty', sessionIds: ['gone'] }]
};

test('labels carry the @name and the role', () => {
  assert.deepEqual(labelsOf(overview), {
    s1: { text: '@미나', title: '@미나 · writes docs' },
    s2: { text: '@지우', title: '@지우' }
  });
  assert.deepEqual(labelsOf(null), {});
});

test('mentions list groups with live sessions first, then sessions, each session except itself', () => {
  const items = mentionsOf(overview, 'ko-KR');
  assert.deepEqual(items.map(i => i.insert), ['@Fan-Out', '@미나', '@지우']);
  assert.equal(items[0].desc, '2개 세션');
  assert.equal(items[0].group, '그룹');
  assert.equal(mentionsOf(overview, 'en')[0].desc, '2 sessions');
  assert.equal(items[1].except, 's1');
  assert.equal(items[1].desc, 'writes docs · app/..'.replace('app/..', 'pipaya/app'));
});
