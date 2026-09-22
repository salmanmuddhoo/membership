// Rendering is the part of S-901 with no database in it: given a template
// and an event's values, what does the member actually read?
import { describe, expect, it } from 'vitest';
import {
  placeholderSequence,
  placeholdersIn,
  problemsWithEdit,
  render,
} from './templates';
import { placeholdersForEvent } from './event-codes';
import type { NotificationTemplate } from './templates';

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

describe('what the editor refuses', () => {
  function template(
    overrides: Partial<NotificationTemplate> = {}
  ): NotificationTemplate {
    return {
      id: 'id',
      eventCode: 'application.approved',
      channel: 'email',
      subject: 'Welcome',
      body: 'Hello {{applicant_name}}',
      isActive: true,
      description: '',
      providerTemplateName: null,
      providerTemplateLanguage: 'en',
      ...overrides,
    };
  }

  const edit = (body: string, subject: string | null = 'Welcome') => ({
    subject,
    body,
    isActive: true,
  });

  it('accepts wording that only uses what the event fills in', () => {
    expect(
      problemsWithEdit(
        template(),
        edit('Hello {{applicant_name}}, you are {{member_no}}.')
      )
    ).toEqual([]);
  });

  // The failure this prevents reaches a real member as "Your member number
  // is ." — with nothing, anywhere, saying why.
  it('refuses a placeholder the event does not fill in', () => {
    const problems = problemsWithEdit(
      template(),
      edit('Your number is {{member_number}}.')
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('{{member_number}}');
    // And names what may be used instead, rather than only refusing.
    expect(problems[0]).toContain('{{member_no}}');
  });

  it('checks the subject as well as the body', () => {
    const problems = problemsWithEdit(
      template(),
      edit('Hello', 'Welcome {{nickname}}')
    );

    expect(problems[0]).toContain('{{nickname}}');
  });

  // Migration 0053's check constraint, reached as the empty field it is
  // rather than as a database error naming a constraint.
  it('refuses an email with no subject', () => {
    expect(problemsWithEdit(template(), edit('Hello', '  '))).toContain(
      'An email needs a subject.'
    );
  });

  it('does not ask a WhatsApp template for a subject it has no field for', () => {
    expect(
      problemsWithEdit(
        template({ channel: 'whatsapp', subject: null }),
        edit('Hello {{applicant_name}}', null)
      )
    ).toEqual([]);
  });

  it('refuses wording with nothing in it', () => {
    expect(problemsWithEdit(template(), edit('   '))).toContain(
      'A message needs wording.'
    );
  });

  // An event code nobody here raises cannot be checked, and refusing what
  // cannot be checked would be wrong.
  it('allows any placeholder on an event it does not know', () => {
    expect(
      problemsWithEdit(
        template({ eventCode: 'something.else' }),
        edit('Hello {{whatever}}')
      )
    ).toEqual([]);
  });
});

describe('placeholdersForEvent', () => {
  it('offers a member number only where a membership was approved', () => {
    expect(placeholdersForEvent('application.approved')).toContain('member_no');
    // An account application opens an account; it has no member number of its
    // own to name, and offering one would invite wording that renders blank.
    expect(placeholdersForEvent('account.approved')).not.toContain('member_no');
  });

  it('offers the comment only where one was required', () => {
    expect(placeholdersForEvent('application.returned')).toContain('comment');
    expect(placeholdersForEvent('application.rejected')).toContain('comment');
    expect(placeholdersForEvent('application.submitted')).not.toContain(
      'comment'
    );
  });

  it('knows nothing about an event it does not raise', () => {
    expect(placeholdersForEvent('member.birthday')).toBeNull();
    expect(placeholdersForEvent('nonsense')).toBeNull();
  });
});

describe('placeholderSequence', () => {
  // A provider that takes positional parameters gets them in this order, so
  // this is not cosmetic: sorted output would put AB1001 where the member's
  // name belongs and nobody would find out until a member read the message.
  it('keeps the order the placeholders appear in, not alphabetical', () => {
    expect(
      placeholderSequence('Hello {{name}}, your number is {{ab_number}}.')
    ).toEqual(['name', 'ab_number']);
    // placeholdersIn sorts; these two must not be confused for each other.
    expect(
      placeholdersIn('Hello {{name}}, your number is {{ab_number}}.')
    ).toEqual(['ab_number', 'name']);
  });

  // One parameter, used twice — which is what the provider expects, since a
  // template may repeat {{1}}.
  it('counts a repeated placeholder once, at its first appearance', () => {
    expect(placeholderSequence('{{a}} then {{b}} then {{a}}')).toEqual([
      'a',
      'b',
    ]);
  });

  it('is case-insensitive, like rendering', () => {
    expect(placeholderSequence('{{Name}} and {{name}}')).toEqual(['name']);
  });

  it('returns nothing for wording with no slots', () => {
    expect(placeholderSequence('Plain text.')).toEqual([]);
  });
});
