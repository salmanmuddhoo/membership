// No unescaped HTML sink anywhere in the client code (S-1001).
//
// This exists because one got in. `CaptureFields.astro` built a search result
// with `innerHTML` and an applicant's own typed name interpolated into it —
// and anyone who can start an application can type one, including a member of
// the public through the app's sign-up and the website through the public API.
// The result was a script running in the officer's session, with the
// officer's access, the moment they searched for a guardian.
//
// There is no DOM harness in this suite, and adding one to test a component's
// rendered output would be a large amount of machinery for a narrow question.
// The question this actually asks is structural: does any source file assign
// to an HTML sink? The answer should be no, and a grep answers it for every
// file at once, including files nobody has written yet.
//
// If a future change genuinely needs one of these, the right move is to
// escape the values and add the file here with a comment saying why — not to
// delete the test.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..'
);

// Assignments and calls that parse their argument as HTML. `set:html` is
// Astro's own and is checked separately below, because it has one legitimate
// use here.
const SINKS = [
  /\.innerHTML\s*=(?!\s*''\s*;)/,
  /\.outerHTML\s*=/,
  /insertAdjacentHTML\s*\(/,
  /document\.write\s*\(/,
];

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(full)));
    } else if (
      /\.(ts|astro)$/.test(entry.name) &&
      !entry.name.endsWith('.test.ts')
    ) {
      files.push(full);
    }
  }
  return files;
}

describe('client-side HTML sinks', () => {
  it('are not used anywhere', async () => {
    const offenders: string[] = [];

    for (const file of await sourceFiles(SRC)) {
      const lines = (await readFile(file, 'utf8')).split('\n');
      lines.forEach((line, index) => {
        // A comment explaining why a sink is NOT used is not a use of one.
        const code = line.replace(/^\s*(\/\/|\*|--).*$/, '');
        if (SINKS.some(pattern => pattern.test(code))) {
          offenders.push(`${path.relative(SRC, file)}:${index + 1}`);
        }
      });
    }

    expect(
      offenders,
      'These parse a string as HTML. If any part of it came from a person — ' +
        'an applicant name, a reference, anything typed into a form — it is ' +
        'a script running in the reader’s session. Build elements and ' +
        'set textContent instead.'
    ).toEqual([]);
  });

  // `innerHTML = ''` only clears; it parses nothing. Allowed, and the
  // pattern above deliberately lets it through — this pins that intent so a
  // later tightening does not break a safe use by accident.
  it('still allow clearing a node', () => {
    expect(SINKS.some(p => p.test("dialogBody.innerHTML = '';"))).toBe(false);
    expect(SINKS.some(p => p.test('el.innerHTML = candidate.name;'))).toBe(
      true
    );
  });
});

describe('Astro set:html', () => {
  // One legitimate use: the API reference embeds its own endpoint list as a
  // JSON island. That data comes from the route descriptors, which are
  // written by whoever writes an endpoint, not by anyone using the system.
  // Any OTHER use needs the same kind of justification.
  const ALLOWED = new Set(['pages/admin/api.astro']);

  it('is used only where the content is not a person’s input', async () => {
    const offenders: string[] = [];

    for (const file of await sourceFiles(SRC)) {
      if (!file.endsWith('.astro')) continue;
      const contents = await readFile(file, 'utf8');
      if (!contents.includes('set:html')) continue;

      const relative = path.relative(SRC, file).replace(/\\/g, '/');
      if (!ALLOWED.has(relative)) offenders.push(relative);
    }

    expect(
      offenders,
      'set:html renders its value as markup. Add the file to ALLOWED only ' +
        'with a comment saying why the content cannot come from a person.'
    ).toEqual([]);
  });
});
