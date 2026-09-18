"use strict";

/* =========================================================================
   STATE
   ========================================================================= */
let sounds = [];
let playingNodes = {};
let bufferCache = new Map();
const BUFFER_CACHE_MAX = 80;
function cacheBufferGet(key) {
  if (!bufferCache.has(key)) return undefined;
  // Bump recency: delete + re-set moves this entry to the end of Map's
  // insertion order, which is what the eviction loop below reads from.
  const val = bufferCache.get(key);
  bufferCache.delete(key);
  bufferCache.set(key, val);
  return val;
}
function cacheBufferSet(key, val) {
  bufferCache.set(key, val);
  while (bufferCache.size > BUFFER_CACHE_MAX) {
    bufferCache.delete(bufferCache.keys().next().value);
  }
}
let audioCtx = null;

let monitorGain = null;
let micSendGain = null;
let micMakeupGain = null;
let micHighpass, micLowShelf, micMidPeak, micHighShelf, micCompressor;
let virtualMicDest = null;
let virtualMicStream = null;

let liveMicStream = null;
let liveMicSource = null;
let micGateGain = null;
let micMuteGain = null;
let micMeterAnalyser = null;
let micGateAnalyser = null;
let meterLoopStarted = false;

let outputDevice = "";
let virtualMicDeviceId = "";
let micInputDeviceId = "";
let localMonitorEnabled = false;
let monitorMicFeedEnabled = false;
let micFxEnabled = false;
let duckEnabled = false;
let duckAmount = 0.35;

let noiseGateEnabled = false;
let noiseGateThreshold = 0.03;
let micMuted = false;
let pushToTalkMode = false;

// AI Voice (RVC) conversion is applied per sound clip (see Edit Sound
// modal), not to the live mic. editingRvcVoice tracks the in-progress
// selection while the Edit modal is open, saved to sound.rvcVoice on Save.
let editingRvcVoice = null;
let editingRvcPitch = 0;
let editingRvcSeparate = false;
let rvcPreviewAudio = null;

let stopOnOverlap = false;
let loopEnabled = false;
let queueMode = false;
let queue = [];
let queuePlaying = false;

let editingId = null;
let recordingHotkey = false;
let currentCategory = "";
let trashBin = null;
let previewNode = null;
let saveTimer = null;

// Persisted app settings (device routing, mic mixer, playback prefs) —
// loaded once at boot, then kept in sync with the Settings modal.
let appSettings = {};
let settingsSaveTimer = null;

let collapsedCategories = new Set();
try {
  collapsedCategories = new Set(JSON.parse(localStorage.getItem("soundboard:collapsedCategories") || "[]"));
} catch {}

// Which theme-picker groups (dark/light) are collapsed in the Appearance
// tab. Both start expanded; collapsing one is remembered across launches
// the same way collapsed sound categories are.
let collapsedThemeGroups = new Set();
try {
  collapsedThemeGroups = new Set(JSON.parse(localStorage.getItem("soundboard:collapsedThemeGroups") || "[]"));
} catch {}

const COLORS = [
  "#a78bfa", "#60a5fa", "#34d399", "#fb923c", "#f472b6", "#facc15",
  "#f87171", "#38bdf8", "#a3e635", "#c084fc", "#fb7185", "#4ade80",
];

// Every theme defined in style.css, grouped by mode so the Appearance tab
// can render a "Dark themes" section and a "Light themes" section with a
// divider between them instead of one flat grid. swatch mirrors each
// theme's --gradient value from style.css.
// Must match SETTINGS_DEFAULTS.rvcCommandTemplate in main.js — used to
// pre-fill the Command Template field and for the Reset button.
const RVC_DEFAULT_COMMAND_TEMPLATE = "{python} -m rvc_python cli -i {input} -o {output} -mp {model} -ip {index}";

const THEMES = [
  // --- Dark themes ---
  { id: "crimson",    name: "Crimson",    mode: "dark",  swatch: "linear-gradient(135deg, #ef4444, #b91c1c)" },
  { id: "violet",     name: "Violet",     mode: "dark",  swatch: "linear-gradient(135deg, #a78bfa, #7c3aed)" },
  { id: "ocean",      name: "Ocean",      mode: "dark",  swatch: "linear-gradient(135deg, #38bdf8, #0284c7)" },
  { id: "emerald",    name: "Emerald",    mode: "dark",  swatch: "linear-gradient(135deg, #34d399, #059669)" },
  { id: "sunset",     name: "Sunset",     mode: "dark",  swatch: "linear-gradient(135deg, #fb923c, #c2410c)" },
  { id: "rose",       name: "Rose",       mode: "dark",  swatch: "linear-gradient(135deg, #fb7185, #e11d48)" },
  { id: "indigo",     name: "Indigo",     mode: "dark",  swatch: "linear-gradient(135deg, #818cf8, #4f46e5)" },
  { id: "teal",       name: "Teal",       mode: "dark",  swatch: "linear-gradient(135deg, #2dd4bf, #0d9488)" },
  { id: "amber",      name: "Amber",      mode: "dark",  swatch: "linear-gradient(135deg, #fbbf24, #d97706)" },
  { id: "slate",      name: "Slate",      mode: "dark",  swatch: "linear-gradient(135deg, #94a3b8, #475569)" },
  { id: "magma",      name: "Magma",      mode: "dark",  swatch: "linear-gradient(135deg, #ff7849, #c2340a)" },
  { id: "cyberpunk",  name: "Cyberpunk",  mode: "dark",  swatch: "linear-gradient(135deg, #f472b6, #a21caf 55%, #0891b2)" },
  { id: "forest",     name: "Forest",     mode: "dark",  swatch: "linear-gradient(135deg, #84cc16, #3f6212)" },
  { id: "midnight",   name: "Midnight",   mode: "dark",  swatch: "linear-gradient(135deg, #60a5fa, #1d4ed8)" },
  { id: "plum",       name: "Plum",       mode: "dark",  swatch: "linear-gradient(135deg, #c084fc, #7e22ce)" },
  { id: "copper",     name: "Copper",     mode: "dark",  swatch: "linear-gradient(135deg, #d99a6c, #9a5228)" },
  { id: "aurora",     name: "Aurora",     mode: "dark",  swatch: "linear-gradient(135deg, #86efac, #22d3ee 45%, #a78bfa)" },
  { id: "bloodmoon",  name: "Bloodmoon",  mode: "dark",  swatch: "linear-gradient(135deg, #e85d04, #9d0208)" },
  { id: "neonlime",   name: "Neon Lime",  mode: "dark",  swatch: "linear-gradient(135deg, #d9f99d, #65a30d)" },
  { id: "graphite",   name: "Graphite",   mode: "dark",  swatch: "linear-gradient(135deg, #d1d5db, #6b7280)" },
  // --- Light themes (one paired to each dark theme above, so the two
  //     groups in the Appearance tab always show equal counts) ---
  { id: "daylight",    name: "Daylight",     mode: "light", swatch: "linear-gradient(135deg, #f4845f, #e4572e)" },
  { id: "lavender",    name: "Lavender",     mode: "light", swatch: "linear-gradient(135deg, #c4b5fd, #7c3aed)" },
  { id: "sky",         name: "Sky",          mode: "light", swatch: "linear-gradient(135deg, #48bff4, #0d9ddd)" },
  { id: "mint",        name: "Mint",         mode: "light", swatch: "linear-gradient(135deg, #4df0ba, #13d897)" },
  { id: "coral",       name: "Coral",        mode: "light", swatch: "linear-gradient(135deg, #e45858, #ca2121)" },
  { id: "blush",       name: "Blush",        mode: "light", swatch: "linear-gradient(135deg, #fd663f, #e83202)" },
  { id: "periwinkle",  name: "Periwinkle",   mode: "light", swatch: "linear-gradient(135deg, #4d51ef, #1317d7)" },
  { id: "seafoam",     name: "Seafoam",      mode: "light", swatch: "linear-gradient(135deg, #5eead4, #0f766e)" },
  { id: "sunbeam",     name: "Sunbeam",      mode: "light", swatch: "linear-gradient(135deg, #fcd34d, #d97706)" },
  { id: "cloud",       name: "Cloud",        mode: "light", swatch: "linear-gradient(135deg, #6e95cf, #356ab6)" },
  { id: "peach",       name: "Peach",        mode: "light", swatch: "linear-gradient(135deg, #ff673d, #eb3300)" },
  { id: "candy",       name: "Candy",        mode: "light", swatch: "linear-gradient(135deg, #ed4f9d, #d51674)" },
  { id: "sage",        name: "Sage",         mode: "light", swatch: "linear-gradient(135deg, #a9ea52, #82d119)" },
  { id: "powderblue",  name: "Powder Blue",  mode: "light", swatch: "linear-gradient(135deg, #4689f6, #0a5ce0)" },
  { id: "blossom",     name: "Blossom",      mode: "light", swatch: "linear-gradient(135deg, #f9a8d4, #be185d)" },
  { id: "orchid",      name: "Orchid",       mode: "light", swatch: "linear-gradient(135deg, #a046f6, #780be0)" },
  { id: "sand",        name: "Sand",         mode: "light", swatch: "linear-gradient(135deg, #d1926c, #b66635)" },
  { id: "aqua",        name: "Aqua",         mode: "light", swatch: "linear-gradient(135deg, #4bdbf1, #11bfda)" },
  { id: "citrus",      name: "Citrus",       mode: "light", swatch: "linear-gradient(135deg, #b0ea53, #8cd11a)" },
  { id: "linen",       name: "Linen",        mode: "light", swatch: "linear-gradient(135deg, #6e91cf, #3564b6)" },
];

/* =========================================================================
   VOICE FX PRESETS
   rate       — playback speed → pitch
   low/high   — shelf EQ gain (dB), gives the "character"
   ring       — ring-modulation (robot/demon buzz)
   bandpass   — { low, high } cutoffs, narrows the band (telephone/radio)
   lowpassFreq— single lowpass cutoff (muffled/underwater)
   distortion — waveshaper drive amount (grit/demon growl)
   delay      — { time, feedback, mix } echo effect (ghost/echo)
   volumeMult — extra gain multiplier baked into the preset (whisper is quieter)
   ========================================================================= */
const VOICE_PRESETS = {
  normal:     { rate: 1.00, low: 0,  high: 0,  ring: false },
  deep:       { rate: 0.75, low: 7,  high: -5, ring: false },
  male:       { rate: 0.88, low: 4,  high: -2, ring: false },
  female:     { rate: 1.22, low: -3, high: 4,  ring: false },
  chipmunk:   { rate: 1.65, low: -6, high: 7,  ring: false },
  helium:     { rate: 2.00, low: -8, high: 9,  ring: false },
  baby:       { rate: 1.80, low: -5, high: 6,  ring: false },
  giant:      { rate: 0.60, low: 9,  high: -7, ring: false },
  demon:      { rate: 0.65, low: 8,  high: -4, ring: true, ringFreq: 14, distortion: 18 },
  robot:      { rate: 1.00, low: 0,  high: 2,  ring: true, ringFreq: 32 },
  alien:      { rate: 1.15, low: -2, high: 3,  ring: true, ringFreq: 55, distortion: 6 },
  telephone:  { rate: 1.00, low: 0,  high: 0,  ring: false, bandpass: { low: 300, high: 3400 } },
  radio:      { rate: 1.00, low: 0,  high: 0,  ring: false, bandpass: { low: 500, high: 2600 }, distortion: 10 },
  underwater: { rate: 0.95, low: 3,  high: -6, ring: false, lowpassFreq: 800 },
  ghost:      { rate: 0.85, low: 2,  high: 1,  ring: false, delay: { time: 0.22, feedback: 0.35, mix: 0.4 } },
  echo:       { rate: 1.00, low: 0,  high: 0,  ring: false, delay: { time: 0.18, feedback: 0.3, mix: 0.35 } },
  whisper:    { rate: 1.05, low: -4, high: 5,  ring: false, volumeMult: 0.6 },
};

const AUDIO_EXTENSIONS = ["mp3", "wav", "ogg", "flac", "m4a", "aac", "opus", "webm", "aiff", "aif"];

/* =========================================================================
   BOOT
   ========================================================================= */
window.addEventListener("DOMContentLoaded", async () => {
  await loadAppSettings();
  applyTheme(appSettings.theme);
  await initAudio();
  await loadDevices();
  await loadSounds();
  bindUI();
  bindHotkeyListener();
  bindKeyboardShortcuts();
  bindModalTabs();
  bindVoicePresets();
  bindWindowStateSync();
  bindDragAndDrop();
  bindSettingsModal();
  bindYoutubeImportModal();
  await loadAppVersion();
  updateEmptyState();
});

/* =========================================================================
   APP SETTINGS
   Everything the person configures in the Settings modal — device
   selection, mic mixer toggles, and playback toggles — is persisted here
   so it stays exactly as they left it until they change it again.
   ========================================================================= */
async function loadAppSettings() {
  try {
    appSettings = (await window.electronAPI.loadSettings()) || {};
  } catch {
    appSettings = {};
  }
}
function saveAppSettingsDebounced() {
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(() => {
    window.electronAPI.saveSettings(appSettings);
  }, 300);
}
function updateSetting(key, value) {
  appSettings[key] = value;
  saveAppSettingsDebounced();
}
function applyTheme(themeId) {
  const theme = THEMES.find((t) => t.id === themeId) || THEMES.find((t) => t.id === "crimson");
  document.documentElement.dataset.theme = theme.id;
  document.documentElement.dataset.mode = theme.mode;
  try { redrawAllWaveforms(); } catch {}
}

/* =========================================================================
   AUDIO ENGINE
   ========================================================================= */
async function initAudio() {
  audioCtx = new AudioContext({ latencyHint: "interactive" });

  monitorGain = audioCtx.createGain();
  monitorGain.gain.value = 0.8;

  micSendGain = audioCtx.createGain();
  micSendGain.gain.value = 1;

  micMakeupGain = audioCtx.createGain();
  micMakeupGain.gain.value = 1.0;

  micHighpass = audioCtx.createBiquadFilter();
  micHighpass.type = "highpass";
  micHighpass.frequency.value = 40;

  micLowShelf = audioCtx.createBiquadFilter();
  micLowShelf.type = "lowshelf";
  micLowShelf.frequency.value = 200;
  micLowShelf.gain.value = 0;

  micMidPeak = audioCtx.createBiquadFilter();
  micMidPeak.type = "peaking";
  micMidPeak.frequency.value = 1500;
  micMidPeak.Q.value = 0.9;
  micMidPeak.gain.value = 0;

  micHighShelf = audioCtx.createBiquadFilter();
  micHighShelf.type = "highshelf";
  micHighShelf.frequency.value = 6000;
  micHighShelf.gain.value = 0;

  micCompressor = audioCtx.createDynamicsCompressor();
  micCompressor.threshold.value = -18;
  micCompressor.knee.value = 20;
  micCompressor.ratio.value = 4;
  micCompressor.attack.value = 0.003;
  micCompressor.release.value = 0.25;

  virtualMicDest = audioCtx.createMediaStreamDestination();
  rebuildMicChain();
}

function rebuildMicChain() {
  [micSendGain, micHighpass, micLowShelf, micMidPeak, micHighShelf, micCompressor, micMakeupGain].forEach((n) => {
    try { n.disconnect(); } catch {}
  });
  if (micFxEnabled) {
    micSendGain.connect(micHighpass).connect(micLowShelf).connect(micMidPeak)
      .connect(micHighShelf).connect(micCompressor).connect(micMakeupGain).connect(virtualMicDest);
    micMakeupGain.gain.value = 1.6;
  } else {
    micSendGain.connect(micMakeupGain).connect(virtualMicDest);
    micMakeupGain.gain.value = 1.0;
  }
  refreshMonitorRouting();
}

function setLocalMonitorEnabled(enabled) {
  localMonitorEnabled = enabled;
  refreshMonitorRouting();
}
function setMonitorMicFeed(enabled) {
  monitorMicFeedEnabled = enabled;
  refreshMonitorRouting();
}
function refreshMonitorRouting() {
  if (!audioCtx) return;
  try { monitorGain.disconnect(audioCtx.destination); } catch {}
  try { micMakeupGain.disconnect(audioCtx.destination); } catch {}
  if (!localMonitorEnabled) return;
  if (monitorMicFeedEnabled) micMakeupGain.connect(audioCtx.destination);
  else monitorGain.connect(audioCtx.destination);
}

async function applyOutputSink() {
  if (typeof audioCtx.setSinkId === "function" && outputDevice) {
    try { await audioCtx.setSinkId(outputDevice); } catch (e) { console.warn("setSinkId (ctx) failed:", e); }
  }
}

async function connectVirtualMic() {
  if (!virtualMicDest) return;
  if (!virtualMicStream) {
    virtualMicStream = new Audio();
    virtualMicStream.srcObject = virtualMicDest.stream;
    virtualMicStream.volume = 1;
    virtualMicStream.play().catch(() => {});
  }
  if (virtualMicDeviceId && virtualMicStream.setSinkId) {
    try { await virtualMicStream.setSinkId(virtualMicDeviceId); }
    catch (e) { console.warn("setSinkId (mic) failed:", e); }
  }
}

/* =========================================================================
   LIVE MICROPHONE
   ========================================================================= */
async function connectLiveMic(deviceId) {
  try { liveMicStream?.getTracks().forEach((t) => t.stop()); } catch {}
  try { liveMicSource?.disconnect(); } catch {}

  try {
    liveMicStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (e) {
    console.warn("Could not open live mic:", e);
    showToast("⚠️ Could not access microphone");
    return;
  }

  liveMicSource = audioCtx.createMediaStreamSource(liveMicStream);

  micGateGain = micGateGain || audioCtx.createGain();
  micMuteGain = micMuteGain || audioCtx.createGain();
  micGateGain.gain.value = 1;
  micMuteGain.gain.value = micMuted ? 0 : 1;

  try { micGateGain.disconnect(); } catch {}
  try { micMuteGain.disconnect(); } catch {}

  liveMicSource.connect(micGateGain).connect(micMuteGain).connect(micSendGain);

  setupMicMeter();
  setupNoiseGate();
}

function setMicMuted(muted) {
  micMuted = muted;
  micMuteGain?.gain.setTargetAtTime(muted ? 0 : 1, audioCtx.currentTime, 0.01);
  document.getElementById("mic-mute-toggle")?.classList.toggle("active", muted);
}

function setupMicMeter() {
  if (!liveMicSource) return;
  micMeterAnalyser = audioCtx.createAnalyser();
  micMeterAnalyser.fftSize = 512;
  liveMicSource.connect(micMeterAnalyser);
  if (meterLoopStarted) return;
  meterLoopStarted = true;
  const data = new Uint8Array(micMeterAnalyser.frequencyBinCount);
  (function tick() {
    if (micMeterAnalyser) {
      micMeterAnalyser.getByteTimeDomainData(data);
      let peak = 0;
      for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i] - 128));
      const fill = document.getElementById("mic-vu-fill");
      if (fill) fill.style.width = Math.min(100, (peak / 128) * 100) + "%";
    }
    requestAnimationFrame(tick);
  })();
}

function setupNoiseGate() {
  if (!liveMicSource) return;
  micGateAnalyser = audioCtx.createAnalyser();
  micGateAnalyser.fftSize = 1024;
  liveMicSource.connect(micGateAnalyser);
  const data = new Float32Array(micGateAnalyser.fftSize);
  (function poll() {
    if (noiseGateEnabled && micGateGain && micGateAnalyser) {
      micGateAnalyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length);
      micGateGain.gain.setTargetAtTime(rms > noiseGateThreshold ? 1 : 0, audioCtx.currentTime, 0.03);
    } else if (micGateGain && micGateGain.gain.value !== 1 && !noiseGateEnabled) {
      micGateGain.gain.setTargetAtTime(1, audioCtx.currentTime, 0.03);
    }
    requestAnimationFrame(poll);
  })();
}

/* =========================================================================
   DEVICES
   ========================================================================= */
async function loadDevices() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
  } catch {}

  const devices = await navigator.mediaDevices.enumerateDevices();
  const audioOut = devices.filter((d) => d.kind === "audiooutput");
  const audioIn = devices.filter((d) => d.kind === "audioinput");

  const outSel = document.getElementById("output-device");
  const inSel = document.getElementById("virtual-mic-device");
  const micInSel = document.getElementById("mic-input-device");

  if (outSel) {
    outSel.innerHTML = audioOut
      .map((d) => `<option value="${d.deviceId}">${d.label || "Speaker " + d.deviceId.slice(0, 6)}</option>`)
      .join("");
  }
  if (inSel) {
    inSel.innerHTML =
      `<option value="">-- Select CABLE Input --</option>` +
      audioOut
        .map((d) => `<option value="${d.deviceId}">${d.label || "Output " + d.deviceId.slice(0, 6)}</option>`)
        .join("");
  }
  if (micInSel) {
    micInSel.innerHTML = audioIn
      .map((d) => `<option value="${d.deviceId}">${d.label || "Mic " + d.deviceId.slice(0, 6)}</option>`)
      .join("");
  }

  // Prefer whatever the person picked last time (if that device still
  // exists on this machine); otherwise fall back to the original
  // auto-detection heuristics.
  const savedOut = audioOut.find((d) => d.deviceId === appSettings.outputDevice);
  const defaultOut = savedOut || audioOut.find((d) => d.deviceId === "default") || audioOut[0];
  if (defaultOut && outSel) outSel.value = defaultOut.deviceId;

  const cableInputGuess = audioOut.find((d) => {
    const lbl = d.label.toLowerCase();
    return lbl.includes("cable input") || (lbl.includes("cable") && !lbl.includes("output"));
  });
  const savedCableInput = audioOut.find((d) => d.deviceId === appSettings.virtualMicDeviceId);
  const cableInput = savedCableInput || cableInputGuess;
  if (cableInput && inSel) inSel.value = cableInput.deviceId;

  const savedIn = audioIn.find((d) => d.deviceId === appSettings.micInputDeviceId);
  const defaultIn = savedIn || audioIn.find((d) => d.deviceId === "default") || audioIn[0];
  if (defaultIn && micInSel) micInSel.value = defaultIn.deviceId;

  outSel?.addEventListener("change", async () => {
    outputDevice = outSel.value;
    updateSetting("outputDevice", outputDevice);
    await applyOutputSink();
  });
  inSel?.addEventListener("change", () => {
    virtualMicDeviceId = inSel.value;
    updateSetting("virtualMicDeviceId", virtualMicDeviceId);
    connectVirtualMic();
  });
  micInSel?.addEventListener("change", () => {
    micInputDeviceId = micInSel.value;
    updateSetting("micInputDeviceId", micInputDeviceId);
    connectLiveMic(micInputDeviceId);
  });

  if (defaultOut) { outputDevice = defaultOut.deviceId; await applyOutputSink(); }
  if (cableInput) {
    virtualMicDeviceId = cableInput.deviceId;
    await connectVirtualMic();
  } else {
    showToast("⚠️ No VB-Cable-style device found — mic routing will fall back to default output");
    await connectVirtualMic();
  }

  if (defaultIn) {
    micInputDeviceId = defaultIn.deviceId;
    await connectLiveMic(micInputDeviceId);
  }
}

/* =========================================================================
   VOICE FX ENGINE
   ========================================================================= */
function semitoneRatio(semitones) {
  return Math.pow(2, semitones / 12);
}

function computeVoiceParams(sound) {
  const preset = VOICE_PRESETS[sound.voicePreset || "normal"] || VOICE_PRESETS.normal;
  const manualPitch = sound.pitchOffset || 0;
  const tilt = sound.formantTilt || 0;
  return {
    rate: preset.rate * semitoneRatio(manualPitch),
    lowGain: preset.low + tilt * 6,
    highGain: preset.high - tilt * 6,
    ring: !!preset.ring,
    ringFreq: preset.ringFreq || 30,
    bandpass: preset.bandpass || null,
    lowpassFreq: preset.lowpassFreq || null,
    distortion: preset.distortion || 0,
    delay: preset.delay || null,
    volumeMult: preset.volumeMult ?? 1,
  };
}

// Standard soft-clip waveshaper curve for the distortion/grit effect.
function makeDistortionCurve(amount) {
  const k = amount;
  const n = 44100;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((3 + k) * x * 20 * (Math.PI / 180)) / (Math.PI + k * Math.abs(x));
  }
  return curve;
}

/*
 * Builds the per-play FX chain. Nodes are chained conditionally based on
 * which fields the preset sets, so simple presets (deep/male/female) stay
 * cheap and only the fancier ones (telephone, ghost, demon) pay for the
 * extra filters/distortion/delay.
 */
function buildVoiceChain(voice) {
  const lowShelf = audioCtx.createBiquadFilter();
  lowShelf.type = "lowshelf";
  lowShelf.frequency.value = 250;
  lowShelf.gain.value = voice.lowGain;

  const highShelf = audioCtx.createBiquadFilter();
  highShelf.type = "highshelf";
  highShelf.frequency.value = 3500;
  highShelf.gain.value = voice.highGain;

  lowShelf.connect(highShelf);
  let chainEnd = highShelf;

  // Telephone / radio: narrow the band to only mid frequencies.
  if (voice.bandpass) {
    const hp = audioCtx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = voice.bandpass.low;
    const lp = audioCtx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = voice.bandpass.high;
    chainEnd.connect(hp);
    hp.connect(lp);
    chainEnd = lp;
  }

  // Underwater: single lowpass to muffle everything above the cutoff.
  if (voice.lowpassFreq) {
    const lp = audioCtx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = voice.lowpassFreq;
    chainEnd.connect(lp);
    chainEnd = lp;
  }

  // Demon / alien / radio grit.
  if (voice.distortion > 0) {
    const shaper = audioCtx.createWaveShaper();
    shaper.curve = makeDistortionCurve(voice.distortion);
    shaper.oversample = "2x";
    chainEnd.connect(shaper);
    chainEnd = shaper;
  }

  // Robot / demon / alien buzz.
  let ringOsc = null;
  if (voice.ring) {
    const ringGain = audioCtx.createGain();
    ringGain.gain.value = 0;
    ringOsc = audioCtx.createOscillator();
    ringOsc.type = "sine";
    ringOsc.frequency.value = voice.ringFreq;
    ringOsc.connect(ringGain.gain);
    chainEnd.connect(ringGain);
    chainEnd = ringGain;
  }

  // Ghost / echo: a real delay-with-feedback tap mixed back in.
  let delayNodes = null;
  let finalOutput = chainEnd;
  if (voice.delay) {
    const dryGain = audioCtx.createGain();
    dryGain.gain.value = 1 - voice.delay.mix;
    const wetGain = audioCtx.createGain();
    wetGain.gain.value = voice.delay.mix;
    const delayNode = audioCtx.createDelay(1.5);
    delayNode.delayTime.value = voice.delay.time;
    const feedbackGain = audioCtx.createGain();
    feedbackGain.gain.value = voice.delay.feedback;
    const mixOut = audioCtx.createGain();

    chainEnd.connect(dryGain).connect(mixOut);
    chainEnd.connect(delayNode);
    delayNode.connect(feedbackGain).connect(delayNode); // feedback loop
    delayNode.connect(wetGain).connect(mixOut);

    finalOutput = mixOut;
    delayNodes = { delayNode, feedbackGain };
  }

  return {
    input: lowShelf,
    output: finalOutput,
    start: (when) => { if (ringOsc) ringOsc.start(when); },
    stop: () => {
      if (ringOsc) { try { ringOsc.stop(); } catch {} }
      if (delayNodes) {
        // Let the echo tail ring out, then break the feedback loop so this
        // node graph can be garbage collected instead of looping forever.
        setTimeout(() => {
          try { delayNodes.feedbackGain.disconnect(); } catch {}
          try { delayNodes.delayNode.disconnect(); } catch {}
        }, Math.max(1000, voice.delay.time * 1000 * 8));
      }
    },
  };
}

/* =========================================================================
   PLAYBACK
   ========================================================================= */
async function getBuffer(sound) {
  const useRvc = !!sound.rvcVoice;
  const cacheKey = useRvc
    ? `${sound.file}::rvc::${sound.rvcVoice}::${sound.rvcPitch || 0}${sound.rvcSeparateVocals ? "::sep" : ""}`
    : sound.file;
  const cached = cacheBufferGet(cacheKey);
  if (cached) return cached;

  let filePath = sound.file;
  if (useRvc) {
    const result = await window.electronAPI.convertRvcFile(
      sound.file, sound.id, sound.rvcVoice, sound.rvcPitch || 0, !!sound.rvcSeparateVocals
    );
    if (!result.success) {
      showToast("⚠️ RVC conversion failed: " + (result.error || "unknown error"));
      throw new Error(result.error || "RVC conversion failed");
    }
    filePath = result.outputPath;
  }

  const response = await fetch(toFileUrl(filePath));
  if (!response.ok) throw new Error("File not found");
  const arrayBuffer = await response.arrayBuffer();
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  cacheBufferSet(cacheKey, audioBuffer);
  queueWaveform(sound, audioBuffer);
  return audioBuffer;
}

async function playSound(id, opts = {}) {
  const sound = sounds.find((s) => s.id === id);
  if (!sound) return;
  if (audioCtx.state === "suspended") await audioCtx.resume();

  if (queueMode && !opts.fromQueue) {
    queue.push(id);
    showToast("➕ Queued: " + sound.name);
    if (!queuePlaying) advanceQueue();
    return;
  }

  if (stopOnOverlap) stopAll();
  if (playingNodes[id]) { stopSound(id); return; }

  try {
    const audioBuffer = await getBuffer(sound);
    const source = audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.loop = loopEnabled && !queueMode;

    const voice = computeVoiceParams(sound.rvcVoice ? { ...sound, voicePreset: "normal", pitchOffset: 0, formantTilt: 0 } : sound);
    source.playbackRate.value = voice.rate;
    const voiceChain = buildVoiceChain(voice);

    const gainNode = audioCtx.createGain();
    const targetVol = ((sound.volume ?? 100) / 100) * voice.volumeMult;
    const fadeIn = (sound.fadeIn ?? 0) / 1000;
    const fadeOut = (sound.fadeOut ?? 0) / 1000;
    const offset = sound.startOffset ?? 0;
    const trimEnd = sound.endOffset ?? audioBuffer.duration;
    const duration = Math.max(0.01, trimEnd - offset) / voice.rate;

    gainNode.gain.setValueAtTime(fadeIn > 0 ? 0 : targetVol, audioCtx.currentTime);
    if (fadeIn > 0) gainNode.gain.linearRampToValueAtTime(targetVol, audioCtx.currentTime + fadeIn);
    if (fadeOut > 0 && !source.loop) {
      const fadeStart = audioCtx.currentTime + Math.max(0, duration - fadeOut);
      gainNode.gain.setValueAtTime(targetVol, fadeStart);
      gainNode.gain.linearRampToValueAtTime(0.0001, fadeStart + fadeOut);
    }

    source.connect(voiceChain.input);
    voiceChain.output.connect(gainNode);
    gainNode.connect(monitorGain);
    if (sound.sendToMic !== false) gainNode.connect(micSendGain);

    const startTime = audioCtx.currentTime;
    voiceChain.start(startTime);
    if (source.loop) source.start(0, offset);
    else source.start(0, offset, duration * voice.rate);

    playingNodes[id] = { source, gainNode, voiceChain, endsAt: startTime + duration, startedAt: startTime, duration, loop: source.loop };

    if (duckEnabled) applyDuck(id);

    const playingCard = document.querySelector(`.sound-card[data-id="${id}"]`);
    if (playingCard) {
      setCardPlayProgress(playingCard, duration, 0, source.loop);
      playingCard.classList.add("playing");
    }
    updateNowPlayingBar();

    source.onended = () => {
      voiceChain.stop();
      delete playingNodes[id];
      document.querySelector(`.sound-card[data-id="${id}"]`)?.classList.remove("playing");
      updateNowPlayingBar();
      if (queueMode && opts.fromQueue) advanceQueue();
    };
  } catch (e) {
    showToast("⚠️ Could not play: " + (sound.name || id));
    console.error(e);
  }
}

function advanceQueue() {
  if (queue.length === 0) { queuePlaying = false; return; }
  queuePlaying = true;
  const nextId = queue.shift();
  playSound(nextId, { fromQueue: true });
}

function applyDuck(excludeId) {
  Object.entries(playingNodes).forEach(([id, node]) => {
    if (id === excludeId) return;
    node.gainNode.gain.linearRampToValueAtTime(node.gainNode.gain.value * duckAmount, audioCtx.currentTime + 0.08);
  });
}

function stopSound(id) {
  if (playingNodes[id]) {
    try { playingNodes[id].source.stop(); } catch {}
    try { playingNodes[id].voiceChain?.stop(); } catch {}
    delete playingNodes[id];
  }
  document.querySelector(`.sound-card[data-id="${id}"]`)?.classList.remove("playing");
  updateNowPlayingBar();
}
function stopAll() {
  Object.keys(playingNodes).forEach((id) => stopSound(id));
  queue = [];
  queuePlaying = false;
}

// Renders a horizontal strip of chips, one per currently playing sound,
// each with a tiny animated waveform and a stop button — a live readout
// of the board's state, not decoration, since it's the only place you can
// see and stop one specific sound without hunting for its card.
function updateNowPlayingBar() {
  const bar = document.getElementById("now-playing-bar");
  if (!bar) return;
  const ids = Object.keys(playingNodes);
  if (ids.length === 0) {
    bar.classList.remove("visible");
    bar.innerHTML = "";
    return;
  }
  bar.classList.add("visible");
  bar.innerHTML = `<span class="now-playing-label">Playing</span>`;
  ids.forEach((id) => {
    const sound = sounds.find((s) => s.id === id);
    if (!sound) return;
    const color = sound.color || COLORS[0];
    const chip = document.createElement("div");
    chip.className = "now-playing-chip";
    chip.style.setProperty("--chip-color-rgb", hexToRgbString(color));
    chip.innerHTML = `
      <span class="now-playing-chip-waves">
        <span class="wave-bar"></span><span class="wave-bar"></span><span class="wave-bar"></span>
      </span>
      <span>${escHtml(sound.name)}</span>
      <span class="now-playing-chip-stop">
        <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
      </span>
    `;
    chip.addEventListener("click", () => stopSound(id));
    bar.appendChild(chip);
  });
}

function hexToRgbString(hex) {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `${r}, ${g}, ${b}`;
}

async function previewVoice(sound, overrideVoiceFields) {
  stopPreview();
  if (audioCtx.state === "suspended") await audioCtx.resume();
  try {
    const audioBuffer = await getBuffer(sound);
    const merged = { ...sound, ...overrideVoiceFields };
    const voice = computeVoiceParams(merged);

    const source = audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.playbackRate.value = voice.rate;

    const voiceChain = buildVoiceChain(voice);
    const gainNode = audioCtx.createGain();
    gainNode.gain.value = ((sound.volume ?? 100) / 100) * voice.volumeMult;

    source.connect(voiceChain.input);
    voiceChain.output.connect(gainNode);
    gainNode.connect(monitorGain);

    const wasMonitorConnected = localMonitorEnabled;
    if (!wasMonitorConnected) monitorGain.connect(audioCtx.destination);

    voiceChain.start(audioCtx.currentTime);
    source.start(0);
    previewNode = { source, voiceChain };

    source.onended = () => {
      voiceChain.stop();
      if (!wasMonitorConnected) { try { monitorGain.disconnect(audioCtx.destination); } catch {} }
      previewNode = null;
    };
  } catch (e) {
    console.error(e);
  }
}
function stopPreview() {
  if (previewNode) {
    try { previewNode.source.stop(); } catch {}
    try { previewNode.voiceChain.stop(); } catch {}
    previewNode = null;
  }
}

/* =========================================================================
   LIBRARY
   ========================================================================= */
async function loadSounds() {
  sounds = await window.electronAPI.loadSounds();
  for (const s of sounds) {
    if (s.hotkey) await window.electronAPI.registerHotkey({ id: s.id, accelerator: s.hotkey });
  }
  renderGrid();
  renderCategoryFilter();
  preconvertRvcSounds();
}

// Converts any sound that already has an AI Voice picked, one at a time,
// quietly in the background after launch — so clicking it later is
// instant instead of waiting on a fresh conversion. Uses the same
// getBuffer()/bufferCache path as normal playback, and main.js's job
// queue means this never runs concurrently with a user-triggered
// Preview/Save conversion.
async function preconvertRvcSounds() {
  const candidates = sounds.filter((s) => s.rvcVoice);
  for (const sound of candidates) {
    // The sound list (or the sound itself) may have changed while this
    // loop was waiting its turn in the queue — skip anything stale.
    const current = sounds.find((s) => s.id === sound.id);
    if (!current || !current.rvcVoice) continue;
    try {
      await getBuffer(current);
    } catch {
      // Failures here are surfaced by getBuffer's own toast when the
      // person actually tries to play it — nothing more to do quietly.
    }
  }
}

function saveSoundsDebounced() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { window.electronAPI.saveSounds(sounds); }, 400);
}
async function saveSoundsNow() {
  clearTimeout(saveTimer);
  return window.electronAPI.saveSounds(sounds);
}

function softDeleteSound(id) {
  const idx = sounds.findIndex((s) => s.id === id);
  if (idx === -1) return;
  const [removed] = sounds.splice(idx, 1);
  stopSound(id);
  saveSoundsNow();
  renderGrid(currentSearchValue());
  renderCategoryFilter();

  if (trashBin) clearTimeout(trashBin.timeout);
  trashBin = { sound: removed, timeout: setTimeout(() => { trashBin = null; }, 6000) };
  showToast("🗑 Deleted \"" + removed.name + "\"", {
    actionLabel: "Undo",
    onAction: () => {
      if (!trashBin) return;
      sounds.push(trashBin.sound);
      if (trashBin.sound.hotkey) {
        window.electronAPI.registerHotkey({ id: trashBin.sound.id, accelerator: trashBin.sound.hotkey });
      }
      saveSoundsNow();
      renderGrid(currentSearchValue());
      renderCategoryFilter();
      trashBin = null;
    },
  });
}

function makeSoundEntry(filePath) {
  const name = filePath.split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
  const id = "snd_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
  const color = COLORS[sounds.length % COLORS.length];
  return {
    id, name, file: filePath, emoji: "🔊", color, hotkey: "",
    volume: 100, category: "", fadeIn: 0, fadeOut: 0, startOffset: 0,
    voicePreset: "normal", pitchOffset: 0, formantTilt: 0,
    favorite: false, sendToMic: true, rvcVoice: null, rvcPitch: 0, rvcSeparateVocals: false,
  };
}

function makeImportedSoundEntry(filePath, name) {
  const color = COLORS[sounds.length % COLORS.length];
  const id = "snd_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
  return {
    id, name: name || "Imported clip", file: filePath, emoji: "🎬", color, hotkey: "",
    volume: 100, category: "", fadeIn: 0, fadeOut: 0, startOffset: 0,
    voicePreset: "normal", pitchOffset: 0, formantTilt: 0,
    favorite: false, sendToMic: true, rvcVoice: null, rvcPitch: 0, rvcSeparateVocals: false,
  };
}

async function addFiles(filePaths) {
  if (!filePaths.length) return;
  for (const file of filePaths) sounds.push(makeSoundEntry(file));
  await saveSoundsNow();
  renderGrid(currentSearchValue());
  renderCategoryFilter();
  showToast("✅ Added " + filePaths.length + " sound" + (filePaths.length > 1 ? "s" : ""));
}

/* =========================================================================
   DRAG-TO-REORDER
   ========================================================================= */
function persistCardOrder(containerSelector = ".sound-card") {
  const ids = [...document.querySelectorAll(containerSelector)].map((el) => el.dataset.id);
  const idSet = new Set(ids);
  const reordered = [];
  let cursor = 0;
  sounds.forEach((s) => {
    if (idSet.has(s.id)) { reordered.push(sounds.find((x) => x.id === ids[cursor])); cursor++; }
  });
  let r = 0;
  sounds = sounds.map((s) => (idSet.has(s.id) ? reordered[r++] : s));
  saveSoundsDebounced();
}

function makeCardDraggable(div) {
  div.draggable = true;
  div.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", div.dataset.id);
    e.dataTransfer.effectAllowed = "move";
    div.classList.add("dragging");
  });
  div.addEventListener("dragend", () => div.classList.remove("dragging"));
  div.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const dragging = document.querySelector(".sound-card.dragging");
    if (!dragging || dragging === div) return;
    const rect = div.getBoundingClientRect();
    const before = (e.clientX - rect.left) < rect.width / 2;
    div.parentNode.insertBefore(dragging, before ? div : div.nextSibling);
  });
  div.addEventListener("drop", (e) => {
    if (!e.dataTransfer.types.includes("text/plain")) return;
    e.preventDefault();
    e.stopPropagation();
    persistCardOrder();
  });
}

/* =========================================================================
   GRID / CARDS
   ========================================================================= */
function currentSearchValue() {
  return document.getElementById("search-input")?.value || "";
}

function renderGrid(filter = "") {
  const grid = document.getElementById("sounds-grid");
  if (!grid) return;
  const countEl = document.getElementById("sound-count-pill");
  if (countEl) countEl.textContent = `${sounds.length} sound${sounds.length === 1 ? "" : "s"}`;
  const lower = filter.toLowerCase();
  const visible = sounds.filter((s) => {
    const matchesText = !filter || s.name.toLowerCase().includes(lower);
    const matchesCat = currentCategory === "" ? !s.category : s.category === currentCategory;
    return matchesText && matchesCat;
  });

  grid.innerHTML = "";

  const groups = new Map();
  visible.forEach((s) => {
    const key = s.category || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  });
  groups.forEach((list) => list.sort((a, b) => (b.favorite === true) - (a.favorite === true)));

  const orderedKeys = [...groups.keys()].sort((a, b) => {
    if (a === "") return -1;
    if (b === "") return 1;
    return a.localeCompare(b);
  });

  orderedKeys.forEach((key) => {
    const list = groups.get(key);
    if (key !== "") {
      grid.appendChild(createCategoryHeader(key, list.length));
      if (collapsedCategories.has(key)) return;
    }
    const section = document.createElement("div");
    section.className = "sound-category-section";
    section.dataset.category = key;
    list.forEach((s) => section.appendChild(createCard(s)));
    grid.appendChild(section);
  });

  updateEmptyState(visible.length === 0 && sounds.length > 0 ? "no-match" : null);
}

function createCategoryHeader(name, count) {
  const header = document.createElement("div");
  header.className = "category-header";
  const collapsed = collapsedCategories.has(name);
  header.innerHTML = `
    <span class="category-header-chevron">${collapsed ? "▸" : "▾"}</span>
    <span class="category-header-name">${escHtml(name)}</span>
    <span class="category-header-count">${count}</span>
  `;
  header.addEventListener("click", () => {
    if (collapsedCategories.has(name)) collapsedCategories.delete(name);
    else collapsedCategories.add(name);
    try { localStorage.setItem("soundboard:collapsedCategories", JSON.stringify([...collapsedCategories])); } catch {}
    renderGrid(currentSearchValue());
  });
  return header;
}

function createCard(sound) {
  const div = document.createElement("div");
  div.className = "sound-card";
  div.dataset.id = sound.id;
  const color = sound.color || COLORS[0];
  div.style.setProperty("--card-color", color);
  const badges = [];
  if (sound.hotkey) badges.push(`<span class="sound-badge sound-badge-key" title="Global hotkey">${escHtml(sound.hotkey)}</span>`);
  if (sound.rvcVoice) badges.push(`<span class="sound-badge sound-badge-voice" title="AI voice: ${escHtml(sound.rvcVoice)}">🤖 ${escHtml(sound.rvcVoice)}</span>`);
  else if (sound.voicePreset && sound.voicePreset !== "normal") badges.push(`<span class="sound-badge sound-badge-voice" title="Voice effect">${escHtml(sound.voicePreset)}</span>`);
  if (sound.sendToMic === false) badges.push(`<span class="sound-badge sound-badge-local" title="Local only — not sent to the virtual mic">🔇</span>`);
  div.innerHTML = `
    <div class="sound-emoji">${sound.emoji || "🔊"}</div>
    <div class="sound-name">${escHtml(sound.name)}</div>
    ${badges.length ? `<div class="sound-badges">${badges.join("")}</div>` : ""}
    <div class="sound-waveform">
      <canvas class="sound-waveform-canvas wf-base" width="360" height="44"></canvas>
      <canvas class="sound-waveform-canvas wf-played" width="360" height="44"></canvas>
    </div>
    <div class="sound-card-actions">
      <button class="sound-favorite-btn ${sound.favorite ? "active" : ""}" title="Favorite">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="${sound.favorite ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
        </svg>
      </button>
      <button class="sound-edit-btn" title="Edit">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
      </button>
      <button class="sound-delete-btn" title="Delete">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
        </svg>
      </button>
    </div>
  `;

  div.addEventListener("click", (e) => {
    if (e.target.closest(".sound-edit-btn")) { openEditModal(sound.id); return; }
    if (e.target.closest(".sound-delete-btn")) {
      e.stopPropagation();
      try { window.electronAPI?.unregisterHotkey?.(sound.id); } catch (err) { console.error("unregisterHotkey failed:", err); }
      softDeleteSound(sound.id);
      return;
    }
    if (e.target.closest(".sound-favorite-btn")) {
      e.stopPropagation();
      sound.favorite = !sound.favorite;
      saveSoundsDebounced();
      renderGrid(currentSearchValue());
      return;
    }
    playSound(sound.id);
  });

  drawWaveform(div, null); // placeholder bars until the audio is decoded
  if (playingNodes[sound.id]) {
    const node = playingNodes[sound.id];
    let elapsed = Math.max(0, audioCtx.currentTime - (node.startedAt ?? audioCtx.currentTime));
    if (node.loop && node.duration) elapsed %= node.duration;
    setCardPlayProgress(div, node.duration, elapsed, node.loop);
    div.classList.add("playing");
  }

  if (bufferCache.has(sound.file)) drawWaveform(div, bufferCache.get(sound.file));
  else getBuffer(sound).catch(() => {});

  makeCardDraggable(div);

  return div;
}

function queueWaveform(sound, buffer) {
  const card = document.querySelector(`.sound-card[data-id="${sound.id}"]`);
  if (card) drawWaveform(card, buffer);
}
function waveformColor(cardEl) {
  const raw = (cardEl.style.getPropertyValue("--card-color") || "").trim();
  if (!/^#[0-9a-f]{6}$/i.test(raw)) return raw || "#ffffff";
  // On light themes pastel card colours vanish against white, so deepen them.
  if (document.documentElement.dataset.mode !== "light") return raw;
  const k = 0.68;
  const c = [1, 3, 5].map((i) => Math.round(parseInt(raw.slice(i, i + 2), 16) * k));
  return "rgb(" + c.join(",") + ")";
}

function drawWaveform(cardEl, buffer) {
  const canvases = cardEl.querySelectorAll(".sound-waveform-canvas");
  if (!canvases.length) return;
  const W = canvases[0].width, H = canvases[0].height;
  const BARS = 48;
  const slot = W / BARS;
  const barW = Math.max(2, slot * 0.62);
  const color = waveformColor(cardEl);

  // Peak per bar across the *trimmed* region so the strip matches what plays.
  let peaks = new Array(BARS).fill(0.06);
  if (buffer) {
    const sound = sounds.find((x) => x.id === cardEl.dataset.id);
    const sr = buffer.sampleRate;
    const s0 = Math.max(0, Math.floor((sound?.startOffset ?? 0) * sr));
    const s1 = Math.min(buffer.length, Math.floor((sound?.endOffset ?? buffer.duration) * sr));
    const span = Math.max(1, s1 - s0);
    const data = buffer.getChannelData(0);
    const per = span / BARS;
    const stride = Math.max(1, Math.floor(per / 160));
    let maxPeak = 0.02;
    for (let i = 0; i < BARS; i++) {
      const from = s0 + Math.floor(i * per);
      const to = Math.min(s1, s0 + Math.floor((i + 1) * per));
      let p = 0;
      for (let j = from; j < to; j += stride) { const v = Math.abs(data[j] || 0); if (v > p) p = v; }
      peaks[i] = p;
      if (p > maxPeak) maxPeak = p;
    }
    // Normalise, then lift quiet bars so even soft clips read clearly.
    peaks = peaks.map((p) => Math.pow(p / maxPeak, 0.7));
  }

  canvases.forEach((canvas) => {
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = color;
    for (let i = 0; i < BARS; i++) {
      const h = Math.max(4, peaks[i] * H);
      const x = i * slot + (slot - barW) / 2;
      const y = (H - h) / 2;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, barW, h, barW / 2);
      else ctx.rect(x, y, barW, h);
      ctx.fill();
    }
  });
}

function redrawAllWaveforms() {
  document.querySelectorAll(".sound-card").forEach((card) => {
    const sound = sounds.find((x) => x.id === card.dataset.id);
    drawWaveform(card, sound && bufferCache.has(sound.file) ? bufferCache.get(sound.file) : null);
  });
}

// Drives the CSS playhead that sweeps across the waveform while a card plays.
function setCardPlayProgress(cardEl, duration, elapsed, loop) {
  cardEl.style.setProperty("--play-dur", Math.max(0.05, duration || 0.05) + "s");
  cardEl.style.setProperty("--play-delay", -(elapsed || 0) + "s");
  cardEl.style.setProperty("--play-iter", loop ? "infinite" : "1");
}

function updateEmptyState(state) {
  const empty = document.getElementById("empty-state");
  const grid = document.getElementById("sounds-grid");
  if (!empty || !grid) return;
  if (sounds.length === 0) {
    empty.classList.add("visible");
    grid.style.display = "none";
    empty.querySelector("p").innerHTML = "No sounds yet.<br/>Click <strong>Add Sounds</strong> or drag files here to get started.";
  } else if (state === "no-match") {
    empty.classList.add("visible");
    grid.style.display = "none";
    empty.querySelector("p").innerHTML = "No sounds match your search.";
  } else {
    empty.classList.remove("visible");
    grid.style.display = "grid";
  }
}

function renderCategoryFilter() {
  const sel = document.getElementById("category-filter");
  if (!sel) return;
  const cats = [...new Set(sounds.map((s) => s.category).filter(Boolean))];
  sel.innerHTML = `<option value="">Uncategorized</option>` +
    cats.map((c) => `<option value="${escHtml(c)}">${escHtml(c)}</option>`).join("");
  sel.value = currentCategory;
}

/* =========================================================================
   DRAG AND DROP (file import)
   ========================================================================= */
function bindDragAndDrop() {
  const grid = document.getElementById("sounds-grid");
  const dropTargets = [grid, document.getElementById("empty-state")].filter(Boolean);

  dropTargets.forEach((el) => {
    el.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    });
    el.addEventListener("drop", async (e) => {
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files || []);
      if (files.length === 0) return;
      const paths = files
        .map((f) => f.path)
        .filter((p) => p && AUDIO_EXTENSIONS.includes(p.split(".").pop().toLowerCase()));
      if (paths.length === 0) {
        showToast("⚠️ No supported audio files in that drop");
        return;
      }
      await addFiles(paths);
    });
  });
}

/* =========================================================================
   YOUTUBE IMPORT
   Paste a URL, optionally set a start/end clip range, and auto-trim
   silence off the edges. Downloading + trimming happens in the main
   process; this just drives the modal and files the result away as a
   normal sound once it comes back.
   ========================================================================= */
function bindYoutubeImportModal() {
  document.getElementById("yt-import-open-btn")?.addEventListener("click", openYoutubeImportModal);
  document.getElementById("yt-cancel-btn")?.addEventListener("click", closeYoutubeImportModal);
  document.getElementById("yt-import-modal-overlay")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("yt-import-modal-overlay")) closeYoutubeImportModal();
  });
  document.getElementById("yt-fetch-btn")?.addEventListener("click", fetchYoutubeInfo);
  document.getElementById("yt-url-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); fetchYoutubeInfo(); }
  });
  document.getElementById("yt-autotrim-toggle")?.addEventListener("click", (e) => {
    e.currentTarget.classList.toggle("active");
  });
  document.getElementById("yt-import-btn-confirm")?.addEventListener("click", runYoutubeImport);
  bindYoutubeCookieControls();
}

/* ---- YouTube cookie management ---- */
const YT_BROWSER_LABELS = {
  chrome: "Chrome", firefox: "Firefox", edge: "Edge", brave: "Brave",
  opera: "Opera", vivaldi: "Vivaldi", chromium: "Chromium", safari: "Safari",
};

function bindYoutubeCookieControls() {
  document.getElementById("yt-cookie-import-btn")?.addEventListener("click", async () => {
    const res = await window.electronAPI.importYoutubeCookiesFile();
    if (res.canceled) return;
    if (!res.success) { showToast("⚠️ " + (res.error || "Couldn't import cookies")); return; }
    renderYtCookieStatus(res.status);
    showToast("✅ Saved " + res.status.fileCookieCount + " YouTube cookies");
  });

  document.getElementById("yt-cookie-browser-btn")?.addEventListener("click", async () => {
    const browser = getVal("yt-cookie-browser-select");
    if (!browser) return;
    const res = await window.electronAPI.useYoutubeCookiesFromBrowser(browser);
    if (!res.success) { showToast("⚠️ " + (res.error || "Couldn't switch cookie source")); return; }
    renderYtCookieStatus(res.status);
    showToast("✅ Using " + (YT_BROWSER_LABELS[browser] || browser) + " cookies");
  });

  document.getElementById("yt-cookie-clear-btn")?.addEventListener("click", async () => {
    const res = await window.electronAPI.clearYoutubeCookies();
    renderYtCookieStatus(res.status);
    showToast("🧹 YouTube cookies cleared");
  });
}

async function refreshYtCookieStatus() {
  try { renderYtCookieStatus(await window.electronAPI.getYoutubeCookieStatus()); } catch (e) { console.error(e); }
}

function renderYtCookieStatus(status) {
  if (!status) return;
  const select = document.getElementById("yt-cookie-browser-select");
  if (select && !select.options.length) {
    for (const b of status.browsers || []) {
      const opt = document.createElement("option");
      opt.value = b;
      opt.textContent = YT_BROWSER_LABELS[b] || b;
      select.appendChild(opt);
    }
  }
  if (select && status.mode === "browser") select.value = status.browser;

  const badge = document.getElementById("yt-cookie-badge");
  if (badge) {
    badge.classList.toggle("active", status.mode !== "none");
    if (status.mode === "file") {
      badge.textContent = "Saved · " + status.fileCookieCount + " cookies";
    } else if (status.mode === "browser") {
      badge.textContent = "From " + (YT_BROWSER_LABELS[status.browser] || status.browser);
    } else {
      badge.textContent = "Not set";
    }
  }
  const clearBtn = document.getElementById("yt-cookie-clear-btn");
  if (clearBtn) clearBtn.disabled = status.mode === "none" && !status.fileCookieCount;
}

// If YouTube is asking for a sign-in, pop the cookie section open so the fix is right there.
function handleYoutubeAuthError(message) {
  if (!/sign in|not a bot|confirm you.re not|login required|age.restricted|cookies/i.test(message || "")) return false;
  const details = document.getElementById("yt-cookies-details");
  if (details) details.open = true;
  return true;
}

function openYoutubeImportModal() {
  setVal("yt-url-input", "");
  setVal("yt-name-input", "");
  setVal("yt-start-input", "");
  setVal("yt-end-input", "");
  document.getElementById("yt-autotrim-toggle")?.classList.add("active");
  const preview = document.getElementById("yt-preview");
  if (preview) preview.style.display = "none";
  setYtStatus("");
  refreshYtCookieStatus();
  document.getElementById("yt-import-modal-overlay")?.classList.add("visible");
}
function closeYoutubeImportModal() {
  document.getElementById("yt-import-modal-overlay")?.classList.remove("visible");
}

function setYtStatus(text) {
  const el = document.getElementById("yt-import-status");
  if (!el) return;
  if (!text) { el.style.display = "none"; el.textContent = ""; return; }
  el.style.display = "block";
  el.textContent = text;
}

function formatSecondsMMSS(total) {
  total = Math.max(0, Math.round(total || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m + ":" + String(s).padStart(2, "0");
}

function parseMMSS(str) {
  if (!str || !str.trim()) return null;
  const parts = str.trim().split(":").map((p) => parseFloat(p));
  if (parts.some((p) => Number.isNaN(p))) return null;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

async function fetchYoutubeInfo() {
  const url = getVal("yt-url-input").trim();
  if (!url) { showToast("⚠️ Paste a YouTube URL first"); return; }
  setYtStatus("Loading video info…");
  try {
    const info = await window.electronAPI.getYoutubeInfo(url);
    setYtStatus("");
    if (!info.success) {
      handleYoutubeAuthError(info.error);
      showToast("⚠️ " + (info.error || "Couldn't load that video"));
      return;
    }
    const preview = document.getElementById("yt-preview");
    if (preview) preview.style.display = "block";
    setLabel("yt-preview-title", info.title);
    setLabel("yt-preview-meta", (info.author ? info.author + " · " : "") + formatSecondsMMSS(info.durationSeconds));
    if (!getVal("yt-name-input").trim()) setVal("yt-name-input", info.title);
    if (!getVal("yt-end-input").trim() && info.durationSeconds) {
      setVal("yt-end-input", formatSecondsMMSS(info.durationSeconds));
    }
  } catch (e) {
    console.error(e);
    setYtStatus("");
    showToast("⚠️ Couldn't load that video");
  }
}

async function runYoutubeImport() {
  const url = getVal("yt-url-input").trim();
  if (!url) { showToast("⚠️ Paste a YouTube URL first"); return; }

  const startStr = getVal("yt-start-input").trim();
  const endStr = getVal("yt-end-input").trim();
  if (startStr && parseMMSS(startStr) == null) { showToast("⚠️ Start time should look like mm:ss"); return; }
  if (endStr && parseMMSS(endStr) == null) { showToast("⚠️ End time should look like mm:ss"); return; }
  if (startStr && endStr && parseMMSS(endStr) <= parseMMSS(startStr)) {
    showToast("⚠️ End time must be after start time");
    return;
  }

  const name = getVal("yt-name-input").trim() || "Imported clip";
  const autoTrim = document.getElementById("yt-autotrim-toggle")?.classList.contains("active") ?? true;

  const btn = document.getElementById("yt-import-btn-confirm");
  if (btn) { btn.disabled = true; btn.textContent = "Importing…"; }
  setYtStatus("Downloading and trimming audio — this can take a moment…");

  try {
    const result = await window.electronAPI.importYoutubeClip({
      url, name, start: startStr, end: endStr, autoTrim,
    });
    if (!result.success) {
      handleYoutubeAuthError(result.error);
      showToast("⚠️ " + (result.error || "Import failed"));
      return;
    }
    const entry = makeImportedSoundEntry(result.filePath, result.name || name);
    sounds.push(entry);
    await saveSoundsNow();
    renderGrid(currentSearchValue());
    renderCategoryFilter();
    closeYoutubeImportModal();
    showToast("✅ Imported \"" + entry.name + "\"");
  } catch (e) {
    console.error(e);
    showToast("⚠️ Import failed");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "⬇ Import"; }
    setYtStatus("");
  }
}

/* =========================================================================
   SETTINGS MODAL (device routing, mic mixer, playback prefs)
   ========================================================================= */
function bindSettingsModal() {
  document.getElementById("settings-btn")?.addEventListener("click", () => {
    document.getElementById("settings-modal-overlay")?.classList.add("visible");
  });
  document.getElementById("settings-modal-overlay")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("settings-modal-overlay")) closeSettingsModal();
  });
  document.getElementById("settings-close-btn")?.addEventListener("click", closeSettingsModal);
  document.querySelectorAll(".settings-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchSettingsTab(btn.dataset.tab));
  });
  renderThemeSwatches();
  bindRvcVoicesPanel();
  renderRvcVoices();
}

// Renders the Appearance tab's theme picker as two collapsible groups —
// "Dark themes" and "Light themes" — each with its own header (name,
// count, chevron) and 3-column swatch grid, instead of one flat list.
function renderThemeSwatches() {
  const container = document.getElementById("theme-swatch-grid");
  if (!container) return;
  const current = document.documentElement.dataset.theme || "crimson";

  container.classList.add("theme-groups");
  container.innerHTML = "";

  const groupDefs = [
    { key: "dark", label: "Dark themes" },
    { key: "light", label: "Light themes" },
  ];

  groupDefs.forEach(({ key, label }) => {
    const themesInGroup = THEMES.filter((t) => t.mode === key);
    if (themesInGroup.length === 0) return;

    const group = document.createElement("div");
    group.className = "theme-group";

    const collapsed = collapsedThemeGroups.has(key);

    const header = document.createElement("div");
    header.className = "theme-group-header";
    header.innerHTML = `
      <span class="theme-group-chevron">${collapsed ? "▸" : "▾"}</span>
      <span class="theme-group-name">${label}</span>
      <span class="theme-group-count">${themesInGroup.length}</span>
    `;

    const swatchGrid = document.createElement("div");
    swatchGrid.className = "theme-group-swatches" + (collapsed ? " collapsed" : "");

    themesInGroup.forEach((t) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "theme-swatch" + (t.id === current ? " selected" : "");
      btn.dataset.theme = t.id;
      btn.innerHTML = `
        <span class="theme-swatch-preview" style="background:${t.swatch}"></span>
        <span class="theme-swatch-name">${t.name}</span>
      `;
      btn.addEventListener("click", () => {
        applyTheme(t.id);
        updateSetting("theme", t.id);
        document.querySelectorAll(".theme-swatch").forEach((b) => b.classList.remove("selected"));
        btn.classList.add("selected");
      });
      swatchGrid.appendChild(btn);
    });

    header.addEventListener("click", () => {
      if (collapsedThemeGroups.has(key)) collapsedThemeGroups.delete(key);
      else collapsedThemeGroups.add(key);
      try {
        localStorage.setItem("soundboard:collapsedThemeGroups", JSON.stringify([...collapsedThemeGroups]));
      } catch {}
      renderThemeSwatches();
    });

    group.appendChild(header);
    group.appendChild(swatchGrid);
    container.appendChild(group);
  });
}

// AI Voices tab — lists the .pth/.index model files stored in the app's
// rvc_voices folder as clickable cards (plus an "Off" card), so the
// person can mark which voice they're currently running in their
// separate real-time RVC app. Nothing here does any audio conversion.
let rvcVoicesCache = [];

async function renderRvcVoices() {
  const grid = document.getElementById("rvc-voice-grid");
  if (!grid) return;
  rvcVoicesCache = await window.electronAPI.listRvcVoices();
  const active = appSettings.activeRvcVoice || null;

  grid.innerHTML = "";

  const offCard = document.createElement("div");
  offCard.className = "rvc-voice-card" + (active === null ? " active" : "");
  offCard.innerHTML = `
    <div class="rvc-voice-card-icon">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
        <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8"/>
        <line x1="2" y1="2" x2="22" y2="22"/>
      </svg>
    </div>
    <div class="rvc-voice-card-info">
      <div class="rvc-voice-card-name">Off</div>
      <div class="rvc-voice-card-meta">Not using an AI voice right now</div>
    </div>
  `;
  offCard.addEventListener("click", () => {
    updateSetting("activeRvcVoice", null);
    renderRvcVoices();
  });
  grid.appendChild(offCard);

  if (rvcVoicesCache.length === 0) {
    const empty = document.createElement("div");
    empty.className = "rvc-empty-note";
    empty.textContent = "No voice models yet — add .pth (and optional .index) files.";
    grid.appendChild(empty);
    return;
  }

  rvcVoicesCache.forEach((v) => {
    const card = document.createElement("div");
    card.className = "rvc-voice-card" + (active === v.id ? " active" : "");
    card.innerHTML = `
      <div class="rvc-voice-card-icon">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8"/>
        </svg>
      </div>
      <div class="rvc-voice-card-info">
        <div class="rvc-voice-card-name">${escHtml(v.name)}</div>
        <div class="rvc-voice-card-meta">${v.sizeMB} MB${v.hasIndex ? " · has index" : ""}</div>
      </div>
      <button type="button" class="rvc-voice-delete-btn" title="Remove">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
        </svg>
      </button>
    `;
    card.addEventListener("click", (e) => {
      if (e.target.closest(".rvc-voice-delete-btn")) {
        e.stopPropagation();
        window.electronAPI.deleteRvcVoice(v.id).then(() => {
          if (appSettings.activeRvcVoice === v.id) updateSetting("activeRvcVoice", null);
          renderRvcVoices();
        });
        return;
      }
      updateSetting("activeRvcVoice", v.id);
      renderRvcVoices();
    });
    grid.appendChild(card);
  });
}

function bindRvcVoicesPanel() {
  const grid = document.getElementById("rvc-voice-grid");
  const addBtn = document.getElementById("rvc-add-btn");
  const folderBtn = document.getElementById("rvc-open-folder-btn");
  const installBtn = document.getElementById("rvc-backend-install-btn");
  const alreadyBound = grid?.dataset.bound;
  if (grid) grid.dataset.bound = "1";

  if (!alreadyBound) {
    addBtn?.addEventListener("click", async () => {
      await window.electronAPI.importRvcVoiceFiles();
      renderRvcVoices();
    });
    folderBtn?.addEventListener("click", () => {
      window.electronAPI.openRvcVoicesFolder();
    });
    installBtn?.addEventListener("click", installRvcBackend);
    window.electronAPI.onRvcBackendLog((line) => {
      const logEl = document.getElementById("rvc-backend-log");
      if (!logEl) return;
      logEl.style.display = "block";
      logEl.textContent += line;
      logEl.scrollTop = logEl.scrollHeight;
    });
    window.electronAPI.onRvcConversionLog((line) => {
      const logEl = document.getElementById("edit-rvc-log");
      if (!logEl) return;
      logEl.style.display = "block";
      logEl.textContent += line;
      logEl.scrollTop = logEl.scrollHeight;
    });

    const pythonInput = document.getElementById("rvc-python-command");
    if (pythonInput) {
      pythonInput.value = appSettings.rvcPythonCommand || "";
      pythonInput.addEventListener("change", () => {
        updateSetting("rvcPythonCommand", pythonInput.value.trim());
        checkRvcBackendStatus();
      });
    }

    const commandInput = document.getElementById("rvc-command-template");
    if (commandInput) {
      commandInput.value = appSettings.rvcCommandTemplate || RVC_DEFAULT_COMMAND_TEMPLATE;
      commandInput.addEventListener("change", () => {
        updateSetting("rvcCommandTemplate", commandInput.value.trim());
      });
    }
    document.getElementById("rvc-command-reset-btn")?.addEventListener("click", () => {
      if (commandInput) commandInput.value = RVC_DEFAULT_COMMAND_TEMPLATE;
      updateSetting("rvcCommandTemplate", RVC_DEFAULT_COMMAND_TEMPLATE);
      showToast("✅ Command template reset to default");
    });

    if (grid) {
      grid.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        grid.classList.add("drag-over");
      });
      grid.addEventListener("dragleave", () => grid.classList.remove("drag-over"));
      grid.addEventListener("drop", async (e) => {
        e.preventDefault();
        grid.classList.remove("drag-over");
        const files = Array.from(e.dataTransfer.files || []);
        const paths = files
          .map((f) => f.path)
          .filter((p) => p && [".pth", ".index"].includes("." + p.split(".").pop().toLowerCase()));
        if (paths.length === 0) {
          showToast("⚠️ Drop .pth or .index RVC model files");
          return;
        }
        await window.electronAPI.importRvcVoiceFilePaths(paths);
        renderRvcVoices();
      });
    }
  }

  checkRvcBackendStatus();
}

async function checkRvcBackendStatus() {
  const statusEl = document.getElementById("rvc-backend-status");
  if (!statusEl) return;
  statusEl.textContent = "Checking…";
  statusEl.className = "rvc-backend-status";
  const status = await window.electronAPI.checkRvcBackend();
  if (status.rvcInstalled) {
    statusEl.textContent = "✓ Backend ready";
    statusEl.className = "rvc-backend-status ready";
  } else if (status.pythonFound) {
    statusEl.textContent = "Python found — backend not installed";
    statusEl.className = "rvc-backend-status missing";
  } else {
    statusEl.textContent = "Python not found";
    statusEl.className = "rvc-backend-status missing";
  }
}

async function installRvcBackend() {
  const installBtn = document.getElementById("rvc-backend-install-btn");
  const statusEl = document.getElementById("rvc-backend-status");
  const logEl = document.getElementById("rvc-backend-log");
  if (logEl) { logEl.textContent = ""; logEl.style.display = "block"; }
  if (installBtn) { installBtn.disabled = true; installBtn.textContent = "Installing…"; }
  if (statusEl) { statusEl.textContent = "Installing…"; statusEl.className = "rvc-backend-status"; }

  const result = await window.electronAPI.installRvcBackend();
  if (installBtn) { installBtn.disabled = false; installBtn.textContent = "Install / Update Backend"; }

  if (result.success) {
    showToast("✅ AI Voice backend installed");
  } else {
    showToast("⚠️ Backend install failed: " + (result.error || "unknown error"));
  }
  checkRvcBackendStatus();
}

function switchSettingsTab(tab) {
  document.querySelectorAll(".settings-tab-btn").forEach((b) => b.classList.toggle("selected", b.dataset.tab === tab));
  document.querySelectorAll(".settings-tab-panel").forEach((p) => {
    p.style.display = p.dataset.tab === tab ? "flex" : "none";
  });
}
function closeSettingsModal() {
  document.getElementById("settings-modal-overlay")?.classList.remove("visible");
}

/* =========================================================================
   EDIT MODAL
   ========================================================================= */
async function openEditModal(id) {
  const sound = sounds.find((s) => s.id === id);
  if (!sound) return;
  editingId = id;

  setVal("edit-name", sound.name);
  setVal("edit-emoji", sound.emoji || "🔊");
  setVal("edit-hotkey", sound.hotkey || "");
  setVal("edit-volume", sound.volume ?? 100);
  setLabel("edit-vol-label", (sound.volume ?? 100) + "%");
  setVal("edit-category", sound.category || "");
  setVal("edit-fadein", sound.fadeIn ?? 0);
  setVal("edit-fadeout", sound.fadeOut ?? 0);

  setVal("edit-pitch", sound.pitchOffset ?? 0);
  setVal("edit-formant", sound.formantTilt ?? 0);
  setLabel("edit-pitch-label", (sound.pitchOffset ?? 0) + " st");
  setLabel("edit-formant-label", (sound.formantTilt ?? 0).toFixed(2));

  const sendToMicEl = document.getElementById("edit-send-to-mic");
  if (sendToMicEl) sendToMicEl.checked = sound.sendToMic !== false;

  document.querySelectorAll(".voice-preset-btn:not(.rvc-pitch-preset-btn)").forEach((btn) => {
    btn.classList.toggle("selected", btn.dataset.preset === (sound.voicePreset || "normal"));
  });

  const row = document.getElementById("color-picker-row");
  if (row) {
    row.innerHTML = "";
    COLORS.forEach((c) => {
      const sw = document.createElement("div");
      sw.className = "color-swatch" + (c === (sound.color || COLORS[0]) ? " selected" : "");
      sw.style.background = c;
      sw.dataset.color = c;
      sw.addEventListener("click", () => {
        document.querySelectorAll(".color-swatch").forEach((x) => x.classList.remove("selected"));
        sw.classList.add("selected");
      });
      row.appendChild(sw);
    });
  }

  editingRvcVoice = sound.rvcVoice || null;
  editingRvcPitch = sound.rvcPitch || 0;
  editingRvcSeparate = !!sound.rvcSeparateVocals;
  setVal("edit-rvc-pitch", editingRvcPitch);
  setLabel("edit-rvc-pitch-label", String(editingRvcPitch));
  const separateEl = document.getElementById("edit-rvc-separate");
  if (separateEl) separateEl.checked = editingRvcSeparate;
  rvcVoicesCache = await window.electronAPI.listRvcVoices();
  renderEditRvcVoiceGrid();
  setLabel("edit-rvc-status", "");

  switchModalTab("sound");
  document.getElementById("modal-overlay")?.classList.add("visible");
}

function currentVoiceFormValues() {
  const selectedBtn = document.querySelector(".voice-preset-btn.selected");
  return {
    voicePreset: selectedBtn?.dataset.preset || "normal",
    pitchOffset: parseFloat(getVal("edit-pitch", 0)) || 0,
    formantTilt: parseFloat(getVal("edit-formant", 0)) || 0,
  };
}

function bindModalTabs() {
  document.querySelectorAll(".modal-tab-btn:not(.settings-tab-btn)").forEach((btn) => {
    btn.addEventListener("click", () => switchModalTab(btn.dataset.tab));
  });
}
function switchModalTab(tab) {
  document.querySelectorAll(".modal-tab-btn:not(.settings-tab-btn)").forEach((b) => b.classList.toggle("selected", b.dataset.tab === tab));
  document.querySelectorAll(".modal-tab-panel:not(.settings-tab-panel)").forEach((p) => {
    p.style.display = p.dataset.tab === tab ? "flex" : "none";
  });
  if (tab !== "voice") stopPreview();
  if (tab !== "aivoice") stopRvcPreview();
}

// AI Voice tab — builds the "Off" + per-model card grid inside the Edit
// Sound modal, mirroring the AI Voices Settings tab but scoped to
// whichever sound is currently being edited.
function renderEditRvcVoiceGrid() {
  const grid = document.getElementById("edit-rvc-voice-grid");
  if (!grid) return;
  grid.innerHTML = "";

  const offCard = document.createElement("div");
  offCard.className = "rvc-voice-card" + (!editingRvcVoice ? " active" : "");
  offCard.innerHTML = `
    <div class="rvc-voice-card-icon">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="2" y1="2" x2="22" y2="22"/>
      </svg>
    </div>
    <div class="rvc-voice-card-info">
      <div class="rvc-voice-card-name">Off</div>
      <div class="rvc-voice-card-meta">Use Voice FX preset above instead</div>
    </div>
  `;
  offCard.addEventListener("click", () => {
    editingRvcVoice = null;
    setLabel("edit-rvc-status", "");
    renderEditRvcVoiceGrid();
  });
  grid.appendChild(offCard);

  rvcVoicesCache.forEach((v) => {
    const card = document.createElement("div");
    card.className = "rvc-voice-card" + (editingRvcVoice === v.id ? " active" : "");
    card.innerHTML = `
      <div class="rvc-voice-card-icon">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8"/>
        </svg>
      </div>
      <div class="rvc-voice-card-info">
        <div class="rvc-voice-card-name">${escHtml(v.name)}</div>
        <div class="rvc-voice-card-meta">${v.sizeMB} MB${v.hasIndex ? " · has index" : ""}</div>
      </div>
    `;
    card.addEventListener("click", () => {
      editingRvcVoice = v.id;
      setLabel("edit-rvc-status", "");
      renderEditRvcVoiceGrid();
    });
    grid.appendChild(card);
  });

  if (rvcVoicesCache.length === 0) {
    const empty = document.createElement("div");
    empty.className = "rvc-empty-note";
    empty.textContent = "No voice models yet — add them in Settings > AI Voices.";
    grid.appendChild(empty);
  }
}

function stopRvcPreview() {
  if (rvcPreviewAudio) {
    try { rvcPreviewAudio.pause(); } catch {}
    rvcPreviewAudio = null;
  }
}

// Clears the Edit modal's live conversion log box right before a new
// convertRvcFile() call, so each run starts with a blank slate instead of
// appending onto the previous attempt's output.
function resetEditRvcLog() {
  const logEl = document.getElementById("edit-rvc-log");
  if (logEl) { logEl.textContent = ""; logEl.style.display = "block"; }
}

function bindVoicePresets() {
  document.querySelectorAll(".voice-preset-btn:not(.rvc-pitch-preset-btn)").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".voice-preset-btn:not(.rvc-pitch-preset-btn)").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
    });
  });
  document.getElementById("edit-pitch")?.addEventListener("input", (e) => {
    setLabel("edit-pitch-label", e.target.value + " st");
  });
  document.getElementById("edit-formant")?.addEventListener("input", (e) => {
    setLabel("edit-formant-label", parseFloat(e.target.value).toFixed(2));
  });
  document.getElementById("voice-preview-btn")?.addEventListener("click", () => {
    if (!editingId) return;
    const sound = sounds.find((s) => s.id === editingId);
    if (!sound) return;
    previewVoice({ ...sound, rvcVoice: null }, currentVoiceFormValues());
  });

  document.getElementById("edit-rvc-pitch")?.addEventListener("input", (e) => {
    editingRvcPitch = parseInt(e.target.value, 10) || 0;
    setLabel("edit-rvc-pitch-label", String(editingRvcPitch));
  });
  document.querySelectorAll(".rvc-pitch-preset-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      editingRvcPitch = parseInt(btn.dataset.rvcPitch, 10) || 0;
      setVal("edit-rvc-pitch", editingRvcPitch);
      setLabel("edit-rvc-pitch-label", String(editingRvcPitch));
    });
  });
  document.getElementById("edit-rvc-separate")?.addEventListener("change", (e) => {
    editingRvcSeparate = e.target.checked;
  });
}

function setVal(id, v) { const el = document.getElementById(id); if (el) el.value = v; }
function getVal(id, fallback = "") { const el = document.getElementById(id); return el ? el.value : fallback; }
function setLabel(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }

function closeModal() {
  document.getElementById("modal-overlay")?.classList.remove("visible");
  stopPreview();
  stopRvcPreview();
  editingId = null;
  stopHotkeyRecording();
}

/* =========================================================================
   HOTKEYS
   ========================================================================= */
function startHotkeyRecording() {
  recordingHotkey = true;
  const input = document.getElementById("edit-hotkey");
  if (!input) return;
  input.value = "Press keys...";
  input.classList.add("recording");
}
function stopHotkeyRecording() {
  recordingHotkey = false;
  document.getElementById("edit-hotkey")?.classList.remove("recording");
}
function bindHotkeyListener() {
  window.electronAPI.onHotkeyTriggered((id) => playSound(id));
  document.getElementById("edit-hotkey")?.addEventListener("click", () => {
    if (!recordingHotkey) startHotkeyRecording();
  });
  document.addEventListener("keydown", (e) => {
    if (!recordingHotkey) return;
    e.preventDefault();
    const mods = [];
    if (e.ctrlKey) mods.push("Ctrl");
    if (e.shiftKey) mods.push("Shift");
    if (e.altKey) mods.push("Alt");
    let key = e.key;
    if (["Control", "Shift", "Alt", "Meta"].includes(key)) return;
    const keyMap = {
      " ": "Space", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
      Escape: "Escape", Enter: "Return", Backspace: "Backspace", Delete: "Delete", Tab: "Tab",
    };
    key = keyMap[key] || (key.length === 1 ? key.toUpperCase() : key);
    setVal("edit-hotkey", [...mods, key].join("+"));
    stopHotkeyRecording();
  });
}

function bindKeyboardShortcuts() {
  document.addEventListener("keydown", (e) => {
    if (recordingHotkey) return;
    const modalOpen = document.getElementById("modal-overlay")?.classList.contains("visible")
      || document.getElementById("settings-modal-overlay")?.classList.contains("visible")
      || document.getElementById("yt-import-modal-overlay")?.classList.contains("visible");
    const typing = ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName);

    if (pushToTalkMode && e.code === "Backquote" && !e.repeat) { setMicMuted(false); }

    if (modalOpen || typing) return;

    if (e.code === "Space") { e.preventDefault(); stopAll(); return; }
    if (/^Digit[1-9]$/.test(e.code)) {
      const idx = parseInt(e.code.replace("Digit", ""), 10) - 1;
      const card = document.querySelectorAll(".sound-card")[idx];
      if (card) playSound(card.dataset.id);
    }
  });
  document.addEventListener("keyup", (e) => {
    if (pushToTalkMode && e.code === "Backquote") setMicMuted(true);
  });
}

/* =========================================================================
   WINDOW STATE SYNC
   ========================================================================= */
function bindWindowStateSync() {
  const icon = document.getElementById("maximize-icon");
  const applyIcon = (isMaximized) => {
    if (!icon) return;
    icon.innerHTML = isMaximized
      ? `<rect x="1.5" y="0.5" width="7" height="7" stroke="currentColor" fill="none"/><rect x="0.5" y="2.5" width="7" height="7" stroke="currentColor" fill="none"/>`
      : `<rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" fill="none"/>`;
  };
  window.electronAPI.isWindowMaximized().then(applyIcon).catch(() => {});
  window.electronAPI.onWindowStateChanged(applyIcon);
}

async function loadAppVersion() {
  try {
    const v = await window.electronAPI.getAppVersion();
    setLabel("app-version-label", "v" + v);
  } catch {}
}

/* =========================================================================
   GENERAL UI BINDINGS
   ========================================================================= */
function wireToggle(id, onChange, startActive = false) {
  const el = document.getElementById(id);
  if (!el) return;
  if (startActive) el.classList.add("active");
  el.addEventListener("click", () => {
    const active = el.classList.toggle("active");
    onChange(active);
  });
}

// Same as wireToggle, but its on/off state is restored from — and written
// back to — settings.json, so it stays exactly as the person left it
// until they flip it again in Settings.
function wirePersistedToggle(id, settingKey, onChange) {
  const el = document.getElementById(id);
  if (!el) return;
  const initial = !!appSettings[settingKey];
  if (initial) el.classList.add("active");
  onChange(initial);
  el.addEventListener("click", () => {
    const active = el.classList.toggle("active");
    onChange(active);
    updateSetting(settingKey, active);
  });
}

function bindUI() {
  document.getElementById("add-sounds-btn")?.addEventListener("click", async () => {
    const files = await window.electronAPI.openFileDialog();
    await addFiles(files);
  });

  let searchDebounce;
  document.getElementById("search-input")?.addEventListener("input", (e) => {
    clearTimeout(searchDebounce);
    const value = e.target.value;
    searchDebounce = setTimeout(() => renderGrid(value), 150);
  });
  document.getElementById("category-filter")?.addEventListener("change", (e) => {
    currentCategory = e.target.value;
    renderGrid(currentSearchValue());
  });
  document.getElementById("stop-all-btn")?.addEventListener("click", stopAll);
  document.getElementById("btn-minimize")?.addEventListener("click", () => window.electronAPI.windowMinimize());
  document.getElementById("btn-maximize")?.addEventListener("click", () => window.electronAPI.windowMaximize());
  document.getElementById("btn-close")?.addEventListener("click", () => window.electronAPI.windowClose());

  wirePersistedToggle("local-monitor-toggle", "localMonitorEnabled", (active) => setLocalMonitorEnabled(active));
  wirePersistedToggle("monitor-mic-feed-toggle", "monitorMicFeedEnabled", (active) => setMonitorMicFeed(active));
  wirePersistedToggle("mic-fx-toggle", "micFxEnabled", (active) => { micFxEnabled = active; rebuildMicChain(); });
  wirePersistedToggle("duck-toggle", "duckEnabled", (active) => { duckEnabled = active; });
  wirePersistedToggle("queue-toggle", "queueMode", (active) => { queueMode = active; queue = []; });
  wirePersistedToggle("stop-overlap-toggle", "stopOnOverlap", (active) => { stopOnOverlap = active; });
  wirePersistedToggle("loop-toggle", "loopEnabled", (active) => { loopEnabled = active; });
  wirePersistedToggle("noise-gate-toggle", "noiseGateEnabled", (active) => {
    noiseGateEnabled = active;
    if (!active && micGateGain) micGateGain.gain.value = 1;
  });
  // Mic mute is a live, momentary control (not a saved preference) —
  // it always starts unmuted on launch.
  wireToggle("mic-mute-toggle", (active) => setMicMuted(active));
  wirePersistedToggle("push-to-talk-toggle", "pushToTalkMode", (active) => {
    pushToTalkMode = active;
    setMicMuted(active);
  });

  const masterSlider = document.getElementById("master-volume");
  if (masterSlider) {
    const savedMaster = appSettings.masterVolume ?? parseInt(masterSlider.value, 10);
    masterSlider.value = savedMaster;
    setLabel("master-vol-label", savedMaster + "%");
    monitorGain.gain.value = savedMaster / 100;
    masterSlider.addEventListener("input", () => {
      setLabel("master-vol-label", masterSlider.value + "%");
      monitorGain.gain.value = masterSlider.value / 100;
      updateSetting("masterVolume", parseInt(masterSlider.value, 10));
    });
  }

  const micSlider = document.getElementById("mic-volume");
  if (micSlider) {
    const savedMic = appSettings.micVolume ?? parseInt(micSlider.value, 10);
    micSlider.value = savedMic;
    setLabel("mic-vol-label", savedMic + "%");
    micSendGain.gain.value = savedMic / 100;
    micSlider.addEventListener("input", () => {
      setLabel("mic-vol-label", micSlider.value + "%");
      micSendGain.gain.value = micSlider.value / 100;
      updateSetting("micVolume", parseInt(micSlider.value, 10));
    });
  }

  const gateThresholdSlider = document.getElementById("noise-gate-threshold");
  if (gateThresholdSlider) {
    const savedThreshold = appSettings.noiseGateThreshold ?? parseFloat(gateThresholdSlider.value);
    gateThresholdSlider.value = savedThreshold;
    noiseGateThreshold = savedThreshold / 100;
    setLabel("noise-gate-threshold-label", savedThreshold + "%");
    gateThresholdSlider.addEventListener("input", () => {
      noiseGateThreshold = parseFloat(gateThresholdSlider.value) / 100;
      setLabel("noise-gate-threshold-label", gateThresholdSlider.value + "%");
      updateSetting("noiseGateThreshold", parseFloat(gateThresholdSlider.value));
    });
  }

  document.getElementById("modal-overlay")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("modal-overlay")) closeModal();
  });
  document.getElementById("modal-cancel-btn")?.addEventListener("click", closeModal);
  document.getElementById("edit-volume")?.addEventListener("input", (e) => {
    setLabel("edit-vol-label", e.target.value + "%");
  });
  document.getElementById("hotkey-clear-btn")?.addEventListener("click", () => {
    setVal("edit-hotkey", "");
    stopHotkeyRecording();
  });
  document.getElementById("reveal-file-btn")?.addEventListener("click", () => {
    if (!editingId) return;
    const sound = sounds.find((s) => s.id === editingId);
    if (sound) window.electronAPI.showInFolder(sound.file);
  });

  document.getElementById("edit-rvc-preview-btn")?.addEventListener("click", async () => {
    if (!editingId) return;
    const sound = sounds.find((s) => s.id === editingId);
    if (!sound) return;
    stopRvcPreview();
    if (!editingRvcVoice) {
      showToast("⚠️ Pick a voice first — Off has nothing to preview here");
      return;
    }
    setLabel("edit-rvc-status", "Converting…");
    resetEditRvcLog();
    const result = await window.electronAPI.convertRvcFile(sound.file, sound.id, editingRvcVoice, editingRvcPitch, editingRvcSeparate);
    if (!result.success) {
      setLabel("edit-rvc-status", "");
      showToast("⚠️ RVC conversion failed: " + (result.error || "unknown error"));
      return;
    }
    setLabel("edit-rvc-status", result.cached ? "Cached ✓" : "Converted ✓");
    rvcPreviewAudio = new Audio(toFileUrl(result.outputPath));
    rvcPreviewAudio.volume = (sound.volume ?? 100) / 100;
    rvcPreviewAudio.play().catch(() => {});
  });

  document.getElementById("edit-rvc-reconvert-btn")?.addEventListener("click", async () => {
    if (!editingId) return;
    const sound = sounds.find((s) => s.id === editingId);
    if (!sound) return;
    if (!editingRvcVoice) {
      showToast("⚠️ Pick a voice first — Off has nothing to reconvert here");
      return;
    }
    stopRvcPreview();
    setLabel("edit-rvc-status", "Clearing old conversion…");
    resetEditRvcLog();
    await window.electronAPI.clearRvcConversion(sound.id, editingRvcVoice, editingRvcPitch, editingRvcSeparate);
    // Drop the in-memory decoded copy too, in case a corrupt/stale file
    // was already loaded once this session — otherwise playback would
    // keep using the old broken buffer even after the file is redone.
    bufferCache.delete(`${sound.file}::rvc::${editingRvcVoice}::${editingRvcPitch}${editingRvcSeparate ? "::sep" : ""}`);

    setLabel("edit-rvc-status", "Converting…");
    const result = await window.electronAPI.convertRvcFile(sound.file, sound.id, editingRvcVoice, editingRvcPitch, editingRvcSeparate);
    if (!result.success) {
      setLabel("edit-rvc-status", "");
      showToast("⚠️ RVC conversion failed: " + (result.error || "unknown error"));
      return;
    }
    setLabel("edit-rvc-status", "Converted ✓");
    rvcPreviewAudio = new Audio(toFileUrl(result.outputPath));
    rvcPreviewAudio.volume = (sound.volume ?? 100) / 100;
    rvcPreviewAudio.play().catch(() => {});
  });

  document.getElementById("modal-save-btn")?.addEventListener("click", async () => {
    if (!editingId) return;
    const sound = sounds.find((s) => s.id === editingId);
    if (!sound) return;
    const oldHotkey = sound.hotkey;

    sound.name = getVal("edit-name").trim() || sound.name;
    sound.emoji = getVal("edit-emoji").trim() || "🔊";
    sound.hotkey = getVal("edit-hotkey").trim();
    sound.volume = parseInt(getVal("edit-volume", 100));
    sound.category = getVal("edit-category").trim();
    sound.fadeIn = parseInt(getVal("edit-fadein", 0)) || 0;
    sound.fadeOut = parseInt(getVal("edit-fadeout", 0)) || 0;

    const sendToMicEl = document.getElementById("edit-send-to-mic");
    if (sendToMicEl) sound.sendToMic = sendToMicEl.checked;

    const voiceVals = currentVoiceFormValues();
    sound.voicePreset = voiceVals.voicePreset;
    sound.pitchOffset = voiceVals.pitchOffset;
    sound.formantTilt = voiceVals.formantTilt;

    const sel = document.querySelector(".color-swatch.selected");
    if (sel) sound.color = sel.dataset.color;

    const rvcChanged =
      editingRvcVoice !== (sound.rvcVoice || null) ||
      editingRvcPitch !== (sound.rvcPitch || 0) ||
      editingRvcSeparate !== !!sound.rvcSeparateVocals;

    if (rvcChanged) {
      if (editingRvcVoice) {
        setLabel("edit-rvc-status", "Converting…");
        resetEditRvcLog();
        const saveBtn = document.getElementById("modal-save-btn");
        if (saveBtn) saveBtn.disabled = true;
        const result = await window.electronAPI.convertRvcFile(sound.file, sound.id, editingRvcVoice, editingRvcPitch, editingRvcSeparate);
        if (saveBtn) saveBtn.disabled = false;
        if (!result.success) {
          setLabel("edit-rvc-status", "");
          showToast("⚠️ RVC conversion failed: " + (result.error || "unknown error"));
          return; // leave the sound as it was so the person can retry
        }
        sound.rvcVoice = editingRvcVoice;
        sound.rvcPitch = editingRvcPitch;
        sound.rvcSeparateVocals = editingRvcSeparate;
      } else {
        sound.rvcVoice = null;
        sound.rvcPitch = 0;
        sound.rvcSeparateVocals = false;
      }
    }

    if (sound.hotkey !== oldHotkey) {
      const result = await window.electronAPI.registerHotkey({ id: sound.id, accelerator: sound.hotkey });
      if (!result.success) {
        showToast("⚠️ Hotkey conflict: " + result.error);
        sound.hotkey = oldHotkey;
      }
    }
    await saveSoundsNow();
    renderGrid(currentSearchValue());
    renderCategoryFilter();
    closeModal();
    showToast("✅ Saved");
  });

  document.getElementById("modal-delete-btn")?.addEventListener("click", async () => {
    if (!editingId) return;
    const idToDelete = editingId;
    try { await window.electronAPI?.unregisterHotkey?.(idToDelete); } catch (err) { console.error("unregisterHotkey failed:", err); }
    closeModal();
    softDeleteSound(idToDelete);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (document.getElementById("modal-overlay")?.classList.contains("visible")) {
      if (recordingHotkey) { stopHotkeyRecording(); return; }
      closeModal();
      return;
    }
    if (document.getElementById("settings-modal-overlay")?.classList.contains("visible")) {
      closeSettingsModal();
      return;
    }
    if (document.getElementById("yt-import-modal-overlay")?.classList.contains("visible")) {
      closeYoutubeImportModal();
    }
  });
}

/* =========================================================================
   UTIL
   ========================================================================= */
// Turns a raw filesystem path into a valid file:// URL. Just swapping
// backslashes for forward slashes (the old approach) breaks on filenames
// with spaces, brackets, etc. — common in YouTube-downloaded files, which
// include the video ID in [brackets] — since those need percent-encoding
// or fetch()/Audio() silently reject the URL. The Windows drive letter
// segment ("C:") is left alone since encoding its colon would break it.
function toFileUrl(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  const encoded = normalized
    .split("/")
    .map((part, i) => (i === 0 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part)))
    .join("/");
  return `file://${encoded}`;
}

function escHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

let toastTimer;
function showToast(msg, { actionLabel, onAction } = {}) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.innerHTML = "";
  const span = document.createElement("span");
  span.textContent = msg;
  t.appendChild(span);
  if (actionLabel && onAction) {
    const btn = document.createElement("button");
    btn.textContent = actionLabel;
    btn.style.cssText = "margin-left:12px;background:none;border:none;color:var(--accent);font-weight:700;cursor:pointer;";
    btn.addEventListener("click", () => { onAction(); t.classList.remove("show"); });
    t.appendChild(btn);
  }
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), actionLabel ? 6000 : 2500);
}
