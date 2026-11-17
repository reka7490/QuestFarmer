"use strict";
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};

// post-loader/package.cjs
var require_package = __commonJS({
  "post-loader/package.cjs"(exports2, module2) {
    "use strict";
    var crypto = require("crypto");
    var fs2 = require("fs");
    var path2 = require("path");
    var https = require("https");
    var sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
    var MAX_FILE = 8 * 1024 * 1024;
    var FILES = ["adapter", "inject", "runtime"];
    function validateManifest(input) {
      if (!input || input.schema !== 1 || !/^\d+\.\d+\.\d+$/.test(input.version) || !Number.isSafeInteger(input.revision) || input.revision < 1) throw new Error("Invalid update manifest");
      if (!Array.isArray(input.platforms) || !input.platforms.includes(process.platform))
        throw new Error("Package does not support this platform");
      const files = {};
      for (const name of FILES) {
        const file = input.files?.[name];
        if (!file || !/^updates\/packages\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_FILE)
          throw new Error("Invalid package file: " + name);
        files[name] = { path: file.path, sha256: file.sha256, size: file.size };
      }
      return { schema: 1, version: input.version, revision: input.revision, platforms: input.platforms, files };
    }
    function githubBase(config) {
      if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(config.repository) || !/^[a-zA-Z0-9_.-]+$/.test(config.branch || "main")) throw new Error("Invalid GitHub repository/branch");
      return `https://github.com/${config.repository}/releases/latest/download/`;
    }
    function releaseFileURL(config, manifest, name) {
      githubBase(config);
      return `https://github.com/${config.repository}/releases/download/v${manifest.version}/${name}.js`;
    }
    function fetchBytes(url, limit = MAX_FILE, redirects = 0, deadline = Date.now() + 8e3) {
      return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const allowed = ["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"];
        if (parsed.protocol !== "https:" || !allowed.includes(parsed.hostname) || parsed.username || parsed.password || parsed.port && parsed.port !== "443")
          return reject(new Error("Disallowed update host"));
        const remaining = deadline - Date.now();
        if (remaining <= 0) return reject(new Error("GitHub request timeout"));
        const req = https.get(parsed, { agent: false, headers: { "User-Agent": "QuestFarmer-PostLoader/1", "Cache-Control": "no-cache" } }, (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
            res.resume();
            if (!res.headers.location || redirects >= 5) return reject(new Error("Invalid GitHub asset redirect"));
            let next;
            try {
              next = new URL(res.headers.location, parsed).href;
            } catch {
              return reject(new Error("Invalid GitHub asset redirect"));
            }
            fetchBytes(next, limit, redirects + 1, deadline).then(resolve, reject);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error("GitHub HTTP " + res.statusCode));
          }
          let size = 0;
          const chunks = [];
          res.on("data", (chunk) => {
            size += chunk.length;
            if (size > limit) req.destroy(new Error("Update exceeds size limit"));
            else chunks.push(chunk);
          });
          res.on("error", reject);
          res.on("end", () => resolve(Buffer.concat(chunks)));
        });
        req.on("socket", (socket) => socket.unref());
        req.on("error", reject);
        req.setTimeout(remaining, () => req.destroy(new Error("GitHub request timeout")));
      });
    }
    function atomicWrite(file, data) {
      fs2.mkdirSync(path2.dirname(file), { recursive: true });
      const temp = file + ".tmp-" + process.pid + "-" + crypto.randomBytes(4).toString("hex");
      try {
        fs2.writeFileSync(temp, data);
        fs2.renameSync(temp, file);
      } catch (error) {
        try {
          fs2.unlinkSync(temp);
        } catch {
        }
        throw error;
      }
    }
    function verifyFiles(manifest, read) {
      for (const name of FILES) {
        const data = read(name);
        const spec = manifest.files[name];
        if (data.length !== spec.size || sha256(data) !== spec.sha256) throw new Error("Package checksum mismatch: " + name);
      }
    }
    var PackageStore = class {
      constructor(home, config, fetcher = fetchBytes) {
        this.home = home;
        this.config = config;
        this.fetcher = fetcher;
        this.cache = path2.join(home, "questfarmer-cache");
        this.remote = null;
        this.prefetching = null;
        this.selecting = null;
        this.lastFetch = 0;
        this.error = null;
      }
      prefetch(force = false) {
        if (this.prefetching) return this.prefetching;
        if (!force && this.lastFetch && Date.now() - this.lastFetch < 30 * 60 * 1e3) return Promise.resolve(this.remote);
        this.lastFetch = Date.now();
        this.prefetching = this.fetcher(githubBase(this.config) + "manifest.json", 65536).then((data) => {
          this.remote = validateManifest(JSON.parse(data));
          this.error = null;
          return this.remote;
        }).catch((error) => {
          this.error = String(error.message || error);
          this.remote = null;
          return null;
        }).finally(() => {
          this.prefetching = null;
        });
        return this.prefetching;
      }
      directory(manifest) {
        return path2.join(this.cache, "packages", `${manifest.revision}-${manifest.version}-${manifest.files.adapter.sha256.slice(0, 12)}`);
      }
      readRecord(pointer = "current") {
        try {
          const manifest = validateManifest(JSON.parse(fs2.readFileSync(path2.join(this.cache, pointer + ".json"), "utf8")));
          verifyFiles(manifest, (name) => fs2.readFileSync(path2.join(this.directory(manifest), name + ".js")));
          return manifest;
        } catch {
          return null;
        }
      }
      seed(manifest, read) {
        manifest = validateManifest(manifest);
        verifyFiles(manifest, read);
        const dir = this.directory(manifest);
        for (const name of FILES) atomicWrite(path2.join(dir, name + ".js"), read(name));
        atomicWrite(path2.join(this.cache, "current.json"), JSON.stringify(manifest, null, 2));
        return manifest;
      }
      select() {
        if (!this.selecting) this.selecting = this.selectPackage().finally(() => {
          this.selecting = null;
        });
        return this.selecting;
      }
      async selectPackage() {
        if (this.prefetching) await this.prefetching;
        const local = [this.readRecord(), this.readRecord("prepared"), this.readRecord("previous")].filter(Boolean).sort((a, b) => b.revision - a.revision)[0];
        const remote = this.remote;
        if (!remote || local && remote.revision < local.revision) return local;
        if (local && remote.revision === local.revision) {
          if (JSON.stringify(remote) !== JSON.stringify(local)) throw new Error("Published revision changed; publish a new revision");
          return local;
        }
        const data = {};
        for (const name of FILES) data[name] = await this.fetcher(releaseFileURL(this.config, remote, name), remote.files[name].size);
        verifyFiles(remote, (name) => data[name]);
        for (const name of FILES) new (require("vm")).Script(require("module").wrap(data[name].toString("utf8")));
        const dir = this.directory(remote);
        for (const name of FILES) atomicWrite(path2.join(dir, name + ".js"), data[name]);
        return remote;
      }
      activate(manifest) {
        const old = this.readRecord();
        if (old && JSON.stringify(old) === JSON.stringify(manifest)) return;
        if (old && old.revision !== manifest.revision) atomicWrite(path2.join(this.cache, "previous.json"), JSON.stringify(old, null, 2));
        atomicWrite(path2.join(this.cache, "current.json"), JSON.stringify(manifest, null, 2));
      }
    };
    module2.exports = { PackageStore, validateManifest, verifyFiles, sha256, atomicWrite, githubBase, releaseFileURL, fetchBytes, FILES };
  }
});

// post-loader/coordinator.cjs
var require_coordinator = __commonJS({
  "post-loader/coordinator.cjs"(exports2, module2) {
    "use strict";
    var fs2 = require("fs");
    var path2 = require("path");
    var { PackageStore, atomicWrite, sha256 } = require_package();
    var Coordinator2 = class {
      constructor(home, config, options = {}) {
        this.home = home;
        this.config = config;
        this.store = options.store || new PackageStore(home, config);
        this.adapterLoader = options.adapterLoader || ((manifest) => this.loadAdapter(manifest));
        this.mainReady = false;
        this.greenUntil = 0;
        this.updaterBusy = 0;
        this.epoch = 0;
        this.checkSeen = false;
        this.checkDone = false;
        this.buildExpected = false;
        this.buildFailed = false;
        this.running = false;
        this.closed = false;
        this.activeAdapter = null;
        this.buildDepth = 0;
        this.lastGoodRenderer = null;
        this.rendererWaiters = /* @__PURE__ */ new Set();
        this.rendererPreparation = null;
        this.stateFile = path2.join(home, "questfarmer-post-state.json");
        this.state = { status: "waiting-discord", networkError: null };
        try {
          this.state = { ...JSON.parse(fs2.readFileSync(this.stateFile, "utf8")), ...this.state };
        } catch {
        }
      }
      save(patch) {
        const next = { ...this.state, ...patch };
        if (JSON.stringify(next) === JSON.stringify(this.state)) return;
        Object.assign(this.state, patch, { at: Date.now() });
        atomicWrite(this.stateFile, JSON.stringify(this.state, null, 2) + "\n");
      }
      prefetch(force = false) {
        return this.store.prefetch(force);
      }
      prepareRendererUpdate(force = false) {
        if (this.closed) return Promise.resolve(null);
        if (this.rendererPreparation && (!this.rendererPreparation.done || !this.rendererPreparation.claimed))
          return this.rendererPreparation.promise;
        const preparation = { done: false, claimed: false, promise: null };
        this.rendererPreparation = preparation;
        preparation.promise = (async () => {
          await this.prefetch(force);
          const manifest = await this.store.select();
          if (!this.closed && manifest) this.stagePackage(manifest);
          return manifest;
        })().catch((error) => {
          this.store.error = String(error.message || error);
          console.warn("[QuestFarmer renderer gate] Update preparation failed:", this.store.error);
          return null;
        }).finally(() => {
          preparation.done = true;
        });
        return preparation.promise;
      }
      stagePackage(manifest) {
        const newer = [this.store.readRecord(), this.store.readRecord("prepared")].filter(Boolean).find((local) => local.revision > manifest.revision);
        if (newer) return;
        const pointer = path2.join(this.store.cache, "prepared.json");
        const data = JSON.stringify(manifest, null, 2);
        let existing;
        try {
          existing = fs2.readFileSync(pointer, "utf8");
        } catch {
        }
        if (existing !== data) atomicWrite(pointer, data);
        this.save({ preparedRevision: manifest.revision, networkError: this.store.error });
      }
      mainLoaded() {
        this.mainReady = true;
        this.greenUntil = Date.now() + Math.max(1e3, this.config.greenZoneMs || 45e3);
      }
      beginUpdate(channel) {
        if (channel === "VencordBuild") {
          if (!this.buildDepth && !this.buildFailed) {
            try {
              this.lastGoodRenderer = fs2.readFileSync(path2.join(this.home, "dist/renderer.js"), "utf8");
            } catch {
            }
          }
          this.buildDepth++;
        }
        this.updaterBusy++;
        this.epoch++;
        if (channel === "VencordGetUpdates" || channel === "VencordUpdate") {
          this.checkSeen = true;
          this.checkDone = false;
        }
        this.prefetch(channel === "VencordGetUpdates" || channel === "VencordUpdate").catch(() => {
        });
      }
      endUpdate(channel, result, failed = false) {
        this.updaterBusy = Math.max(0, this.updaterBusy - 1);
        this.epoch++;
        if (channel === "VencordGetUpdates" || channel === "VencordUpdate") {
          this.checkDone = true;
          const value = result?.ok === true ? result.value : result;
          const settings = this.settings();
          if (channel === "VencordGetUpdates" && !failed && result?.ok !== false && !Array.isArray(value)) {
            this.checkDone = false;
            console.warn("[QuestFarmer post-loader] Unknown update-check result; queue remains paused");
          }
          const outdated = channel === "VencordGetUpdates" ? Array.isArray(value) && value.length > 0 : value === true;
          this.buildExpected = !failed && result?.ok !== false && outdated && settings.autoUpdate !== false;
        }
        if (channel === "VencordBuild") {
          this.buildDepth = Math.max(0, this.buildDepth - 1);
          this.buildExpected = false;
          this.buildFailed = failed || result?.ok === false || (result?.ok === true ? result.value : result) !== true;
          if (!this.buildDepth) for (const done of [...this.rendererWaiters]) done();
        }
        this.greenUntil = Math.max(this.greenUntil, Date.now() + (this.config.quietMs || 12e3));
      }
      settings() {
        try {
          return JSON.parse(fs2.readFileSync(path2.join(this.home, "settings", "settings.json"), "utf8"));
        } catch {
          return {};
        }
      }
      ready() {
        return !this.closed && this.mainReady && this.checkSeen && this.checkDone && !this.updaterBusy && !this.buildExpected && !this.buildFailed && Date.now() >= this.greenUntil;
      }
      settled() {
        const quiet = this.config.quietMs || 12e3;
        for (const name of ["renderer.js", "patcher.js", "vencordDesktopRenderer.js"]) {
          try {
            if (Date.now() - fs2.statSync(path2.join(this.home, "dist", name)).mtimeMs < quiet) return false;
          } catch (e) {
            if (e.code !== "ENOENT") return false;
          }
        }
        return true;
      }
      loadAdapter(manifest) {
        const dir = this.store.directory(manifest);
        const keys = ["__QF_ADAPTER_ONLY__", "__QF_ADAPTER_HOME__", "__QF_ADAPTER_PAYLOAD__"];
        const old = keys.map((k) => global[k]);
        Object.assign(global, { __QF_ADAPTER_ONLY__: true, __QF_ADAPTER_HOME__: this.home, __QF_ADAPTER_PAYLOAD__: path2.join(dir, "inject.js") });
        try {
          const adapter = require(path2.join(dir, "adapter.js"));
          if (adapter.version !== manifest.version || typeof adapter.patchRendererFile !== "function") throw new Error("Unsupported patch adapter");
          return adapter;
        } finally {
          keys.forEach((k, i) => old[i] === void 0 ? delete global[k] : global[k] = old[i]);
        }
      }
      async tick() {
        if (this.running || !this.ready()) return { status: "waiting-queue" };
        this.running = true;
        const epoch = this.epoch;
        try {
          if (!this.settled()) return { status: "settling" };
          const previous = this.store.readRecord() || this.store.readRecord("previous");
          let manifest;
          try {
            manifest = await this.store.select();
          } catch (error) {
            this.store.error = error.message;
            manifest = previous;
          }
          if (!manifest) {
            this.save({ status: "no-verified-package", networkError: this.store.error });
            return this.state;
          }
          if (!this.ready() || epoch !== this.epoch || !this.settled()) return { status: "queue-changed" };
          this.stagePackage(manifest);
          return { status: "prepared-for-renderer", revision: manifest.revision };
        } catch (error) {
          this.save({ status: "error", error: String(error.message || error) });
          return this.state;
        } finally {
          this.running = false;
        }
      }
      beforeRenderer() {
        if (this.closed || this.buildDepth || this.buildFailed) return { status: "renderer-blocked" };
        const previous = this.store.readRecord() || this.store.readRecord("previous");
        const manifest = [previous, this.store.readRecord("prepared")].filter(Boolean).sort((a, b) => b.revision - a.revision)[0];
        if (!manifest) return { status: "no-verified-package" };
        try {
          const renderer = path2.join(this.home, "dist", "renderer.js");
          if (!fs2.existsSync(renderer)) throw new Error("No Vencord renderer; install official Vencord first");
          const marker = `/*QF_POST_PACKAGE:${manifest.revision}:${manifest.files.inject.sha256}*/`;
          const before = fs2.readFileSync(renderer, "utf8");
          const markerAt = before.indexOf(marker);
          const expected = this.state.rendererSha256;
          const intact = markerAt >= 0 && Boolean(expected) && sha256(before) === expected;
          if (intact && before.includes(`QUESTFARMER_INJECT_VERSION:${manifest.version}`)) {
            this.restoreSettings();
            this.save({ status: "already-patched", revision: manifest.revision, version: manifest.version, networkError: this.store.error });
            return this.state;
          }
          const backup = path2.join(this.home, "questfarmer-cache", "backups", sha256(before) + ".renderer.js");
          if (!fs2.existsSync(backup)) atomicWrite(backup, before);
          const adapter = this.adapterLoader(manifest);
          const runtimeChanged = previous && previous.files.runtime.sha256 !== manifest.files.runtime.sha256;
          const owned = "/*===QUESTFARMER_STANDALONE_INJECT===*/";
          const index = before.indexOf(owned);
          let changed = false;
          try {
            if (index >= 0) {
              const prefix = before.slice(0, index).replace('QuestFarmer:{folderName:"questFarmer",userPlugin:!0},', "");
              atomicWrite(renderer, prefix);
            }
            changed = adapter.patchRendererFile(renderer);
            const patched = fs2.readFileSync(renderer, "utf8");
            if (!changed || !patched.includes(`QUESTFARMER_INJECT_VERSION:${manifest.version}`)) throw new Error("Patch did not verify");
            atomicWrite(renderer, patched + "\n" + marker + "\n");
          } catch (error) {
            atomicWrite(renderer, before);
            throw error;
          }
          this.store.activate(manifest);
          this.restoreSettings();
          this.activeAdapter = adapter;
          this.save({
            status: "patched-before-renderer",
            revision: manifest.revision,
            version: manifest.version,
            rendererSha256: sha256(fs2.readFileSync(renderer)),
            runtimeChanged: Boolean(runtimeChanged),
            networkError: this.store.error
          });
          return this.state;
        } catch (error) {
          this.save({ status: "error", error: String(error.message || error) });
          return this.state;
        }
      }
      serveRenderer(listener, receiver, event, args = []) {
        const started = Date.now();
        let finished = false, timeout, networkDone = false;
        const deliver = (fallback) => {
          if (finished) return;
          finished = true;
          clearTimeout(timeout);
          this.rendererWaiters.delete(resume);
          event.sender?.removeListener?.("destroyed", cancel);
          if (event.sender?.isDestroyed?.()) return;
          if (fallback || this.closed || this.buildFailed || this.buildDepth) {
            event.returnValue = this.lastGoodRenderer || "";
            console.warn("[QuestFarmer renderer gate] Safe fallback; updater unfinished or failed");
            return;
          }
          let result;
          try {
            result = this.beforeRenderer();
          } catch (error) {
            result = { status: "patch-error-stock-fallback" };
            console.error("[QuestFarmer renderer gate] Patch check failed:", error.message);
          }
          try {
            const proxy = new Proxy(event, {
              get: (target, key) => Reflect.get(target, key, target),
              set: (target, key, value) => {
                if (key === "returnValue" && typeof value === "string") this.lastGoodRenderer = value;
                return Reflect.set(target, key, value, target);
              }
            });
            listener.apply(receiver, [proxy, ...args]);
          } catch (error) {
            event.returnValue = this.lastGoodRenderer || "";
            console.error("[QuestFarmer renderer gate] Stock read failed:", error.message);
          }
          console.info("[QuestFarmer renderer gate]", result.status, `${Date.now() - started}ms`);
        };
        const resume = () => {
          if (this.closed || this.buildFailed) deliver(true);
          else if (networkDone && !this.buildDepth) deliver(false);
        };
        const cancel = () => {
          finished = true;
          clearTimeout(timeout);
          this.rendererWaiters.delete(resume);
        };
        if (this.closed || this.buildFailed) {
          deliver(true);
          return;
        }
        this.rendererWaiters.add(resume);
        event.sender?.once?.("destroyed", cancel);
        timeout = setTimeout(() => {
          console.warn("[QuestFarmer renderer gate] Wait timed out; using verified local fallback");
          deliver(Boolean(this.buildDepth || this.buildFailed));
        }, Math.min(3e4, Math.max(100, this.config.rendererWaitMs || 1e4)));
        timeout.unref?.();
        if (!this.rendererPreparation || this.rendererPreparation.done && this.rendererPreparation.claimed)
          this.prepareRendererUpdate(true);
        const preparation = this.rendererPreparation;
        preparation.claimed = true;
        preparation.promise.then(() => {
          networkDone = true;
          resume();
        });
        console.info("[QuestFarmer renderer gate] Waiting for early GitHub check/package and any active Vencord write");
      }
      restoreSettings() {
        const file = path2.join(this.home, "settings", "settings.json");
        const settings = this.settings();
        settings.plugins ||= {};
        const preferences = path2.join(this.home, "questfarmer-cache", "preferences.json");
        if (!settings.plugins.QuestFarmer) {
          let saved;
          try {
            saved = JSON.parse(fs2.readFileSync(preferences, "utf8"));
          } catch {
          }
          settings.plugins.QuestFarmer = saved || { enabled: true };
          atomicWrite(file, JSON.stringify(settings, null, 4) + "\n");
        }
        const data = JSON.stringify(settings.plugins.QuestFarmer, null, 2);
        let existing;
        try {
          existing = fs2.readFileSync(preferences, "utf8");
        } catch {
        }
        if (existing !== data) atomicWrite(preferences, data);
      }
      close() {
        this.closed = true;
        for (const done of [...this.rendererWaiters]) done();
        this.relayAdapter?.stopDiscordSaysRelay?.();
        this.activeAdapter?.stopDiscordSaysRelay?.();
      }
    };
    module2.exports = { Coordinator: Coordinator2 };
  }
});

// post-loader/runtime.cjs
var path = require("path");
var fs = require("fs");
var { Coordinator } = require_coordinator();
function start(home, electron, delegate) {
  const config = JSON.parse(fs.readFileSync(path.join(home, "questfarmer-post-config.json"), "utf8"));
  const queue = new Coordinator(home, config);
  queue.prepareRendererUpdate(true);
  const channels = /* @__PURE__ */ new Set(["VencordGetUpdates", "VencordUpdate", "VencordBuild"]);
  const ipc = electron.ipcMain;
  const originalHandle = ipc.handle;
  const originalOn = ipc.on;
  let rendererListener;
  ipc.on = function(channel, listener) {
    if (channel !== "VencordPreloadGetRendererJs") return originalOn.call(this, channel, listener);
    rendererListener = function(event, ...args) {
      const url = event.senderFrame?.url || event.sender?.getURL?.() || "";
      if (!/^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\//i.test(url))
        return listener.apply(this, [event, ...args]);
      queue.serveRenderer(listener, this, event, args);
    };
    return originalOn.call(this, channel, rendererListener);
  };
  ipc.handle = function(channel, listener) {
    if (!channels.has(channel)) return originalHandle.call(this, channel, listener);
    return originalHandle.call(this, channel, async function(...args) {
      queue.beginUpdate(channel);
      console.info("[QuestFarmer post-loader] Update stage started:", channel);
      try {
        const result = await listener.apply(this, args);
        queue.endUpdate(channel, result);
        console.info("[QuestFarmer post-loader] Update stage finished:", channel, result?.ok === false ? "failed" : "done");
        return result;
      } catch (error) {
        queue.endUpdate(channel, null, true);
        console.warn("[QuestFarmer post-loader] Update stage failed:", channel);
        throw error;
      }
    });
  };
  let interval, lastStatus;
  const listenWindow = (win) => {
    win.webContents.on("did-start-navigation", (_event, url, _inPlace, isMainFrame) => {
      if (isMainFrame && !_inPlace && /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\//i.test(url))
        queue.prepareRendererUpdate(true);
    });
    win.webContents.on("did-finish-load", () => {
      if (!/^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\//i.test(win.webContents.getURL())) return;
      queue.mainLoaded();
      console.info("[QuestFarmer post-loader] Main window loaded; waiting for green zone and Vencord update completion");
      if (!interval) {
        interval = setInterval(() => {
          queue.prefetch().catch(() => {
          });
          queue.tick().then((result) => {
            if (result.status !== lastStatus) {
              lastStatus = result.status;
              console.info("[QuestFarmer post-loader] Queue:", lastStatus);
            }
          }).catch((error) => console.error("[QuestFarmer post-loader]", error.message));
        }, 15e3);
        interval.unref?.();
      }
      const cached = queue.store.readRecord();
      if (cached) {
        try {
          queue.relayAdapter = queue.loadAdapter(cached);
          queue.relayAdapter.startDiscordSaysRelay();
        } catch (error) {
          console.error("[QuestFarmer relay]", error.message);
        }
      }
    });
  };
  electron.app.on("browser-window-created", (_event, win) => listenWindow(win));
  electron.app.on("before-quit", () => {
    clearInterval(interval);
    queue.close();
  });
  try {
    delegate();
  } finally {
    ipc.handle = originalHandle;
    ipc.on = originalOn;
  }
  if (!rendererListener) console.error("[QuestFarmer renderer gate] Stock renderer-read IPC not found; no early injection available");
  console.info("[QuestFarmer post-loader] Stock Vencord delegated; update-stage observers registered");
  return queue;
}
module.exports = { start, bootstrapApi: 1 };
