# Rally Story Notifier (macOS, Tauri + TypeScript)

Local desktop notifier for Rally **story updates** scoped to one or more selected sprint trackers.

## Features

- Polls Rally every 1/5/10 minutes (default 5)
- Supports selecting multiple projects in one workspace
- Save creates a new sprint tracker card on the main page
- Multiple trackers can run in parallel (different sprints/projects)
- Sprint dropdown: choose exactly one sprint per tracker
- Tracks only stories that belong to each tracker's chosen sprint
- Three tabs per selected tracker in UI:
  - `Current Stories` (all stories currently in sprint + current state)
  - `All Changes` (all captured field changes for chosen sprint)
  - `State Changes` (only state-related changes)
- Uses Rally Lookback API for change events
- Uses WSAPI for current story/sprint/project metadata
- Sends native desktop notifications
- Stores API key in macOS Keychain (via Rust `keyring`)

## Rally requirements

- Rally API key with access to your workspace/projects
- Workspace ObjectID
- One or more Project ObjectIDs

## Run locally

1. Install dependencies:

```bash
npm install
```

2. Start desktop app:

```bash
npm run tauri dev
```

3. In app settings:

- Enter Rally base URL (usually `https://rally1.rallydev.com`)
- Enter API key
- Load/select workspace
- Load/select one or more projects
- Load/select sprint from dropdown
- Save

## Build

```bash
npm run tauri build
```

## Notes

- Polling-first architecture: no webhook dependency.
- If API key is invalid/unauthorized, polling stops and shows an auth error.
- Captured change history retention is 45 days.
- Each tracker stores its own polling cursor/history.
