# bb-plugin-next-steps

Suggests the most beneficial next steps for the current project and shows them
above an empty composer. Press <kbd>→</kbd> to drop the highlighted suggestion
into the message box.

```
Add unit tests for parseSuggestions and isCacheStale        untested parsing  →
Fix the Escape handler stealing Escape from host overlays
Delete the unused vendored components under components/ui
                                          ↑↓ pick · → use · esc hide   Refresh
```

## How it works

1. When the composer is empty, the banner asks the backend for that project's
   suggestions over rpc.
2. If the cache is missing or older than the refresh interval, the backend
   spawns a **hidden** thread in the project (`visibility: "hidden"`) with a
   read-only analysis prompt. It runs on the project's own provider and reads
   the real repository — git log, git status, README/CLAUDE.md, TODOs, tests.
3. When that thread goes idle, `thread.idle` fires. The plugin parses the JSON
   out of the reply, caches it in kv under `cache:<projectId>`, publishes a
   realtime signal, and archives the analysis thread.
4. The banner refetches on that signal and renders the list.

A regular thread going idle also triggers a refresh (subject to the interval),
because finishing work is exactly when the next steps change.

## Files

| File                 | What lives there                                          |
| -------------------- | --------------------------------------------------------- |
| `lib/suggestions.ts` | Prompt text and reply parsing. Pure, no bb API.            |
| `server.ts`          | Settings, kv cache, spawn/complete, rpc, events, CLI.      |
| `app.tsx`            | The composer banner and its keyboard handling.             |

## Settings

Extensions → Plugins → Next Steps, or `bb plugin config next-steps set <key> <value>`.

| Key                   | Default | Meaning                                          |
| --------------------- | ------- | ------------------------------------------------ |
| `suggestionCount`     | `3`     | How many suggestions to generate and show (1-5).  |
| `refreshMinutes`      | `10`    | Wait this long before regenerating.               |
| `refreshOnThreadIdle` | `true`  | Refresh when a thread in the project finishes.    |
| `arrowCycling`        | `true`  | Let ↑/↓ move the highlight in an empty composer.  |

Settings edits do not reload the plugin; the values are read per call, so they
take effect on the next request.

## Keys

| Key           | Action                                              |
| ------------- | --------------------------------------------------- |
| <kbd>→</kbd>  | Put the highlighted suggestion in the composer.      |
| <kbd>↑</kbd> <kbd>↓</kbd> | Move the highlight (off via `arrowCycling`). |
| <kbd>Esc</kbd> | Hide the banner until the project changes.          |

Keys are only claimed while the banner is visible, the caret is in a text
input, the draft is empty, and no modifier is held. Escape is observed but not
swallowed, so host overlays still close.

## CLI

```sh
bb next-steps show                  # print the cached suggestions
bb next-steps refresh               # force a fresh analysis run
bb next-steps clear                 # drop the cache
bb next-steps show --project proj_x # target a project explicitly
```

## Development

```sh
npm install
npx tsc --noEmit
bb plugin dev            # watch: rebuild + reload on save
bb plugin logs next-steps -f
```

`bb plugin dev` and the `bb` CLI need loopback access to the bb server. Under a
workspace-sandboxed agent thread those calls may need escalation.

## Customizing

- **Prompt** — `buildAnalysisPrompt` in `lib/suggestions.ts`. This is the main
  quality knob: name the files, checks, or conventions you care about.
- **Provider/model** — the analysis thread inherits the project's defaults.
  Pass `providerId` / `execution` to `bb.sdk.threads.spawn` in
  `requestGeneration` to pin a cheaper model.
- **Environment** — `resolveEnvironment` reuses an existing environment so a
  refresh does not provision a worktree. Return `{ type: "project-default" }`
  unconditionally if you want isolation instead.
- **Accept key** — the `ArrowRight` branch of the keydown handler in `app.tsx`.
- **Look** — the banner is registered with `chrome: "bare"`, so the markup at
  the bottom of `app.tsx` is entirely yours. Style with host token classes
  (`text-muted-foreground`, `bg-muted`); never hardcode colors.
