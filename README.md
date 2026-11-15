# ctx

Local Git multi-repo cockpit, branch-tied context memory, and metadata-only Gemini standup & PR summarizer.

## What It Does

- **Multi-repo status (`ctx status` / `ctx ui`)**: Tracks any repository you run `ctx` inside plus any watched parent folders (`ctx watch <dir>`), showing active branches, staged/modified/untracked counts, ahead/behind counts, stashes, and open TODOs.
- **Branch-tied notes, TODOs & links**: Store notes, checkable TODOs, and PR/ticket URLs in a central local SQLite database (`%LOCALAPPDATA%\ctx\ctx.db` on Windows) so your repositories stay completely clean. Worktrees of the same repo automatically share branch context.
- **Opt-in branch recall (`ctx hook install`)**: Installs a safe `post-checkout` hook (preserving any existing hook script) that records branch visits and prints your saved notes & open TODOs when switching branches in your terminal.
- **Metadata-only Gemini summaries (`ctx standup`, `ctx pr`)**: Summarizes your daily standup (smart last-workday window, filtered to your `git config user.email` by default) or drafts a PR description. **Only commit subjects, changed file paths/line counts, and your notes/TODOs are sent to Gemini — never source code diffs.** Falls back cleanly to structured offline Markdown if `GEMINI_API_KEY` is missing or unreachable.

## Quick Start

```powershell
# Link globally so `ctx` works from any folder
bun link

# Inside any git repo:
ctx note "Investigating retry jitter edge case"
ctx todo "Add test for 429 Retry-After header"
ctx link "https://github.com/org/repo/pull/42"
ctx hook install          # optional: print context when switching branches

# Multi-repo cockpit & summaries:
ctx watch C:\path\to\projects
ctx status                # add --dirty or --fetch
ctx standup --copy        # uses GEMINI_API_KEY, falls back offline if unset
ctx pr --copy             # draft PR description for current branch
ctx ui                    # launch local dashboard at http://127.0.0.1:4312
```

## Configuration

Set `GEMINI_API_KEY` in your environment, or configure locally:

```powershell
ctx config set geminiKey YOUR_API_KEY
ctx config set geminiModel gemini-2.5-flash
ctx config set standupFormat markdown   # or slack
ctx config show                         # key is always redacted
```

## Development

```powershell
bun run typecheck
bun test
```
