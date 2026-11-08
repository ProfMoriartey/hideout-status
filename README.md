# hideout-status

The live feed behind the Hideout site. `status.json` on `main` says who is
working on what, which missions are running, and the last 20 events. The site
polls it and draws the scene; it builds every visible sentence itself from
structured fields (for example `kind: done` + `verb: interrogating` becomes
"Feitan finished interrogating"). The feed never contains free text.

- `status.json`: the feed (format v1, `schema/status.schema.json`)
- `schema/allowlist.json`: the member ids and the verb list
- `missions.allow`: mission codenames that may appear, one per line
- `bin/hideout`: the only tool that writes the feed
- `bin/check.js`: the CI check (also run by `.github/workflows/check.yml`)
- `lib/validate.js`: the validation rules shared by both

Needs Node 18 or newer and git. No npm packages.

## Commands sessions run

```sh
hideout start <member> --verb <verb> [--mission <codename>] [--progress N/M]
hideout progress <member> [--verb <verb>] [--progress N/M]
hideout done <member>        # the site celebrates, then shows the member idle
hideout idle <member>        # back to idle, no event
```

Missions (events are recorded as `chrollo`):

```sh
hideout mission start "Silk Lantern" [--tickets 0/12]
hideout mission progress "Silk Lantern" --tickets 4/12
hideout mission done "Silk Lantern" [--tickets 12/12]
```

Examples:

```sh
hideout start feitan --verb interrogating --mission "Silk Lantern" --progress 0/5
hideout progress feitan --progress 3/5
hideout done feitan
```

Options:

- `--dry-run` prints the new `status.json` and changes nothing (it reads the
  local checkout without fetching).
- `--repo <path>` or `HIDEOUT_REPO=<path>`: the checkout to update. Default:
  the checkout that contains the script.
- `--branch <name>`: default `main`. Tests use a scratch branch.

Run it from a dedicated clone of this repo with `main` checked out and nothing
uncommitted. Each call fetches, fast-forwards to the remote tip, applies the
change, validates the whole file, commits `status.json` with a fixed message
(`hideout: feitan start interrogating`) and pushes. If another session pushed
first, it fetches again, re-applies the same change to the fresh file and
retries (up to 5 times, jittered backoff). It never force-pushes. It refuses
to run if the checkout is on another branch, has uncommitted changes, or has
local commits that are not on the remote.

Members: chrollo, elders, pakunoda, shalnark, kortopi, phinks, feitan, machi,
nobunaga, franklin, shizuku, bonolenov, kalluto.

Verbs: advising, analyzing, auditing, briefing, building, cleaning, crafting,
debating, debugging, deploying, designing, documenting, drumming, fixing,
folding, forging, guarding, interrogating, planning, questioning, reading,
refactoring, researching, reviewing, scheduling, sketching, stitching, testing,
tracking, wiring.

## Adding a mission codename (Chrollo)

When a mission is agreed, Chrollo adds its codename to `missions.allow` on
`main`, one per line, exact case:

```sh
echo "Blue Moth" >> missions.allow
node bin/check.js
git commit -am "missions: allow Blue Moth" && git push origin main
```

A codename is one to three capitalised words of letters only
(`^[A-Z][a-z]+( [A-Z][a-z]+){0,2}$`). Pick a codename that says nothing about
the real work. Until it is listed, `hideout` and CI reject it.

## Feed updates go to main

The feed's purpose is to be read from `main`, so `hideout` pushes straight to
`main`. This is an owner-approved exception to "never push to main" and covers
only `status.json` commits made by `bin/hideout`. Everything else goes through
branches as usual.

## Privacy rules

- Only member ids, verbs from the list, allowlisted mission codenames, small
  counts (`N/M`, `0 <= N <= M <= 999`) and timestamps can reach the feed.
- No free text: no notes, titles, file names, repo names or client names.
  Unknown flags, extra arguments and extra JSON fields are rejected.
- The tool validates every write; CI validates every push and pull request.
  A rejected command exits non-zero, prints a short error, and writes nothing.
- Error messages do not echo the rejected value.

## Development

```sh
node --test          # tests, including a two-clone push race
node bin/check.js    # the CI check
```
