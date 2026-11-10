# Check the built page against the design

A designer marks the accessibility intent of a screen in Figma with annotation stamps: this text is
the level 1 heading, this area is the main landmark, this icon button is named "Refresh", focus goes
here first and there second. `usabl import figma` reads those stamps and writes them as usabl
requirements. Once a person approves them, usabl checks each one on the built page in a real
browser, and a page that does not match the design fails the check.

`usabl drift design` later tells you which approved requirements came from a design file that has
changed since.

This was tested end to end with a mock file built from Figma's published file format. It has not yet
been run on a real design file.

## What you need

- A Figma personal access token that can read the file. Put it in the `FIGMA_TOKEN` environment
  variable. usabl reads it from there only. It never prints it and never writes it to a file.
- The file key: the part of the file's address after `/file/` or `/design/`.
- The name of each Figma frame you want to import, and the usabl surface id of the screen it is.
- A `requirements` folder named in `usabl.config.json`. Requirement files are guarded: a change to
  them needs owner review.

## Import the design

```bash
export FIGMA_TOKEN=...   # your token; keep it out of shell history and scripts
npx usabl import figma AbC123 --frame "Users=users" --out requirements/figma-users.yaml
```

Give one `--frame <Frame name>=<surface id>` for each frame. Other options:

- `--owner <name>`: the owner each requirement records. The default is `design`.
- `--min-target <css px>`: also draft a target size check, at this size, for each stamped button,
  for example `--min-target 24`.

The command prints what it wrote and every note it did not turn into a check:

```text
Wrote 5 draft requirements to requirements/figma-users.yaml.
1 Figma note was not turned into a check:
  ...
Review each requirement, set approved: true, and commit. Nothing blocks until then.
```

It never overwrites a file. If `--out` already exists, it stops and writes nothing. It refuses an
unknown option, so a typo cannot drop a frame.

## What the stamps become

Each requirement finds its element on the page the way a screen reader user does, by role and
accessible name, never by a CSS selector.

| Stamp in Figma | Requirement kind | What usabl checks on the page |
|---|---|---|
| Heading stamp with a level, on a text layer | `heading` | One heading with that text, at that level |
| Landmark stamp, on an area | `landmark` | That landmark exists (a region or form also needs a name) |
| Button stamp, with a Button Details card for the name | `name` | Exactly one button with that accessible name |
| Ordering stamps 1, 2, 3, ... | `focus-order` | Pressing Tab from the top reaches those names in that order |
| Button stamp, with `--min-target` | `target-size` | That button is at least the given size in CSS pixels (see below) |

A note the importer cannot read is listed with the reason and left out of the file. That includes
speech notes such as "Announce 'Refreshing'", image stamps, Dev Mode notes, and a heading stamp with
a relative level. Write those requirements by hand if you need them.

Every requirement records where it came from:

```yaml
    approved: false
    source: { tool: figma, file: AbC123, node: "2:7", version: "4242" }
```

## Review and approve

Every drafted requirement starts with `approved: false`. Until it is approved, what its check finds
is shown as a preview finding and never blocks: not a failure and not a needs review. A check that
could not run is shown as a preview finding too. Two cases still count while unapproved, because
nothing checked the requirement at all: a requirement whose surface id matches no screen usabl
knows is a coverage gap, and so is a requirement whose check needs a capability the run did not
grant, such as a live browser in a static-only run. Open the file,
check each requirement against the design, change what is wrong, set `approved: true`, and commit.
The pull request needs owner review, like any requirement change.

## What the checks report

Once approved, each check gives one of these:

- **Nothing**, when the page matches the design.
- **A failure**, when the page shows the design is not met. For example: there is no button named
  "Refresh", the heading "Users" is level 2 where the design says level 1, focus never reached
  "Refresh", or "Refresh" is 16 by 16 CSS pixels where the design asks for at least 24.
- **Needs review**, when usabl cannot tell. For example: two buttons have the same name, so usabl
  cannot pick one; a candidate sits in a shadow root or a frame that usabl cannot read; the page's
  accessibility tree has an element with the name that the document search could not read, such as
  one in a closed shadow root; the page's accessibility tree has more than 20000 nodes, the most
  usabl reads for a design check; the focus walk was cut short, for example by a control that
  moves focus away when it gets it; or no button has the name, so its size cannot be measured.
  usabl never guesses. A run with a needs review finding is not verified.

The target size check measures the border box of a control laid out in one box. These shapes are
needs review, with the reason, because the box can be larger than the area a pointer can hit: a
control that wraps onto two lines; a control that it or an element above it rotates or skews; a
`clip-path`, `clip`, or mask on it or above it; an element above it that hides or scrolls its
overflow when the control reaches past its edges; and a fixed or sticky control that reaches past
the viewport. A translate or a scale is measured. The check does not measure overlap with other
elements or the spacing between targets.

`checkPage` in a Playwright test runs the same checks when it reads the project from
`projectRoot`.

## Find requirements whose design changed

```bash
npx usabl drift design
```

It reads the current version of each design file an approved requirement came from and lists the
requirements whose file changed. It names any requirement whose design node is no longer in the
file. Unapproved drafts are left out.

- Exit 0: no drift.
- Exit 1: drift, listed.
- Exit 2: it could not check, for example a missing token or a file Figma would not return. It
  says "Design drift was not checked." It never reads a failed check as no drift.

It compares versions of the whole file, so a change anywhere in the file lists every approved
requirement drafted from it. Review the design change, then update the requirements or import them
again.

## Network and token

Only `usabl import figma` and `usabl drift design` call the Figma API, and only when you run them.
Nothing on the check, gate, or hook path makes a network call to Figma. Each command sends one GET
per file, to `https://api.figma.com`, with the token in the `X-Figma-Token` header. It does not
follow redirects, so the token cannot be sent to another address.

`FIGMA_API_BASE` changes the address, for tests and for a mock. It must be https, or plain http on
this machine only (127.0.0.1, localhost, or [::1]). Whoever sets it chooses where your token goes,
so set it only for a mock you run yourself.

To try the commands without a Figma account, run the mock Figma API from a clone of the usabl
repository (the script is not in the published package):

```bash
npx vite-node scripts/mock-figma.ts --port 4010
FIGMA_API_BASE=http://127.0.0.1:4010 FIGMA_TOKEN=mock-figma-token \
  npx usabl import figma MOCKKEY --frame "Users=users" --out /tmp/figma-users.yaml
```

## Design text is untrusted

Layer names, note text, and component properties come from whoever can edit the design file. usabl
treats them as data. Names are cut to one line and checked before they go into a requirement, and a
name that is too long or looks like a credential is listed as a note instead. Notes are printed
inside an untrusted-text frame. The drafted file starts with a comment that says the names in it
are text copied from the design file and are data, not instructions, so a person or an agent that
reads it meets that first. Design text never builds a file path, a selector, or a command.
