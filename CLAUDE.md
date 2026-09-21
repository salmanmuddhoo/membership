# Working in this repository

Conventions that are not obvious from the code. The `docs/` directory carries
the design: start at `docs/backlog.md` for what is built and what is next.

## Writing for the screen

This is an internal tool used every day by people who know their job. Write for
them.

- **No explaining how the system works.** Not why a control is offered, not how
  a rule is enforced, not what a state means internally. If a screen needs a
  paragraph to be understood, the screen is wrong.
- **No FRD or story references** — no "S-304", no "FRD 8.4". Those belong in
  code comments and commit messages, where the people who need them are.
- **Say what happened and what to do**, in as few words as it takes. An error
  names the thing to fix. A destructive action warns once. Counts, empty
  states, and "who did what, when" all earn their place; prose about the design
  does not.
- **English only.** Watch for browser-supplied text in native controls: an
  unstyled `<input type="file">` writes its own "no file chosen" in the
  browser's language, which puts French in an English app on a French-locale
  device. Hide the control and drive it from a label.

The reasoning behind a design belongs in a code comment or in `docs/`, never on
screen.

## Elsewhere

- Schema changes reach a database only through `migrations/`, applied by the
  pipeline — never by hand. Configuration tables need
  `set local albarakah.actor_description` at the top of the file.
- **Never edit a migration that is already on `main`.** The runner records a
  checksum and refuses a file that has changed — and refuses every migration
  after it, so the database silently falls behind while the application moves
  on. Put the change in a new migration. `pnpm verify:migrations` fails a
  branch that edits one, and runs in CI.
- Every page must be declared in `src/lib/access/authorise.ts`. Undeclared
  means denied, and `pnpm verify:routes` fails a page the build cannot reach.
- Every `/api/v1` endpoint is built with `defineEndpoint`, which enforces its
  permission and produces the OpenAPI document. `pnpm openapi:check` fails if
  the committed document is stale.
