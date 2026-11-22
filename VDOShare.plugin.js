/**
 * @name VDOShare
 * @author C0ffiz
 * @authorLink https://github.com/C0ffiz
 * @description Usa o botão "Compartilhar Tela" do Discord para transmitir via VDO.Ninja (P2P, fora dos servidores de mídia do Discord) e publica um Rich Presence com o botão "Assistir Transmissão".
 * @version 1.0.0
 * @source https://github.com/C0ffiz/Discord-VDO-Share
 * @website https://github.com/C0ffiz/Discord-VDO-Share
 * @updateUrl https://raw.githubusercontent.com/C0ffiz/Discord-VDO-Share/main/VDOShare.plugin.js
 */

"use strict";

/* ------------------------------------------------------------------------ *
 *  Defaults
 * ------------------------------------------------------------------------ */

// aria-label fragments (lowercase) of Discord's "Share your screen" button,
// in the most common client languages. Users can add more in settings or use
// the "calibrate" button.
const DEFAULT_LABELS = [
    "share your screen", "share screen", "screen share", "go live",
    "compartilhe sua tela", "compartilhar sua tela", "compartilhar tela", "transmitir tela",
    "compartir tu pantalla", "compartir pantalla",
    "partager votre écran", "partager l'écran", "partager l’écran",
    "bildschirm teilen", "deinen bildschirm teilen",
    "condividi lo schermo", "condividi schermo",
    "udostępnij ekran", "поделиться экраном", "демонстрация экрана",
    "ekranını paylaş", "ekranı paylaş", "scherm delen", "dela skärm",
    "画面共有", "画面を共有", "화면 공유", "共享屏幕", "分享螢幕", "共享螢幕"
];

// Labels that must never be intercepted even if they contain a pattern above
// (e.g. Discord's own "Stop Streaming" when a native stream is running).
const EXCLUDE_WORDS = ["stop", "parar", "encerrar", "detener", "arrêter", "beenden", "interrompi", "settings", "configura"];

const DEFAULTS = {
    // Transmission
    baseUrl: "https://vdo.ninja/",
    apiUrl: "https://api.vdo.ninja/",
    idMode: "fixed",           // "fixed" | "session"
    streamId: "",
    apiKey: "",
    quality: "0",              // &screensharequality: -1 native, 0 1080p, 1 720p, 2 360p
    fps: 60,                   // &screensharefps
    contentHint: "motion",     // "motion" | "detail" | ""
    hqAudio: true,             // &stereo on push and view
    preShareButton: false,     // &screenshare2 instead of &screenshare&autostart
    meshcast: false,           // &meshcast (server relay for many viewers)
    streamLabel: "",
    extraPushParams: "",
    // Viewer
    viewerBitrate: 6000,       // &bitrate (kbps, viewer side)
    viewerCodec: "",           // &codec
    waitMessage: "A transmissão vai começar em instantes...",
    extraViewParams: "",
    // Rich Presence
    rpcEnabled: true,
    appId: "",
    activityName: "Transmissão ao vivo",
    activityType: 3,           // 0 Playing, 2 Listening, 3 Watching, 5 Competing
    details: "Compartilhando a tela via VDO.Ninja",
    state: "Clique em \"Assistir Transmissão\"",
    buttonLabel: "Assistir Transmissão",
    largeImage: "",
    // Behaviour
    interceptButton: true,
    customLabels: "",
    copyViewerLink: true,
    autoDetectEnd: true
};

/* ------------------------------------------------------------------------ *
 *  Helpers
 * ------------------------------------------------------------------------ */

function randomId(length) {
    const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    let out = "";
    for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
    return out;
}

// Builds a VDO.Ninja URL. Params with value `true` are added as bare flags
// (e.g. "&screenshare"); null/undefined/false/"" are skipped.
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

function sanitizeId(value) {
    return String(value || "").replace(/[^A-Za-z0-9_]/g, "").slice(0, 40);
}

function cssEscape(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

/* ------------------------------------------------------------------------ *
 *  Plugin
 * ------------------------------------------------------------------------ */

module.exports = class VDOShare {
    constructor(meta) {
        this.meta = meta;
        this.api = new BdApi(meta.name);
        this.live = false;
        this.busy = false;
        this.session = null;
        this.pollTimer = null;
        this.calibrating = false;
        this.onClickCapture = this.onClickCapture.bind(this);
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

        document.addEventListener("click", this.onClickCapture, true);
        this.updateStyles();
        this.registerCommand();
    }

    stop() {
        document.removeEventListener("click", this.onClickCapture, true);
        if (this.live) this.stopStream({silent: true});
        this.clearPresence();
        this.stopPolling();
        document.body.classList.remove("vdoshare-live");
        this.api.DOM.removeStyle("vdoshare-css");
        try { this.api.Commands?.unregisterAll?.(); } catch (_) { /* older BD */ }
    }

    saveSettings() {
        this.api.Data.save("settings", this.settings);
    }

    /* ---------------- Discord button interception ---------------- */

    getLabelPatterns() {
        const custom = String(this.settings.customLabels || "")
            .split(/[\n,;]/).map(s => s.trim().toLowerCase()).filter(Boolean);
        return [...new Set([...custom, ...DEFAULT_LABELS])];
    }

    // Walks up from the click target looking for an element whose aria-label
    // matches the "Share your screen" button.
    findShareButton(target) {
        const patterns = this.getLabelPatterns();
        let el = target instanceof Element ? target : target?.parentElement;
        for (let depth = 0; el && depth < 6; depth++, el = el.parentElement) {
            if (el.closest?.(".bd-settings-group, .bd-addon-modal, [class*='bd-'] .bd-setting-item")) return null;
            const label = (el.getAttribute?.("aria-label") || "").trim().toLowerCase();
            if (!label) continue;
            if (EXCLUDE_WORDS.some(w => label.includes(w))) return null;
            if (patterns.some(p => label.includes(p))) return el;
        }
        return null;
    }

    onClickCapture(event) {
        if (this.calibrating) return this.handleCalibrationClick(event);
        if (!this.settings.interceptButton || event.button !== 0) return;

        const button = this.findShareButton(event.target);
        if (!button) return;

        // Stop Discord from opening its own Go Live modal.
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        this.toggle();
    }

    startCalibration() {
        this.calibrating = true;
        this.api.UI.showToast("VDOShare: feche as configurações e clique no botão \"Compartilhar Tela\" do Discord.", {type: "info", timeout: 8000});
        clearTimeout(this.calibrationTimer);
        this.calibrationTimer = setTimeout(() => {
            if (!this.calibrating) return;
            this.calibrating = false;
            this.api.UI.showToast("VDOShare: calibração cancelada (tempo esgotado).", {type: "warning"});
        }, 60000);
    }

    handleCalibrationClick(event) {
        // Ignore clicks that only close the settings screen / modals.
        let el = event.target instanceof Element ? event.target : null;
        if (!el || el.closest("[class*='standardSidebarView'], .bd-modal-root, [class*='layer'] [role='dialog']")) return;

        const button = el.closest("button, [role='button']");
        let label = "";
        for (let node = button || el, depth = 0; node && depth < 4 && !label; depth++, node = node.parentElement) {
            label = (node.getAttribute("aria-label") || "").trim();
        }
        if (!button || !label) {
            this.api.UI.showToast("VDOShare: isso não parece um botão com rótulo. Clique exatamente no botão de compartilhar tela.", {type: "warning"});
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        this.calibrating = false;
        clearTimeout(this.calibrationTimer);

        const save = () => {
            const lower = label.toLowerCase();
            const current = String(this.settings.customLabels || "").split(/[\n,;]/).map(s => s.trim()).filter(Boolean);
            if (!current.map(s => s.toLowerCase()).includes(lower)) current.push(lower);
            this.settings.customLabels = current.join(", ");
            this.saveSettings();
            this.updateStyles();
            this.api.UI.showToast(`VDOShare: botão "${label}" registrado!`, {type: "success"});
        };

        this.api.UI.showConfirmationModal("VDOShare — calibrar botão",
            `Usar o botão com o rótulo "${label}" para iniciar/encerrar a transmissão?`,
            {confirmText: "Usar este botão", cancelText: "Cancelar", onConfirm: save});
    }

    // Highlights the share button(s) while a VDO.Ninja stream is live.
    updateStyles() {
        const selectors = this.getLabelPatterns()
            .map(p => `body.vdoshare-live [aria-label*="${cssEscape(p)}" i]`)
            .join(",\n");
        this.api.DOM.removeStyle("vdoshare-css");
        this.api.DOM.addStyle("vdoshare-css", `
${selectors} {
    color: var(--status-positive, #23a55a) !important;
    background-color: color-mix(in srgb, var(--status-positive, #23a55a) 18%, transparent) !important;
    border-radius: 8px;
}`);
    }

    /* ---------------- URLs ---------------- */

    ensureIds() {
        if (this.settings.idMode === "session" || !sanitizeId(this.settings.streamId)) {
            this.settings.streamId = randomId(12);
            this.saveSettings();
        }
        return {streamId: sanitizeId(this.settings.streamId), apiKey: sanitizeId(this.settings.apiKey)};
    }

    buildPublisherUrl(streamId, apiKey) {
        const s = this.settings;
        const quality = String(s.quality);
        return buildUrl(s.baseUrl, [
            ["push", streamId],
            [s.preShareButton ? "screenshare2" : "screenshare", true],
            ["autostart", !s.preShareButton],
            ["screensharequality", quality === "" ? null : quality],
            ["screensharefps", Number(s.fps) > 0 ? Number(s.fps) : null],
            ["screensharecontenthint", s.contentHint || null],
            ["stereo", !!s.hqAudio],
            ["meshcast", !!s.meshcast],
            ["label", s.streamLabel || null],
            ["api", apiKey],
            ["easyexit", true]
        ], s.extraPushParams);
    }

    buildViewerUrl(streamId) {
        const s = this.settings;
        return buildUrl(s.baseUrl, [
            ["view", streamId],
            ["stereo", !!s.hqAudio],
            ["bitrate", Number(s.viewerBitrate) > 0 ? Number(s.viewerBitrate) : null],
            ["codec", s.viewerCodec || null],
            ["waitmessage", s.waitMessage || null],
            ["waittimeout", s.waitMessage ? 0 : null]
        ], s.extraViewParams);
    }

    /* ---------------- stream lifecycle ---------------- */

    toggle() {
        if (this.busy) return;
        if (this.live) this.stopStream();
        else this.startStream();
    }

    async startStream() {
        if (this.live || this.busy) return;
        this.busy = true;
        try {
            const {streamId, apiKey} = this.ensureIds();
            const publisherUrl = this.buildPublisherUrl(streamId, apiKey);
            const viewerUrl = this.buildViewerUrl(streamId);

            this.session = {streamId, apiKey, publisherUrl, viewerUrl, startedAt: Date.now(), seenAlive: false, misses: 0};
            this.live = true;
            document.body.classList.add("vdoshare-live");

            this.openExternal(publisherUrl);
            await this.setPresence();
            if (this.settings.copyViewerLink) this.copy(viewerUrl);
            if (this.settings.autoDetectEnd) this.startPolling();

            this.api.UI.showToast(
                "VDOShare: escolha a tela/janela/aba no navegador" +
                (this.settings.copyViewerLink ? " — link de visualização copiado!" : "."),
                {type: "success", timeout: 6000}
            );
        }
        catch (err) {
            this.api.Logger.error("Failed to start stream", err);
            this.api.UI.showToast(`VDOShare: erro ao iniciar — ${err?.message || err}`, {type: "error"});
            this.live = false;
            document.body.classList.remove("vdoshare-live");
            this.clearPresence();
        }
        finally {
            this.busy = false;
        }
    }

    async stopStream({silent = false, reason = null, skipHangup = false} = {}) {
        if (!this.live) return;
        this.busy = true;
        const session = this.session;
        this.stopPolling();
        this.live = false;
        this.session = null;
        document.body.classList.remove("vdoshare-live");
        this.clearPresence();

        let hungUp = skipHangup;
        if (!skipHangup && session) {
            const result = await this.apiCommand(session.apiKey, "hangup");
            hungUp = result !== null && result !== "timeout";
        }
        this.busy = false;

        if (silent) return;
        if (reason) this.api.UI.showToast(`VDOShare: ${reason}`, {type: "info", timeout: 6000});
        else if (hungUp) this.api.UI.showToast("VDOShare: transmissão encerrada.", {type: "success"});
        else this.api.UI.showToast("VDOShare: Rich Presence removido. Não consegui falar com a página do VDO.Ninja — feche a aba se ela ainda estiver aberta.", {type: "warning", timeout: 8000});
    }

    /* ---------------- VDO.Ninja remote API ---------------- */

    // GET https://api.vdo.ninja/{apiKey}/{action}. Returns the response text,
    // "timeout" when no page is listening, or null on network error.
    async apiCommand(apiKey, action) {
        const url = `${this.settings.apiUrl.replace(/\/+$/, "")}/${encodeURIComponent(apiKey)}/${action}`;
        try {
            const fetcher = this.api.Net?.fetch ? (u) => this.api.Net.fetch(u, {timeout: 8000}) : (u) => fetch(u);
            const res = await fetcher(url);
            return (await res.text()).trim();
        }
        catch (err) {
            this.api.Logger.warn(`API request "${action}" failed`, err);
            return null;
        }
    }

    // Polls the publisher page through the API so the presence is removed when
    // the browser tab is closed (or the share never starts).
    startPolling() {
        this.stopPolling();
        const tick = async () => {
            const session = this.session;
            if (!this.live || !session) return;
            const result = await this.apiCommand(session.apiKey, "getDetails");
            if (this.session !== session) return;

            if (result !== null && result !== "timeout") {
                session.seenAlive = true;
                session.misses = 0;
            }
            else if (result === "timeout") {
                session.misses++;
                const elapsed = Date.now() - session.startedAt;
                if (session.seenAlive && session.misses >= 3) {
                    return this.stopStream({reason: "a página do VDO.Ninja foi fechada — transmissão encerrada.", skipHangup: true});
                }
                if (!session.seenAlive && elapsed > 3 * 60 * 1000) {
                    return this.stopStream({reason: "a página do VDO.Ninja não respondeu em 3 minutos — Rich Presence removido.", skipHangup: true});
                }
            }
            this.pollTimer = setTimeout(tick, 15000);
        };
        this.pollTimer = setTimeout(tick, 10000);
    }

    stopPolling() {
        clearTimeout(this.pollTimer);
        this.pollTimer = null;
    }

    /* ---------------- Rich Presence ---------------- */

    async setPresence() {
        if (!this.settings.rpcEnabled || !this.session) return;
        if (!this.Dispatcher) {
            this.api.UI.showToast("VDOShare: não encontrei o Dispatcher do Discord; Rich Presence indisponível.", {type: "error"});
            return;
        }
        const s = this.settings;
        const appId = String(s.appId || "").trim();
        if (!appId) {
            this.api.UI.showToast("VDOShare: configure um Application ID para o botão do Rich Presence aparecer (veja o README).", {type: "warning", timeout: 8000});
        }

        const activity = {
            application_id: appId || "0",
            name: s.activityName || "VDO.Ninja",
            type: Number(s.activityType) || 0,
            details: s.details || undefined,
            state: s.state || undefined,
            timestamps: {start: this.session.startedAt},
            buttons: [s.buttonLabel || "Assistir Transmissão"],
            metadata: {button_urls: [this.session.viewerUrl]},
            flags: 1
        };

        if (s.largeImage && appId && this.AssetUtils) {
            try {
                const [asset] = await this.AssetUtils.fetchAssetIds(appId, [s.largeImage]);
                if (asset) activity.assets = {large_image: asset, large_text: s.activityName || "VDO.Ninja"};
            }
            catch (err) {
                this.api.Logger.warn("Could not resolve large image asset", err);
            }
        }

        if (!this.live) return; // stopped while resolving assets
        this.Dispatcher.dispatch({type: "LOCAL_ACTIVITY_UPDATE", activity, socketId: "VDOShare"});
    }

    clearPresence() {
        try {
            this.Dispatcher?.dispatch({type: "LOCAL_ACTIVITY_UPDATE", activity: null, socketId: "VDOShare"});
        }
        catch (err) {
            this.api.Logger.warn("Could not clear presence", err);
        }
    }

    /* ---------------- misc ---------------- */

    openExternal(url) {
        // In the Discord desktop client window.open() for http(s) URLs is routed
        // to the operating system's default browser.
        const win = window.open(url, "_blank", "noopener,noreferrer");
        if (win === undefined) {
            const a = document.createElement("a");
            a.href = url;
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            a.click();
        }
    }

    copy(text) {
        try {
            if (window.DiscordNative?.clipboard?.copy) return window.DiscordNative.clipboard.copy(text);
            navigator.clipboard?.writeText(text);
        }
        catch (err) {
            this.api.Logger.warn("Clipboard copy failed", err);
        }
    }

    registerCommand() {
        const Commands = this.api.Commands;
        if (!Commands?.register) return;
        try {
            Commands.register({
                id: "vdoshare",
                name: "vdoshare",
                description: "Inicia ou encerra a transmissão via VDO.Ninja",
                execute: async () => {
                    const wasLive = this.live;
                    if (wasLive) await this.stopStream();
                    else await this.startStream();
                    if (!wasLive && this.session) return {content: `🔴 Transmissão iniciada. Link para assistir: ${this.session.viewerUrl}`};
                    return {content: wasLive ? "⏹️ Transmissão encerrada." : "Não foi possível iniciar a transmissão."};
                }
            });
        }
        catch (err) {
            this.api.Logger.warn("Could not register slash command", err);
        }
    }

    /* ---------------- settings panel ---------------- */

    getSettingsPanel() {
        const s = this.settings;
        const set = (key) => (value) => {
            s[key] = value;
            this.saveSettings();
            if (key === "customLabels") this.updateStyles();
            if (this.live && ["rpcEnabled", "appId", "activityName", "activityType", "details", "state", "buttonLabel", "largeImage"].includes(key)) {
                if (s.rpcEnabled) this.setPresence();
                else this.clearPresence();
            }
        };
        const text = (id, name, note, extra = {}) => ({type: "text", id, name, note, value: s[id], onChange: set(id), ...extra});
        const sw = (id, name, note) => ({type: "switch", id, name, note, value: !!s[id], onChange: set(id)});
        const num = (id, name, note, min, max) => ({type: "number", id, name, note, value: s[id], min, max, onChange: (v) => set(id)(Number(v))});
        const dd = (id, name, note, options) => ({type: "dropdown", id, name, note, value: s[id], options, onChange: set(id)});

        return this.api.UI.buildSettingsPanel({
            settings: [
                {
                    type: "category", id: "actions", name: "Ações", collapsible: true, shown: true,
                    settings: [
                        {type: "button", id: "toggleNow", name: "Iniciar / encerrar agora", note: "Mesmo efeito de clicar no botão de compartilhar tela do Discord.", children: "Alternar transmissão", onClick: () => this.toggle()},
                        {type: "button", id: "calibrate", name: "Calibrar botão", note: "Use se o clique no botão de compartilhar tela não for interceptado (outro idioma ou layout novo do Discord).", children: "Calibrar", onClick: () => this.startCalibration()},
                        {type: "button", id: "copyView", name: "Copiar link de visualização", note: "Link que vai no botão do Rich Presence.", children: "Copiar", onClick: () => { this.copy(this.session?.viewerUrl || this.buildViewerUrl(sanitizeId(s.streamId))); this.api.UI.showToast("Link copiado!", {type: "success"}); }},
                        {type: "button", id: "copyPush", name: "Copiar link do transmissor", note: "Para abrir manualmente em outro navegador. Contém a sua chave de API: não compartilhe.", children: "Copiar", onClick: () => { this.copy(this.session?.publisherUrl || this.buildPublisherUrl(sanitizeId(s.streamId), sanitizeId(s.apiKey))); this.api.UI.showToast("Link copiado!", {type: "success"}); }},
                        {type: "button", id: "regen", name: "Gerar novo ID e chave", note: "Invalida links antigos de transmissão.", children: "Gerar", onClick: () => { s.streamId = randomId(12); s.apiKey = randomId(24); this.saveSettings(); this.api.UI.showToast("Novo ID gerado. Reabra as configurações para ver.", {type: "success"}); }}
                    ]
                },
                {
                    type: "category", id: "stream", name: "Transmissão (quem compartilha)", collapsible: true, shown: true,
                    settings: [
                        dd("idMode", "ID da transmissão", "Fixo: o link de visualização é sempre o mesmo. Por sessão: um link novo a cada transmissão.", [
                            {label: "Fixo (link permanente)", value: "fixed"},
                            {label: "Novo a cada transmissão", value: "session"}
                        ]),
                        text("streamId", "Stream ID", "Somente letras, números e _. Gerado automaticamente.", {onChange: (v) => set("streamId")(sanitizeId(v))}),
                        dd("quality", "Qualidade da captura", "&screensharequality", [
                            {label: "1080p (recomendado)", value: "0"},
                            {label: "Nativa / sem limite", value: "-1"},
                            {label: "720p", value: "1"},
                            {label: "360p", value: "2"}
                        ]),
                        num("fps", "FPS alvo", "&screensharefps (0 = padrão do VDO.Ninja)", 0, 144),
                        dd("contentHint", "Tipo de conteúdo", "&screensharecontenthint", [
                            {label: "Movimento (jogos, vídeo) — prioriza FPS", value: "motion"},
                            {label: "Detalhe (texto, código) — prioriza nitidez", value: "detail"},
                            {label: "Automático", value: ""}
                        ]),
                        sw("hqAudio", "Áudio em alta qualidade (estéreo)", "Adiciona &stereo nos dois links: desliga cancelamento de eco/ruído e aumenta o bitrate do áudio do sistema."),
                        sw("preShareButton", "Mostrar botão antes do seletor", "Usa &screenshare2. Ative se o seu navegador não abrir o seletor de tela sozinho."),
                        sw("meshcast", "Usar Meshcast (muitos espectadores)", "Envia um único stream a um servidor que distribui para todos. Menos upload, um pouco mais de latência."),
                        text("streamLabel", "Rótulo", "&label — nome exibido na transmissão (opcional)."),
                        text("extraPushParams", "Parâmetros extras (transmissor)", "Ex.: &screensharecursor&maxvideobitrate=8000")
                    ]
                },
                {
                    type: "category", id: "viewer", name: "Visualização (quem assiste)", collapsible: true, shown: false,
                    settings: [
                        num("viewerBitrate", "Bitrate solicitado (kbps)", "&bitrate no link de visualização (0 = padrão do VDO.Ninja).", 0, 50000),
                        dd("viewerCodec", "Codec preferido", "&codec — preferência, não garantia.", [
                            {label: "Automático", value: ""},
                            {label: "VP9", value: "vp9"},
                            {label: "H.264", value: "h264"},
                            {label: "AV1", value: "av1"},
                            {label: "VP8", value: "vp8"}
                        ]),
                        text("waitMessage", "Mensagem de espera", "&waitmessage — exibida enquanto a transmissão não conecta."),
                        text("extraViewParams", "Parâmetros extras (visualização)", "Ex.: &buffer=200")
                    ]
                },
                {
                    type: "category", id: "rpc", name: "Rich Presence", collapsible: true, shown: false,
                    settings: [
                        sw("rpcEnabled", "Ativar Rich Presence", "Mostra a atividade com o botão no seu perfil enquanto transmite."),
                        text("appId", "Application ID", "ID de uma aplicação do Discord Developer Portal. Necessário para o botão aparecer."),
                        text("activityName", "Nome da atividade", "Ex.: \"Transmissão ao vivo\""),
                        dd("activityType", "Tipo de atividade", "", [
                            {label: "Assistindo", value: 3},
                            {label: "Jogando", value: 0},
                            {label: "Ouvindo", value: 2},
                            {label: "Competindo em", value: 5}
                        ]),
                        text("details", "Detalhes (linha 1)", ""),
                        text("state", "Estado (linha 2)", ""),
                        text("buttonLabel", "Texto do botão", "Máx. 32 caracteres.", {maxLength: 32}),
                        text("largeImage", "Imagem (URL)", "URL https de uma imagem (opcional, requer Application ID).")
                    ]
                },
                {
                    type: "category", id: "behaviour", name: "Comportamento", collapsible: true, shown: false,
                    settings: [
                        sw("interceptButton", "Interceptar o botão \"Compartilhar Tela\"", "Desative para usar o Go Live nativo do Discord (o comando /vdoshare continua funcionando)."),
                        text("customLabels", "Rótulos extras do botão", "aria-labels adicionais (separados por vírgula). Preenchido pela calibração."),
                        sw("copyViewerLink", "Copiar link de visualização ao iniciar", ""),
                        sw("autoDetectEnd", "Detectar fim da transmissão", "Consulta a página pelo API do VDO.Ninja e remove o Rich Presence se a aba for fechada."),
                        text("baseUrl", "URL do VDO.Ninja", "Troque apenas se usar uma instância própria."),
                        text("apiUrl", "URL da API", "Padrão: https://api.vdo.ninja/")
                    ]
                }
            ]
        });
    }
};
