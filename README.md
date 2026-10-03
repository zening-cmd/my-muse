# My Muse

A personal AI agent app for Windows. You chat with it, and it does the work on its own cloud computer, using your apps and browser, and checks with you before anything important.

**Built on the Sai API from [platform.simular.ai](https://platform.simular.ai/).** Agents like Meta's Muse work because each one gets its own cloud computer. The Sai API gives developers that whole package in one place:

- **A cloud computer**: a real Windows desktop in the cloud, ready in one click, to build and run your agent on.
- **Computer use**: an agent that operates that desktop for you. It opens apps, browses, fills in forms and handles files, and asks for approval before risky steps.

This app is an example of what you can build on top of it: a full personal-agent experience in under 2,000 lines of plain JavaScript, HTML and CSS. To build your own, get a cloud computer and an API key at **[platform.simular.ai](https://platform.simular.ai/)**.

## Features

- **Chat to hand off tasks.** Progress shows while the agent works, and replies render with formatting.
- **Approvals in the conversation.** Allow, Always allow (for this task) or Deny, with a summary of what the agent wants to do.
- **Multiple chats.** Make new ones, switch between them and delete them. When you return to an older chat, the agent gets a short recap of it.
- **Live screen.** Watch any of your Sai computers' desktops in the app (view only).
- **Keeps running in the background.** Closing the window keeps tasks running from the tray, with Windows notifications when a task needs you, finishes or fails. Tasks still running when you quit are picked up again on the next launch.
- **Files.** Attach files to a task. Files the agent creates can be copied to a "My Muse" folder in your Google Drive and opened from the chat.
- **Ideas and routines.** One-tap starting points that fill in the message box so you can edit before sending.
- **Make it yours.** Rename your Muse in Settings.

## Getting started

> [!IMPORTANT]
> **You need a Sai cloud computer and a Sai API key. Get both at [platform.simular.ai](https://platform.simular.ai/).**
>
> 1. Sign in at **[platform.simular.ai](https://platform.simular.ai/)** and create a cloud computer in the [Playground](https://platform.simular.ai/playground). It takes one click.
> 2. Create an API key on the [API keys](https://platform.simular.ai/api-keys) page. It starts with `sapi_`.
> 3. Paste the key into My Muse under **Settings**.

Requirements: Windows 10/11, Node.js 22+, and a Sai account with at least one computer.

```powershell
git clone https://github.com/zening-cmd/my-muse.git
cd my-muse
npm install
npm start
```

On first launch, open **Settings** (≡ at the bottom of the sidebar) and paste your Sai API key from [platform.simular.ai](https://platform.simular.ai/api-keys). It's encrypted with Windows secure storage and only the app's background process uses it. For development you can set `SAI_API_KEY` in the environment instead.

Each task uses your Sai account, and the cost of each reply is shown under it.

## How it works

```
renderer (UI) ──IPC──▶ main process ──HTTPS──▶ api.simular.ai/v1/agents/*
                         │  owns the API key            message, events (long-poll),
                         │  polls task updates          approve, abort, upload,
                         │  notifications, tray          machines, machines/:id/live
                         └─ %APPDATA%\My Muse\store.json (chats, tasks, settings)
```

- `src/sai-api.js`: Sai agents API client
- `src/main.js`: window, tray, notifications, task polling (rate-limit aware), local store
- `src/preload.js`: the only bridge the UI gets
- `src/renderer/`: plain HTML/CSS/JS UI; `screen.js` is the live view built on the Guacamole client
- `scripts/check-api.mjs`: read-only API check (`npm run check`)
- `scripts/vendor.mjs`: rebuilds `src/renderer/vendor/guacamole-common.js` from npm (`npm run vendor`)

## Known limits

- The live screen is view only; the API doesn't offer control yet, so CAPTCHAs and sign-in pop-ups have to be handled by the agent or in Sai.
- The API can't download the agent's files (`sai://file/...`) yet, so the app uses the Google Drive copy instead.
- Voice input isn't built yet.

## License

MIT. See [LICENSE](LICENSE). Bundled third-party code is listed in [NOTICE](NOTICE).
