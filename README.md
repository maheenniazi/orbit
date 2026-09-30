# orbit

A student workspace inspired by Notion that runs itself. Drop in a syllabus and the app fills your calendar, schedules study sessions before each exam, and switches into stricter focus modes as exams get closer.

## Run it

```bash
cp .env.example .env   # optional, see below
node server.js         # Node 18+, no npm install needed
```
Open **http://127.0.0.1:3000**. Use `127.0.0.1` and not `localhost`, because Spotify requires it.

It has no dependencies and works offline. Adding keys turns on the smart features:

| `.env` key | Unlocks |
|---|---|
| `KIRO_API_KEY` **or** `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | AI syllabus parsing, the full chat assistant, AI-written notes |
| `SPOTIFY_CLIENT_ID` | Account connect: now playing, playback controls, your own playlists |

### Using Kiro as the AI

The app can run all of its AI (chat, notes, syllabus parsing) through your Kiro subscription using [Kiro CLI headless mode](https://kiro.dev/docs/cli/headless/).

1. Install Kiro CLI: `curl -fsSL https://cli.kiro.dev/install | bash` (macOS/Linux). Windows users can install from PowerShell (see kiro.dev/cli).
2. Generate an API key in your Kiro account settings. API keys are available on the Pro, Pro+ and Power plans.
3. Put `KIRO_API_KEY=ksk_...` in `.env` and restart the server. The startup log should show `AI: kiro`.

If you'd rather not use a key, run `kiro-cli login` once and set `AI_PROVIDER=kiro` instead. If `kiro-cli` isn't on your PATH, set `KIRO_CLI_PATH`.

Kiro runs as the `study-os` agent in `kiro-agent/`, which has **no tools**, so it can only reply with text and can't run commands or touch your files. Each AI request uses Kiro credits from your plan. Replies take a few seconds longer than a direct API call because the CLI starts up for each one.

**Spotify setup:** create an app at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard), add the redirect URI `http://127.0.0.1:3000/callback`, and copy the Client ID. The OAuth flow is PKCE, so you don't need a client secret. Remote playback control needs Spotify Premium. The embedded player works without any of this.

## Features

- **Syllabus import:** accepts PDF, TXT or pasted text. Exams, quizzes, deadlines, readings, labs and no-class days go straight onto the calendar, and you can undo the import. Without an AI key, a built-in date parser handles formats like `Oct 14`, `10/14`, `14th November` and `2026-10-14`, and picks up times.
- **Auto study plans:** each exam gets six sessions scheduled at 10, 7, 5, 3, 2 and 1 days out, each with its own goal.
- **Focus phases:** these change automatically as the next exam approaches: drift, then rising (14 days), gravity (7), eclipse (3) and liftoff (exam day). Each phase changes the accent color (eclipse switches to the night theme), the pomodoro length and the playlist. You can override the mode by hand or turn on Zen to hide the sidebar.
- **Calendar:** month view, colors per course, course filters, quick add (`bio quiz fri 2pm`), and `.ics` export to Google or Apple Calendar.
- **Ask:** a chat that knows your schedule and notes. It can explain topics, quiz you and add events. In offline mode it only answers schedule questions.
- **Notes generator:** turns lecture text or slides into an outline, Cornell notes, a summary or flashcards. Notes are editable markdown, and each has a "Quiz me" button.
- **Spotify:** a player in the sidebar that keeps playing when you switch pages, with a playlist for each focus mode that you can change in Settings.

- **Careers:**
  - *Profile:* your default resume (PDF or paste) plus details like major, grad date, target roles, skills and work authorization. AI can fill the details in from your resume.
  - *Find:* type something like "summer 2027 software internships in nyc or remote" and it turns that into filters (type, term, location, remote, field, posted date, work authorization). Listings come from [SimplifyJobs' Summer 2027](https://github.com/SimplifyJobs/Summer2027-Internships) and [New Grad](https://github.com/SimplifyJobs/New-Grad-Positions) lists (updated hourly by the community) plus any Greenhouse, Lever or Ashby company board you add. Results are ranked by fit with your profile, and AI can re-rank the top 30 with a reason for each.
  - *Tailor:* paste a job link or description and get a tailored resume, CV or cover letter built only from your real experience, plus notes on missing keywords. "Save as pdf" opens a clean print layout.
  - *Tracker:* saved roles move through saved, applied, interview, offer and rejected. Deadlines and follow-ups can go on your calendar.

All data lives in the browser's localStorage. You can export and import a backup in Settings.

## Code map

```
server.js            static server + /api/ai proxy (Anthropic/OpenAI) + /api/status
public/js/app.js     router, theme, focus palette, sidebar widgets
  syllabus.js        offline parser, AI parser, quick-add parser, import view
  focus.js           mode logic, study-plan generator, pomodoro, focus view
  calendar.js  chat.js  notes.js  dashboard.js  settings.js  spotify.js
  store.js           localStorage state + pub/sub     util.js  helpers + markdown
```
To rename the app, change `APP_NAME` in `public/js/util.js`. The look is defined by the CSS variables at the top of `public/styles.css`: paper/night themes, fonts, and accent colors.
