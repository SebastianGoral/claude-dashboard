# claude-dash

A local dashboard for macOS. It shows all your Claude Code sessions at once: from the terminal and from the Claude desktop app.

## Features

- Live list of all sessions, from the terminal, the desktop app, VS Code and the Agent SDK.
- A "Waiting for you" section, sounds (with a mute switch), and the waiting count in the tab title, the Dock and the menu bar.
- Exact "needs permission" status with Claude Code hooks (optional, see below).
- Tool errors and API errors on the card.
- Detail panel: recent messages, tool calls and sub-agents.
- "Recently closed" sessions, a History tab, and search over all sessions.

## Install

claude-dash runs only on macOS. Pick one way.

### Desktop app (recommended)

```sh
curl -fsSL https://raw.githubusercontent.com/SebastianGoral/claude-dashboard/main/install.sh | bash
```

The script downloads the newest app for your Mac (Apple Silicon or Intel), puts it in `/Applications` and opens it. Run the same command again to update.

### In the browser (needs Node.js 22)

```sh
npx claude-dash
```

The dashboard opens at http://127.0.0.1:4317. Press Ctrl+C to stop it. You get no Dock badge, menu bar icon or notifications.

## Release a new version

1. Push a tag:

   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```

2. The GitHub Action `.github/workflows/release.yml` builds the app zips, makes a GitHub release and publishes the npm package. The version comes from the tag.

The npm step needs the repository secret `NPM_TOKEN` (an npm access token that can publish).

## Develop

### Requirements

- macOS
- Node.js 22

### Run in the browser

```sh
npm install
npm run dev
```

Open http://localhost:4318.

## Desktop app

The desktop app runs the same server and the same UI in one window.

- The Dock badge shows the number of sessions that wait for you.
- The menu bar icon shows the same number. Click the icon to show or hide the window.
- A notification comes when a session changes to "your turn" or "waiting". Click it to show the window.
- Closing the window hides it. The app keeps running. Press Cmd+Q to quit.

### Run in dev mode

Stop `npm run dev` first. Both use port 4317.

```sh
npm run dev:desktop
```

This starts Vite and Electron. The window loads the Vite URL, so UI changes reload in place. After a change in `desktop/` or `server/`, restart the command.

### Build the app

```sh
npm run build:desktop
```

The app is in `desktop/release/mac-arm64/claude-dash.app`. To install it:

1. Quit the app with Cmd+Q, if it runs.
2. Replace the old copy. Do not copy over it, because old files stay and break the signature.

   ```sh
   rm -rf /Applications/claude-dash.app
   cp -R desktop/release/mac-arm64/claude-dash.app /Applications/
   ```

The app has no Apple developer signature. It has only an "ad-hoc" signature, which needs no certificate.

- An app that you build on your own Mac opens normally.
- An app that you download or get from another Mac is blocked by macOS. To open it, run:

  ```sh
  xattr -dr com.apple.quarantine /Applications/claude-dash.app
  ```

## macOS permissions

### Automation (one time)

A click on a session card brings its Terminal.app tab to the front. For this, claude-dash controls Terminal and System Events with AppleScript.

On the first click, macOS shows 2 prompts:

1. "claude-dash" wants access to control "Terminal". Click **Allow**.
2. "claude-dash" wants access to control "System Events". Click **Allow**.

If you clicked **Don't Allow**:

1. Open **System Settings → Privacy & Security → Automation**.
2. Find **claude-dash**.
3. Turn on **Terminal** and **System Events**.

After a rebuild, macOS can ask again, because the ad-hoc signature changes. To clear the old answers, run:

```sh
tccutil reset AppleEvents dev.claude-dash.app
```

With `npm run dev`, the prompts name your terminal app (for example Terminal or iTerm) instead of claude-dash.

### Notifications

macOS asks for permission at the first notification. To change it later, open **System Settings → Notifications → claude-dash**.

## Hooks (exact status)

Without hooks, the dashboard guesses "needs permission" from the session files. With hooks, Claude Code tells the dashboard.

1. Click **Hooks: off** in the header.
2. Confirm. The dashboard adds its hooks to `~/.claude/settings.json`. It writes a backup first: `settings.json.claude-dash-backup`.
3. Start new Claude Code sessions. They send their events to the dashboard.

To remove the hooks, click **Hooks: on**. Your other hooks stay.

## Data

claude-dash writes only to `~/.claude-dash/`: settings and the "Recently closed" list. It writes to `~/.claude/settings.json` only when you turn on hooks.

## Ports

- 4317: server (API, and the built UI in the desktop app)
- 4318: Vite dev server
