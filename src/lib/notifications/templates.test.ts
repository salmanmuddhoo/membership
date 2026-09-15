// Rendering is the part of S-901 with no database in it: given a template
// and an event's values, what does the member actually read?
import { describe, expect, it } from 'vitest';
import { placeholdersIn, render } from './templates';

describe('render', () => {
  it('fills a placeholder from the values', () => {
    expect(render('Dear {{name}},', { name: 'Fatimah' })).toBe('Dear Fatimah,');
  });

  it('fills every occurrence, not just the first', () => {
    expect(render('{{a}} and {{a}}', { a: 'x' })).toBe('x and x');
  });

  it('tolerates spaces inside the braces', () => {
    expect(render('Hello {{ name }}', { name: 'Zahra' })).toBe('Hello Zahra');
  });

  it('is case-insensitive on the key', () => {
    expect(render('{{Member_No}}', { member_no: 'AB1001' })).toBe('AB1001');
  });

  it('blanks a placeholder with no value rather than leaving braces on show', () => {
    expect(render('Dear {{name}},', {})).toBe('Dear ,');
    expect(render('Dear {{name}},', { name: null })).toBe('Dear ,');
    expect(render('Dear {{name}},', { name: undefined })).toBe('Dear ,');
  });

  it('does not expand braces that arrive inside a value', () => {
    // One pass only: a value is text, never another template.
    expect(render('{{a}}', { a: '{{b}}', b: 'expanded' })).toBe('{{b}}');
  });

  it('leaves a body with no placeholders alone', () => {
    expect(render('No slots here.', { name: 'x' })).toBe('No slots here.');
  });

  it('keeps an unrecognised placeholder shape as written', () => {
    // A single brace is not a placeholder, so it is left as typed.
    expect(render('{name}', { name: 'x' })).toBe('{name}');
  });
});

describe('placeholdersIn', () => {
  it('lists what a template uses, deduplicated and sorted', () => {
    expect(placeholdersIn('{{b}} {{a}} {{b}}')).toEqual(['a', 'b']);
  });

  it('lowercases so the editor shows one name per slot', () => {
    expect(placeholdersIn('{{Name}} {{name}}')).toEqual(['name']);
  });

  it('returns nothing for a template with no slots', () => {
    expect(placeholdersIn('Plain text.')).toEqual([]);
  });
});
