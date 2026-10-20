import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInteger, parsePagination, getString } from './http';

test('parseInteger applies defaults and clamps values', () => {
  assert.equal(parseInteger(undefined, { defaultValue: 5 }), 5);
  assert.equal(parseInteger('9', { min: 10 }), 10);
  assert.equal(parseInteger('25', { max: 20 }), 20);
  assert.equal(parseInteger('abc', { defaultValue: 3 }), 3);
});

test('parsePagination normalizes page and pageSize', () => {
  assert.deepEqual(parsePagination({ page: '0', pageSize: '500' }, { defaultPageSize: 50, maxPageSize: 100 }), {
    page: 1,
    pageSize: 100,
  });
  assert.deepEqual(parsePagination({}, { defaultPage: 2, defaultPageSize: 25 }), {
    page: 2,
    pageSize: 25,
  });
});

test('getString trims empty values', () => {
  assert.equal(getString('  hello  '), 'hello');
  assert.equal(getString('   '), undefined);
  assert.equal(getString([' world ']), 'world');
});