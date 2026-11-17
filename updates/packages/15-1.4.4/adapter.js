/*
 * Post-Update «Green Zone» загрузчик QuestFarmer v1.4.4 (questfarmer-loader.js).
 *
 * Лежит в корне папки Vencord (~/.config/Vencord или %APPDATA%\Vencord),
 * то есть ВНЕ папки dist/, которую Vencord перезаписывает при обновлении.
 *
 * Почему эта архитектура НЕ ломает обновления Discord и Vencord на Windows/Linux:
 *   1. Никакого вмешательства на старте (Splash / Installing update...):
 *      - Во время запуска Electron (пока идёт проверка/установка обновлений Discord
 *        через updater.node и installer.db) лоадер НЕ трогает ни один файл на диске,
 *        НЕ модифицирует resources/app.asar, НЕ перехватывает fs.writeFile/writeFileSync
 *        и НЕ открывает сокеты в процессе сплеш-апдейтера.
 *      - resources/app.asar остаётся в 100% штатном формате Vencord
 *        (require(".../Vencord/dist/patcher.js")), за его перенос в новую папку
 *        app-1.0.xxx отвечает только штатный persistAfterDiscordUpdates самого Vencord.
 *   2. Ожидание загрузки главного окна + Таймер «Зелёной зоны» (45 секунд):
 *      - Лоадер ждёт, пока закроется сплеш-скрин (file://) и полностью загрузится
 *        главное окно клиента (https://discord.com/...).
 *      - После загрузки главного окна запускается таймер «зелёной зоны» (по умолчанию 45 с).
 *        В это время все стартовые скрипты Discord и встроенный OTA-апдейтер Vencord
 *        выполняются без малейшего вмешательства — вплоть до запуска клиента БЕЗ нашего плагина,
 *        если Vencord только что обновился.
 *   3. Пост-проверка после «Зелёной зоны» -> Патч Vencord -> Ручной полный запуск:
 *      - Когда «зелёная зона» прошла и файлы в dist/ устоялись (не менялись последние 12 с),
 *        лоадер проверяет dist/renderer.js.
 *      - Если после обновления Vencord нашего плагина в renderer.js нет:
 *        атомарно (через .qf-tmp + rename) дописывает questfarmer-inject.js в dist/renderer.js,
 *        регистрирует PluginMeta и возвращает хук в dist/patcher.js без авто-рестарта.
 *        Уведомление просит полностью выйти и запустить клиент. Проверяется не только
 *        DQ.booted, но и версия основного процесса: Ctrl+R не обновляет HTTP-апдейтер.
 */
"use strict";

const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");

// The post-update coordinator loads a versioned adapter from its own cache.
const VENCORD_HOME = global.__QF_ADAPTER_HOME__ || __dirname;
const DIST_DIR = path.join(VENCORD_HOME, "dist");
const PATCHER_FILE = path.join(DIST_DIR, "patcher.js");
const RENDERER_FILE = path.join(DIST_DIR, "renderer.js");
const DESKTOP_RENDERER_FILE = path.join(DIST_DIR, "vencordDesktopRenderer.js");
const INJECT_FILE = global.__QF_ADAPTER_PAYLOAD__ || path.join(VENCORD_HOME, "questfarmer-inject.js");
const SETTINGS_FILE = path.join(VENCORD_HOME, "settings", "settings.json");
const STATE_FILE = path.join(VENCORD_HOME, ".questfarmer-state.json");

const RENDERER_MARKER = "/*===QUESTFARMER_STANDALONE_INJECT===*/";
const INJECT_VERSION_MARKER = "/*QUESTFARMER_INJECT_VERSION:1.4.4*/";
// Keep a still-running 1.3.2 loader from fighting the installer before full exit.
// Preserve older loader markers; the current loader also verifies the payload.
const LEGACY_INJECT_VERSION_MARKER = "/*QUESTFARMER_INJECT_VERSION:1.4.3*/\n/*QUESTFARMER_INJECT_VERSION:1.4.2*/\n/*QUESTFARMER_INJECT_VERSION:1.4.1*/\n/*QUESTFARMER_INJECT_VERSION:1.4.0*/\n/*QUESTFARMER_INJECT_VERSION:1.3.9*/\n/*QUESTFARMER_INJECT_VERSION:1.3.8*/\n/*QUESTFARMER_INJECT_VERSION:1.3.7*/\n/*QUESTFARMER_INJECT_VERSION:1.3.6*/\n/*QUESTFARMER_INJECT_VERSION:1.3.5*/\n/*QUESTFARMER_INJECT_VERSION:1.3.4*/\n/*QUESTFARMER_INJECT_VERSION:1.3.3*/\n/*QUESTFARMER_INJECT_VERSION:1.3.2*/";
const PATCHER_MARKER = "/*QUESTFARMER_LOADER_HOOK*/";

const GREEN_ZONE_MS = Math.max(5_000, Number(process.env.QF_GREEN_ZONE_MS) || 45_000);
const SETTLE_QUIET_MS = Math.max(1_000, Number(process.env.QF_SETTLE_QUIET_MS) || 12_000);
const SETTLE_RETRY_MS = Math.max(1_000, Number(process.env.QF_SETTLE_RETRY_MS) || 15_000);
const PERIODIC_CHECK_MS = Math.max(15_000, Number(process.env.QF_PERIODIC_CHECK_MS) || 120_000);
// Renderer reloads do NOT reload Vencord's main-process HTTP updater/gitHash.
// Never reload on OTA: leave the normal restart notification to the user.
function patcherBuild() {
    try { return fs.readFileSync(PATCHER_FILE, "utf8").match(/^\/\/ Vencord ([a-f0-9]+)/m)?.[1] || null; }
    catch { return null; }
}
const LOADED_PATCHER_BUILD = patcherBuild(); // Read-only snapshot before delegating to Vencord.
let restartNoticeShown = false;

const RELAY_HOST = "127.0.0.1";
const RELAY_PORT = 43210;
const RELAY_HEADER = "x-orion-relay";
const DISCORD_ORIGIN_RE = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com$/i;
const MAIN_WINDOW_URL_RE = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\//i;
const ALLOWED_PATH_RE = /^\/\.proxy\/acf\/(?:authorize|quest\/progress)$/;
const DISCORDSAYS_HOST_SUFFIX = ".discordsays.com";

let relayServer = null;
let mainWindowLoaded = false;
let greenZoneTimer = null;
let periodicTimer = null;
let checkInProgress = false;

function readLoaderState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) || {};
        }
    } catch {}
    return {};
}

function writeLoaderState(patch) {
    try {
        const next = Object.assign(readLoaderState(), patch);
        const tmp = STATE_FILE + ".tmp-" + process.pid;
        fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
        fs.renameSync(tmp, STATE_FILE);
    } catch {}
}

function atomicWriteFileSync(targetPath, content) {
    const tmpPath = targetPath + ".qf-tmp-" + process.pid + "-" + Date.now();
    try {
        fs.writeFileSync(tmpPath, content, "utf8");
        fs.renameSync(tmpPath, targetPath);
    } catch (error) {
        try {
            if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch {}
        throw error; // Never truncate a live bundle if Windows denies the rename.
    }
}

function getInjectPayload() {
    try {
        if (!fs.existsSync(INJECT_FILE)) return "";
        const code = fs.readFileSync(INJECT_FILE, "utf8");
        if (!code.trim()) return "";
        return "\n" + RENDERER_MARKER + "\n" + INJECT_VERSION_MARKER + "\n" + LEGACY_INJECT_VERSION_MARKER + "\n" + code + "\n";
    } catch {
        return "";
    }
}

function getPatcherHookLine() {
    const loaderPath = JSON.stringify(path.join(VENCORD_HOME, "questfarmer-loader.js"));
    return `${PATCHER_MARKER}try{require(${loaderPath})}catch(e){}\n`;
}

function isRendererAlreadyPatched(filePath) {
    try {
        if (!fs.existsSync(filePath)) return true;
        const text = fs.readFileSync(filePath, "utf8");
        if (text.includes(RENDERER_MARKER)) return text.includes(INJECT_VERSION_MARKER);
        return text.includes("QuestFarmer");
    } catch {
        return true;
    }
}

function registerRendererMetadata(text) {
    // Find PluginModal's metadata lookup, not a guessed minifier identifier.
    const lookup = /\b(?:let|const|var)\s+([\w$]+)=([\w$]+)\[([\w$]+)\.name\];return\b/g;
    let match;
    while ((match = lookup.exec(text))) {
        const tail = text.slice(lookup.lastIndex, lookup.lastIndex + 600);
        if (!tail.includes(`!${match[1]}.userPlugin`)) continue;
        const map = match[2].replace(/\$/g, "\\$");
        const definition = new RegExp(`\\b${map}=\\{`);
        if (!definition.test(text)) break;
        return text.replace(definition, prefix => prefix +
            'QuestFarmer:{folderName:"questFarmer",userPlugin:!0},');
    }
    // Fail closed on an unknown Vencord layout instead of registering a broken plugin.
    throw new Error("Unsupported Vencord PluginMeta layout; patch skipped");
}

function patchRendererFile(filePath) {
    try {
        if (!fs.existsSync(filePath)) return false;
        let text = fs.readFileSync(filePath, "utf8");
        const markerAt = text.indexOf(RENDERER_MARKER);
        if (markerAt >= 0) {
            if (text.includes(INJECT_VERSION_MARKER)) return false;
            text = text.slice(0, markerAt); // Replace our old appended payload only.
        } else if (text.includes("QuestFarmer")) return false;
        const payload = getInjectPayload();
        if (!payload) return false;
        if (!text.includes('QuestFarmer:{folderName:"questFarmer",userPlugin:!0}')) {
            text = registerRendererMetadata(text);
        }
        atomicWriteFileSync(filePath, text + payload);
        return true;
    } catch (error) {
        writeLoaderState({ lastError: String(error.message || error), lastErrorAt: Date.now() });
        return false;
    }
}

function ensurePatcherHook(filePath = PATCHER_FILE) {
    try {
        if (!fs.existsSync(filePath)) return false;
        const text = fs.readFileSync(filePath, "utf8");
        if (text.includes(PATCHER_MARKER)) return false;
        atomicWriteFileSync(filePath, getPatcherHookLine() + text);
        return true;
    } catch {
        return false;
    }
}

function stripPatcherHook(filePath = PATCHER_FILE) {
    try {
        if (!fs.existsSync(filePath)) return false;
        const text = fs.readFileSync(filePath, "utf8");
        if (!text.includes(PATCHER_MARKER)) return false;
        const cleaned = text.replace(/^\/\*QUESTFARMER_LOADER_HOOK\*\/[^\r\n]*\r?\n?/, "");
        atomicWriteFileSync(filePath, cleaned);
        return true;
    } catch {
        return false;
    }
}

function ensureSettingsEnabled(install = false) {
    try {
        fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
        const raw = fs.existsSync(SETTINGS_FILE) ? fs.readFileSync(SETTINGS_FILE, "utf8") : "{}";
        const data = JSON.parse(raw || "{}");
        data.plugins = data.plugins || {};
        data.plugins.QuestFarmer = data.plugins.QuestFarmer || {};
        let changed = false;
        if (install && data.autoUpdate !== true) {
            data.autoUpdate = true;
            changed = true;
        }
        if (install && data.plugins.QuestFarmer.enabled !== true) {
            data.plugins.QuestFarmer.enabled = true;
            changed = true;
        }
        if (install && (!data.plugins.QuestFarmer.intervalHours || data.plugins.QuestFarmer.intervalHours === 72)) {
            data.plugins.QuestFarmer.intervalHours = 12;
            changed = true;
        }
        if (changed || !fs.existsSync(SETTINGS_FILE)) {
            atomicWriteFileSync(SETTINGS_FILE, JSON.stringify(data, null, 4) + "\n");
        }
        return changed;
    } catch {
        return false;
    }
}

/**
 * Создаёт минимальный стандартный ASAR-архив (совместимый с Vencord writer.ts).
 */
function buildMiniAsar(files) {
    const headerObj = { files: {} };
    const chunks = [];
    let offset = 0;

    for (const [name, content] of Object.entries(files)) {
        const buf = Buffer.from(content, "utf8");
        headerObj.files[name] = { size: buf.length, offset: String(offset) };
        chunks.push(buf);
        offset += buf.length;
    }

    const headerStr = JSON.stringify(headerObj);
    const headerStrLen = Buffer.byteLength(headerStr, "utf8");
    const alignedSize = Math.ceil((headerStrLen + 4) / 4) * 4;
    const headerBuf = Buffer.alloc(16 + alignedSize);

    headerBuf.writeUInt32LE(4, 0);
    headerBuf.writeUInt32LE(alignedSize + 8, 4);
    headerBuf.writeUInt32LE(alignedSize + 4, 8);
    headerBuf.writeUInt32LE(headerStrLen, 12);
    headerBuf.write(headerStr, 16, "utf8");

    return Buffer.concat([headerBuf, ...chunks]);
}

function buildStandardVencordAsarBuffer() {
    const indexJs = `require(${JSON.stringify(PATCHER_FILE)});`;
    const pkgJson = JSON.stringify({ name: "discord", main: "index.js" });
    return buildMiniAsar({
        "index.js": indexJs,
        "package.json": pkgJson,
    });
}

/**
 * Если на машине раньше стояла старая версия (v1.2.0/v1.3.0), которая переписывала
 * resources/app.asar на questfarmer-loader.js, бережно возвращает стандартный
 * Vencord app.asar (require(".../dist/patcher.js")), чтобы апдейтер Discord/Vencord
 * работал со штатным файлом.
 */
function restoreDiscordAsarsToStandardVencord() {
    const roots = new Set();
    const home = os.homedir();

    if (process.platform === "win32") {
        const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
        for (const name of ["Discord", "DiscordPTB", "DiscordCanary", "DiscordDevelopment"]) {
            roots.add(path.join(local, name));
        }
    } else {
        const cfg = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
        for (const name of ["discord", "discordptb", "discordcanary", "Discord", "DiscordPTB", "DiscordCanary"]) {
            roots.add(path.join(cfg, name));
        }
        roots.add("/opt/discord");
        roots.add("/opt/Discord");
        roots.add("/usr/share/discord");
        roots.add("/usr/lib/discord");
    }

    let restoredCount = 0;
    for (const root of roots) {
        try {
            if (!fs.existsSync(root)) continue;
            const entries = fs.readdirSync(root, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory() || !entry.name.startsWith("app-")) continue;
                const resDir = path.join(root, entry.name, "resources");
                const asarPath = path.join(resDir, "app.asar");
                const origAsar = path.join(resDir, "_app.asar");
                if (!fs.existsSync(asarPath) || !fs.existsSync(origAsar)) continue;
                const st = fs.statSync(asarPath);
                if (!st.isFile() || st.size > 16384) continue;
                const raw = fs.readFileSync(asarPath).toString("utf8");
                if (!raw.includes("questfarmer-loader.js")) continue;
                fs.writeFileSync(asarPath, buildStandardVencordAsarBuffer());
                restoredCount++;
            }
        } catch {}
    }
    return restoredCount;
}

function areDistFilesSettled(quietMs = SETTLE_QUIET_MS) {
    const now = Date.now();
    for (const file of [RENDERER_FILE, PATCHER_FILE, DESKTOP_RENDERER_FILE]) {
        try {
            if (!fs.existsSync(file)) continue;
            const st = fs.statSync(file);
            if (now - st.mtimeMs < quietMs) {
                return false;
            }
        } catch {}
    }
    return true;
}

async function isFarmerBusyInWindow() {
    try {
        const electron = require("electron");
        const BrowserWindow = electron && electron.BrowserWindow;
        if (!BrowserWindow || typeof BrowserWindow.getAllWindows !== "function") return false;
        for (const win of BrowserWindow.getAllWindows()) {
            try {
                if (!win || win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) continue;
                const url = win.webContents.getURL() || "";
                if (!MAIN_WINDOW_URL_RE.test(url)) continue;
                const busy = await win.webContents.executeJavaScript(
                    "Boolean(window.DQ && window.DQ._state && window.DQ._state.running)",
                    true
                );
                if (busy) return true;
            } catch {}
        }
    } catch {}
    return false;
}

async function requestFullRestart(reason) {
    writeLoaderState({ pendingReload: false, restartRequired: true,
        reloadStatus: "restart-required", restartReason: reason,
        loadedPatcherBuild: LOADED_PATCHER_BUILD, diskPatcherBuild: patcherBuild() });
    if (restartNoticeShown) return;
    try {
        const { BrowserWindow } = require("electron");
        for (const win of BrowserWindow?.getAllWindows?.() || []) {
            if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
            if (!MAIN_WINDOW_URL_RE.test(win.webContents.getURL())) continue;
            const shown = await win.webContents.executeJavaScript(`(() => {
                const show = window.Vencord?.Api?.Notifications?.showNotification;
                if (!show) return false;
                show({ title: "QuestFarmer: обновление подготовлено",
                    body: "Полностью выйди из Discord через трей и запусти снова. Ctrl+R не обновляет основной процесс Vencord. Автоматических перезапусков не будет.",
                    permanent: true, noPersist: true });
                return true;
            })()`, true);
            if (shown) restartNoticeShown = true;
            break;
        }
    } catch (error) {
        writeLoaderState({ lastError: String(error.message || error) });
    }
}

/**
 * Главная проверка ПОСЛЕ окончания «Зелёной зоны»:
 *  - убеждается, что файлы Vencord в dist/ не находятся в процессе записи апдейтером;
 *  - если после обновления Vencord в dist/renderer.js пропал QuestFarmer —
 *    патчит dist/renderer.js и dist/patcher.js и предлагает полный выход/запуск;
 *  - если QuestFarmer уже есть в dist/renderer.js — просто тихо проверяет хук в patcher.js
 *    без перезапуска.
 */
async function runPostGreenZoneCheck(trigger = "timer") {
    if (checkInProgress) return { status: "busy" };
    checkInProgress = true;
    try {
        if (!fs.existsSync(RENDERER_FILE)) {
            return { status: "no-renderer" };
        }

        if (!areDistFilesSettled()) {
            setTimeout(() => {
                runPostGreenZoneCheck("settle-retry").catch(() => {});
            }, SETTLE_RETRY_MS);
            return { status: "settling" };
        }

        const rendererNeedsPatch = !isRendererAlreadyPatched(RENDERER_FILE);

        if (!rendererNeedsPatch) {
            ensurePatcherHook(PATCHER_FILE);
            patchRendererFile(DESKTOP_RENDERER_FILE);
            ensureSettingsEnabled();
            const diskBuild = patcherBuild();
            const st = readLoaderState();
            if (st.restartRequired && diskBuild === LOADED_PATCHER_BUILD) {
                const { BrowserWindow } = require("electron");
                for (const win of BrowserWindow?.getAllWindows?.() || []) {
                    if (win.isDestroyed() || win.webContents.isDestroyed() || !MAIN_WINDOW_URL_RE.test(win.webContents.getURL())) continue;
                    const loaded = await win.webContents.executeJavaScript(
                        "Boolean(window.DQ?._state?.booted && window.DQ.version === '1.4.4')", true);
                    if (loaded) {
                        writeLoaderState({ restartRequired: false, pendingReload: false, reloadStatus: "verified", lastVerifiedAt: Date.now() });
                        return { status: "verified" };
                    }
                }
            }
            if ((diskBuild && LOADED_PATCHER_BUILD && diskBuild !== LOADED_PATCHER_BUILD) || st.pendingReload || st.restartRequired) {
                await requestFullRestart(trigger);
                return { status: "restart-required" };
            }
            return { status: "already-patched", trigger };
        }

        if (await isFarmerBusyInWindow()) {
            return { status: "farmer-busy" };
        }

        const patchedMain = patchRendererFile(RENDERER_FILE);
        patchRendererFile(DESKTOP_RENDERER_FILE);
        if (!isRendererAlreadyPatched(RENDERER_FILE)) {
            throw new Error(readLoaderState().lastError || "QuestFarmer renderer patch verification failed");
        }
        ensurePatcherHook(PATCHER_FILE);
        ensureSettingsEnabled();

        if (patchedMain) {
            writeLoaderState({
                lastPatchedAt: Date.now(),
                lastTrigger: trigger,
                pendingReload: false,
            });
            await requestFullRestart("vencord-updated-" + trigger);
            return { status: "patched-restart-required" };
        }

        return { status: "noop" };
    } catch (err) {
        return { status: "error", error: String(err && err.message ? err.message : err) };
    } finally {
        checkInProgress = false;
    }
}

function onMainDiscordWindowReady() {
    if (mainWindowLoaded) return;
    mainWindowLoaded = true;

    startDiscordSaysRelay();

    if (greenZoneTimer) clearTimeout(greenZoneTimer);
    greenZoneTimer = setTimeout(() => {
        greenZoneTimer = null;
        runPostGreenZoneCheck("green-zone").catch(() => {});

        if (!periodicTimer) {
            periodicTimer = setInterval(() => {
                runPostGreenZoneCheck("periodic").catch(() => {});
            }, PERIODIC_CHECK_MS);
            if (typeof periodicTimer.unref === "function") {
                periodicTimer.unref();
            }
        }
    }, GREEN_ZONE_MS);

    if (typeof greenZoneTimer.unref === "function") {
        greenZoneTimer.unref();
    }
}

function inspectWindowForMainDiscord(win) {
    try {
        if (!win || win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) return;
        const wc = win.webContents;
        const checkUrl = () => {
            try {
                if (wc.isDestroyed()) return;
                const url = wc.getURL() || "";
                if (MAIN_WINDOW_URL_RE.test(url)) {
                    onMainDiscordWindowReady();
                }
            } catch {}
        };
        wc.on("did-finish-load", checkUrl);
        wc.on("did-finish-load", () => {
            if (!readLoaderState().restartRequired && !readLoaderState().pendingReload) return;
            const timer = setTimeout(async () => {
                try {
                    if (wc.isDestroyed() || !MAIN_WINDOW_URL_RE.test(wc.getURL())) return;
                    const loaded = await wc.executeJavaScript(
                        "Boolean(window.DQ?._state?.booted && window.DQ.version === '1.4.4')", true);
                    const diskBuild = patcherBuild();
                    const verified = loaded && diskBuild === LOADED_PATCHER_BUILD;
                    writeLoaderState({ pendingReload: false, restartRequired: !verified,
                        reloadStatus: verified ? "verified" : "restart-required",
                        lastVerifiedAt: verified ? Date.now() : null });
                } catch (error) {
                    writeLoaderState({ reloadStatus: "verification-failed", lastError: String(error.message || error) });
                }
            }, 5000);
            timer.unref?.();
        });
        if (!wc.isLoading?.()) checkUrl();
    } catch {}
}

function attachGreenZoneLifecycle() {
    try {
        const electron = require("electron");
        const app = electron && electron.app;
        if (!app || typeof app.on !== "function") return;

        app.on("browser-window-created", (_event, win) => {
            inspectWindowForMainDiscord(win);
        });

        app.on("before-quit", () => {
            stopDiscordSaysRelay();
            // Трогаем patcher.js на выходе ТОЛЬКО если главное окно уже загружалось
            // (то есть это НЕ сплеш-апдейтер, который перезапускается после Installing update...).
            if (mainWindowLoaded && areDistFilesSettled()) {
                try {
                    ensurePatcherHook(PATCHER_FILE);
                } catch {}
            }
        });

        const checkExistingWindows = () => {
            try {
                const BrowserWindow = electron.BrowserWindow;
                if (BrowserWindow && typeof BrowserWindow.getAllWindows === "function") {
                    for (const win of BrowserWindow.getAllWindows()) {
                        inspectWindowForMainDiscord(win);
                    }
                }
            } catch {}
        };

        if (typeof app.isReady === "function" && app.isReady()) {
            checkExistingWindows();
        } else if (typeof app.whenReady === "function") {
            app.whenReady().then(checkExistingWindows).catch(() => {});
        }
    } catch {}
}

/**
 * Локальный loopback-релей (127.0.0.1:43210) для квестов ACHIEVEMENT_IN_ACTIVITY.
 * Позволяет рендереру проксировать запросы к https://<appId>.discordsays.com/.proxy/acf/...
 * в обход CSP окна Discord.
 */
function isAllowedDiscordSaysUrl(rawUrl) {
    try {
        const parsed = new URL(String(rawUrl));
        if (parsed.protocol !== "https:") return null;
        const host = parsed.hostname.toLowerCase();
        if (!host.endsWith(DISCORDSAYS_HOST_SUFFIX)) return null;
        const prefix = host.slice(0, -DISCORDSAYS_HOST_SUFFIX.length);
        if (!/^\d+$/.test(prefix)) return null;
        if (!ALLOWED_PATH_RE.test(parsed.pathname)) return null;
        return parsed;
    } catch {
        return null;
    }
}

function forwardDiscordSaysRequest(targetUrl, headers, body) {
    return new Promise((resolve, reject) => {
        const payload = Buffer.from(String(body ?? ""), "utf8");
        const req = https.request(
            {
                protocol: targetUrl.protocol,
                hostname: targetUrl.hostname,
                port: targetUrl.port || 443,
                path: targetUrl.pathname + targetUrl.search,
                method: "POST",
                headers: {
                    "Content-Type": headers["content-type"] || "application/json",
                    "Content-Length": payload.length,
                    "X-Auth-Token": headers["x-auth-token"] ?? "",
                    "X-Discord-Quest-ID": headers["x-discord-quest-id"] ?? "",
                    "Referer": headers["referer"] ?? "",
                    "Origin": `https://${targetUrl.hostname}`,
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
                },
            },
            res => {
                const chunks = [];
                res.on("data", chunk => chunks.push(chunk));
                res.on("end", () => {
                    resolve({
                        status: res.statusCode || 0,
                        body: Buffer.concat(chunks).toString("utf8"),
                    });
                });
            }
        );
        req.on("error", reject);
        req.setTimeout(25000, () => {
            req.destroy(new Error("discordsays proxy timeout"));
        });
        req.write(payload);
        req.end();
    });
}

function stopDiscordSaysRelay() {
    try {
        if (relayServer) {
            relayServer.close();
            relayServer = null;
        }
    } catch {}
}

function startDiscordSaysRelay(keepAlive = false) {
    if (relayServer) return relayServer;
    try {
        const server = http.createServer((req, res) => {
            const origin = String(req.headers.origin || "");
            const allowOrigin = DISCORD_ORIGIN_RE.test(origin) ? origin : "https://discord.com";

            res.setHeader("Access-Control-Allow-Origin", allowOrigin);
            res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Orion-Relay");
            res.setHeader("Vary", "Origin");

            if (req.method === "OPTIONS") {
                res.writeHead(204);
                res.end();
                return;
            }

            if (req.url === "/ping" && (req.method === "POST" || req.method === "GET")) {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true, service: "questfarmer-relay", version: "1.4.4" }));
                return;
            }

            if (req.method !== "POST" || req.url !== "/proxy") {
                res.writeHead(404, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "not_found" }));
                return;
            }

            if (req.headers[RELAY_HEADER] !== "1") {
                res.writeHead(403, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "missing_relay_header" }));
                return;
            }

            const chunks = [];
            let total = 0;
            req.on("data", chunk => {
                total += chunk.length;
                if (total <= 65536) chunks.push(chunk);
            });
            req.on("end", async () => {
                try {
                    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
                    const targetUrl = isAllowedDiscordSaysUrl(parsed.url);
                    if (!targetUrl) {
                        res.writeHead(400, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ error: "disallowed_target_url" }));
                        return;
                    }
                    const hdrs = {};
                    if (parsed.headers && typeof parsed.headers === "object") {
                        for (const [k, v] of Object.entries(parsed.headers)) {
                            hdrs[String(k).toLowerCase()] = String(v ?? "");
                        }
                    }
                    const upstream = await forwardDiscordSaysRequest(targetUrl, hdrs, parsed.body ?? "");
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify(upstream));
                } catch (err) {
                    res.writeHead(502, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: String(err && err.message ? err.message : err) }));
                }
            });
        });

        server.on("error", () => {});
        server.listen(RELAY_PORT, RELAY_HOST, () => {
            if (!keepAlive && typeof server.unref === "function") {
                server.unref();
            }
        });
        relayServer = server;
        return server;
    } catch {
        return null;
    }
}

module.exports = {
    version: "1.4.4", patchRendererFile, isRendererAlreadyPatched,
    areDistFilesSettled, ensureSettingsEnabled, stripPatcherHook,
    buildMiniAsar, startDiscordSaysRelay, stopDiscordSaysRelay,
};

// In coordinator mode, expose patch operations without starting the old timers,
// restoring hooks, writing app.asar, or delegating to Vencord again.
if (global.__QF_ADAPTER_ONLY__) return;

// ======================= CLI-режимы (--install / --uninstall / --test-green-zone) =======================
if (require.main === module) {
    if (process.argv.includes("--daemon-relay")) {
        startDiscordSaysRelay(true);
        return;
    }

    if (process.argv.includes("--uninstall")) {
        restoreDiscordAsarsToStandardVencord();
        stripPatcherHook(PATCHER_FILE);
        try {
            if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
        } catch {}
        return;
    }

    if (process.argv.includes("--test-green-zone")) {
        (async () => {
            const r = await runPostGreenZoneCheck("cli-test");
            console.log(JSON.stringify(r));
        })();
        return;
    }

    if (process.argv.includes("--install")) {
        restoreDiscordAsarsToStandardVencord();
        ensureSettingsEnabled(true);
        patchRendererFile(RENDERER_FILE);
        patchRendererFile(DESKTOP_RENDERER_FILE);
        if (!isRendererAlreadyPatched(RENDERER_FILE)) {
            throw new Error(readLoaderState().lastError || "QuestFarmer renderer patch verification failed");
        }
        ensurePatcherHook(PATCHER_FILE);
        writeLoaderState({ restartRequired: true, pendingReload: false,
            reloadStatus: "restart-required", restartReason: "installed-1.4.4" });
        try {
            const { spawn } = require("child_process");
            const child = spawn(process.execPath, [__filename, "--daemon-relay"], {
                detached: true,
                stdio: "ignore",
            });
            child.unref();
        } catch {}
        return;
    }
}

// ======================= Режим внутри Electron (Discord) =======================
if (!global.__QUESTFARMER_LOADER_ACTIVE__) {
    global.__QUESTFARMER_LOADER_ACTIVE__ = true;
    if (process.versions && process.versions.electron) {
        attachGreenZoneLifecycle();
    }
}

// Если нас вызвали напрямую (а не из первой строчки самого patcher.js) — передаём управление Vencord:
if (!require.cache[PATCHER_FILE] && fs.existsSync(PATCHER_FILE)) {
    require(PATCHER_FILE);
}
