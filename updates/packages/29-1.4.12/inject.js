(() => {
  // vencord-plugin/questFarmer/core.ts
  function createQuestFarmer() {
    "use strict";
    const localStorage2 = (() => {
      try {
        return window.Vencord?.Util?.localStorage || globalThis.localStorage;
      } catch {
        return null;
      }
    })();
    try {
      if (window.DQ?._state?.running) {
        console.warn("[quests] \u041F\u0440\u0435\u0434\u044B\u0434\u0443\u0449\u0438\u0439 \u0437\u0430\u043F\u0443\u0441\u043A \u0435\u0449\u0451 \u0430\u043A\u0442\u0438\u0432\u0435\u043D \u2014 \u043E\u0441\u0442\u0430\u043D\u0430\u0432\u043B\u0438\u0432\u0430\u044E \u0435\u0433\u043E.");
        window.DQ.stop();
      }
    } catch {
    }
    const VERSION = "1.4.12";
    const CONFIG = {
      autoEnroll: true,
      // принимать квесты автоматически
      hideClaimedQuests: true,
      // скрывать только уже забранные награды
      autoClaim: false,
      // забирать награды автоматически (может вылезти капча)
      onlyOrbs: false,
      // трогать только квесты с Orb-наградой
      types: ["VIDEO", "GAME", "ACTIVITY", "ACHIEVEMENT"],
      maxMinutes: 40,
      // потолок на один квест
      videoMinGap: 7e3,
      // мс между video-progress
      videoMaxGap: 9500,
      pollMs: 2e3,
      // как часто проверять прогресс GAME-квеста
      gameNoProgressSec: 150,
      // сколько ждать первый heartbeat, прежде чем сдаться
      // Автофарм по расписанию. Работает только в Vencord-плагине:
      // консольный quests.js не переживает перезапуск клиента.
      schedule: {
        enabled: true,
        everyHours: 12,
        // пауза от фактического конца прошлой сессии (по стандарту 12 ч)
        checkMinutes: 10,
        // как часто проверять, не пора ли
        retryNoQuestsHours: 6,
        // если подходящих квестов нет — не долбить чаще
        maxSessionMinutes: 180,
        // аварийный стоп всей сессии
        types: ["GAME", "ACTIVITY", "ACHIEVEMENT"],
        // по умолчанию игры + активности + ачивки в активностях
        onlyOrbs: true,
        autoClaim: true
      }
    };
    const BLACKLISTED_QUESTS = /* @__PURE__ */ new Set([
      "1412491570820812933"
      // ломает enroll у аккаунта
    ]);
    const CONSOLE_ONLY = /* @__PURE__ */ new Set(["PLAY_ON_XBOX", "PLAY_ON_PLAYSTATION"]);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const rnd = (a, b) => a + Math.random() * (b - a);
    const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
    const LOG_LIMIT = 250;
    function logArg(a) {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    }
    function recordLog(level, msg, args) {
      try {
        const text = [msg, ...args.map(logArg)].join(" ");
        state.logs.push({ t: Date.now(), level, text: text.slice(0, 500) });
        if (state.logs.length > LOG_LIMIT) state.logs.splice(0, state.logs.length - LOG_LIMIT);
      } catch {
      }
    }
    const tag = (color, level = "info") => (msg, ...args) => {
      console.log(`%c[quests]%c ${msg}`, `color:${color};font-weight:800`, "", ...args);
      recordLog(level, msg, args);
    };
    const log = tag("#5865f2", "info");
    const ok = tag("#3ba55d", "ok");
    const warn = tag("#faa81a", "warn");
    const error = tag("#ed4245", "error");
    const state = {
      running: false,
      runBusy: false,
      runIds: [],
      queue: [],
      queueOwner: null,
      queueDraining: false,
      manualActive: null,
      stop: false,
      modules: null,
      enrolledAt: /* @__PURE__ */ new Map(),
      // questId -> timestamp (локально, если стор не обновился)
      processed: /* @__PURE__ */ new Set(),
      restoreStore: null,
      fakeGames: [],
      // для панели в клиенте
      activity: null,
      // что делаю прямо сейчас
      lastError: null,
      logs: [],
      // автофарм
      booted: false,
      readySince: 0,
      connectionReady: false,
      connectionWatch: false,
      connectionEvents: [],
      safety: { schema: 1, accounts: {} },
      safetyLoaded: false,
      safetyStorageError: false,
      safetyStorageFailure: null,
      safetyReadFailed: false,
      safetyEvents: [],
      safetyCacheOwner: null,
      emptyConfirmed: false,
      schedBusy: false,
      sched: {
        lastEnd: 0,
        // фактический конец последней сессии
        startedAt: 0,
        lastBeat: 0,
        running: false,
        nextRetry: 0,
        failStreak: 0,
        // подряд неудачных сессий — для backoff
        lastResult: null
      },
      timers: []
    };
    function setActivity(activity) {
      state.activity = activity ? { startedAt: Date.now(), ...activity } : null;
    }
    let M = null;
    const SAFETY_KEY = "DQ_SAFETY_STATE_V1";
    const DISCORD_SYSTEM_ID = "643945264868098049";
    function safetyStorageFailure(operation, code) {
      state.safetyStorageError = true;
      state.safetyStorageFailure = { operation, code };
      warn(`\u0425\u0440\u0430\u043D\u0438\u043B\u0438\u0449\u0435 \u0437\u0430\u0449\u0438\u0442\u044B \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u043E: ${operation}/${code}. \u0417\u0430\u043F\u0443\u0441\u043A\u0438 \u0437\u0430\u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u0430\u043D\u044B.`);
    }
    function loadSafety() {
      if (state.safetyLoaded) return;
      state.safetyLoaded = true;
      let operation = "read";
      try {
        if (!localStorage2) throw new Error("storage-unavailable");
        const raw = localStorage2.getItem(SAFETY_KEY);
        if (!raw) {
          saveSafety();
          return;
        }
        operation = "validate";
        const saved = JSON.parse(raw);
        if (saved?.schema !== 1 || !saved.accounts || typeof saved.accounts !== "object" || Array.isArray(saved.accounts)) throw new Error("invalid safety state");
        for (const record of Object.values(saved.accounts)) {
          if (!record || typeof record.paused !== "boolean" || !Array.isArray(record.incidents) || record.incidents.some((i) => !i || typeof i.id !== "string" || typeof i.fingerprint !== "string")) throw new Error("invalid safety records");
        }
        state.safety = saved;
      } catch {
        state.safetyReadFailed = true;
        safetyStorageFailure(operation, operation === "validate" ? "invalid-state" : "storage-unavailable");
      }
    }
    function saveSafety() {
      if (state.safetyReadFailed) return;
      let operation = "write";
      try {
        const json = JSON.stringify(state.safety);
        localStorage2.setItem(SAFETY_KEY, json);
        operation = "verify";
        if (localStorage2.getItem(SAFETY_KEY) !== json) throw new Error("safety state not persisted");
      } catch {
        safetyStorageFailure(operation, operation === "verify" ? "readback-failed" : "storage-unavailable");
      }
    }
    function safetyOwner() {
      try {
        return String(M?.users?.getCurrentUser?.()?.id || "unknown");
      } catch {
        return "unknown";
      }
    }
    function safetyRecord() {
      loadSafety();
      return state.safety.accounts[safetyOwner()];
    }
    function safetyPaused() {
      loadSafety();
      return state.safetyStorageError || Boolean(state.safety.accounts.unknown?.paused || safetyRecord()?.paused);
    }
    function warningReason(text) {
      const s = String(text || "").toLowerCase();
      if (/inauthentic\s+quest\s+completion|inauthenticquestcompletion/.test(s)) return "inauthentic-quest-completion";
      if (/your\s+(?:access|ability)[\s\S]{0,100}quest[\s\S]{0,160}(?:suspend|restrict|block)|your\s+(?:access|ability)[\s\S]{0,160}(?:suspend|restrict|block)[\s\S]{0,100}quest/.test(s)) return "quest-access-warning";
      if (/unusual\s+quest\s+activity|quest\s+activity\s+(?:notice|warning)/.test(s)) return "quest-activity-warning";
      if (/fake\s+quest\s+completion/.test(s) && /violation|scripts|tools/.test(s)) return "quest-automation-warning";
      if (/необычн\S*\s+(?:активност|действи)/.test(s) && /квест|задани/.test(s)) return "quest-activity-warning-ru";
      if (/квест|задани/.test(s) && /неаутентичн|неподлинн|недостоверн/.test(s) && /выполн|заверш|активност/.test(s)) return "inauthentic-quest-completion-ru";
      if (/ваш\S*\s+доступ/.test(s) && /квест|задани/.test(s) && /приостанов|огранич|заблокир/.test(s)) return "quest-access-warning-ru";
      return null;
    }
    function restrictionEvidence() {
      const q = M?.quests;
      if (!q) return null;
      const until = (value) => {
        const n = new Date(value ?? NaN).getTime();
        return Number.isFinite(n) ? n : 0;
      };
      let suspended = q.isQuestAccessSuspended === true;
      try {
        if (typeof q.isQuestAccessSuspended === "function") suspended = q.isQuestAccessSuspended() === true;
      } catch {
      }
      const access = until(q.questAccessSuspendedUntil);
      const enrollment = until(q.questEnrollmentBlockedUntil);
      if (suspended || access > Date.now()) return { reason: "quest-access-suspended", until: access, source: "QuestStore" };
      if (enrollment > Date.now()) return { reason: "quest-enrollment-blocked", until: enrollment, source: "QuestStore" };
      return null;
    }
    function latchSafety(evidence) {
      loadSafety();
      const owner = safetyOwner();
      const record = state.safety.accounts[owner] || { paused: false, incidents: [] };
      state.safety.accounts[owner] = record;
      const fingerprint = `${evidence.reason}:${evidence.messageId || evidence.until || "active"}`;
      if (record.incidents.some((i) => i.fingerprint === fingerprint && (evidence.messageId || !i.acknowledgedAt))) return;
      const incident = {
        id: `${Date.now()}-${record.incidents.length + 1}`,
        fingerprint,
        detectedAt: Date.now(),
        reason: evidence.reason,
        source: evidence.source,
        until: evidence.until || null,
        messageId: evidence.messageId || null,
        acknowledgedAt: null,
        pluginVersion: VERSION,
        session: {
          running: state.running || state.schedBusy,
          startedAt: state.sched.startedAt,
          completed: state.sched.doneInSession || 0
        },
        activity: state.activity ? { type: state.activity.type, questIds: [...state.activity.questIds || []] } : null,
        action: "mandatory-pause"
      };
      record.incidents.push(incident);
      record.paused = true;
      saveSafety();
      state.stop = true;
      state.queue.length = 0;
      restoreRunning();
      warn(`\u041E\u0431\u044F\u0437\u0430\u0442\u0435\u043B\u044C\u043D\u0430\u044F \u043F\u0430\u0443\u0437\u0430: ${incident.reason}. \u041E\u0442\u0447\u0451\u0442 \u0441\u043E\u0445\u0440\u0430\u043D\u0451\u043D; \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u043E\u0435 \u0432\u043E\u0437\u043E\u0431\u043D\u043E\u0432\u043B\u0435\u043D\u0438\u0435 \u0437\u0430\u043F\u0440\u0435\u0449\u0435\u043D\u043E.`);
      try {
        window.Vencord?.Api?.Notifications?.showNotification?.({
          title: "QuestFarmer \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D",
          body: "Discord \u0441\u043E\u043E\u0431\u0449\u0438\u043B \u043E \u043F\u0440\u0435\u0434\u0443\u043F\u0440\u0435\u0436\u0434\u0435\u043D\u0438\u0438 / \u043E\u0433\u0440\u0430\u043D\u0438\u0447\u0435\u043D\u0438\u0438 \u043A\u0432\u0435\u0441\u0442\u043E\u0432. \u041E\u0442\u043A\u0440\u043E\u0439 \xAB\u0410\u0432\u0442\u043E\u0444\u0430\u0440\u043C\xBB \u2192 \u043E\u0442\u0447\u0451\u0442. \u041F\u0430\u0443\u0437\u0430 \u0441\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u0430 \u0434\u043E \u0440\u0443\u0447\u043D\u043E\u0433\u043E \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u044F.",
          permanent: true,
          noPersist: true
        });
      } catch {
      }
    }
    function observeSafetyMessage(message) {
      if (!message || message.webhook_id || message.webhookId || String(message.author?.id) !== DISCORD_SYSTEM_ID) return;
      const text = [message.content, ...(message.embeds || []).flatMap((e) => [e.title, e.description, ...(e.fields || []).flatMap((f) => [f.name, f.value])])].filter(Boolean).join("\n");
      const reason = warningReason(text);
      if (reason) latchSafety({ reason, source: "Discord system message", messageId: String(message.id || "unknown") });
    }
    function checkSafety() {
      loadSafety();
      const evidence = restrictionEvidence();
      if (evidence) latchSafety(evidence);
      if (safetyPaused()) {
        state.stop = true;
        state.queue.length = 0;
        if (state.restoreStore) restoreRunning();
      }
      return safetyPaused();
    }
    function safetySnapshot() {
      const paused = checkSafety();
      const record = state.safety.accounts.unknown?.paused ? state.safety.accounts.unknown : safetyRecord();
      return {
        paused,
        storageError: state.safetyStorageError,
        storageFailure: state.safetyStorageFailure,
        incident: record?.incidents?.at(-1) || null,
        reportCount: record?.incidents?.length || 0,
        activeRestriction: restrictionEvidence()
      };
    }
    function safetyReport() {
      const s = safetySnapshot();
      const record = state.safety.accounts.unknown?.paused ? state.safety.accounts.unknown : safetyRecord();
      return {
        schema: 1,
        generatedAt: Date.now(),
        pluginVersion: VERSION,
        paused: s.paused,
        storageError: s.storageError,
        storageFailure: s.storageFailure,
        activeRestriction: s.activeRestriction,
        incidents: JSON.parse(JSON.stringify(record?.incidents || [])),
        limitations: "Only recognised EN/RU Discord system messages and exposed QuestStore restrictions. No inference of server detection rules. No private message contents or credentials."
      };
    }
    function acknowledgeSafety(incidentId) {
      if (state.running || state.schedBusy) return { ok: false, reason: "still-stopping" };
      if (checkSafety() && (state.safetyStorageError || state.safety.accounts.unknown?.paused || restrictionEvidence())) return { ok: false, reason: "active-restriction-or-unavailable-state" };
      const record = safetyRecord();
      const incident = record?.incidents?.at(-1);
      if (!record?.paused || !incident || incident.id !== incidentId) return { ok: false, reason: "incident-mismatch" };
      for (const i of record.incidents) if (!i.acknowledgedAt) i.acknowledgedAt = Date.now();
      record.paused = false;
      saveSafety();
      applySettingsPatch({ enabled: false });
      if (!state.running) state.stop = false;
      return { ok: !state.safetyStorageError, scheduleEnabled: false };
    }
    function attachSafetyMonitor() {
      if (!M?.dispatcher?.subscribe || state.safetyEvents.length) return;
      for (const [event, handler] of [
        ["MESSAGE_CREATE", (e) => observeSafetyMessage(e.message)],
        ["MESSAGE_UPDATE", (e) => observeSafetyMessage(e.message)],
        ["LOAD_MESSAGES_SUCCESS", (e) => {
          for (const m of e.messages || []) observeSafetyMessage(m);
        }],
        ["USER_UPDATE", () => checkSafety()],
        ["QUESTS_FETCH_CURRENT_QUESTS_SUCCESS", () => checkSafety()]
      ]) {
        const safeHandler = (e) => {
          try {
            handler(e || {});
          } catch {
          }
        };
        M.dispatcher.subscribe(event, safeHandler);
        state.safetyEvents.push([event, safeHandler]);
      }
      scanSafetyCache();
    }
    function scanSafetyCache() {
      if (state.safetyCacheOwner === safetyOwner()) return;
      try {
        M.messages ||= window.Vencord?.Webpack?.Common?.MessageStore;
        const id = M.channels?.getDMFromUserId?.(DISCORD_SYSTEM_ID);
        const cached = id ? M.messages?.getMessages?.(id) : null;
        const messages = cached?.toArray?.();
        if (!Array.isArray(messages)) return;
        for (const message of messages) observeSafetyMessage(message);
        state.safetyCacheOwner = safetyOwner();
      } catch {
      }
    }
    function webpack() {
      const W = window.Vencord?.Webpack;
      if (!W) {
        throw new Error(
          "window.Vencord.Webpack \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D. \u041D\u0443\u0436\u0435\u043D desktop-\u043A\u043B\u0438\u0435\u043D\u0442 \u0441 \u0432\u043A\u043B\u044E\u0447\u0451\u043D\u043D\u044B\u043C Vencord, \u043D\u0435 \u0431\u0440\u0430\u0443\u0437\u0435\u0440\u043D\u0430\u044F \u0432\u0435\u0440\u0441\u0438\u044F Discord."
        );
      }
      return W;
    }
    function init() {
      const W = webpack();
      const store = (name) => {
        try {
          return W.findStore?.(name) ?? null;
        } catch {
          return null;
        }
      };
      const props = (...names) => {
        try {
          return W.findByProps?.(...names) ?? null;
        } catch {
          return null;
        }
      };
      const common = W.Common ?? {};
      M = {
        quests: store("QuestStore") || store("QuestsStore") || props("getQuest", "quests"),
        running: store("RunningGameStore") || props("getRunningGames"),
        stream: store("ApplicationStreamingStore") || props("getStreamerActiveStreamMetadata"),
        channels: store("ChannelStore") || props("getSortedPrivateChannels"),
        guilds: store("GuildChannelStore") || props("getAllGuilds"),
        users: store("UserStore") || props("getCurrentUser"),
        messages: common.MessageStore || store("MessageStore"),
        dispatcher: common.FluxDispatcher || props("dispatch", "subscribe", "unsubscribe", "flushWaitQueue"),
        api: common.RestAPI || props("get", "post", "del")
      };
      const missing = ["quests", "api"].filter((k) => !M[k]);
      if (missing.length) {
        throw new Error(`\u041D\u0435 \u043D\u0430\u0448\u0451\u043B \u043C\u043E\u0434\u0443\u043B\u0438 Discord: ${missing.join(", ")}. \u041F\u0435\u0440\u0435\u0437\u0430\u043F\u0443\u0441\u0442\u0438 \u043A\u043B\u0438\u0435\u043D\u0442 / \u043E\u0431\u043D\u043E\u0432\u0438 Vencord.`);
      }
      state.modules = M;
      attachSafetyMonitor();
      checkSafety();
      return M;
    }
    function modules() {
      if (!M) init();
      return M;
    }
    async function apiCall(method, url, body, opts = {}) {
      const { api } = modules();
      const retries = opts.retries ?? 3;
      let lastErr = null;
      for (let attempt = 0; attempt <= retries; attempt++) {
        const cleanup = opts.stoppable === false && (method === "get" && url === "/oauth2/tokens" || method === "del" && /^\/oauth2\/tokens\/[A-Za-z0-9_-]+$/.test(url));
        if (!cleanup && checkSafety()) throw new Error("safety-paused");
        if (state.stop && opts.stoppable !== false) throw new Error("stopped");
        let res = null;
        let errObj = null;
        try {
          res = await api[method]({
            url,
            ...opts.query ? { query: opts.query } : {},
            ...body !== void 0 ? { body } : {}
          });
          if (!res || (res.status ?? 0) >= 400) errObj = res;
        } catch (e) {
          errObj = e;
        }
        if (!errObj) return res;
        const status = Number(errObj?.status ?? errObj?.statusCode ?? errObj?.httpStatus ?? 0);
        const errBody = errObj?.body ?? null;
        if (url.startsWith("/quests/") && warningReason(errBody?.message)) {
          latchSafety({ reason: warningReason(errBody.message), source: "Discord quest API" });
          throw new Error("safety-paused");
        }
        if (status === 429) {
          const wait = Number(errBody?.retry_after ?? 2);
          if (wait > 90) throw new Error(`rate limit ${Math.round(wait)}s`);
          warn(`rate limit (429), \u0436\u0434\u0443 ${wait.toFixed(1)} \u0441`);
          await sleep((wait + 0.5) * 1e3);
          continue;
        }
        const msg = errBody?.message ?? errObj?.message ?? `HTTP ${status || "error"}`;
        const err = new Error(`${method.toUpperCase()} ${url}: ${msg}`);
        err.status = status;
        err.body = errBody;
        lastErr = err;
        if (status >= 400 && status < 500 && status !== 408) {
          throw err;
        }
        if (attempt < retries) {
          await sleep(1500 * (attempt + 1));
          continue;
        }
        throw err;
      }
      throw lastErr ?? new Error("request failed");
    }
    function isExpired(q) {
      try {
        const store = modules().quests;
        if (typeof store?.isQuestExpired === "function") {
          return store.isQuestExpired(q.id) === true;
        }
      } catch {
      }
      const ends = new Date(q?.config?.expiresAt ?? NaN).getTime();
      return !Number.isNaN(ends) && ends <= Date.now();
    }
    function allQuests(opts = {}) {
      const raw = modules().quests.quests;
      if (!raw) return [];
      const list2 = typeof raw.values === "function" ? [...raw.values()] : Object.values(raw);
      if (opts.includeExpired) return list2;
      return list2.filter((q) => !isExpired(q));
    }
    function freshQuest(id) {
      try {
        const q = modules().quests.getQuest?.(id);
        if (q) return q;
      } catch {
      }
      return allQuests().find((q) => String(q.id) === String(id)) ?? null;
    }
    function questName(q) {
      return q?.config?.messages?.questName ?? q?.config?.messages?.questNameWithQuestReward ?? q?.id ?? "?";
    }
    function sealedFor(q) {
      try {
        return modules().quests.getQuest?.(q.id)?.trafficMetadataSealed ?? q?.trafficMetadataSealed ?? null;
      } catch {
        return null;
      }
    }
    function questOrbs(cfg) {
      const rewards = cfg?.rewardsConfig?.rewards;
      if (!Array.isArray(rewards)) return null;
      let orbs = 0;
      let premium = 0;
      for (const r of rewards) {
        const base = typeof r?.orbQuantity === "number" && r.orbQuantity > 0 ? r.orbQuantity : 0;
        if (!base) continue;
        orbs += base;
        premium += typeof r?.premiumOrbQuantity === "number" && r.premiumOrbQuantity > 0 ? r.premiumOrbQuantity : base;
      }
      return orbs > 0 ? { orbs, premium } : null;
    }
    function taskKeys(tasks) {
      if (!tasks) return [];
      if (tasks instanceof Map) return [...tasks.keys()];
      return Object.keys(tasks);
    }
    function taskAt(tasks, key) {
      if (!tasks) return null;
      return tasks instanceof Map ? tasks.get(key) ?? null : tasks[key] ?? null;
    }
    function selectTaskConfig(cfg) {
      const v2 = cfg?.taskConfigV2;
      if (taskKeys(v2?.tasks).length) return v2;
      const v1 = cfg?.taskConfig;
      if (taskKeys(v1?.tasks).length) return v1;
      return v2 ?? v1 ?? null;
    }
    function collectAppIds(tasks, task, cfg) {
      const ids = [];
      const push = (v) => {
        if (v !== void 0 && v !== null && String(v).trim() && String(v) !== "0") {
          const s = String(v).trim();
          if (!ids.includes(s)) ids.push(s);
        }
      };
      if (Array.isArray(task?.applications)) {
        for (const a of task.applications) push(a?.id);
      }
      push(cfg?.application?.id);
      for (const k of taskKeys(tasks)) {
        const t = taskAt(tasks, k);
        if (Array.isArray(t?.applications)) {
          for (const a of t.applications) push(a?.id);
        }
      }
      return ids;
    }
    function detectTask(cfg) {
      const tc = selectTaskConfig(cfg);
      const tasks = tc?.tasks;
      const keys = taskKeys(tasks);
      if (!keys.length) return null;
      const rules = [
        { type: "VIDEO", prefers: "WATCH_VIDEO", match: (k) => k.includes("VIDEO") },
        { type: "GAME", prefers: "PLAY_ON_DESKTOP", match: (k) => k.startsWith("PLAY") && k !== "PLAY_ACTIVITY" },
        { type: "ACTIVITY", exact: "PLAY_ACTIVITY" },
        { type: "ACTIVITY", match: (k) => k.includes("ACTIVITY") && k !== "ACHIEVEMENT_IN_ACTIVITY" },
        { type: "ACHIEVEMENT", exact: "ACHIEVEMENT_IN_ACTIVITY" },
        { type: "STREAM", prefers: "STREAM_ON_DESKTOP", match: (k) => k.startsWith("STREAM") }
      ];
      for (const rule of rules) {
        const key = rule.exact && keys.find((k) => k === rule.exact) || rule.prefers && keys.find((k) => k === rule.prefers) || keys.find((k) => rule.match?.(k) && !CONSOLE_ONLY.has(k));
        if (!key) continue;
        const task = taskAt(tasks, key) ?? {};
        const appIds = collectAppIds(tasks, task, cfg);
        return {
          type: rule.type,
          key,
          target: Number(task.target) || 0,
          appId: appIds[0] ?? null,
          appIds,
          canActivityFallback: keys.some((k) => k.includes("ACTIVITY"))
        };
      }
      if (keys.every((k) => CONSOLE_ONLY.has(k))) return null;
      if (cfg?.application?.id && keys.length) {
        const first = taskAt(tasks, keys[0]) ?? {};
        const appIds = collectAppIds(tasks, first, cfg);
        return {
          type: "GAME",
          key: "PLAY_ON_DESKTOP",
          target: Number(first.target) || 0,
          appId: appIds[0] ?? String(cfg.application.id),
          appIds,
          canActivityFallback: false
        };
      }
      return null;
    }
    function progressOf(q, key) {
      const p = q?.userStatus?.progress;
      const read = (k) => {
        if (!p || !k) return null;
        const entry = p instanceof Map ? p.get(k) : p?.[k];
        return typeof entry?.value === "number" ? entry.value : null;
      };
      return read(key) ?? read("WATCH_VIDEO") ?? read("PLAY_ON_DESKTOP") ?? read("PLAY_ACTIVITY") ?? (typeof q?.userStatus?.streamProgressSeconds === "number" ? q.userStatus.streamProgressSeconds : 0);
    }
    function isCompleted(q, det) {
      if (q?.userStatus?.completedAt) return true;
      if (!det) return false;
      return progressOf(q, det.key) >= det.target && det.target > 0;
    }
    function isClaimed(q) {
      return Boolean(q?.userStatus?.claimedAt ?? q?.userStatus?.claimed_at);
    }
    function list() {
      try {
        modules();
      } catch (e) {
        error(e.message);
        return [];
      }
      const rows = allQuests().map((q, i) => {
        const det = detectTask(q.config);
        const orbs2 = questOrbs(q.config);
        const done = isCompleted(q, det);
        const enrolled = Boolean(q.userStatus?.enrolledAt) || state.enrolledAt.has(String(q.id));
        const status = done ? isClaimed(q) ? "\u0437\u0430\u0431\u0440\u0430\u043D\u043E" : "\u0433\u043E\u0442\u043E\u0432\u043E (\u0437\u0430\u0431\u0440\u0430\u0442\u044C)" : enrolled ? "\u043F\u0440\u0438\u043D\u044F\u0442" : "\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D";
        return {
          "#": i + 1,
          "\u043A\u0432\u0435\u0441\u0442": questName(q),
          "\u0442\u0438\u043F": det ? det.key : "\u2014",
          "\u043D\u0430\u0433\u0440\u0430\u0434\u0430": orbs2 ? `${orbs2.orbs} Orbs${orbs2.premium !== orbs2.orbs ? ` (${orbs2.premium} Nitro)` : ""}` : "\u2014",
          "\u043F\u0440\u043E\u0433\u0440\u0435\u0441\u0441": det ? `${Math.floor(progressOf(q, det.key))}/${det.target} \u0441` : "\u2014",
          "\u0441\u0442\u0430\u0442\u0443\u0441": status,
          "\u0434\u043E": q.config?.expiresAt ? new Date(q.config.expiresAt).toLocaleString() : "\u2014"
        };
      });
      if (!rows.length) {
        warn("\u041A\u0432\u0435\u0441\u0442\u043E\u0432 \u043D\u0435\u0442.");
        return [];
      }
      console.table(rows);
      const orbs = allQuests().reduce((n, q) => {
        const det = detectTask(q.config);
        return n + (!isCompleted(q, det) ? questOrbs(q.config)?.orbs ?? 0 : 0);
      }, 0);
      log(`${rows.length} \u043A\u0432\u0435\u0441\u0442(\u043E\u0432), \u0434\u043E\u0441\u0442\u0443\u043F\u043D\u043E Orbs \u0437\u0430 \u043D\u0435\u0437\u0430\u0432\u0435\u0440\u0448\u0451\u043D\u043D\u044B\u0435: ${orbs}`);
      return rows;
    }
    function syncEnrolledStatus(q, body) {
      const enrolledIso = body?.enrolled_at ?? body?.enrolledAt ?? (/* @__PURE__ */ new Date()).toISOString();
      const patch = (target) => {
        if (!target || typeof target !== "object") return;
        target.userStatus = {
          ...target.userStatus || {},
          ...body && typeof body === "object" ? body : {},
          enrolledAt: target.userStatus?.enrolledAt || enrolledIso,
          enrolled_at: target.userStatus?.enrolled_at || enrolledIso,
          progress: target.userStatus?.progress ?? body?.progress ?? {}
        };
      };
      patch(q);
      patch(freshQuest(q.id));
      try {
        modules().dispatcher?.dispatch?.({
          type: "QUESTS_ENROLL_SUCCESS",
          questId: q.id,
          userQuestStatus: body ?? q.userStatus,
          userStatus: body ?? q.userStatus
        });
      } catch {
      }
    }
    async function enroll(q) {
      if (!CONFIG.autoEnroll) return false;
      if (q.userStatus?.enrolledAt || state.enrolledAt.has(String(q.id))) {
        syncEnrolledStatus(q, q.userStatus);
        return true;
      }
      log(`\u041F\u0440\u0438\u043D\u0438\u043C\u0430\u044E "${questName(q)}"...`);
      const res = await apiCall("post", `/quests/${q.id}/enroll`, {
        location: 11,
        is_targeted: false,
        metadata_sealed: null,
        traffic_metadata_sealed: sealedFor(q)
      });
      state.enrolledAt.set(String(q.id), Date.now());
      syncEnrolledStatus(q, res?.body);
      await sleep(rnd(1200, 1900));
      ok(`\u041F\u0440\u0438\u043D\u044F\u0442 "${questName(q)}"`);
      return true;
    }
    async function completeVideo(q, det) {
      const live = freshQuest(q.id) ?? q;
      let cur = progressOf(live, det.key);
      const deadline = Date.now() + (det.target + 180) * 1e3;
      let failures = 0;
      let lastLog = Date.now();
      log(`\u0421\u043C\u043E\u0442\u0440\u044E \u0432\u0438\u0434\u0435\u043E "${questName(q)}" \u2014 ${Math.ceil(det.target / 60)} \u043C\u0438\u043D \u0432 \u0440\u0435\u0430\u043B\u044C\u043D\u043E\u043C \u0442\u0435\u043C\u043F\u0435`);
      if (cur > 0) log(`  \u0443\u0436\u0435 \u043F\u0440\u043E\u0441\u043C\u043E\u0442\u0440\u0435\u043D\u043E ${Math.floor(cur)}/${det.target} \u0441`);
      while (!state.stop && cur < det.target && Date.now() < deadline) {
        const gapSec = rnd(CONFIG.videoMinGap, CONFIG.videoMaxGap) / 1e3;
        await sleep(gapSec * 1e3);
        const next = Math.min(det.target, cur + gapSec);
        try {
          const res = await apiCall("post", `/quests/${q.id}/video-progress`, {
            timestamp: Number(next.toFixed(6))
          });
          failures = 0;
          const server = res?.body?.progress?.[det.key]?.value ?? res?.body?.progress?.WATCH_VIDEO?.value;
          cur = typeof server === "number" ? Math.max(cur, server) : next;
          if (res?.body?.completed_at) break;
          if (Date.now() - lastLog >= 3e4) {
            log(`  ${Math.floor(cur)}/${det.target} \u0441`);
            lastLog = Date.now();
          }
        } catch (e) {
          if (e.message === "stopped") break;
          failures++;
          warn(`video-progress: ${e.message}`);
          if (failures >= 3) return false;
          await sleep(3e3 * failures);
        }
      }
      const done = !!freshQuest(q.id)?.userStatus?.completedAt || cur >= det.target;
      if (done) ok(`\u0412\u0438\u0434\u0435\u043E \u0433\u043E\u0442\u043E\u0432\u043E: "${questName(q)}"`);
      return done;
    }
    const PATCHED = [
      "getRunningGames",
      "getGameForPID",
      "getVisibleGame",
      "getVisibleRunningGames",
      "getRunningDiscordApplicationIds",
      "getCandidateGames"
    ];
    function pickExecutable(executables, name) {
      const clean = String(name || "Game").replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/\s+/g, " ") || "Game";
      const loose = (v) => String(v || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
      const fallback = `${clean.replace(/\s+/g, "")}.exe`;
      const win32 = (Array.isArray(executables) ? executables : []).filter((x) => x?.os === "win32" && typeof x.name === "string" && x.name.length).map((x) => x.name.replace(">", "").replace(/\\/g, "/"));
      if (!win32.length) return { exeName: fallback, relPath: `${clean}/${fallback}` };
      const rank = (n) => [
        /(^|[-_./ ])test([-_. ]|\.exe$)/i.test(n) ? "1" : "0",
        /launcher/i.test(n) ? "1" : "0",
        n.includes("/") ? "1" : "0",
        n
      ].join("");
      const chosen = win32.slice().sort((a, b) => rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : 0)[0];
      const parts = chosen.split("/").filter(Boolean);
      const exeName = parts[parts.length - 1];
      const dirs = parts.slice(0, -1);
      const alreadyRooted = dirs.length > 0 && loose(dirs[0]) === loose(clean);
      return { exeName, relPath: (alreadyRooted ? parts : [clean, ...parts]).join("/") };
    }
    function makeFakeGame(app) {
      const name = app?.name ?? "Game";
      const { exeName, relPath } = pickExecutable(app?.executables, name);
      const pid = Math.floor(rnd(2500, 12500)) * 4;
      return {
        id: app?.id ?? 0,
        name,
        icon: app?.icon ?? null,
        pid,
        pidPath: [pid],
        processName: name,
        start: Date.now(),
        exeName,
        exePath: `c:/program files/${relPath.toLowerCase()}`,
        cmdLine: `C:\\Program Files\\${relPath.replace(/\//g, "\\")}`,
        executables: [{ os: "win32", name: exeName, is_launcher: false }],
        windowHandle: 0,
        fullscreenType: 0,
        overlay: true,
        sandboxed: false,
        hidden: false,
        isLauncher: false
      };
    }
    function dispatchGames(added, removed) {
      try {
        modules().dispatcher.dispatch({
          type: "RUNNING_GAMES_CHANGE",
          added,
          removed,
          games: modules().running.getRunningGames()
        });
      } catch (e) {
        warn(`dispatch: ${e.message}`);
      }
    }
    function dispatchRpc(g) {
      try {
        modules().dispatcher.dispatch({
          type: "LOCAL_ACTIVITY_UPDATE",
          socketId: null,
          pid: g ? g.pid : 9999,
          activity: g ? {
            application_id: g.id,
            name: g.name,
            type: 0,
            details: null,
            state: null,
            timestamps: { start: g.start },
            icon: g.icon,
            assets: null
          } : null
        });
      } catch (e) {
        warn(`rpc dispatch: ${e.message}`);
      }
    }
    function patchRunning(games) {
      if (checkSafety() || state.stop) throw new Error("safety-paused");
      const S = modules().running;
      if (!S) throw new Error("RunningGameStore \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D \u2014 \u044D\u0442\u043E \u0442\u043E\u0447\u043D\u043E desktop-\u043A\u043B\u0438\u0435\u043D\u0442?");
      const real = {};
      for (const key of PATCHED) {
        if (typeof S[key] === "function") real[key] = S[key];
      }
      if (real.getRunningGames) {
        S.getRunningGames = () => [...games, ...real.getRunningGames.call(S)];
      }
      if (real.getGameForPID) {
        S.getGameForPID = (pid) => games.find((g) => g.pid === pid) ?? real.getGameForPID.call(S, pid);
      }
      if (real.getVisibleGame) {
        S.getVisibleGame = () => games[0] ?? real.getVisibleGame.call(S);
      }
      if (real.getVisibleRunningGames) {
        S.getVisibleRunningGames = () => [...games, ...real.getVisibleRunningGames.call(S)];
      }
      if (real.getCandidateGames) {
        S.getCandidateGames = () => [...games, ...real.getCandidateGames.call(S)];
      }
      if (real.getRunningDiscordApplicationIds) {
        S.getRunningDiscordApplicationIds = () => {
          const ids = real.getRunningDiscordApplicationIds.call(S);
          const ours = games.map((g) => String(g.id));
          return ids instanceof Set ? /* @__PURE__ */ new Set([...ours, ...ids]) : [...ours, ...ids ?? []];
        };
      }
      state.fakeGames = games;
      state.restoreStore = () => {
        for (const [key, fn] of Object.entries(real)) S[key] = fn;
        state.restoreStore = null;
        state.fakeGames = [];
      };
      dispatchGames(games, []);
      dispatchRpc(games[0] ?? null);
    }
    function restoreRunning() {
      const restore = state.restoreStore;
      const games = state.fakeGames;
      if (!restore) return;
      try {
        restore();
      } catch (e) {
        warn(`restore: ${e.message}`);
      }
      try {
        dispatchGames([], games);
      } catch {
      }
      try {
        dispatchRpc(null);
      } catch {
      }
    }
    async function completeGame(group) {
      const candidateIds = [];
      for (const e of group) {
        const list2 = Array.isArray(e.det.appIds) && e.det.appIds.length ? e.det.appIds : [e.det.appId];
        for (const id of list2) {
          if (id && !candidateIds.includes(String(id))) candidateIds.push(String(id));
        }
      }
      const appId = candidateIds[0] ?? group[0].det.appId;
      if (!appId) {
        for (const e of group) error(`"${e.name}": \u0432 \u043A\u043E\u043D\u0444\u0438\u0433\u0435 \u043D\u0435\u0442 application id`);
        return /* @__PURE__ */ new Set();
      }
      if (typeof DiscordNative === "undefined") {
        for (const e of group) error(`"${e.name}": \u043D\u0443\u0436\u0435\u043D desktop-\u043A\u043B\u0438\u0435\u043D\u0442, \u0432 \u0431\u0440\u0430\u0443\u0437\u0435\u0440\u0435 \u043F\u0440\u043E\u0446\u0435\u0441\u0441 \u043D\u0435 \u043F\u043E\u0434\u0441\u0442\u0430\u0432\u0438\u0442\u044C`);
        return /* @__PURE__ */ new Set();
      }
      const target = Math.max(...group.map((e) => e.det.target));
      const questIds = group.map((e) => String(e.q.id));
      const groupTitle = group.map((e) => e.name).join(", ");
      setActivity({
        type: "GAME",
        questIds,
        name: groupTitle,
        target,
        progress: Math.max(0, ...group.map((e) => Math.floor(progressOf(e.q, e.det.key)))),
        note: `\u0417\u0430\u043F\u0440\u0430\u0448\u0438\u0432\u0430\u044E \u043C\u0435\u0442\u0430\u0434\u0430\u043D\u043D\u044B\u0435 \u043F\u0440\u0438\u043B\u043E\u0436\u0435\u043D\u0438\u0439 (${candidateIds.slice(0, 6).join(", ")})\u2026`
      });
      let fetchedApps = [];
      try {
        const res = await apiCall("get", `/applications/public?application_ids=${candidateIds.slice(0, 10).join(",")}`);
        fetchedApps = Array.isArray(res.body) ? res.body : Array.isArray(res.body?.applications) ? res.body.applications : [];
      } catch (e) {
        warn(`\u041D\u0435 \u0441\u043C\u043E\u0433 \u043F\u043E\u043B\u0443\u0447\u0438\u0442\u044C \u0434\u0430\u043D\u043D\u044B\u0435 \u043F\u0440\u0438\u043B\u043E\u0436\u0435\u043D\u0438\u044F ${appId}: ${e.message}`);
      }
      const byId = new Map(fetchedApps.filter(Boolean).map((a) => [String(a.id), a]));
      const fallbackAppName = group[0].q?.config?.application?.name || group[0].name;
      const rankedIds = candidateIds.slice(0, 6).sort((a, b) => {
        const hasWinA = Array.isArray(byId.get(a)?.executables) && byId.get(a).executables.some((x) => x?.os === "win32");
        const hasWinB = Array.isArray(byId.get(b)?.executables) && byId.get(b).executables.some((x) => x?.os === "win32");
        return hasWinA === hasWinB ? 0 : hasWinA ? -1 : 1;
      });
      const fakes = rankedIds.map((id) => {
        const meta = byId.get(String(id));
        const normId = String(id) === String(group[0].det.appId) ? group[0].det.appId : id;
        return makeFakeGame({
          ...meta ?? {},
          id: normId,
          name: meta?.name || fallbackAppName
        });
      });
      const fake = fakes[0];
      const deadline = Date.now() + Math.min(
        (target + 300) * 1e3,
        CONFIG.maxMinutes * 6e4
      );
      log(
        `\u0417\u0430\u043F\u0443\u0441\u043A\u0430\u044E "${fake.name}" (${fake.exeName}, pid ${fake.pid}` + (fakes.length > 1 ? `, +${fakes.length - 1} ID` : "") + `) \u0434\u043B\u044F: ${group.map((e) => `"${e.name}"`).join(", ")}`
      );
      const groupIdSet = new Set(questIds);
      const beatProgress = /* @__PURE__ */ new Map();
      const prevProgress = new Map(
        group.map((e) => [String(e.q.id), Math.floor(progressOf(e.q, e.det.key))])
      );
      let gotBeat = false;
      let lastBeatAt = 0;
      let lastBeatErr = null;
      let consecutiveBeatFails = 0;
      let silentSince = Date.now();
      const startedGameAt = Date.now();
      let lastLoggedAt = 0;
      let lastRedispatchAt = Date.now();
      const onBeatOk = (d) => {
        const qid = String(d?.questId ?? "");
        if (!groupIdSet.has(qid)) return;
        gotBeat = true;
        lastBeatAt = Date.now();
        lastBeatErr = null;
        consecutiveBeatFails = 0;
        silentSince = Date.now();
        const member = group.find((e) => String(e.q.id) === qid);
        const prog = d?.userStatus ? progressOf({ userStatus: d.userStatus }, member?.det?.key) : null;
        if (typeof prog === "number" && prog >= 0) {
          beatProgress.set(qid, prog);
          if (member) {
            log(`\u2665 heartbeat "${member.name}": ${Math.floor(prog)}/${member.det.target} \u0441`);
          }
        } else if (member) {
          log(`\u2665 heartbeat "${member.name}" \u043F\u043E\u043B\u0443\u0447\u0435\u043D`);
        }
      };
      const onBeatFail = (d) => {
        const qid = String(d?.questId ?? "");
        if (qid && !groupIdSet.has(qid)) return;
        consecutiveBeatFails++;
        const err = d?.error ?? d;
        const status = err?.status ?? err?.httpStatus;
        const code = err?.body?.code ?? err?.code;
        const msg = err?.body?.message ?? err?.message ?? "\u043E\u0448\u0438\u0431\u043A\u0430 heartbeat";
        const text = [status ? `HTTP ${status}` : null, code ? `code ${code}` : null, msg].filter(Boolean).join(", ");
        lastBeatErr = text;
        warn(`Discord \u043D\u0435 \u0441\u043C\u043E\u0433 \u043E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u044C heartbeat (${consecutiveBeatFails}): ${text}`);
        if (gotBeat && consecutiveBeatFails < 3) {
          silentSince = Date.now();
        }
      };
      let subscribed = false;
      try {
        modules().dispatcher?.subscribe?.("QUESTS_SEND_HEARTBEAT_SUCCESS", onBeatOk);
        modules().dispatcher?.subscribe?.("QUESTS_SEND_HEARTBEAT_FAILURE", onBeatFail);
        subscribed = true;
      } catch {
      }
      patchRunning(fakes);
      const done = /* @__PURE__ */ new Set();
      try {
        while (!state.stop && Date.now() < deadline) {
          const snapshot2 = group.map((e) => {
            const id = String(e.q.id);
            const q = freshQuest(id) ?? e.q;
            const storeProg = progressOf(q, e.det.key);
            const beatProg = beatProgress.get(id) ?? 0;
            const prog = Math.max(storeProg, beatProg);
            const prev = prevProgress.get(id) ?? 0;
            const advanced = prog > prev;
            if (advanced) prevProgress.set(id, Math.floor(prog));
            return {
              e,
              q,
              prog,
              advanced,
              complete: !!q?.userStatus?.completedAt || prog >= e.det.target
            };
          });
          for (const s of snapshot2) {
            if (s.complete) done.add(String(s.e.q.id));
          }
          const anyAdvanced = snapshot2.some((s) => s.advanced);
          if (anyAdvanced) {
            gotBeat = true;
            silentSince = Date.now();
          }
          const maxProg = Math.max(0, ...snapshot2.map((s) => Math.floor(s.prog)));
          const elapsedSec = Math.floor((Date.now() - startedGameAt) / 1e3);
          if (!gotBeat && maxProg === 0 && Date.now() - lastRedispatchAt >= 35e3) {
            lastRedispatchAt = Date.now();
            for (const e of group) syncEnrolledStatus(e.q, e.q.userStatus);
            dispatchGames(fakes, []);
            dispatchRpc(fake);
          }
          const note = lastBeatErr ? `\u041E\u0448\u0438\u0431\u043A\u0430 heartbeat: ${lastBeatErr}` : gotBeat || maxProg > 0 ? `\u2665 \u0417\u0430\u0441\u0447\u0438\u0442\u044B\u0432\u0430\u0435\u0442\u0441\u044F (${fake.exeName})${lastBeatAt ? ` \xB7 \u043E\u0442\u0432\u0435\u0442 ${Math.floor((Date.now() - lastBeatAt) / 1e3)} \u0441 \u043D\u0430\u0437\u0430\u0434` : ""}` : `\u041F\u0440\u043E\u0446\u0435\u0441\u0441 ${fake.exeName} \u0437\u0430\u043F\u0443\u0449\u0435\u043D. \u0416\u0434\u0443 \u043F\u0435\u0440\u0432\u044B\u0439 heartbeat \u043E\u0442 Discord (\u043E\u0431\u044B\u0447\u043D\u043E 30\u201360 \u0441, \u043F\u0440\u043E\u0448\u043B\u043E ${elapsedSec} \u0441)\u2026`;
          setActivity({
            type: "GAME",
            questIds,
            name: groupTitle,
            target,
            progress: maxProg,
            exeName: fake.exeName,
            note,
            startedAt: startedGameAt
          });
          if (done.size === group.length) break;
          if (Date.now() - silentSince > Math.max(5, CONFIG.gameNoProgressSec || 150) * 1e3) {
            warn(`Discord \u043D\u0435 \u043F\u0440\u0438\u0441\u044B\u043B\u0430\u0435\u0442 heartbeat \u0434\u043B\u044F "${fake.name}" (${fake.exeName}).`);
            break;
          }
          if (anyAdvanced || Date.now() - lastLoggedAt >= 3e4) {
            lastLoggedAt = Date.now();
            const line = snapshot2.map((s) => `${s.e.name}: ${Math.floor(s.prog)}/${s.e.det.target}`).join(" | ");
            log(`  ${line}`);
          }
          await sleep(CONFIG.pollMs);
        }
      } finally {
        if (subscribed) {
          try {
            modules().dispatcher?.unsubscribe?.("QUESTS_SEND_HEARTBEAT_SUCCESS", onBeatOk);
          } catch {
          }
          try {
            modules().dispatcher?.unsubscribe?.("QUESTS_SEND_HEARTBEAT_FAILURE", onBeatFail);
          } catch {
          }
        }
        restoreRunning();
      }
      return done;
    }
    function buildStreamKey() {
      try {
        const ownerId = modules().users?.getCurrentUser?.()?.id;
        if (!ownerId) return null;
        const dm = modules().channels?.getSortedPrivateChannels?.()?.[0]?.id;
        if (dm) return `call:${dm}:${ownerId}`;
        for (const g of Object.values(modules().guilds?.getAllGuilds?.() ?? {})) {
          const vc = g?.VOCAL?.[0]?.channel;
          const guildId = vc?.guild_id ?? g?.id;
          if (vc?.id && guildId) return `guild:${guildId}:${vc.id}:${ownerId}`;
        }
        return `call:${ownerId}:${ownerId}`;
      } catch {
      }
      return null;
    }
    async function completeActivity(q, det) {
      const key = buildStreamKey();
      if (!key) {
        error(`"${questName(q)}": \u043D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0441\u0444\u043E\u0440\u043C\u0438\u0440\u043E\u0432\u0430\u0442\u044C stream_key \u0434\u043B\u044F \u0430\u043A\u0442\u0438\u0432\u043D\u043E\u0441\u0442\u0438.`);
        return false;
      }
      const beat = {
        stream_key: key,
        application_id: String(det.appId ?? ""),
        terminal: false
      };
      let cur = progressOf(freshQuest(q.id) ?? q, det.key);
      let silent = 0;
      const startedActAt = Date.now();
      const deadline = Date.now() + Math.min(
        (det.target + 180) * 1e3,
        CONFIG.maxMinutes * 6e4
      );
      log(`Activity "${questName(q)}" \u0447\u0435\u0440\u0435\u0437 ${key.split(":")[0]}-\u043A\u0430\u043D\u0430\u043B (best-effort)`);
      while (!state.stop && cur < det.target && Date.now() < deadline) {
        setActivity({
          type: "ACTIVITY",
          questIds: [String(q.id)],
          name: questName(q),
          progress: Math.floor(cur),
          target: det.target,
          note: `\u041E\u0442\u043F\u0440\u0430\u0432\u043B\u044F\u044E activity heartbeat (${Math.floor(cur)}/${det.target} \u0441)\u2026`,
          startedAt: startedActAt
        });
        try {
          const res = await apiCall("post", `/quests/${q.id}/heartbeat`, beat);
          const reported = res?.body?.progress?.[det.key]?.value ?? res?.body?.progress?.PLAY_ACTIVITY?.value ?? res?.body?.progress?.PLAY_ON_DESKTOP?.value;
          if (typeof reported === "number" && reported > cur) {
            cur = reported;
            silent = 0;
            log(`\u2665 activity "${questName(q)}": ${Math.floor(cur)}/${det.target} \u0441`);
          } else if (++silent >= 4) {
            warn(`Discord \u043D\u0435 \u043D\u0430\u0447\u0438\u0441\u043B\u044F\u0435\u0442 activity-\u043F\u0440\u043E\u0433\u0440\u0435\u0441\u0441 \u0434\u043B\u044F "${questName(q)}".`);
            return false;
          }
          if (cur >= det.target || res?.body?.completed_at) {
            try {
              await apiCall("post", `/quests/${q.id}/heartbeat`, { ...beat, terminal: true });
            } catch {
            }
            ok(`Activity \u0433\u043E\u0442\u043E\u0432: "${questName(q)}"`);
            return true;
          }
        } catch (e) {
          if (e.message === "stopped") break;
          warn(`heartbeat: ${e.message}`);
          silent++;
          if (silent >= 4) return false;
        }
        await sleep(rnd(19e3, 22e3));
      }
      return !!freshQuest(q.id)?.userStatus?.completedAt || cur >= det.target;
    }
    function parseDiscordSaysDetail(rawBody, fallback) {
      let parsed = rawBody;
      if (typeof rawBody === "string") {
        try {
          parsed = JSON.parse(rawBody);
        } catch {
        }
      }
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.trim();
        if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error.trim();
      } else if (typeof parsed === "string" && parsed.trim()) {
        return parsed.trim().slice(0, 200);
      }
      return fallback;
    }
    async function postDiscordSays(stage, opts) {
      if (checkSafety() || state.stop) throw new Error("safety-paused");
      const nativeHelper = window.VencordNative?.pluginHelpers?.QuestFarmer ?? window.VencordNative?.pluginHelpers?.OrionQuests;
      if (nativeHelper) {
        const fn = stage === "authorize" ? nativeHelper.discordsaysAuthorize : nativeHelper.discordsaysProgress;
        if (typeof fn === "function") {
          try {
            const res = await fn(opts);
            if (res && typeof res.status === "number") {
              if (res.ok && res.status >= 200 && res.status < 300) return res;
              if (res.status > 0) {
                const err = new Error(parseDiscordSaysDetail(res.body, `discordsays ${stage} HTTP ${res.status}`));
                err.status = res.status;
                err.body = res.body;
                throw err;
              }
            }
          } catch (e) {
            if (e?.status) throw e;
          }
        }
      }
      const url = stage === "authorize" ? `https://${opts.appId}.discordsays.com/.proxy/acf/authorize` : `https://${opts.appId}.discordsays.com/.proxy/acf/quest/progress`;
      const headers = stage === "authorize" ? {
        "Content-Type": "application/json",
        "X-Auth-Token": "",
        "X-Discord-Quest-ID": String(opts.questId),
        Referer: opts.referrer
      } : {
        "Content-Type": "application/json",
        "X-Auth-Token": opts.token,
        "X-Discord-Quest-ID": String(opts.questId),
        Referer: opts.referrer
      };
      const body = stage === "authorize" ? JSON.stringify({ code: opts.authCode }) : JSON.stringify({ progress: opts.target, quest_id: String(opts.questId) });
      try {
        const r2 = await fetch("http://127.0.0.1:43210/proxy", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Orion-Relay": "1" },
          body: JSON.stringify({ url, headers, body })
        });
        const text2 = await r2.text();
        if (r2.ok) {
          let upstream;
          try {
            upstream = JSON.parse(text2);
          } catch {
          }
          if (!upstream || typeof upstream.status !== "number" || typeof upstream.body !== "string") {
            const err3 = new Error("discordsays relay: \u043D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u0444\u043E\u0440\u043C\u0430\u0442 \u043E\u0442\u0432\u0435\u0442\u0430 (\u043E\u0436\u0438\u0434\u0430\u043B status/body)");
            err3.status = 502;
            throw err3;
          }
          if (upstream.status >= 200 && upstream.status < 300) {
            return { ok: true, status: upstream.status, body: upstream.body };
          }
          const err2 = new Error(parseDiscordSaysDetail(upstream.body, `discordsays ${stage} HTTP ${upstream.status}`));
          err2.status = upstream.status || 502;
          try {
            err2.body = JSON.parse(upstream.body);
          } catch {
            err2.body = upstream.body;
          }
          throw err2;
        }
        const err = new Error(parseDiscordSaysDetail(text2, `discordsays ${stage} HTTP ${r2.status}`));
        err.status = r2.status;
        err.body = text2;
        throw err;
      } catch (e) {
        if (e?.status) throw e;
      }
      const r = await fetch(url, {
        method: "POST",
        headers,
        body,
        referrer: opts.referrer,
        referrerPolicy: "unsafe-url",
        mode: "cors",
        credentials: "omit"
      });
      const text = await r.text();
      if (!r.ok) {
        const err = new Error(parseDiscordSaysDetail(text, `discordsays ${stage} HTTP ${r.status}`));
        err.status = r.status;
        err.body = text;
        throw err;
      }
      return { ok: true, status: r.status, body: text };
    }
    async function completeAchievement(q, det) {
      const name = questName(q);
      const questId = String(q.id);
      const appId = String(det.appId || q.config?.application?.id || "");
      if (!/^\d+$/.test(appId) || !/^\d+$/.test(questId)) {
        error(`"${name}": \u043D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 application/quest id (${appId} / ${questId}).`);
        return false;
      }
      const startedAt = Date.now();
      setActivity({
        type: "ACHIEVEMENT",
        questIds: [questId],
        name,
        progress: 0,
        target: det.target,
        note: "\u041F\u0440\u043E\u0432\u0435\u0440\u044F\u044E \u0442\u0435\u043A\u0443\u0449\u0438\u0435 OAuth-\u0440\u0430\u0437\u0440\u0435\u0448\u0435\u043D\u0438\u044F \u043F\u0435\u0440\u0435\u0434 \u0437\u0430\u043F\u0443\u0441\u043A\u043E\u043C \u0430\u043A\u0442\u0438\u0432\u043D\u043E\u0441\u0442\u0438\u2026",
        startedAt
      });
      let preGrantIds = null;
      try {
        const before = await apiCall("get", "/oauth2/tokens");
        const list2 = Array.isArray(before?.body) ? before.body : [];
        preGrantIds = new Set(
          list2.filter((tk) => String(tk?.application?.id) === appId && tk?.id).map((tk) => tk.id)
        );
      } catch (e) {
        warn(`"${name}": \u043D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u043E\u043B\u0443\u0447\u0438\u0442\u044C \u0441\u043F\u0438\u0441\u043E\u043A OAuth-\u0442\u043E\u043A\u0435\u043D\u043E\u0432 (${e.message}).`);
        return false;
      }
      let authorizationStarted = false;
      try {
        log(`\u0412\u044B\u043F\u043E\u043B\u043D\u044F\u044E ACHIEVEMENT-\u043A\u0432\u0435\u0441\u0442 "${name}" \u0447\u0435\u0440\u0435\u0437 Discord Says (target=${det.target})\u2026`);
        setActivity({
          type: "ACHIEVEMENT",
          questIds: [questId],
          name,
          progress: 0,
          target: det.target,
          note: "\u0410\u0432\u0442\u043E\u0440\u0438\u0437\u0443\u044E \u0430\u043A\u0442\u0438\u0432\u043D\u043E\u0441\u0442\u044C \u0447\u0435\u0440\u0435\u0437 /oauth2/authorize\u2026",
          startedAt
        });
        authorizationStarted = true;
        const authRes = await apiCall(
          "post",
          `/oauth2/authorize?response_type=code&client_id=${encodeURIComponent(appId)}&scope=${encodeURIComponent("identify applications.commands applications.entitlements")}`,
          {
            permissions: "0",
            authorize: true,
            integration_type: 1,
            location_context: { guild_id: "10000", channel_id: "10000", channel_type: 1e4 }
          },
          {
            query: {
              response_type: "code",
              client_id: appId,
              scope: "identify applications.commands applications.entitlements"
            }
          }
        );
        if (state.stop) return false;
        const location2 = authRes?.body?.location;
        if (!location2) throw new Error("\u0441\u0435\u0440\u0432\u0435\u0440 \u043D\u0435 \u0432\u0435\u0440\u043D\u0443\u043B location \u0438\u0437 /oauth2/authorize");
        const authCode = new URL(location2).searchParams.get("code");
        if (!authCode) throw new Error("\u043D\u0435\u0442 code \u0432 location /oauth2/authorize");
        setActivity({
          type: "ACHIEVEMENT",
          questIds: [questId],
          name,
          progress: 0,
          target: det.target,
          note: "\u041F\u043E\u043B\u0443\u0447\u0430\u044E proxy ticket \u0434\u043B\u044F \u0441\u0435\u0441\u0441\u0438\u0438 \u0430\u043A\u0442\u0438\u0432\u043D\u043E\u0441\u0442\u0438\u2026",
          startedAt
        });
        const ticketRes = await apiCall("post", `/applications/${appId}/proxy-tickets`, {});
        if (state.stop) return false;
        const proxyTicket = ticketRes?.body?.ticket;
        if (!proxyTicket) throw new Error("\u043D\u0435 \u043F\u043E\u043B\u0443\u0447\u0435\u043D proxy ticket");
        const referrer = `https://${appId}.discordsays.com/?instance_id=example-cl-instance&platform=desktop&discord_proxy_ticket=${encodeURIComponent(proxyTicket)}`;
        setActivity({
          type: "ACHIEVEMENT",
          questIds: [questId],
          name,
          progress: Math.max(1, Math.floor(det.target / 2)),
          target: det.target,
          note: "\u041E\u0442\u043A\u0440\u044B\u0432\u0430\u044E \u0441\u0435\u0441\u0441\u0438\u044E \u0432 discordsays.com (.proxy/acf/authorize)\u2026",
          startedAt
        });
        const dsAuthRes = await postDiscordSays("authorize", {
          appId,
          questId,
          authCode,
          referrer
        });
        if (state.stop) return false;
        let dsToken = null;
        try {
          dsToken = JSON.parse(dsAuthRes.body)?.token;
        } catch {
        }
        if (!dsToken) throw new Error("\u043D\u0435 \u043F\u043E\u043B\u0443\u0447\u0435\u043D \u0442\u043E\u043A\u0435\u043D \u0438\u0437 .proxy/acf/authorize");
        setActivity({
          type: "ACHIEVEMENT",
          questIds: [questId],
          name,
          progress: det.target,
          target: det.target,
          note: `\u041E\u0442\u043F\u0440\u0430\u0432\u043B\u044F\u044E \u043F\u0440\u043E\u0433\u0440\u0435\u0441\u0441 (${det.target}/${det.target}) \u0432 .proxy/acf/quest/progress\u2026`,
          startedAt
        });
        await postDiscordSays("progress", {
          appId,
          questId,
          token: dsToken,
          target: det.target,
          referrer
        });
        const completedIso = (/* @__PURE__ */ new Date()).toISOString();
        try {
          for (const target of [q, freshQuest(questId)]) {
            if (!target) continue;
            target.userStatus = target.userStatus || { questId };
            target.userStatus.completedAt = target.userStatus.completedAt || completedIso;
            target.userStatus.progress = target.userStatus.progress || {};
            target.userStatus.progress[det.key] = {
              ...target.userStatus.progress[det.key] || {},
              value: det.target
            };
          }
        } catch {
        }
        await sleep(1200);
        ok(`\u0410\u0447\u0438\u0432\u043A\u0430 \u0432 \u0430\u043A\u0442\u0438\u0432\u043D\u043E\u0441\u0442\u0438 \u0433\u043E\u0442\u043E\u0432\u0430: "${name}"`);
        return true;
      } catch (e) {
        const code = e?.body?.code ?? e?.code;
        if (code === 50165) {
          warn(`"${name}": \u0430\u043A\u0442\u0438\u0432\u043D\u043E\u0441\u0442\u044C \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0430 \u043D\u0430 \u0430\u043A\u043A\u0430\u0443\u043D\u0442\u0435 (\u0432\u043E\u0437\u0440\u0430\u0441\u0442\u043D\u043E\u0435 \u043E\u0433\u0440\u0430\u043D\u0438\u0447\u0435\u043D\u0438\u0435 \u0438\u043B\u0438 \u0443\u0434\u0430\u043B\u0435\u043D\u0430, \u043A\u043E\u0434 50165).`);
          state.lastError = `"${name}": \u0432\u043E\u0437\u0440\u0430\u0441\u0442\u043D\u043E\u0435 \u043E\u0433\u0440\u0430\u043D\u0438\u0447\u0435\u043D\u0438\u0435 / \u0430\u043A\u0442\u0438\u0432\u043D\u043E\u0441\u0442\u044C \u0443\u0434\u0430\u043B\u0435\u043D\u0430 (50165)`;
          return false;
        }
        warn(`"${name}" (ACHIEVEMENT): ${e?.message ?? e}`);
        state.lastError = `"${name}": ${e?.message ?? e}`;
        return false;
      } finally {
        if (authorizationStarted && preGrantIds) {
          try {
            const after = await apiCall("get", "/oauth2/tokens", void 0, { stoppable: false });
            const list2 = Array.isArray(after?.body) ? after.body : [];
            for (const tk of list2) {
              if (String(tk?.application?.id) === appId && tk?.id && !preGrantIds.has(tk.id)) {
                await apiCall("del", `/oauth2/tokens/${tk.id}`, void 0, { stoppable: false });
                log(`\u041E\u0442\u043E\u0437\u0432\u0430\u043D\u043E \u0432\u0440\u0435\u043C\u0435\u043D\u043D\u043E\u0435 OAuth-\u0440\u0430\u0437\u0440\u0435\u0448\u0435\u043D\u0438\u0435 \u0434\u043B\u044F "${name}" (${tk.id}).`);
              }
            }
          } catch (e) {
            warn(`\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043E\u0442\u043E\u0437\u0432\u0430\u0442\u044C \u0432\u0440\u0435\u043C\u0435\u043D\u043D\u044B\u0439 OAuth-\u0442\u043E\u043A\u0435\u043D (${appId}): ${e?.message ?? e}`);
          }
        }
      }
    }
    function markQuestClaimed(q, claimedIso) {
      const iso = claimedIso || (/* @__PURE__ */ new Date()).toISOString();
      try {
        for (const target of [q, freshQuest(q?.id)]) {
          if (!target) continue;
          target.userStatus = target.userStatus || { questId: String(q.id) };
          target.userStatus.claimedAt = iso;
        }
      } catch {
      }
    }
    async function claim(q) {
      try {
        const res = await apiCall("post", `/quests/${q.id}/claim-reward`, {
          platform: 0,
          location: 11,
          is_targeted: false,
          metadata_sealed: null,
          traffic_metadata_sealed: sealedFor(q)
        });
        if (res?.body?.claimed_at) {
          markQuestClaimed(q, res.body.claimed_at);
          return true;
        }
        return false;
      } catch (e) {
        const msg = String(e?.message || "");
        if (msg.includes("\u0443\u0436\u0435 \u043F\u043E\u043B\u0443\u0447\u0438\u043B \u043D\u0430\u0433\u0440\u0430\u0434\u0443") || msg.toLowerCase().includes("already claimed")) {
          markQuestClaimed(q);
          return true;
        }
        throw e;
      }
    }
    async function claimAll() {
      if (checkSafety()) return { claimed: 0, reason: "safety-paused" };
      try {
        modules();
      } catch (e) {
        error(e.message);
        return;
      }
      const targets = allQuests().filter((q) => {
        const det = detectTask(q.config);
        return isCompleted(q, det) && !isClaimed(q);
      });
      if (!targets.length) {
        log("\u041D\u0435\u0447\u0435\u0433\u043E \u0437\u0430\u0431\u0438\u0440\u0430\u0442\u044C.");
        return;
      }
      let claimed = 0;
      let orbs = 0;
      for (const q of targets) {
        try {
          log(`\u0417\u0430\u0431\u0438\u0440\u0430\u044E "${questName(q)}"...`);
          if (await claim(q)) {
            claimed++;
            orbs += questOrbs(q.config)?.orbs ?? 0;
            ok(`\u0417\u0430\u0431\u0440\u0430\u043D\u043E: "${questName(q)}"`);
          } else {
            warn(`"${questName(q)}": \u0441\u0435\u0440\u0432\u0435\u0440 \u043D\u0435 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u043B. \u041E\u0442\u043A\u0440\u043E\u0439 \u043A\u0432\u0435\u0441\u0442\u044B \u0432 UI \u2014 \u0432\u043E\u0437\u043C\u043E\u0436\u043D\u043E, \u043A\u0430\u043F\u0447\u0430.`);
          }
        } catch (e) {
          warn(`"${questName(q)}": ${e.message} (\u043A\u0430\u043F\u0447\u0430/\u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u0435 \u0432 UI)`);
        }
        await sleep(rnd(1500, 3e3));
      }
      ok(`\u0418\u0442\u043E\u0433\u043E \u0437\u0430\u0431\u0440\u0430\u043D\u043E: ${claimed}, ~${orbs} Orbs`);
    }
    async function run(opts = {}) {
      if (state.runBusy) return { ran: false, reason: "busy" };
      state.runBusy = true;
      try {
        return await executeRun(opts);
      } finally {
        state.runBusy = false;
        state.runIds = [];
        if (!state.schedBusy) drainQueue();
      }
    }
    async function executeRun(opts = {}) {
      if (checkSafety()) return { ran: false, reason: "safety-paused" };
      if (state.running) {
        warn("\u0423\u0436\u0435 \u0432\u044B\u043F\u043E\u043B\u043D\u044F\u0435\u0442\u0441\u044F. DQ.stop() \u2014 \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u0442\u044C.");
        return { ran: false, reason: "busy" };
      }
      Object.assign(CONFIG, opts);
      try {
        modules();
      } catch (e) {
        error(e.message);
        return { ran: false, reason: "not-ready" };
      }
      if (checkSafety()) return { ran: false, reason: "safety-paused" };
      const suspendedUntil = modules().quests?.questAccessSuspendedUntil;
      if (modules().quests?.isQuestAccessSuspended === true || suspendedUntil && new Date(suspendedUntil).getTime() > Date.now()) {
        const until = suspendedUntil ? new Date(suspendedUntil).toLocaleString() : "\u0432\u0440\u0435\u043C\u0435\u043D\u043D\u043E";
        error(`Discord \u043F\u0440\u0438\u043E\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u043B \u0434\u043E\u0441\u0442\u0443\u043F \u043A \u043A\u0432\u0435\u0441\u0442\u0430\u043C (${until}).`);
        return { ran: false, reason: "blocked", blockedUntil: suspendedUntil || Date.now() + 36e5 };
      }
      const blockedUntil = modules().quests?.questEnrollmentBlockedUntil;
      if (blockedUntil && new Date(blockedUntil).getTime() > Date.now()) {
        error(
          `Discord \u0437\u0430\u043F\u0440\u0435\u0442\u0438\u043B \u043F\u0440\u0438\u043D\u044F\u0442\u0438\u0435 \u043A\u0432\u0435\u0441\u0442\u043E\u0432 \u0434\u043E ${new Date(blockedUntil).toLocaleString()}. \u042D\u0442\u043E \u0443\u0436\u0435 \u0441\u0430\u043D\u043A\u0446\u0438\u044F \u2014 \u043D\u0435 \u043F\u044B\u0442\u0430\u0439\u0441\u044F \u043E\u0431\u043E\u0439\u0442\u0438, \u0431\u0443\u0434\u0435\u0442 \u0445\u0443\u0436\u0435.`
        );
        return { ran: false, reason: "blocked", blockedUntil };
      }
      state.running = true;
      state.stop = false;
      state.processed.clear();
      state.enrolledAt.clear();
      state.lastError = null;
      setActivity({
        type: "INIT",
        questIds: [],
        name: "\u041F\u0440\u043E\u0432\u0435\u0440\u044F\u044E \u0441\u043F\u0438\u0441\u043E\u043A \u043A\u0432\u0435\u0441\u0442\u043E\u0432\u2026",
        progress: 0,
        target: 0,
        note: "\u041E\u0442\u0431\u0438\u0440\u0430\u044E \u0430\u043A\u0442\u0438\u0432\u043D\u044B\u0435 \u043A\u0432\u0435\u0441\u0442\u044B"
      });
      const stats = { done: 0, failed: 0, skipped: 0, orbs: 0, stopped: false };
      const all = allQuests().map((q) => {
        const det = detectTask(q.config);
        return {
          q,
          det,
          name: questName(q),
          orbs: questOrbs(q.config)?.orbs ?? 0,
          completed: isCompleted(q, det)
        };
      });
      const onlyId = opts.onlyQuestId ? String(opts.onlyQuestId) : null;
      const runnable = [];
      for (const e of all) {
        if (onlyId && String(e.q.id) !== onlyId) continue;
        if (e.completed) continue;
        if (BLACKLISTED_QUESTS.has(String(e.q.id))) {
          warn(`\u041F\u0440\u043E\u043F\u0443\u0441\u043A\u0430\u044E "${e.name}" (\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u044B\u0439 \u0431\u0430\u0433 \u0441 enroll).`);
          stats.skipped++;
          continue;
        }
        if (!e.det) {
          warn(`\u041F\u0440\u043E\u043F\u0443\u0441\u043A\u0430\u044E "${e.name}": \u043D\u0435\u0442 \u043F\u043E\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u0435\u043C\u043E\u0433\u043E \u0442\u0438\u043F\u0430 \u0437\u0430\u0434\u0430\u043D\u0438\u044F.`);
          stats.skipped++;
          continue;
        }
        if (!onlyId && !CONFIG.types.includes(e.det.type)) {
          warn(`\u041F\u0440\u043E\u043F\u0443\u0441\u043A\u0430\u044E "${e.name}": \u0442\u0438\u043F ${e.det.type} \u043D\u0435 \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0437\u0438\u0440\u0443\u0435\u0442\u0441\u044F.`);
          stats.skipped++;
          continue;
        }
        if (e.det.type === "STREAM") {
          warn(`\u041F\u0440\u043E\u043F\u0443\u0441\u043A\u0430\u044E "${e.name}": \u0434\u043B\u044F STREAM \u043D\u0443\u0436\u0435\u043D \u0440\u0435\u0430\u043B\u044C\u043D\u044B\u0439 Go Live \u0438 \u0437\u0440\u0438\u0442\u0435\u043B\u044C.`);
          stats.skipped++;
          continue;
        }
        if ((e.det.type === "GAME" || e.det.type === "ACTIVITY" || e.det.type === "ACHIEVEMENT") && !e.det.appId) {
          warn(`\u041F\u0440\u043E\u043F\u0443\u0441\u043A\u0430\u044E "${e.name}": \u0432 \u043A\u043E\u043D\u0444\u0438\u0433\u0435 \u043D\u0435\u0442 application id.`);
          stats.skipped++;
          continue;
        }
        if (!onlyId && CONFIG.onlyOrbs && !e.orbs) {
          stats.skipped++;
          continue;
        }
        if (!e.det.target) {
          warn(`\u041F\u0440\u043E\u043F\u0443\u0441\u043A\u0430\u044E "${e.name}": \u043D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 target (${e.det.target}).`);
          stats.skipped++;
          continue;
        }
        runnable.push(e);
      }
      state.runIds = runnable.map((e) => String(e.q.id));
      if (!runnable.length) {
        log("\u041D\u0435\u0442 \u043A\u0432\u0435\u0441\u0442\u043E\u0432, \u043A\u043E\u0442\u043E\u0440\u044B\u0435 \u043C\u043E\u0436\u043D\u043E \u0432\u044B\u043F\u043E\u043B\u043D\u0438\u0442\u044C.");
        setActivity(null);
        state.running = false;
        return { ran: false, reason: "empty" };
      }
      log(`\u0412 \u0440\u0430\u0431\u043E\u0442\u0443: ${runnable.length}. \u0412\u0441\u0451 \u0438\u0434\u0451\u0442 \u0432 \u0440\u0435\u0430\u043B\u044C\u043D\u043E\u043C \u0432\u0440\u0435\u043C\u0435\u043D\u0438, \u043D\u0435 \u0437\u0430\u043A\u0440\u044B\u0432\u0430\u0439 \u043A\u043B\u0438\u0435\u043D\u0442.`);
      log("\u041E\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u0442\u044C: DQ.stop()");
      try {
        for (const e of runnable) {
          if (state.stop) break;
          if (state.processed.has(String(e.q.id))) continue;
          try {
            if (e.det.type === "GAME") {
              const group = e.det.appId ? runnable.filter(
                (x) => x.det.type === "GAME" && String(x.det.appId) === String(e.det.appId) && !state.processed.has(String(x.q.id))
              ) : [e];
              for (const x of group) state.processed.add(String(x.q.id));
              const ready = [];
              for (const x of group) {
                if (state.stop) break;
                if (x.q.userStatus?.enrolledAt || state.enrolledAt.has(String(x.q.id))) {
                  ready.push(x);
                } else if (CONFIG.autoEnroll) {
                  setActivity({
                    type: "ENROLL",
                    questIds: [String(x.q.id)],
                    name: x.name,
                    progress: 0,
                    target: x.det.target,
                    note: "\u041F\u0440\u0438\u043D\u0438\u043C\u0430\u044E \u043A\u0432\u0435\u0441\u0442 \u0447\u0435\u0440\u0435\u0437 API Discord\u2026"
                  });
                  try {
                    await enroll(x.q);
                    ready.push(x);
                  } catch (err) {
                    warn(`enroll "${x.name}": ${err.message}`);
                    state.lastError = `enroll "${x.name}": ${err.message}`;
                    stats.failed++;
                  }
                } else {
                  warn(`"${x.name}" \u043D\u0435 \u043F\u0440\u0438\u043D\u044F\u0442, \u0430 autoEnroll \u0432\u044B\u043A\u043B\u044E\u0447\u0435\u043D \u2014 \u043F\u0440\u043E\u043F\u0443\u0441\u043A\u0430\u044E.`);
                  stats.skipped++;
                }
              }
              if (!ready.length || state.stop) continue;
              const done2 = await completeGame(ready);
              for (const x of ready) {
                let finished = done2.has(String(x.q.id)) || isCompleted(freshQuest(x.q.id) ?? x.q, x.det);
                if (!finished && !state.stop && x.det.canActivityFallback) {
                  log(`\u041F\u0440\u043E\u0431\u0443\u044E \u0440\u0435\u0437\u0435\u0440\u0432\u043D\u044B\u0439 activity-heartbeat \u0434\u043B\u044F "${x.name}"\u2026`);
                  finished = await completeActivity(x.q, x.det);
                }
                if (finished || isCompleted(freshQuest(x.q.id) ?? x.q, x.det)) {
                  stats.done++;
                  stats.orbs += x.orbs;
                  if (state.sched.running) {
                    persistSched({ doneInSession: (state.sched.doneInSession || 0) + 1 });
                  }
                  ok(`\u0413\u043E\u0442\u043E\u0432\u043E: "${x.name}"`);
                  if (CONFIG.autoClaim) {
                    try {
                      if (await claim(x.q)) ok(`\u041D\u0430\u0433\u0440\u0430\u0434\u0430: "${x.name}"`);
                    } catch (err) {
                      warn(`claim "${x.name}": ${err.message}`);
                    }
                  }
                } else if (!state.stop) {
                  stats.failed++;
                  state.lastError = `"${x.name}": Discord \u043D\u0435 \u0437\u0430\u0441\u0447\u0438\u0442\u0430\u043B \u0438\u0433\u0440\u0443 (\u043D\u0435\u0442 heartbeat)`;
                  warn(`\u041D\u0435 \u0432\u044B\u0448\u043B\u043E: "${x.name}"`);
                }
              }
              continue;
            }
            state.processed.add(String(e.q.id));
            if (!e.q.userStatus?.enrolledAt && !state.enrolledAt.has(String(e.q.id))) {
              if (!CONFIG.autoEnroll) {
                warn(`"${e.name}" \u043D\u0435 \u043F\u0440\u0438\u043D\u044F\u0442, \u0430 autoEnroll \u0432\u044B\u043A\u043B\u044E\u0447\u0435\u043D \u2014 \u043F\u0440\u043E\u043F\u0443\u0441\u043A\u0430\u044E.`);
                stats.skipped++;
                continue;
              }
              setActivity({
                type: "ENROLL",
                questIds: [String(e.q.id)],
                name: e.name,
                progress: 0,
                target: e.det.target,
                note: "\u041F\u0440\u0438\u043D\u0438\u043C\u0430\u044E \u043A\u0432\u0435\u0441\u0442 \u0447\u0435\u0440\u0435\u0437 API Discord\u2026"
              });
              try {
                await enroll(e.q);
              } catch (err) {
                warn(`enroll "${e.name}": ${err.message}`);
                state.lastError = `enroll "${e.name}": ${err.message}`;
                stats.failed++;
                continue;
              }
            }
            let done = false;
            setActivity({
              type: e.det.type,
              questIds: [String(e.q.id)],
              name: e.name,
              key: e.det.key,
              target: e.det.target,
              note: e.det.type === "VIDEO" ? "\u041E\u0442\u043F\u0440\u0430\u0432\u043B\u044F\u044E \u043F\u0440\u043E\u0433\u0440\u0435\u0441\u0441 \u043F\u0440\u043E\u0441\u043C\u043E\u0442\u0440\u0430 \u0432 \u0440\u0435\u0430\u043B\u044C\u043D\u043E\u043C \u0442\u0435\u043C\u043F\u0435\u2026" : e.det.type === "ACHIEVEMENT" ? "\u0412\u044B\u043F\u043E\u043B\u043D\u044F\u044E \u0430\u043A\u0442\u0438\u0432\u043D\u043E\u0441\u0442\u044C \u0447\u0435\u0440\u0435\u0437 Discord Says\u2026" : "\u041E\u0442\u043F\u0440\u0430\u0432\u043B\u044F\u044E heartbeat \u0430\u043A\u0442\u0438\u0432\u043D\u043E\u0441\u0442\u0438\u2026"
            });
            if (e.det.type === "VIDEO") done = await completeVideo(e.q, e.det);
            else if (e.det.type === "ACTIVITY") done = await completeActivity(e.q, e.det);
            else if (e.det.type === "ACHIEVEMENT") done = await completeAchievement(e.q, e.det);
            else {
              warn(`\u0422\u0438\u043F ${e.det.type} \u043D\u0435 \u0440\u0435\u0430\u043B\u0438\u0437\u043E\u0432\u0430\u043D.`);
            }
            if (done || isCompleted(freshQuest(e.q.id) ?? e.q, e.det)) {
              stats.done++;
              stats.orbs += e.orbs;
              if (state.sched.running) {
                persistSched({ doneInSession: (state.sched.doneInSession || 0) + 1 });
              }
              ok(`\u0413\u043E\u0442\u043E\u0432\u043E: "${e.name}"`);
              if (CONFIG.autoClaim) {
                try {
                  if (await claim(e.q)) ok(`\u041D\u0430\u0433\u0440\u0430\u0434\u0430: "${e.name}"`);
                } catch (err) {
                  warn(`claim "${e.name}": ${err.message}`);
                }
              }
            } else if (!state.stop) {
              stats.failed++;
              state.lastError = `"${e.name}": \u043F\u0440\u043E\u0433\u0440\u0435\u0441\u0441 \u043D\u0435 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0451\u043D`;
              warn(`\u041D\u0435 \u0432\u044B\u0448\u043B\u043E: "${e.name}"`);
            }
          } catch (err) {
            if (err.message === "stopped" || err.message === "safety-paused") break;
            stats.failed++;
            state.lastError = `"${e.name}": ${err.message}`;
            error(`"${e.name}": ${err.message}`);
          }
        }
      } finally {
        stats.stopped = state.stop;
        setActivity(null);
        restoreRunning();
        state.running = false;
        state.stop = false;
      }
      log(
        `\u0418\u0442\u043E\u0433: \u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043D\u043E ${stats.done}, \u043E\u0448\u0438\u0431\u043E\u043A ${stats.failed}, \u043F\u0440\u043E\u043F\u0443\u0449\u0435\u043D\u043E ${stats.skipped}` + (stats.orbs ? `, ~${stats.orbs} Orbs` : "") + "."
      );
      if (CONFIG.autoClaim && !stats.stopped) await claimAll();
      return { ran: true, ...stats };
    }
    function stop() {
      state.queue.length = 0;
      state.queueOwner = null;
      if (!state.running) {
        log("\u041D\u0438\u0447\u0435\u0433\u043E \u043D\u0435 \u0432\u044B\u043F\u043E\u043B\u043D\u044F\u0435\u0442\u0441\u044F.");
        return;
      }
      state.stop = true;
      restoreRunning();
      warn("\u041E\u0441\u0442\u0430\u043D\u0430\u0432\u043B\u0438\u0432\u0430\u044E\u0441\u044C...");
    }
    function inspect(target) {
      try {
        modules();
      } catch (e) {
        error(e.message);
        return;
      }
      const all = allQuests();
      const q = typeof target === "number" ? all[target - 1] : all.find((x) => String(x.id) === String(target) || questName(x) === target);
      if (!q) {
        error("\u041D\u0435 \u043D\u0430\u0448\u0451\u043B \u043A\u0432\u0435\u0441\u0442. \u0423\u043A\u0430\u0436\u0438 \u043D\u043E\u043C\u0435\u0440 \u0438\u0437 DQ.list() \u0438\u043B\u0438 id.");
        return;
      }
      console.log(questName(q), q.id);
      console.log(JSON.stringify(q.config, null, 2));
      return q;
    }
    const SCHED_KEY = "DQ_FARM_STATE_V1";
    const HOUR = 3600 * 1e3;
    function persistSched(patch = {}) {
      Object.assign(state.sched, { schema: 2 }, patch);
      try {
        localStorage2.setItem(SCHED_KEY, JSON.stringify(state.sched));
      } catch {
      }
    }
    function loadSched() {
      let saved = {};
      try {
        saved = JSON.parse(localStorage2.getItem(SCHED_KEY) || "{}") || {};
      } catch {
        saved = {};
      }
      state.sched = {
        schema: 2,
        lastEnd: Number(saved.lastEnd) || 0,
        startedAt: Number(saved.startedAt) || 0,
        lastBeat: Number(saved.lastBeat) || 0,
        running: !!saved.running,
        doneInSession: Number(saved.doneInSession) || 0,
        nextRetry: Number(saved.nextRetry) || 0,
        failStreak: Number(saved.failStreak) || 0,
        lastResult: saved.lastResult ?? null
      };
      if (saved.schema !== 2 && !(saved.lastResult?.done > 0)) {
        state.sched.lastEnd = 0;
        state.sched.nextRetry = 0;
        state.sched.failStreak = 0;
      }
      if (state.sched.running) {
        const end = Math.min(
          Date.now(),
          state.sched.lastBeat || state.sched.startedAt || Date.now()
        );
        const hadDone = state.sched.doneInSession > 0;
        state.sched.running = false;
        state.sched.startedAt = 0;
        state.sched.nextRetry = 0;
        state.sched.doneInSession = 0;
        if (hadDone) {
          state.sched.lastEnd = end;
          warn(`\u041F\u0440\u043E\u0448\u043B\u0430\u044F \u0441\u0435\u0441\u0441\u0438\u044F \u043F\u0440\u0435\u0440\u0432\u0430\u043D\u0430. \u041E\u0442\u0441\u0447\u0451\u0442 72 \u0447 \u0441 ${new Date(end).toLocaleString()}.`);
        } else {
          warn("\u041F\u0440\u0435\u0434\u044B\u0434\u0443\u0449\u0438\u0439 \u0437\u0430\u043F\u0443\u0441\u043A \u0431\u044B\u043B \u043F\u0440\u0435\u0440\u0432\u0430\u043D \u0434\u043E \u0432\u044B\u043F\u043E\u043B\u043D\u0435\u043D\u0438\u044F \u043A\u0432\u0435\u0441\u0442\u043E\u0432 \u2014 \u043D\u0430\u0447\u043D\u0443 \u0437\u0430\u043D\u043E\u0432\u043E \u0431\u0435\u0437 \u043F\u0430\u0443\u0437\u044B 72 \u0447.");
        }
        persistSched();
      } else if (saved.schema !== 2) {
        persistSched();
      }
    }
    function scheduleIntervalMs() {
      return Math.max(0.5, Number(CONFIG.schedule.everyHours) || 12) * HOUR;
    }
    function nextRunAt() {
      return state.sched.lastEnd ? state.sched.lastEnd + scheduleIntervalMs() : 0;
    }
    function fmtNext() {
      const at = nextRunAt();
      return at ? new Date(at).toLocaleString() : "\u0441\u0440\u0430\u0437\u0443";
    }
    function schedReady() {
      try {
        const m = modules();
        const W = webpack();
        if (!state.connectionWatch) {
          state.connectionWatch = true;
          const connected = () => {
            if (!state.booted) return;
            state.connectionReady = true;
            state.readySince = Date.now();
          };
          const disconnected = () => {
            state.connectionReady = false;
            state.readySince = 0;
          };
          if (W.onceReady?.then) W.onceReady.then(connected).catch(() => {
          });
          else state.connectionReady = Boolean(m.users?.getCurrentUser?.());
          if (m.dispatcher?.subscribe) {
            for (const [event, handler] of [["CONNECTION_OPEN", connected], ["CONNECTION_RESUMED", connected], ["CONNECTION_CLOSED", disconnected]]) {
              m.dispatcher.subscribe(event, handler);
              state.connectionEvents.push([event, handler]);
            }
          }
        }
        if (!state.connectionReady) return false;
        if (!state.readySince) state.readySince = Date.now();
        return Date.now() - state.readySince >= 15e3;
      } catch {
        return false;
      }
    }
    function endSchedSession(reason, result) {
      const now = Date.now();
      persistSched({
        running: false,
        startedAt: 0,
        doneInSession: 0,
        lastBeat: now,
        lastEnd: now,
        nextRetry: 0,
        failStreak: 0,
        lastResult: result ? { ...result, at: now, outcome: "ok" } : null
      });
      log(`\u0421\u0435\u0441\u0441\u0438\u044F \u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043D\u0430 (${reason}). \u0421\u043B\u0435\u0434\u0443\u044E\u0449\u0430\u044F \u043D\u0435 \u0440\u0430\u043D\u044C\u0448\u0435 ${fmtNext()}.`);
    }
    async function maybeRun(reason) {
      if (checkSafety()) return { ran: false, reason: "safety-paused" };
      const s = CONFIG.schedule;
      if (!s?.enabled || !state.booted) return;
      if (state.schedBusy || state.runBusy || state.running || state.queueDraining) return;
      if (!schedReady()) return;
      if (checkSafety()) return { ran: false, reason: "safety-paused" };
      if (state.sched.nextRetry && Date.now() < state.sched.nextRetry) return;
      const now = Date.now();
      if (state.sched.lastEnd && now - state.sched.lastEnd < scheduleIntervalMs()) {
        return;
      }
      const blockedUntil = modules().quests?.questEnrollmentBlockedUntil;
      if (blockedUntil && new Date(blockedUntil).getTime() > now) {
        const until = new Date(blockedUntil).getTime();
        persistSched({ nextRetry: until + 60 * 1e3 });
        warn(`\u0410\u0432\u0442\u043E\u0444\u0430\u0440\u043C \u043E\u0442\u043B\u043E\u0436\u0435\u043D: \u043A\u0432\u0435\u0441\u0442\u044B \u0437\u0430\u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u0430\u043D\u044B \u0434\u043E ${new Date(until).toLocaleString()}.`);
        return;
      }
      state.schedBusy = true;
      const started = Date.now();
      persistSched({ running: true, startedAt: started, lastBeat: started, doneInSession: 0, nextRetry: 0 });
      const hb = setInterval(() => {
        if (state.sched.running) persistSched({ lastBeat: Date.now() });
      }, 60 * 1e3);
      const watchdog = setTimeout(() => {
        warn(`\u0410\u0432\u0442\u043E\u0444\u0430\u0440\u043C \u0438\u0434\u0451\u0442 \u0434\u043E\u043B\u044C\u0448\u0435 ${s.maxSessionMinutes} \u043C\u0438\u043D \u2014 \u043E\u0441\u0442\u0430\u043D\u0430\u0432\u043B\u0438\u0432\u0430\u044E.`);
        stop();
      }, Math.max(5, Number(s.maxSessionMinutes) || 180) * 60 * 1e3);
      log(
        `\u0410\u0432\u0442\u043E\u0444\u0430\u0440\u043C (${reason}): \u0441\u0442\u0430\u0440\u0442. \u0422\u0438\u043F\u044B: ${s.types.join(", ")}, \u0442\u043E\u043B\u044C\u043A\u043E Orbs: ${s.onlyOrbs ? "\u0434\u0430" : "\u043D\u0435\u0442"}.`
      );
      let res;
      try {
        res = await run({
          types: s.types,
          onlyOrbs: s.onlyOrbs,
          autoClaim: s.autoClaim,
          maxMinutes: CONFIG.maxMinutes
        });
        if (checkSafety()) {
          persistSched({
            running: false,
            startedAt: 0,
            doneInSession: 0,
            nextRetry: 0,
            ...res?.done > 0 ? { lastEnd: Date.now() } : {},
            lastResult: { ...res, at: Date.now(), outcome: "safety-paused" }
          });
        } else if (res?.ran && res.stopped) {
          endSchedSession("\u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u043E \u0432\u0440\u0443\u0447\u043D\u0443\u044E", res);
        } else if (res?.ran && res.done > 0) {
          endSchedSession("\u0433\u043E\u0442\u043E\u0432\u043E", res);
        } else if (res?.ran) {
          const streak = (state.sched.failStreak || 0) + 1;
          const hours = Math.min(24, Math.max(1, 2 ** (streak - 1)));
          const retry = hours * HOUR;
          state.lastError = state.lastError || "\u043D\u0438 \u043E\u0434\u0438\u043D \u043A\u0432\u0435\u0441\u0442 \u043D\u0435 \u0432\u044B\u043F\u043E\u043B\u043D\u0435\u043D";
          persistSched({
            running: false,
            startedAt: 0,
            lastBeat: 0,
            nextRetry: Date.now() + retry,
            failStreak: streak,
            lastResult: { ...res, at: Date.now(), outcome: "failed", error: state.lastError }
          });
          warn(
            `\u041D\u0438 \u043E\u0434\u0438\u043D \u043A\u0432\u0435\u0441\u0442 \u043D\u0435 \u0432\u044B\u043F\u043E\u043B\u043D\u0435\u043D (\u043F\u043E\u043F\u044B\u0442\u043A\u0430 ${streak}). \u041F\u043E\u0432\u0442\u043E\u0440 \u0447\u0435\u0440\u0435\u0437 ${hours} \u0447 \u2014 \u043F\u0440\u0438\u0447\u0438\u043D\u0430 \u0432 \u0436\u0443\u0440\u043D\u0430\u043B\u0435.`
          );
        } else if (res?.reason === "empty") {
          if (s.autoClaim) {
            try {
              await claimAll();
            } catch (e) {
              warn(`claimAll: ${e?.message ?? e}`);
            }
          }
          const retry = state.emptyConfirmed ? (Number(s.retryNoQuestsHours) || 6) * HOUR : 6e4;
          state.emptyConfirmed = true;
          persistSched({
            running: false,
            startedAt: 0,
            nextRetry: Date.now() + retry,
            lastResult: { at: Date.now(), outcome: "empty" }
          });
          log(`\u041F\u043E\u0434\u0445\u043E\u0434\u044F\u0449\u0438\u0445 \u043A\u0432\u0435\u0441\u0442\u043E\u0432 \u043D\u0435\u0442. \u041F\u043E\u0432\u0442\u043E\u0440\u043D\u0430\u044F \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0430 \u0447\u0435\u0440\u0435\u0437 ${Math.round(retry / 6e4)} \u043C\u0438\u043D.`);
        } else if (res?.reason === "blocked") {
          const until = new Date(res.blockedUntil).getTime() + 60 * 1e3;
          persistSched({ running: false, startedAt: 0, nextRetry: until });
        } else {
          persistSched({ running: false, startedAt: 0, nextRetry: Date.now() + 30 * 60 * 1e3 });
        }
      } catch (e) {
        error(`\u0410\u0432\u0442\u043E\u0444\u0430\u0440\u043C: ${e?.message ?? e}`);
        state.lastError = e?.message ?? String(e);
        state.running = false;
        restoreRunning();
        persistSched({ running: false, startedAt: 0, nextRetry: Date.now() + 30 * 60 * 1e3 });
      } finally {
        clearInterval(hb);
        clearTimeout(watchdog);
        state.schedBusy = false;
        drainQueue();
      }
      return res;
    }
    function scheduleTick(reason) {
      maybeRun(reason).catch((e) => error(`\u041F\u043B\u0430\u043D\u0438\u0440\u043E\u0432\u0449\u0438\u043A: ${e?.message ?? e}`));
    }
    function bootScheduler() {
      if (state.timers.length) return;
      loadSched();
      if (!state.sched.failStreak && (!state.sched.lastResult || state.sched.lastResult.outcome === "empty")) {
        persistSched({ nextRetry: 0 });
      }
      const checkMs = Math.min(6e4, Math.max(1, Number(CONFIG.schedule.checkMinutes) || 10) * 60 * 1e3);
      state.timers.push(setInterval(() => scheduleTick("\u0442\u0430\u0439\u043C\u0435\u0440"), checkMs));
      const bootTimer = setInterval(() => {
        if (!schedReady()) return;
        clearInterval(bootTimer);
        scheduleTick("\u0441\u0442\u0430\u0440\u0442");
      }, 5e3);
      state.timers.push(bootTimer);
      const onVisible = () => {
        if (document.visibilityState === "visible") scheduleTick("\u0432\u043E\u0437\u0432\u0440\u0430\u0442");
      };
      document.addEventListener("visibilitychange", onVisible);
      state.onVisible = onVisible;
      if (schedReady()) {
        clearInterval(bootTimer);
        scheduleTick("\u0441\u0442\u0430\u0440\u0442");
      }
      const at = nextRunAt();
      if (at && at > Date.now()) {
        log(`\u0410\u0432\u0442\u043E\u0444\u0430\u0440\u043C: \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0438\u0439 \u043D\u0435 \u0440\u0430\u043D\u044C\u0448\u0435 ${new Date(at).toLocaleString()}.`);
      } else {
        log(`\u0410\u0432\u0442\u043E\u0444\u0430\u0440\u043C: \u043F\u0430\u0443\u0437\u0430 ${CONFIG.schedule.everyHours} \u0447 \u0443\u0436\u0435 \u043F\u0440\u043E\u0448\u043B\u0430, \u043F\u0440\u043E\u0432\u0435\u0440\u044F\u044E \u043A\u0432\u0435\u0441\u0442\u044B.`);
      }
    }
    function shutdown() {
      state.queue.length = 0;
      state.queueOwner = null;
      CONFIG.schedule.enabled = false;
      for (const t of state.timers) clearInterval(t);
      state.timers = [];
      for (const [event, handler] of state.connectionEvents) {
        try {
          M?.dispatcher?.unsubscribe?.(event, handler);
        } catch {
        }
      }
      state.connectionEvents = [];
      for (const [event, handler] of state.safetyEvents) {
        try {
          M?.dispatcher?.unsubscribe?.(event, handler);
        } catch {
        }
      }
      state.safetyEvents = [];
      if (state.onSafetyStorage) window.removeEventListener?.("storage", state.onSafetyStorage);
      state.onSafetyStorage = null;
      state.connectionWatch = false;
      state.connectionReady = false;
      state.readySince = 0;
      if (state.onVisible) {
        document.removeEventListener("visibilitychange", state.onVisible);
        state.onVisible = null;
      }
      if (state.running) stop();
      if (state.sched.running) {
        persistSched({
          running: false,
          startedAt: 0,
          doneInSession: 0,
          lastBeat: Date.now(),
          ...state.sched.doneInSession > 0 ? { lastEnd: Date.now() } : {}
        });
      }
      if (window.DQ === DQ) {
        try {
          delete window.DQ;
        } catch {
          window.DQ = void 0;
        }
      }
      state.booted = false;
      log("\u0410\u0432\u0442\u043E\u0444\u0430\u0440\u043C \u0432\u044B\u043A\u043B\u044E\u0447\u0435\u043D.");
    }
    const SETTINGS_KEY = "DQ_FARM_SETTINGS_V1";
    function loadSavedSettings() {
      try {
        const raw = localStorage2.getItem(SETTINGS_KEY);
        if (!raw) return;
        const saved = JSON.parse(raw);
        if (!saved || typeof saved !== "object") return;
        if (saved.schema !== 3 && Array.isArray(saved.types) && !saved.types.includes("ACHIEVEMENT")) {
          saved.types = [...saved.types, "ACHIEVEMENT"];
        }
        applySettingsPatch(saved, saved.schema !== 3);
      } catch {
      }
    }
    function applySettingsPatch(patch = {}, persist = true) {
      const s = CONFIG.schedule;
      if (patch.everyHours !== void 0) {
        s.everyHours = Math.max(0.5, Number(patch.everyHours) || 12);
      }
      if (patch.onlyOrbs !== void 0) {
        s.onlyOrbs = Boolean(patch.onlyOrbs);
        CONFIG.onlyOrbs = s.onlyOrbs;
      }
      if (patch.autoClaim !== void 0) {
        s.autoClaim = Boolean(patch.autoClaim);
        CONFIG.autoClaim = s.autoClaim;
      }
      if (patch.autoEnroll !== void 0) {
        CONFIG.autoEnroll = Boolean(patch.autoEnroll);
      }
      if (patch.hideClaimedQuests !== void 0) CONFIG.hideClaimedQuests = Boolean(patch.hideClaimedQuests);
      if (Array.isArray(patch.types) && patch.types.length) {
        s.types = [...new Set(patch.types)];
      }
      if (patch.retryNoQuestsHours !== void 0) {
        s.retryNoQuestsHours = Math.max(1, Number(patch.retryNoQuestsHours) || 6);
      }
      if (patch.maxSessionMinutes !== void 0) {
        s.maxSessionMinutes = Math.max(5, Number(patch.maxSessionMinutes) || 180);
      }
      if (patch.gameNoProgressSec !== void 0) {
        CONFIG.gameNoProgressSec = Math.max(30, Number(patch.gameNoProgressSec) || 150);
      }
      if (patch.enabled !== void 0) {
        s.enabled = Boolean(patch.enabled);
      }
      if (persist) {
        try {
          localStorage2.setItem(SETTINGS_KEY, JSON.stringify({
            schema: 3,
            everyHours: s.everyHours,
            onlyOrbs: s.onlyOrbs,
            autoClaim: s.autoClaim,
            autoEnroll: CONFIG.autoEnroll,
            hideClaimedQuests: CONFIG.hideClaimedQuests,
            types: s.types,
            retryNoQuestsHours: s.retryNoQuestsHours,
            maxSessionMinutes: s.maxSessionMinutes,
            gameNoProgressSec: CONFIG.gameNoProgressSec,
            enabled: s.enabled
          }));
        } catch {
        }
        try {
          state.onSettingsChange?.(patch);
        } catch {
        }
      }
    }
    function boot(initialSettings = null) {
      if (state.booted) return;
      state.booted = true;
      loadSafety();
      loadSavedSettings();
      if (initialSettings) applySettingsPatch(initialSettings, false);
      window.DQ = DQ;
      log(`v${VERSION}: \u0430\u0432\u0442\u043E\u0444\u0430\u0440\u043C \u043A\u0430\u0436\u0434\u044B\u0435 ${CONFIG.schedule.everyHours} \u0447 \u043F\u043E\u0441\u043B\u0435 \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u0438.`);
      log("\u041D\u0430\u043F\u043E\u043C\u0438\u043D\u0430\u043D\u0438\u0435: Discord \u043F\u0430\u043B\u0438\u0442 \u0430\u0432\u0442\u043E\u043A\u0432\u0435\u0441\u0442\u044B \u0441 \u0430\u043F\u0440\u0435\u043B\u044F 2026 \u2014 \u043D\u0435 \u0433\u043E\u043D\u044F\u0439 24/7.");
      try {
        init();
        list();
      } catch (e) {
        warn(`\u041A\u0432\u0435\u0441\u0442\u044B \u0435\u0449\u0451 \u043D\u0435 \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u043B\u0438\u0441\u044C (${e?.message ?? e}), \u043F\u043E\u0434\u043E\u0436\u0434\u0443.`);
      }
      bootScheduler();
      state.onSafetyStorage = (e) => {
        if (e.key === SAFETY_KEY) {
          state.safetyLoaded = false;
          checkSafety();
        }
      };
      window.addEventListener?.("storage", state.onSafetyStorage);
      state.timers.push(setInterval(() => {
        try {
          modules();
          attachSafetyMonitor();
          scanSafetyCache();
          checkSafety();
        } catch {
        }
      }, 2e3));
    }
    function resetSchedule() {
      if (state.running || state.sched.running) {
        warn("\u0421\u043D\u0430\u0447\u0430\u043B\u0430 \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u0438 \u0442\u0435\u043A\u0443\u0449\u0443\u044E \u0441\u0435\u0441\u0441\u0438\u044E: DQ.stop().");
        return;
      }
      persistSched({
        lastEnd: 0,
        nextRetry: 0,
        running: false,
        startedAt: 0,
        doneInSession: 0,
        failStreak: 0,
        lastResult: null
      });
      log("\u0422\u0430\u0439\u043C\u0435\u0440 \u0430\u0432\u0442\u043E\u0444\u0430\u0440\u043C\u0430 \u0441\u0431\u0440\u043E\u0448\u0435\u043D. \u0421\u043B\u0435\u0434\u0443\u044E\u0449\u0430\u044F \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0430 \u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442 \u0444\u0430\u0440\u043C \u0441\u0440\u0430\u0437\u0443.");
    }
    async function forceRun() {
      if (checkSafety()) return { ran: false, reason: "safety-paused" };
      if (state.running || state.runBusy || state.schedBusy || state.queueDraining) return { ran: false, reason: "busy" };
      if (!state.booted) return { ran: false, reason: "not-ready" };
      if (!schedReady()) return { ran: false, reason: "not-ready" };
      if (checkSafety()) return { ran: false, reason: "safety-paused" };
      persistSched({
        lastEnd: 0,
        nextRetry: 0,
        failStreak: 0,
        doneInSession: 0,
        lastResult: null,
        running: false,
        startedAt: 0
      });
      log("\u0420\u0443\u0447\u043D\u043E\u0439 \u0437\u0430\u043F\u0443\u0441\u043A \u0438\u0437 \u043F\u0430\u043D\u0435\u043B\u0438.");
      scheduleTick("\u0432\u0440\u0443\u0447\u043D\u0443\u044E");
      return { ran: true, started: true };
    }
    async function runOne(questId) {
      if (checkSafety()) return { ran: false, reason: "safety-paused" };
      if (!schedReady()) return { ran: false, reason: "not-ready" };
      if (checkSafety()) return { ran: false, reason: "safety-paused" };
      const id = String(questId);
      const row = questRowsForUi().find((q) => q.id === id);
      if (!row?.manualEligible) return { ran: false, reason: "ineligible" };
      if (state.queueOwner && state.queueOwner !== safetyOwner()) state.queue.length = 0;
      state.queueOwner = safetyOwner();
      if (state.manualActive === id || state.runIds.includes(id)) return { ran: false, reason: "active" };
      const existing = state.queue.indexOf(id);
      if (existing >= 0) return { ran: true, queued: true, position: existing + 1 };
      if (state.stop && (state.runBusy || state.schedBusy)) return { ran: false, reason: "stopping" };
      state.queue.push(id);
      const position = state.queue.length;
      const started = !state.runBusy && !state.running && !state.schedBusy && !state.queueDraining;
      drainQueue();
      return { ran: true, started, queued: !started, position: started ? 0 : position };
    }
    async function drainQueue() {
      if (state.queueDraining || state.runBusy || state.running || state.schedBusy || !state.queue.length) return;
      state.queueDraining = true;
      try {
        while (state.queue.length) {
          if (checkSafety() || state.queueOwner !== safetyOwner() || !schedReady()) {
            state.queue.length = 0;
            break;
          }
          const id = state.queue.shift();
          if (!questRowsForUi().find((q) => q.id === id)?.manualEligible) continue;
          state.manualActive = id;
          try {
            await run({
              onlyQuestId: id,
              types: ["GAME", "ACTIVITY", "ACHIEVEMENT", "VIDEO"],
              onlyOrbs: false,
              autoClaim: CONFIG.schedule.autoClaim,
              maxMinutes: CONFIG.maxMinutes
            });
          } catch (e) {
            error(`\u041A\u0432\u0435\u0441\u0442 ${id}: ${e?.message ?? e}`);
          } finally {
            state.manualActive = null;
          }
        }
      } catch (e) {
        state.queue.length = 0;
        error(`\u041E\u0447\u0435\u0440\u0435\u0434\u044C \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u0430: ${e?.message ?? e}`);
      } finally {
        state.manualActive = null;
        state.queueDraining = false;
        if (!state.queue.length) state.queueOwner = null;
      }
    }
    function removeQueued(questId) {
      const index = state.queue.indexOf(String(questId));
      if (index < 0) return false;
      state.queue.splice(index, 1);
      return true;
    }
    function fmtDate(ts) {
      if (!ts) return "\u2014";
      return new Date(ts).toLocaleString();
    }
    function fmtDur(ms) {
      if (!ms || ms <= 0) return "\u0441\u0435\u0439\u0447\u0430\u0441";
      const m = Math.ceil(ms / 6e4);
      if (m < 60) return `${m} \u043C\u0438\u043D`;
      const h = Math.floor(m / 60);
      const mm = m % 60;
      if (h < 24) return `${h} \u0447${mm ? ` ${mm} \u043C\u0438\u043D` : ""}`;
      const d = Math.floor(h / 24);
      return `${d} \u0434${h % 24 ? ` ${h % 24} \u0447` : ""}`;
    }
    function statusInfo(now = Date.now()) {
      if (checkSafety()) return { code: "safety-paused", color: "#ed4245", label: "\u041E\u0431\u044F\u0437\u0430\u0442\u0435\u043B\u044C\u043D\u0430\u044F \u043F\u0430\u0443\u0437\u0430", detail: state.safetyStorageError ? "\u041E\u0448\u0438\u0431\u043A\u0430 \u0445\u0440\u0430\u043D\u0438\u043B\u0438\u0449\u0430 \u0437\u0430\u0449\u0438\u0442\u044B. \u0424\u0430\u0440\u043C \u0438 \u043F\u043E\u043B\u0443\u0447\u0435\u043D\u0438\u0435 \u043D\u0430\u0433\u0440\u0430\u0434 \u0437\u0430\u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u0430\u043D\u044B. \u041E\u0442\u043A\u0440\u043E\u0439 \u043E\u0442\u0447\u0451\u0442 \u0434\u043B\u044F \u0434\u0438\u0430\u0433\u043D\u043E\u0441\u0442\u0438\u043A\u0438; \u0442\u0430\u0439\u043C\u0435\u0440 \u043D\u0435 \u0441\u043D\u0438\u043C\u0430\u0435\u0442 \u044D\u0442\u0443 \u043F\u0430\u0443\u0437\u0443." : "\u041F\u0440\u0435\u0434\u0443\u043F\u0440\u0435\u0436\u0434\u0435\u043D\u0438\u0435 / \u043E\u0433\u0440\u0430\u043D\u0438\u0447\u0435\u043D\u0438\u0435 Discord. \u0424\u0430\u0440\u043C \u0438 \u043F\u043E\u043B\u0443\u0447\u0435\u043D\u0438\u0435 \u043D\u0430\u0433\u0440\u0430\u0434 \u0437\u0430\u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u0430\u043D\u044B. \u041E\u0442\u043A\u0440\u043E\u0439 \u043E\u0442\u0447\u0451\u0442; \u0442\u0430\u0439\u043C\u0435\u0440 \u043D\u0435 \u0441\u043D\u0438\u043C\u0430\u0435\u0442 \u044D\u0442\u0443 \u043F\u0430\u0443\u0437\u0443." };
      const sch = CONFIG.schedule;
      if (!state.booted) {
        return { code: "off", color: "#80848e", label: "\u0412\u044B\u043A\u043B\u044E\u0447\u0435\u043D", detail: "\u041F\u043B\u0430\u0433\u0438\u043D \u043D\u0435 \u0437\u0430\u043F\u0443\u0449\u0435\u043D." };
      }
      if (!sch.enabled) {
        return { code: "off", color: "#80848e", label: "\u0410\u0432\u0442\u043E\u0444\u0430\u0440\u043C \u0432\u044B\u043A\u043B\u044E\u0447\u0435\u043D", detail: "\u0412\u043A\u043B\u044E\u0447\u0438 \u043F\u043B\u0430\u0433\u0438\u043D/\u0440\u0430\u0441\u043F\u0438\u0441\u0430\u043D\u0438\u0435." };
      }
      if (state.running || state.schedBusy) {
        const a = state.activity;
        return {
          code: "running",
          color: "#3ba55d",
          label: "\u0424\u0430\u0440\u043C \u0438\u0434\u0451\u0442",
          detail: a ? a.note ? `${a.name} \u2014 ${a.note}` : `\u0412\u044B\u043F\u043E\u043B\u043D\u044F\u044E: ${a.name}` : "\u0413\u043E\u0442\u043E\u0432\u043B\u044E\u0441\u044C \u043A \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0435\u043C\u0443 \u043A\u0432\u0435\u0441\u0442\u0443\u2026"
        };
      }
      if (!schedReady()) {
        return { code: "loading", color: "#faa81a", label: "\u0416\u0434\u0443 Discord", detail: "QuestStore \u0435\u0449\u0451 \u043D\u0435 \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u043B\u0441\u044F." };
      }
      const retry = Number(state.sched.nextRetry) || 0;
      if (retry > now) {
        const failed = state.sched.lastResult?.outcome === "failed";
        return {
          code: failed ? "error" : "wait",
          color: failed ? "#ed4245" : "#faa81a",
          label: failed ? "\u041F\u0430\u0443\u0437\u0430 \u043F\u043E\u0441\u043B\u0435 \u043E\u0448\u0438\u0431\u043A\u0438" : "\u041E\u0436\u0438\u0434\u0430\u043D\u0438\u0435",
          detail: `\u0421\u043B\u0435\u0434\u0443\u044E\u0449\u0430\u044F \u043F\u043E\u043F\u044B\u0442\u043A\u0430 ${fmtDate(retry)} (\u0447\u0435\u0440\u0435\u0437 ${fmtDur(retry - now)}).`,
          remainingMs: retry - now
        };
      }
      const at = nextRunAt();
      if (!at) {
        return { code: "ready", color: "#5865f2", label: "\u0413\u043E\u0442\u043E\u0432 \u043A \u0437\u0430\u043F\u0443\u0441\u043A\u0443", detail: "\u0422\u0430\u0439\u043C\u0435\u0440 \u0435\u0449\u0451 \u043D\u0435 \u0437\u0430\u043F\u0443\u0441\u043A\u0430\u043B\u0441\u044F \u2014 \u043D\u0430\u0447\u043D\u0443 \u0441\u0440\u0430\u0437\u0443." };
      }
      if (at > now) {
        return {
          code: "sleep",
          color: "#5865f2",
          label: "\u0421\u043F\u0438\u0442",
          detail: `\u0421\u043B\u0435\u0434\u0443\u044E\u0449\u0438\u0439 \u0437\u0430\u043F\u0443\u0441\u043A ${fmtDate(at)} (\u0447\u0435\u0440\u0435\u0437 ${fmtDur(at - now)}).`,
          remainingMs: at - now
        };
      }
      return { code: "due", color: "#3ba55d", label: "\u041F\u043E\u0440\u0430 \u0437\u0430\u043F\u0443\u0441\u043A\u0430\u0442\u044C", detail: "\u041F\u0430\u0443\u0437\u0430 \u043F\u0440\u043E\u0448\u043B\u0430, \u0436\u0434\u0443 \u0431\u043B\u0438\u0436\u0430\u0439\u0448\u0435\u0439 \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0438." };
    }
    function questRowsForUi() {
      const rows = [];
      for (const [i, q] of allQuests().entries()) {
        const det = detectTask(q.config);
        const orbs = questOrbs(q.config);
        const completed = isCompleted(q, det);
        const claimed = isClaimed(q);
        const enrolled = Boolean(q.userStatus?.enrolledAt) || state.enrolledAt.has(String(q.id));
        const sch = CONFIG.schedule;
        const manualSkip = completed ? "\u0437\u0430\u0434\u0430\u043D\u0438\u0435 \u0443\u0436\u0435 \u0432\u044B\u043F\u043E\u043B\u043D\u0435\u043D\u043E" : BLACKLISTED_QUESTS.has(String(q.id)) ? "\u0432 \u0447\u0451\u0440\u043D\u043E\u043C \u0441\u043F\u0438\u0441\u043A\u0435" : !det || !["GAME", "ACTIVITY", "ACHIEVEMENT", "VIDEO"].includes(det.type) ? "\u0442\u0438\u043F \u043D\u0435 \u043F\u043E\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u0435\u0442\u0441\u044F" : !det.target ? "\u043D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 target" : ["GAME", "ACTIVITY", "ACHIEVEMENT"].includes(det.type) && !det.appId ? "\u043D\u0435\u0442 application id" : null;
        let skip = null;
        if (completed) skip = null;
        else if (BLACKLISTED_QUESTS.has(String(q.id))) skip = "\u0432 \u0447\u0451\u0440\u043D\u043E\u043C \u0441\u043F\u0438\u0441\u043A\u0435";
        else if (!det) skip = "\u0442\u0438\u043F \u043D\u0435 \u043F\u043E\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u0435\u0442\u0441\u044F";
        else if (!sch.types.includes(det.type)) skip = `\u0442\u0438\u043F ${det.type} \u0432\u044B\u043A\u043B\u044E\u0447\u0435\u043D`;
        else if (det.type === "STREAM") skip = "\u043D\u0443\u0436\u0435\u043D \u0440\u0435\u0430\u043B\u044C\u043D\u044B\u0439 Go Live";
        else if ((det.type === "GAME" || det.type === "ACTIVITY" || det.type === "ACHIEVEMENT") && !det.appId) skip = "\u043D\u0435\u0442 application id";
        else if (sch.onlyOrbs && !orbs) skip = "\u0431\u0435\u0437 Orbs";
        else if (!det.target) skip = "\u043D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 target";
        rows.push({
          index: i + 1,
          id: String(q.id),
          name: questName(q),
          type: det?.type ?? "\u2014",
          key: det?.key ?? "\u2014",
          target: det?.target ?? 0,
          progress: Math.floor(progressOf(q, det?.key)),
          orbs: orbs?.orbs ?? 0,
          completed,
          claimed,
          enrolled,
          eligible: !completed && !skip,
          manualEligible: !manualSkip,
          manualSkip,
          skip,
          status: completed ? claimed ? "\u0437\u0430\u0431\u0440\u0430\u043D\u043E" : "\u0433\u043E\u0442\u043E\u0432\u043E" : enrolled ? "\u043F\u0440\u0438\u043D\u044F\u0442" : "\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D",
          expiresAt: q.config?.expiresAt ? new Date(q.config.expiresAt).getTime() : 0
        });
      }
      rows.sort((a, b) => {
        if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
        if (a.completed !== b.completed) return a.completed ? 1 : -1;
        return b.orbs - a.orbs;
      });
      return rows;
    }
    function snapshot() {
      const now = Date.now();
      let rows = [];
      let claimedQuestIds = [];
      let loadError = null;
      try {
        rows = questRowsForUi();
        claimedQuestIds = allQuests({ includeExpired: true }).filter(isClaimed).map((q) => String(q.id));
      } catch (e) {
        loadError = e?.message ?? String(e);
      }
      let activity = state.activity;
      if (activity) {
        const q = freshQuest(activity.questIds?.[0]);
        const det = q ? detectTask(q.config) : null;
        const storeProg = q ? Math.floor(progressOf(q, det?.key)) : 0;
        activity = {
          ...activity,
          progress: Math.max(Number(activity.progress) || 0, storeProg),
          target: det?.target || activity.target || 0,
          elapsedMs: now - (activity.startedAt || now)
        };
      }
      const counts = {
        total: rows.length,
        completed: rows.filter((r) => r.completed).length,
        claimed: rows.filter((r) => r.claimed).length,
        enrolled: rows.filter((r) => r.enrolled).length,
        runnable: rows.filter((r) => r.eligible).length,
        orbsPending: rows.reduce((n, r) => n + (!r.completed ? r.orbs : 0), 0),
        orbsDone: rows.reduce((n, r) => n + (r.completed ? r.orbs : 0), 0)
      };
      return {
        version: VERSION,
        now,
        manualReady: !checkSafety() && schedReady(),
        safety: safetySnapshot(),
        status: statusInfo(now),
        queue: state.queue.map((id, index) => ({ id, position: index + 1, name: rows.find((q) => q.id === id)?.name || "\u0417\u0430\u0434\u0430\u043D\u0438\u0435" })),
        activeQuestIds: [.../* @__PURE__ */ new Set([...state.runIds, ...state.manualActive ? [state.manualActive] : []])],
        session: {
          running: state.sched.running || state.running || state.runBusy || state.queueDraining,
          startedAt: state.sched.startedAt,
          lastEnd: state.sched.lastEnd,
          lastBeat: state.sched.lastBeat,
          nextRetry: state.sched.nextRetry,
          failStreak: state.sched.failStreak || 0,
          lastResult: state.sched.lastResult
        },
        nextRunAt: nextRunAt(),
        activity,
        counts,
        quests: rows,
        claimedQuestIds,
        logs: state.logs.slice(-120),
        lastError: state.lastError,
        loadError,
        config: {
          enabled: CONFIG.schedule.enabled,
          everyHours: CONFIG.schedule.everyHours,
          types: [...CONFIG.schedule.types],
          onlyOrbs: CONFIG.schedule.onlyOrbs,
          autoClaim: CONFIG.schedule.autoClaim,
          autoEnroll: CONFIG.autoEnroll,
          hideClaimedQuests: CONFIG.hideClaimedQuests,
          retryNoQuestsHours: CONFIG.schedule.retryNoQuestsHours,
          maxSessionMinutes: CONFIG.schedule.maxSessionMinutes,
          gameNoProgressSec: CONFIG.gameNoProgressSec
        }
      };
    }
    const DQ = {
      version: VERSION,
      config: CONFIG,
      list,
      run,
      runOne,
      removeQueued,
      stop,
      claimAll,
      inspect,
      boot,
      shutdown,
      resetSchedule,
      forceRun,
      updateSettings: applySettingsPatch,
      snapshot,
      status: statusInfo,
      clearLogs: () => {
        state.logs.length = 0;
      },
      safetyReport,
      acknowledgeSafety,
      maybeRun: () => scheduleTick("\u0432\u0440\u0443\u0447\u043D\u0443\u044E"),
      _maybeRun: maybeRun,
      nextRunAt,
      _state: state,
      _modules: () => M
    };
    return DQ;
  }

  // vencord-plugin/webpack-common-shim.ts
  var React = new Proxy({}, {
    get(_, prop) {
      return window.Vencord?.Webpack?.Common?.React?.[prop];
    }
  });
  function createRoot(...args) {
    return window.Vencord?.Webpack?.Common?.createRoot?.(...args);
  }

  // vencord-plugin/questFarmer/claimed-quests.ts
  function visibleQuestRows(quests, enabled = true) {
    return enabled ? quests.filter((quest) => !quest.claimed) : quests;
  }
  function createClaimedQuestFilter() {
    const hidden = /* @__PURE__ */ new Map();
    const restore = (card) => {
      const previous = hidden.get(card);
      if (!previous) return;
      if (card.style.getPropertyValue("display") === "none" && card.style.getPropertyPriority("display") === "important") {
        if (previous.display) card.style.setProperty("display", previous.display, previous.priority);
        else card.style.removeProperty("display");
      }
      hidden.delete(card);
    };
    return {
      sync(cards, rows, enabled = true) {
        if (!enabled) {
          this.clear();
          return;
        }
        for (const card of hidden.keys()) {
          if (!card.isConnected || !rows.get(cards.get(card))?.claimed) restore(card);
        }
        for (const [card, id] of cards) {
          if (!rows.get(id)?.claimed) continue;
          if (!hidden.has(card)) hidden.set(card, {
            display: card.style.getPropertyValue("display"),
            priority: card.style.getPropertyPriority("display")
          });
          card.style.setProperty("display", "none", "important");
        }
      },
      clear() {
        for (const card of hidden.keys()) restore(card);
      },
      repair() {
        for (const card of hidden.keys()) {
          if (card.isConnected && (card.style.getPropertyValue("display") !== "none" || card.style.getPropertyPriority("display") !== "important")) {
            card.style.setProperty("display", "none", "important");
          }
        }
      }
    };
  }

  // vencord-plugin/questFarmer/ui.tsx
  var root = null;
  var host = null;
  function showQuestFarmerPanel() {
    window.dispatchEvent(new Event("questfarmer-open-native"));
  }
  function onQuestsPage() {
    try {
      const where = `${location.pathname}${location.hash}`.toLowerCase();
      return /(^|[/#])(?:quest-home|quests)([/#?]|$)/.test(where);
    } catch {
      return false;
    }
  }
  function fmtTime(ts) {
    try {
      return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    } catch {
      return "";
    }
  }
  var styles = {
    panel: {
      position: "fixed",
      display: "flex",
      flexDirection: "column",
      background: "var(--background-secondary, #2b2d31)",
      color: "var(--text-normal, #dbdee1)",
      border: "1px solid var(--background-modifier-accent, #3f4147)",
      borderRadius: 12,
      boxShadow: "0 14px 44px rgba(0,0,0,.6)",
      zIndex: 2147483e3,
      overflow: "hidden",
      fontFamily: 'var(--font-primary, "gg sans", sans-serif)',
      fontSize: 13,
      lineHeight: 1.35,
      userSelect: "none"
    },
    header: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      padding: "12px 16px",
      background: "var(--background-secondary, #2b2d31)",
      borderBottom: "1px solid var(--background-modifier-accent, #3f4147)",
      color: "var(--header-primary, #f2f3f5)",
      flex: "0 0 auto",
      cursor: "move",
      userSelect: "none"
    },
    iconBtn: {
      border: 0,
      background: "rgba(255,255,255,.16)",
      color: "#fff",
      borderRadius: 6,
      width: 24,
      height: 24,
      cursor: "pointer",
      fontSize: 13,
      fontWeight: 700,
      lineHeight: "22px",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 0
    },
    iconBtnDanger: {
      background: "rgba(218,55,60,.82)"
    },
    iconBtnActive: {
      background: "rgba(255,255,255,.34)"
    },
    body: {
      padding: 12,
      overflowY: "auto",
      minHeight: 0,
      flex: 1,
      display: "flex",
      flexDirection: "column",
      gap: 10,
      userSelect: "text"
    },
    card: {
      background: "#232428",
      border: "1px solid #1e1f22",
      borderRadius: 8,
      padding: "9px 10px"
    },
    row: {
      display: "flex",
      alignItems: "center",
      gap: 8
    },
    label: {
      color: "#949ba4",
      fontSize: 11,
      textTransform: "uppercase",
      letterSpacing: ".04em",
      fontWeight: 700
    },
    value: {
      color: "#f2f3f5",
      fontWeight: 600
    },
    buttons: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: 6
    },
    btn: {
      border: 0,
      borderRadius: 6,
      padding: "8px 9px",
      cursor: "pointer",
      fontWeight: 700,
      fontSize: 12,
      color: "#fff",
      background: "#4e5058"
    },
    btnPrimary: {
      background: "#5865f2"
    },
    btnDanger: {
      background: "#da373c"
    },
    btnGhost: {
      background: "#3f4147"
    },
    miniBtn: {
      border: 0,
      borderRadius: 5,
      padding: "2px 6px",
      cursor: "pointer",
      fontWeight: 700,
      fontSize: 10,
      color: "#fff",
      background: "#4752c4",
      flex: "0 0 auto"
    },
    quest: {
      display: "flex",
      alignItems: "center",
      gap: 7,
      padding: "5px 0",
      borderTop: "1px solid rgba(255,255,255,.05)"
    },
    questName: {
      flex: 1,
      minWidth: 0,
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap"
    },
    badge: {
      flex: "0 0 auto",
      fontSize: 10,
      fontWeight: 800,
      padding: "2px 5px",
      borderRadius: 4,
      background: "#3f4147",
      color: "#c7ccd1"
    },
    progressOuter: {
      height: 6,
      background: "#1e1f22",
      borderRadius: 4,
      overflow: "hidden",
      marginTop: 6
    },
    progressInner: {
      height: "100%",
      background: "#5865f2",
      borderRadius: 4,
      transition: "width .3s ease"
    },
    log: {
      display: "flex",
      gap: 7,
      fontFamily: "var(--font-code, monospace)",
      fontSize: 11,
      lineHeight: 1.45,
      padding: "2px 0"
    },
    logTime: {
      color: "#6d6f78",
      flex: "0 0 auto"
    },
    details: {
      cursor: "pointer",
      color: "#b5bac1",
      fontWeight: 700,
      fontSize: 12,
      userSelect: "none"
    },
    pill: {
      position: "fixed",
      zIndex: 2147483e3,
      border: "1px solid #1e1f22",
      borderRadius: 999,
      padding: "7px 10px 7px 12px",
      background: "#2b2d31",
      color: "#dbdee1",
      boxShadow: "0 6px 20px rgba(0,0,0,.45)",
      fontWeight: 800,
      fontSize: 12,
      display: "flex",
      alignItems: "center",
      gap: 8,
      userSelect: "none"
    },
    input: {
      width: 72,
      background: "#1e1f22",
      color: "#f2f3f5",
      border: "1px solid #3f4147",
      borderRadius: 5,
      padding: "4px 7px",
      fontSize: 12,
      fontWeight: 600,
      textAlign: "right"
    },
    chip: {
      border: "1px solid #3f4147",
      borderRadius: 5,
      padding: "3px 7px",
      fontSize: 11,
      fontWeight: 700,
      cursor: "pointer",
      background: "#2b2d31",
      color: "#dbdee1"
    },
    chipActive: {
      background: "#5865f2",
      borderColor: "#5865f2",
      color: "#fff"
    },
    settingRow: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 8,
      padding: "5px 0",
      borderTop: "1px solid rgba(255,255,255,.05)"
    },
    checkboxLabel: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      cursor: "pointer",
      fontSize: 12,
      color: "#dbdee1"
    },
    resizeGrip: {
      position: "absolute",
      right: 2,
      bottom: 1,
      width: 16,
      height: 16,
      cursor: "nwse-resize",
      color: "#80848e",
      fontSize: 11,
      lineHeight: "16px",
      textAlign: "center",
      userSelect: "none"
    }
  };
  var integrationCss = `
.qf-ui { --qf-surface: var(--background-secondary, #232428); --qf-text: var(--text-normal, #dbdee1); --qf-muted: var(--text-muted, #949ba4); --qf-border: var(--background-modifier-accent, #3f4147); --qf-brand: var(--brand-500, #5865f2); color: var(--qf-text); font-family: var(--font-primary, "gg sans", sans-serif); font-size: 14px; line-height: 1.4; text-align: left; }
.qf-ui, .qf-ui * { box-sizing: border-box; }
.qf-ui button, .qf-ui input { font: inherit; }
.qf-ui button { cursor: pointer; }
.qf-ui button:disabled { cursor: not-allowed; opacity: .45; }
.qf-ui button:focus-visible, .qf-ui input:focus-visible, .qf-ui summary:focus-visible { outline: 2px solid var(--text-link, #00a8fc); outline-offset: 3px; }
.qf-status { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 500; color: var(--qf-muted); }
.qf-status-dot { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: currentColor; }
.qf-status[data-state="running"], .qf-status[data-state="due"] { color: var(--text-positive, #3ba55d); }
.qf-status[data-state="error"] { color: var(--text-danger, #f28385); }
.qf-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.qf-button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 32px; border: 1px solid transparent; border-radius: 6px; padding: 6px 12px; font-size: 13px !important; font-weight: 600 !important; color: var(--qf-text); background: transparent; white-space: nowrap; transition: background .12s ease; }
.qf-button:not(:disabled):hover { background: var(--background-modifier-hover, rgba(255,255,255,.06)); }
.qf-button-primary { background: var(--qf-brand); color: #fff; }
.qf-button-primary:not(:disabled):hover { background: var(--brand-560, #4752c4); }
.qf-button-secondary { border-color: var(--qf-border); }
.qf-button-secondary[aria-expanded="true"] { background: var(--background-modifier-selected, rgba(255,255,255,.1)); }
.qf-button-stop { border-color: var(--text-danger, #f28385); color: var(--text-danger, #f28385); }
.qf-button-icon { width: 32px; padding: 6px; }
.qf-detail { padding: 0 24px 16px; color: var(--qf-muted); font-size: 13px; overflow-wrap: anywhere; }
.qf-metrics { display: flex; flex-wrap: wrap; gap: 8px 24px; padding: 12px 24px; border-top: 1px solid var(--qf-border); color: var(--qf-muted); font-size: 12px; }
.qf-metrics span { display: inline-flex; align-items: center; gap: 6px; }
.qf-metrics strong { color: var(--qf-text); font-weight: 600; font-variant-numeric: tabular-nums; }
.qf-alert { display: flex; align-items: flex-start; gap: 8px; margin: 0 24px 16px; padding: 12px; border-left: 3px solid var(--text-danger, #f28385); border-radius: 4px; background: var(--background-modifier-hover, rgba(255,255,255,.04)); color: var(--text-danger, #f28385); font-size: 13px; overflow-wrap: anywhere; }
.qf-activity { margin: 0 24px 16px; }
.qf-activity-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 8px; }
.qf-activity-heading strong { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qf-progress { height: 4px; border-radius: 4px; background: var(--background-modifier-accent, #3f4147); overflow: hidden; }
.qf-progress > div { height: 100%; border-radius: inherit; background: var(--qf-brand); }
.qf-view-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
.qf-view-heading h3 { margin: 0; font-size: 14px; font-weight: 600; }
.qf-scroll { max-height: 280px; overflow-y: auto; }
.qf-setting-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); gap: 16px 32px; }
.qf-setting { display: flex; align-items: center; justify-content: space-between; gap: 16px; font-size: 13px; padding: 8px 0; }
.qf-setting small { display: block; color: var(--qf-muted); margin-top: 4px; font-size: 12px; }
.qf-ui input[type="number"] { width: 80px; min-height: 32px; border: 1px solid var(--qf-border); background: var(--background-tertiary, #1e1f22); color: var(--qf-text); border-radius: 6px; padding: 4px 8px; text-align: right; }
.qf-ui input[type="checkbox"] { accent-color: var(--qf-brand); width: 16px; height: 16px; flex: 0 0 auto; }
.qf-check { display: flex; align-items: center; gap: 12px; font-size: 13px; padding: 8px 0; cursor: pointer; }
.qf-presets { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 8px; }
.qf-presets .qf-button { min-height: 28px; padding: 4px 8px; font-size: 12px !important; }
.qf-presets [aria-pressed="true"] { background: var(--background-modifier-selected, rgba(255,255,255,.1)); color: var(--text-link, #00a8fc); }
.qf-settings details { margin-top: 16px; border-top: 1px solid var(--qf-border); padding-top: 16px; }
.qf-settings summary { cursor: pointer; color: var(--qf-muted); font-size: 13px; }
.qf-note { color: var(--qf-muted); font-size: 12px; overflow-wrap: anywhere; }
.qf-card { width: 100%; padding: 12px 16px; border-top: 1px solid var(--qf-border); background: transparent; font-size: 12px; }
.qf-card-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.qf-card-label { display: flex; align-items: center; gap: 8px; color: var(--qf-muted); min-width: 0; font-variant-numeric: tabular-nums; }
.qf-card .qf-button { font-size: 12px !important; min-height: 32px; padding: 6px 10px; }
.qf-card .qf-note { margin-top: 8px; font-size: 11px; }
.qf-card .qf-progress { margin-top: 8px; }
.qf-card-done { padding-top: 10px; padding-bottom: 10px; }
.qf-hud { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 16px; padding: 0 0 16px; font-size: 13px; color: var(--qf-muted); }
.qf-hud-main { display: inline-flex; align-items: center; gap: 8px; }
.qf-hud-main strong { color: var(--qf-text); font-weight: 500; }
.qf-hud[data-state="error"] .qf-hud-main { color: var(--text-danger, #f28385); }
.qf-text-button { border: 0; background: transparent; padding: 4px 0; color: var(--text-link, #00a8fc); font-size: 13px; }
.qf-text-button:hover { text-decoration: underline; }
.qf-tab-badge { margin-left: 6px; padding: 1px 5px; border-radius: 8px; font-size: 11px; background: var(--background-modifier-accent, #3f4147); color: var(--text-normal, #dbdee1); }
.qf-native-tab { white-space: nowrap; }
.qf-native-tab:focus-visible { outline: 2px solid var(--text-link, #00a8fc); outline-offset: -2px; }
.qf-farm-page { max-width: 960px; margin: 0 auto; padding: 32px 24px; }
.qf-farm-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 16px; margin-bottom: 24px; }
.qf-farm-heading h1 { margin: 0 0 4px; color: var(--header-primary, #f2f3f5); font-size: 24px; line-height: 1.25; }
.qf-farm-heading p { margin: 0; color: var(--qf-muted); font-size: 13px; }
.qf-farm-summary { padding: 0 0 24px; border-bottom: 1px solid var(--qf-border); }
.qf-farm-summary .qf-detail { padding: 8px 0 0; }
.qf-farm-summary .qf-activity, .qf-farm-summary .qf-alert { margin: 12px 0 0; }
.qf-subnav { display: flex; gap: 24px; border-bottom: 1px solid var(--qf-border); margin: 24px 0; overflow-x: auto; }
.qf-subnav button { background: transparent; color: var(--qf-muted); border: 0; border-bottom: 2px solid transparent; padding: 0 0 12px; font-weight: 500; white-space: nowrap; }
.qf-subnav button[aria-pressed="true"] { color: var(--qf-text); border-bottom-color: var(--qf-text); }
.qf-farm-page .qf-metrics { padding: 0; border: 0; margin-bottom: 16px; }
.qf-farm-page .qf-scroll { max-height: none; }
.qf-task-list { list-style: none; margin: 0; padding: 0; }
.qf-task { display: flex; align-items: center; gap: 16px; padding: 16px 0; border-bottom: 1px solid var(--qf-border); }
.qf-task-name { flex: 1; min-width: 0; }
.qf-task-name strong { display: block; font-weight: 500; }
.qf-task-name small { color: var(--qf-muted); font-size: 12px; }
.qf-task-meta { color: var(--qf-muted); font-size: 12px; white-space: nowrap; }
.qf-farm-page details { margin-top: 24px; }
.qf-farm-page summary { cursor: pointer; color: var(--qf-muted); }
.qf-farm-footer { display: flex; justify-content: space-between; align-items: center; gap: 16px; border-top: 1px solid var(--qf-border); padding-top: 16px; margin-top: 32px; color: var(--qf-muted); font-size: 12px; }
@media (max-width: 600px) { .qf-farm-page { padding: 24px 16px; } .qf-task { gap: 8px; flex-wrap: wrap; } .qf-task-name { min-width: 160px; } .qf-task-meta { display: none; } }
@media (prefers-reduced-motion: reduce) { .qf-ui button { transition: none; } }
`;
  function Icon({ name, size = 16 }) {
    const paths = {
      play: /* @__PURE__ */ React.createElement("path", { d: "m8 5 11 7-11 7Z" }),
      stop: /* @__PURE__ */ React.createElement("rect", { x: "6", y: "6", width: "12", height: "12", rx: "1" }),
      check: /* @__PURE__ */ React.createElement("path", { d: "m5 12 4 4L19 6" }),
      more: /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("circle", { cx: "5", cy: "12", r: "1" }), /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "12", r: "1" }), /* @__PURE__ */ React.createElement("circle", { cx: "19", cy: "12", r: "1" })),
      settings: /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("path", { d: "M4 7h16M4 17h16" }), /* @__PURE__ */ React.createElement("circle", { cx: "9", cy: "7", r: "3" }), /* @__PURE__ */ React.createElement("circle", { cx: "15", cy: "17", r: "3" })),
      list: /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("path", { d: "M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" })),
      log: /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("path", { d: "M8 3h12v18H4V7Z" }), /* @__PURE__ */ React.createElement("path", { d: "M8 3v4H4m4 4h8m-8 4h8" })),
      clock: /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("circle", { cx: "12", cy: "12", r: "9" }), /* @__PURE__ */ React.createElement("path", { d: "M12 7v5l3 2" })),
      orb: /* @__PURE__ */ React.createElement("path", { d: "m12 3 9 9-9 9-9-9Z" }),
      close: /* @__PURE__ */ React.createElement("path", { d: "m6 6 12 12M6 18 18 6" })
    };
    return /* @__PURE__ */ React.createElement(
      "svg",
      {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: "1.8",
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
        style: { flex: "0 0 auto" }
      },
      paths[name] || paths.orb
    );
  }
  function SettingsPane({ cfg, onChange }) {
    const types = Array.isArray(cfg.types) ? cfg.types : ["GAME", "ACTIVITY", "ACHIEVEMENT"];
    const number = (key, label, fallback, min, max, step, note) => /* @__PURE__ */ React.createElement("label", { className: "qf-setting" }, /* @__PURE__ */ React.createElement("span", null, label, note && /* @__PURE__ */ React.createElement("small", null, note)), /* @__PURE__ */ React.createElement(
      "input",
      {
        "aria-label": label,
        type: "number",
        min,
        max,
        step,
        value: cfg[key] ?? fallback,
        onChange: (e) => onChange({ [key]: Number(e.target.value) || fallback })
      }
    ));
    const check = (key, label, value) => /* @__PURE__ */ React.createElement("label", { className: "qf-check" }, /* @__PURE__ */ React.createElement("input", { type: "checkbox", checked: value, onChange: (e) => onChange({ [key]: e.target.checked }) }), label);
    return /* @__PURE__ */ React.createElement("div", { className: "qf-settings" }, /* @__PURE__ */ React.createElement("div", { className: "qf-setting-grid" }, /* @__PURE__ */ React.createElement("div", null, number("everyHours", "\u0418\u043D\u0442\u0435\u0440\u0432\u0430\u043B \u0437\u0430\u043F\u0443\u0441\u043A\u0430, \u0447", 12, 0.5, 168, 0.5, "\u041E\u0442 \u043A\u043E\u043D\u0446\u0430 \u043F\u0440\u0435\u0434\u044B\u0434\u0443\u0449\u0435\u0439 \u0441\u0435\u0441\u0441\u0438\u0438, \u043D\u0435 \u043E\u0442 \u0437\u0430\u043F\u0443\u0441\u043A\u0430 Discord."), /* @__PURE__ */ React.createElement("div", { className: "qf-presets" }, [4, 8, 12, 24, 48, 72].map((h) => /* @__PURE__ */ React.createElement("button", { key: h, className: "qf-button", "aria-pressed": Number(cfg.everyHours) === h, onClick: () => onChange({ everyHours: h }) }, h, " \u0447"))), check("enabled", "\u0410\u0432\u0442\u043E\u0444\u0430\u0440\u043C \u043F\u043E \u0440\u0430\u0441\u043F\u0438\u0441\u0430\u043D\u0438\u044E", cfg.enabled !== false), check("onlyOrbs", "\u0422\u043E\u043B\u044C\u043A\u043E \u043D\u0430\u0433\u0440\u0430\u0434\u044B \u0432 Orbs", Boolean(cfg.onlyOrbs))), /* @__PURE__ */ React.createElement("div", null, check("autoEnroll", "\u0410\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u0438 \u043F\u0440\u0438\u043D\u0438\u043C\u0430\u0442\u044C \u0437\u0430\u0434\u0430\u043D\u0438\u044F", cfg.autoEnroll !== false), check("autoClaim", "\u0410\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u0438 \u0437\u0430\u0431\u0438\u0440\u0430\u0442\u044C \u043D\u0430\u0433\u0440\u0430\u0434\u044B", Boolean(cfg.autoClaim)), check("hideClaimedQuests", "\u0421\u043A\u0440\u044B\u0432\u0430\u0442\u044C \u0437\u0430\u0431\u0440\u0430\u043D\u043D\u044B\u0435 \u043D\u0430\u0433\u0440\u0430\u0434\u044B", cfg.hideClaimedQuests !== false), /* @__PURE__ */ React.createElement("div", { className: "qf-note" }, "\u0415\u0441\u043B\u0438 Discord \u0437\u0430\u043F\u0440\u043E\u0441\u0438\u0442 \u043A\u0430\u043F\u0447\u0443, \u0435\u0451 \u043D\u0443\u0436\u043D\u043E \u043F\u0440\u043E\u0439\u0442\u0438 \u0432\u0440\u0443\u0447\u043D\u0443\u044E."), /* @__PURE__ */ React.createElement("div", { className: "qf-note", style: { marginTop: 16, marginBottom: 4 } }, "\u0422\u0438\u043F\u044B \u0437\u0430\u0434\u0430\u043D\u0438\u0439"), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: "0 16px" } }, [
      ["GAME", "\u0418\u0433\u0440\u044B"],
      ["ACTIVITY", "\u0410\u043A\u0442\u0438\u0432\u043D\u043E\u0441\u0442\u0438 / Roblox"],
      ["ACHIEVEMENT", "\u0410\u0447\u0438\u0432\u043A\u0438 (Discord Says)"],
      ["VIDEO", "\u0412\u0438\u0434\u0435\u043E"]
    ].map(([key, label]) => /* @__PURE__ */ React.createElement("label", { key, className: "qf-check" }, /* @__PURE__ */ React.createElement(
      "input",
      {
        type: "checkbox",
        checked: types.includes(key),
        onChange: (e) => {
          const next = e.target.checked ? [.../* @__PURE__ */ new Set([...types, key])] : types.filter((t) => t !== key);
          if (next.length) onChange({ types: next });
        }
      }
    ), label))))), /* @__PURE__ */ React.createElement("details", null, /* @__PURE__ */ React.createElement("summary", null, "\u0414\u043E\u043F\u043E\u043B\u043D\u0438\u0442\u0435\u043B\u044C\u043D\u044B\u0435 \u043F\u0430\u0440\u0430\u043C\u0435\u0442\u0440\u044B"), /* @__PURE__ */ React.createElement("div", { className: "qf-setting-grid", style: { marginTop: 8 } }, number("gameNoProgressSec", "\u041E\u0436\u0438\u0434\u0430\u043D\u0438\u0435 \u043F\u0435\u0440\u0432\u043E\u0433\u043E \u043F\u0440\u043E\u0433\u0440\u0435\u0441\u0441\u0430, \u0441", 150, 60, 600, 15), number("retryNoQuestsHours", "\u041F\u043E\u0432\u0442\u043E\u0440, \u0435\u0441\u043B\u0438 \u0437\u0430\u0434\u0430\u043D\u0438\u0439 \u043D\u0435\u0442, \u0447", 6, 1, 48, 1), number("maxSessionMinutes", "\u041B\u0438\u043C\u0438\u0442 \u0441\u0435\u0441\u0441\u0438\u0438, \u043C\u0438\u043D", 180, 15, 600, 15))));
  }
  function questCount(n) {
    const form = n % 100 >= 11 && n % 100 <= 14 ? 2 : n % 10 === 1 ? 0 : n % 10 >= 2 && n % 10 <= 4 ? 1 : 2;
    return `${n} ${["\u0437\u0430\u0434\u0430\u043D\u0438\u0435", "\u0437\u0430\u0434\u0430\u043D\u0438\u044F", "\u0437\u0430\u0434\u0430\u043D\u0438\u0439"][form]}`;
  }
  function eligibleRewards(snap) {
    return (snap.quests || []).reduce((sum, q) => sum + (q.eligible ? Number(q.orbs || 0) : 0), 0);
  }
  function SafetyNotice({ farmer, snap }) {
    const [confirmed, setConfirmed] = React.useState(false);
    const [message, setMessage] = React.useState("");
    const safety = snap.safety;
    if (!safety?.paused && !safety?.reportCount) return null;
    const incident = safety.incident;
    const download = () => {
      try {
        const blob = new Blob([JSON.stringify(farmer.safetyReport(), null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `QuestFarmer-safety-${Date.now()}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1e3);
      } catch (e) {
        setMessage(`\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0432\u044B\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u043E\u0442\u0447\u0451\u0442: ${String(e?.message || e)}`);
      }
    };
    return /* @__PURE__ */ React.createElement("section", { className: "qf-safety", "aria-label": "\u041F\u0440\u0435\u0434\u0443\u043F\u0440\u0435\u0436\u0434\u0435\u043D\u0438\u044F Discord" }, safety.paused && /* @__PURE__ */ React.createElement("div", { className: "qf-alert", role: "alert" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("strong", null, "\u041E\u0431\u044F\u0437\u0430\u0442\u0435\u043B\u044C\u043D\u0430\u044F \u043F\u0430\u0443\u0437\u0430"), /* @__PURE__ */ React.createElement("div", null, safety.storageError ? "\u0421\u043E\u0441\u0442\u043E\u044F\u043D\u0438\u0435 \u0437\u0430\u0449\u0438\u0442\u044B \u043D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u0440\u043E\u0447\u0438\u0442\u0430\u0442\u044C \u0438\u043B\u0438 \u0441\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C. \u0417\u0430\u043F\u0443\u0441\u043A\u0438 \u0437\u0430\u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u0430\u043D\u044B." : `\u041F\u0440\u0438\u0447\u0438\u043D\u0430: ${incident?.reason || "\u043E\u0433\u0440\u0430\u043D\u0438\u0447\u0435\u043D\u0438\u0435 Discord"}. \u0424\u0430\u0440\u043C \u0438 \u043F\u043E\u043B\u0443\u0447\u0435\u043D\u0438\u0435 \u043D\u0430\u0433\u0440\u0430\u0434 \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u044B.`), safety.storageError && safety.storageFailure && /* @__PURE__ */ React.createElement("div", null, "\u0414\u0438\u0430\u0433\u043D\u043E\u0441\u0442\u0438\u043A\u0430: ", safety.storageFailure.operation, " / ", safety.storageFailure.code, ". \u041F\u043E\u0434\u0440\u043E\u0431\u043D\u043E\u0441\u0442\u0438 \u2014 \u0432 \u043E\u0442\u0447\u0451\u0442\u0435."), /* @__PURE__ */ React.createElement("div", null, "\u041F\u0435\u0440\u0435\u0437\u0430\u043F\u0443\u0441\u043A, \u0441\u0431\u0440\u043E\u0441 \u0442\u0430\u0439\u043C\u0435\u0440\u0430 \u0438 \u0438\u0441\u0442\u0435\u0447\u0435\u043D\u0438\u0435 \u043E\u0433\u0440\u0430\u043D\u0438\u0447\u0435\u043D\u0438\u044F \u043D\u0435 \u0432\u043E\u0437\u043E\u0431\u043D\u043E\u0432\u043B\u044F\u044E\u0442 \u0444\u0430\u0440\u043C."))), incident && /* @__PURE__ */ React.createElement("p", { className: "qf-note" }, "\u041E\u0431\u043D\u0430\u0440\u0443\u0436\u0435\u043D\u043E ", new Date(incident.detectedAt).toLocaleString(), " \xB7 ", incident.source, incident.until ? ` \xB7 \u0441\u0440\u043E\u043A Discord: ${new Date(incident.until).toLocaleString()}` : ""), /* @__PURE__ */ React.createElement("button", { className: "qf-button qf-button-secondary", onClick: download }, "\u0421\u043A\u0430\u0447\u0430\u0442\u044C \u043E\u0442\u0447\u0451\u0442"), safety.paused && !safety.storageError && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("label", { className: "qf-check" }, /* @__PURE__ */ React.createElement("input", { type: "checkbox", checked: confirmed, onChange: (e) => setConfirmed(e.target.checked) }), "\u042F \u043F\u0440\u043E\u0447\u0438\u0442\u0430\u043B \u043F\u0440\u0435\u0434\u0443\u043F\u0440\u0435\u0436\u0434\u0435\u043D\u0438\u0435 \u0438 \u043E\u0442\u0447\u0451\u0442. \u041F\u043E\u043D\u0438\u043C\u0430\u044E, \u0447\u0442\u043E \u044D\u0442\u043E \u043D\u0435 \u0433\u0430\u0440\u0430\u043D\u0442\u0438\u044F \u0431\u0435\u0437\u043E\u043F\u0430\u0441\u043D\u043E\u0441\u0442\u0438."), /* @__PURE__ */ React.createElement(
      "button",
      {
        className: "qf-button qf-button-secondary",
        disabled: !confirmed || Boolean(safety.activeRestriction) || snap.session?.running,
        onClick: () => {
          const result = farmer.acknowledgeSafety(incident?.id);
          setMessage(result?.ok ? "\u041F\u0430\u0443\u0437\u0430 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0430. \u0420\u0430\u0441\u043F\u0438\u0441\u0430\u043D\u0438\u0435 \u043E\u0441\u0442\u0430\u0432\u043B\u0435\u043D\u043E \u0432\u044B\u043A\u043B\u044E\u0447\u0435\u043D\u043D\u044B\u043C; \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u043E\u0433\u043E \u0437\u0430\u043F\u0443\u0441\u043A\u0430 \u043D\u0435 \u0431\u0443\u0434\u0435\u0442." : "\u041F\u0430\u0443\u0437\u0430 \u043D\u0435 \u0441\u043D\u044F\u0442\u0430: \u043E\u0433\u0440\u0430\u043D\u0438\u0447\u0435\u043D\u0438\u0435 \u0430\u043A\u0442\u0438\u0432\u043D\u043E, \u0441\u0435\u0441\u0441\u0438\u044F \u0435\u0449\u0451 \u043E\u0441\u0442\u0430\u043D\u0430\u0432\u043B\u0438\u0432\u0430\u0435\u0442\u0441\u044F \u0438\u043B\u0438 \u0441\u043E\u0441\u0442\u043E\u044F\u043D\u0438\u0435 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u043E.");
        }
      },
      "\u041F\u043E\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u044C \u043F\u0440\u0435\u0434\u0443\u043F\u0440\u0435\u0436\u0434\u0435\u043D\u0438\u0435"
    ), safety.activeRestriction && /* @__PURE__ */ React.createElement("p", { className: "qf-note" }, "\u041F\u043E\u043A\u0430 Discord \u043E\u0433\u0440\u0430\u043D\u0438\u0447\u0438\u0432\u0430\u0435\u0442 \u043A\u0432\u0435\u0441\u0442\u044B, \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u0435 \u0437\u0430\u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u0430\u043D\u043E.")), message && /* @__PURE__ */ React.createElement("p", { className: "qf-note", role: "status" }, message));
  }
  function FarmHud({ farmer, snap, open }) {
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState("");
    const running = Boolean(snap.session?.running);
    const count = snap.counts?.runnable || 0;
    const rewards = eligibleRewards(snap);
    const failed = error || snap.lastError || snap.loadError || (snap.safety?.paused ? "\u041F\u0440\u0435\u0434\u0443\u043F\u0440\u0435\u0436\u0434\u0435\u043D\u0438\u0435 Discord: \u043E\u0431\u044F\u0437\u0430\u0442\u0435\u043B\u044C\u043D\u0430\u044F \u043F\u0430\u0443\u0437\u0430" : "");
    const next = Math.max(Number(snap.nextRunAt || 0), Number(snap.session?.nextRetry || 0));
    const remaining = Math.max(0, Math.ceil((next - Number(snap.now || Date.now())) / 6e4));
    return /* @__PURE__ */ React.createElement("div", { className: "qf-ui qf-hud", "data-state": failed ? "error" : running ? "running" : "idle" }, /* @__PURE__ */ React.createElement("style", null, integrationCss), /* @__PURE__ */ React.createElement("span", { className: "qf-hud-main", role: "status", title: failed || snap.status?.detail }, /* @__PURE__ */ React.createElement(Icon, { name: running ? "clock" : count ? "orb" : "check", size: 14 }), /* @__PURE__ */ React.createElement("strong", null, snap.safety?.paused ? "\u0410\u0432\u0442\u043E\u0444\u0430\u0440\u043C \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D: \u043F\u0440\u0435\u0434\u0443\u043F\u0440\u0435\u0436\u0434\u0435\u043D\u0438\u0435 Discord" : failed ? "\u0410\u0432\u0442\u043E\u0444\u0430\u0440\u043C: \u043D\u0443\u0436\u043D\u0430 \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0430" : running ? `\u0412\u044B\u043F\u043E\u043B\u043D\u044F\u0435\u0442\u0441\u044F: ${snap.activity?.name || "\u0437\u0430\u0434\u0430\u043D\u0438\u0435"}` : !snap.manualReady ? "\u0417\u0430\u0434\u0430\u043D\u0438\u044F \u0437\u0430\u0433\u0440\u0443\u0436\u0430\u044E\u0442\u0441\u044F\u2026" : count ? `\u041C\u043E\u0436\u043D\u043E \u0432\u044B\u043F\u043E\u043B\u043D\u0438\u0442\u044C ${questCount(count)}` : "\u041D\u0435\u0442 \u0437\u0430\u0434\u0430\u043D\u0438\u0439 \u0434\u043B\u044F \u0430\u0432\u0442\u043E\u0444\u0430\u0440\u043C\u0430")), !running && count > 0 && rewards > 0 && /* @__PURE__ */ React.createElement("span", null, rewards.toLocaleString(), " Orbs \u0437\u0430 \u044D\u0442\u0438 \u0437\u0430\u0434\u0430\u043D\u0438\u044F"), !running && !snap.safety?.paused && snap.config?.enabled !== false && next > 0 && /* @__PURE__ */ React.createElement("span", { title: snap.status?.detail }, remaining ? `\u041F\u0440\u043E\u0432\u0435\u0440\u043A\u0430 \u0447\u0435\u0440\u0435\u0437 ${remaining >= 60 ? `${Math.floor(remaining / 60)} \u0447 ` : ""}${remaining % 60 ? `${remaining % 60} \u043C\u0438\u043D` : ""}` : "\u041F\u0440\u043E\u0432\u0435\u0440\u043A\u0430 \u0441\u043A\u043E\u0440\u043E"), running ? /* @__PURE__ */ React.createElement("button", { className: "qf-text-button", onClick: () => farmer.stop() }, "\u041E\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u0442\u044C") : count > 0 && /* @__PURE__ */ React.createElement("button", { className: "qf-text-button", disabled: busy || !snap.manualReady, onClick: async () => {
      if (busy) return;
      setBusy(true);
      setError("");
      try {
        await farmer.forceRun();
      } catch (e) {
        setError(String(e?.message || e));
      } finally {
        setBusy(false);
      }
    } }, busy ? "\u0417\u0430\u043F\u0443\u0441\u043A\u0430\u044E\u2026" : "\u0412\u044B\u043F\u043E\u043B\u043D\u0438\u0442\u044C"), /* @__PURE__ */ React.createElement("button", { className: "qf-text-button", onClick: open }, snap.safety?.paused ? "\u041E\u0442\u043A\u0440\u044B\u0442\u044C \u043E\u0442\u0447\u0451\u0442" : failed ? "\u041F\u043E\u043A\u0430\u0437\u0430\u0442\u044C \u043F\u0440\u0438\u0447\u0438\u043D\u0443" : "\u0420\u0430\u0441\u043F\u0438\u0441\u0430\u043D\u0438\u0435 \u0438 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438"));
  }
  function FarmPage({ farmer, snap, attached }) {
    const [view, setView] = React.useState("overview");
    const [busy, setBusy] = React.useState(null);
    const [actionError, setActionError] = React.useState("");
    const running = Boolean(snap.session?.running);
    const cfg = snap.config || {};
    const c = snap.counts || {};
    const quests = visibleQuestRows(snap.quests || [], snap.config?.hideClaimedQuests !== false);
    const unclaimed = quests.filter((q) => q.completed && !q.claimed).length;
    const available = quests.filter((q) => !q.completed && q.manualEligible);
    const other = quests.filter((q) => q.completed || !q.manualEligible);
    const error = actionError || snap.lastError || snap.session?.lastResult?.error || snap.loadError;
    const a = snap.activity;
    const pct = a?.target > 0 ? Math.max(0, Math.min(100, a.progress / a.target * 100)) : 0;
    const act = async (name, fn) => {
      if (busy) return;
      setBusy(name);
      setActionError("");
      try {
        await fn();
      } catch (e) {
        setActionError(String(e?.message || e));
      } finally {
        setBusy(null);
      }
    };
    const taskList = (items) => /* @__PURE__ */ React.createElement("ul", { className: "qf-task-list" }, items.map((q) => /* @__PURE__ */ React.createElement("li", { key: q.id, className: "qf-task" }, /* @__PURE__ */ React.createElement("div", { className: "qf-task-name" }, /* @__PURE__ */ React.createElement("strong", null, q.name), /* @__PURE__ */ React.createElement("small", null, q.completed ? q.claimed ? "\u041D\u0430\u0433\u0440\u0430\u0434\u0430 \u0437\u0430\u0431\u0440\u0430\u043D\u0430" : "\u0413\u043E\u0442\u043E\u0432\u043E \u043A \u043F\u043E\u043B\u0443\u0447\u0435\u043D\u0438\u044E" : q.skip ? `\u0422\u043E\u043B\u044C\u043A\u043E \u0432\u0440\u0443\u0447\u043D\u0443\u044E \xB7 ${q.skip}` : "\u0412\u043A\u043B\u044E\u0447\u0435\u043D\u043E \u0432 \u0430\u0432\u0442\u043E\u0444\u0430\u0440\u043C")), q.orbs > 0 && /* @__PURE__ */ React.createElement("span", { className: "qf-task-meta" }, Number(q.orbs).toLocaleString(), " Orbs"), q.manualEligible && /* @__PURE__ */ React.createElement(
      "button",
      {
        className: "qf-button qf-button-secondary",
        disabled: Boolean(busy) || !snap.manualReady || snap.activeQuestIds?.includes(q.id) || snap.queue?.some((item) => item.id === q.id),
        onClick: () => act("one", () => farmer.runOne(q.id))
      },
      snap.queue?.some((item) => item.id === q.id) ? "\u0412 \u043E\u0447\u0435\u0440\u0435\u0434\u0438" : snap.activeQuestIds?.includes(q.id) ? "\u0412\u044B\u043F\u043E\u043B\u043D\u044F\u0435\u0442\u0441\u044F\u2026" : "\u0412\u044B\u043F\u043E\u043B\u043D\u0438\u0442\u044C"
    ))));
    return /* @__PURE__ */ React.createElement("div", { className: "qf-ui qf-farm-page" }, /* @__PURE__ */ React.createElement("style", null, integrationCss), /* @__PURE__ */ React.createElement("header", { className: "qf-farm-heading" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("h1", null, "\u0410\u0432\u0442\u043E\u0444\u0430\u0440\u043C"), /* @__PURE__ */ React.createElement("p", null, "\u0412\u044B\u043F\u043E\u043B\u043D\u0435\u043D\u0438\u0435 \u0437\u0430\u0434\u0430\u043D\u0438\u0439 \u0438 \u0440\u0430\u0441\u043F\u0438\u0441\u0430\u043D\u0438\u0435 \u0437\u0430\u043F\u0443\u0441\u043A\u043E\u0432")), /* @__PURE__ */ React.createElement("div", { className: "qf-actions" }, unclaimed > 0 && !running && /* @__PURE__ */ React.createElement("button", { className: "qf-button qf-button-secondary", disabled: Boolean(busy) || snap.safety?.paused, onClick: () => act("claim", () => farmer.claimAll()) }, "\u0417\u0430\u0431\u0440\u0430\u0442\u044C \u043D\u0430\u0433\u0440\u0430\u0434\u044B \xB7 ", unclaimed), running ? /* @__PURE__ */ React.createElement("button", { className: "qf-button qf-button-stop", onClick: () => {
      farmer.stop();
      setBusy(null);
    } }, /* @__PURE__ */ React.createElement(Icon, { name: "stop" }), "\u041E\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u0442\u044C") : /* @__PURE__ */ React.createElement("button", { className: "qf-button qf-button-primary", disabled: Boolean(busy) || !snap.manualReady || !c.runnable, onClick: () => act("run", () => farmer.forceRun()) }, /* @__PURE__ */ React.createElement(Icon, { name: "play" }), busy === "run" ? "\u0417\u0430\u043F\u0443\u0441\u043A\u0430\u044E\u2026" : "\u0417\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u044C \u0430\u0432\u0442\u043E\u0444\u0430\u0440\u043C"))), /* @__PURE__ */ React.createElement("section", { className: "qf-farm-summary", "aria-label": "\u0421\u043E\u0441\u0442\u043E\u044F\u043D\u0438\u0435 \u0438 \u0440\u0430\u0441\u043F\u0438\u0441\u0430\u043D\u0438\u0435" }, /* @__PURE__ */ React.createElement("span", { className: "qf-status", "data-state": snap.safety?.paused || error ? "error" : running ? "running" : "idle" }, /* @__PURE__ */ React.createElement("span", { className: "qf-status-dot" }), snap.safety?.paused ? "\u041E\u0431\u044F\u0437\u0430\u0442\u0435\u043B\u044C\u043D\u0430\u044F \u043F\u0430\u0443\u0437\u0430" : error ? "\u041D\u0443\u0436\u043D\u0430 \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0430" : running ? "\u0412\u044B\u043F\u043E\u043B\u043D\u044F\u0435\u0442\u0441\u044F" : cfg.enabled === false ? "\u0420\u0430\u0441\u043F\u0438\u0441\u0430\u043D\u0438\u0435 \u0432\u044B\u043A\u043B\u044E\u0447\u0435\u043D\u043E" : "\u041F\u043E \u0440\u0430\u0441\u043F\u0438\u0441\u0430\u043D\u0438\u044E"), /* @__PURE__ */ React.createElement("div", { className: "qf-detail" }, snap.status?.detail || "\u0417\u0430\u0433\u0440\u0443\u0436\u0430\u044E \u0437\u0430\u0434\u0430\u043D\u0438\u044F\u2026"), error && /* @__PURE__ */ React.createElement("div", { className: "qf-alert", role: "alert" }, error), running && a?.target > 0 && /* @__PURE__ */ React.createElement("div", { className: "qf-activity" }, /* @__PURE__ */ React.createElement("div", { className: "qf-activity-heading" }, /* @__PURE__ */ React.createElement("strong", null, a.name), /* @__PURE__ */ React.createElement("span", null, Math.round(pct), "%")), /* @__PURE__ */ React.createElement("div", { className: "qf-progress", role: "progressbar", "aria-label": a.name, "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.round(pct) }, /* @__PURE__ */ React.createElement("div", { style: { width: `${pct}%` } })))), /* @__PURE__ */ React.createElement(SafetyNotice, { key: snap.safety?.incident?.id || "safety", farmer, snap }), /* @__PURE__ */ React.createElement("nav", { className: "qf-subnav", "aria-label": "\u0420\u0430\u0437\u0434\u0435\u043B\u044B \u0430\u0432\u0442\u043E\u0444\u0430\u0440\u043C\u0430" }, [["overview", "\u041E\u0431\u0437\u043E\u0440"], ["settings", "\u041D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438"], ["logs", "\u0416\u0443\u0440\u043D\u0430\u043B"]].map(([key, label]) => /* @__PURE__ */ React.createElement("button", { key, "aria-pressed": view === key, onClick: () => setView(key) }, label))), view === "overview" && /* @__PURE__ */ React.createElement("section", { "aria-label": "\u041E\u0431\u0437\u043E\u0440 \u0437\u0430\u0434\u0430\u043D\u0438\u0439" }, snap.queue?.length > 0 && /* @__PURE__ */ React.createElement("section", { "aria-label": "\u041E\u0447\u0435\u0440\u0435\u0434\u044C \u0432\u044B\u043F\u043E\u043B\u043D\u0435\u043D\u0438\u044F" }, /* @__PURE__ */ React.createElement("h2", null, "\u041E\u0447\u0435\u0440\u0435\u0434\u044C \xB7 ", snap.queue.length), /* @__PURE__ */ React.createElement("ol", null, snap.queue.map((item) => /* @__PURE__ */ React.createElement("li", { key: item.id }, item.name, " ", /* @__PURE__ */ React.createElement("button", { className: "qf-text-button", onClick: () => farmer.removeQueued(item.id) }, "\u0423\u0431\u0440\u0430\u0442\u044C"))))), /* @__PURE__ */ React.createElement("div", { className: "qf-metrics" }, /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("strong", null, c.runnable || 0), " \u0434\u043B\u044F \u0430\u0432\u0442\u043E\u0444\u0430\u0440\u043C\u0430"), /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("strong", null, eligibleRewards(snap).toLocaleString()), " Orbs \u0434\u043E\u0441\u0442\u0443\u043F\u043D\u044B"), /* @__PURE__ */ React.createElement("span", null, /* @__PURE__ */ React.createElement("strong", null, unclaimed), " \u043D\u0430\u0433\u0440\u0430\u0434 \u043A \u043F\u043E\u043B\u0443\u0447\u0435\u043D\u0438\u044E")), available.length ? taskList(available) : /* @__PURE__ */ React.createElement("p", { className: "qf-note" }, "\u041F\u043E\u0434\u0445\u043E\u0434\u044F\u0449\u0438\u0445 \u0437\u0430\u0434\u0430\u043D\u0438\u0439 \u043F\u043E\u043A\u0430 \u043D\u0435\u0442. \u041F\u0440\u043E\u0432\u0435\u0440\u043A\u0430 \u0431\u0443\u0434\u0435\u0442 \u0432\u044B\u043F\u043E\u043B\u043D\u0435\u043D\u0430 \u043F\u043E \u0440\u0430\u0441\u043F\u0438\u0441\u0430\u043D\u0438\u044E."), other.length > 0 && /* @__PURE__ */ React.createElement("details", null, /* @__PURE__ */ React.createElement("summary", null, "\u0412\u044B\u043F\u043E\u043B\u043D\u0435\u043D\u043D\u044B\u0435 \u0438 \u043D\u0435\u043F\u043E\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u0435\u043C\u044B\u0435 (", other.length, ")"), taskList(other))), view === "settings" && /* @__PURE__ */ React.createElement(SettingsPane, { cfg, onChange: (patch) => farmer.updateSettings?.(patch) }), view === "logs" && /* @__PURE__ */ React.createElement("section", { "aria-label": "\u0416\u0443\u0440\u043D\u0430\u043B \u0430\u0432\u0442\u043E\u0444\u0430\u0440\u043C\u0430" }, /* @__PURE__ */ React.createElement("div", { className: "qf-view-heading" }, /* @__PURE__ */ React.createElement("span", { className: "qf-note" }, "\u041F\u043E\u0441\u043B\u0435\u0434\u043D\u0438\u0435 \u0441\u043E\u0431\u044B\u0442\u0438\u044F"), /* @__PURE__ */ React.createElement("button", { className: "qf-text-button", onClick: () => farmer.clearLogs?.() }, "\u041E\u0447\u0438\u0441\u0442\u0438\u0442\u044C \u0436\u0443\u0440\u043D\u0430\u043B")), snap.session?.lastResult && /* @__PURE__ */ React.createElement("p", { className: "qf-note" }, "\u041F\u043E\u0441\u043B\u0435\u0434\u043D\u044F\u044F \u0441\u0435\u0441\u0441\u0438\u044F: ", snap.session.lastResult.done ?? 0, " \u0432\u044B\u043F\u043E\u043B\u043D\u0435\u043D\u043E \xB7 ", snap.session.lastResult.failed ?? 0, " \u043E\u0448\u0438\u0431\u043E\u043A \xB7 ", snap.session.lastResult.orbs ?? 0, " Orbs"), (snap.logs || []).length ? snap.logs.slice(-120).reverse().map((l, i) => /* @__PURE__ */ React.createElement("div", { key: i, style: styles.log }, /* @__PURE__ */ React.createElement("span", { style: { ...styles.logTime, color: "var(--qf-muted)" } }, fmtTime(l.t)), /* @__PURE__ */ React.createElement("span", { style: { overflowWrap: "anywhere", color: l.level === "error" ? "var(--text-danger, #f28385)" : "var(--qf-text)" } }, l.text))) : /* @__PURE__ */ React.createElement("p", { className: "qf-note" }, "\u041F\u043E\u043A\u0430 \u043D\u0435\u0442 \u0441\u043E\u0431\u044B\u0442\u0438\u0439.")), /* @__PURE__ */ React.createElement("footer", { className: "qf-farm-footer" }, /* @__PURE__ */ React.createElement("span", null, "QuestFarmer v", snap.version, " \xB7 ", attached, " \u043A\u0430\u0440\u0442\u043E\u0447\u0435\u043A"), /* @__PURE__ */ React.createElement("button", { className: "qf-text-button", disabled: Boolean(busy) || running, onClick: () => act("reset", () => farmer.resetSchedule()) }, "\u0421\u0431\u0440\u043E\u0441\u0438\u0442\u044C \u0442\u0430\u0439\u043C\u0435\u0440")));
  }
  function questIdInProps(props, ids) {
    for (const id of [props?.questId, props?.quest?.id]) {
      if (id != null && ids.has(String(id))) return String(id);
    }
    return null;
  }
  function resolveQuestCard(element, ids) {
    if (element.closest("[data-qf-owned]")) return null;
    let id = null;
    let owner = null;
    for (let node = element, depth = 0; node && depth < 8; node = node.parentElement, depth++) {
      const explicit = node.getAttribute?.("data-quest-id");
      if (ids.has(explicit)) {
        id = explicit;
        owner = node;
        break;
      }
      const src = node.getAttribute?.("src") || node.getAttribute?.("href") || "";
      const assetId = /\/quests\/(\d+)(?:\/|[?#]|$)/.exec(src)?.[1];
      if (assetId && ids.has(assetId)) {
        id = assetId;
        break;
      }
      const key = Object.keys(node).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
      let fiber = key ? node[key] : null;
      for (let i = 0; fiber && i < 24; i++, fiber = fiber.return) {
        const found = questIdInProps(fiber.memoizedProps, ids) || questIdInProps(fiber.pendingProps, ids);
        if (!found) continue;
        id = found;
        const stack = [fiber];
        for (let visited = 0; stack.length && visited < 100; visited++) {
          const current = stack.pop();
          if (current?.stateNode instanceof HTMLElement && current.stateNode.contains(element)) {
            owner = current.stateNode;
            break;
          }
          for (let child = current?.child; child; child = child.sibling) stack.push(child);
        }
        break;
      }
      if (id) break;
    }
    if (!id) return null;
    const nativeCard = element.closest('[class*="questTile"], [class*="questCard"], [class*="QuestCard"], [class*="QuestTile"]');
    if (nativeCard) owner = nativeCard;
    if (!owner) {
      for (let node = element.parentElement, i = 0; node && i < 8; node = node.parentElement, i++) {
        if (node === document.body || node.matches('main, [role="main"]')) break;
        if (node.querySelector("img, video") && node.querySelector('button, [role="button"]')) {
          owner = node;
          break;
        }
      }
    }
    if (!owner || owner === document.body || owner.matches('main, [role="main"], button, a, img, video')) return null;
    const assetIds = new Set(Array.from(owner.querySelectorAll("img[src]"), (img) => /\/quests\/(\d+)(?:\/|[?#]|$)/.exec(img.getAttribute("src") || "")?.[1]).filter((x) => x && ids.has(x)));
    if (assetIds.size > 1) return null;
    return { id, card: owner };
  }
  function CardControl({ farmer, q, snap }) {
    const [pending, setPending] = React.useState(false);
    const [message, setMessage] = React.useState("");
    const running = Boolean(snap.session.running);
    const active = running && (snap.activeQuestIds?.includes(q.id) || snap.activity?.questIds?.map(String).includes(q.id));
    const queued = snap.queue?.find((item) => item.id === q.id);
    const ready = Boolean(snap.manualReady);
    const disabled = pending || active || Boolean(queued) || !q.manualEligible || !ready;
    const pct = q.target > 0 ? Math.max(0, Math.min(100, q.progress / q.target * 100)) : 0;
    const progress = q.type === "ACHIEVEMENT" ? `${q.progress}/${q.target}` : `${Math.floor(q.progress / 60)}:${String(q.progress % 60).padStart(2, "0")} / ${Math.floor(q.target / 60)}:${String(q.target % 60).padStart(2, "0")}`;
    return /* @__PURE__ */ React.createElement(
      "div",
      {
        className: `qf-ui qf-card${q.completed ? " qf-card-done" : ""}`,
        onClick: (e) => e.stopPropagation(),
        onMouseDown: (e) => e.stopPropagation()
      },
      /* @__PURE__ */ React.createElement("div", { className: "qf-card-row" }, /* @__PURE__ */ React.createElement("span", { className: "qf-card-label", title: q.completed ? "QuestFarmer: \u0437\u0430\u0434\u0430\u043D\u0438\u0435 \u0432\u044B\u043F\u043E\u043B\u043D\u0435\u043D\u043E" : q.skip ? `\u0412 \u0430\u0432\u0442\u043E\u0444\u0430\u0440\u043C\u0435: ${q.skip}` : "\u0412\u043A\u043B\u044E\u0447\u0435\u043D\u043E \u0432 \u0430\u0432\u0442\u043E\u0444\u0430\u0440\u043C" }, /* @__PURE__ */ React.createElement(Icon, { name: q.completed ? "check" : "clock", size: 14 }), q.completed ? q.claimed ? "\u041D\u0430\u0433\u0440\u0430\u0434\u0430 \u0437\u0430\u0431\u0440\u0430\u043D\u0430" : "\u0413\u043E\u0442\u043E\u0432\u043E \u043A \u043F\u043E\u043B\u0443\u0447\u0435\u043D\u0438\u044E" : active ? "\u0412 \u0440\u0430\u0431\u043E\u0442\u0435" : queued ? `\u0412 \u043E\u0447\u0435\u0440\u0435\u0434\u0438 \xB7 ${queued.position}` : q.manualEligible ? progress : "\u0420\u0443\u0447\u043D\u043E\u0435 \u0432\u044B\u043F\u043E\u043B\u043D\u0435\u043D\u0438\u0435"), !q.completed && q.manualEligible && /* @__PURE__ */ React.createElement(
        "button",
        {
          type: "button",
          className: "qf-button qf-button-secondary",
          disabled,
          title: q.manualSkip || (!ready ? "\u0416\u0434\u0443 \u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0438 Discord" : queued ? `\u041E\u0447\u0435\u0440\u0435\u0434\u044C: ${queued.position}` : running ? "\u0414\u043E\u0431\u0430\u0432\u0438\u0442\u044C \u0432 \u043E\u0447\u0435\u0440\u0435\u0434\u044C \u0432\u044B\u043F\u043E\u043B\u043D\u0435\u043D\u0438\u044F" : "\u0412\u044B\u043F\u043E\u043B\u043D\u0438\u0442\u044C \u0442\u043E\u043B\u044C\u043A\u043E \u044D\u0442\u043E \u0437\u0430\u0434\u0430\u043D\u0438\u0435"),
          onClick: async (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (disabled) return;
            setPending(true);
            setMessage("");
            try {
              const result = await farmer.runOne(q.id);
              if (!result?.ran) setMessage(result?.reason === "not-ready" ? "\u0416\u0434\u0443 \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u044F \u0438 \u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0438 \u0437\u0430\u0434\u0430\u043D\u0438\u0439" : result?.reason === "safety-paused" ? "\u041E\u0431\u044F\u0437\u0430\u0442\u0435\u043B\u044C\u043D\u0430\u044F \u0437\u0430\u0449\u0438\u0442\u043D\u0430\u044F \u043F\u0430\u0443\u0437\u0430" : result?.reason === "active" ? "\u0417\u0430\u0434\u0430\u043D\u0438\u0435 \u0443\u0436\u0435 \u0432\u044B\u043F\u043E\u043B\u043D\u044F\u0435\u0442\u0441\u044F" : "\u0417\u0430\u0434\u0430\u043D\u0438\u0435 \u043F\u043E\u043A\u0430 \u043D\u0435\u043B\u044C\u0437\u044F \u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u044C");
            } catch (error) {
              setMessage(String(error?.message || error));
            } finally {
              setPending(false);
            }
          }
        },
        !active && !pending && !queued && /* @__PURE__ */ React.createElement(Icon, { name: "play", size: 14 }),
        active ? "\u0412\u044B\u043F\u043E\u043B\u043D\u044F\u0435\u0442\u0441\u044F\u2026" : queued ? `\u0412 \u043E\u0447\u0435\u0440\u0435\u0434\u0438 \xB7 ${queued.position}` : pending ? "\u0414\u043E\u0431\u0430\u0432\u043B\u044F\u044E\u2026" : "\u0412\u044B\u043F\u043E\u043B\u043D\u0438\u0442\u044C"
      )),
      queued && /* @__PURE__ */ React.createElement("button", { className: "qf-text-button", onClick: () => farmer.removeQueued(q.id) }, "\u0423\u0431\u0440\u0430\u0442\u044C \u0438\u0437 \u043E\u0447\u0435\u0440\u0435\u0434\u0438"),
      (active || !q.completed && q.progress > 0) && /* @__PURE__ */ React.createElement("div", { className: "qf-progress", role: "progressbar", "aria-label": `\u041F\u0440\u043E\u0433\u0440\u0435\u0441\u0441: ${q.name}`, "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.round(pct) }, /* @__PURE__ */ React.createElement("div", { style: { width: `${pct}%` } })),
      active && /* @__PURE__ */ React.createElement("div", { className: "qf-note" }, snap.activity?.note || "\u0412\u044B\u043F\u043E\u043B\u043D\u044F\u044E \u0437\u0430\u0434\u0430\u043D\u0438\u0435"),
      !q.completed && q.skip && !active && /* @__PURE__ */ React.createElement("div", { className: "qf-note", title: q.manualSkip || q.skip }, q.manualEligible ? `\u0422\u043E\u043B\u044C\u043A\u043E \u0432\u0440\u0443\u0447\u043D\u0443\u044E \xB7 ${q.skip}` : q.manualSkip || q.skip),
      message && /* @__PURE__ */ React.createElement("div", { role: "alert", className: "qf-note", style: { color: "var(--text-danger, #f28385)" } }, message)
    );
  }
  var stopIntegration = null;
  function resolveQuestNavigation() {
    const all = /^(?:все задания|all quests|all)$/i;
    const completed = /^(?:заверш[её]нные задания|completed quests|completed)$/i;
    const label = (node) => (node.textContent || "").trim().replace(/\s+/g, " ");
    for (const bar of document.querySelectorAll('[role="tablist"], [class*="tabBar"], [class*="TabBar"]')) {
      if (bar.closest('[data-qf-owned], [role="dialog"]')) continue;
      const tabs2 = [...bar.querySelectorAll('[role="tab"], button, [role="button"]')].filter((node) => !node.closest("[data-qf-owned]"));
      const first2 = tabs2.find((node) => all.test(label(node)));
      const last2 = tabs2.find((node) => completed.test(label(node)));
      if (first2 && last2 && first2.parentElement === last2.parentElement) return { bar: first2.parentElement, tabs: [first2, last2] };
    }
    const tabs = [...document.querySelectorAll('[role="tab"], button, [role="button"]')].filter((node) => !node.closest('[data-qf-owned], [role="dialog"]'));
    const first = tabs.find((node) => all.test(label(node)));
    const last = tabs.find((node) => completed.test(label(node)) && node.parentElement === first?.parentElement);
    return first && last ? { bar: first.parentElement, tabs: [first, last] } : null;
  }
  function questContentBranch(container, nav) {
    for (const tab of nav.querySelectorAll("[aria-controls]")) {
      const pane = document.getElementById(tab.getAttribute("aria-controls"));
      if (pane?.contains(container) && !pane.contains(nav)) return pane;
    }
    for (let node = container; node && node !== document.body && !node.contains(nav); node = node.parentElement) {
      if (/^(?:auto|scroll)$/.test(window.getComputedStyle(node).overflowY)) return node;
    }
    for (let root2 = container.parentElement; root2 && root2 !== document.body; root2 = root2.parentElement) {
      if (!root2.contains(nav)) continue;
      let branch = container;
      while (branch.parentElement !== root2 && branch.parentElement) branch = branch.parentElement;
      if (!branch.contains(nav)) return branch;
      break;
    }
    return container;
  }
  function mountQuestFarmerIntegration(farmer) {
    let page = null;
    let navigation = null;
    let pane = null;
    let selected = false;
    const hidden = /* @__PURE__ */ new Map();
    const nativeState = /* @__PURE__ */ new Map();
    const controls = /* @__PURE__ */ new Map();
    const claimedFilter = createClaimedQuestFilter();
    let disposed = false;
    let pending = null;
    const remove = (entry) => {
      try {
        entry.root.unmount();
      } catch {
      }
      entry.host.remove();
    };
    const restore = () => {
      for (const [node, previous] of hidden) {
        if (node.style.getPropertyValue("display") === "none" && node.style.getPropertyPriority("display") === "important") {
          if (previous.display) node.style.setProperty("display", previous.display, previous.priority);
          else node.style.removeProperty("display");
        }
      }
      hidden.clear();
      for (const [tab, previous] of nativeState) {
        if (tab.className === previous.appliedClass) tab.className = previous.className;
        if (tab.getAttribute("aria-selected") === "false") {
          if (previous.selected == null) tab.removeAttribute("aria-selected");
          else tab.setAttribute("aria-selected", previous.selected);
        }
      }
      nativeState.clear();
    };
    const closeTab = () => {
      selected = false;
      restore();
      if (pane) pane.host.hidden = true;
      if (navigation) {
        navigation.button.setAttribute("aria-selected", "false");
        navigation.button.className = navigation.tabs.find((tab) => tab.getAttribute("aria-selected") !== "true" && !/selected/i.test(tab.className))?.className || "";
        for (const [property, value] of Object.entries(navigation.inactiveStyle || {})) navigation.button.style.setProperty(property, value);
      }
    };
    const openTab = () => {
      if (!navigation || !pane) return;
      selected = true;
      refresh();
      navigation.button.focus();
    };
    const onNativeClick = (e) => {
      if (navigation?.tabs.some((tab) => tab.contains(e.target))) closeTab();
    };
    document.addEventListener("click", onNativeClick, true);
    window.addEventListener("questfarmer-open-native", openTab);
    const clear = () => {
      closeTab();
      claimedFilter.clear();
      if (navigation) navigation.button.remove();
      navigation = null;
      if (pane) remove(pane);
      pane = null;
      for (const entry of controls.values()) remove(entry);
      controls.clear();
      if (page) remove(page);
      page = null;
    };
    const refresh = () => {
      pending = null;
      if (disposed) return;
      if (!onQuestsPage() && !(page?.host.isConnected && document.querySelector('[role="dialog"], [aria-modal="true"]'))) {
        clear();
        return;
      }
      let snap;
      try {
        snap = farmer.snapshot();
      } catch {
        return;
      }
      const rows = new Map(snap.quests.map((q) => [q.id, q]));
      for (const id of snap.claimedQuestIds || []) {
        if (!rows.has(id)) rows.set(id, { id, claimed: true });
      }
      const ids = new Set(rows.keys());
      const found = /* @__PURE__ */ new Map();
      const ambiguous = /* @__PURE__ */ new Set();
      for (const element of document.querySelectorAll('img, button, [data-quest-id], [class*="questTile"], [class*="questCard"]')) {
        const result = resolveQuestCard(element, ids);
        if (!result) continue;
        if (result.card.closest('[role="dialog"], [aria-modal="true"]')) continue;
        if (found.has(result.card) && found.get(result.card) !== result.id) ambiguous.add(result.card);
        found.set(result.card, result.id);
      }
      for (const card of ambiguous) found.delete(card);
      for (const [outer, outerId] of [...found]) {
        for (const [inner, innerId] of [...found]) {
          if (outer === inner || !outer.contains(inner)) continue;
          if (outerId === innerId) found.delete(inner);
          else {
            found.delete(outer);
            break;
          }
        }
      }
      claimedFilter.sync(found, rows, snap.config?.hideClaimedQuests !== false);
      for (const [card, entry] of controls) {
        if (!card.isConnected || !entry.host.isConnected || found.get(card) !== entry.id || rows.get(entry.id)?.claimed) {
          remove(entry);
          controls.delete(card);
        }
      }
      for (const [card, id] of found) {
        if (rows.get(id)?.claimed) continue;
        let entry = controls.get(card);
        if (!entry) {
          const host2 = document.createElement("div");
          host2.dataset.qfOwned = "card";
          host2.dataset.qfQuestId = id;
          host2.style.cssText = "width:100%;min-width:0;box-sizing:border-box;align-self:stretch;flex-shrink:0;grid-column:1/-1";
          card.appendChild(host2);
          entry = { id, host: host2, root: createRoot(host2) };
          controls.set(card, entry);
        }
        entry.root.render(/* @__PURE__ */ React.createElement(CardControl, { farmer, q: rows.get(id), snap }));
      }
      const nativeTiles = [...document.querySelectorAll('article[class*="questTile"], article[class*="questCard"]')].filter((node) => !node.closest('[data-qf-owned], [role="dialog"]'));
      const anchors = nativeTiles.length ? nativeTiles : [...found.keys()];
      let grid = anchors[0]?.parentElement || null;
      while (grid && !anchors.every((card) => grid.contains(card))) grid = grid.parentElement;
      const container = grid?.parentElement || document.querySelector('[class*="questsPage"], [class*="questHome"], main, [role="main"]') || (pane?.container.isConnected ? pane.container : null);
      if (container && container !== document.body && container !== document.documentElement && !container.closest("[data-qf-owned]")) {
        if (page && (!page.host.isConnected || page.host.parentElement !== container)) {
          remove(page);
          page = null;
        }
        if (!page) {
          const host2 = document.createElement("section");
          host2.dataset.qfOwned = "page";
          host2.setAttribute("aria-label", "\u0421\u0432\u043E\u0434\u043A\u0430 \u0430\u0432\u0442\u043E\u0444\u0430\u0440\u043C\u0430");
          host2.style.cssText = "max-width:100%;min-width:0;box-sizing:border-box;grid-column:1/-1";
          container.insertBefore(host2, grid?.parentElement === container ? grid : container.firstChild);
          page = { host: host2, root: createRoot(host2) };
        }
        page.root.render(/* @__PURE__ */ React.createElement(FarmHud, { farmer, snap, open: openTab }));
        const nav = resolveQuestNavigation();
        if (navigation && (!navigation.button.isConnected || nav?.bar !== navigation.bar)) {
          closeTab();
          navigation.button.remove();
          navigation = null;
          if (pane) remove(pane);
          pane = null;
        }
        if (nav && !navigation) {
          const button = document.createElement("button");
          button.type = "button";
          button.dataset.qfOwned = "tab";
          button.id = "qf-autofarm-tab";
          button.setAttribute("role", "tab");
          button.setAttribute("aria-controls", "qf-autofarm-pane");
          button.addEventListener("click", (e) => {
            e.stopPropagation();
            openTab();
          });
          button.addEventListener("keydown", (e) => {
            const target = e.key === "ArrowLeft" || e.key === "Home" ? nav.tabs[e.key === "Home" ? 0 : nav.tabs.length - 1] : e.key === "ArrowRight" ? nav.tabs[0] : null;
            if (target) {
              e.preventDefault();
              e.stopPropagation();
              closeTab();
              target.focus();
              target.click();
            } else if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              openTab();
            } else if (e.key === "End") {
              e.preventDefault();
              e.stopPropagation();
              button.focus();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              closeTab();
              (nav.tabs.find((tab) => tab.getAttribute("aria-selected") === "true") || nav.tabs[0]).focus();
            }
          });
          nav.bar.appendChild(button);
          navigation = { ...nav, button };
        }
        if (navigation) {
          const branch = questContentBranch(container, navigation.bar);
          if (branch && pane?.container !== branch) {
            closeTab();
            if (pane) remove(pane);
            const host2 = document.createElement("section");
            host2.dataset.qfOwned = "pane";
            host2.id = "qf-autofarm-pane";
            host2.setAttribute("role", "tabpanel");
            host2.setAttribute("aria-labelledby", "qf-autofarm-tab");
            host2.style.cssText = "width:100%;min-width:0;flex:1 0 auto;grid-column:1/-1";
            host2.hidden = true;
            branch.appendChild(host2);
            pane = { container: branch, host: host2, root: createRoot(host2) };
          }
          const activeTab = navigation.tabs.find((tab) => tab.getAttribute("aria-selected") === "true" || /selected/i.test(tab.className)) || navigation.tabs[0];
          const baseClass = nativeState.get(activeTab)?.className || activeTab.className;
          const inactiveClass = baseClass.split(/\s+/).filter((c) => !/^selected(?:_|$)/i.test(c)).join(" ");
          navigation.button.className = `${selected ? baseClass : inactiveClass} qf-native-tab`;
          const readStyle = (node) => {
            const computed = window.getComputedStyle(node);
            return Object.fromEntries(["font-family", "font-size", "font-weight", "color", "background-color", "border-top", "border-right", "border-bottom", "border-left", "border-radius", "padding", "height", "line-height", "box-shadow"].map((property) => [property, computed.getPropertyValue(property)]));
          };
          if (!selected || !navigation.activeStyle) {
            navigation.activeStyle = readStyle(activeTab);
            navigation.inactiveStyle = readStyle(navigation.tabs.find((tab) => tab !== activeTab) || activeTab);
          }
          for (const [property, value] of Object.entries((selected ? navigation.activeStyle : navigation.inactiveStyle) || {})) {
            if (value) navigation.button.style.setProperty(property, value);
          }
          navigation.button.style.cursor = "pointer";
          navigation.button.setAttribute("aria-selected", String(selected));
          navigation.button.setAttribute("aria-label", `\u0410\u0432\u0442\u043E\u0444\u0430\u0440\u043C: \u043C\u043E\u0436\u043D\u043E \u0432\u044B\u043F\u043E\u043B\u043D\u0438\u0442\u044C ${questCount(snap.counts?.runnable || 0)}`);
          const count = snap.counts?.runnable || 0;
          const text = `\u0410\u0432\u0442\u043E\u0444\u0430\u0440\u043C${count ? ` \xB7 ${count}` : ""}`;
          if (navigation.button.textContent !== text) navigation.button.textContent = text;
          if (pane) {
            pane.root.render(/* @__PURE__ */ React.createElement(FarmPage, { farmer, snap, attached: controls.size }));
            pane.host.hidden = !selected;
            if (selected) {
              for (const tab of navigation.tabs) {
                if (!nativeState.has(tab)) nativeState.set(tab, { className: tab.className, selected: tab.getAttribute("aria-selected"), appliedClass: tab.className.split(/\s+/).filter((c) => !/^selected(?:_|$)/i.test(c)).join(" ") });
                tab.className = nativeState.get(tab).appliedClass;
                tab.setAttribute("aria-selected", "false");
              }
              for (const child of pane.container.children) {
                if (!(child instanceof HTMLElement) || child === pane.host || child.contains(navigation.bar)) continue;
                if (!hidden.has(child)) hidden.set(child, { display: child.style.getPropertyValue("display"), priority: child.style.getPropertyPriority("display") });
                child.style.setProperty("display", "none", "important");
              }
            }
          }
        }
      } else if (page) {
        clear();
      }
    };
    const schedule = () => {
      if (!disposed && !pending) pending = setTimeout(refresh, 200);
    };
    const observer = new MutationObserver((records) => {
      if (records.some((r) => r.type === "attributes")) claimedFilter.repair();
      if (records.some((r) => !r.target.closest?.("[data-qf-owned]") && [...r.addedNodes, ...r.removedNodes].some((n) => !(n instanceof HTMLElement && n.dataset.qfOwned)))) schedule();
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["style"] });
    const interval = setInterval(refresh, 1e3);
    refresh();
    return () => {
      disposed = true;
      observer.disconnect();
      document.removeEventListener("click", onNativeClick, true);
      window.removeEventListener("questfarmer-open-native", openTab);
      clearInterval(interval);
      clearTimeout(pending);
      clear();
    };
  }
  function mountQuestFarmerUI(farmer) {
    if (stopIntegration) return;
    farmer.openPanel = showQuestFarmerPanel;
    stopIntegration = mountQuestFarmerIntegration(farmer);
  }
  function unmountQuestFarmerUI() {
    stopIntegration?.();
    stopIntegration = null;
    try {
      root?.unmount?.();
    } catch {
    }
    root = null;
    host?.remove();
    host = null;
  }

  // vencord-plugin/managed-plugins.ts
  function registerManagedPlugin(makePlugin) {
    if (typeof window === "undefined") return;
    let attempts = 0;
    const timer = setInterval(async () => {
      const V = window.Vencord;
      if (!V?.Plugins?.plugins || !V?.Webpack?.Common?.React?.createElement || typeof V?.Webpack?.Common?.createRoot !== "function") {
        if (++attempts >= 120) clearInterval(timer);
        return;
      }
      clearInterval(timer);
      try {
        await V.Webpack.onceReady;
        await new Promise((resolve) => setTimeout(resolve, 0));
        const plugin = makePlugin(V);
        if (V.Plugins.plugins[plugin.name]) return;
        V.Settings.plugins[plugin.name] ??= { enabled: true };
        V.Plugins.plugins[plugin.name] = plugin;
        if (V.Settings.plugins[plugin.name].enabled !== false) {
          if (typeof V.Plugins.startPlugin === "function") V.Plugins.startPlugin(plugin);
          else {
            plugin.start();
            plugin.started = true;
          }
        }
      } catch {
        console.error("[Managed plugins] Plugin registration failed");
      }
    }, 500);
  }

  // vencord-plugin/questFarmer/standalone.ts
  (function bootStandaloneQuestFarmer() {
    if (typeof window === "undefined") return;
    if (window.__QF_STANDALONE_LOADED__) return;
    window.__QF_STANDALONE_LOADED__ = true;
    let farmer = null;
    function startFarmer() {
      if (farmer || window.DQ?._state?.booted) return;
      farmer = createQuestFarmer();
      const store = window.Vencord?.Settings?.plugins?.QuestFarmer || {};
      const types = [
        store.includeGame !== false && "GAME",
        store.includeActivity !== false && "ACTIVITY",
        store.includeAchievement !== false && "ACHIEVEMENT",
        store.includeVideo && "VIDEO"
      ].filter(Boolean);
      farmer._state.onSettingsChange = (patch) => {
        const keys = {
          everyHours: "intervalHours",
          autoEnroll: "autoEnroll",
          autoClaim: "autoClaim",
          onlyOrbs: "onlyOrbs",
          hideClaimedQuests: "hideClaimedQuests",
          gameNoProgressSec: "gameNoProgressSec",
          retryNoQuestsHours: "retryNoQuestsHours",
          maxSessionMinutes: "maxSessionMinutes"
        };
        for (const [key, native] of Object.entries(keys)) if (patch[key] !== void 0) store[native] = patch[key];
        if (patch.types) for (const [type, key] of Object.entries({
          GAME: "includeGame",
          ACTIVITY: "includeActivity",
          ACHIEVEMENT: "includeAchievement",
          VIDEO: "includeVideo"
        })) store[key] = patch.types.includes(type);
      };
      farmer.boot({
        ...store.intervalHours !== void 0 ? { everyHours: store.intervalHours } : {},
        ...store.autoEnroll !== void 0 ? { autoEnroll: store.autoEnroll } : {},
        ...store.autoClaim !== void 0 ? { autoClaim: store.autoClaim } : {},
        ...store.onlyOrbs !== void 0 ? { onlyOrbs: store.onlyOrbs } : {},
        ...store.hideClaimedQuests !== void 0 ? { hideClaimedQuests: store.hideClaimedQuests } : {},
        gameNoProgressSec: store.gameNoProgressSec,
        retryNoQuestsHours: store.retryNoQuestsHours,
        maxSessionMinutes: store.maxSessionMinutes,
        types: types.length ? types : ["GAME"]
      });
      mountQuestFarmerUI(farmer);
    }
    function stopFarmer() {
      unmountQuestFarmerUI();
      farmer?.shutdown?.();
      farmer = null;
    }
    registerManagedPlugin((V) => {
      const React2 = V.Webpack.Common.React;
      return {
        name: "QuestFarmer",
        description: "\u041A\u043D\u043E\u043F\u043A\u0438 \u0432\u044B\u043F\u043E\u043B\u043D\u0435\u043D\u0438\u044F \u043D\u0430 \u043A\u0430\u0440\u0442\u043E\u0447\u043A\u0430\u0445 \u0437\u0430\u0434\u0430\u043D\u0438\u0439, \u0441\u0442\u0430\u0442\u0443\u0441, \u0440\u0430\u0441\u043F\u0438\u0441\u0430\u043D\u0438\u0435 \u0438 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438 \u0432\u043E \u0432\u043A\u043B\u0430\u0434\u043A\u0435 \u0437\u0430\u0434\u0430\u043D\u0438\u0439.",
        authors: [{ name: "reka", id: 0n }],
        started: false,
        enabledByDefault: true,
        options: {},
        settingsAboutComponent: () => React2.createElement(
          "div",
          null,
          "\u0423\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0438\u0435 \u2014 \u0432\u043E \u0432\u043A\u043B\u0430\u0434\u043A\u0435 \xAB\u0410\u0432\u0442\u043E\u0444\u0430\u0440\u043C\xBB. \xAB\u0412\u044B\u043F\u043E\u043B\u043D\u0438\u0442\u044C\xBB \u043D\u0430 \u0441\u043E\u0441\u0435\u0434\u043D\u0438\u0445 \u043A\u0430\u0440\u0442\u043E\u0447\u043A\u0430\u0445 \u0434\u043E\u0431\u0430\u0432\u043B\u044F\u0435\u0442 \u0437\u0430\u0434\u0430\u043D\u0438\u044F \u0432 \u043E\u0447\u0435\u0440\u0435\u0434\u044C."
        ),
        start: startFarmer,
        stop: stopFarmer
      };
    });
  })();

  // vencord-plugin/voiceProfileGradientFix/core.ts
  function createVoiceProfileGradientFix(deps) {
    let stopped = true, timer = null, busy = false, generation = 0;
    const attempted = /* @__PURE__ */ new Set();
    const subscriptions = [];
    function participants() {
      const channelId = deps.selected.getVoiceChannelId();
      if (!channelId) return [];
      const states = deps.voice.getVoiceStatesForChannel(channelId) || {};
      const ids = Object.values(states).map((state) => state.userId || state.user_id).filter(Boolean);
      const own = deps.users.getCurrentUser()?.id;
      if (own) ids.push(own);
      return [...new Set(ids)];
    }
    function schedule() {
      if (stopped || timer !== null) return;
      timer = deps.setTimeout(() => {
        timer = null;
        void drain();
      }, 500);
    }
    async function drain() {
      if (busy || stopped) return;
      busy = true;
      const token = generation;
      try {
        while (!stopped && token === generation) {
          const id = participants().find((id2) => !attempted.has(id2) && !deps.profiles.getUserProfile(id2));
          if (!id) break;
          attempted.add(id);
          try {
            await deps.fetchProfile(id);
          } catch {
            deps.warn("[VoiceProfileGradientFix] Profile fetch failed; not retrying this session");
          }
          if (stopped || token !== generation) break;
          await new Promise((resolve) => deps.setTimeout(resolve, 1500));
        }
      } catch {
        deps.warn("[VoiceProfileGradientFix] Discord profile/voice API unavailable");
      } finally {
        busy = false;
        if (!stopped && token !== generation) schedule();
      }
    }
    return {
      start() {
        if (!stopped) return;
        stopped = false;
        generation++;
        attempted.clear();
        for (const store of [deps.selected, deps.voice]) {
          store.addChangeListener(schedule);
          subscriptions.push(store);
        }
        schedule();
      },
      stop() {
        stopped = true;
        generation++;
        if (timer !== null) deps.clearTimeout(timer);
        timer = null;
        for (const store of subscriptions.splice(0)) store.removeChangeListener(schedule);
        attempted.clear();
      }
    };
  }

  // vencord-plugin/voiceProfileGradientFix/index.ts
  registerManagedPlugin((V) => {
    let worker = null;
    return {
      name: "VoiceProfileGradientFix",
      description: "\u041F\u043E\u0434\u0433\u0440\u0443\u0436\u0430\u0435\u0442 \u043F\u0440\u043E\u0444\u0438\u043B\u0438 \u0443\u0447\u0430\u0441\u0442\u043D\u0438\u043A\u043E\u0432 \u0442\u0435\u043A\u0443\u0449\u0435\u0433\u043E \u0437\u0432\u043E\u043D\u043A\u0430 \u0434\u043B\u044F \u0440\u043E\u0434\u043D\u043E\u0433\u043E \u0433\u0440\u0430\u0434\u0438\u0435\u043D\u0442\u0430 \u0433\u043E\u043B\u043E\u0441\u043E\u0432\u044B\u0445 \u043F\u043B\u0438\u0442\u043E\u043A.",
      authors: [{ name: "reka", id: 0n }],
      started: false,
      enabledByDefault: true,
      options: {},
      start() {
        const C = V.Webpack.Common;
        if (!V.Util?.fetchUserProfile || !C.UserProfileStore || !C.VoiceStateStore || !C.SelectedChannelStore)
          throw new Error("Discord profile API unavailable");
        worker = createVoiceProfileGradientFix({
          selected: C.SelectedChannelStore,
          voice: C.VoiceStateStore,
          users: C.UserStore,
          profiles: C.UserProfileStore,
          fetchProfile: (id) => V.Util.fetchUserProfile(id),
          setTimeout: (...args) => globalThis.setTimeout(...args),
          clearTimeout: (id) => globalThis.clearTimeout(id),
          warn: (message) => console.warn(message)
        });
        try {
          worker.start();
        } catch (error) {
          try {
            worker?.stop?.();
          } catch {
          }
          worker = null;
          throw error;
        }
      },
      stop() {
        worker?.stop();
        worker = null;
      }
    };
  });
})();
/*!
 * Discord quests runner — консольный скрипт для desktop-клиента с Vencord.
 *
 * Что делает:
 *   • показывает список доступных квестов (DQ.list())
 *   • принимает квесты (enroll) и выполняет их в реальном темпе
 *   • VIDEO       — шлёт video-progress с человеческим интервалом 7–9.5 с
 *   • GAME        — подставляет фейковый запущенный процесс, дальше Discord
 *                   сам шлёт heartbeat-ы (браузер/игра/Windows не нужны)
 *   • ACTIVITY    — best-effort heartbeat в голосовой канал
 *   • забирает награды (DQ.claimAll())
 *
 * Не умеет (и не притворяется):
 *   • STREAM_ON_DESKTOP — нужен реальный Go Live + второй зритель в канале
 *   • ACHIEVEMENT_IN_GAME / ACHIEVEMENT_IN_ACTIVITY
 *   • PLAY_ON_XBOX / PLAY_ON_PLAYSTATION — это делает консоль, не десктоп
 *
 * Использование:
 *   1. Discord desktop (Vesktop/Discord с Vencord), DevTools → Console
 *   2. вставить весь файл, Enter
 *   3. DQ.list()                     — посмотреть квесты
 *      DQ.run()                      — принять и выполнить всё поддерживаемое
 *      DQ.run({ autoClaim: true })   — то же + забрать награды
 *      DQ.stop()                     — остановить
 *
 * ВАЖНО: с апреля 2026 Discord банит за автоматизацию квестов (14 дней без
 * квестов + Account Standing). Скрипт специально не ускоряет время и не
 * работает 24/7. Запускай на свой страх и риск, лучше не на основном аккаунте.
 */
