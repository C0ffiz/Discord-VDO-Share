/**
 * @name VDOShare
 * @author C0ffiz
 * @authorLink https://github.com/C0ffiz
 * @description Reativa o Go Live nativo do Discord ("Compartilhar Tela") e transmite a tela direto do Discord via VDO.Ninja (P2P), com um Rich Presence "Assistir Transmissão" para quem quiser assistir no navegador.
 * @version 2.0.0
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
const INSTALL_GIVE_UP_MS = 60000;

const DEFAULTS = {
    // Stream
    idMode: "fixed",            // "fixed" | "session"
    streamId: "",
    apiKey: "",                 // only used by the browser fallback (&api remote control)
    quality: "picker",          // "picker" | "720" | "1080" | "1440" | "native"
    fps: 0,                     // 0 = what Discord's picker chose
    maxBitrate: 0,              // kbps, 0 = automatic
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
        if (dirty) this.saveSettings();

        this.Dispatcher = this.api.Webpack.getByKeys("dispatch", "subscribe", "unsubscribe")
            || this.api.Webpack.getModule(m => typeof m?.dispatch === "function" && typeof m?.subscribe === "function", {searchExports: true});
        this.AssetUtils = this.api.Webpack.getByKeys("fetchAssetIds");

        this.api.DOM.addStyle("vdoshare-css", PICKER_CSS);
        this.registerCommand();
        this.startedAt = Date.now();
        this.tryInstallBridge();
        this.loadSdk().catch(error => this.api.Logger.warn("SDK preload failed", error));
    }

    stop() {
        clearTimeout(this.installTimer);
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

    tryInstallBridge() {
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
        if (this.share.maxBitrateKbps) publishOptions.videoBitrate = `${this.share.maxBitrateKbps}kbps`;
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

    resolvePreset({resolution, fps}) {
        const s = this.settings;
        const pickerHeight = resolution === 0 ? 2160 : Math.max(Number(resolution) || 1080, 1080);
        const height = {picker: pickerHeight, "720": 720, "1080": 1080, "1440": 1440, native: 2160}[s.quality] ?? pickerHeight;
        const frameRate = Number(s.fps) > 0 ? Number(s.fps) : Math.max(Number(fps) || 30, 15);
        const width = Math.round(height * 16 / 9);
        const autoKbps = Math.min(12000, Math.max(1500, Math.round(width * height * frameRate * 0.08 / 1000)));
        return {width, height, frameRate, maxBitrateKbps: Number(s.maxBitrate) > 0 ? Number(s.maxBitrate) : autoKbps, sharp: Number(fps) > 0 && Number(fps) <= 15};
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
                maxBitrateKbps: preset.maxBitrateKbps,
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
            this.api.UI.showToast(`VDOShare: ao vivo em ${preset.height}p${preset.frameRate}` + (this.settings.copyViewerLink ? " — link copiado!" : "."), {type: "success", timeout: 6000});
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
        const preset = this.resolvePreset(source);
        const captured = await captureSource({sourceId: source.sourceId, width: preset.width, height: preset.height, fps: preset.frameRate, wantAudio: source.sound});
        captured.video.contentHint = preset.sharp ? "detail" : "motion";
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
            if (this.share && ["rpcEnabled", "appId", "activityName", "activityType", "details", "state", "buttonLabel", "largeImage", "showViewerCount"].includes(key)) {
                if (s.rpcEnabled) this.setPresence();
                else this.clearPresence();
            }
        };
        const text = (id, name, note, extra = {}) => ({type: "text", id, name, note, value: s[id], onChange: set(id), ...extra});
        const sw = (id, name, note) => ({type: "switch", id, name, note, value: !!s[id], onChange: set(id)});
        const num = (id, name, note, min, max) => ({type: "number", id, name, note, value: s[id], min, max, onChange: (v) => set(id)(Number(v))});
        const dd = (id, name, note, options) => ({type: "dropdown", id, name, note, value: s[id], options, onChange: set(id)});
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
                        dd("quality", "Resolução", "Sem Nitro o seletor do Discord só oferece 720p; aqui o mínimo é 1080p porque a mídia não passa pelo Discord.", [
                            {label: "Seguir o seletor (mín. 1080p)", value: "picker"},
                            {label: "720p", value: "720"},
                            {label: "1080p", value: "1080"},
                            {label: "1440p", value: "1440"},
                            {label: "Nativa (até 4K)", value: "native"}
                        ]),
                        dd("fps", "FPS", "", [
                            {label: "Seguir o seletor", value: 0},
                            {label: "30", value: 30},
                            {label: "60", value: 60}
                        ]),
                        num("maxBitrate", "Bitrate máximo (kbps)", "0 = automático pela resolução/FPS (1,5–12 Mbps). Cada espectador consome esse upload.", 0, 50000),
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
.vdoshare-picker-cancel { margin-left: auto; padding: 8px 16px; border: 0; border-radius: 4px; cursor: pointer; background: var(--button-secondary-background, #4e5058); color: #fff; }
`;
