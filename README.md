# Soundboard

A soundboard app with virtual mic routing for Discord, YouTube clip importing, and AI voice conversion (RVC).

## Requirements

* [Node.js](https://nodejs.org/) v18 or newer
* [VB-Audio Virtual Cable](https://vb-audio.com/Cable/) — required for routing sounds into Discord (or any other app) as a virtual microphone (free)
* (Optional, for **AI Voices** only) [Python 3](https://www.python.org/downloads/) — used to run the voice-conversion backend

## Installation

1. Download and extract the project folder (or `git clone` it)
2. Open a terminal inside the folder
3. Run:

   ```
   npm install
   ```

## Running the App

```
npm start
```

## Setup for Discord (Virtual Mic)

This app can route sounds directly into your Discord mic so others in a voice channel can hear them.

1. Install **VB-Audio Virtual Cable** from https://vb-audio.com/Cable/
2. Restart your PC after installing
3. Open the soundboard, click the **Settings** gear icon, and go to the **Audio** tab
4. Set **Virtual Mic Device** to **CABLE Input**
5. In Discord: go to **Settings → Voice & Video → Input Device** and set it to **CABLE Output**
6. Done — sounds you play will be heard by others in your voice channel, mixed with your real mic if you enable that too

## Usage

### Adding & playing sounds

* Click **Add Sounds** to import audio files (MP3, WAV, OGG, FLAC, M4A, AAC, Opus, WebM, AIFF)
* Click a sound card to play it, click again to stop
* Use the search bar and category filter at the top to find sounds quickly
* Click the pencil icon on a card to edit it:
  * Rename it, change its category, emoji, and color
  * Set a **global hotkey** (works even when the app is minimized/in the background)
  * Adjust per-sound **volume**, **fade in/out**
  * Apply pitch/formant shifting or an **AI voice** conversion (see below)
  * Choose whether the sound also plays through your virtual mic
* Click the trash/reveal icons to delete a sound or show its file in your file explorer

### Playback controls

* **Master Volume** — overall output volume
* **Virtual Mic Volume** — how loud sounds are when routed into Discord
* **Stop All Sounds** button stops everything at once
* Toggles available in the main toolbar:
  * **Stop on overlap** — automatically stops any currently playing sound when you play a new one
  * **Loop** — loops the currently played sound until stopped
  * **Queue mode** — queues sounds instead of playing them simultaneously

### Mic mixer (Audio settings)

Open **Settings → Audio** to configure:

* **Output Device**, **Virtual Mic Device**, and **Mic Input Device** — pick which physical/virtual devices the app uses
* **Mic Volume** and a live input meter
* **Local monitor** — hear your own mic through your speakers/headphones
* **Monitor mic feed** — hear the combined mic + soundboard mix locally
* **Mic FX** — apply effects to your live mic
* **Noise gate** — mute your mic below a set volume threshold, with an adjustable threshold
* **Ducking** — automatically lower music/sound volume while you talk
* **Push-to-talk mode** — mic is only live while a key is held

### AI Voices (RVC)

Convert a sound clip's audio to sound like one of your installed AI voice models before it plays:

1. Go to **Settings → AI Voices** and click **Install/Update Backend** to set up the required Python packages (`rvc-python`, `demucs`) automatically — or install Python yourself first if it isn't found
2. Add voice model files (`.pth`, optionally with a matching `.index`) via **Add Voices**, or drop them straight into the app's `rvc_voices` folder (openable from the same tab)
3. On a sound's edit screen, pick a voice, adjust pitch, and optionally enable **Separate vocals** (isolates vocals before conversion and remixes them with the original instrumental afterward — slower, but keeps background music/effects clean)
4. Click **Preview** to hear it, or **Save** to apply it — converted audio is cached so it only needs to run once per sound/voice/pitch combination

This runs conversion locally on your machine via Python; the first conversion of a clip can take a while (longer with vocal separation), especially without a GPU. This is separate from any real-time voice-changer app — this feature converts pre-recorded sound clips, not your live mic.

### Importing clips from YouTube

1. Click the YouTube import button, paste a video URL, and click **Fetch**
2. Optionally set a start/end time to trim the clip, and enable **auto-trim** to strip silence from the start/end
3. Click **Import** to download and add it as a sound

The app downloads a small helper tool (`yt-dlp`) automatically the first time you use this — no manual install needed. If a video fails to import with a "sign in to confirm you're not a bot" or age-restriction error, go to the YouTube import settings and either:
* Import a `cookies.txt` file exported from your browser while signed in to YouTube, or
* Point the app at a browser you're signed in to and let it read cookies from there directly

Cookies are stored locally and only ever handed to the download tool — they aren't sent anywhere else.

## Hotkeys

Hotkeys are global and work even when the app is minimized.

To set a hotkey:

1. Click the pencil icon on a sound card
2. Click the hotkey field
3. Press your desired key combination (e.g. `Ctrl+Shift+1`)
4. Click Save (or click the clear button to remove it)

## Notes

* All your sounds, settings, and window position are saved automatically and reloaded next time you launch the app
* Everything (sound library, settings, imported clips, downloaded tools, voice models) is stored locally in the app's own data folder — nothing is uploaded anywhere
