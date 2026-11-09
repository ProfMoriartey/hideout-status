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
- `bin/check.js`: the CI check (`.github/workflows/check.yml`, every push;
  the test suite runs in `test.yml` when anything besides `status.json` changes)
- `lib/validate.js`: the validation rules shared by both

Needs Node 18 or newer and git. No npm packages.

## Commands sessions run

```sh
hideout start <member> --verb <verb> [--mission <codename>] [--progress N/M]
                       [--ticket N:title]
hideout progress <member> [--verb <verb>] [--progress N/M] [--ticket N:title]
hideout done <member>        # the site celebrates, then shows the member idle
hideout idle <member>        # back to idle, no event
```

- `start` sets the member working. Starting again while working changes the
  verb/mission/progress but keeps `since`.
- `progress` needs the member to be working. It always updates the state;
  it adds an event only when the verb changes, so progress ticks do not flood
  the event list.
- `done` needs the member to be working (exit 2 "not working" otherwise).
  `done` on a member that is already done, and `idle` on an idle member, do
  nothing and exit 0.
- `since` is when the current state began and moves only when the state
  changes. Every member write sets the member's `updatedAt`.

`--ticket 3:structure` shows which ticket a working member is on: a number
1..999 and a title from the `titles` list in `schema/allowlist.json` (never free
text). `progress` keeps it unless given a new one; `done` and `idle` clear it.

Missions (events are recorded as `chrollo`):

```sh
hideout mission start "Silk Lantern" [--tickets 0/12]
hideout mission progress "Silk Lantern" --tickets 4/12
hideout mission done "Silk Lantern" [--tickets 12/12]
hideout mission retire "Silk Lantern"
```

`mission retire` (only after `mission done`) removes the mission from the
feed: from `missions`, from members' `mission` fields, and every event that
names it. It also works after the codename was already removed from
`missions.allow` (then in any state), to repair a feed left stuck by doing
things in the wrong order.

Examples:

```sh
hideout start feitan --verb interrogating --mission "Silk Lantern" --progress 0/5
hideout progress feitan --progress 3/5
hideout done feitan
```

Options:

- `--dry-run` prints the new `status.json` and changes nothing. It does not
  fetch: it reads the local checkout as it is, which may be behind `main`.
- `--repo <path>` or `HIDEOUT_REPO=<path>`: the checkout to update. Default:
  the checkout that contains the script.
- `--branch <name>`: default `main`. Tests use a scratch branch.

Use one dedicated clone per session (or point `HIDEOUT_REPO` at it), with
`main` checked out and nothing uncommitted. Do not share a clone between
sessions running at the same time. Each call fetches, fast-forwards to the remote tip, applies the
change, validates the whole file, commits `status.json` with a fixed message
(`hideout: feitan start interrogating`) and pushes. If another session pushed
first, it fetches again, re-applies the same change to the fresh file and
retries (up to 10 times, jittered backoff, at most 5 s per wait). Only push
races are retried; any other refusal by the remote (branch protection, server
hooks) fails at once. It never force-pushes, and runs git with hooks and
fsmonitor disabled, without signing, and ignoring `GIT_DIR`, `GIT_INDEX_FILE`
and other `GIT_*` overrides from the caller. Feed commits are authored and
committed as `hideout <hideout@noreply.invalid>` with UTC dates, so the public
history does not reveal who ran the tool or their time zone. It refuses to
run if git attributes (filter, eol, text, encoding) apply to `status.json`,
and checks that the committed blob is exactly the validated bytes. It refuses to run if the checkout is on another branch,
has uncommitted changes, or has local commits that are not on the remote,
with two recoveries for a run that was killed part-way: a tree whose only
change is `status.json` is reset (so a hand edit of `status.json` in the feed
clone is thrown away), and local commits that are all feed-identity commits
touching only `status.json` are dropped. Both are logged; anything else is
still refused. Each git call times out after 60 s.

Members: chrollo, elders, pakunoda, shalnark, kortopi, phinks, feitan, machi,
nobunaga, franklin, shizuku, bonolenov, kalluto.

Verbs: advising, analyzing, auditing, briefing, building, cleaning, crafting,
debating, debugging, deploying, designing, documenting, drumming, fixing,
folding, forging, guarding, interrogating, planning, questioning, reading,
refactoring, researching, reviewing, scheduling, sketching, stitching, testing,
tracking, wiring.

## Mission codenames (Chrollo)

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

To take a codename out again, in this order:

1. `hideout mission done "<codename>"`
2. `hideout mission retire "<codename>"` (the codename must still be listed)
3. remove its line from `missions.allow`, run `node bin/check.js`, commit, push

Removing the line first would make the feed invalid while it still names the
mission.

## Feed updates go to main

The feed's purpose is to be read from `main`, so `hideout` pushes straight to
`main`. This is an owner-approved exception to "never push to main" and covers
only `status.json` commits made by `bin/hideout`. Everything else goes through
branches as usual.

## Privacy rules

- Only member ids, verbs and ticket titles from the lists, allowlisted mission codenames, small
  counts (`N/M`, `0 <= N <= M <= 999`), ticket numbers and timestamps can reach the feed.
- No free text: no notes, titles, file names, repo names or client names.
  Unknown flags, extra arguments and extra JSON fields are rejected.
- The tool validates every write; CI validates every push and pull request.
  A rejected command exits non-zero, prints a short error, and writes nothing.
- Error messages do not echo the rejected value or file content.
- `status.json` must be byte-for-byte canonical (`JSON.stringify(doc, null, 2)`
  plus one newline), so duplicate keys or other raw-only content cannot hide
  in the file. `status.json`, `missions.allow` and `schema/allowlist.json`
  must be regular, non-hard-linked UTF-8 files, never symlinks.

## Development

```sh
node --test          # tests, including a two-clone push race
node bin/check.js    # the CI check
```
