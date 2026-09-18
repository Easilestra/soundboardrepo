"use strict";

const {
  app,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  dialog,
  shell,
} = require("electron");
const path = require("path");
const fs = require("fs");
const https = require("https");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const { autoUpdater } = require("electron-updater");

ffmpeg.setFfmpegPath(ffmpegPath);

/* -----------------------------------------------------------------------
   Auto-update — checks the GitHub Releases page for this repo on launch.
   If a newer version is published there, it downloads it in the
   background and asks the person to restart to install it.
   ----------------------------------------------------------------------- */
autoUpdater.autoDownload = true;

function setupAutoUpdater() {
  autoUpdater.on("update-available", (info) => {
    console.log(`[Update] New version available: ${info.version}`);
  });

  autoUpdater.on("update-not-available", () => {
    console.log("[Update] Already up to date.");
  });

  autoUpdater.on("error", (err) => {
    console.error("[Update] Error checking for updates:", err);
  });

  autoUpdater.on("update-downloaded", async () => {
    if (!mainWindow) return;
    const result = await dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "Update ready",
      message: "A new version has been downloaded. Restart now to install it?",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (result.response === 0) autoUpdater.quitAndInstall();
  });

  // Check once on launch. checkForUpdatesAndNotify silently does nothing
  // in dev mode (unpackaged), so this is safe to leave in during testing.
  autoUpdater.checkForUpdatesAndNotify().catch((e) => {
    console.error("[Update] checkForUpdatesAndNotify failed:", e);
  });
}

let mainWindow;

const userDataPath = app.getPath("userData");
const soundsConfigPath = path.join(userDataPath, "sounds.json");
const soundsBackupPath = path.join(userDataPath, "sounds.json.bak");
const windowStatePath = path.join(userDataPath, "window-state.json");
const settingsConfigPath = path.join(userDataPath, "settings.json");
const importedSoundsDir = path.join(userDataPath, "imported");
try { fs.mkdirSync(importedSoundsDir, { recursive: true }); } catch {}

/* -----------------------------------------------------------------------
   YouTube import — uses yt-dlp instead of a Node scraping library.
   yt-dlp is a separately-released tool patched independently of this
   app whenever YouTube changes something, so it stays working far more
   reliably than a bundled JS library would. Downloaded once, on first
   use, straight from its GitHub releases — no manual install needed.
   ----------------------------------------------------------------------- */
const ytdlpDir = path.join(userDataPath, "bin");
const ytdlpPath = path.join(ytdlpDir, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");

function ytdlpReleaseUrl() {
  if (process.platform === "win32") return "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
  if (process.platform === "darwin") return "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos";
  return "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";
}

function downloadFile(url, destPath, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "soundboard-app" } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) { reject(new Error("Too many redirects")); return; }
        downloadFile(res.headers.location, destPath, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Download failed with status ${res.statusCode}`));
        return;
      }
      const fileStream = fs.createWriteStream(destPath);
      res.pipe(fileStream);
      fileStream.on("finish", () => fileStream.close(() => resolve()));
      fileStream.on("error", reject);
    }).on("error", reject);
  });
}

async function ensureYtDlp() {
  if (fs.existsSync(ytdlpPath)) return ytdlpPath;
  fs.mkdirSync(ytdlpDir, { recursive: true });
  console.log("[YT] Downloading yt-dlp (one-time setup)...");
  await downloadFile(ytdlpReleaseUrl(), ytdlpPath);
  if (process.platform !== "win32") fs.chmodSync(ytdlpPath, 0o755);
  return ytdlpPath;
}

function runYtDlpJson(exePath, url) {
  return new Promise((resolve, reject) => {
    const proc = spawn(exePath, ["--dump-json", "--no-warnings", "--no-playlist", ...ytCookieArgs(), url], { windowsHide: true });
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => { proc.kill(); reject(new Error("Timed out fetching video info")); }, 30000);
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`)); return; }
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error("Couldn't parse video info")); }
    });
  });
}

function runYtDlpDownload(exePath, url, outputTemplate) {
  return new Promise((resolve, reject) => {
    const proc = spawn(exePath, ["-f", "bestaudio/best", "--no-playlist", ...ytCookieArgs(), "-o", outputTemplate, url], { windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => { proc.kill(); reject(new Error("Download timed out")); }, 180000);
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`)); return; }
      resolve();
    });
  });
}

const YOUTUBE_URL_RE = /^https?:\/\/(www\.)?(youtube\.com|youtu\.be|m\.youtube\.com)\//i;

/* -----------------------------------------------------------------------
   YouTube cookies — lets yt-dlp act as a signed-in user, which fixes the
   "Sign in to confirm you're not a bot" / age-restricted errors.
   Two sources, only one active at a time:
     • "file"    — a Netscape-format cookies.txt the person imported
                   (filtered down to youtube.com / google.com on import)
     • "browser" — yt-dlp reads cookies straight from an installed browser
   Cookies never leave the machine; they're only handed to yt-dlp.
   ----------------------------------------------------------------------- */
const ytCookiesFilePath = path.join(userDataPath, "yt-cookies.txt");
const ytCookieConfigPath = path.join(userDataPath, "yt-cookie-config.json");
const YT_COOKIE_BROWSERS = ["chrome", "firefox", "edge", "brave", "opera", "vivaldi", "chromium", "safari"];

function readYtCookieConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(ytCookieConfigPath, "utf8"));
    if (cfg && ["none", "file", "browser"].includes(cfg.mode)) return cfg;
  } catch {}
  return { mode: "none", browser: "" };
}

function writeYtCookieConfig(cfg) {
  try { fs.writeFileSync(ytCookieConfigPath, JSON.stringify(cfg, null, 2), "utf8"); return true; }
  catch (e) { console.error("Couldn't save YouTube cookie config:", e); return false; }
}

function ytCookieArgs() {
  const cfg = readYtCookieConfig();
  if (cfg.mode === "file" && fs.existsSync(ytCookiesFilePath)) return ["--cookies", ytCookiesFilePath];
  if (cfg.mode === "browser" && YT_COOKIE_BROWSERS.includes(cfg.browser)) return ["--cookies-from-browser", cfg.browser];
  return [];
}

function countCookieLines(text) {
  return text.split(/\r?\n/).filter((l) => l && (!l.startsWith("#") || l.startsWith("#HttpOnly_")) && l.split("\t").length >= 7).length;
}

// Keep only YouTube/Google cookie lines so an exported "all sites" cookies.txt
// doesn't leave the rest of the person's logins sitting in the app folder.
function filterNetscapeCookies(text) {
  const kept = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const isHttpOnly = raw.startsWith("#HttpOnly_");
    if (raw.startsWith("#") && !isHttpOnly) continue;
    const fields = raw.split("\t");
    if (fields.length < 7) continue;
    const domain = (isHttpOnly ? fields[0].slice("#HttpOnly_".length) : fields[0]).replace(/^\./, "").toLowerCase();
    if (/(^|\.)(youtube\.com|google\.com)$/.test(domain)) kept.push(raw);
  }
  return kept;
}

function getYtCookieStatus() {
  const cfg = readYtCookieConfig();
  let fileCookieCount = 0, fileSavedAt = null;
  try {
    if (fs.existsSync(ytCookiesFilePath)) {
      fileCookieCount = countCookieLines(fs.readFileSync(ytCookiesFilePath, "utf8"));
      fileSavedAt = fs.statSync(ytCookiesFilePath).mtimeMs;
    }
  } catch {}
  return {
    mode: cfg.mode === "file" && !fileCookieCount ? "none" : cfg.mode,
    browser: cfg.browser || "",
    fileCookieCount,
    fileSavedAt,
    browsers: YT_COOKIE_BROWSERS,
  };
}


/* -----------------------------------------------------------------------
   AI Voices (RVC) — model file storage.
   Conversion itself runs in a separate real-time RVC app; this app just
   stores .pth/.index model files the person drops in and remembers which
   one they're currently using there (or "off"), as an organizer/reminder.
   ----------------------------------------------------------------------- */
const rvcVoicesDir = path.join(userDataPath, "rvc_voices");
try { fs.mkdirSync(rvcVoicesDir, { recursive: true }); } catch {}

// Cache of RVC-converted sound clips — one file per (sound, voice) pair,
// so a clip only gets run through the conversion command once, then
// plays straight from disk on every subsequent play like any other sound.
const rvcConvertedDir = path.join(userDataPath, "rvc_converted");
try { fs.mkdirSync(rvcConvertedDir, { recursive: true }); } catch {}
const { exec, spawn } = require("child_process");

/* -----------------------------------------------------------------------
   Single instance lock — avoids duplicate windows and duplicate global
   hotkey registrations if the app gets launched twice.
   ----------------------------------------------------------------------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

/* -----------------------------------------------------------------------
   Window state persistence (size, position, maximized)
   ----------------------------------------------------------------------- */
function loadWindowState() {
  const defaults = { width: 1100, height: 750, x: undefined, y: undefined, maximized: false };
  try {
    const raw = fs.readFileSync(windowStatePath, "utf-8");
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return defaults;
  }
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const bounds = mainWindow.getBounds();
    const state = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      maximized: mainWindow.isMaximized(),
    };
    fs.writeFileSync(windowStatePath, JSON.stringify(state));
  } catch {
    // Non-critical — worst case, window position doesn't restore next launch.
  }
}

/* -----------------------------------------------------------------------
   Atomic JSON writes for sounds.json, with a rolling .bak copy so a
   crash mid-write can't silently wipe the library.
   ----------------------------------------------------------------------- */
function readSoundsFile() {
  if (!fs.existsSync(soundsConfigPath)) return [];
  try {
    const raw = fs.readFileSync(soundsConfigPath, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error("sounds.json is corrupt, attempting backup:", e);
    try {
      const rawBackup = fs.readFileSync(soundsBackupPath, "utf-8");
      const parsedBackup = JSON.parse(rawBackup);
      return Array.isArray(parsedBackup) ? parsedBackup : [];
    } catch {
      return [];
    }
  }
}

function writeSoundsFile(sounds) {
  const tmpPath = soundsConfigPath + ".tmp";
  try {
    if (fs.existsSync(soundsConfigPath)) {
      fs.copyFileSync(soundsConfigPath, soundsBackupPath);
    }
    fs.writeFileSync(tmpPath, JSON.stringify(sounds, null, 2));
    fs.renameSync(tmpPath, soundsConfigPath);
    return true;
  } catch (e) {
    console.error("Failed to save sounds.json:", e);
    try { fs.unlinkSync(tmpPath); } catch {}
    return false;
  }
}

/* -----------------------------------------------------------------------
   Settings persistence (device routing, mic mixer, playback preferences).
   These live in the app's Settings modal and, once toggled on, are meant
   to stay on across restarts until the person turns them off themselves —
   so every value here is just read back verbatim on next launch.
   ----------------------------------------------------------------------- */
const SETTINGS_DEFAULTS = {
  theme: "crimson",
  outputDevice: "",
  virtualMicDeviceId: "",
  micInputDeviceId: "",
  masterVolume: 80,
  micVolume: 100,
  noiseGateThreshold: 3,
  localMonitorEnabled: false,
  monitorMicFeedEnabled: false,
  micFxEnabled: false,
  duckEnabled: false,
  noiseGateEnabled: false,
  pushToTalkMode: false,
  stopOnOverlap: false,
  loopEnabled: false,
  queueMode: false,
  activeRvcVoice: null,
  // Which python executable to invoke — auto-picked per platform, but
  // editable in case the person's setup needs something else (a venv
  // path, "py -3.10", etc.).
  rvcPythonCommand: process.platform === "win32" ? "python" : "python3",
  // Command run once per sound clip being converted. Placeholders:
  // {python}, {input}, {output}, {model}, {index} (dropped entirely,
  // flag and all, for voices with no .index file — see buildRvcCommand).
  // Defaults to rvc-python, which the AI Voices Settings tab can install
  // automatically.
  rvcCommandTemplate: "{python} -m rvc_python cli -i {input} -o {output} -mp {model} -ip {index} -pi {pitch}",
};

function readSettingsFile() {
  try {
    const raw = fs.readFileSync(settingsConfigPath, "utf-8");
    const parsed = JSON.parse(raw);
    return { ...SETTINGS_DEFAULTS, ...(parsed && typeof parsed === "object" ? parsed : {}) };
  } catch {
    return { ...SETTINGS_DEFAULTS };
  }
}

function writeSettingsFile(settings) {
  const tmpPath = settingsConfigPath + ".tmp";
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2));
    fs.renameSync(tmpPath, settingsConfigPath);
    return true;
  } catch (e) {
    console.error("Failed to save settings.json:", e);
    try { fs.unlinkSync(tmpPath); } catch {}
    return false;
  }
}

/* -----------------------------------------------------------------------
   AI Voices (RVC) — model file helpers.
   A "voice" is identified by its file basename: <name>.pth is required,
   an optional matching <name>.index (the retrieval index some RVC models
   ship with) is picked up automatically if present alongside it.
   ----------------------------------------------------------------------- */
function listRvcVoices() {
  let files = [];
  try {
    files = fs.readdirSync(rvcVoicesDir);
  } catch {
    return [];
  }
  const byBase = new Map();
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (ext !== ".pth" && ext !== ".index") continue;
    const base = path.basename(f, ext);
    if (!byBase.has(base)) byBase.set(base, { name: base, pthPath: null, indexPath: null });
    const entry = byBase.get(base);
    const full = path.join(rvcVoicesDir, f);
    if (ext === ".pth") entry.pthPath = full;
    else entry.indexPath = full;
  }
  return [...byBase.values()]
    .filter((v) => v.pthPath) // a voice needs at least the model file
    .map((v) => {
      let sizeBytes = 0;
      try { sizeBytes = fs.statSync(v.pthPath).size; } catch {}
      return {
        id: v.name,
        name: v.name,
        hasIndex: !!v.indexPath,
        sizeMB: Math.round((sizeBytes / (1024 * 1024)) * 10) / 10,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function copyRvcFilesInto(filePaths) {
  for (const src of filePaths || []) {
    const ext = path.extname(src).toLowerCase();
    if (ext !== ".pth" && ext !== ".index") continue;
    try {
      const dest = path.join(rvcVoicesDir, path.basename(src));
      fs.copyFileSync(src, dest);
    } catch (e) {
      console.error("Failed to copy RVC voice file:", src, e);
    }
  }
}

/* -----------------------------------------------------------------------
   Window creation
   ----------------------------------------------------------------------- */
function createWindow() {
  const state = loadWindowState();

  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    transparent: false,
    backgroundColor: "#0a0404",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
    icon: path.join(__dirname, "assets", "icon.png"),
    show: false,
  });

  if (state.maximized) mainWindow.maximize();

  mainWindow.loadFile("index.html");

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  // --- Security hardening ---
  // This app never needs to open new windows or navigate away from its
  // own local index.html, so both are blocked. External links (if any
  // are ever added) get handed to the OS browser instead.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://")) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // --- Window state tracking ---
  const sendMaximizeState = () => {
    mainWindow?.webContents.send("window-state-changed", mainWindow.isMaximized());
  };
  mainWindow.on("maximize", sendMaximizeState);
  mainWindow.on("unmaximize", sendMaximizeState);
  mainWindow.on("resize", saveWindowState);
  mainWindow.on("move", saveWindowState);
  mainWindow.on("close", saveWindowState);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  app.setAppUserModelId("com.example.soundboard");
  createWindow();
  setupAutoUpdater();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Only tear down global hotkeys when the app is actually quitting — not
// just when the window closes (macOS keeps the app alive in the dock).
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

/* =========================================================================
   Window controls
   ========================================================================= */
ipcMain.on("window-minimize", () => mainWindow?.minimize());

ipcMain.on("window-maximize", () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});

ipcMain.on("window-close", () => mainWindow?.close());

ipcMain.handle("is-window-maximized", () => mainWindow?.isMaximized() ?? false);

ipcMain.handle("get-app-version", () => app.getVersion());

/* =========================================================================
   File dialog / filesystem helpers
   ========================================================================= */
ipcMain.handle("open-file-dialog", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "Audio Files", extensions: ["mp3", "wav", "ogg", "flac", "m4a", "aac", "opus", "webm", "aiff", "aif"] },
    ],
  });
  if (result.canceled) return [];
  return result.filePaths;
});

ipcMain.handle("show-in-folder", (_, filePath) => {
  if (typeof filePath === "string" && filePath.length > 0) {
    shell.showItemInFolder(filePath);
  }
});

/* =========================================================================
   Sounds persistence
   ========================================================================= */
ipcMain.handle("load-sounds", () => readSoundsFile());

ipcMain.handle("save-sounds", (_, sounds) => {
  if (!Array.isArray(sounds)) return { success: false, error: "Invalid data" };
  const ok = writeSoundsFile(sounds);
  return { success: ok };
});

/* =========================================================================
   Settings persistence
   ========================================================================= */
ipcMain.handle("load-settings", () => readSettingsFile());

ipcMain.handle("save-settings", (_, settings) => {
  if (!settings || typeof settings !== "object") return { success: false, error: "Invalid data" };
  const ok = writeSettingsFile({ ...SETTINGS_DEFAULTS, ...settings });
  return { success: ok };
});

/* =========================================================================
   AI Voices (RVC) — model file management.
   Purely organizational: stores .pth/.index files the person drops in and
   returns the current list, so the Appearance-tab-style picker in the
   renderer can show them. Actual voice conversion happens in a separate
   real-time RVC app; nothing here does any audio processing.
   ========================================================================= */
ipcMain.handle("list-rvc-voices", () => listRvcVoices());

ipcMain.handle("import-rvc-voice-files", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "RVC Model Files", extensions: ["pth", "index"] }],
  });
  if (result.canceled) return { success: true, voices: listRvcVoices() };
  copyRvcFilesInto(result.filePaths);
  return { success: true, voices: listRvcVoices() };
});

ipcMain.handle("import-rvc-voice-file-paths", (_, filePaths) => {
  copyRvcFilesInto(filePaths);
  return { success: true, voices: listRvcVoices() };
});

ipcMain.handle("delete-rvc-voice", (_, voiceId) => {
  try {
    const pth = path.join(rvcVoicesDir, voiceId + ".pth");
    const idx = path.join(rvcVoicesDir, voiceId + ".index");
    if (fs.existsSync(pth)) fs.unlinkSync(pth);
    if (fs.existsSync(idx)) fs.unlinkSync(idx);
  } catch (e) {
    return { success: false, error: e.message, voices: listRvcVoices() };
  }
  return { success: true, voices: listRvcVoices() };
});

ipcMain.handle("open-rvc-voices-folder", () => {
  shell.openPath(rvcVoicesDir);
});

// Splits an input file into vocals.wav / no_vocals.wav via demucs
// (--two-stems=vocals), returning both paths. demucs downloads its model
// weights on first use (~80MB, one-time).
function runDemucsSeparation(python, inputPath, workDir) {
  return new Promise((resolve, reject) => {
    const command = `${python} -m demucs --two-stems=vocals -o "${workDir}" "${inputPath}"`;
    console.log(`[RVC] Separating vocals: ${command}`);
    const proc = spawn(command, { shell: true, windowsHide: true });
    let stderrBuf = "";
    const forward = (d) => {
      const text = d.toString();
      console.log(`[RVC] ${text}`);
      mainWindow?.webContents.send("rvc-conversion-log", text);
    };
    proc.stdout.on("data", forward);
    proc.stderr.on("data", (d) => { stderrBuf += d.toString(); forward(d); });
    const timer = setTimeout(() => { proc.kill(); reject(new Error("Vocal separation timed out")); }, 600000);
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(stderrBuf.trim() || `demucs exited with code ${code}`)); return; }
      const base = path.basename(inputPath, path.extname(inputPath));
      const stemDir = path.join(workDir, "htdemucs", base);
      const vocals = path.join(stemDir, "vocals.wav");
      const noVocals = path.join(stemDir, "no_vocals.wav");
      if (!fs.existsSync(vocals) || !fs.existsSync(noVocals)) {
        reject(new Error("demucs ran but expected stem files weren't found"));
        return;
      }
      resolve({ vocals, noVocals });
    });
  });
}

// Mixes the RVC-converted vocals back with the untouched instrumental
// stem into one final file, via ffmpeg's amix filter.
function mixVocalsWithInstrumental(vocalsPath, instrumentalPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(vocalsPath)
      .input(instrumentalPath)
      .complexFilter(["[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=0[aout]"])
      .outputOptions("-map", "[aout]")
      .on("error", reject)
      .on("end", resolve)
      .save(outputPath);
  });
}

// Fills in {input}/{output}/{model}/{index} in the person's configured
// command. When a voice has no .index file, the entire preceding flag
// (e.g. "-ip {index}") is dropped rather than left as "-ip \"\"", since
// most RVC CLIs treat an empty index path as an error rather than "none".
function buildRvcCommand(template, { python, input, output, model, index, pitch }) {
  let command = template
    .split("{python}").join(python)
    .split("{input}").join(`"${input}"`)
    .split("{output}").join(`"${output}"`)
    .split("{model}").join(`"${model}"`)
    .split("{pitch}").join(String(pitch ?? 0));
  if (index) {
    command = command.split("{index}").join(`"${index}"`);
  } else {
    // Remove the whole preceding flag together with the placeholder (e.g.
    // "-ip {index}" -> ""), not just the placeholder — leaving a bare
    // "-ip" with no argument is what was breaking this before.
    command = command.replace(/\S+\s+\{index\}/, "").replace(/\s{2,}/g, " ").trim();
  }
  return command;
}

// Converts one sound file through the person's configured RVC command and
// caches the result under rvc_converted/<soundId>__<voiceId>.wav — so a
// given sound+voice pairing only runs the command once; every later play
// (or the Preview button) just reuses the cached file.
// Serializes conversion jobs so a background pre-conversion and a
// user-triggered Preview/Save never spawn two CPU-heavy python processes
// at once — each queued job waits for the previous one, success or not.
let rvcQueueTail = Promise.resolve();
function queueRvcJob(jobFn) {
  const result = rvcQueueTail.then(jobFn, jobFn);
  rvcQueueTail = result.then(() => {}, () => {});
  return result;
}

ipcMain.handle("convert-rvc-file", (_, args) => queueRvcJob(() => runRvcConversion(args)));

async function runRvcConversion({ inputPath, soundId, voiceId, pitch, separateVocals }) {
  const modelPath = path.join(rvcVoicesDir, voiceId + ".pth");
  const indexPath = path.join(rvcVoicesDir, voiceId + ".index");
  if (!fs.existsSync(modelPath)) {
    return { success: false, error: "Voice model file not found" };
  }
  if (!inputPath || !fs.existsSync(inputPath)) {
    return { success: false, error: "Sound file not found" };
  }
  const hasIndex = fs.existsSync(indexPath);
  // UI convention (see the AI Voice tab slider): negative = male-to-female
  // (raise pitch), positive = female-to-male (lower pitch). rvc-python's
  // -pi flag is the opposite (positive raises), so it's negated here —
  // this is the one place that mapping lives.
  const uiPitch = Math.round(pitch || 0);
  const cliPitch = -uiPitch;
  const outputPath = path.join(
    rvcConvertedDir,
    `${soundId}__${voiceId}__${uiPitch}${separateVocals ? "_sep" : ""}.wav`
  );

  if (fs.existsSync(outputPath)) {
    return { success: true, outputPath, cached: true };
  }

  const python = readSettingsFile().rvcPythonCommand || SETTINGS_DEFAULTS.rvcPythonCommand;
  // Vocal separation is cached per SOUND (not per voice/pitch/job) and kept
  // permanently, since the same isolated vocals track is reusable no matter
  // which voice or pitch is applied afterward — this is the slow step, so
  // skipping it on repeat conversions of the same sound is the big win.
  const separatedDir = path.join(rvcConvertedDir, "separated", soundId);
  const scratchDir = path.join(rvcConvertedDir, `job_${soundId}_${Date.now()}`);

  try {
    const settings = readSettingsFile();
    const template = settings.rvcCommandTemplate || SETTINGS_DEFAULTS.rvcCommandTemplate;

    let rvcInputPath = inputPath;
    let noVocalsPath = null;

    if (separateVocals) {
      const cachedVocals = path.join(separatedDir, "vocals.wav");
      const cachedNoVocals = path.join(separatedDir, "no_vocals.wav");
      if (fs.existsSync(cachedVocals) && fs.existsSync(cachedNoVocals)) {
        console.log(`[RVC] Reusing cached vocal separation for ${soundId}`);
        rvcInputPath = cachedVocals;
        noVocalsPath = cachedNoVocals;
      } else {
        fs.mkdirSync(scratchDir, { recursive: true });
        const { vocals, noVocals } = await runDemucsSeparation(python, inputPath, scratchDir);
        fs.mkdirSync(separatedDir, { recursive: true });
        fs.copyFileSync(vocals, cachedVocals);
        fs.copyFileSync(noVocals, cachedNoVocals);
        fs.rmSync(scratchDir, { recursive: true, force: true });
        rvcInputPath = cachedVocals;
        noVocalsPath = cachedNoVocals;
      }
    }

    const convertedVocalsPath = separateVocals
      ? path.join(rvcConvertedDir, `${soundId}__${voiceId}__${uiPitch}_vocals_only.wav`)
      : outputPath;

    const command = buildRvcCommand(template, {
      python,
      input: rvcInputPath,
      output: convertedVocalsPath,
      model: modelPath,
      index: hasIndex ? indexPath : "",
      pitch: cliPitch,
    });

    await new Promise((resolve, reject) => {
      // A full clip can take a while depending on length/hardware — give
      // this more room than a live chunk would ever need.
      console.log(`[RVC] Converting: ${command}`);
      const proc = spawn(command, { shell: true, windowsHide: true });
      let stderrBuf = "";

      const forward = (data) => {
        const text = data.toString();
        console.log(`[RVC] ${text}`);
        mainWindow?.webContents.send("rvc-conversion-log", text);
      };
      proc.stdout.on("data", forward);
      proc.stderr.on("data", (d) => { stderrBuf += d.toString(); forward(d); });

      // CPU-only inference (no GPU) can legitimately take several minutes
      // for a longer clip — model loading alone can take 30s+. 10 minutes
      // gives real conversions room without waiting forever on a genuinely
      // stuck process.
      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error("Conversion timed out after 10 minutes"));
      }, 600000);

      proc.on("error", (e) => { clearTimeout(timer); reject(e); });
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(stderrBuf.trim() || `Command exited with code ${code}`));
      });
    });

    if (!fs.existsSync(convertedVocalsPath)) {
      throw new Error("Command ran but produced no output file — check the RVC command template");
    }

    if (separateVocals) {
      await mixVocalsWithInstrumental(convertedVocalsPath, noVocalsPath, outputPath);
      try { fs.unlinkSync(convertedVocalsPath); } catch {}
    }

    return { success: true, outputPath, cached: false };
  } catch (e) {
    try { fs.unlinkSync(outputPath); } catch {}
    if (fs.existsSync(scratchDir)) { try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch {} }
    console.error("RVC conversion failed:", e);
    return { success: false, error: e.message };
  }
}


ipcMain.handle("clear-rvc-conversion", (_, { soundId, voiceId, pitch, separateVocals }) => {
  try {
    const uiPitch = Math.round(pitch || 0);
    const outputPath = path.join(
      rvcConvertedDir,
      `${soundId}__${voiceId}__${uiPitch}${separateVocals ? "_sep" : ""}.wav`
    );
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Checks whether python and the rvc-python package are available, so the
// AI Voices Settings tab can show "Ready" / "Needs setup" instead of the
// person only finding out when a conversion fails.
ipcMain.handle("check-rvc-backend", async () => {
  const settings = readSettingsFile();
  const python = settings.rvcPythonCommand || SETTINGS_DEFAULTS.rvcPythonCommand;

  const pythonFound = await new Promise((resolve) => {
    exec(`${python} --version`, { windowsHide: true }, (err) => resolve(!err));
  });
  if (!pythonFound) {
    return { pythonFound: false, rvcInstalled: false };
  }
  const rvcInstalled = await new Promise((resolve) => {
    exec(`${python} -m pip show rvc-python`, { windowsHide: true }, (err) => resolve(!err));
  });
  return { pythonFound: true, rvcInstalled };
});

// One-click setup: installs/updates rvc-python via pip, streaming progress
// lines back to the renderer so this doesn't feel like dropping to a
// terminal — the app manages its own backend.
ipcMain.handle("install-rvc-backend", async () => {
  const settings = readSettingsFile();
  const python = settings.rvcPythonCommand || SETTINGS_DEFAULTS.rvcPythonCommand;

  const pythonFound = await new Promise((resolve) => {
    exec(`${python} --version`, { windowsHide: true }, (err) => resolve(!err));
  });
  if (!pythonFound) {
    return {
      success: false,
      error: `"${python}" wasn't found. Install Python first, then try again (adjust the python command in AI Voices if yours is named differently).`,
    };
  }

  return new Promise((resolve) => {
    const proc = spawn(python, ["-m", "pip", "install", "--upgrade", "rvc-python", "demucs"], { windowsHide: true });
    proc.stdout.on("data", (d) => mainWindow?.webContents.send("rvc-backend-log", d.toString()));
    proc.stderr.on("data", (d) => mainWindow?.webContents.send("rvc-backend-log", d.toString()));
    proc.on("error", (e) => resolve({ success: false, error: e.message }));
    proc.on("close", (code) => {
      if (code === 0) resolve({ success: true });
      else resolve({ success: false, error: `pip install exited with code ${code}` });
    });
  });
});

/* =========================================================================
   YouTube import (meme-sound grabbing) — fetch metadata, then download the
   audio track, cut it to the requested range, auto-trim silence at the
   edges, and hand back an mp3 the renderer can add as a normal sound.
   ========================================================================= */
function parseTimeToSeconds(str) {
  if (!str || typeof str !== "string" || !str.trim()) return null;
  const parts = str.trim().split(":").map(Number);
  if (parts.some((p) => Number.isNaN(p))) return null;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

/* ---- YouTube cookie management ---- */
ipcMain.handle("youtube-cookies-status", () => getYtCookieStatus());

ipcMain.handle("youtube-cookies-import-file", async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Select a Netscape-format cookies.txt",
      properties: ["openFile"],
      filters: [{ name: "Cookies (cookies.txt)", extensions: ["txt"] }, { name: "All files", extensions: ["*"] }],
    });
    if (result.canceled || !result.filePaths.length) return { success: false, canceled: true };

    const raw = fs.readFileSync(result.filePaths[0], "utf8");
    const kept = filterNetscapeCookies(raw);
    if (!kept.length) {
      return {
        success: false,
        error: "No YouTube/Google cookies found in that file. Export a Netscape-format cookies.txt while signed in to YouTube.",
      };
    }
    fs.writeFileSync(ytCookiesFilePath, "# Netscape HTTP Cookie File\n" + kept.join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
    writeYtCookieConfig({ mode: "file", browser: "" });
    return { success: true, status: getYtCookieStatus() };
  } catch (e) {
    console.error("youtube-cookies-import-file failed:", e);
    return { success: false, error: e?.message || "Couldn't import that cookies file" };
  }
});

ipcMain.handle("youtube-cookies-use-browser", (_, browser) => {
  if (!YT_COOKIE_BROWSERS.includes(browser)) return { success: false, error: "Unsupported browser" };
  writeYtCookieConfig({ mode: "browser", browser });
  return { success: true, status: getYtCookieStatus() };
});

ipcMain.handle("youtube-cookies-clear", () => {
  try { fs.unlinkSync(ytCookiesFilePath); } catch {}
  writeYtCookieConfig({ mode: "none", browser: "" });
  return { success: true, status: getYtCookieStatus() };
});

ipcMain.handle("youtube-get-info", async (_, url) => {
  try {
    if (!url || !YOUTUBE_URL_RE.test(url)) {
      return { success: false, error: "That doesn't look like a valid YouTube URL" };
    }
    const exePath = await ensureYtDlp();
    const json = await runYtDlpJson(exePath, url);
    return {
      success: true,
      title: json.title,
      author: json.uploader || json.channel || "",
      durationSeconds: Math.round(json.duration || 0),
    };
  } catch (e) {
    console.error("youtube-get-info failed:", e);
    return { success: false, error: e?.message || "Couldn't load that video — it may be private, age-restricted, or unavailable." };
  }
});

ipcMain.handle("youtube-import", async (_, payload) => {
  const { url, name, start, end, autoTrim } = payload || {};
  let tempAudioPath = null;
  try {
    if (!url || !YOUTUBE_URL_RE.test(url)) {
      return { success: false, error: "That doesn't look like a valid YouTube URL" };
    }

    const startSec = parseTimeToSeconds(start);
    const endSec = parseTimeToSeconds(end);
    if (start && startSec == null) return { success: false, error: "Start time should look like mm:ss" };
    if (end && endSec == null) return { success: false, error: "End time should look like mm:ss" };
    if (startSec != null && endSec != null && endSec <= startSec) {
      return { success: false, error: "End time must be after start time" };
    }

    const exePath = await ensureYtDlp();
    const id = "yt_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
    const outPath = path.join(importedSoundsDir, id + ".mp3");
    const tempBase = path.join(importedSoundsDir, `${id}_src`);

    await runYtDlpDownload(exePath, url, `${tempBase}.%(ext)s`);

    const producedFile = fs.readdirSync(importedSoundsDir).find((f) => f.startsWith(`${id}_src.`));
    if (!producedFile) throw new Error("Download finished but no audio file was produced");
    tempAudioPath = path.join(importedSoundsDir, producedFile);

    await new Promise((resolve, reject) => {
      let command = ffmpeg(tempAudioPath).audioBitrate(128).format("mp3");

      if (startSec != null && startSec > 0) command = command.setStartTime(startSec);
      if (endSec != null) {
        const clipDuration = startSec != null ? endSec - startSec : endSec;
        command = command.setDuration(Math.max(0.1, clipDuration));
      }

      // Auto-trim: strip near-silence from the head and tail so grabbed
      // clips don't carry a chunk of dead air before/after the punchline.
      // (The reverse/re-reverse pair trims the tail using the same filter
      // that natively only trims the head.)
      if (autoTrim) {
        command = command.audioFilters([
          "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.15:detection=peak",
          "areverse",
          "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.15:detection=peak",
          "areverse",
        ]);
      }

      command.on("error", reject).on("end", resolve).save(outPath);
    });

    return { success: true, filePath: outPath, name: (name || "Imported clip").trim() };
  } catch (e) {
    console.error("youtube-import failed:", e);
    return { success: false, error: e?.message || "Import failed for an unknown reason" };
  } finally {
    if (tempAudioPath) { try { fs.unlinkSync(tempAudioPath); } catch {} }
  }
});

/* =========================================================================
   Global hotkeys
   ========================================================================= */
const registeredHotkeys = new Map();

ipcMain.handle("register-hotkey", (_, { id, accelerator }) => {
  if (registeredHotkeys.has(id)) {
    try { globalShortcut.unregister(registeredHotkeys.get(id)); } catch {}
    registeredHotkeys.delete(id);
  }
  if (!accelerator) return { success: true };
  try {
    const ok = globalShortcut.register(accelerator, () => {
      mainWindow?.webContents.send("hotkey-triggered", id);
    });
    if (ok) {
      registeredHotkeys.set(id, accelerator);
      return { success: true };
    }
    return { success: false, error: "Hotkey already in use" };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle("unregister-hotkey", (_, id) => {
  if (registeredHotkeys.has(id)) {
    try { globalShortcut.unregister(registeredHotkeys.get(id)); } catch {}
    registeredHotkeys.delete(id);
  }
});
