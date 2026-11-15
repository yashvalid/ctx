# ctx

Local Git multi-repo cockpit, branch-tied context memory, and metadata-only AI standup & PR summarizer.

## What It Does

- **Multi-repo status (`ctx status` / `ctx ui`)**: Tracks any repository you run `ctx` inside plus any watched parent folders (`ctx watch <dir>`), showing active branches, staged/modified/untracked counts, ahead/behind counts, stashes, and open TODOs.
- **Branch-tied notes, TODOs & links**: Store notes, checkable TODOs, and PR/ticket URLs in a central local SQLite database (`%LOCALAPPDATA%\ctx\ctx.db` on Windows) so your repositories stay completely clean. Worktrees of the same repo automatically share branch context.
- **Cross-repo search & activity (`ctx search`, `ctx activity`)**: Search across branch notes, TODOs, PR/ticket links, and commit subjects in one query, or view a cross-repo timeline and contribution pulse in both the terminal and the **Activity & Search** tab in `ctx ui`.
- **Opt-in branch recall (`ctx hook install`)**: Installs a safe `post-checkout` hook (preserving any existing hook script) that records branch visits and prints your saved notes & open TODOs when switching branches in your terminal.
- **Metadata-only AI summaries (`ctx standup`, `ctx pr`)**: Generates human-readable daily standups and PR drafts using any configured LLM provider (`gemini`, `openai`, `anthropic`, `groq`, `openrouter`, `ollama`, or `custom` OpenAI-compatible endpoints). **Only commit subjects, changed file paths/line counts, and your notes/TODOs are sent — never source code diffs.** Falls back cleanly to structured offline Markdown if no API key is set.

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
ctx search "retry"        # search notes, TODOs, links, and commit subjects
ctx activity --since 14d  # cross-repo commit & context activity feed
ctx standup --copy        # uses GEMINI_API_KEY, falls back offline if unset
ctx pr --copy             # draft PR description for current branch
ctx ui                    # launch local dashboard at http://127.0.0.1:4312
```

## Configuration

Set your provider's API key in the environment (`GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`), or configure any LLM locally (including local Ollama with no key needed):

```powershell
# Example: OpenAI / Anthropic / Groq / OpenRouter / Gemini
ctx config set provider openai
ctx config set model gpt-4o-mini
ctx config set apiKey YOUR_API_KEY

# Example: Local Ollama or custom OpenAI-compatible server
ctx config set provider ollama
ctx config set model llama3.2
ctx config set baseUrl http://127.0.0.1:11434/v1

ctx config set standupFormat markdown   # or slack
ctx config show                         # API key is always redacted
```

## Development

```powershell
bun run typecheck
bun test
```
