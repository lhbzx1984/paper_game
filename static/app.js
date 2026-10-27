"use strict";

/* PaperQuest front-end: upload -> case file -> four levels -> report. */

const state = {
  screen: "home",
  status: null,
  statusError: "",
  epoch: 0,
  caseData: null,
  levels: [],
  levelStates: [],
  levelsMeta: null,
  levelsPending: false,
  levelsError: "",
  levelsPromise: null,
  paperText: "",
  paperPdfFile: null,
  paperPdfUrl: "",
  paperPdfBlobUrl: "",
  meta: null,
  currentLevel: 0,
  reflection: "",
  outline: "",
  pendingFile: null,
  startedAt: null,
  completedAt: null,
  processing: null,
  lastRenderKey: "",
  modal: null,
  settingsNotice: "",
  account: null,
  accountLoaded: false,
  authMode: "login",
  authNotice: "",
  authBusy: false,
  purchase: null,
  purchaseBusy: false,
  purchaseError: "",
  purchaseNotice: "",
  purchaseBaseline: null,
  gameId: "",
  caseId: null,
  libraryItems: [],
  libraryCount: 0,
  libraryLoading: false,
  libraryLoaded: false,
  libraryError: "",
  savePending: false,
  deleteTarget: null,
  loadTarget: null,
  progressSaveErrorShown: false,
  story: null,
  storyClueId: null,
};

let processingTimer = null;
let settingsBusy = false;
let drawerTimer = null;
let progressTimer = null;
let progressSaveChain = Promise.resolve();

const LETTERS = ["A", "B", "C", "D", "E", "F"];
const FALLBACK_LEVELS = [
  { title: "缺口定位", skill: "问题定位" },
  { title: "实验装配", skill: "方法拆解" },
  { title: "结果侦探", skill: "数据判读" },
  { title: "审稿对线", skill: "批判评价" },
];

class AppError extends Error {
  constructor(message, { detail = "", status = 0, code = "", payload = null } = {}) {
    super(message || "操作失败");
    this.name = "AppError";
    this.detail = detail;
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

function $(selector, root = document) {
  return root.querySelector(selector);
}

function $$(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(value, max = 80) {
  const text = String(value ?? "").trim();
  if (text.length <= max) return text;
  return text.slice(0, Math.max(1, max - 1)) + "…";
}

function isUseful(value) {
  const text = String(value ?? "").trim();
  return Boolean(text) && !["论文未报告", "未报告", "N/A", "n/a"].includes(text);
}

function paperOf() {
  return state.caseData?.paper || {};
}

function paperTitle() {
  return paperOf().title || "未命名论文";
}

function releasePaperPdf() {
  if (state.paperPdfBlobUrl) {
    try { URL.revokeObjectURL(state.paperPdfBlobUrl); } catch (_error) { /* ignore */ }
  }
  state.paperPdfBlobUrl = "";
  state.paperPdfFile = null;
  state.paperPdfUrl = "";
}

function ensurePaperPdfUrl() {
  if (state.paperPdfUrl) return state.paperPdfUrl;
  if (state.paperPdfFile) {
    state.paperPdfBlobUrl = URL.createObjectURL(state.paperPdfFile);
    state.paperPdfUrl = state.paperPdfBlobUrl;
  }
  return state.paperPdfUrl;
}

function levelKicker(level, index) {
  return level.kicker || `LEVEL ${String(index + 1).padStart(2, "0")}`;
}

function totalScore() {
  return state.levels.reduce((sum, level, index) => {
    return sum + levelScore(level, state.levelStates[index]);
  }, 0);
}

function completedLevelCount() {
  return state.levels.reduce((count, level, index) => {
    return count + (isLevelComplete(level, state.levelStates[index]) ? 1 : 0);
  }, 0);
}

function allLevelsComplete() {
  return state.levels.length > 0 && completedLevelCount() === state.levels.length;
}

function firstIncompleteLevel() {
  for (let index = 0; index < state.levels.length; index += 1) {
    if (!isLevelComplete(state.levels[index], state.levelStates[index])) return index;
  }
  return -1;
}

function hintCount() {
  return state.levelStates.reduce((count, levelState) => count + (levelState?.hintUsed ? 1 : 0), 0);
}

function verifiedQuoteStats(levels) {
  let total = 0;
  let verified = 0;
  levels.forEach((level) => {
    if (level.source_quote) {
      total += 1;
      if (level.verified) verified += 1;
    }
    if (level.followup?.source_quote) {
      total += 1;
      if (level.followup.verified) verified += 1;
    }
  });
  return { total, verified };
}

function countAnswers(level, levelState) {
  if (!levelState) return 0;
  if (level.type === "review") {
    return (levelState.mainAttempts || 0) + (levelState.followupAttempts || 0);
  }
  return levelState.attempts || 0;
}

function statusMeta() {
  if (!state.status) {
    return {
      className: state.statusError ? "bad" : "",
      label: state.statusError ? "服务未连接" : "检测模型中",
      title: state.statusError || "正在读取本地服务状态",
    };
  }
  if (state.status.mock) {
    return {
      className: "warn",
      label: "模拟模式",
      title: "当前使用示例案件，不会调用云端模型",
    };
  }
  if (state.status.real_configured) {
    return {
      className: "ok",
      label: state.status.model || "云端模型已连接",
      title: `已连接 ${state.status.host || "云端模型"} · ${state.status.model || "模型"}`,
    };
  }
  return {
    className: "bad",
    label: "未配置模型",
    title: "点击填写 Base URL、API Key 与模型名",
  };
}

async function apiFetch(url, options = {}, timeoutMs = 240000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const contentType = response.headers.get("content-type") || "";
    let data = null;
    if (contentType.includes("application/json")) {
      try {
        data = await response.json();
      } catch (_error) {
        data = null;
      }
    } else {
      const text = await response.text();
      data = { detail: text };
    }
    if (!response.ok) {
      const message = data?.error || `请求失败（HTTP ${response.status}）`;
      const detail = data?.detail || data?.error || "";
      throw new AppError(message, {
        detail,
        status: response.status,
        code: data?.code || "",
        payload: data,
      });
    }
    return data ?? {};
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new AppError("请求超时，请稍后重试，或换用响应更快的模型。");
    }
    if (error instanceof AppError) throw error;
    throw new AppError("无法连接本地服务，请确认 Flask 服务仍在运行。", {
      detail: String(error?.message || error),
    });
  } finally {
    clearTimeout(timer);
  }
}

function initializeLevelState(level) {
  if (level.type === "review") {
    return {
      hintUsed: false,
      hintFree: false,
      mainSelected: null,
      mainWrong: [],
      mainAttempts: 0,
      mainResolved: false,
      mainQuality: null,
      followupSelected: null,
      followupWrong: [],
      followupAttempts: 0,
      followupResolved: false,
      followupQuality: null,
    };
  }
  if (level.type === "assembly") {
    const categories = Array.isArray(level.categories) ? level.categories : [];
    return {
      hintUsed: false,
      hintFree: false,
      selected: categories.map(() => null),
      attempts: 0,
      resolved: false,
      quality: null,
    };
  }
  return {
    hintUsed: false,
    hintFree: false,
    selected: null,
    wrong: [],
    attempts: 0,
    resolved: false,
    quality: null,
  };
}

function isLevelComplete(level, levelState) {
  if (!level || !levelState) return false;
  if (level.type === "review") {
    return Boolean(levelState.mainResolved && levelState.followupResolved);
  }
  return Boolean(levelState.resolved);
}

function scoreForQuality(base, quality) {
  if (quality === "first") return base;
  if (quality === "retry") return Math.round(base * 0.6);
  if (quality === "revealed") return Math.round(base * 0.2);
  return 0;
}

function levelScore(level, levelState) {
  if (!level || !levelState) return 0;
  let points = 0;
  if (level.type === "review") {
    if (levelState.mainResolved) points += scoreForQuality(15, levelState.mainQuality);
    if (levelState.followupResolved) points += scoreForQuality(10, levelState.followupQuality);
  } else if (levelState.resolved) {
    points = scoreForQuality(25, levelState.quality);
  }
  if (points > 0 && levelState.hintUsed && !levelState.hintFree) points = Math.max(0, points - 3);
  return points;
}

function qualityLabel(quality) {
  if (quality === "first") return "一次命中";
  if (quality === "retry") return "二次命中";
  if (quality === "revealed") return "已看解析";
  return "未完成";
}

function levelResultStatus(level, levelState) {
  if (!isLevelComplete(level, levelState)) return { label: "未完成", className: "warn" };
  const qualities = level.type === "review"
    ? [levelState.mainQuality, levelState.followupQuality]
    : [levelState.quality];
  if (qualities.every((quality) => quality === "first")) return { label: "一次命中", className: "" };
  if (qualities.some((quality) => quality === "revealed")) return { label: "已看解析", className: "warn" };
  return { label: "二次命中", className: "warn" };
}

function attemptLabel(level, levelState) {
  if (!levelState) return "";
  if (level.type === "review") {
    const main = levelState.mainAttempts ? `主问 ${levelState.mainAttempts} 次` : "主问未答";
    const followup = levelState.followupAttempts ? `追问 ${levelState.followupAttempts} 次` : "追问未答";
    return `${main} · ${followup}`;
  }
  return levelState.attempts ? `作答 ${levelState.attempts} 次` : "直接查看解析";
}

function sectionLabel(value) {
  return String(value || "正文").trim() || "正文";
}

function billingOn() {
  return Boolean(state.account?.billing?.enabled);
}

function accountUser() {
  return state.account?.user || null;
}

function quotaText() {
  const billing = state.account?.billing;
  if (!billing?.enabled) return "";
  if (billing.free_trial_available) return "首局免费";
  const remaining = billing.quota?.remaining;
  if (typeof remaining === "number") return `剩余 ${remaining} 次`;
  return "次数待确认";
}

function accountActionsHtml() {
  if (!billingOn()) return "";
  const user = accountUser();
  if (!user) {
    return `<button class="account-btn" data-action="open-auth">登录 / 注册</button>`;
  }
  return `
    <button class="account-btn" data-action="open-account" title="${escapeHtml(user.email)}">
      <span class="account-dot"></span>
      <span class="account-label">${escapeHtml(quotaText())}</span>
    </button>
    <button class="buy-btn" data-action="open-purchase">购买次数</button>
  `;
}

async function refreshAccount(renderAfter = true) {
  try {
    const data = await apiFetch("/api/auth/me", {}, 20000);
    state.account = data;
    state.accountLoaded = true;
  } catch (error) {
    if (renderAfter) showToast(`账号状态读取失败：${truncate(error.message, 80)}`, "warn");
  }
  renderTopbar();
  return state.account;
}

function renderTopbar() {
  const root = $("#topbar");
  if (!root) return;
  const badge = statusMeta();
  root.innerHTML = `
    <header class="topbar">
      <div class="topbar-inner">
        <button class="brand" data-action="home" aria-label="返回 PaperQuest 首页">
          <span class="brand-mark">PQ</span>
          <span>
            <span class="brand-en">PAPERQUEST</span>
            <span class="brand-cn">论文副本</span>
          </span>
        </button>
        <div class="top-actions">
          ${accountActionsHtml()}
          <button class="status-chip ${badge.className}" data-action="open-settings" title="${escapeHtml(badge.title)}">
            <span class="status-dot"></span>
            <span class="status-label">${escapeHtml(badge.label)}</span>
          </button>
          <button class="library-btn" data-action="open-library" title="打开资料库">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
              <rect x="3" y="4" width="18" height="4" rx="1"></rect>
              <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"></path>
              <path d="M10 12h4"></path>
            </svg>
            <span class="library-label">资料库</span>
            ${state.libraryCount ? `<span class="library-count">${state.libraryCount}</span>` : ""}
          </button>
          <button class="settings-btn" data-action="open-settings" aria-label="打开模型设置">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
              <circle cx="12" cy="12" r="3"></circle>
              <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.09A1.7 1.7 0 0 0 9 19.35a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.63 15a1.7 1.7 0 0 0-1.56-1.03H3v-4h.09A1.7 1.7 0 0 0 4.65 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.63a1.7 1.7 0 0 0 1.03-1.56V3h4v.09A1.7 1.7 0 0 0 15 4.65a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.37 9a1.7 1.7 0 0 0 1.56 1.03H21v4h-.09A1.7 1.7 0 0 0 19.4 15Z"></path>
            </svg>
            <span>模型设置</span>
          </button>
        </div>
      </div>
    </header>
  `;
}

function modeNoteHtml() {
  if (!state.status) {
    if (state.statusError) {
      return `本地服务状态读取失败：${escapeHtml(truncate(state.statusError, 120))}。仍可上传论文，或检查 Flask 服务。`;
    }
    return "正在读取本地模型状态…";
  }
  if (state.status.mock) {
    return "当前是<strong>模拟模式</strong>：上传任意论文都会载入示例案件，用于体验四幕调查；配置真实模型后才会解析你的论文。";
  }
  if (state.status.real_configured) {
    const host = state.status.host || "云端模型";
    return `已连接 <strong>${escapeHtml(host)}</strong> · ${escapeHtml(state.status.model || "模型")}。上传论文后会调用该接口解析。`;
  }
  return "尚未配置云端模型：请先点击右上角「模型设置」填写 API，再上传论文；模拟模式下可直接上传体验示例。";
}

function homeHtml() {
  const activeCase = state.caseData
    ? `<span class="format-sep">·</span><button class="link-btn" data-action="resume-current">继续《${escapeHtml(truncate(paperTitle(), 34))}》</button>`
    : "";
  return `
    <div class="home">
      <section class="hero">
        <div class="hero-copy">
          <div class="eyebrow"><span class="eyebrow-line"></span>PAPER → CASE → PLAY</div>
          <h1>把论文，<br>读成一场<em>雨夜调查</em>。</h1>
          <p class="lede">上传论文后，你会以第一人称进入四幕案发现场：在档案馆找研究缺口，在实验台核对方法，在数据室追证据，在审稿密室确认边界。四幕结束，才是 100 分制结案考核。</p>
          <div class="hero-actions">
            <button class="btn btn-accent" data-action="upload">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M12 16V4m0 0L7 9m5-5 5 5"></path>
                <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"></path>
              </svg>
              上传论文，进入案发现场
            </button>
            <button class="btn btn-ghost" data-action="open-library">打开资料库</button>
          </div>
          <div class="format-note">PDF / TXT / Markdown · 25 MB 以内 · 必须先上传论文${activeCase}</div>
          <p class="mode-note">${modeNoteHtml()}</p>
        </div>

        <div class="hero-art" aria-hidden="true">
          <div class="hero-photo">
            <img src="/static/assets/art/cover.jpg" alt="雨夜中的学院档案馆" loading="eager">
            <div class="hero-photo-shade"></div>
            <div class="hero-case-chip"><span>CASE FILE</span><strong>PQ-204</strong></div>
            <div class="hero-photo-caption"><span>23:47</span>雨还在下。有人翻过那篇论文的卷宗。</div>
          </div>
          <div class="floating-note note-one"><small>ACT I / 缺口</small>现有研究没解决什么？</div>
          <div class="floating-note note-two"><small>ACT IV / 边界</small>结论能推到哪里，又不能推到哪里？</div>
        </div>
      </section>

      <section class="steps">
        <article class="step-card">
          <div class="step-num">01</div>
          <h3>上传论文 · 立案建档</h3>
          <p>提取章节，定位研究问题、缺口、方法配置与证据边界。没有论文，不开始游戏。</p>
        </article>
        <article class="step-card">
          <div class="step-num">02</div>
          <h3>选择调查员 · 四幕现场</h3>
          <p>雨夜档案馆、地下实验台、数据观测室、审稿人密室。点击线索，拼出证据链，再用一次推理打开下一幕。</p>
        </article>
        <article class="step-card">
          <div class="step-num">03</div>
          <h3>结案审讯 · 100 分报告</h3>
          <p>四道结案考核检验你真正读懂了多少，生成逐关证据记录、结案报告与可带走的阅读大纲。</p>
        </article>
      </section>

      <div class="proof-strip">
        <div class="proof-item"><strong>4</strong>幕第一人称现场</div>
        <div class="proof-item"><strong>3</strong>名调查员 · 专属被动</div>
        <div class="proof-item"><strong>4</strong>关结案考核</div>
        <div class="proof-item"><strong>100</strong>分制评分</div>
      </div>
    </div>
  `;
}

function processingHtml() {
  const p = state.processing;
  if (!p) return "";
  return `
    <div class="processing">
      <section class="processing-card">
        <div class="loader" aria-hidden="true"></div>
        <h2>${escapeHtml(p.title)}</h2>
        <p>${escapeHtml(p.subtitle)}</p>
        <div class="stage-list">
          ${p.stages.map((stage, index) => `
            <div class="stage-item ${index < p.stageIndex ? "done" : index === p.stageIndex ? "active" : ""}" data-stage-index="${index}">
              <span class="stage-dot"></span>
              <span>${escapeHtml(stage)}</span>
            </div>
          `).join("")}
        </div>
        <div class="progress-track"><div class="progress-fill" style="width:${Number(p.progress) || 0}%"></div></div>
        <div class="processing-tip">${escapeHtml(p.tip || "")}</div>
      </section>
    </div>
  `;
}

function render() {
  renderTopbar();
  if (state.screen === "game" && (!state.levels.length || !state.caseData)) {
    state.screen = state.caseData ? "case" : "home";
  }
  if (state.screen === "results" && !state.caseData) {
    state.screen = "home";
  }
  if ((state.screen === "select" || state.screen === "story") && !state.caseData) {
    state.screen = "home";
  }
  if (state.screen === "story" && !state.story?.character) {
    state.screen = state.caseData ? "select" : "home";
  }
  document.body.classList.toggle(
    "story-mode",
    state.screen === "select" || state.screen === "story",
  );
  const host = $("#screen");
  if (!host) return;
  let html = "";
  if (state.screen === "processing") html = processingHtml();
  else if (state.screen === "select") html = selectHtml();
  else if (state.screen === "story") html = storyHtml();
  else if (state.screen === "case") html = caseHtml();
  else if (state.screen === "game") html = gameHtml();
  else if (state.screen === "results") html = resultsHtml();
  else if (state.screen === "library") html = libraryHtml();
  else html = homeHtml();
  host.innerHTML = html;

  const key = state.screen === "game"
    ? `game:${state.currentLevel}`
    : state.screen === "story"
      ? `story:${Number(state.story?.sceneIndex) || 0}`
      : state.screen === "results"
        ? "results"
        : state.screen;
  if (key !== state.lastRenderKey) {
    state.lastRenderKey = key;
    window.scrollTo(0, 0);
  }
}

function updateProcessingDom() {
  const p = state.processing;
  if (!p) return;
  $$(".stage-item").forEach((item, index) => {
    item.classList.toggle("done", index < p.stageIndex);
    item.classList.toggle("active", index === p.stageIndex && index < p.stages.length);
  });
  const fill = $(".progress-fill");
  if (fill) fill.style.width = `${Number(p.progress) || 0}%`;
}

function stopProcessingTicker() {
  if (processingTimer) {
    clearInterval(processingTimer);
    processingTimer = null;
  }
}

function beginProcessing({ title, subtitle, stages, tip }) {
  stopProcessingTicker();
  state.screen = "processing";
  state.processing = {
    title,
    subtitle,
    stages,
    tip,
    stageIndex: 0,
    progress: 8,
  };
  render();
  const startedAt = Date.now();
  processingTimer = setInterval(() => {
    const p = state.processing;
    if (!p) return;
    const elapsed = Date.now() - startedAt;
    p.stageIndex = Math.min(p.stages.length - 1, Math.floor(elapsed / 1900));
    p.progress = Math.min(93, Math.max(p.progress, 8 + Math.round(elapsed / 260)));
    updateProcessingDom();
  }, 420);
}

async function runProcessing(config, taskPromise) {
  const startedAt = Date.now();
  beginProcessing(config);
  const result = await taskPromise;
  const elapsed = Date.now() - startedAt;
  if (elapsed < 850) await delay(850 - elapsed);
  stopProcessingTicker();
  if (state.processing) {
    state.processing.stageIndex = state.processing.stages.length;
    state.processing.progress = 100;
    updateProcessingDom();
  }
  await delay(320);
  state.processing = null;
  return result;
}

function resetCase() {
  clearProgressTimer();
  releasePaperPdf();
  state.caseId = null;
  state.caseData = null;
  state.levels = [];
  state.levelStates = [];
  state.levelsMeta = null;
  state.levelsPending = false;
  state.levelsError = "";
  state.levelsPromise = null;
  state.paperText = "";
  state.meta = null;
  state.currentLevel = 0;
  state.reflection = "";
  state.outline = "";
  state.startedAt = null;
  state.completedAt = null;
  state.savePending = false;
  state.progressSaveErrorShown = false;
  state.story = null;
  state.storyClueId = null;
}

function extractLevelList(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.levels)) return payload.levels;
  return [];
}

function applyCasePayload(payload, fallbackSource = "upload") {
  if (!payload?.case_file?.paper) {
    throw new AppError("服务返回的案件档案不完整，请重试。");
  }
  const levels = extractLevelList(payload.levels);
  clearProgressTimer();
  releasePaperPdf();
  state.caseId = null;
  state.caseData = payload.case_file;
  state.paperText = String(payload.paper_text || "");
  state.meta = payload.meta || {};
  state.meta.source = state.meta.source || fallbackSource;
  state.paperPdfUrl = typeof payload.pdf_url === "string" ? payload.pdf_url : "";
  state.levels = levels;
  state.levelStates = levels.map(initializeLevelState);
  state.levelsMeta = null;
  state.levelsPending = false;
  state.levelsError = "";
  state.levelsPromise = null;
  state.currentLevel = 0;
  state.reflection = "";
  state.outline = "";
  state.startedAt = Date.now();
  state.completedAt = null;
  state.savePending = false;
  state.progressSaveErrorShown = false;
  state.story = null;
  state.storyClueId = null;
  state.screen = "select";
  render();
  if (!state.levels.length) {
    prefetchLevels();
  }
}

async function prefetchLevels(force = false) {
  if (!state.caseData || state.levelsPending) return;
  if (state.levels.length && !force) return;
  const epoch = state.epoch;
  state.levelsPending = true;
  state.levelsError = "";
  state.levelsPromise = apiFetch(
    "/api/generate",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ case_file: state.caseData, paper_text: state.paperText }),
    },
    300000,
  );
  if (state.screen === "case") render();
  try {
    const data = await state.levelsPromise;
    if (epoch !== state.epoch) return;
    const levels = extractLevelList(data.levels);
    if (!levels.length) throw new AppError("模型没有返回可玩的关卡，请重试。");
    state.levels = levels;
    state.levelStates = levels.map(initializeLevelState);
    state.levelsMeta = data.meta || null;
    state.levelsPending = false;
    state.levelsError = "";
    state.currentLevel = 0;
    if (state.screen === "case") render();
    showToast("四关已经生成，可以进入调查了。");
  } catch (error) {
    if (epoch !== state.epoch) return;
    state.levelsPending = false;
    state.levelsError = error?.message || "关卡生成失败";
    if (state.screen === "case") render();
    showToast(`关卡生成中断：${truncate(state.levelsError, 90)}`, "bad");
  } finally {
    if (epoch === state.epoch) state.levelsPromise = null;
  }
}

async function startAnalyze(file) {
  const epoch = ++state.epoch;
  await flushProgressSave();
  resetCase();
  if (!state.gameId) {
    state.gameId = (typeof crypto !== "undefined" && crypto.randomUUID)
      ? crypto.randomUUID()
      : `g-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
  try { sessionStorage.setItem("pq_game_id", state.gameId); } catch (_error) { /* ignore */ }
  const formData = new FormData();
  formData.append("file", file, file.name);
  formData.append("game_id", state.gameId);
  const task = apiFetch("/api/analyze", { method: "POST", body: formData }, 300000);
  try {
    const data = await runProcessing(
      {
        title: "正在拆解论文",
        subtitle: `《${truncate(file.name, 60)}》 · 提取章节并建立案件档案`,
        stages: ["校验调查通行证", "提取论文文本与章节", "定位研究问题与缺口", "核对主张、结果与原文引文", "封装案件档案并准备四关"],
        tip: "真实模型通常需要 30–120 秒。这个过程只把论文发送到你配置的接口。",
      },
      task,
    );
    if (epoch !== state.epoch) return;
    state.gameId = "";
    try { sessionStorage.removeItem("pq_game_id"); } catch (_error) { /* ignore */ }
    applyCasePayload(data, "upload");
    state.meta.filename = file.name;
    if (/\.pdf$/i.test(file.name) && state.meta.source === "upload" && !state.paperPdfUrl) {
      state.paperPdfFile = file;
      state.paperPdfUrl = URL.createObjectURL(file);
      state.paperPdfBlobUrl = state.paperPdfUrl;
    }
    refreshAccount(false).catch(() => {});
  } catch (error) {
    if (epoch !== state.epoch) return;
    state.processing = null;
    state.screen = state.caseData ? "case" : "home";
    render();
    throw error;
  }
}

async function refreshStatus() {
  state.status = await apiFetch("/api/status", {}, 15000);
  state.statusError = "";
  renderTopbar();
  return state.status;
}

async function handleFile(file) {
  if (!file) return;
  if (!/\.(pdf|txt|md)$/i.test(file.name)) {
    showToast("目前支持 PDF、TXT 和 Markdown 文件。", "bad");
    return;
  }
  if (file.size > 25 * 1024 * 1024) {
    showToast("文件超过 25 MB，请压缩或换一个文件。", "bad");
    return;
  }
  if (!file.size) {
    showToast("这个文件是空的。", "bad");
    return;
  }
  state.pendingFile = file;
  try {
    if (!state.status) await refreshStatus();
  } catch (error) {
    state.statusError = error.message;
    renderTopbar();
    throw error;
  }
  if (!state.status.mock && !state.status.real_configured) {
    openSettings("请先填写模型连接信息。保存成功后，我会自动继续解析你刚选择的论文。");
    return;
  }
  if (billingOn() && !accountUser()) {
    state.pendingFile = file;
    openAuthModal("登录后即可开始你的第一局免费调查。");
    return;
  }
  state.pendingFile = null;
  try {
    await startAnalyze(file);
  } catch (error) {
    if (handleBillingError(error, file)) return;
    throw error;
  }
}

function requestUpload() {
  const input = $("#file-input");
  if (!input) return;
  input.value = "";
  input.click();
}

async function startGame() {
  if (!state.caseData) {
    showToast("请先上传或打开一篇论文。", "bad");
    return;
  }
  if (!state.story?.character) {
    state.screen = "select";
    render();
    return;
  }
  if (!state.story.finished) {
    state.screen = "story";
    render();
    showToast("四幕现场调查结束后，才会进入结案审讯。", "warn");
    return;
  }
  if (!state.levels.length) {
    if (state.levelsPending) {
      showToast("结案考核还在生成，请稍等片刻。");
      return;
    }
    const epoch = state.epoch;
    state.screen = "case";
    render();
    showToast("正在生成结案考核，完成后会自动进入第一关。");
    await prefetchLevels();
    if (epoch !== state.epoch || !state.levels.length) return;
  }
  if (allLevelsComplete()) {
    if (!state.completedAt) {
      state.completedAt = Date.now();
      scheduleProgressSave();
    }
    state.screen = "results";
    render();
    return;
  }
  const next = firstIncompleteLevel();
  state.currentLevel = next >= 0 ? next : 0;
  state.screen = "game";
  render();
}

function resumeCurrent() {
  if (!state.caseData) return;
  if (!state.story?.character) {
    state.screen = "select";
    render();
    return;
  }
  if (!state.story.finished) {
    state.screen = "story";
    render();
    return;
  }
  if (allLevelsComplete()) {
    state.completedAt = state.completedAt || Date.now();
    state.screen = "results";
    render();
    return;
  }
  if (state.levels.length) {
    startGame();
    return;
  }
  state.screen = "case";
  render();
}

function goHome() {
  state.screen = "home";
  render();
}

function goCase() {
  if (!state.caseData) {
    goHome();
    return;
  }
  state.screen = "case";
  render();
}

/* ---------- library, persistence and progress sync ---------- */

function clearProgressTimer() {
  if (progressTimer) {
    clearTimeout(progressTimer);
    progressTimer = null;
  }
}

function validQuality(value) {
  return ["first", "retry", "revealed"].includes(value) ? value : null;
}

function validIndex(value, length) {
  return Number.isInteger(value) && value >= 0 && value < length ? value : null;
}

function validWrongList(value, length) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => Number.isInteger(item) && item >= 0 && item < length))];
}

function validCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.min(99, Math.floor(count)) : 0;
}

function restoreSavedLevelState(level, saved) {
  const fresh = initializeLevelState(level);
  if (!saved || typeof saved !== "object") return fresh;
  fresh.hintUsed = saved.hintUsed === true;
  fresh.hintFree = saved.hintFree === true;

  if (level.type === "review") {
    const mainCount = Array.isArray(level.options) ? level.options.length : 0;
    const followupCount = Array.isArray(level.followup?.options) ? level.followup.options.length : 0;
    fresh.mainSelected = validIndex(saved.mainSelected, mainCount);
    fresh.mainWrong = validWrongList(saved.mainWrong, mainCount);
    fresh.mainAttempts = validCount(saved.mainAttempts);
    fresh.mainResolved = saved.mainResolved === true;
    fresh.mainQuality = fresh.mainResolved ? (validQuality(saved.mainQuality) || "revealed") : null;
    fresh.followupSelected = validIndex(saved.followupSelected, followupCount);
    fresh.followupWrong = validWrongList(saved.followupWrong, followupCount);
    fresh.followupAttempts = validCount(saved.followupAttempts);
    fresh.followupResolved = saved.followupResolved === true;
    fresh.followupQuality = fresh.followupResolved ? (validQuality(saved.followupQuality) || "revealed") : null;
    return fresh;
  }

  if (level.type === "assembly") {
    const categories = Array.isArray(level.categories) ? level.categories : [];
    const savedSelected = Array.isArray(saved.selected) ? saved.selected : [];
    fresh.selected = categories.map((category, index) => {
      const optionCount = Array.isArray(category.options) ? category.options.length : 0;
      return validIndex(savedSelected[index], optionCount);
    });
    fresh.attempts = validCount(saved.attempts);
    fresh.resolved = saved.resolved === true;
    fresh.quality = fresh.resolved ? (validQuality(saved.quality) || "revealed") : null;
    return fresh;
  }

  const optionCount = Array.isArray(level.options) ? level.options.length : 0;
  fresh.selected = validIndex(saved.selected, optionCount);
  fresh.wrong = validWrongList(saved.wrong, optionCount);
  fresh.attempts = validCount(saved.attempts);
  fresh.resolved = saved.resolved === true;
  fresh.quality = fresh.resolved ? (validQuality(saved.quality) || "revealed") : null;
  return fresh;
}

function hasAnyProgress() {
  if (String(state.reflection || "").trim() || String(state.outline || "").trim()) return true;
  if (state.story?.character) return true;
  return state.levelStates.some((levelState) => {
    if (!levelState) return false;
    return Boolean(
      levelState.hintUsed
      || levelState.attempts
      || levelState.mainAttempts
      || levelState.followupAttempts
      || levelState.resolved
      || levelState.mainResolved
      || levelState.followupResolved
    );
  });
}

function serializeProgress() {
  return {
    levelStates: state.levelStates,
    currentLevel: state.currentLevel,
    reflection: state.reflection,
    outline: state.outline,
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    score: totalScore(),
    completedLevels: completedLevelCount(),
    completed: allLevelsComplete(),
    levelCount: state.levels.length,
    hintsUsed: hintCount(),
    story: state.story,
  };
}

function applyLibrarySummary(item) {
  if (!item?.id) return;
  const items = state.libraryItems.filter((entry) => entry.id !== item.id);
  items.unshift(item);
  state.libraryItems = items;
  state.libraryCount = items.length;
  renderTopbar();
}

async function saveProgressNow() {
  const caseId = state.caseId;
  if (!caseId || !state.caseData || !state.levels.length) return;
  const progress = serializeProgress();
  try {
    const data = await apiFetch(
      `/api/library/${encodeURIComponent(caseId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ progress }),
      },
      20000,
    );
    if (data.item) applyLibrarySummary(data.item);
    state.progressSaveErrorShown = false;
  } catch (error) {
    if (error.status === 404) {
      if (state.caseId === caseId) {
        state.caseId = null;
        showToast("这个案件已从资料库删除，当前进度不再自动保存。", "warn");
        render();
      }
      return;
    }
    if (!state.progressSaveErrorShown) {
      state.progressSaveErrorShown = true;
      showToast("进度自动保存失败，稍后仍会继续尝试。", "bad");
    }
  }
}

function scheduleProgressSave(delayMs = 450) {
  if (!state.caseId || !state.levels.length) return;
  clearProgressTimer();
  progressTimer = setTimeout(() => {
    progressTimer = null;
    progressSaveChain = progressSaveChain.then(saveProgressNow);
  }, delayMs);
}

function flushProgressSave() {
  if (!state.caseId || !state.levels.length) return Promise.resolve();
  clearProgressTimer();
  progressSaveChain = progressSaveChain.then(saveProgressNow).catch(() => {});
  return progressSaveChain;
}

function formatLibraryDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleString("zh-CN", {
    ...(sameYear ? {} : { year: "numeric" }),
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function toTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function librarySourceLabel(item) {
  if (item.source === "demo") return "示例案件";
  if (item.source === "mock") return "模拟解析";
  if (item.filename) return item.filename;
  return "上传论文";
}

function saveCaseButtonHtml({ onDark = false } = {}) {
  const base = onDark ? "btn btn-on-dark btn-sm" : "btn btn-light btn-sm";
  if (!state.levels.length) {
    return `<button class="${base}" disabled>生成四关后可保存</button>`;
  }
  if (state.caseId) {
    return `<button class="${base} saved-btn" data-action="open-library"><span class="save-dot"></span>已存入资料库 · 查看</button>`;
  }
  return `<button class="${base}" data-action="save-case" ${state.savePending ? "disabled" : ""}><span class="save-dot"></span>${state.savePending ? "正在保存…" : "保存到资料库"}</button>`;
}

async function saveCurrentCase() {
  if (state.savePending) return;
  if (!state.caseData || !state.levels.length) {
    showToast("四关生成后才能保存案件。", "warn");
    return;
  }
  if (!String(state.paperText || "").trim()) {
    showToast("这个案件缺少论文原文，暂时无法保存。", "bad");
    return;
  }
  syncReflection();
  state.savePending = true;
  render();
  try {
    const payload = {
      case_file: state.caseData,
      levels: state.levels,
      meta: { ...(state.meta || {}), source: state.meta?.source || "upload" },
      paper_text: state.paperText,
      progress: serializeProgress(),
    };
    const source = payload.meta.source;
    const includePdf = source === "upload" && Boolean(state.paperPdfFile);
    let options;
    if (includePdf) {
      const form = new FormData();
      form.append("payload", JSON.stringify(payload));
      form.append("pdf", state.paperPdfFile, state.paperPdfFile.name || "paper.pdf");
      options = { method: "POST", body: form };
    } else {
      options = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      };
    }
    const data = await apiFetch("/api/library", options, 180000);
    state.caseId = data.item.id;
    state.paperPdfUrl = data.item.has_pdf
      ? `/api/library/${encodeURIComponent(data.item.id)}/pdf`
      : state.paperPdfUrl;
    if (state.paperPdfBlobUrl) {
      try { URL.revokeObjectURL(state.paperPdfBlobUrl); } catch (_error) { /* ignore */ }
      state.paperPdfBlobUrl = "";
    }
    if (data.item.has_pdf) state.paperPdfFile = null;
    state.savePending = false;
    state.progressSaveErrorShown = false;
    applyLibrarySummary(data.item);
    render();
    showToast(
      data.item.created
        ? "案件已存入资料库，之后的进度会自动同步。"
        : "案件已在资料库中更新。",
    );
  } catch (error) {
    state.savePending = false;
    render();
    throw error;
  }
}

async function refreshLibrary({ silent = false } = {}) {
  if (state.libraryLoading) return;
  state.libraryLoading = true;
  if (state.screen === "library") render();
  try {
    const data = await apiFetch("/api/library", {}, 20000);
    state.libraryItems = Array.isArray(data.items) ? data.items : [];
    state.libraryCount = state.libraryItems.length;
    state.libraryError = "";
    state.libraryLoaded = true;
  } catch (error) {
    state.libraryError = error?.message || "资料库读取失败。";
    if (!silent) showToast(`资料库读取失败：${truncate(state.libraryError, 80)}`, "bad");
  } finally {
    state.libraryLoading = false;
    renderTopbar();
    if (state.screen === "library") render();
  }
}

async function openLibrary() {
  state.screen = "library";
  state.libraryError = "";
  render();
  await flushProgressSave();
  await refreshLibrary();
}

function libraryItemHtml(item, index) {
  const isCurrent = item.id === state.caseId;
  const levelCount = Math.max(0, Number(item.level_count) || 0);
  let done = Math.max(0, Math.min(levelCount, Number(item.completed_levels) || 0));
  if (item.completed) done = levelCount;
  const pct = levelCount ? Math.round((done / levelCount) * 100) : 0;
  const score = Math.max(0, Math.min(100, Number(item.score) || 0));
  const status = item.completed
    ? { label: "已结案", className: "" }
    : item.started
      ? { label: "调查中", className: "warn" }
      : { label: "未开始", className: "idle" };
  const metaBits = [item.authors, item.year, item.venue]
    .filter((value) => String(value || "").trim())
    .map((value) => escapeHtml(value));
  const metaText = metaBits.length ? metaBits.join(" · ") : "作者与出处未收录";
  return `
    <article class="library-card ${isCurrent ? "current" : ""}">
      <div class="library-card-top">
        <div class="library-index">${String(index + 1).padStart(2, "0")}</div>
        <div class="library-title-wrap">
          <h2 class="library-card-title">${escapeHtml(item.title || "未命名论文")}</h2>
          <p class="library-card-meta">${metaText}</p>
        </div>
        <span class="status-pill ${status.className}">${status.label}</span>
      </div>
      <div class="library-card-stats">
        <span>得分 <strong>${score}</strong> / 100</span>
        <span>已完成 <strong>${done}</strong> / ${levelCount} 关</span>
        <span>更新于 ${escapeHtml(formatLibraryDate(item.updated_at))}</span>
        ${isCurrent ? `<span class="library-current-flag">当前打开</span>` : ""}
      </div>
      <div class="library-progress" aria-hidden="true"><span style="width:${pct}%"></span></div>
      <div class="library-card-actions">
        <span class="library-source" title="${escapeHtml(librarySourceLabel(item))}">${escapeHtml(librarySourceLabel(item))}</span>
        ${isCurrent
          ? `<button class="btn btn-light btn-sm" data-action="resume-current">继续当前</button>`
          : `<button class="btn btn-primary btn-sm" data-action="load-case" data-id="${escapeHtml(item.id)}">${item.completed ? "查看结案报告" : item.started ? "继续调查" : "打开案件"}</button>`}
        <button class="btn btn-ghost btn-sm danger" data-action="delete-case" data-id="${escapeHtml(item.id)}">删除</button>
      </div>
    </article>
  `;
}

function libraryHtml() {
  const items = state.libraryItems;
  const activeCount = items.filter((item) => item.started && !item.completed).length;
  const doneCount = items.filter((item) => item.completed).length;
  let body = "";
  if (state.libraryLoading && !state.libraryLoaded) {
    body = `
      <div class="library-state">
        <div class="loader" aria-hidden="true"></div>
        <h2>正在读取资料库</h2>
        <p>从本机 SQLite 中调取已保存的案件。</p>
      </div>
    `;
  } else if (!items.length && state.libraryError) {
    body = `
      <div class="library-state">
        <div class="empty-stamp">CONNECTION LOST</div>
        <h2>资料库暂时打不开</h2>
        <p>${escapeHtml(state.libraryError)}</p>
        <button class="btn btn-primary" data-action="refresh-library">重新读取</button>
      </div>
    `;
  } else if (!items.length) {
    body = `
      <div class="library-state library-empty">
        <div class="empty-stamp">NO CASES YET</div>
        <h2>资料库还是空的</h2>
        <p>上传论文并生成四幕现场后，在案件档案里点击「保存到资料库」。保存后，调查与答题进度会自动同步。</p>
        <div class="library-empty-actions">
          <button class="btn btn-accent" data-action="upload">上传论文</button>
        </div>
      </div>
    `;
  } else {
    body = `
      ${state.libraryError ? `<div class="notice-banner"><span class="notice-mark">!</span><span>列表刷新失败：${escapeHtml(truncate(state.libraryError, 120))}</span></div>` : ""}
      <div class="library-list">
        ${items.map((item, index) => libraryItemHtml(item, index)).join("")}
      </div>
      <p class="library-note">案件保存在这台电脑的本地 SQLite 文件中，不会随论文上传到云端。删除案件会同时删除关卡与答题进度，但不会影响你原来的论文文件。</p>
    `;
  }

  return `
    <div class="screen library-screen">
      <div class="screen-head library-head">
        <button class="back-link" data-action="home">← 返回封面</button>
        <div class="eyebrow"><span class="eyebrow-line"></span>CASE ARCHIVE · 本地资料库</div>
        <div class="library-title-row">
          <div>
            <h1 class="library-title">资料库</h1>
            <p class="library-lede">把生成过四关的论文存成案件，随时回来继续调查。每答一题、用一次提示、修改一次审稿判断，进度都会写回本机数据库。</p>
          </div>
          <div class="library-head-actions">
            <button class="btn btn-ghost" data-action="refresh-library" ${state.libraryLoading ? "disabled" : ""}>刷新列表</button>
            <button class="btn btn-accent" data-action="upload">上传新论文</button>
          </div>
        </div>
        <div class="library-stats">
          <div class="library-stat"><strong>${items.length}</strong><span>已保存案件</span></div>
          <div class="library-stat"><strong>${activeCount}</strong><span>调查中</span></div>
          <div class="library-stat"><strong>${doneCount}</strong><span>已结案</span></div>
        </div>
      </div>
      ${body}
    </div>
  `;
}

function renderConfirmModal({ eyebrow, title, message, detail = "", confirmLabel, action, id, tone = "danger" }) {
  const root = $("#modal-root");
  if (!root) return;
  root.innerHTML = `
    <div class="modal-backdrop open">
      <section class="modal-card confirm-card" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <div class="modal-head">
          <div>
            <div class="eyebrow"><span class="eyebrow-line"></span>${escapeHtml(eyebrow)}</div>
            <h2 id="confirm-title">${escapeHtml(title)}</h2>
          </div>
          <button class="icon-btn" data-action="close-modal" aria-label="关闭确认框">×</button>
        </div>
        <p class="modal-lede">${message}</p>
        ${detail ? `<div class="confirm-detail">${detail}</div>` : ""}
        <div class="modal-actions">
          <button class="btn btn-ghost confirm-cancel" data-action="close-modal">取消</button>
          <button class="btn ${tone === "danger" ? "btn-danger" : "btn-primary"}" data-action="${escapeHtml(action)}" data-id="${escapeHtml(id)}">${escapeHtml(confirmLabel)}</button>
        </div>
      </section>
    </div>
  `;
  state.modal = action;
  lockBody();
  setTimeout(() => $(".confirm-cancel")?.focus(), 30);
}

function requestDeleteCase(id) {
  const item = state.libraryItems.find((entry) => entry.id === id);
  if (!item) return;
  state.deleteTarget = id;
  renderConfirmModal({
    eyebrow: "REMOVE FROM LIBRARY",
    title: "删除这个案件？",
    message: `《${escapeHtml(item.title || "未命名论文")}》的案件档案、四关与答题进度会一起删除。你电脑上的原始论文文件不受影响。`,
    detail: "删除后无法恢复。如果只是想重新挑战，请打开案件档案并使用「重新挑战」。",
    confirmLabel: "删除案件",
    action: "confirm-delete",
    id,
    tone: "danger",
  });
}

async function confirmDeleteCase(actionEl) {
  const id = state.deleteTarget || actionEl?.dataset.id;
  if (!id) return;
  const originalLabel = actionEl?.textContent;
  if (actionEl) {
    actionEl.disabled = true;
    actionEl.textContent = "正在删除…";
  }
  try {
    const wasCurrent = state.caseId === id;
    if (wasCurrent) {
      clearProgressTimer();
      state.caseId = null;
    }
    await apiFetch(`/api/library/${encodeURIComponent(id)}`, { method: "DELETE" }, 20000);
    if (wasCurrent && state.paperPdfUrl.startsWith("/api/library/")) {
      state.paperPdfUrl = "";
    }
    state.libraryItems = state.libraryItems.filter((item) => item.id !== id);
    state.libraryCount = state.libraryItems.length;
    state.deleteTarget = null;
    closeModal();
    render();
    showToast(wasCurrent ? "案件已删除。当前页面仍可查看，但进度不再自动保存。" : "案件已从资料库删除。");
  } catch (error) {
    if (actionEl) {
      actionEl.disabled = false;
      actionEl.textContent = originalLabel;
    }
    throw error;
  }
}

function requestLoadCase(id) {
  const item = state.libraryItems.find((entry) => entry.id === id);
  if (!item) return Promise.resolve();
  if (state.caseId === id) {
    resumeCurrent();
    return Promise.resolve();
  }
  if (state.caseData && !state.caseId && hasAnyProgress()) {
    state.loadTarget = id;
    renderConfirmModal({
      eyebrow: "UNSAVED CASE",
      title: "当前进度还没有保存",
      message: `打开《${escapeHtml(item.title || "未命名论文")}》会替换当前案件。当前论文的答题进度、审稿判断与阅读大纲都不在资料库中，替换后无法恢复。`,
      detail: `当前案件：${escapeHtml(paperTitle())}。如果希望保留，请先取消并点击「保存到资料库」。`,
      confirmLabel: "仍然打开",
      action: "confirm-load",
      id,
      tone: "primary",
    });
    return Promise.resolve();
  }
  return loadSavedCase(id);
}

async function loadSavedCase(id) {
  await flushProgressSave();
  const payload = await apiFetch(`/api/library/${encodeURIComponent(id)}`, {}, 30000);
  const levels = extractLevelList(payload.levels);
  if (!payload?.case_file?.paper || !levels.length) {
    throw new AppError("这个存档缺少案件档案或关卡，无法打开。");
  }
  const progress = payload.progress && typeof payload.progress === "object" ? payload.progress : {};
  state.epoch += 1;
  clearProgressTimer();
  releasePaperPdf();
  state.caseId = payload.item?.id || id;
  state.caseData = payload.case_file;
  state.paperText = String(payload.paper_text || "");
  state.meta = payload.meta && typeof payload.meta === "object" ? payload.meta : {};
  state.paperPdfUrl = typeof payload.pdf_url === "string" ? payload.pdf_url : "";
  state.levels = levels;
  state.levelStates = levels.map((level, index) => {
    const savedStates = Array.isArray(progress.levelStates) ? progress.levelStates : [];
    return restoreSavedLevelState(level, savedStates[index]);
  });
  state.levelsMeta = null;
  state.levelsPending = false;
  state.levelsError = "";
  state.levelsPromise = null;
  state.currentLevel = validIndex(progress.currentLevel, levels.length) ?? 0;
  state.reflection = typeof progress.reflection === "string" ? progress.reflection : "";
  state.outline = typeof progress.outline === "string" ? progress.outline : "";
  state.startedAt = toTimestamp(progress.startedAt) || toTimestamp(payload.item?.created_at) || Date.now();
  state.completedAt = toTimestamp(progress.completedAt);
  state.story = restoreStory(progress.story);
  state.storyClueId = null;
  state.savePending = false;
  state.progressSaveErrorShown = false;
  state.loadTarget = null;
  state.deleteTarget = null;

  if (allLevelsComplete()) {
    if (!state.completedAt) state.completedAt = Date.now();
    state.screen = "results";
  } else if (state.story?.finished) {
    const next = firstIncompleteLevel();
    state.currentLevel = next >= 0 ? next : 0;
    state.screen = "game";
  } else if (state.story?.character) {
    state.screen = "story";
  } else {
    state.screen = "select";
  }

  if (payload.item) applyLibrarySummary(payload.item);
  closeModal(false);
  state.lastRenderKey = "";
  render();
  showToast("已从资料库打开案件，进度已恢复。");
}

/* ---------- case file screen ---------- */

function noticeBanner(text) {
  if (!text) return "";
  return `
    <div class="notice-banner">
      <span class="notice-mark">!</span>
      <span>${escapeHtml(text)}</span>
    </div>
  `;
}

function verificationMark(verified) {
  if (verified === true) return `<span class="verified">原文可回链</span>`;
  if (verified === false) return `<span class="unverified">待核验</span>`;
  return "";
}

function quoteBlockHtml({ section, quote, verified, action = "" }) {
  if (!quote) return "";
  return `
    <div class="quote-block">
      <div class="quote-meta">
        <span>${escapeHtml(sectionLabel(section))}</span>
        ${verificationMark(verified)}
      </div>
      <p class="quote-text">“${escapeHtml(quote)}”</p>
      ${action ? `<div class="quote-actions">${action}</div>` : ""}
    </div>
  `;
}

function caseLevelPreviewHtml() {
  const ready = state.levels.length > 0;
  const levels = ready ? state.levels : FALLBACK_LEVELS;
  const next = ready ? firstIncompleteLevel() : 0;
  const locked = !state.story?.finished;
  return levels.map((level, index) => {
    const levelState = ready ? state.levelStates[index] : null;
    const done = ready && isLevelComplete(level, levelState);
    const current = ready && !locked && index === next && !allLevelsComplete();
    let sub = ready ? String(level.skill || "论文理解") : "等待生成";
    if (done) sub += " · 已完成";
    else if (state.levelsPending) sub += " · 生成中";
    else if (locked) sub = "完成四幕现场后解锁";
    return `
      <div class="preview-item ${done ? "done" : ""} ${current ? "current" : ""} ${locked && !done ? "locked" : ""}">
        <div class="preview-num">${done ? "✓" : locked ? "锁" : String(index + 1).padStart(2, "0")}</div>
        <div class="preview-body">
          <div class="preview-title">${escapeHtml(level.title || `第 ${index + 1} 关`)}</div>
          <div class="preview-skill">${escapeHtml(sub)}</div>
        </div>
      </div>
    `;
  }).join("");
}

function caseStoryPreviewHtml() {
  const acts = storyActs();
  if (!acts.length) return "";
  if (!state.story?.character) {
    return `
      <div class="story-preview-empty">
        <p>尚未选择调查员。</p>
        <button class="link-btn" data-action="open-select">先去选人 →</button>
      </div>
    `;
  }
  const currentIndex = Number(state.story.sceneIndex) || 0;
  return acts.map((act, index) => {
    const solved = storyActSolved(act);
    const current = !solved && index === currentIndex;
    return `
      <div class="story-preview-item ${solved ? "done" : ""} ${current ? "current" : ""}">
        <span class="story-preview-dot">${solved ? "✓" : String(index + 1).padStart(2, "0")}</span>
        <div>
          <div class="story-preview-title">${escapeHtml(act.title)}</div>
          <div class="story-preview-sub">${escapeHtml(solved ? "推理已成立" : current ? "正在调查" : "尚未抵达")}</div>
        </div>
      </div>
    `;
  }).join("");
}

function caseCtaState() {
  const summary = storyProgressSummary();
  if (!summary.started) {
    return {
      title: "先选一位调查员",
      note: "案件档案已建立。选定调查员后，以第一人称进入四幕现场；四幕结束才解锁结案考核。",
      label: "选择调查员，进入现场",
      action: "open-select",
      disabled: false,
    };
  }
  if (!summary.finished) {
    return {
      title: "现场调查进行中",
      note: `已完成 ${summary.solved}/4 幕。点击继续第 ${summary.nextIndex + 1} 幕「${summary.nextTitle}」，找齐线索并解开推理锁。`,
      label: `继续第 ${summary.nextIndex + 1} 幕 · ${summary.nextTitle}`,
      action: "continue-story",
      disabled: false,
    };
  }
  if (allLevelsComplete()) {
    return {
      title: "案件已经结清",
      note: "四幕调查与四关结案考核都已完成，可以查看分数、证据链与结案报告。",
      label: "查看结案报告",
      action: "start-game",
      disabled: false,
    };
  }
  if (state.levelsPending) {
    return {
      title: "正在准备结案考核",
      note: "模型正在把论文改写成四道审讯题，通常还需要 30–120 秒。完成后本页会自动出现入口。",
      label: "正在生成考核…",
      action: "start-game",
      disabled: true,
    };
  }
  if (state.levelsError) {
    return {
      title: "结案考核生成中断",
      note: `${truncate(state.levelsError, 140)} 点击下方按钮重试，不必重新调查四幕现场。`,
      label: "重试生成考核",
      action: "retry-generate",
      disabled: false,
    };
  }
  if (!state.levels.length) {
    return {
      title: "可以开庭了",
      note: "四幕现场调查已完成。生成四道结案考核，检验你对论文的真实理解。",
      label: "生成结案考核",
      action: "start-game",
      disabled: false,
    };
  }
  const done = completedLevelCount();
  const next = firstIncompleteLevel();
  return {
    title: done > 0 ? "继续结案审讯" : "开始结案审讯",
    note: "四关 × 25 分。四幕调查不会直接计分；结案考核按一次命中、二次命中与提示使用情况计分。",
    label: done > 0 ? `继续第 ${next + 1} 关` : "进入第 1 关",
    action: "start-game",
    disabled: false,
  };
}

function caseHtml() {
  const paper = paperOf();
  const meta = state.meta || {};
  const method = paper.method || {};
  const claims = Array.isArray(paper.claims) ? paper.claims : [];
  const limitations = Array.isArray(paper.limitations) ? paper.limitations : [];
  const glossary = Array.isArray(paper.glossary) ? paper.glossary : [];
  const quotes = meta.quote_stats || {};
  const score = Number(paper.gameability?.score);
  const sectionCount = Array.isArray(meta.sections) ? meta.sections.length : 0;
  const cta = caseCtaState();
  const notices = [meta.notice, state.levelsMeta?.notice]
    .filter(Boolean)
    .filter((item, index, list) => list.indexOf(item) === index);

  return `
    <div class="screen">
      <div class="screen-head">
        <button class="back-link" data-action="home">← 返回封面</button>
        <div class="eyebrow"><span class="eyebrow-line"></span>CASE FILE · 案件档案已建立</div>
        <h1 class="paper-title-h">${escapeHtml(paper.title || "未命名论文")}</h1>
        <div class="paper-meta">
          ${escapeHtml(paper.authors || "作者未报告")} · ${escapeHtml(paper.year || "年份未报告")} · ${escapeHtml(paper.venue || "发表信息未报告")} · ${escapeHtml(paper.paper_type || "实证研究")}
        </div>
        <div class="badges">
          ${quotes.total ? `<span class="badge ok">案件引文 ${Number(quotes.verified) || 0}/${Number(quotes.total) || 0} 可回链</span>` : ""}
          ${sectionCount ? `<span class="badge">${sectionCount} 个章节</span>` : ""}
          ${meta.pages ? `<span class="badge">${Number(meta.pages)} 页</span>` : ""}
          ${Number.isFinite(score) ? `<span class="badge">可玩性 ${Math.round(score * 100)}%</span>` : ""}
          ${paper.estimated_minutes ? `<span class="badge">约 ${Number(paper.estimated_minutes)} 分钟</span>` : ""}
          ${meta.mock ? `<span class="badge warn">模拟数据</span>` : ""}
          ${meta.source === "demo" ? `<span class="badge">示例案件</span>` : ""}
          ${state.caseId ? `<span class="badge ok">已存入资料库</span>` : ""}
        </div>
        ${notices.map((notice) => noticeBanner(notice)).join("")}
      </div>

      <div class="case-grid">
        <div class="case-main">
          <section class="card summary-card">
            <div class="card-label">案件简报 / ONE-SENTENCE BRIEF</div>
            <p class="summary-text">${escapeHtml(paper.one_sentence_summary || "模型没有提供一句话简报，请直接查看研究缺口与方法。")}</p>
            ${isUseful(paper.research_question) ? `
              <div class="brief-question">
                <span>RESEARCH QUESTION / 研究问题</span>
                ${escapeHtml(paper.research_question)}
              </div>
            ` : ""}
          </section>

          ${isUseful(paper.gap) ? `
            <section class="card gap-card">
              <div class="card-label">研究缺口 / RESEARCH GAP</div>
              <p class="gap-text">${escapeHtml(paper.gap)}</p>
            </section>
          ` : ""}

          ${(isUseful(method.summary) || method.key_components?.length || method.dataset) ? `
            <section class="card">
              <div class="card-label">方法与实验 / METHOD</div>
              <p class="method-summary">${escapeHtml(method.summary || "论文未提供方法摘要。")}</p>
              ${Array.isArray(method.key_components) && method.key_components.length ? `
                <div class="chip-row">
                  ${method.key_components.map((item) => `<span class="chip-static">${escapeHtml(item)}</span>`).join("")}
                </div>
              ` : ""}
              <div class="method-grid">
                ${isUseful(method.dataset) ? `<div class="method-item"><dt>数据</dt><dd>${escapeHtml(method.dataset)}</dd></div>` : ""}
                ${method.baselines?.length ? `<div class="method-item"><dt>基线</dt><dd>${escapeHtml(method.baselines.join("；"))}</dd></div>` : ""}
                ${method.metrics?.length ? `<div class="method-item"><dt>指标</dt><dd>${escapeHtml(method.metrics.join("；"))}</dd></div>` : ""}
              </div>
            </section>
          ` : ""}

          ${claims.length ? `
            <section class="card">
              <div class="card-label">关键主张与原文证据 / CLAIMS</div>
              <div class="claim-list">
                ${claims.map((claim, index) => {
                  const support = String(claim.support || "").toLowerCase();
                  const supportBadge = support === "strong"
                    ? `<span class="badge ok">强证据</span>`
                    : support === "partial"
                      ? `<span class="badge warn">部分支持</span>`
                      : "";
                  return `
                    <article class="claim">
                      <div class="claim-head">
                        <span class="claim-id">${escapeHtml(claim.id || `C${index + 1}`)}</span>
                        ${supportBadge}
                      </div>
                      <p class="claim-text">${escapeHtml(claim.text || "")}</p>
                      ${quoteBlockHtml({
                        section: claim.section,
                        quote: claim.evidence_quote,
                        verified: claim.verified,
                        action: `<button class="link-btn" data-action="open-source" data-scope="claim" data-claim-id="${escapeHtml(claim.id || "")}">打开原文定位 →</button>`,
                      })}
                    </article>
                  `;
                }).join("")}
              </div>
            </section>
          ` : ""}

          ${limitations.length ? `
            <section class="card">
              <div class="card-label">研究边界 / LIMITATIONS</div>
              <ul class="limitations">
                ${limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
              </ul>
            </section>
          ` : ""}
        </div>

        <aside class="case-side">
          <section class="card">
            <div class="card-label">INVESTIGATION / 四幕现场</div>
            <h2 class="side-title">第一人称调查</h2>
            <div class="story-preview">${caseStoryPreviewHtml()}</div>
            <button class="btn btn-light btn-sm side-source-btn" data-action="${state.story?.character ? "continue-story" : "open-select"}">
              ${state.story?.character && !state.story.finished ? "继续进入现场" : state.story?.finished ? "回看现场" : "选择调查员"}
            </button>
          </section>

          <section class="card">
            <div class="card-label">FINAL ASSESSMENT / 结案考核</div>
            <h2 class="side-title">四关审讯</h2>
            <div class="level-preview">${caseLevelPreviewHtml()}</div>
            <p class="side-hint">四幕结束后解锁。四关共 100 分，提示按角色能力结算。</p>
            <button class="btn btn-light btn-sm side-source-btn" data-action="open-source" data-scope="paper">查看论文原文</button>
          </section>

          ${glossary.length ? `
            <section class="card">
              <div class="card-label">GLOSSARY / 术语</div>
              <div class="glossary">
                ${glossary.map((item, index) => `
                  <details ${index === 0 ? "open" : ""}>
                    <summary>${escapeHtml(item.term || "")}</summary>
                    <p>${escapeHtml(item.definition || "")}</p>
                  </details>
                `).join("")}
              </div>
            </section>
          ` : ""}

          <section class="cta-card">
            <div class="card-label">CASE READY</div>
            <h2 class="cta-title">${escapeHtml(cta.title)}</h2>
            <p class="cta-note">${escapeHtml(cta.note)}</p>
            <div class="cta-actions">
              <button class="btn btn-accent" data-action="${escapeHtml(cta.action)}" ${cta.disabled ? "disabled" : ""}>${escapeHtml(cta.label)}</button>
              ${saveCaseButtonHtml({ onDark: true })}
            </div>
            <p class="cta-subnote">答题不是背摘要：每个选择都要回到原文证据。${state.caseId ? "进度会自动保存到资料库。" : ""}</p>
          </section>
        </aside>
      </div>
    </div>
  `;
}

/* ---------- game screen ---------- */

function questionView(level, levelState, phase) {
  if (level.type === "review") {
    if (phase === "followup") {
      return {
        selected: levelState.followupSelected,
        wrong: levelState.followupWrong,
        attempts: levelState.followupAttempts,
        resolved: levelState.followupResolved,
        quality: levelState.followupQuality,
      };
    }
    return {
      selected: levelState.mainSelected,
      wrong: levelState.mainWrong,
      attempts: levelState.mainAttempts,
      resolved: levelState.mainResolved,
      quality: levelState.mainQuality,
    };
  }
  return {
    selected: levelState.selected,
    wrong: levelState.wrong,
    attempts: levelState.attempts,
    resolved: levelState.resolved,
    quality: levelState.quality,
  };
}

function phaseOptions(level, phase) {
  if (phase === "followup") return level.followup?.options || [];
  return level.options || [];
}

function phaseAnswerIndex(level, phase) {
  if (phase === "followup") return level.followup?.answer_index ?? -1;
  return level.answer_index ?? -1;
}

function phaseBase(level, phase) {
  if (level.type !== "review") return 25;
  return phase === "followup" ? 10 : 15;
}

function optionButtonsHtml(level, levelState, phase) {
  const options = phaseOptions(level, phase);
  const view = questionView(level, levelState, phase);
  const answer = phaseAnswerIndex(level, phase);
  return `
    <div class="options">
      ${options.map((option, index) => {
        let className = "option";
        let disabled = false;
        if (view.resolved) {
          disabled = true;
          if (index === answer) className += " correct";
          else if (view.wrong.includes(index)) className += " wrong";
          else className += " dimmed";
        } else {
          if (view.selected === index) className += " selected";
          if (view.wrong.includes(index)) {
            className += " dimmed";
            disabled = true;
          }
        }
        return `
          <button class="${className}" data-action="select-option" data-phase="${phase}" data-index="${index}" ${disabled ? "disabled" : ""}>
            <span class="option-letter">${LETTERS[index] || index + 1}</span>
            <span class="option-text">${escapeHtml(option)}</span>
          </button>
        `;
      }).join("")}
    </div>
  `;
}

function sourceBoxHtml(level, phase) {
  const isFollowup = phase === "followup";
  const quote = isFollowup ? level.followup?.source_quote : level.source_quote;
  const verified = isFollowup ? level.followup?.verified : level.verified;
  const section = level.source_section || "正文";
  if (!quote) return "";
  return `
    <div class="source-box">
      <div class="source-label">
        <span>原文依据 · ${escapeHtml(sectionLabel(section))}</span>
        ${verificationMark(verified)}
      </div>
      <p class="source-quote">“${escapeHtml(quote)}”</p>
      <div class="source-actions">
        <button class="link-btn" data-action="open-source" data-scope="${isFollowup ? "followup" : "level"}" data-level-index="${state.currentLevel}">打开原文定位 →</button>
      </div>
    </div>
  `;
}

function phaseFeedbackHtml(level, levelState, phase) {
  const view = questionView(level, levelState, phase);
  if (!view.attempts && !view.resolved) return "";
  const isReview = level.type === "review";
  const finalLevelScore = levelScore(level, levelState);

  if (!view.resolved) {
    const retryPoints = scoreForQuality(phaseBase(level, phase), "retry");
    const revealPoints = scoreForQuality(phaseBase(level, phase), "revealed");
    return `
      <div class="feedback warn">
        <div class="feedback-head">
          <span class="feedback-title">证据还没对上</span>
        </div>
        <p>这个选择与论文的表述不一致。你还可以再选一次（本阶段二次命中得 ${retryPoints} 分），或者展开解析（得 ${revealPoints} 分）。先看看下面的原文线索。</p>
        ${sourceBoxHtml(level, phase)}
      </div>
    `;
  }

  const title = view.quality === "first"
    ? "判断正确"
    : view.quality === "retry"
      ? "第二次命中"
      : "解析已展开";
  const className = view.quality === "revealed" ? "warn" : "ok";
  let pointsText = "";
  if (isReview) {
    pointsText = phase === "followup"
      ? `本关 ${finalLevelScore}/25`
      : `+${scoreForQuality(phaseBase(level, phase), view.quality)} 分`;
  } else {
    pointsText = `+${finalLevelScore} 分`;
  }
  const hintNote = levelState.hintUsed
    ? `<p class="muted">${levelState.hintFree ? "本关提示由角色能力免扣分。" : "本关使用过提示，已扣除 3 分。"}</p>`
    : "";
  return `
    <div class="feedback ${className}">
      <div class="feedback-head">
        <span class="feedback-title">${title}</span>
        <span class="feedback-points">${pointsText}</span>
      </div>
      <p>${escapeHtml(level.explanation || "模型没有提供解析。")}</p>
      ${hintNote}
      ${sourceBoxHtml(level, phase)}
    </div>
  `;
}

function phaseActionsHtml(level, levelState, phase) {
  const view = questionView(level, levelState, phase);
  if (view.resolved) return "";
  return `
    <div class="next-row">
      ${view.attempts > 0 ? `<button class="btn btn-ghost btn-sm" data-action="view-analysis" data-phase="${phase}">查看解析</button>` : ""}
      <button class="btn btn-primary btn-sm" data-action="submit-choice" data-phase="${phase}" ${view.selected == null ? "disabled" : ""}>提交判断</button>
    </div>
  `;
}

function nextRowHtml() {
  const last = state.currentLevel >= state.levels.length - 1;
  return `
    <div class="next-row">
      <button class="btn btn-primary" data-action="next-level">${last ? "查看结案报告" : `进入第 ${state.currentLevel + 2} 关`} →</button>
    </div>
  `;
}

function hintAreaHtml(level, levelState) {
  const unavailable = !level.hint || levelState.hintUsed || isLevelComplete(level, levelState);
  const character = activeCharacter();
  let note = level.hint ? "使用提示会在本关扣 3 分" : "本关暂无提示";
  if (levelState.hintUsed && levelState.hintFree) note = "本次提示由角色能力免扣分";
  else if (!levelState.hintUsed && character?.id === "gu" && level.type === "review") {
    note = "审稿人能力：本关提示不扣分";
  } else if (!levelState.hintUsed && character?.id === "lin" && state.story?.freeHintAvailable) {
    note = "档案员能力：本次提示不扣分（整局 1 次）";
  }
  return `
    <div class="hint-row">
      <button class="hint-btn" data-action="use-hint" ${unavailable ? "disabled" : ""}>${levelState.hintUsed ? "提示已使用" : "需要一点提示？"}</button>
      <span class="assembly-hint">${escapeHtml(note)}</span>
    </div>
    ${levelState.hintUsed && level.hint ? `<div class="hint-box">${escapeHtml(level.hint)}</div>` : ""}
  `;
}

function choiceLevelHtml(level, levelState) {
  const view = questionView(level, levelState, "main");
  return `
    ${optionButtonsHtml(level, levelState, "main")}
    ${phaseFeedbackHtml(level, levelState, "main")}
    ${view.resolved ? nextRowHtml() : phaseActionsHtml(level, levelState, "main")}
  `;
}

function assemblyLevelHtml(level, levelState) {
  const categories = Array.isArray(level.categories) ? level.categories : [];
  const allChosen = levelState.selected.every((value) => value != null);
  const character = activeCharacter();
  const showsRuledOut = character?.id === "shen" && !levelState.resolved;
  return `
    ${showsRuledOut ? `<p class="passive-note"><span>沙盘推演</span>沈砾已为每一类排除一个错误选项。</p>` : ""}
    <div class="assembly">
      ${categories.map((category, categoryIndex) => {
        const excluded = assemblyExcludedIndex(level, categoryIndex);
        return `
        <div class="assembly-row">
          <div class="assembly-label">${escapeHtml(category.name || `配置 ${categoryIndex + 1}`)}</div>
          <div class="chip-options">
            ${(category.options || []).map((option, optionIndex) => {
              const chosen = levelState.selected[categoryIndex] === optionIndex;
              const ruledOut = !levelState.resolved && optionIndex === excluded;
              let className = "chip-option";
              if (levelState.resolved) {
                if (optionIndex === category.answer_index) className += " correct";
                else if (chosen) className += " wrong";
              } else if (chosen) {
                className += " selected";
              }
              if (ruledOut) className += " ruled-out";
              return `
                <button class="${className}" data-action="select-assembly" data-cat="${categoryIndex}" data-opt="${optionIndex}" ${levelState.resolved || ruledOut ? "disabled" : ""}>
                  ${escapeHtml(option)}${ruledOut ? `<span class="ruled-badge">排除</span>` : ""}
                </button>
              `;
            }).join("")}
          </div>
        </div>
      `; }).join("")}
    </div>
    ${phaseFeedbackHtml(level, levelState, "main")}
    ${levelState.resolved ? nextRowHtml() : `
      <div class="next-row">
        ${levelState.attempts > 0 ? `<button class="btn btn-ghost btn-sm" data-action="view-analysis" data-phase="main">查看解析</button>` : ""}
        <button class="btn btn-primary btn-sm" data-action="submit-assembly" ${allChosen ? "" : "disabled"}>提交装配</button>
      </div>
    `}
  `;
}

function reviewLevelHtml(level, levelState) {
  const followup = level.followup || {};
  const mainView = questionView(level, levelState, "main");
  const followupView = questionView(level, levelState, "followup");
  const mainPart = `
    ${optionButtonsHtml(level, levelState, "main")}
    ${phaseFeedbackHtml(level, levelState, "main")}
    ${mainView.resolved ? "" : phaseActionsHtml(level, levelState, "main")}
  `;
  if (!mainView.resolved) return mainPart;

  const rebuttal = `
    <div class="author-response">
      <div class="author-label">AUTHOR RESPONSE · 作者回应</div>
      <p>${escapeHtml(followup.author_response || "作者没有提供回应。")}</p>
    </div>
    <div class="level-kicker level-kicker-followup">REBUTTAL · 追问</div>
    <p class="prompt">${escapeHtml(followup.prompt || "作者回应后，哪一种追问最专业？")}</p>
    <div class="game-meta">
      <span class="meta-pill">追问 +10 分</span>
      <span class="meta-pill">依据 · ${escapeHtml(sectionLabel(level.source_section))}</span>
    </div>
    ${optionButtonsHtml(level, levelState, "followup")}
    ${phaseFeedbackHtml(level, levelState, "followup")}
    ${followupView.resolved ? nextRowHtml() : phaseActionsHtml(level, levelState, "followup")}
  `;
  return mainPart + rebuttal;
}

function levelCardHtml(level, levelState) {
  let body = "";
  if (level.type === "assembly") body = assemblyLevelHtml(level, levelState);
  else if (level.type === "review") body = reviewLevelHtml(level, levelState);
  else body = choiceLevelHtml(level, levelState);
  return `
    <article class="level-card">
      <div class="level-kicker">${escapeHtml(levelKicker(level, state.currentLevel))}</div>
      <h1 class="level-title">${escapeHtml(level.title || "论文调查")}</h1>
      <p class="level-objective">${escapeHtml(level.objective || "")}</p>
      <p class="prompt">${escapeHtml(level.prompt || "")}</p>
      <div class="game-meta">
        <span class="meta-pill">技能 · ${escapeHtml(level.skill || "论文理解")}</span>
        <span class="meta-pill">本题 ${level.type === "review" ? "15 + 10" : "25"} 分</span>
        <span class="meta-pill">依据 · ${escapeHtml(sectionLabel(level.source_section))}</span>
        ${level.verified === true ? `<span class="meta-pill">引文已核验</span>` : ""}
      </div>
      ${hintAreaHtml(level, levelState)}
      ${body}
    </article>
  `;
}

const LEVEL_STEP_LABELS = ["缺口", "装配", "结果", "审稿"];

function gameProgressHtml() {
  return state.levels.map((level, index) => {
    const done = isLevelComplete(level, state.levelStates[index]);
    const active = index === state.currentLevel && !done;
    return `
      ${index > 0 ? `<span class="pstep-line"></span>` : ""}
      <div class="pstep ${done ? "done" : ""} ${active ? "active" : ""}">
        <span class="pstep-dot">${done ? "✓" : index + 1}</span>
        <span class="pstep-label">${LEVEL_STEP_LABELS[index] || "关卡"}</span>
      </div>
    `;
  }).join("");
}

function gameSideHtml() {
  const quoteCounts = verifiedQuoteStats(state.levels);
  const character = activeCharacter();
  return `
    <aside class="game-side">
      <section class="map-card">
        ${character ? `
          <div class="game-character">
            <span class="game-character-avatar" style="background-image:url('${escapeHtml(character.portrait)}')"></span>
            <span class="game-character-copy">
              <strong>${escapeHtml(character.name)} · ${escapeHtml(character.role)}</strong>
              <small>${escapeHtml(character.passive)}：${escapeHtml(character.passiveShort)}</small>
            </span>
          </div>
        ` : ""}
        <div class="card-label">FINAL ASSESSMENT · 结案审讯</div>
        <div class="map-card-body">
          ${state.levels.map((level, index) => {
            const done = isLevelComplete(level, state.levelStates[index]);
            const active = index === state.currentLevel && !done;
            const sub = done
              ? `已完成 · ${levelScore(level, state.levelStates[index])}/25`
              : active
                ? "正在受审"
                : "待审";
            return `
              <div class="map-node ${done ? "done" : ""} ${active ? "active" : ""}">
                <span class="map-dot"></span>
                <div>
                  <div class="map-label">${index + 1}. ${escapeHtml(level.title || `第 ${index + 1} 关`)}</div>
                  <div class="map-sub">${escapeHtml(sub)}</div>
                </div>
              </div>
            `;
          }).join("")}
        </div>
        <div class="stat-row">
          <div class="stat"><div class="stat-label">当前得分</div><div class="stat-value">${totalScore()}<small style="font-size:11px;color:var(--muted)"> / 100</small></div></div>
          <div class="stat"><div class="stat-label">已完成</div><div class="stat-value">${completedLevelCount()}<small style="font-size:11px;color:var(--muted)"> / 4</small></div></div>
          <div class="stat"><div class="stat-label">已用提示</div><div class="stat-value">${hintCount()}</div></div>
          <div class="stat"><div class="stat-label">证据回链</div><div class="stat-value">${quoteCounts.total ? `${quoteCounts.verified}/${quoteCounts.total}` : "—"}</div></div>
        </div>
        <button class="btn btn-light btn-sm side-source-btn" data-action="open-source" data-scope="paper">查看论文原文</button>
        <div class="side-save-row">
          ${state.caseId
            ? `<div class="side-save-state"><span class="save-dot"></span>资料库已同步 · 自动保存进度</div>`
            : `<button class="btn btn-accent btn-sm" data-action="save-case" ${state.savePending ? "disabled" : ""}>${state.savePending ? "正在保存…" : "保存案件与进度"}</button>`}
        </div>
      </section>
    </aside>
  `;
}

function gameHtml() {
  const level = state.levels[state.currentLevel];
  if (!level) return homeHtml();
  const levelState = state.levelStates[state.currentLevel] || initializeLevelState(level);
  state.levelStates[state.currentLevel] = levelState;
  return `
    <div class="game-shell">
      <button class="back-link" data-action="back-to-case">← 案件档案</button>
      <div class="game-banner">
        <div class="game-banner-text">
          <span class="game-banner-kicker">FINAL ASSESSMENT · 结案审讯</span>
          <strong>四幕调查已经结束。现在，用四道题证明你读懂了论文。</strong>
        </div>
        <span class="game-banner-stamp">${completedLevelCount()}/4 已结</span>
      </div>
      <div class="game-top">
        <span class="game-case-id">CASE FILE · FINAL ${state.levels.length} LEVELS</span>
        <div class="progress-steps">${gameProgressHtml()}</div>
        <div class="score-chip"><strong>${totalScore()}</strong><span>/ 100</span></div>
      </div>
      <div class="game-grid">
        ${levelCardHtml(level, levelState)}
        ${gameSideHtml()}
      </div>
    </div>
  `;
}

function scrollToFeedback() {
  requestAnimationFrame(() => {
    const feedback = $(".feedback");
    if (feedback) feedback.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
}

function selectOption(phase, index) {
  const level = state.levels[state.currentLevel];
  const levelState = state.levelStates[state.currentLevel];
  if (!level || !levelState) return;
  const view = questionView(level, levelState, phase);
  if (view.resolved || view.wrong.includes(index)) return;
  if (level.type === "review") {
    if (phase === "followup") levelState.followupSelected = index;
    else levelState.mainSelected = index;
  } else {
    levelState.selected = index;
  }
  render();
}

function submitChoice(phase) {
  const level = state.levels[state.currentLevel];
  const levelState = state.levelStates[state.currentLevel];
  if (!level || !levelState) return;
  const view = questionView(level, levelState, phase);
  if (view.resolved) return;
  const selected = view.selected;
  if (selected == null) {
    showToast("先选择一个选项，再提交判断。", "warn");
    return;
  }
  const answer = phaseAnswerIndex(level, phase);

  if (level.type === "review") {
    if (phase === "followup") {
      levelState.followupAttempts += 1;
      if (selected === answer) {
        levelState.followupResolved = true;
        levelState.followupQuality = levelState.followupAttempts === 1 ? "first" : "retry";
      } else {
        if (!levelState.followupWrong.includes(selected)) levelState.followupWrong.push(selected);
        levelState.followupSelected = null;
        if (levelState.followupAttempts >= 2) {
          levelState.followupResolved = true;
          levelState.followupQuality = "revealed";
        }
      }
    } else {
      levelState.mainAttempts += 1;
      if (selected === answer) {
        levelState.mainResolved = true;
        levelState.mainQuality = levelState.mainAttempts === 1 ? "first" : "retry";
      } else {
        if (!levelState.mainWrong.includes(selected)) levelState.mainWrong.push(selected);
        levelState.mainSelected = null;
        if (levelState.mainAttempts >= 2) {
          levelState.mainResolved = true;
          levelState.mainQuality = "revealed";
        }
      }
    }
  } else {
    levelState.attempts += 1;
    if (selected === answer) {
      levelState.resolved = true;
      levelState.quality = levelState.attempts === 1 ? "first" : "retry";
    } else {
      if (!levelState.wrong.includes(selected)) levelState.wrong.push(selected);
      levelState.selected = null;
      if (levelState.attempts >= 2) {
        levelState.resolved = true;
        levelState.quality = "revealed";
      }
    }
  }
  scheduleProgressSave();
  render();
  scrollToFeedback();
}

function revealAnalysis(phase) {
  const level = state.levels[state.currentLevel];
  const levelState = state.levelStates[state.currentLevel];
  if (!level || !levelState) return;
  const view = questionView(level, levelState, phase);
  if (view.resolved) return;
  if (level.type === "review") {
    if (phase === "followup") {
      levelState.followupResolved = true;
      levelState.followupQuality = "revealed";
      levelState.followupSelected = null;
    } else {
      levelState.mainResolved = true;
      levelState.mainQuality = "revealed";
      levelState.mainSelected = null;
    }
  } else if (level.type === "assembly") {
    levelState.resolved = true;
    levelState.quality = "revealed";
  } else {
    levelState.resolved = true;
    levelState.quality = "revealed";
    levelState.selected = null;
  }
  scheduleProgressSave();
  render();
  scrollToFeedback();
}

function selectAssembly(categoryIndex, optionIndex) {
  const level = state.levels[state.currentLevel];
  const levelState = state.levelStates[state.currentLevel];
  if (!level || !levelState || level.type !== "assembly" || levelState.resolved) return;
  levelState.selected[categoryIndex] = optionIndex;
  render();
}

function submitAssembly() {
  const level = state.levels[state.currentLevel];
  const levelState = state.levelStates[state.currentLevel];
  if (!level || !levelState || level.type !== "assembly" || levelState.resolved) return;
  if (levelState.selected.some((value) => value == null)) {
    showToast("四类配置都要各选一张卡片。", "warn");
    return;
  }
  const categories = Array.isArray(level.categories) ? level.categories : [];
  const allCorrect = categories.every((category, index) => levelState.selected[index] === category.answer_index);
  levelState.attempts += 1;
  if (allCorrect) {
    levelState.resolved = true;
    levelState.quality = levelState.attempts === 1 ? "first" : "retry";
  } else if (levelState.attempts >= 2) {
    levelState.resolved = true;
    levelState.quality = "revealed";
  }
  scheduleProgressSave();
  render();
  scrollToFeedback();
}

function useHint() {
  const level = state.levels[state.currentLevel];
  const levelState = state.levelStates[state.currentLevel];
  if (!level || !levelState || !level.hint || levelState.hintUsed) return;
  const character = activeCharacter();
  let free = false;
  if (character?.id === "lin" && state.story?.freeHintAvailable) {
    state.story.freeHintAvailable = false;
    free = true;
  } else if (character?.id === "gu" && level.type === "review") {
    free = true;
  }
  levelState.hintUsed = true;
  levelState.hintFree = free;
  scheduleProgressSave();
  render();
  showToast(
    free ? "提示已展开，角色能力生效，本关不扣分。" : "提示已展开，本关将扣除 3 分。",
    free ? "" : "warn",
  );
}

function nextLevel() {
  const level = state.levels[state.currentLevel];
  const levelState = state.levelStates[state.currentLevel];
  if (!isLevelComplete(level, levelState)) return;
  if (state.currentLevel >= state.levels.length - 1) {
    state.completedAt = Date.now();
    state.screen = "results";
    scheduleProgressSave();
    render();
    return;
  }
  state.currentLevel += 1;
  state.screen = "game";
  scheduleProgressSave();
  render();
}

/* ---------- results, outline and report ---------- */

function scoreTier(score) {
  if (score >= 90) {
    return {
      label: "首席调查员",
      note: "证据链完整。你能区分论文报告了什么、没有报告什么，也能在作者回应后继续追问边界。",
    };
  }
  if (score >= 75) {
    return {
      label: "资深审稿人",
      note: "你抓住了主要论证，也识别了关键边界。再回看一两次原文，证据链会更稳。",
    };
  }
  if (score >= 60) {
    return {
      label: "独立研究者",
      note: "主线已经跑通。建议回看提示与解析中的原文依据，把结论与证据一一对应起来。",
    };
  }
  return {
    label: "论文见习侦探",
    note: "案件已经走完。下一轮可以配合原文线索再挑战一次，先分清“作者说了什么”和“你能推出什么”。",
  };
}

function argumentMapHtml() {
  const paper = paperOf();
  const finding = paper.claims?.[0]?.text || paper.one_sentence_summary || "论文未提供结论";
  return `
    <div class="argument-map">
      <div class="map-block">
        <div class="map-block-label">PROBLEM / 问题</div>
        <div class="map-block-text">${escapeHtml(paper.research_question || "论文未报告")}</div>
      </div>
      <div class="map-block">
        <div class="map-block-label">METHOD / 方法</div>
        <div class="map-block-text">${escapeHtml(paper.method?.summary || "论文未报告")}</div>
      </div>
      <div class="map-block">
        <div class="map-block-label">FINDING / 证据结论</div>
        <div class="map-block-text">${escapeHtml(finding)}</div>
      </div>
    </div>
  `;
}

function resultsTableHtml() {
  return `
    <div class="table-wrap">
      <table class="record-table">
        <thead>
          <tr><th>关卡</th><th>技能</th><th>判定</th><th>得分</th><th>依据</th></tr>
        </thead>
        <tbody>
          ${state.levels.map((level, index) => {
            const levelState = state.levelStates[index];
            const status = levelResultStatus(level, levelState);
            const points = levelScore(level, levelState);
            return `
              <tr>
                <td>
                  <strong>${escapeHtml(level.title || `第 ${index + 1} 关`)}</strong><br>
                  <span class="muted">${escapeHtml(attemptLabel(level, levelState))}</span>
                </td>
                <td>${escapeHtml(level.skill || "论文理解")}</td>
                <td><span class="status-pill ${status.className}">${status.label}</span></td>
                <td><strong>${points}</strong> / 25</td>
                <td>
                  ${escapeHtml(sectionLabel(level.source_section))}<br>
                  ${level.source_quote ? `<button class="link-btn" data-action="open-source" data-scope="level" data-level-index="${index}">定位原文</button>` : `<span class="muted">—</span>`}
                </td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function resultsHtml() {
  const paper = paperOf();
  const score = totalScore();
  const tier = scoreTier(score);
  const pct = Math.max(0, Math.min(100, score));
  const character = activeCharacter();
  const summary = storyProgressSummary();
  return `
    <div class="results">
      <section class="results-hero">
        <div>
          <div class="closed-stamp">CASE CLOSED · 已结案</div>
          <h1>${score} 分，案件已结。</h1>
          <p class="results-sub">${escapeHtml(tier.label)} · ${escapeHtml(tier.note)}</p>
          <p class="paper-meta">${escapeHtml(paper.title || "未命名论文")} · 四幕现场 + 四关结案审讯 · ${escapeHtml(new Date(state.completedAt || Date.now()).toLocaleDateString("zh-CN"))}</p>
          ${character ? `<p class="results-character">调查员：${escapeHtml(character.name)} · ${escapeHtml(character.role)} · ${escapeHtml(character.passive)}</p>` : ""}
          ${state.caseId ? `<div class="results-save-state"><span class="save-dot"></span>结案报告与审稿判断已同步到资料库</div>` : ""}
        </div>
        <div class="score-ring" style="--pct:${pct}%">
          <div class="score-ring-inner">
            <div class="score-num">${score}</div>
            <div class="score-den">TOTAL / 100</div>
          </div>
        </div>
      </section>

      <section class="result-section">
        <h2>四幕现场调查 <span class="result-section-note">${summary.solved}/4 推理成立</span></h2>
        <div class="story-summary-row">
          ${storyActs().map((act, index) => `
            <div class="story-summary-item ${storyActSolved(act) ? "done" : ""}">
              <span class="story-summary-num">${storyActSolved(act) ? "✓" : String(index + 1).padStart(2, "0")}</span>
              <div>
                <strong>${escapeHtml(act.title)}</strong>
                <small>${escapeHtml(storyActSolved(act) ? act.short + " · 推理已成立" : "未完成")}</small>
              </div>
            </div>
          `).join("")}
        </div>
      </section>

      <section class="result-section">
        <h2>四关判定</h2>
        <div class="skill-row">
          ${state.levels.map((level, index) => {
            const levelState = state.levelStates[index];
            const status = levelResultStatus(level, levelState);
            return `
              <span class="skill-stamp ${status.className === "warn" ? "warn" : ""}">
                <span class="skill-dot"></span>
                ${escapeHtml(level.title || `第 ${index + 1} 关`)}
                <small>${status.label} · ${levelScore(level, levelState)}/25</small>
              </span>
            `;
          }).join("")}
        </div>
      </section>

      <section class="result-section">
        <h2>论文论证地图</h2>
        ${argumentMapHtml()}
      </section>

      <section class="result-section">
        <h2>逐关记录</h2>
        ${resultsTableHtml()}
      </section>

      <section class="result-section">
        <div class="defense-card">
          <div class="card-label">DEFENSE / 你的审稿判断</div>
          <h2>作者如果坐在你对面，你会追问什么？</h2>
          <p class="defense-prompt">写下一个具体、可验证、能被论文自身证据回应的追问。它可以是关于外部效度、消融缺口、失败案例，或结论与数据之间的距离。</p>
          <textarea class="defense-area" id="reflection" placeholder="例如：我认可作者在三个低资源分类数据集上的结果，但论文尚未验证……，建议补充……">${escapeHtml(state.reflection)}</textarea>
          <div class="report-actions">
            <button class="btn btn-on-dark" data-action="build-outline">生成阅读大纲</button>
            <button class="btn btn-accent" data-action="download-report">下载结案报告</button>
            ${state.outline ? `<button class="btn btn-on-dark" data-action="copy-outline">复制大纲</button>` : ""}
          </div>
          ${state.outline ? `<div class="outline">${escapeHtml(state.outline)}</div>` : ""}
        </div>
      </section>

      <div class="report-actions result-bottom-actions">
        ${state.caseId
          ? `<button class="btn btn-light" data-action="open-library">打开资料库</button>`
          : `<button class="btn btn-light" data-action="save-case" ${state.savePending ? "disabled" : ""}>${state.savePending ? "正在保存…" : "保存本案件"}</button>`}
        <button class="btn btn-ghost" data-action="restart-game">重新挑战本论文</button>
        <button class="btn btn-light" data-action="back-to-case">回看案件档案</button>
        <button class="btn btn-primary" data-action="new-paper">拆解另一篇论文</button>
      </div>

      <p class="disclaimer">报告由案件档案、你的作答与提示使用情况自动汇总。关键引文已与提取文本做过字符串核验，但仍建议在原始 PDF 中复核；学术判断不能替代你自己的阅读。</p>
    </div>
  `;
}

function syncReflection() {
  const input = $("#reflection");
  if (input) state.reflection = input.value;
}

function buildOutlineText() {
  const paper = paperOf();
  const lines = [`《${paper.title || "未命名论文"}》阅读大纲`, ""];
  if (isUseful(paper.one_sentence_summary)) {
    lines.push("一句话简报", paper.one_sentence_summary, "");
  }
  lines.push("一、研究问题");
  lines.push(paper.research_question || "论文未报告");
  lines.push("");
  lines.push("二、研究缺口");
  lines.push(paper.gap || "论文未报告");
  lines.push("");
  lines.push("三、方法与实验");
  lines.push(paper.method?.summary || "论文未报告");
  if (paper.method?.key_components?.length) {
    lines.push(`关键组件：${paper.method.key_components.join("；")}`);
  }
  if (paper.method?.dataset) lines.push(`数据：${paper.method.dataset}`);
  if (paper.method?.baselines?.length) lines.push(`基线：${paper.method.baselines.join("；")}`);
  if (paper.method?.metrics?.length) lines.push(`指标：${paper.method.metrics.join("；")}`);
  lines.push("");

  const claims = Array.isArray(paper.claims) ? paper.claims : [];
  if (claims.length) {
    lines.push("四、证据链");
    claims.forEach((claim, index) => {
      lines.push(`${claim.id || `C${index + 1}`}. ${claim.text}`);
      if (claim.evidence_quote) {
        lines.push(`   原文（${sectionLabel(claim.section)}）：“${claim.evidence_quote}”`);
      }
    });
    lines.push("");
  }

  const limitations = Array.isArray(paper.limitations) ? paper.limitations : [];
  if (limitations.length) {
    lines.push("五、边界与局限");
    limitations.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
    lines.push("");
  }

  if (state.reflection.trim()) {
    lines.push("六、我的审稿追问");
    lines.push(state.reflection.trim());
    lines.push("");
  }

  const glossary = Array.isArray(paper.glossary) ? paper.glossary : [];
  if (glossary.length) {
    lines.push(state.reflection.trim() ? "七、术语备忘" : "六、术语备忘");
    glossary.forEach((item) => lines.push(`- ${item.term}：${item.definition}`));
    lines.push("");
  }
  lines.push("—— 由 PaperQuest 论文副本生成");
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function mdCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function reviewRecordLine(level, index) {
  const levelState = state.levelStates[index];
  if (level.type === "review") {
    return `主问：${qualityLabel(levelState.mainQuality)}（${levelState.mainAttempts} 次） · 追问：${qualityLabel(levelState.followupQuality)}（${levelState.followupAttempts} 次）`;
  }
  return `${qualityLabel(levelState.quality)} · ${attemptLabel(level, levelState)}`;
}

function buildReportMarkdown() {
  const paper = paperOf();
  const score = totalScore();
  const tier = scoreTier(score);
  const lines = [];
  lines.push("# PaperQuest 结案报告");
  lines.push("");
  lines.push(`**论文：** ${paper.title || "未命名论文"}`);
  lines.push("");
  lines.push(`**作者：** ${paper.authors || "未报告"}  `);
  lines.push(`**年份 / 发表：** ${paper.year || "未报告"} · ${paper.venue || "未报告"}  `);
  const character = activeCharacter();
  if (character) lines.push(`**调查员：** ${character.name} · ${character.role} · ${character.passive}  `);
  lines.push(`**总评：** ${score}/100 · ${tier.label}  `);
  lines.push(`**生成时间：** ${new Date().toLocaleString("zh-CN")}`);
  lines.push("");
  lines.push("## 一句话简报");
  lines.push("");
  lines.push(paper.one_sentence_summary || "论文未报告");
  lines.push("");
  lines.push("## 四幕现场调查");
  lines.push("");
  storyActs().forEach((act, index) => {
    const solved = storyActSolved(act);
    lines.push(`- 第 ${index + 1} 幕 · ${act.title}：${solved ? "推理成立" : "未完成"}`);
  });
  lines.push("");
  lines.push("## 逐关成绩");
  lines.push("");
  lines.push("| 关卡 | 技能 | 判定 | 得分 | 作答记录 |");
  lines.push("| --- | --- | --- | --- | --- |");
  state.levels.forEach((level, index) => {
    const status = levelResultStatus(level, state.levelStates[index]);
    lines.push(`| ${mdCell(level.title)} | ${mdCell(level.skill)} | ${status.label} | ${levelScore(level, state.levelStates[index])}/25 | ${mdCell(reviewRecordLine(level, index))} |`);
  });
  lines.push("");
  lines.push("## 四关作答与解析");
  lines.push("");
  state.levels.forEach((level, index) => {
    const levelState = state.levelStates[index];
    lines.push(`### ${index + 1}. ${level.title}`);
    lines.push("");
    lines.push(`- 技能：${level.skill || "论文理解"}`);
    lines.push(`- 判定：${levelResultStatus(level, levelState).label}，${levelScore(level, levelState)}/25`);
    lines.push(`- 作答：${reviewRecordLine(level, index)}`);
    if (levelState.hintUsed) lines.push(`- 提示：使用过（${levelState.hintFree ? "角色能力免扣分" : "扣 3 分"}）`);
    lines.push(`- 原文依据：${sectionLabel(level.source_section)}`);
    if (level.explanation) {
      lines.push("");
      lines.push(`> ${level.explanation}`);
    }
    lines.push("");
  });
  lines.push("## 证据链");
  lines.push("");
  const claims = Array.isArray(paper.claims) ? paper.claims : [];
  claims.forEach((claim) => {
    lines.push(`### ${claim.id || "主张"} · ${claim.text}`);
    lines.push("");
    if (claim.evidence_quote) {
      lines.push(`> “${claim.evidence_quote}”`);
      lines.push(`> — ${sectionLabel(claim.section)}`);
      lines.push("");
    }
  });
  const limitations = Array.isArray(paper.limitations) ? paper.limitations : [];
  if (limitations.length) {
    lines.push("## 研究边界");
    lines.push("");
    limitations.forEach((item) => lines.push(`- ${item}`));
    lines.push("");
  }
  lines.push("## 我的审稿判断");
  lines.push("");
  lines.push(state.reflection.trim() || "（未填写）");
  lines.push("");
  lines.push("## 阅读大纲");
  lines.push("");
  lines.push(state.outline || buildOutlineText());
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("由 PaperQuest 论文副本生成。引文已与提取文本做字符串核验；正式引用前请回到原始 PDF 复核。");
  return lines.join("\n");
}

function sanitizeFileName(value) {
  return String(value || "论文")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 64) || "论文";
}

function downloadTextFile(filename, content) {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1200);
}

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  area.style.left = "-9999px";
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  if (!ok) throw new AppError("浏览器拒绝访问剪贴板，请手动选择文本复制。");
}

function buildOutlineFromResults() {
  syncReflection();
  state.outline = buildOutlineText();
  scheduleProgressSave();
  render();
  requestAnimationFrame(() => {
    const outline = $(".outline");
    if (outline) outline.scrollIntoView({ behavior: "smooth", block: "center" });
  });
  showToast("阅读大纲已生成，可继续编辑审稿判断后重新生成。");
}

/* ---------- dialogs, settings and source reader ---------- */

function lockBody() {
  document.body.style.overflow = "hidden";
}

function unlockBodyIfIdle() {
  if (!$(".modal-backdrop.open") && !$(".drawer.open")) {
    document.body.style.overflow = "";
  }
}

function showToast(message, type = "") {
  const root = $("#toast-root");
  if (!root) return;
  while (root.children.length >= 3) root.firstElementChild.remove();
  const toast = document.createElement("div");
  toast.className = `toast ${type}`.trim();
  toast.textContent = message;
  toast.style.transition = "opacity .2s ease, transform .2s ease";
  root.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(6px)";
    setTimeout(() => toast.remove(), 220);
  }, 4200);
}

function closeModal(clearPending = true) {
  stopPurchasePoll();
  const root = $("#modal-root");
  if (root) root.innerHTML = "";
  if (state.modal === "purchase") {
    state.purchase = null;
    state.purchaseError = "";
    state.purchaseNotice = "";
    state.purchaseBaseline = null;
  }
  state.modal = null;
  state.deleteTarget = null;
  state.loadTarget = null;
  state.storyClueId = null;
  if (clearPending) state.pendingFile = null;
  unlockBodyIfIdle();
}

function showError(title, error, fallback = "请稍后重试。") {
  const message = error?.message || String(error || fallback);
  const detail = error?.detail || "";
  const root = $("#modal-root");
  if (!root) return;
  root.innerHTML = `
    <div class="modal-backdrop open">
      <section class="modal-card error-card" role="dialog" aria-modal="true" aria-labelledby="error-title">
        <div class="modal-head">
          <div>
            <div class="eyebrow"><span class="eyebrow-line"></span>SOMETHING BROKE</div>
            <h2 id="error-title">${escapeHtml(title)}</h2>
          </div>
          <button class="icon-btn" data-action="close-modal" aria-label="关闭错误提示">×</button>
        </div>
        <p class="modal-lede">${escapeHtml(message)}</p>
        ${detail ? `<div class="error-detail">${escapeHtml(detail)}</div>` : ""}
        <div class="modal-actions">
          <button class="btn btn-primary" data-action="close-modal">知道了</button>
        </div>
      </section>
    </div>
  `;
  state.modal = "error";
  lockBody();
  setTimeout(() => $(".error-card .icon-btn")?.focus(), 30);
}

function setAuthNotice(text, type = "pending") {
  state.authNotice = text || "";
  const node = $("#auth-status");
  if (!node) return;
  node.className = `form-status ${type}`;
  node.textContent = text || "";
}

function setAuthBusy(busy) {
  state.authBusy = busy;
  const form = $("#auth-form");
  if (!form) return;
  $$("button, input", form).forEach((element) => {
    element.disabled = busy;
  });
}

function openAuthModal(notice = "", mode = "login") {
  if (accountUser()) {
    openAccountModal();
    return;
  }
  state.authMode = mode;
  state.authNotice = notice || "";
  renderAuthModal();
}

function renderAuthModal() {
  const root = $("#modal-root");
  if (!root) return;
  const isRegister = state.authMode === "register";
  root.innerHTML = `
    <div class="modal-backdrop open">
      <section class="modal-card auth-card" role="dialog" aria-modal="true" aria-labelledby="auth-title">
        <div class="modal-head">
          <div>
            <div class="eyebrow"><span class="eyebrow-line"></span>DETECTIVE PASS</div>
            <h2 id="auth-title">${isRegister ? "注册账号" : "登录"}</h2>
          </div>
          <button class="icon-btn" data-action="close-modal" aria-label="关闭登录窗口">×</button>
        </div>
        <p class="modal-lede">用邮箱保存你的游戏次数与资料库。每名用户的第一局免费，之后每局消耗 1 次。</p>
        <div class="auth-tabs" role="tablist">
          <button class="auth-tab ${isRegister ? "" : "active"}" data-action="auth-tab" data-mode="login" role="tab">登录</button>
          <button class="auth-tab ${isRegister ? "active" : ""}" data-action="auth-tab" data-mode="register" role="tab">注册</button>
        </div>
        <form class="settings-form" id="auth-form" autocomplete="on">
          <div class="field">
            <label for="auth-email">邮箱</label>
            <input id="auth-email" name="email" type="email" placeholder="you@example.com" autocomplete="email" required>
          </div>
          <div class="field">
            <label for="auth-password">密码</label>
            <input id="auth-password" name="password" type="password" placeholder="${isRegister ? "至少 8 个字符" : "输入密码"}" autocomplete="${isRegister ? "new-password" : "current-password"}" required>
          </div>
          <div class="form-status pending" id="auth-status">${escapeHtml(state.authNotice)}</div>
          <div class="modal-actions">
            <button class="btn btn-ghost" type="button" data-action="close-modal">取消</button>
            <button class="btn btn-primary" type="submit">${isRegister ? "注册并登录" : "登录"}</button>
          </div>
        </form>
        <div class="field-note">次数由支付宝「一人付」管理，购买后自动到账。忘记密码暂不支持自助重置。</div>
      </section>
    </div>
  `;
  state.modal = "auth";
  lockBody();
  setTimeout(() => $("#auth-email")?.focus(), 40);
}

async function submitAuth() {
  if (state.authBusy) return;
  const form = $("#auth-form");
  if (!form) return;
  const formData = new FormData(form);
  const email = String(formData.get("email") || "").trim();
  const password = String(formData.get("password") || "");
  if (!email || !password) {
    setAuthNotice("请填写邮箱和密码。", "bad");
    return;
  }
  const isRegister = state.authMode === "register";
  setAuthBusy(true);
  setAuthNotice(isRegister ? "正在创建账号…" : "正在登录…", "pending");
  try {
    const data = await apiFetch(
      isRegister ? "/api/auth/register" : "/api/auth/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      },
      30000,
    );
    state.account = { user: data.user, billing: data.billing };
    state.accountLoaded = true;
    const pending = state.pendingFile;
    state.pendingFile = null;
    state.authBusy = false;
    closeModal(false);
    renderTopbar();
    refreshLibrary({ silent: true }).catch(() => {});
    showToast(isRegister ? "账号已创建，开始你的第一局免费调查。" : "已登录。");
    if (pending) {
      try {
        await startAnalyze(pending);
      } catch (error) {
        if (!handleBillingError(error, pending)) throw error;
      }
    }
  } catch (error) {
    setAuthBusy(false);
    setAuthNotice(error.message || "登录失败。", "bad");
  }
}

function openAccountModal() {
  const root = $("#modal-root");
  if (!root) return;
  const user = accountUser();
  if (!user) {
    openAuthModal();
    return;
  }
  const billing = state.account?.billing || {};
  const remaining = billing.quota && typeof billing.quota.remaining === "number"
    ? `${billing.quota.remaining} 次`
    : "待确认";
  root.innerHTML = `
    <div class="modal-backdrop open">
      <section class="modal-card account-card" role="dialog" aria-modal="true" aria-labelledby="account-title">
        <div class="modal-head">
          <div>
            <div class="eyebrow"><span class="eyebrow-line"></span>DETECTIVE PASS</div>
            <h2 id="account-title">我的账号</h2>
          </div>
          <button class="icon-btn" data-action="close-modal" aria-label="关闭账号窗口">×</button>
        </div>
        <div class="account-summary">
          <div><span>邮箱</span><strong>${escapeHtml(user.email)}</strong></div>
          <div><span>剩余次数</span><strong>${escapeHtml(remaining)}</strong></div>
          <div><span>首局免费</span><strong>${billing.free_trial_available ? "尚未使用" : "已使用"}</strong></div>
        </div>
        ${billing.error ? `<div class="form-status bad">${escapeHtml(billing.error)}</div>` : ""}
        <div class="modal-actions">
          <button class="btn btn-ghost" data-action="logout">退出登录</button>
          <button class="btn btn-primary" data-action="open-purchase">购买次数</button>
        </div>
        <div class="field-note">每上传并解析一篇论文消耗 1 次；已存入资料库的案件重开不扣次数。</div>
      </section>
    </div>
  `;
  state.modal = "account";
  lockBody();
}

function purchaseOptions() {
  const options = state.account?.billing?.product?.charging_options;
  return Array.isArray(options) ? options : [];
}

function formatAmount(value) {
  const text = String(value ?? "").trim();
  const num = Number(text);
  if (!text || !Number.isFinite(num)) return text;
  return num.toFixed(2).replace(/\.?0+$/, "");
}

function optionPrice(option) {
  const price = String(option?.price ?? "").trim();
  if (!price) return "";
  const shown = formatAmount(price);
  const currency = option?.currency === "CNY" || !option?.currency ? "元" : String(option.currency);
  return currency === "元" ? `¥${shown}` : `${shown} ${currency}`;
}

function optionUnitPrice(option) {
  const amount = Number(option?.quota_amount || 0);
  const price = Number(option?.price ?? NaN);
  if (!(amount > 1) || !Number.isFinite(price) || price <= 0) return "";
  return `折合 ${formatAmount((price / amount).toFixed(2))} 元/次`;
}

function openPurchaseModal(payload = null) {
  if (!billingOn()) {
    showToast("服务端未启用收费，无需购买。");
    return;
  }
  if (!accountUser()) {
    openAuthModal("登录后即可购买次数。");
    return;
  }
  if (payload?.billing) state.account.billing = payload.billing;
  const remaining = state.account?.billing?.quota?.remaining;
  state.purchaseBaseline = typeof remaining === "number" ? remaining : 0;
  state.purchase = null;
  state.purchaseError = "";
  state.purchaseNotice = "";
  renderPurchaseModal();
}

function renderPurchaseModal() {
  const root = $("#modal-root");
  if (!root) return;
  const billing = state.account?.billing || {};
  const quota = billing.quota || {};
  const remaining = typeof quota.remaining === "number" ? `${quota.remaining} 次` : "待确认";
  const options = purchaseOptions();
  const purchase = state.purchase;
  const productName = billing.product?.name || "PaperQuest 次数包";

  const optionsHtml = options.length
    ? options.map((option) => {
      const name = String(option.display_name || "次数包").trim();
      const quota = option.quota_amount ? `${option.quota_amount} 次` : "";
      const showQuota = quota && quota.replace(/\s/g, "") !== name.replace(/\s/g, "");
      const meta = [showQuota ? quota : "", optionUnitPrice(option)].filter(Boolean).join(" · ");
      return `
      <button class="plan-card" data-action="buy-plan" data-sku="${escapeHtml(option.sku_id || "")}" ${state.purchaseBusy ? "disabled" : ""}>
        <span class="plan-name">${escapeHtml(name)}</span>
        <span class="plan-quota">${escapeHtml(meta)}</span>
        <span class="plan-price">${escapeHtml(optionPrice(option))}</span>
      </button>
    `;
    }).join("")
    : `<div class="form-status pending">一人付项目还没有可用套餐，请先在控制台配置次数包。</div>`;

  const payHtml = purchase ? `
    <div class="pay-card">
      <div class="pay-head">
        <div>
          <div class="pay-label">ALIPAY · 一人付</div>
          <strong>${escapeHtml(purchase.option?.display_name || "购买次数")}</strong>
        </div>
        <span class="pay-price">${purchase.option ? escapeHtml(optionPrice(purchase.option)) : ""}</span>
      </div>
      ${purchase.purchase_qr_code ? `
        <div class="qr-box">
          <img src="${escapeHtml(purchase.purchase_qr_code)}" alt="支付宝购买二维码">
          <p>用支付宝扫码购买，付款后次数会自动到账。</p>
        </div>
      ` : `<p class="pay-hint">请在支付宝中打开购买页面完成支付。</p>`}
      <div class="pay-actions">
        ${purchase.purchase_url ? `<a class="btn btn-primary" href="${escapeHtml(purchase.purchase_url)}" target="_blank" rel="noopener">在支付宝打开</a>` : ""}
        <button class="btn btn-ghost" data-action="refresh-quota" ${state.purchaseBusy ? "disabled" : ""}>我已支付，刷新次数</button>
      </div>
      ${purchase.expire_time ? `<div class="field-note">购买入口有效期至 ${escapeHtml(purchase.expire_time)}（北京时间）。</div>` : ""}
    </div>
  ` : optionsHtml;

  root.innerHTML = `
    <div class="modal-backdrop open">
      <section class="modal-card purchase-card" role="dialog" aria-modal="true" aria-labelledby="purchase-title">
        <div class="modal-head">
          <div>
            <div class="eyebrow"><span class="eyebrow-line"></span>GAME PASS</div>
            <h2 id="purchase-title">购买调查次数</h2>
          </div>
          <button class="icon-btn" data-action="close-modal" aria-label="关闭购买窗口">×</button>
        </div>
        <p class="modal-lede">${escapeHtml(productName)}：每局消耗 1 次，次数永久有效。当前剩余 <strong>${escapeHtml(remaining)}</strong>。</p>
        ${payHtml}
        ${state.purchaseError ? `<div class="form-status bad">${escapeHtml(state.purchaseError)}</div>` : ""}
        ${state.purchaseNotice ? `<div class="form-status ok">${escapeHtml(state.purchaseNotice)}</div>` : ""}
        <div class="field-note">${purchase
          ? "付款完成后通常几秒内到账；到账会自动刷新并继续。若暂时未显示，请点击「我已支付，刷新次数」，不要重复付款。"
          : "先选择一个套餐，再用支付宝扫码或打开购买页面。付款完成后次数会自动到账。"}</div>
      </section>
    </div>
  `;
  state.modal = "purchase";
  lockBody();
}

let purchaseTimer = null;

function startPurchasePoll() {
  stopPurchasePoll();
  purchaseTimer = setInterval(() => {
    checkPurchase().catch(() => {});
  }, 10000);
}

function stopPurchasePoll() {
  if (purchaseTimer) {
    clearInterval(purchaseTimer);
    purchaseTimer = null;
  }
}

async function checkPurchase() {
  if (state.modal !== "purchase") {
    stopPurchasePoll();
    return;
  }
  const data = await apiFetch("/api/auth/me", {}, 15000);
  state.account = data;
  state.accountLoaded = true;
  renderTopbar();
  const remaining = data.billing?.quota?.remaining;
  const baseline = typeof state.purchaseBaseline === "number" ? state.purchaseBaseline : 0;
  const arrived = typeof remaining === "number" && remaining > baseline;
  if (!arrived) {
    if (state.modal === "purchase") renderPurchaseModal();
    return;
  }
  stopPurchasePoll();
  const pending = state.pendingFile;
  state.pendingFile = null;
  closeModal(false);
  showToast("次数已到账，继续解析论文…");
  if (pending) {
    try {
      await startAnalyze(pending);
    } catch (error) {
      if (!handleBillingError(error, pending)) showError("论文解析没有完成", error);
    }
  }
}

async function buyPlan(skuId) {
  if (state.purchaseBusy) return;
  state.purchaseBusy = true;
  state.purchaseError = "";
  state.purchaseNotice = "";
  renderPurchaseModal();
  try {
    const data = await apiFetch(
      "/api/billing/purchase",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sku_id: skuId || "" }),
      },
      30000,
    );
    state.purchase = data;
  } catch (error) {
    state.purchaseError = error.message || "创建购买入口失败。";
  } finally {
    state.purchaseBusy = false;
    if (state.modal === "purchase") renderPurchaseModal();
    startPurchasePoll();
  }
}

async function refreshQuota() {
  if (state.purchaseBusy) return;
  state.purchaseBusy = true;
  state.purchaseError = "";
  renderPurchaseModal();
  try {
    const data = await apiFetch("/api/auth/me", {}, 20000);
    state.account = data;
    state.accountLoaded = true;
    renderTopbar();
    const remaining = data.billing?.quota?.remaining;
    state.purchaseNotice = typeof remaining === "number"
      ? `已刷新：当前剩余 ${remaining} 次。`
      : "已刷新，仍未查到到账，请稍后再试。";
  } catch (error) {
    state.purchaseError = error.message || "刷新失败。";
  } finally {
    state.purchaseBusy = false;
    if (state.modal === "purchase") renderPurchaseModal();
  }
}

async function logout() {
  try {
    const data = await apiFetch("/api/auth/logout", { method: "POST" }, 15000);
    state.account = { user: null, billing: data.billing || state.account?.billing || null };
    state.accountLoaded = true;
    closeModal();
    renderTopbar();
    refreshLibrary({ silent: true }).catch(() => {});
    showToast("已退出登录，本地案件仍可阅读，但不会再同步资料库。");
  } catch (error) {
    showToast(`退出登录失败：${truncate(error.message, 80)}`, "bad");
  }
}

function handleBillingError(error, file = null) {
  const code = error?.code || "";
  if (code === "LOGIN_REQUIRED") {
    if (file) state.pendingFile = file;
    openAuthModal("请先登录，再开始你的第一局免费调查。");
    return true;
  }
  if (code === "QUOTA_REQUIRED") {
    if (file) state.pendingFile = file;
    state.gameId = "";
    try { sessionStorage.removeItem("pq_game_id"); } catch (_error) { /* ignore */ }
    openPurchaseModal(error.payload || null);
    return true;
  }
  if (code === "GAME_KEY_REUSED") {
    state.gameId = "";
    try { sessionStorage.removeItem("pq_game_id"); } catch (_error) { /* ignore */ }
    if (file) state.pendingFile = file;
    showToast("这一局已经结束，请重新选择论文开始新的一局。", "warn");
    return true;
  }
  if (code === "BILLING_FAILED") {
    state.gameId = "";
    try { sessionStorage.removeItem("pq_game_id"); } catch (_error) { /* ignore */ }
    if (file) state.pendingFile = file;
    showToast("这一局的扣费没有成功，请重新上传开始新的一局。", "bad");
    return true;
  }
  if (code === "BILLING_PENDING") {
    if (file) state.pendingFile = file;
    showToast(error.message || "扣费结果确认中，请稍后重试。", "warn");
    return true;
  }
  return false;
}

function settingsModeText() {
  if (!state.status) {
    return state.statusError
      ? `本地服务状态读取失败：${truncate(state.statusError, 100)}`
      : "正在读取本地模型状态…";
  }
  if (state.status.mock) {
    return "当前为模拟模式。填写 Base URL 与 API Key 后会切换到真实模型；连接字段留空时继续保持模拟模式。";
  }
  if (state.status.real_configured) {
    return `已保存连接：${state.status.host || "云端模型"} · ${state.status.model || "模型"}。连接字段留空时保持现有设置，只更新模型名。`;
  }
  return "尚未配置云端模型。可以接入任意兼容 OpenAI Chat Completions 的接口。";
}

function renderSettingsModal() {
  const root = $("#modal-root");
  if (!root) return;
  const status = state.status;
  const realReady = Boolean(status?.real_configured);
  const hostPlaceholder = realReady && status?.host
    ? `已连接 ${status.host}，留空保持不变`
    : "https://api.openai.com/v1";
  const keyPlaceholder = realReady ? "已保存，留空保持不变" : "sk-...";
  const pendingName = state.pendingFile ? truncate(state.pendingFile.name, 42) : "";
  const notice = state.settingsNotice || (pendingName ? `配置完成后会自动继续解析《${pendingName}》。` : "");
  root.innerHTML = `
    <div class="modal-backdrop open">
      <section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div class="modal-head">
          <div>
            <div class="eyebrow"><span class="eyebrow-line"></span>MODEL ACCESS</div>
            <h2 id="settings-title">模型设置</h2>
          </div>
          <button class="icon-btn" data-action="close-modal" aria-label="关闭模型设置">×</button>
        </div>
        <p class="modal-lede">${escapeHtml(notice || "接入一个兼容 OpenAI Chat Completions 的模型服务。连接信息只发送给这台机器上的 PaperQuest 服务，不会写入浏览器存储。")}</p>
        <form class="settings-form" id="settings-form" autocomplete="off">
          <div class="field">
            <label for="settings-base-url">Base URL</label>
            <input id="settings-base-url" name="base_url" type="text" placeholder="${escapeHtml(hostPlaceholder)}" spellcheck="false">
          </div>
          <div class="field">
            <label for="settings-api-key">API Key</label>
            <input id="settings-api-key" name="api_key" type="password" placeholder="${escapeHtml(keyPlaceholder)}" autocomplete="new-password" spellcheck="false">
          </div>
          <div class="field">
            <label for="settings-model">模型名</label>
            <input id="settings-model" name="model" type="text" value="${escapeHtml(status?.model || "gpt-4o-mini")}" placeholder="gpt-4o-mini" spellcheck="false">
          </div>
          <div class="field-note">兼容 OpenAI、DeepSeek、Moonshot、通义等 OpenAI-compatible 接口。Base URL 一般以 <span class="mono">/v1</span> 结尾；程序会自动补上 <span class="mono">/chat/completions</span>。</div>
          <div class="form-status pending" id="settings-status">${escapeHtml(settingsModeText())}</div>
          <div class="modal-actions">
            <button class="btn btn-ghost" type="button" data-action="test-connection">测试连接</button>
            <button class="btn btn-primary" type="submit">${pendingName ? "保存并继续" : "保存设置"}</button>
          </div>
        </form>
      </section>
    </div>
  `;
  state.modal = "settings";
  lockBody();
  setTimeout(() => $("#settings-base-url")?.focus(), 40);
}

async function openSettings(notice = "") {
  state.settingsNotice = notice || "";
  if (!state.status) {
    try {
      await refreshStatus();
    } catch (error) {
      state.statusError = error.message;
      renderTopbar();
    }
  }
  renderSettingsModal();
}

function setSettingsStatus(text, type = "pending") {
  const status = $("#settings-status");
  if (!status) return;
  status.className = `form-status ${type}`;
  status.textContent = text;
}

function setSettingsBusy(busy) {
  const form = $("#settings-form");
  if (!form) return;
  $$("button, input", form).forEach((element) => {
    element.disabled = busy;
  });
}

async function saveSettings(testOnly = false) {
  if (settingsBusy) return;
  const form = $("#settings-form");
  if (!form) return;
  const formData = new FormData(form);
  const baseUrl = String(formData.get("base_url") || "").trim();
  const apiKey = String(formData.get("api_key") || "").trim();
  const model = String(formData.get("model") || "").trim();
  const hasExisting = Boolean(state.status?.real_configured || state.status?.mock);

  if (!baseUrl && !apiKey && !hasExisting) {
    setSettingsStatus("请填写 Base URL 与 API Key；也可以先关闭设置，试玩示例案件。", "bad");
    return;
  }
  if ((baseUrl && !apiKey) || (!baseUrl && apiKey)) {
    setSettingsStatus(baseUrl ? "请填写 API Key。" : "请填写 Base URL。", "bad");
    return;
  }

  settingsBusy = true;
  setSettingsBusy(true);
  setSettingsStatus(testOnly ? "正在保存并测试连接…" : "正在保存设置…", "pending");
  try {
    const configResult = await apiFetch(
      "/api/config",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, model }),
      },
      25000,
    );
    if (configResult.status) state.status = configResult.status;
    renderTopbar();

    if (testOnly) {
      setSettingsStatus("正在向模型发送一条测试消息…", "pending");
      const result = await apiFetch("/api/config/test", { method: "POST" }, 190000);
      if (!result.ok) throw new AppError("连接已返回，但模型没有按约定应答。");
      const pendingHint = state.pendingFile ? " 现在可以点击「保存并继续」。" : "";
      setSettingsStatus(`连接成功${result.mock ? "（模拟模型可用）" : ""}。${pendingHint}`, "ok");
      return;
    }

    if (!state.status.real_configured && !state.status.mock) {
      setSettingsStatus("连接信息尚未生效。请同时填写 Base URL 与 API Key。", "bad");
      return;
    }

    const fileToContinue = state.pendingFile;
    state.pendingFile = null;
    closeModal(false);
    if (fileToContinue) {
      showToast("模型已保存，继续解析论文…");
      try {
        await startAnalyze(fileToContinue);
      } catch (error) {
        if (handleBillingError(error, fileToContinue)) return;
        showError("论文解析没有完成", error);
      }
    } else {
      render();
      showToast("模型设置已保存。");
    }
  } catch (error) {
    setSettingsStatus(error?.message || "保存失败，请重试。", "bad");
  } finally {
    settingsBusy = false;
    setSettingsBusy(false);
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightQuote(block, quote) {
  const raw = String(block || "");
  const cleaned = String(quote || "").trim();
  if (!raw || cleaned.length < 12) return escapeHtml(raw);
  const words = cleaned.split(/\s+/).filter(Boolean);
  const variants = [
    words.slice(0, 24).join(" "),
    words.slice(0, 16).join(" "),
    words.slice(0, 10).join(" "),
  ].filter((value) => value.length >= 12);
  for (const variant of variants) {
    try {
      const pattern = variant.split(/\s+/).map(escapeRegExp).join("\\s+");
      const match = new RegExp(pattern, "i").exec(raw);
      if (match) {
        return escapeHtml(raw.slice(0, match.index))
          + `<mark>${escapeHtml(match[0])}</mark>`
          + escapeHtml(raw.slice(match.index + match[0].length));
      }
    } catch (_error) {
      // Ignore a bad regex and try a shorter fragment.
    }
  }
  return escapeHtml(raw);
}

function readerParagraphText(block) {
  return String(block || "")
    .replace(/-\s*\n\s*/g, "-")
    .replace(/\s*\n\s*/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function looksLikeHeading(block) {
  const compact = readerParagraphText(block).replace(/^#{1,6}\s+/, "");
  if (!compact || compact.length > 120) return false;
  if (String(block || "").split("\n").filter((line) => line.trim()).length > 2) return false;
  return /^(abstract|introduction|related work|background|method|methods|approach|experimental setup|experiments?|evaluation|results?|ablation|discussion|limitations?|conclusion|references|appendix|\d+(?:\.\d+)*\s+[A-Z][^\n]{1,90})$/i.test(compact);
}

function paperReaderHeadHtml() {
  const paper = paperOf() || {};
  const title = String(paper.title || paperTitle() || "").trim();
  const details = [paper.authors, paper.venue, paper.year]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  if (state.meta?.pages) details.push(`${state.meta.pages} 页`);
  return `
    <div class="reader-paper-head">
      <div class="reader-paper-title">${escapeHtml(title)}</div>
      ${details.length ? `<div class="reader-paper-meta">${escapeHtml(details.join(" · "))}</div>` : ""}
    </div>
  `;
}

function paperContentBlocks(text = state.paperText) {
  const paper = paperOf() || {};
  const title = String(paper.title || paperTitle() || "").trim();
  const authors = String(paper.authors || "").trim();
  const blocks = String(text || "").split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  const titleKey = readerParagraphText(title).toLowerCase();
  if (blocks.length && titleKey) {
    const firstKey = readerParagraphText(blocks[0]).replace(/^#{1,6}\s+/, "").toLowerCase();
    if (firstKey === titleKey || (firstKey.length > 12 && titleKey.startsWith(firstKey.slice(0, 24)))) {
      blocks.shift();
      if (blocks.length) {
        const nextKey = readerParagraphText(blocks[0]).replace(/^#{1,6}\s+/, "").toLowerCase();
        const combined = `${firstKey} ${nextKey}`.replace(/\s+/g, " ").trim();
        if (combined.length <= titleKey.length + 6 && titleKey.startsWith(combined.slice(0, 24))) {
          blocks.shift();
        }
      }
    }
  }
  if (authors && blocks.length) {
    const first = readerParagraphText(blocks[0]);
    if (first === authors) {
      blocks.shift();
    } else if (first.startsWith(`${authors} `)) {
      const rest = first.slice(authors.length).trim();
      if (rest) blocks[0] = rest;
      else blocks.shift();
    }
  }
  return blocks;
}

function readerBodyHtml(text, quote) {
  const blocks = paperContentBlocks(text);
  if (!blocks.length) return `<p class="muted">没有可显示的论文文本。</p>`;
  return blocks.map((block) => {
    if (looksLikeHeading(block)) {
      return `<h4>${escapeHtml(readerParagraphText(block).replace(/^#{1,6}\s+/, ""))}</h4>`;
    }
    return `<p>${highlightQuote(readerParagraphText(block), quote)}</p>`;
  }).join("");
}

function paperMarkdownText() {
  const paper = paperOf() || {};
  const title = String(paper.title || paperTitle() || "论文原文").trim();
  const authors = String(paper.authors || "").trim();
  const blocks = paperContentBlocks();
  const body = blocks.map((block) => {
    if (looksLikeHeading(block)) {
      const compact = readerParagraphText(block).replace(/^#{1,6}\s+/, "");
      const depth = /^\d+\.\d+/.test(compact) ? "###" : "##";
      return `${depth} ${compact}`;
    }
    return readerParagraphText(block);
  }).join("\n\n");
  const header = [`# ${title}`];
  if (authors) header.push("", authors);
  return `${header.join("\n")}\n\n${body}\n`;
}

function switchReaderTab(tab) {
  const root = $("#drawer-root");
  if (!root) return;
  const isPdf = tab === "pdf" && Boolean($(".pdf-pane", root));
  $$(".drawer-tab", root).forEach((button) => {
    const active = (button.dataset.tab === "pdf") === isPdf;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  $$(".drawer-pane", root).forEach((pane) => {
    pane.classList.toggle("active", pane.dataset.pane === (isPdf ? "pdf" : "markdown"));
  });
  const drawer = $(".drawer", root);
  drawer?.classList.toggle("pdf-mode", isPdf);
  const sub = $(".drawer-sub", root);
  if (sub) {
    sub.textContent = isPdf
      ? "PDF 原件 · 引文定位请回到 Markdown 阅读"
      : sub.dataset.defaultText || "";
  }
  const frame = $(".pdf-frame", root);
  if (isPdf && frame && !frame.getAttribute("src")) {
    frame.src = frame.dataset.src || "";
  }
  if (!isPdf) {
    const body = $(".drawer-body", root);
    const mark = $(".reader mark", root);
    if (body && mark) {
      const top = mark.getBoundingClientRect().top
        - body.getBoundingClientRect().top
        + body.scrollTop
        - body.clientHeight / 2;
      body.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    }
  }
}

function closeReader() {
  const root = $("#drawer-root");
  if (!root) return;
  const backdrop = $(".drawer-backdrop", root);
  const drawer = $(".drawer", root);
  if (backdrop) backdrop.classList.remove("open");
  if (drawer) drawer.classList.remove("open");
  if (drawerTimer) clearTimeout(drawerTimer);
  drawerTimer = setTimeout(() => {
    if (root) root.innerHTML = "";
    unlockBodyIfIdle();
  }, 320);
  unlockBodyIfIdle();
}

function renderReader({ quote = "", section = "全文" }) {
  const root = $("#drawer-root");
  if (!root) return;
  if (drawerTimer) {
    clearTimeout(drawerTimer);
    drawerTimer = null;
  }
  const pdfUrl = ensurePaperPdfUrl();
  const pdfTab = pdfUrl
    ? `<button type="button" class="drawer-tab" data-action="reader-tab" data-tab="pdf" role="tab" aria-selected="false">PDF 原件</button>`
    : "";
  const pdfTool = pdfUrl
    ? `<a class="drawer-tool" href="${escapeHtml(pdfUrl)}" target="_blank" rel="noopener">新窗口打开</a>`
    : `<span class="drawer-tool muted">未附 PDF</span>`;
  root.innerHTML = `
    <div class="drawer-backdrop"></div>
    <aside class="drawer" role="dialog" aria-modal="true" aria-label="论文原文">
      <div class="drawer-head">
        <div>
          <h2 class="drawer-title">论文原文</h2>
          <div class="drawer-sub">${escapeHtml(sectionLabel(section))}</div>
        </div>
        <button class="icon-btn" data-action="close-drawer" aria-label="关闭原文">×</button>
      </div>
      <div class="drawer-tabs" role="tablist" aria-label="原文视图">
        <button type="button" class="drawer-tab active" data-action="reader-tab" data-tab="markdown" role="tab" aria-selected="true">Markdown 阅读版</button>
        ${pdfTab}
        <div class="drawer-tools">
          ${pdfTool}
          <button type="button" class="drawer-tool" data-action="download-paper-md">导出 .md</button>
        </div>
      </div>
      <div class="drawer-body">
        <div class="drawer-pane reader-pane active" data-pane="markdown">
          <div class="reader">
            ${paperReaderHeadHtml()}
            ${readerBodyHtml(state.paperText, quote)}
          </div>
        </div>
        ${pdfUrl ? `
          <div class="drawer-pane pdf-pane" data-pane="pdf">
            <iframe class="pdf-frame" title="论文 PDF 原件" data-src="${escapeHtml(pdfUrl)}" loading="lazy"></iframe>
          </div>
        ` : ""}
      </div>
    </aside>
  `;
  lockBody();
  const backdrop = $(".drawer-backdrop", root);
  const drawer = $(".drawer", root);
  if (drawer) void drawer.offsetWidth;
  backdrop?.classList.add("open");
  drawer?.classList.add("open");
  setTimeout(() => {
    const body = $(".drawer-body", root);
    const mark = $(".reader mark", root);
    const sub = $(".drawer-sub", root);
    if (sub) sub.dataset.defaultText = sub.textContent || sectionLabel(section);
    if (quote && mark && body) {
      if (sub) {
        sub.textContent = `${sectionLabel(section)} · 已定位摘录`;
        sub.dataset.defaultText = sub.textContent;
      }
      const top = mark.getBoundingClientRect().top
        - body.getBoundingClientRect().top
        + body.scrollTop
        - body.clientHeight / 2;
      body.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    } else if (quote) {
      if (sub) {
        sub.textContent = `${sectionLabel(section)} · 未精确定位，显示全文`;
        sub.dataset.defaultText = sub.textContent;
      }
      if (body) {
        const note = document.createElement("div");
        note.className = "reader-note";
        note.textContent = "提取文本中未能精确定位这段摘录，已显示论文全文。可在页面中搜索关键短语。";
        const pane = $(".reader-pane", body);
        const reader = $(".reader", pane);
        if (pane && reader) pane.insertBefore(note, reader);
      }
    }
    $(".drawer .icon-btn", root)?.focus();
  }, 230);
}

function openSourceReader(scope = "paper", levelIndex = null, claimId = null) {
  if (!state.paperText) {
    showToast("当前案件没有可显示的原文文本。", "bad");
    return;
  }
  let quote = "";
  let section = "全文";
  if (scope === "claim") {
    const claims = Array.isArray(paperOf().claims) ? paperOf().claims : [];
    const claim = claims.find((item, index) => (item.id || `C${index + 1}`) === claimId) || claims[0];
    if (claim) {
      quote = claim.evidence_quote || "";
      section = claim.section || "正文";
    }
  } else if (scope === "level" || scope === "followup") {
    const index = Number.isInteger(levelIndex) ? levelIndex : state.currentLevel;
    const level = state.levels[index] || state.levels[state.currentLevel];
    if (level) {
      if (scope === "followup") {
        quote = level.followup?.source_quote || level.source_quote || "";
      } else {
        quote = level.source_quote || "";
      }
      section = level.source_section || "正文";
    }
  }
  renderReader({ quote, section });
}

/* ---------- events and boot ---------- */

async function dispatchAction(actionEl) {
  const action = actionEl.dataset.action;
  switch (action) {
    case "upload":
      requestUpload();
      break;
    case "home":
      goHome();
      break;
    case "resume-current":
      resumeCurrent();
      break;
    case "open-select":
      state.screen = "select";
      render();
      break;
    case "choose-character":
      chooseCharacter(actionEl.dataset.id);
      break;
    case "continue-story":
      continueStory();
      break;
    case "story-hotspot":
    case "story-clue":
      openStoryHotspot(actionEl.dataset.id);
      break;
    case "story-deduct": {
      const index = Number(actionEl.dataset.index);
      if (Number.isInteger(index)) submitStoryDeduction(index);
      break;
    }
    case "next-story-act":
      await nextStoryAct();
      break;
    case "open-story-quote":
      openStoryClueSource(actionEl.dataset.id);
      break;
    case "open-library":
      await openLibrary();
      break;
    case "refresh-library":
      await refreshLibrary();
      break;
    case "save-case":
      await saveCurrentCase();
      break;
    case "load-case":
      await requestLoadCase(actionEl.dataset.id);
      break;
    case "delete-case":
      requestDeleteCase(actionEl.dataset.id);
      break;
    case "confirm-delete":
      await confirmDeleteCase(actionEl);
      break;
    case "confirm-load": {
      const targetId = actionEl.dataset.id || state.loadTarget;
      state.loadTarget = null;
      if (targetId) await loadSavedCase(targetId);
      break;
    }
    case "start-game":
      await startGame();
      break;
    case "back-to-case":
      goCase();
      break;
    case "retry-generate":
      await prefetchLevels(true);
      break;
    case "open-settings":
      await openSettings();
      break;
    case "open-auth":
      openAuthModal();
      break;
    case "auth-tab":
      state.authMode = actionEl.dataset.mode === "register" ? "register" : "login";
      state.authNotice = "";
      renderAuthModal();
      break;
    case "open-account":
      openAccountModal();
      break;
    case "open-purchase":
      openPurchaseModal();
      break;
    case "buy-plan":
      await buyPlan(actionEl.dataset.sku || "");
      break;
    case "refresh-quota":
      await refreshQuota();
      break;
    case "logout":
      await logout();
      break;
    case "close-modal":
      closeModal();
      break;
    case "test-connection":
      await saveSettings(true);
      break;
    case "select-option": {
      const phase = actionEl.dataset.phase === "followup" ? "followup" : "main";
      const index = Number(actionEl.dataset.index);
      if (Number.isInteger(index)) selectOption(phase, index);
      break;
    }
    case "submit-choice": {
      const phase = actionEl.dataset.phase === "followup" ? "followup" : "main";
      submitChoice(phase);
      break;
    }
    case "view-analysis": {
      const phase = actionEl.dataset.phase === "followup" ? "followup" : "main";
      revealAnalysis(phase);
      break;
    }
    case "select-assembly": {
      const categoryIndex = Number(actionEl.dataset.cat);
      const optionIndex = Number(actionEl.dataset.opt);
      if (Number.isInteger(categoryIndex) && Number.isInteger(optionIndex)) {
        selectAssembly(categoryIndex, optionIndex);
      }
      break;
    }
    case "submit-assembly":
      submitAssembly();
      break;
    case "use-hint":
      useHint();
      break;
    case "next-level":
      nextLevel();
      break;
    case "open-source": {
      const scope = actionEl.dataset.scope || "paper";
      const rawIndex = actionEl.dataset.levelIndex;
      const levelIndex = rawIndex == null || rawIndex === "" ? null : Number(rawIndex);
      openSourceReader(scope, Number.isInteger(levelIndex) ? levelIndex : null, actionEl.dataset.claimId || null);
      break;
    }
    case "reader-tab":
      switchReaderTab(actionEl.dataset.tab || "markdown");
      break;
    case "download-paper-md":
      downloadTextFile(
        `PaperQuest_原文_${sanitizeFileName(paperTitle())}.md`,
        paperMarkdownText(),
      );
      showToast("Markdown 版本已开始下载。");
      break;
    case "close-drawer":
      closeReader();
      break;
    case "build-outline":
      buildOutlineFromResults();
      break;
    case "copy-outline": {
      syncReflection();
      const nextOutline = buildOutlineText();
      if (nextOutline !== state.outline) {
        state.outline = nextOutline;
        const outlineNode = $(".outline");
        if (outlineNode) outlineNode.textContent = nextOutline;
      }
      scheduleProgressSave();
      await copyText(state.outline);
      showToast("阅读大纲已复制到剪贴板。");
      break;
    }
    case "download-report": {
      syncReflection();
      state.outline = buildOutlineText();
      scheduleProgressSave();
      const report = buildReportMarkdown();
      downloadTextFile(`PaperQuest_结案报告_${sanitizeFileName(paperTitle())}.md`, report);
      showToast("结案报告已开始下载。");
      break;
    }
    case "restart-game": {
      if (!state.levels.length) return;
      const characterId = state.story?.character || "";
      state.levelStates = state.levels.map(initializeLevelState);
      state.currentLevel = 0;
      state.reflection = "";
      state.outline = "";
      state.startedAt = Date.now();
      state.completedAt = null;
      state.story = freshStory(characterId);
      state.storyClueId = null;
      state.screen = characterId ? "story" : "select";
      scheduleProgressSave();
      render();
      showToast("调查进度与分数已重置，可以重新走一遍四幕现场。");
      break;
    }
    case "new-paper":
      await flushProgressSave();
      state.epoch += 1;
      resetCase();
      state.screen = "home";
      render();
      break;
    default:
      break;
  }
}

function bindEvents() {
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.classList.contains("modal-backdrop")) {
      closeModal();
      return;
    }
    if (target.classList.contains("drawer-backdrop")) {
      closeReader();
      return;
    }
    const actionEl = target.closest("[data-action]");
    if (!actionEl) return;
    event.preventDefault();
    dispatchAction(actionEl).catch((error) => {
      console.error(error);
      showError("操作没有完成", error);
    });
  });

  document.addEventListener("submit", (event) => {
    if (event.target?.id === "settings-form") {
      event.preventDefault();
      saveSettings(false).catch((error) => {
        console.error(error);
        setSettingsStatus(error?.message || "保存失败。", "bad");
      });
      return;
    }
    if (event.target?.id === "auth-form") {
      event.preventDefault();
      submitAuth().catch((error) => {
        console.error(error);
        setAuthNotice(error?.message || "登录失败。", "bad");
      });
    }
  });

  document.addEventListener("input", (event) => {
    if (event.target?.id === "reflection") {
      state.reflection = event.target.value;
      if (state.caseId) scheduleProgressSave(700);
    }
  });

  const fileInput = $("#file-input");
  if (fileInput) {
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (file) {
        handleFile(file).catch((error) => {
          console.error(error);
          showError("论文没有打开", error);
        });
      }
    });
  }

  let dragDepth = 0;
  const overlay = $("#drop-overlay");
  const hasFiles = (event) => Array.from(event.dataTransfer?.types || []).includes("Files");
  window.addEventListener("dragenter", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    overlay?.classList.add("open");
  });
  window.addEventListener("dragover", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  });
  window.addEventListener("dragleave", (event) => {
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) overlay?.classList.remove("open");
  });
  window.addEventListener("drop", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    overlay?.classList.remove("open");
    const file = event.dataTransfer?.files?.[0];
    if (file) {
      handleFile(file).catch((error) => {
        console.error(error);
        showError("论文没有打开", error);
      });
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if ($(".modal-backdrop.open")) {
      closeModal();
      return;
    }
    if ($(".drawer.open")) {
      closeReader();
    }
  });
}

async function init() {
  bindEvents();
  render();
  refreshLibrary({ silent: true });
  try {
    await refreshStatus();
    if (state.screen === "home") render();
  } catch (error) {
    state.statusError = error.message;
    renderTopbar();
    if (state.screen === "home") render();
  }
  await refreshAccount(false);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
