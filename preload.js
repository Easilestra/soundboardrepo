"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  // Files / dialogs
  openFileDialog: () => ipcRenderer.invoke("open-file-dialog"),
  showInFolder: (filePath) => ipcRenderer.invoke("show-in-folder", filePath),

  // Sounds persistence
  loadSounds: () => ipcRenderer.invoke("load-sounds"),
  saveSounds: (sounds) => ipcRenderer.invoke("save-sounds", sounds),

  // Settings persistence (device routing, mic mixer, playback prefs)
  loadSettings: () => ipcRenderer.invoke("load-settings"),
  saveSettings: (settings) => ipcRenderer.invoke("save-settings", settings),

  // AI Voices (RVC) — model file management only; conversion runs in a
  // separate real-time RVC app.
  listRvcVoices: () => ipcRenderer.invoke("list-rvc-voices"),
  importRvcVoiceFiles: () => ipcRenderer.invoke("import-rvc-voice-files"),
  importRvcVoiceFilePaths: (filePaths) => ipcRenderer.invoke("import-rvc-voice-file-paths", filePaths),
  deleteRvcVoice: (voiceId) => ipcRenderer.invoke("delete-rvc-voice", voiceId),
  openRvcVoicesFolder: () => ipcRenderer.invoke("open-rvc-voices-folder"),
  convertRvcFile: (inputPath, soundId, voiceId, pitch, separateVocals) =>
    ipcRenderer.invoke("convert-rvc-file", { inputPath, soundId, voiceId, pitch, separateVocals }),
  clearRvcConversion: (soundId, voiceId, pitch, separateVocals) =>
    ipcRenderer.invoke("clear-rvc-conversion", { soundId, voiceId, pitch, separateVocals }),
  checkRvcBackend: () => ipcRenderer.invoke("check-rvc-backend"),
  installRvcBackend: () => ipcRenderer.invoke("install-rvc-backend"),
  onRvcBackendLog: (callback) =>
    ipcRenderer.on("rvc-backend-log", (_, line) => callback(line)),
  onRvcConversionLog: (callback) =>
    ipcRenderer.on("rvc-conversion-log", (_, line) => callback(line)),

  // YouTube import (meme-sound grabbing)
  getYoutubeInfo: (url) => ipcRenderer.invoke("youtube-get-info", url),
  importYoutubeClip: (payload) => ipcRenderer.invoke("youtube-import", payload),
  getYoutubeCookieStatus: () => ipcRenderer.invoke("youtube-cookies-status"),
  importYoutubeCookiesFile: () => ipcRenderer.invoke("youtube-cookies-import-file"),
  useYoutubeCookiesFromBrowser: (browser) => ipcRenderer.invoke("youtube-cookies-use-browser", browser),
  clearYoutubeCookies: () => ipcRenderer.invoke("youtube-cookies-clear"),

  // Hotkeys
  registerHotkey: (data) => ipcRenderer.invoke("register-hotkey", data),
  unregisterHotkey: (id) => ipcRenderer.invoke("unregister-hotkey", id),
  onHotkeyTriggered: (callback) =>
    ipcRenderer.on("hotkey-triggered", (_, id) => callback(id)),

  // Window controls
  windowMinimize: () => ipcRenderer.send("window-minimize"),
  windowMaximize: () => ipcRenderer.send("window-maximize"),
  windowClose: () => ipcRenderer.send("window-close"),
  isWindowMaximized: () => ipcRenderer.invoke("is-window-maximized"),
  onWindowStateChanged: (callback) =>
    ipcRenderer.on("window-state-changed", (_, isMaximized) => callback(isMaximized)),

  // Misc
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
});
