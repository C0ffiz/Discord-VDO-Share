/**
 * @name VDOShare
 * @author C0ffiz
 * @authorLink https://github.com/C0ffiz
 * @description Reativa o Go Live nativo do Discord ("Compartilhar Tela") e transmite a tela direto do Discord via VDO.Ninja (P2P), com um Rich Presence "Assistir Transmissão" para quem quiser assistir no navegador.
 * @version 2.1.0
 * @source https://github.com/C0ffiz/Discord-VDO-Share
 * @website https://github.com/C0ffiz/Discord-VDO-Share
 * @updateUrl https://raw.githubusercontent.com/C0ffiz/Discord-VDO-Share/main/VDOShare.plugin.js
 */

"use strict";

// Parts of this file (GoLiveBridge, keepAlive) are adapted from
// https://github.com/ADCDS/discord-byo-stream, Copyright (c) 2026 Adriel Santos,
// MIT License. See THIRD_PARTY_NOTICES.md for the full notice.

/* ========================================================================== *
 *  Constants
 * ========================================================================== */

// VDO.Ninja SDK (MPL-2.0, https://github.com/steveseguin/ninjasdk), fetched at
// runtime from npm CDNs. The hash pins the exact file: anything else is refused.
const SDK_VERSION = "1.6.2";
const SDK_URLS = [
    `https://cdn.jsdelivr.net/npm/@vdoninja/sdk@${SDK_VERSION}/vdoninja-sdk.min.js`,
    `https://unpkg.com/@vdoninja/sdk@${SDK_VERSION}/vdoninja-sdk.min.js`
];
const SDK_SHA256 = "5b2f9f0800c398026e4ca92cda40a0a01069b42d6f4c504dfbcb9027e97a0934";

// Discord's client-side experiment that hides/locks Go Live by region (e.g. Brazil since 08/2026).
const VIDEO_GUARD_EXPERIMENT = "2026-08-video-guard";
const STREAM_ID_PREFIX = "vdoshare:";
const REGION = "vdo-ninja";
const STREAM_CONTEXT = "stream";
const GATEWAY_STREAM_METHODS = ["streamCreate", "streamWatch", "streamDelete", "streamSetPaused", "streamPing"];
const REASON_USER_REQUESTED = "user_requested";
const REASON_UNAUTHORIZED = "unauthorized";
const INSTALL_RETRY_MS = 2000;
// Intl message hash that appears in the source of Discord's Go Live modal module.
const GO_LIVE_MODAL_SOURCE = "GQgGHISKZ5aYqYeYhX9isDUHGw";

const CODEC_OPTIONS = [
    {label: "Automático", value: ""},
    {label: "H.264 (menos CPU com aceleração)", value: "h264"},
    {label: "VP9", value: "vp9"},
    {label: "AV1", value: "av1"},
    {label: "VP8", value: "vp8"}
];

const QUALITY_PRESETS = [
    {label: "4K 60", values: {customHeight: 2160, customFps: 60, maxBitrate: 20000}},
    {label: "1440p 60", values: {customHeight: 1440, customFps: 60, maxBitrate: 12000}},
    {label: "1080p 120", values: {customHeight: 1080, customFps: 120, maxBitrate: 12000}},
    {label: "1080p 60", values: {customHeight: 1080, customFps: 60, maxBitrate: 8000}},
    {label: "720p 60", values: {customHeight: 720, customFps: 60, maxBitrate: 4500}},
    {label: "Texto (1440p 15)", values: {customHeight: 1440, customFps: 15, maxBitrate: 4000}},
    {label: "Nativa 60", values: {customHeight: 0, customFps: 60, maxBitrate: 0}}
];
const INSTALL_GIVE_UP_MS = 60000;

const DEFAULTS = {
    // Stream
    idMode: "fixed",            // "fixed" | "session"
    streamId: "",
    apiKey: "",                 // only used by the browser fallback (&api remote control)
    unlockQuality: true,        // unlock every resolution/FPS in Discord's Go Live picker
    customQuality: false,       // override the picker with the values below
    customHeight: 1080,         // px, 0 = source (native)
    customFps: 60,
    maxBitrate: 0,              // kbps, 0 = automatic
    minBitrate: 0,              // kbps, 0 = none
    audioBitrate: 0,            // kbps, 0 = SDK default
    videoCodec: "",             // publisher preference: "" | "h264" | "vp9" | "av1" | "vp8"
    keepAlive: true,
    streamLabel: "",
    signalingHost: "",          // empty = SDK default (wss://wss.vdo.ninja)
    takeOverGoLive: true,
    // Viewer link
    baseUrl: "https://vdo.ninja/",
    viewerBitrate: 0,
    viewerCodec: "",
    hqAudio: true,
    waitMessage: "A transmissão vai começar em instantes...",
    extraViewParams: "",
    // Browser fallback
    apiUrl: "https://api.vdo.ninja/",
    extraPushParams: "",
    // Rich Presence
    rpcEnabled: true,
    appId: "",
    activityName: "Transmissão ao vivo",
    activityType: 3,            // 0 Playing, 2 Listening, 3 Watching, 5 Competing
    details: "Compartilhando a tela via VDO.Ninja",
    state: "Clique em \"Assistir Transmissão\"",
    showViewerCount: true,
    buttonLabel: "Assistir Transmissão",
    largeImage: "",
    copyViewerLink: true
};

/* ========================================================================== *
 *  Small helpers
 * ========================================================================== */

function randomId(length) {
    const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    let out = "";
    for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
    return out;
}

function sanitizeId(value) {
    return String(value || "").replace(/[^A-Za-z0-9_]/g, "").slice(0, 40);
}

// Params with value `true` become bare flags ("&stereo"); null/false/"" are skipped.
function buildUrl(base, params, extra) {
    const parts = [];
    for (const [key, value] of params) {
        if (value === null || value === undefined || value === false || value === "") continue;
        parts.push(value === true ? key : `${key}=${encodeURIComponent(value)}`);
    }
    const extraClean = String(extra || "").trim().replace(/^[?&]+/, "");
    if (extraClean) parts.push(extraClean);
    const root = /\/$/.test(base) || base.includes("?") ? base : base + "/";
    return root + (root.includes("?") ? "&" : "?") + parts.join("&");
}

async function sha256Hex(text) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function streamKeyOf({streamType, guildId, channelId, ownerId}) {
    return streamType === "guild" ? ["guild", guildId, channelId, ownerId].join(":") : ["call", channelId, ownerId].join(":");
}

function parseStreamKey(key) {
    const parts = String(key || "").split(":");
    return parts[0] === "guild"
        ? {streamType: "guild", guildId: parts[1], channelId: parts[2], ownerId: parts[3]}
        : {streamType: "call", guildId: null, channelId: parts[1], ownerId: parts[2]};
}

const isMac = () => navigator.platform.startsWith("Mac");
const isLinux = () => navigator.platform.startsWith("Linux");
const isWindows = () => navigator.platform.startsWith("Win");

/* ========================================================================== *
 *  Capture (inside Discord's Electron renderer)
 * ========================================================================== */

function listSources() {
    const capture = window.DiscordNative?.desktopCapture;
    if (!capture?.getDesktopCaptureSources) return Promise.reject(new Error("DiscordNative.desktopCapture indisponível"));
    return capture.getDesktopCaptureSources({types: ["screen", "window"], thumbnailSize: {width: 320, height: 180}});
}

// Discord sets no display-media handler, so getDisplayMedia is unavailable;
// Electron's chromeMediaSource constraints are used instead. Only Windows can
// capture system audio this way, and it is the *whole* system output.
async function captureSource({sourceId, width, height, fps, wantAudio}) {
    const video = {mandatory: {chromeMediaSource: "desktop", chromeMediaSourceId: sourceId, maxWidth: width, maxHeight: height, maxFrameRate: fps}};
    let audioError = wantAudio ? null : "not requested";
    if (wantAudio && !isWindows()) audioError = "o Discord só consegue capturar o áudio do sistema no Windows";
    if (wantAudio && !audioError) {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({audio: {mandatory: {chromeMediaSource: "desktop"}}, video});
            const audio = stream.getAudioTracks()[0] ?? null;
            return {video: stream.getVideoTracks()[0], audio, audioError: audio ? null : "nenhuma faixa de áudio"};
        }
        catch (error) {
            audioError = `${error.name}: ${error.message}`; // a failed audio capture must not cost the video
        }
    }
    const stream = await navigator.mediaDevices.getUserMedia({audio: false, video});
    return {video: stream.getVideoTracks()[0], audio: null, audioError};
}

// Screen capture only emits frames when the screen changes; a viewer joining a
// still screen would see black until something moves. This re-sends the last
// frame at >= 5 fps and trims frames to multiples of 8 px (hardware encoders).
// Adapted from ADCDS/discord-byo-stream (plugin/src/keepalive.js).
function keepAlive(track) {
    if (typeof MediaStreamTrackProcessor !== "function" || typeof MediaStreamTrackGenerator !== "function") return track;
    const MIN_FPS = 5;
    const ALIGN = 8;
    let alignFailed = false;
    const align = (frame) => {
        if (alignFailed) return frame;
        try {
            const r = frame.visibleRect;
            const width = Math.max(ALIGN, r.width - (r.width % ALIGN));
            const height = Math.max(ALIGN, r.height - (r.height % ALIGN));
            if (width === r.width && height === r.height) return frame;
            const cropped = new VideoFrame(frame, {visibleRect: {x: r.x, y: r.y, width, height}, displayWidth: width, displayHeight: height});
            frame.close();
            return cropped;
        }
        catch (_) {
            alignFailed = true;
            return frame;
        }
    };

    const reader = new MediaStreamTrackProcessor({track}).readable.getReader();
    const generator = new MediaStreamTrackGenerator({kind: "video"});
    const writer = generator.writable.getWriter();
    let last = null;
    let lastAt = 0;
    let finished = false;

    const finish = () => {
        if (finished) return;
        finished = true;
        clearInterval(timer);
        last?.close();
        last = null;
        reader.cancel().catch(() => {});
        writer.close().catch(() => {});
        track.stop();
    };

    const timer = setInterval(() => {
        if (!last || finished || performance.now() - lastAt < 1000 / MIN_FPS) return;
        if (writer.desiredSize !== null && writer.desiredSize <= 0) return;
        const repeat = new VideoFrame(last, {timestamp: last.timestamp + Math.round((performance.now() - lastAt) * 1000)});
        writer.write(repeat).catch(() => repeat.close());
    }, 1000 / MIN_FPS);

    (async () => {
        try {
            for (;;) {
                const {value: raw, done} = await reader.read();
                if (done) break;
                const frame = align(raw);
                last?.close();
                last = frame.clone();
                lastAt = performance.now();
                await writer.write(frame);
            }
        }
        catch (_) { /* capture or published track went away */ }
        const endedBySource = !finished;
        finish();
        if (endedBySource) generator.dispatchEvent(new Event("ended"));
    })();

    const stop = generator.stop.bind(generator);
    generator.stop = () => { finish(); stop(); };
    generator.contentHint = track.contentHint;
    return generator;
}

/* ========================================================================== *
 *  Native Go Live bridge
 *
 *  Keeps Discord's own Go Live UI (button, picker, LIVE badge, own stream tile,
 *  "Stop Streaming") and routes it to our VDO.Ninja stream. Approach adapted
 *  from ADCDS/discord-byo-stream (plugin/src/native.js): the stream is marked
 *  active with STREAM_UPDATE (not STREAM_CREATE, which expects a real media
 *  server), Discord's gateway stream calls for our stream are dropped, and the
 *  states Discord's servers would send back are dispatched locally.
 * ========================================================================== */

class GoLiveBridge {
    constructor(plugin) {
        this.plugin = plugin;
        this.api = plugin.api;
        this.pendingSource = null;
        this.pickedSource = null;
        this.own = null;            // {key, guildId, channelId, started}
        this.videoListeners = new Set();
        this.regionLocked = false;
        this.undo = [];
    }

    log(...args) { this.api.Logger.log(...args); }

    locate() {
        const {Webpack} = this.api;
        const need = (name, value) => {
            if (!value) throw new Error(`${name} not found`);
            return value;
        };
        const store = (name) => Webpack.getStore?.(name) ?? Webpack.getModule(m => m?._dispatchToken && m.getName?.() === name, {searchExports: true});
        const guardFilter = (exact) => (m) => typeof m?.getConfig === "function" && typeof m?.definition?.name === "string"
            && (exact ? m.definition.name === VIDEO_GUARD_EXPERIMENT : /video[-_]?guard/i.test(m.definition.name));
        return {
            dispatcher: need("dispatcher", Webpack.getModule(m => typeof m?.addInterceptor === "function" && Array.isArray(m?._interceptors), {searchExports: true})),
            guard: Webpack.getModule(guardFilter(true), {searchExports: true}) ?? Webpack.getModule(guardFilter(false), {searchExports: true}),
            mediaEngine: need("MediaEngineStore", store("MediaEngineStore")),
            gateway: need("GatewayConnectionStore", store("GatewayConnectionStore")),
            voiceStates: need("VoiceStateStore", store("VoiceStateStore")),
            previews: store("ApplicationStreamPreviewStore"),
            users: need("UserStore", store("UserStore")),
            channels: store("ChannelStore")
        };
    }

    install() {
        try {
            Object.assign(this, this.locate());
            this.installSteps();
            return true;
        }
        catch (error) {
            this.rollback();
            throw error;
        }
    }

    installSteps() {
        const P = this.api.Patcher;
        this.selfId = () => this.users.getCurrentUser()?.id;

        // 1. Unlock Go Live (the regional "video guard" experiment).
        if (this.guard) {
            const unlock = (_, args, original) => {
                const config = original(...args);
                if (config && config.videoEnabled === false) this.regionLocked = true;
                return {...config, videoEnabled: true};
            };
            this.undo.push(P.instead(this.guard, "getConfig", unlock));
            if (typeof this.guard.useConfig === "function") this.undo.push(P.instead(this.guard, "useConfig", unlock));
        }
        else this.log("video guard experiment not found (Go Live may already be unlocked here)");

        // 2. Drop Discord's gateway calls for *our* stream; other people's streams are untouched.
        this.patchGateway();

        // 3. Render our capture in Discord's own stream tiles.
        this.videoComponent = this.createVideoComponent();
        this.undo.push(P.instead(this.mediaEngine, "getVideoComponent", (_, args, original) => {
            this.fallbackComponent = original(...args);
            return this.videoComponent;
        }));
        if (this.previews?.shouldFetchPreview) {
            this.undo.push(P.instead(this.previews, "shouldFetchPreview", (_, args, original) =>
                args.some(a => a === this.selfId()) ? false : original(...args)));
        }

        // 4. Picker: make Discord hand back sources Chromium can capture.
        const engine = this.mediaEngine.getMediaEngine?.();
        if (isLinux() && engine?.presentNativeScreenSharePicker) {
            // On Wayland the system picker is the desktop portal; open it through Chromium instead.
            this.undo.push(P.instead(engine, "presentNativeScreenSharePicker", () => {
                this.presentSystemPicker().catch(error => this.log(`picker failed: ${error.message}`));
            }));
            for (const name of ["setNativeDesktopVideoSourcePickerActive", "releaseNativeDesktopVideoSourcePickerStream"]) {
                if (typeof engine[name] === "function") this.undo.push(P.instead(engine, name, () => {}));
            }
        }
        else {
            // Windows/macOS: use Discord's own source window fed from Chromium's sources.
            for (const name of ["getUseSystemScreensharePicker", "supportsSystemScreensharePicker"]) {
                if (typeof this.mediaEngine[name] === "function") this.undo.push(P.instead(this.mediaEngine, name, () => false));
            }
            if (engine && typeof engine.supports === "function") {
                this.undo.push(P.instead(engine, "supports", (_, [feature], original) =>
                    feature === "SCREEN_PREVIEWS" || feature === "WINDOW_PREVIEWS" ? false : original(feature)));
            }
        }

        // 5. Intercept Discord's Go Live actions before Discord handles them.
        const interceptor = (action) => {
            try { return this.onAction(action); }
            catch (error) { this.log(`interceptor error on ${action?.type}`, error); return false; }
        };
        this.dispatcher.addInterceptor(interceptor);
        this.undo.push(() => {
            const index = this.dispatcher._interceptors.indexOf(interceptor);
            if (index >= 0) this.dispatcher._interceptors.splice(index, 1);
        });

        this.mediaEngine.emitChange?.();
        this.log("native Go Live bridge installed");
    }

    patchGateway() {
        const socket = this.gateway.getSocket?.();
        if (!socket || socket === this.patchedSocket) return;
        this.patchedSocket = socket;
        for (const method of GATEWAY_STREAM_METHODS) {
            if (typeof socket[method] !== "function") continue;
            this.undo.push(this.api.Patcher.instead(socket, method, (_, args, original) => {
                if (this.isOurGatewayCall(method, args[0])) return this.log(`blocked gateway ${method}`);
                return original(...args);
            }));
        }
    }

    isOurGatewayCall(method, first) {
        if (!this.plugin.settings.takeOverGoLive) return false;
        if (method === "streamCreate") return true;
        const key = typeof first === "string" ? first : first?.streamKey;
        if (!key) return Boolean(this.own);
        return key === this.own?.key || parseStreamKey(key).ownerId === this.selfId();
    }

    uninstall() {
        if (this.undo.length) this.endOwnStream();
        this.rollback();
        this.mediaEngine?.emitChange?.();
    }

    rollback() {
        for (const undo of this.undo.reverse()) {
            try { undo(); }
            catch (error) { this.log(`undo failed: ${error.message}`); }
        }
        this.undo = [];
        this.patchedSocket = null;
    }

    dispatch(action) {
        Promise.resolve(this.dispatcher.dispatch(action)).catch(error => this.log(`dispatch ${action.type} failed: ${error.message}`));
    }

    /** Runs before Discord handles any action. Returning true drops the action. */
    onAction(action) {
        if (!this.plugin.settings.takeOverGoLive) return false;
        switch (action.type) {
            case "MEDIA_ENGINE_SET_GO_LIVE_SOURCE":
                return this.onGoLiveSource(action);
            case "MEDIA_ENGINE_SET_VIDEO_ENABLED":
                // With the region lock the camera would still go to Discord's servers and fail.
                if (action.enabled && this.regionLocked) {
                    this.api.UI.showToast("VDOShare: a câmera continua bloqueada pelo Discord na sua região.", {type: "warning"});
                    return true;
                }
                return false;
            case "STREAM_START":
                this.patchGateway();
                this.onStreamStart(action);
                return false;
            case "STREAM_WATCH":
                return this.onStreamWatch(action);
            case "STREAM_STOP":
                this.onStreamStop(action);
                return false;
            case "VOICE_STATE_UPDATES":
                // Discord's servers don't know about our stream and would clear the LIVE flag.
                if (this.own?.started) {
                    for (const state of action.voiceStates ?? []) {
                        if (state.userId === this.selfId() && state.channelId) state.selfStream = true;
                    }
                }
                return false;
            default:
                return false;
        }
    }

    // ---- picking ----

    async presentSystemPicker() {
        const existing = Boolean(this.own?.started);
        const source = await this.plugin.pickSource({askAudio: false});
        if (!source) {
            this.dispatch({type: "NATIVE_SCREEN_SHARE_PICKER_CANCEL", existing});
            return;
        }
        this.pickedSource = source;
        const isWindow = source.id.startsWith("window:");
        const content = {windows: isWindow ? [{title: source.name}] : [], applications: [], displays: isWindow ? [] : [{name: source.name}]};
        this.dispatch({type: "NATIVE_SCREEN_SHARE_PICKER_UPDATE", existing, content});
    }

    onGoLiveSource({settings}) {
        if (!settings?.desktopSettings) {
            if (settings?.cameraSettings) this.api.UI.showToast("VDOShare: câmera como fonte de transmissão não é suportada.", {type: "warning"});
            return true; // never start Discord's native capture engine
        }
        let sourceId = settings.desktopSettings.sourceId;
        let sourceName = null;
        if (String(sourceId).startsWith("prepicked:") && this.pickedSource) {
            ({id: sourceId, name: sourceName} = this.pickedSource);
            this.pickedSource = null;
        }
        const source = {
            sourceId,
            sourceName,
            sound: Boolean(settings.desktopSettings.sound),
            resolution: settings.qualityOptions?.resolution ?? 1080,
            fps: settings.qualityOptions?.frameRate ?? 30
        };
        // Discord re-sends the same source right after a stream starts.
        const current = this.startingSource ?? this.activeSource;
        if (current && current.sourceId === source.sourceId && current.sound === source.sound
            && current.resolution === source.resolution && current.fps === source.fps) return true;
        this.pendingSource = source;
        this.beginIfReady();
        return true;
    }

    onStreamStart({streamType, guildId, channelId}) {
        if (this.own?.started) return; // source switch: GO_LIVE_SOURCE handles it
        const ownerId = this.selfId();
        this.own = {key: streamKeyOf({streamType, guildId, channelId, ownerId}), guildId: guildId ?? null, channelId, started: false};
        this.beginIfReady();
    }

    beginIfReady() {
        if (!this.own || !this.pendingSource || this.starting) return;
        const source = this.pendingSource;
        this.pendingSource = null;
        this.starting = true;
        this.startingSource = source;
        this.startSharing(source)
            .then(() => { this.activeSource = source; })
            .catch((error) => {
                this.log("stream failed", error);
                this.api.UI.showToast(`VDOShare: não foi possível transmitir — ${error.message}`, {type: "error", timeout: 8000});
                const own = this.own;
                this.own = null;
                this.activeSource = null;
                if (own) {
                    if (own.started) this.clearOwnUi(own);
                    this.dispatch({type: "STREAM_DELETE", streamKey: own.key, unavailable: false, reason: REASON_UNAUTHORIZED});
                }
                this.plugin.endShare({silent: true});
            })
            .finally(() => {
                this.starting = false;
                this.startingSource = null;
                this.beginIfReady();
            });
    }

    async startSharing(source) {
        const wasLive = this.own.started;
        if (wasLive) await this.plugin.switchSource(source);
        else await this.plugin.startNativeShare(source, () => this.endOwnStream({fromCapture: true}));
        if (!this.own) return;
        const {key, guildId} = this.own;
        this.own.started = true;
        this.dispatch({type: "STREAM_UPDATE", streamKey: key, region: REGION, viewerIds: [], paused: false});
        if (!wasLive) this.setVoiceStateStream(this.selfId(), true);
        this.dispatch({type: "RTC_CONNECTION_VIDEO", userId: this.selfId(), guildId, streamId: STREAM_ID_PREFIX + this.selfId(), context: STREAM_CONTEXT});
        this.notifyVideoListeners();
    }

    onStreamWatch({streamKey}) {
        const {ownerId, guildId} = parseStreamKey(streamKey);
        if (ownerId !== this.selfId() || !this.own?.started) return false;
        // Discord's preview of your own stream: point it at our capture.
        this.dispatch({type: "STREAM_UPDATE", streamKey, region: REGION, viewerIds: [], paused: false});
        this.dispatch({type: "RTC_CONNECTION_VIDEO", userId: ownerId, guildId, streamId: STREAM_ID_PREFIX + ownerId, context: STREAM_CONTEXT});
        return false;
    }

    onStreamStop({streamKey}) {
        if (streamKey === this.own?.key) this.endOwnStream();
        else if (parseStreamKey(streamKey).ownerId === this.selfId() && this.plugin.share?.mode === "native") this.endOwnStream();
    }

    /** Ends our stream and tells Discord's UI. */
    endOwnStream({fromCapture = false} = {}) {
        const own = this.own;
        this.own = null;
        this.pendingSource = null;
        this.activeSource = null;
        if (this.plugin.share?.mode === "native") this.plugin.endShare({reason: fromCapture ? "a fonte compartilhada foi fechada — transmissão encerrada." : null});
        if (!own || !this.dispatcher) return;
        if (own.started) this.clearOwnUi(own);
        this.dispatch({type: "STREAM_DELETE", streamKey: own.key, unavailable: false, reason: REASON_USER_REQUESTED});
    }

    clearOwnUi(own) {
        this.setVoiceStateStream(this.selfId(), false, own.channelId);
        this.dispatch({type: "RTC_CONNECTION_VIDEO", userId: this.selfId(), guildId: own.guildId, streamId: null, context: STREAM_CONTEXT});
        this.notifyVideoListeners();
    }

    setVoiceStateStream(userId, live, channelIdOverride) {
        const channelId = channelIdOverride ?? this.own?.channelId;
        const state = channelId ? this.voiceStates.getVoiceStateForChannel?.(channelId, userId) : null;
        if (!state) return false;
        const guildId = this.channels?.getChannel?.(channelId)?.getGuildId?.() ?? null;
        this.dispatch({
            type: "VOICE_STATE_UPDATES",
            voiceStates: [{
                userId, guildId, channelId,
                sessionId: state.sessionId,
                mute: state.mute,
                deaf: state.deaf,
                selfMute: state.selfMute,
                selfDeaf: state.selfDeaf,
                selfVideo: state.selfVideo,
                selfStream: live,
                suppress: state.suppress,
                requestToSpeakTimestamp: state.requestToSpeakTimestamp
            }]
        });
        return true;
    }

    // ---- video tile ----

    notifyVideoListeners() {
        for (const listener of this.videoListeners) listener();
    }

    createVideoComponent() {
        const bridge = this;
        const {Component, createElement} = BdApi.React;

        // Discord passes {className, streamId, onResize, onReady, paused}.
        class LiveVideo extends Component {
            constructor(props) {
                super(props);
                this.video = null;
                this.track = null;
                this.setVideo = (element) => { this.video = element; this.attach(); };
                this.attach = () => {
                    const video = this.video;
                    if (!video) return;
                    const track = bridge.plugin.share?.mode === "native" ? bridge.plugin.share.videoTrack : null;
                    if (track === this.track) return;
                    this.track = track;
                    video.srcObject = track ? new MediaStream([track]) : null;
                    if (track) video.play().catch(() => {});
                };
            }
            componentDidMount() { bridge.videoListeners.add(this.attach); }
            componentDidUpdate() {
                this.attach();
                if (!this.video) return;
                if (this.props.paused) this.video.pause();
                else if (this.video.paused && this.track) this.video.play().catch(() => {});
            }
            componentWillUnmount() { bridge.videoListeners.delete(this.attach); }
            render() {
                const {className, onReady, onResize} = this.props;
                return createElement("video", {
                    ref: this.setVideo,
                    className,
                    autoPlay: true,
                    playsInline: true,
                    muted: true,
                    onLoadedData: () => onReady?.(),
                    onResize: (event) => onResize?.({width: event.target.videoWidth, height: event.target.videoHeight})
                });
            }
        }

        return function VDOShareVideo(props) {
            if (String(props.streamId).startsWith(STREAM_ID_PREFIX)) return createElement(LiveVideo, props);
            return bridge.fallbackComponent ? createElement(bridge.fallbackComponent, props) : null;
        };
    }
}

/* ========================================================================== *
 *  Plugin
 * ========================================================================== */

module.exports = class VDOShare {
    constructor(meta) {
        this.meta = meta;
        this.api = new BdApi(meta.name);
        this.share = null;   // {mode: "native"|"standalone"|"browser", ...}
        this.busy = false;
        this.SDK = null;
    }

    /* ---------------- lifecycle ---------------- */

    start() {
        this.settings = Object.assign({}, DEFAULTS, this.api.Data.load("settings") || {});
        let dirty = false;
        if (!sanitizeId(this.settings.streamId)) { this.settings.streamId = randomId(12); dirty = true; }
        if (!sanitizeId(this.settings.apiKey)) { this.settings.apiKey = randomId(24); dirty = true; }
        dirty = this.migrateSettings() || dirty;
        if (dirty) this.saveSettings();

        this.Dispatcher = this.api.Webpack.getByKeys("dispatch", "subscribe", "unsubscribe")
            || this.api.Webpack.getModule(m => typeof m?.dispatch === "function" && typeof m?.subscribe === "function", {searchExports: true});
        this.AssetUtils = this.api.Webpack.getByKeys("fetchAssetIds");

        this.api.DOM.addStyle("vdoshare-css", PICKER_CSS);
        this.registerCommand();
        this.startedAt = Date.now();
        this.qualityUnlock = {validator: false, check: false};
        this.abort = new AbortController();
        this.tryInstallBridge();
        this.patchGoLiveModal();
        this.loadSdk().catch(error => this.api.Logger.warn("SDK preload failed", error));
    }

    stop() {
        clearTimeout(this.installTimer);
        this.abort?.abort();
        this.closePicker?.();
        this.bridge?.uninstall();
        this.bridge = null;
        this.endShare({silent: true});
        this.clearPresence();
        this.api.Patcher.unpatchAll();
        this.api.DOM.removeStyle("vdoshare-css");
        try { this.api.Commands?.unregisterAll?.(); } catch (_) { /* older BD */ }
    }

    saveSettings() {
        this.api.Data.save("settings", this.settings);
    }

    // v2.0 stored "quality"/"fps" dropdowns; map them onto the custom quality fields.
    migrateSettings() {
        const s = this.settings;
        if (!("quality" in s) && !("fps" in s)) return false;
        const height = {"720": 720, "1080": 1080, "1440": 1440, native: 0}[s.quality];
        if (height !== undefined || Number(s.fps) > 0) {
            s.customQuality = true;
            if (height !== undefined) s.customHeight = height;
            if (Number(s.fps) > 0) s.customFps = Number(s.fps);
        }
        delete s.quality;
        delete s.fps;
        return true;
    }

    tryInstallBridge() {
        this.installQualityUnlock();
        const bridge = new GoLiveBridge(this);
        try {
            bridge.install();
            this.bridge = bridge;
            this.bridgeError = null;
        }
        catch (error) {
            this.bridgeError = error.message;
            if (Date.now() - this.startedAt < INSTALL_GIVE_UP_MS) {
                this.installTimer = setTimeout(() => this.tryInstallBridge(), INSTALL_RETRY_MS);
                return;
            }
            this.api.Logger.error("Native Go Live bridge unavailable", error);
            this.api.UI.showToast(`VDOShare: não consegui reativar o Go Live (${error.message}). Use o comando /vdoshare.`, {type: "error", timeout: 10000});
        }
    }

    /* ---------------- Go Live quality unlock ---------------- */

    /** [object, key] of the first function in a module (found by source) that passes `fnFilter`. */
    findFunctionPatchTarget(sourceStrings, fnFilter) {
        const W = this.api.Webpack;
        const raw = W.getModule(W.Filters.bySource(...sourceStrings), {raw: true});
        if (!raw) return null;
        const pick = (obj) => {
            if (!obj || typeof obj !== "object") return null;
            for (const key of Object.keys(obj)) {
                let value;
                try { value = obj[key]; } catch (_) { continue; }
                if (typeof value !== "function") continue;
                let code = "";
                try { code = Function.prototype.toString.call(value); } catch (_) { continue; }
                if (fnFilter(code)) return [obj, key];
            }
            return null;
        };
        return pick(raw.declarations) ?? pick(raw.exports);
    }

    /**
     * Makes every resolution/FPS in Discord's Go Live picker selectable without
     * Nitro, by overriding the client-side checks the picker asks. (Same targets
     * YABDP4Nitro documents: the "canStreamWithSettings" validator and the
     * preset/resolution/fps permission check.) Safe to call repeatedly.
     */
    installQualityUnlock() {
        const P = this.api.Patcher;
        const allow = (_, args, original) => (this.settings.unlockQuality ? true : original(...args));
        if (!this.qualityUnlock.validator) {
            const target = this.findFunctionPatchTarget(["canStreamWithSettings"], code => code.includes("canStreamWithSettings"));
            if (target) {
                P.instead(target[0], target[1], allow);
                this.qualityUnlock.validator = true;
            }
        }
        if (!this.qualityUnlock.check) {
            const target = this.findFunctionPatchTarget(["preset)&&", "resolution&&", "fps&&"], code => code.includes("fps"));
            if (target) {
                P.instead(target[0], target[1], allow);
                this.qualityUnlock.check = true;
            }
        }
    }

    /** Adds a "VDOShare" quality button to the footer of Discord's Go Live modal. Best effort. */
    patchGoLiveModal() {
        const W = this.api.Webpack;
        const {React} = BdApi;
        W.waitForModule(W.Filters.bySource(GO_LIVE_MODAL_SOURCE), {signal: this.abort.signal})
            .then((mod) => {
                if (!mod || this.abort.signal.aborted) return;
                const key = ["default", "A", "Z", "ZP"].find(k => typeof mod[k] === "function")
                    ?? Object.keys(mod).find(k => typeof mod[k] === "function");
                if (!key) return this.api.Logger.warn("Go Live modal: no component export found");
                this.api.Patcher.after(mod, key, (_, __, ret) => {
                    try {
                        const footer = this.api.Utils.findInTree(ret, (node) => typeof node?.className === "string"
                            && /(^|\s|_)footer/i.test(node.className) && node.children !== undefined, {walkable: ["props", "children"]});
                        if (!footer) return ret;
                        const children = Array.isArray(footer.children) ? footer.children : [footer.children];
                        if (children.some(c => c?.key === "vdoshare-quality")) return ret;
                        footer.children = [...children, React.createElement("button", {
                            key: "vdoshare-quality",
                            type: "button",
                            className: "vdoshare-golive-btn",
                            title: "Qualidade VDOShare: resolução, FPS e bitrate personalizados",
                            onClick: (event) => { event.preventDefault(); event.stopPropagation(); this.openQualityModal(); }
                        }, "⚙ VDOShare")];
                    }
                    catch (error) {
                        this.api.Logger.warn("Go Live modal footer patch failed", error);
                    }
                    return ret;
                });
            })
            .catch((error) => { if (!this.abort.signal.aborted) this.api.Logger.warn("Go Live modal not found", error); });
    }

    /** Quick quality dialog (Go Live footer button, /vdoshare-qualidade, settings). */
    openQualityModal() {
        const {React} = BdApi;
        const {createElement: h} = React;
        const s = this.settings;
        const fields = ["customQuality", "customHeight", "customFps", "maxBitrate", "minBitrate", "audioBitrate", "videoCodec"];
        const draft = Object.fromEntries(fields.map(k => [k, s[k]]));
        const item = (setting, version) => h(React.Fragment, {key: `${setting.id}-${version}`},
            this.api.UI.buildSettingItem({...setting, value: draft[setting.id], onChange: (v) => { draft[setting.id] = setting.type === "number" ? Number(v) : v; }}));

        const Content = () => {
            const [version, setVersion] = React.useState(0);
            const applyPreset = (values) => { Object.assign(draft, values, {customQuality: true}); setVersion(v => v + 1); };
            return h("div", {className: "vdoshare-quality"},
                h("div", {className: "vdoshare-quality-presets"},
                    QUALITY_PRESETS.map(p => h("button", {key: p.label, type: "button", className: "vdoshare-preset", onClick: () => applyPreset(p.values)}, p.label)),
                    h("button", {key: "auto", type: "button", className: "vdoshare-preset", onClick: () => { draft.customQuality = false; setVersion(v => v + 1); }}, "Seguir o Discord")),
                item({type: "switch", id: "customQuality", name: "Usar qualidade personalizada", note: "Desligado: usa a resolução/FPS escolhidos no seletor do Discord."}, version),
                item({type: "number", id: "customHeight", name: "Resolução (altura em px)", note: "0 = nativa. Ex.: 720, 1080, 1440, 2160.", min: 0, max: 4320}, version),
                item({type: "number", id: "customFps", name: "FPS", note: "1–240", min: 1, max: 240}, version),
                item({type: "number", id: "maxBitrate", name: "Bitrate máximo (kbps)", note: "0 = automático pela resolução/FPS.", min: 0, max: 100000}, version),
                item({type: "number", id: "minBitrate", name: "Bitrate mínimo (kbps)", note: "0 = sem mínimo. Nem todo navegador respeita.", min: 0, max: 100000}, version),
                item({type: "number", id: "audioBitrate", name: "Bitrate do áudio (kbps)", note: "0 = padrão.", min: 0, max: 510}, version),
                item({type: "dropdown", id: "videoCodec", name: "Codec de vídeo", note: "Preferência do transmissor.", options: CODEC_OPTIONS}, version));
        };

        this.api.UI.showConfirmationModal("Qualidade da transmissão", h(Content), {
            confirmText: "Aplicar",
            cancelText: "Cancelar",
            onConfirm: () => {
                Object.assign(s, draft);
                this.saveSettings();
                this.applyQualityLive();
            }
        });
    }

    /** Applies the current quality settings to a running stream without dropping viewers. */
    async applyQualityLive() {
        const share = this.share;
        if (!share?.vdo || !share.source) {
            this.api.UI.showToast("VDOShare: qualidade salva — vale para a próxima transmissão.", {type: "success"});
            return;
        }
        try {
            const next = this.resolvePreset(share.source);
            const recapture = next.height !== share.preset.height || next.frameRate !== share.preset.frameRate || next.width !== share.preset.width;
            if (recapture) await this.switchSource(share.source);
            else {
                share.preset = next;
                await this.applyEncoding(share, next);
            }
            this.api.UI.showToast(`VDOShare: qualidade aplicada — ${next.label}.`, {type: "success"});
        }
        catch (error) {
            this.api.Logger.error("Applying quality failed", error);
            this.api.UI.showToast(`VDOShare: não consegui aplicar a qualidade — ${error.message}`, {type: "error"});
        }
    }

    /* ---------------- VDO.Ninja SDK ---------------- */

    async loadSdk() {
        if (this.SDK) return this.SDK;
        if (this.sdkLoading) return this.sdkLoading;
        this.sdkLoading = (async () => {
            const fetcher = this.api.Net?.fetch ? (u) => this.api.Net.fetch(u, {timeout: 20000}) : (u) => fetch(u);
            let lastError = null;
            for (const url of SDK_URLS) {
                try {
                    const res = await fetcher(url);
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const code = await res.text();
                    const hash = await sha256Hex(code);
                    if (hash !== SDK_SHA256) throw new Error(`hash inesperado (${hash.slice(0, 12)}…)`);
                    const mod = {exports: {}};
                    // eslint-disable-next-line no-new-func
                    new Function("module", "exports", "define", code)(mod, mod.exports, undefined);
                    const SDK = mod.exports?.VDONinjaSDK || mod.exports;
                    if (typeof SDK !== "function") throw new Error("SDK não exportou VDONinjaSDK");
                    this.SDK = SDK;
                    return SDK;
                }
                catch (error) {
                    lastError = error;
                    this.api.Logger.warn(`SDK load from ${url} failed`, error);
                }
            }
            throw new Error(`não foi possível carregar o SDK do VDO.Ninja (${lastError?.message})`);
        })();
        try { return await this.sdkLoading; }
        finally { this.sdkLoading = null; }
    }

    async publish(stream) {
        const SDK = await this.loadSdk();
        const s = this.settings;
        const options = {salt: "vdo.ninja"}; // required for playback on https://vdo.ninja
        if (s.signalingHost) options.host = s.signalingHost;
        const vdo = new SDK(options);
        const viewers = new Set();
        vdo.addEventListener("peerConnected", (event) => {
            const uuid = event.detail?.uuid;
            if (uuid) viewers.add(uuid);
            this.onViewersChanged(viewers.size);
        });
        vdo.addEventListener("peerDisconnected", (event) => {
            viewers.delete(event.detail?.uuid);
            this.onViewersChanged(viewers.size);
        });
        vdo.addEventListener("error", (event) => this.api.Logger.warn("SDK error", event.detail?.error ?? event.detail));

        await vdo.connect();
        const publishOptions = {streamID: this.share.streamId};
        if (s.streamLabel) publishOptions.label = s.streamLabel;
        const media = this.mediaOptions(this.share.preset);
        if (media) publishOptions.media = media;
        await vdo.publish(stream, publishOptions);
        return vdo;
    }

    /* ---------------- shares ---------------- */

    ensureStreamId() {
        if (this.settings.idMode === "session" || !sanitizeId(this.settings.streamId)) {
            this.settings.streamId = randomId(12);
            this.saveSettings();
        }
        return sanitizeId(this.settings.streamId);
    }

    /**
     * Capture/encode settings for a Go Live pick ({resolution, fps}; resolution 0 =
     * source), or for the custom values when "custom quality" is on.
     */
    resolvePreset({resolution, fps}) {
        const s = this.settings;
        const unlocked = s.unlockQuality && (this.qualityUnlock?.validator || this.qualityUnlock?.check);
        let height;
        let frameRate;
        if (s.customQuality) {
            height = Number(s.customHeight) > 0 ? Math.round(Number(s.customHeight)) : 0;
            frameRate = Number(s.customFps) || 30;
        }
        else {
            height = Number(resolution) === 0 ? 0 : (Number(resolution) || 1080);
            // Without the unlock a non-Nitro picker tops out at 720p, but the media
            // doesn't go through Discord, so don't stay that low.
            if (!unlocked && height) height = Math.max(height, 1080);
            frameRate = Number(fps) || 30;
        }
        height = height ? Math.min(4320, Math.max(16, height)) : 0;
        frameRate = Math.min(240, Math.max(1, Math.round(frameRate)));
        const native = height === 0;
        // Max constraints only: Chromium keeps the aspect ratio and fits inside both,
        // so allow up to 32:9 to keep ultrawide screens at the requested height.
        const maxHeight = native ? 4320 : height;
        const maxWidth = native ? 7680 : Math.round(height * 32 / 9);
        const pixels = (native ? 1440 : height) ** 2 * 16 / 9;
        const autoKbps = Math.min(20000, Math.max(1500, Math.round(pixels * Math.min(frameRate, 60) * 0.08 / 1000)));
        return {
            width: maxWidth,
            height: maxHeight,
            frameRate,
            maxBitrateKbps: Number(s.maxBitrate) > 0 ? Number(s.maxBitrate) : autoKbps,
            minBitrateKbps: Number(s.minBitrate) > 0 ? Number(s.minBitrate) : 0,
            audioBitrateKbps: Number(s.audioBitrate) > 0 ? Number(s.audioBitrate) : 0,
            codec: s.videoCodec || "",
            sharp: frameRate <= 15,
            label: `${native ? "nativa" : height + "p"}${frameRate}`
        };
    }

    /** Replaces the live encoding preferences (bitrate/codec) on every viewer connection. */
    async applyEncoding(share, preset) {
        if (!share?.vdo?.updatePublisherMedia) return;
        try {
            // Merging would keep values that were removed (e.g. a min bitrate set back to 0).
            await share.vdo.updatePublisherMedia({clear: true});
            const media = this.mediaOptions(preset);
            if (media) await share.vdo.updatePublisherMedia({media});
        }
        catch (error) {
            this.api.Logger.warn("updatePublisherMedia failed", error);
        }
    }

    /** SDK media options (publish / updatePublisherMedia) for a preset. */
    mediaOptions(preset) {
        if (!preset) return null;
        const video = {};
        const audio = {};
        if (preset.maxBitrateKbps) video.maxBitrate = `${preset.maxBitrateKbps}kbps`;
        if (preset.minBitrateKbps) video.minBitrate = `${Math.min(preset.minBitrateKbps, preset.maxBitrateKbps || Infinity)}kbps`;
        if (preset.codec) video.codec = preset.codec;
        if (preset.audioBitrateKbps) audio.maxBitrate = `${preset.audioBitrateKbps}kbps`;
        const media = {};
        if (Object.keys(video).length) media.video = video;
        if (Object.keys(audio).length) media.audio = audio;
        return Object.keys(media).length ? media : null;
    }

    /** Captures a source inside Discord and publishes it. Used by the Go Live bridge and by /vdoshare. */
    async startCaptureShare(mode, source, onEnded) {
        if (this.share) throw new Error("já existe uma transmissão ativa");
        this.busy = true;
        try {
            let {sourceId, sourceName} = source;
            if (!/^(screen|window):/.test(sourceId ?? "")) {
                // Came from a system picker Electron can't use directly.
                const picked = await this.pickSource({askAudio: false});
                if (!picked) throw new Error("seleção de fonte cancelada");
                ({id: sourceId, name: sourceName} = picked);
            }
            const preset = this.resolvePreset(source);
            const captured = await captureSource({sourceId, width: preset.width, height: preset.height, fps: preset.frameRate, wantAudio: source.sound});
            if (source.sound && !captured.audio) {
                this.api.UI.showToast(`VDOShare: transmitindo sem som — ${captured.audioError}`, {type: "warning", timeout: 8000});
            }
            else if (captured.audio && isWindows()) {
                this.api.UI.showToast("VDOShare: o áudio do sistema inclui o som da chamada de voz.", {type: "info", timeout: 6000});
            }
            captured.video.contentHint = preset.sharp ? "detail" : "motion";
            const videoTrack = this.settings.keepAlive ? keepAlive(captured.video) : captured.video;

            const streamId = this.ensureStreamId();
            this.share = {
                mode, streamId, sourceId, sourceName,
                viewerUrl: this.buildViewerUrl(streamId),
                startedAt: Date.now(),
                videoTrack, audioTrack: captured.audio,
                source: {...source, sourceId, sourceName},
                preset,
                viewers: 0, onEnded
            };
            videoTrack.addEventListener("ended", () => {
                if (this.share?.videoTrack === videoTrack) (this.share.onEnded ?? (() => this.endShare({reason: "a fonte compartilhada foi fechada — transmissão encerrada."})))();
            });

            const stream = new MediaStream([videoTrack, ...(captured.audio ? [captured.audio] : [])]);
            this.share.mediaStream = stream;
            this.share.vdo = await this.publish(stream);

            await this.setPresence();
            if (this.settings.copyViewerLink) this.copy(this.share.viewerUrl);
            this.api.UI.showToast(`VDOShare: ao vivo em ${preset.label} (${preset.maxBitrateKbps} kbps)` + (this.settings.copyViewerLink ? " — link copiado!" : "."), {type: "success", timeout: 6000});
        }
        catch (error) {
            this.endShare({silent: true});
            throw error;
        }
        finally {
            this.busy = false;
        }
    }

    startNativeShare(source, onEnded) {
        return this.startCaptureShare("native", source, onEnded);
    }

    /** Go Live "change source": swap the published tracks without reconnecting viewers. */
    async switchSource(source) {
        const share = this.share;
        if (!share?.vdo) return this.startNativeShare(source);
        source = {...share.source, ...source};
        const preset = this.resolvePreset(source);
        const captured = await captureSource({sourceId: source.sourceId, width: preset.width, height: preset.height, fps: preset.frameRate, wantAudio: source.sound});
        captured.video.contentHint = preset.sharp ? "detail" : "motion";
        share.source = source;
        share.preset = preset;
        const videoTrack = this.settings.keepAlive ? keepAlive(captured.video) : captured.video;
        const oldVideo = share.videoTrack;
        share.videoTrack = videoTrack;
        videoTrack.addEventListener("ended", () => {
            if (this.share?.videoTrack === videoTrack) this.share.onEnded?.();
        });
        await share.vdo.replaceTrack(oldVideo, videoTrack);
        oldVideo.stop();
        if (captured.audio && share.audioTrack) {
            await share.vdo.replaceTrack(share.audioTrack, captured.audio);
            share.audioTrack.stop();
            share.audioTrack = captured.audio;
        }
        else captured.audio?.stop();
        await this.applyEncoding(share, preset);
        this.bridge?.notifyVideoListeners();
    }

    /** Stops whatever is running (capture, SDK, browser page) and clears the presence. */
    endShare({silent = false, reason = null} = {}) {
        const share = this.share;
        if (!share) return;
        this.share = null;
        clearTimeout(this.pollTimer);
        clearTimeout(this.presenceTimer);
        this.clearPresence();
        try { share.videoTrack?.stop(); } catch (_) { /* ignore */ }
        try { share.audioTrack?.stop(); } catch (_) { /* ignore */ }
        if (share.vdo) {
            Promise.resolve()
                .then(() => share.vdo.stopPublishing())
                .then(() => share.vdo.disconnect())
                .catch(error => this.api.Logger.warn("SDK teardown failed", error));
        }
        if (share.mode === "browser" && !share.pageGone) this.apiCommand(share.apiKey, "hangup");
        if (silent) return;
        this.api.UI.showToast(`VDOShare: ${reason || "transmissão encerrada."}`, {type: "info", timeout: 6000});
    }

    onViewersChanged(count) {
        if (!this.share) return;
        this.share.viewers = count;
        if (!this.settings.showViewerCount) return;
        clearTimeout(this.presenceTimer);
        this.presenceTimer = setTimeout(() => this.setPresence(), 1500);
    }

    /* ---------------- /vdoshare (no voice channel needed) ---------------- */

    async toggleStandalone() {
        if (this.busy) return null;
        if (this.share) {
            if (this.share.mode === "native" && this.bridge?.own) this.bridge.endOwnStream();
            else this.endShare();
            return {content: "⏹️ Transmissão encerrada."};
        }
        const source = await this.pickSource({askAudio: true});
        if (!source) return null;
        try {
            await this.startCaptureShare("standalone", {sourceId: source.id, sourceName: source.name, sound: source.sound, resolution: 1080, fps: 30});
            return {content: `🔴 Ao vivo! Link para assistir: ${this.share.viewerUrl}`};
        }
        catch (error) {
            this.api.UI.showToast(`VDOShare: ${error.message}`, {type: "error", timeout: 8000});
            return {content: `Não foi possível iniciar: ${error.message}`};
        }
    }

    registerCommand() {
        if (!this.api.Commands?.register) return;
        try {
            this.api.Commands.register({
                id: "vdoshare",
                name: "vdoshare",
                description: "Inicia ou encerra uma transmissão de tela via VDO.Ninja",
                execute: () => this.toggleStandalone()
            });
            this.api.Commands.register({
                id: "vdoshare-qualidade",
                name: "vdoshare-qualidade",
                description: "Ajusta resolução, FPS e bitrate da transmissão VDOShare (aplica ao vivo)",
                execute: () => { this.openQualityModal(); }
            });
        }
        catch (error) {
            this.api.Logger.warn("Could not register slash command", error);
        }
    }

    /* ---------------- browser fallback (tab audio, Chrome picker) ---------------- */

    buildPublisherUrl(streamId, apiKey) {
        const s = this.settings;
        return buildUrl(s.baseUrl, [
            ["push", streamId],
            ["screenshare", true],
            ["autostart", true],
            ["screensharequality", "0"],
            ["screensharefps", 60],
            ["stereo", !!s.hqAudio],
            ["label", s.streamLabel || null],
            ["api", apiKey],
            ["easyexit", true]
        ], s.extraPushParams);
    }

    async startBrowserShare() {
        if (this.share || this.busy) return;
        const streamId = this.ensureStreamId();
        const apiKey = sanitizeId(this.settings.apiKey);
        this.share = {mode: "browser", streamId, apiKey, viewerUrl: this.buildViewerUrl(streamId), startedAt: Date.now(), viewers: 0, seenAlive: false, misses: 0};
        window.open(this.buildPublisherUrl(streamId, apiKey), "_blank", "noopener,noreferrer");
        await this.setPresence();
        if (this.settings.copyViewerLink) this.copy(this.share.viewerUrl);
        this.api.UI.showToast("VDOShare: escolha a tela/aba no navegador.", {type: "success"});
        this.pollBrowserPage();
    }

    // The page answers "timeout" through the API when it isn't open.
    pollBrowserPage() {
        const share = this.share;
        const tick = async () => {
            if (this.share !== share) return;
            const result = await this.apiCommand(share.apiKey, "getDetails");
            if (this.share !== share) return;
            if (result !== null && result !== "timeout") { share.seenAlive = true; share.misses = 0; }
            else if (result === "timeout") {
                share.misses++;
                if ((share.seenAlive && share.misses >= 3) || (!share.seenAlive && Date.now() - share.startedAt > 180000)) {
                    share.pageGone = true;
                    return this.endShare({reason: "a página do VDO.Ninja foi fechada — transmissão encerrada."});
                }
            }
            this.pollTimer = setTimeout(tick, 15000);
        };
        this.pollTimer = setTimeout(tick, 10000);
    }

    async apiCommand(apiKey, action) {
        const url = `${this.settings.apiUrl.replace(/\/+$/, "")}/${encodeURIComponent(apiKey)}/${action}`;
        try {
            const res = this.api.Net?.fetch ? await this.api.Net.fetch(url, {timeout: 8000}) : await fetch(url);
            return (await res.text()).trim();
        }
        catch (error) {
            this.api.Logger.warn(`API "${action}" failed`, error);
            return null;
        }
    }

    /* ---------------- viewer link ---------------- */

    buildViewerUrl(streamId) {
        const s = this.settings;
        return buildUrl(s.baseUrl, [
            ["view", streamId],
            ["stereo", !!s.hqAudio],
            ["bitrate", Number(s.viewerBitrate) > 0 ? Number(s.viewerBitrate) : null],
            ["codec", s.viewerCodec || null],
            ["waitmessage", s.waitMessage || null],
            ["waittimeout", s.waitMessage ? 0 : null],
            // Same form as the SDK's own example viewer link (&wss2=apibackup.vdo.ninja).
            ["wss2", s.signalingHost ? s.signalingHost.replace(/^wss:\/\//, "") : null]
        ], s.extraViewParams);
    }

    /* ---------------- source picker (for /vdoshare and Linux) ---------------- */

    async pickSource({askAudio}) {
        let sources;
        try { sources = await listSources(); }
        catch (error) {
            this.api.UI.showToast(`VDOShare: ${error.message}`, {type: "error"});
            return null;
        }
        if (!sources?.length) return null;
        if (sources.length === 1 && !askAudio) return sources[0];

        this.closePicker?.();
        return new Promise((resolve) => {
            const root = document.createElement("div");
            root.className = "vdoshare-picker";
            const close = (value) => {
                root.remove();
                document.removeEventListener("keydown", onKey, true);
                this.closePicker = null;
                resolve(value);
            };
            const onKey = (event) => { if (event.key === "Escape") { event.stopPropagation(); close(null); } };
            this.closePicker = () => close(null);

            const panel = document.createElement("div");
            panel.className = "vdoshare-picker-panel";
            const title = document.createElement("h2");
            title.textContent = "O que você quer transmitir?";
            panel.append(title);

            const grid = document.createElement("div");
            grid.className = "vdoshare-picker-grid";
            let audioBox = null;
            for (const source of sources) {
                const item = document.createElement("button");
                item.className = "vdoshare-picker-item";
                const thumb = source.url || source.thumbnail;
                if (typeof thumb === "string" && thumb) {
                    const img = document.createElement("img");
                    img.src = thumb;
                    item.append(img);
                }
                const label = document.createElement("span");
                label.textContent = (source.id.startsWith("screen:") ? "🖥️ " : "🪟 ") + (source.name || source.id);
                item.append(label);
                item.addEventListener("click", () => close({...source, sound: Boolean(audioBox?.checked)}));
                grid.append(item);
            }
            panel.append(grid);

            const footer = document.createElement("div");
            footer.className = "vdoshare-picker-footer";
            if (askAudio) {
                const wrap = document.createElement("label");
                audioBox = document.createElement("input");
                audioBox.type = "checkbox";
                audioBox.disabled = !isWindows();
                wrap.append(audioBox, document.createTextNode(isWindows() ? " Incluir áudio do sistema" : " Áudio do sistema só no Windows"));
                footer.append(wrap);
            }
            const cancel = document.createElement("button");
            cancel.className = "vdoshare-picker-cancel";
            cancel.textContent = "Cancelar";
            cancel.addEventListener("click", () => close(null));
            footer.append(cancel);
            panel.append(footer);

            root.append(panel);
            root.addEventListener("click", (event) => { if (event.target === root) close(null); });
            document.addEventListener("keydown", onKey, true);
            document.body.append(root);
        });
    }

    /* ---------------- Rich Presence ---------------- */

    async setPresence() {
        const share = this.share;
        if (!this.settings.rpcEnabled || !share || !this.Dispatcher) return;
        const s = this.settings;
        const appId = String(s.appId || "").trim();
        if (!appId && !this.warnedAppId) {
            this.warnedAppId = true;
            this.api.UI.showToast("VDOShare: configure um Application ID para o botão do Rich Presence aparecer (veja o README).", {type: "warning", timeout: 8000});
        }
        let state = s.state || "";
        if (s.showViewerCount && share.viewers > 0) state = `${state ? state + " · " : ""}👀 ${share.viewers}`;

        const activity = {
            application_id: appId || "0",
            name: s.activityName || "VDO.Ninja",
            type: Number(s.activityType) || 0,
            details: s.details || undefined,
            state: state || undefined,
            timestamps: {start: share.startedAt},
            buttons: [String(s.buttonLabel || "Assistir Transmissão").slice(0, 32)],
            metadata: {button_urls: [share.viewerUrl]},
            flags: 1
        };
        if (s.largeImage && appId && this.AssetUtils) {
            try {
                const [asset] = await this.AssetUtils.fetchAssetIds(appId, [s.largeImage]);
                if (asset) activity.assets = {large_image: asset, large_text: s.activityName || "VDO.Ninja"};
            }
            catch (error) {
                this.api.Logger.warn("Could not resolve large image", error);
            }
        }
        if (this.share !== share) return;
        this.Dispatcher.dispatch({type: "LOCAL_ACTIVITY_UPDATE", activity, socketId: "VDOShare"});
    }

    clearPresence() {
        try { this.Dispatcher?.dispatch({type: "LOCAL_ACTIVITY_UPDATE", activity: null, socketId: "VDOShare"}); }
        catch (error) { this.api.Logger.warn("Could not clear presence", error); }
    }

    copy(text) {
        try {
            if (window.DiscordNative?.clipboard?.copy) return window.DiscordNative.clipboard.copy(text);
            navigator.clipboard?.writeText(text);
        }
        catch (error) {
            this.api.Logger.warn("Clipboard copy failed", error);
        }
    }

    /* ---------------- settings panel ---------------- */

    getSettingsPanel() {
        const s = this.settings;
        const set = (key) => (value) => {
            s[key] = value;
            this.saveSettings();
            if (this.share && ["customQuality", "customHeight", "customFps", "maxBitrate", "minBitrate", "audioBitrate", "videoCodec"].includes(key)) {
                clearTimeout(this.qualityTimer);
                this.qualityTimer = setTimeout(() => this.applyQualityLive(), 1200);
            }
            if (this.share && ["rpcEnabled", "appId", "activityName", "activityType", "details", "state", "buttonLabel", "largeImage", "showViewerCount"].includes(key)) {
                if (s.rpcEnabled) this.setPresence();
                else this.clearPresence();
            }
        };
        const text = (id, name, note, extra = {}) => ({type: "text", id, name, note, value: s[id], onChange: set(id), ...extra});
        const sw = (id, name, note) => ({type: "switch", id, name, note, value: !!s[id], onChange: set(id)});
        const num = (id, name, note, min, max) => ({type: "number", id, name, note, value: s[id], min, max, onChange: (v) => set(id)(Number(v))});
        const dd = (id, name, note, options) => ({type: "dropdown", id, name, note, value: s[id], options, onChange: set(id)});
        const unlockStatus = this.qualityUnlock?.validator || this.qualityUnlock?.check
            ? ""
            : " (Não encontrei as verificações de qualidade do Discord: o seletor pode continuar limitado, mas a qualidade personalizada funciona.)";
        const status = this.bridge
            ? (this.bridge.regionLocked ? "Go Live reativado (estava bloqueado na sua região)." : "Go Live nativo conectado.")
            : `Go Live nativo indisponível${this.bridgeError ? `: ${this.bridgeError}` : ""}. Use /vdoshare.`;

        return this.api.UI.buildSettingsPanel({
            settings: [
                {
                    type: "category", id: "actions", name: "Ações", collapsible: true, shown: true,
                    settings: [
                        {type: "button", id: "status", name: "Status", note: status, children: this.share ? "Encerrar transmissão" : "Transmitir (escolher fonte)",
                            onClick: () => this.toggleStandalone()},
                        {type: "button", id: "browser", name: "Transmitir pelo navegador", note: "Alternativa: abre o VDO.Ninja no navegador padrão (seletor do Chrome, áudio de aba). Clique de novo para encerrar.",
                            children: "Navegador", onClick: () => (this.share?.mode === "browser" ? this.endShare() : this.startBrowserShare())},
                        {type: "button", id: "copyView", name: "Copiar link de visualização", note: "O mesmo link do botão do Rich Presence.", children: "Copiar",
                            onClick: () => { this.copy(this.share?.viewerUrl || this.buildViewerUrl(sanitizeId(s.streamId))); this.api.UI.showToast("Link copiado!", {type: "success"}); }},
                        {type: "button", id: "regen", name: "Gerar novo ID", note: "Invalida o link de visualização antigo.", children: "Gerar",
                            onClick: () => { s.streamId = randomId(12); s.apiKey = randomId(24); this.saveSettings(); this.api.UI.showToast("Novo ID gerado.", {type: "success"}); }}
                    ]
                },
                {
                    type: "category", id: "stream", name: "Transmissão", collapsible: true, shown: true,
                    settings: [
                        sw("takeOverGoLive", "Usar o Go Live do Discord", "O botão \"Compartilhar Tela\" transmite pelo VDO.Ninja. Desative para devolver o Go Live ao Discord (onde ele estiver liberado)."),
                        sw("keepAlive", "Manter imagem em telas paradas", "Reenvia o último quadro para quem entra não ver tela preta."),
                        dd("idMode", "ID da transmissão", "", [
                            {label: "Fixo (link permanente)", value: "fixed"},
                            {label: "Novo a cada transmissão", value: "session"}
                        ]),
                        text("streamId", "Stream ID", "Letras, números e _.", {onChange: (v) => set("streamId")(sanitizeId(v))}),
                        text("streamLabel", "Rótulo", "Nome exibido para quem assiste (opcional)."),
                        text("signalingHost", "Servidor de sinalização", "Vazio = padrão do VDO.Ninja. Ex.: wss://apibackup.vdo.ninja")
                    ]
                },
                {
                    type: "category", id: "quality", name: "Qualidade (resolução, FPS, bitrate)", collapsible: true, shown: true,
                    settings: [
                        {type: "button", id: "qualityModal", name: "Ajuste rápido", note: `Predefinições e aplicação ao vivo. Também no botão "⚙ VDOShare" da janela do Go Live e em /vdoshare-qualidade.${unlockStatus}`,
                            children: "Abrir", onClick: () => this.openQualityModal()},
                        sw("unlockQuality", "Desbloquear todas as opções do Go Live", "Libera no seletor do Discord todas as resoluções (até Nativa) e FPS (até 60), sem Nitro."),
                        sw("customQuality", "Usar qualidade personalizada", "Ignora o que foi escolhido no seletor e usa os valores abaixo."),
                        num("customHeight", "Resolução (altura em px)", "0 = nativa. Ex.: 720, 1080, 1440, 2160.", 0, 4320),
                        num("customFps", "FPS", "1–240", 1, 240),
                        num("maxBitrate", "Bitrate máximo (kbps)", "0 = automático pela resolução/FPS (1,5–20 Mbps). Cada espectador consome esse upload.", 0, 100000),
                        num("minBitrate", "Bitrate mínimo (kbps)", "0 = sem mínimo.", 0, 100000),
                        num("audioBitrate", "Bitrate do áudio (kbps)", "0 = padrão.", 0, 510),
                        dd("videoCodec", "Codec de vídeo", "Preferência do transmissor (o link de visualização tem a sua própria opção).", CODEC_OPTIONS)
                    ]
                },
                {
                    type: "category", id: "viewer", name: "Link de visualização", collapsible: true, shown: false,
                    settings: [
                        sw("hqAudio", "Áudio estéreo (&stereo)", ""),
                        num("viewerBitrate", "Bitrate solicitado (kbps)", "&bitrate (0 = não definir).", 0, 50000),
                        dd("viewerCodec", "Codec preferido", "&codec", [
                            {label: "Automático", value: ""},
                            {label: "VP9", value: "vp9"},
                            {label: "H.264", value: "h264"},
                            {label: "AV1", value: "av1"},
                            {label: "VP8", value: "vp8"}
                        ]),
                        text("waitMessage", "Mensagem de espera", "&waitmessage"),
                        text("extraViewParams", "Parâmetros extras", "Ex.: &buffer=200"),
                        text("baseUrl", "URL do VDO.Ninja", "")
                    ]
                },
                {
                    type: "category", id: "rpc", name: "Rich Presence", collapsible: true, shown: false,
                    settings: [
                        sw("rpcEnabled", "Ativar Rich Presence", ""),
                        text("appId", "Application ID", "Necessário para o botão aparecer. Veja o README."),
                        text("activityName", "Nome da atividade", ""),
                        dd("activityType", "Tipo", "", [
                            {label: "Assistindo", value: 3},
                            {label: "Jogando", value: 0},
                            {label: "Ouvindo", value: 2},
                            {label: "Competindo em", value: 5}
                        ]),
                        text("details", "Linha 1", ""),
                        text("state", "Linha 2", ""),
                        sw("showViewerCount", "Mostrar número de espectadores", ""),
                        text("buttonLabel", "Texto do botão", "Máx. 32 caracteres.", {maxLength: 32}),
                        text("largeImage", "Imagem (URL)", "Opcional, requer Application ID."),
                        sw("copyViewerLink", "Copiar link ao iniciar", "")
                    ]
                },
                {
                    type: "category", id: "browserFallback", name: "Modo navegador", collapsible: true, shown: false,
                    settings: [
                        text("extraPushParams", "Parâmetros extras do transmissor", "Ex.: &screensharecursor"),
                        text("apiUrl", "URL da API", "Padrão: https://api.vdo.ninja/")
                    ]
                }
            ]
        });
    }
};

const PICKER_CSS = `
.vdoshare-picker { position: fixed; inset: 0; z-index: 10000; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.7); }
.vdoshare-picker-panel { width: min(860px, 92vw); max-height: 85vh; display: flex; flex-direction: column; gap: 12px; padding: 20px; border-radius: 12px;
    background: var(--modal-background, var(--background-primary, #313338)); color: var(--text-normal, #dbdee1); box-shadow: 0 8px 32px rgba(0,0,0,.5); }
.vdoshare-picker-panel h2 { margin: 0; font-size: 20px; font-weight: 600; color: var(--header-primary, #f2f3f5); }
.vdoshare-picker-grid { overflow: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px; }
.vdoshare-picker-item { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 2px solid transparent; border-radius: 8px; cursor: pointer; text-align: left;
    background: var(--background-secondary, #2b2d31); color: inherit; font-size: 13px; }
.vdoshare-picker-item:hover { border-color: var(--brand-500, #5865f2); }
.vdoshare-picker-item img { width: 100%; aspect-ratio: 16/9; object-fit: contain; background: #000; border-radius: 4px; }
.vdoshare-picker-item span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vdoshare-picker-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.vdoshare-golive-btn { padding: 6px 12px; margin: 0 8px; border: 0; border-radius: 8px; cursor: pointer; font-weight: 600;
    background: var(--control-secondary-background-default, var(--button-secondary-background, #4e5058)); color: var(--text-normal, #fff); }
.vdoshare-golive-btn:hover { filter: brightness(1.15); }
.vdoshare-quality { display: flex; flex-direction: column; gap: 4px; }
.vdoshare-quality-presets { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.vdoshare-preset { padding: 6px 10px; border: 0; border-radius: 6px; cursor: pointer; font-size: 13px;
    background: var(--brand-500, #5865f2); color: #fff; }
.vdoshare-preset:hover { filter: brightness(1.1); }
.vdoshare-picker-cancel { margin-left: auto; padding: 8px 16px; border: 0; border-radius: 4px; cursor: pointer; background: var(--button-secondary-background, #4e5058); color: #fff; }
`;
