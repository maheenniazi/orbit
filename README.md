# Study OS *(working title)*

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
| `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` | AI syllabus parsing, the full chat assistant, AI-written notes |
| `SPOTIFY_CLIENT_ID` | Account connect: now playing, playback controls, your own playlists |

**Spotify setup:** create an app at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard), add the redirect URI `http://127.0.0.1:3000/callback`, and copy the Client ID. The OAuth flow is PKCE, so you don't need a client secret. Remote playback control needs Spotify Premium. The embedded player works without any of this.

## Features

- **Syllabus import:** accepts PDF, TXT or pasted text. Exams, quizzes, deadlines, readings, labs and no-class days go straight onto the calendar, and you can undo the import. Without an AI key, a built-in date parser handles formats like `Oct 14`, `10/14`, `14th November` and `2026-10-14`, and picks up times.
- **Auto study plans:** each exam gets six sessions scheduled at 10, 7, 5, 3, 2 and 1 days out, each with its own goal.
- **Focus modes:** these change automatically as the next exam approaches: Cruise, then Warm-up (14 days), Ramp-up (7), Lock-in (3) and Exam Day. Each mode changes the color theme, the pomodoro length and the playlist. You can override the mode by hand or turn on Zen to hide the sidebar.
- **Calendar:** month view, colors per course, course filters, quick add (`bio quiz fri 2pm`), and `.ics` export to Google or Apple Calendar.
- **Ask:** a chat that knows your schedule and notes. It can explain topics, quiz you and add events. In offline mode it only answers schedule questions.
- **Notes generator:** turns lecture text or slides into an outline, Cornell notes, a summary or flashcards. Notes are editable markdown, and each has a "Quiz me" button.
- **Spotify:** a player in the sidebar that keeps playing when you switch pages, with a playlist for each focus mode that you can change in Settings.

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
To rename the app, change `APP_NAME` in `public/js/util.js`.
