"use strict";

/* PaperQuest detective mode: investigator select, four first-person acts, clue deduction. */

const CHARACTERS = [
  {
    id: "lin",
    name: "林砚",
    role: "档案员",
    tag: "ARCHIVIST",
    portrait: "/static/assets/art/char-lin.jpg",
    accent: "#d6a64a",
    passive: "索引记忆",
    passiveShort: "整局 1 次免费提示",
    description: "习惯先读目录，再读正文。能在杂乱卷宗里一眼找到被忽略的那一页。",
    ability: "整局仅一次：使用提示不扣分。",
    line: "我把索引卡按年份排开。顺序被打断的地方，通常就是有人动过的地方。",
  },
  {
    id: "shen",
    name: "沈砾",
    role: "实验员",
    tag: "EXPERIMENTALIST",
    portrait: "/static/assets/art/char-shen.jpg",
    accent: "#58b8aa",
    passive: "沙盘推演",
    passiveShort: "装配关每类排除一个错误项",
    description: "相信可复现的装置胜过漂亮的说辞。她会在实验台上先排除不可能的配置。",
    ability: "在「实验装配」题中，每个分类自动排除一个错误选项。",
    line: "先看装置，再看结论。不能复现的实验，不值得相信。",
  },
  {
    id: "gu",
    name: "顾言",
    role: "审稿人",
    tag: "REVIEWER",
    portrait: "/static/assets/art/char-gu.jpg",
    accent: "#c76a5a",
    passive: "反诘训练",
    passiveShort: "审稿关提示不扣分",
    description: "从不满足于作者的第一句解释。他总在追问：这条结论究竟能推到哪里？",
    ability: "在「审稿对线」关使用提示不扣分。",
    line: "我先读 Limitations。作者自己承认的边界，往往比摘要更诚实。",
  },
];

function storyPlain(value, fallback = "") {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || fallback;
}

function storyList(value, fallback) {
  const items = Array.isArray(value)
    ? value.map((item) => storyPlain(item)).filter(Boolean)
    : [];
  return items.length ? items.join("；") : fallback;
}

function storyShort(value, max = 100) {
  return truncate(storyPlain(value), max);
}

function freshStory(character = "") {
  return {
    character: character || "",
    sceneIndex: 0,
    clues: [],
    solved: [],
    answers: {},
    finished: false,
    freeHintAvailable: true,
    startedAt: Date.now(),
    finishedAt: null,
  };
}

function restoreStory(saved) {
  if (!saved || typeof saved !== "object" || !saved.character) return null;
  if (!CHARACTERS.some((character) => character.id === saved.character)) return null;
  const acts = storyActs();
  const clueIds = new Set(acts.flatMap((act) => act.hotspots.map((clue) => clue.id)));
  const actIds = new Set(acts.map((act) => act.id));
  const clues = Array.isArray(saved.clues)
    ? [...new Set(saved.clues.filter((id) => clueIds.has(id)))]
    : [];
  const solved = Array.isArray(saved.solved)
    ? [...new Set(saved.solved.filter((id) => actIds.has(id)))]
    : [];
  const answers = {};
  if (saved.answers && typeof saved.answers === "object") {
    acts.forEach((act) => {
      const entry = saved.answers[act.id];
      if (!entry || typeof entry !== "object") return;
      answers[act.id] = {
        solved: entry.solved === true || solved.includes(act.id),
        wrong: Array.isArray(entry.wrong)
          ? [...new Set(entry.wrong.filter((index) => Number.isInteger(index) && index >= 0 && index < 3))]
          : [],
      };
    });
  }
  const sceneIndex = Number.isInteger(saved.sceneIndex)
    ? Math.max(0, Math.min(acts.length - 1, saved.sceneIndex))
    : 0;
  return {
    character: saved.character,
    sceneIndex,
    clues,
    solved,
    answers,
    finished: saved.finished === true,
    freeHintAvailable: saved.freeHintAvailable !== false,
    startedAt: Number(saved.startedAt) || Date.now(),
    finishedAt: Number(saved.finishedAt) || null,
  };
}

function activeCharacter() {
  return CHARACTERS.find((character) => character.id === state.story?.character) || null;
}

function assemblyExcludedIndex(level, categoryIndex) {
  if (activeCharacter()?.id !== "shen") return -1;
  const categories = Array.isArray(level?.categories) ? level.categories : [];
  const category = categories[categoryIndex];
  if (!category || !Array.isArray(category.options)) return -1;
  const wrong = category.options
    .map((_option, index) => index)
    .filter((index) => index !== Number(category.answer_index));
  if (!wrong.length) return -1;
  const seed = (Number(state.currentLevel) || 0) * 7 + categoryIndex * 3 + 1;
  return wrong[seed % wrong.length];
}

function storyActSolved(act) {
  if (!act || !state.story) return false;
  return state.story.solved.includes(act.id) || state.story.answers?.[act.id]?.solved === true;
}

function storyClueFound(id) {
  return Boolean(state.story?.clues?.includes(id));
}

function storyFoundCount(act) {
  if (!act) return 0;
  return act.hotspots.filter((clue) => storyClueFound(clue.id)).length;
}

function storyCurrentAct() {
  const acts = storyActs();
  if (!acts.length) return null;
  const index = Math.max(0, Math.min(acts.length - 1, Number(state.story?.sceneIndex) || 0));
  return acts[index];
}

function storyProgressSummary() {
  const acts = storyActs();
  const solved = acts.filter((act) => storyActSolved(act)).length;
  let nextIndex = acts.findIndex((act) => !storyActSolved(act));
  if (nextIndex < 0) nextIndex = Math.max(0, acts.length - 1);
  return {
    total: acts.length,
    solved,
    started: Boolean(state.story?.character),
    finished: Boolean(state.story?.finished),
    nextIndex,
    nextTitle: acts[nextIndex]?.title || "结案",
  };
}

function storyDeduction({ prompt, correct, distractors, answer, hint, explanation, note }) {
  const answerIndex = Math.max(0, Math.min(2, Number(answer) || 0));
  const correctText = storyShort(correct, 108);
  const unique = [];
  distractors.forEach((item) => {
    const text = storyShort(item, 108);
    if (text && text !== correctText && !unique.includes(text) && unique.length < 2) unique.push(text);
  });
  while (unique.length < 2) {
    unique.push(`案卷里没有这一条记录（备选 ${unique.length + 1}）。`);
  }
  const options = unique.slice(0, 2);
  options.splice(answerIndex, 0, correctText);
  return {
    prompt,
    options,
    answer_index: answerIndex,
    hint,
    explanation,
    note,
  };
}

function storyActs() {
  if (!state.caseData?.paper) return [];
  const paper = paperOf();
  const method = paper.method || {};
  const claims = Array.isArray(paper.claims)
    ? paper.claims.filter((claim) => storyPlain(claim?.text))
    : [];
  const limitations = Array.isArray(paper.limitations)
    ? paper.limitations.map((item) => storyPlain(item)).filter(Boolean)
    : [];

  const title = storyShort(paper.title || paperTitle(), 58);
  const summary = storyPlain(paper.one_sentence_summary, "论文没有提供一句话摘要。");
  const gap = storyPlain(paper.gap, "论文没有单独写出研究缺口，只留下一个研究问题。");
  const question = storyPlain(paper.research_question, "论文没有明确写出研究问题。");
  const methodSummary = storyPlain(method.summary, "论文没有提供方法摘要。");
  const components = storyList(method.key_components, "论文没有列出方法组件。");
  const dataset = storyPlain(method.dataset, "论文未报告数据集。");
  const baselines = storyList(method.baselines, "论文未报告基线。");
  const metrics = storyList(method.metrics, "论文未报告评价指标。");
  const limitationA = limitations[0] || "论文没有单列研究局限。";
  const limitationB = limitations[1] || "论文没有进一步报告失败案例。";
  const evidenced = claims.find((claim) => storyPlain(claim.evidence_quote)) || null;
  const orderedClaims = evidenced
    ? [evidenced, ...claims.filter((claim) => claim !== evidenced)]
    : claims;
  const claimA = orderedClaims[0] || null;
  const claimB = orderedClaims[1] || null;
  const claimC = orderedClaims[2] || null;
  const quoteStats = state.meta?.quote_stats || {};
  const quoteTotal = Number(quoteStats.total) || 0;
  const quoteVerified = Number(quoteStats.verified) || 0;

  const evidenceClue = (claim, fallbackTitle, fallbackText) => {
    if (!claim) {
      return {
        title: fallbackTitle,
        text: fallbackText,
        quote: "",
        section: "",
        verified: null,
      };
    }
    return {
      title: `主张 ${storyPlain(claim.id, claimA === claim ? "C1" : "C")}`,
      text: storyPlain(claim.text),
      quote: storyPlain(claim.evidence_quote),
      section: storyPlain(claim.section, "正文"),
      verified: claim.verified,
    };
  };

  const evidenceA = evidenceClue(
    claimA,
    "投影上的摘要",
    summary,
  );
  const evidenceB = evidenceClue(
    claimB,
    "夹在胶片里的核验记录",
    quoteTotal
      ? `案卷记录了 ${quoteTotal} 条原文引文，其中 ${quoteVerified} 条能在提取文本中逐字定位。`
      : "案卷没有记录原文引文的核验结果。没有引文托底的主张，只能先当作线索。",
  );
  const evidenceC = evidenceClue(
    claimC,
    "软木板边角的批注",
    limitationA,
  );

  const archiveDeduction = storyDeduction({
    prompt: "三份材料指向同一场调查。这项研究真正要补的缺口是——",
    correct: gap,
    distractors: [question, summary, limitationA],
    answer: 1,
    hint: "缺口说的是「现有研究没做到什么」；研究问题说的是「本文要回答什么」；摘要说的是「本文发现了什么」。",
    explanation: "研究缺口是现有研究的空白，研究问题是作者据此提出的问题，摘要里的一句话是研究结果。把三者混在一起，就会把「作者想做什么」误当成「作者已经证明了什么」。",
    note: "结案笔记：研究缺口已定位。先记住作者想补的洞，再去地下实验台核对方法有没有对准它。",
  });

  const labDeduction = storyDeduction({
    prompt: "把三张实验记录拼起来，这套研究设计真正在做什么？",
    correct: methodSummary,
    distractors: [
      summary,
      limitationA,
      "只更换了损失函数，模型结构与训练流程完全没有变化。",
    ],
    answer: 2,
    hint: "方法摘要回答「怎么做」；一句话简报回答「发现了什么」；局限回答「不能推到哪」。先分清这三件事。",
    explanation: "方法摘要描述研究如何落地：组件、数据与流程。一句话简报是结果，局限是边界。判断方法时，要找可复现的配置，而不是漂亮的结果陈述。",
    note: "结案笔记：方法必须能落成配置。数据集、组件、基线、指标，是核对一篇实证论文的四颗钉子。",
  });

  const evidenceDeduction = evidenced
    ? storyDeduction({
      prompt: "哪一条主张在案卷里留下了可回链的原文证据？",
      correct: evidenced.text,
      distractors: [
        summary,
        (claimA && claimA !== evidenced ? claimA.text : claimB?.text) || limitationA,
        limitationA,
      ],
      answer: 0,
      hint: "不要找「听起来最重要」的结论，要找那条旁边贴着原文引文、能回到具体章节的主张。",
      explanation: "有原文托底的主张，才能被逐字核对；没有引文的结论只能算线索。证据链不是把结论重复一遍，而是能找到它在原文中的位置。",
      note: "结案笔记：主张与引文必须一一对应。没有出处的结论，再漂亮也不能写进结案报告。",
    })
    : storyDeduction({
      prompt: "逐页核对之后，哪句话最准确？",
      correct: "案卷里没有任何一条主张附有可回链的原文引文。",
      distractors: [claimA?.text || summary, summary, limitationA],
      answer: 2,
      hint: "先看每条主张旁边有没有跟着原文引文，再判断哪句话最诚实。",
      explanation: "这份案卷没有留下可回链的原文引文。在这种情况下，最专业的判断不是替作者补证据，而是明确指出证据链缺失。",
      note: "结案笔记：证据链缺失本身就是重要发现。写报告时要区分「作者的主张」与「你能核对的证据」。",
    });

  const reviewDeduction = storyDeduction({
    prompt: "哪一句追问，真正落在论文自己承认的边界上？",
    correct: limitationA,
    distractors: [
      summary,
      "为什么不使用更大的预训练模型？",
      methodSummary,
    ],
    answer: 1,
    hint: "先排除与论文证据无关的泛问，再找 Limitations 里作者亲口承认的限制。",
    explanation: "作者自己承认的边界，是最可靠的追问起点；泛泛地问「为什么不用更大模型」，并没有落在论文的证据与设计上。好的追问沿着作者承认的限制再往前一步。",
    note: "结案笔记：好的追问不是抬杠，而是沿着作者承认的边界再往前一步。四幕到此结束，接下来是结案审讯。",
  });

  return [
    {
      id: "archive",
      roman: "第一幕",
      short: "缺口",
      title: "雨夜档案馆",
      en: "THE ARCHIVE",
      time: "23:47",
      scene: "/static/assets/art/scene-archive.jpg",
      objective: "在档案馆找到三处被动过的痕迹，判断这项研究真正要补的缺口。",
      intro: [
        "23:47。档案馆的暖气早就停了，雨水顺着高窗往下爬，像有人在玻璃外面用指甲划字。",
        `值班员只留下一句话：有人翻过《${title}》的卷宗。`,
        "我拉开椅子。桌上摊着三样东西：一份研究缺口备忘、一张借阅登记卡、一页折角的摘要。要立案，先得弄清作者想补哪个洞。",
      ],
      hotspots: [
        {
          id: "archive-gap",
          x: 27,
          y: 55,
          label: "摊开的缺口备忘",
          title: "研究缺口备忘",
          text: gap,
          quote: "",
        },
        {
          id: "archive-question",
          x: 54,
          y: 37,
          label: "借阅登记卡",
          title: "登记卡上的研究问题",
          text: question,
          quote: "",
        },
        {
          id: "archive-summary",
          x: 77,
          y: 51,
          label: "折角的摘要",
          title: "摘要页的承诺",
          text: summary,
          quote: "",
        },
      ],
      deduction: archiveDeduction,
    },
    {
      id: "lab",
      roman: "第二幕",
      short: "方法",
      title: "地下实验台",
      en: "THE LAB",
      time: "00:36",
      scene: "/static/assets/art/scene-lab.jpg",
      objective: "核对实验台的三份记录，还原论文的方法与实验配置。",
      intro: [
        "地下实验台的风机在头顶低鸣。显示器还亮着，像一排没合上的眼睛。",
        "设备清单、白板残图、基线记录——有人在这里试图复现论文的实验。",
        "我戴上手套。方法不是口号，它必须落成可核对的配置。",
      ],
      hotspots: [
        {
          id: "lab-config",
          x: 22,
          y: 55,
          label: "实验台配置单",
          title: "数据集与指标",
          text: `数据集：${dataset}。评价指标：${metrics}。`,
          quote: "",
        },
        {
          id: "lab-board",
          x: 50,
          y: 36,
          label: "白板残图",
          title: "方法组件",
          text: components,
          quote: "",
        },
        {
          id: "lab-baseline",
          x: 75,
          y: 57,
          label: "基线记录",
          title: "对照基线",
          text: baselines,
          quote: "",
        },
      ],
      deduction: labDeduction,
    },
    {
      id: "data",
      roman: "第三幕",
      short: "证据",
      title: "数据观测室",
      en: "THE OBSERVATORY",
      time: "01:18",
      scene: "/static/assets/art/scene-data.jpg",
      objective: "核对投影与图钉下的主张，找出真正有原文托底的那一条。",
      intro: [
        "数据观测室的投影仪没有关。红色图钉把三页结果钉在软木板上，红绳在它们之间拉出证据链。",
        "每一条主张都该有原文托底。没有出处的结论，只是漂亮的猜测。",
        "我逐条核对：作者说了什么，证据又说了什么。",
      ],
      hotspots: [
        {
          id: "data-claim-1",
          x: 26,
          y: 48,
          label: "红色图钉下的主张",
          title: evidenceA.title,
          text: evidenceA.text,
          quote: evidenceA.quote,
          section: evidenceA.section,
          verified: evidenceA.verified,
        },
        {
          id: "data-claim-2",
          x: 52,
          y: 35,
          label: "投影上的第二页",
          title: evidenceB.title,
          text: evidenceB.text,
          quote: evidenceB.quote,
          section: evidenceB.section,
          verified: evidenceB.verified,
        },
        {
          id: "data-claim-3",
          x: 75,
          y: 55,
          label: "软木板边角",
          title: evidenceC.title,
          text: evidenceC.text,
          quote: evidenceC.quote,
          section: evidenceC.section,
          verified: evidenceC.verified,
        },
      ],
      deduction: evidenceDeduction,
    },
    {
      id: "review",
      roman: "第四幕",
      short: "边界",
      title: "审稿人密室",
      en: "THE REVIEW CHAMBER",
      time: "02:04",
      scene: "/static/assets/art/scene-review.jpg",
      objective: "读作者自己承认的边界，找出最专业的那个追问。",
      intro: [
        "审稿人密室在走廊尽头。长桌上摆着八把空椅子，只有一盏黄灯亮着。",
        "论文被红绳捆着，旁边是一封没寄出的审稿意见。",
        "作者已经回应过一次。现在轮到我决定：哪些追问真正落在论文承认的边界上。",
      ],
      hotspots: [
        {
          id: "review-limit-1",
          x: 25,
          y: 53,
          label: "未寄出的审稿意见",
          title: "作者承认的边界",
          text: limitationA,
          quote: "",
        },
        {
          id: "review-limit-2",
          x: 53,
          y: 36,
          label: "作者回应页边",
          title: "第二条边界",
          text: limitationB,
          quote: "",
        },
        {
          id: "review-note",
          x: 75,
          y: 54,
          label: "红笔圈出的句子",
          title: "审稿人的批注",
          text: "先问论文自己承认了什么，再问证据还能推到哪。外部效度、消融缺口、失败案例，都是可追问的入口。",
          quote: "",
        },
      ],
      deduction: reviewDeduction,
    },
  ];
}

/* ---------- character selection screen ---------- */

function selectHtml() {
  if (!state.caseData) return homeHtml();
  const paper = paperOf();
  return `
    <div class="select-screen">
      <div class="select-backdrop" style="background-image:url('/static/assets/art/cover.jpg')"></div>
      <div class="select-veil"></div>
      <div class="select-inner">
        <div class="select-top">
          <button class="story-link" data-action="back-to-case">← 案件档案</button>
          <span class="select-case-id">CASE FILE · ${escapeHtml(storyShort(paper.title || paperTitle(), 64))}</span>
        </div>
        <header class="select-head">
          <div class="eyebrow"><span class="eyebrow-line"></span>CHOOSE YOUR INVESTIGATOR</div>
          <h1>谁会接手<br>这桩案子？</h1>
          <p>三位调查员各有一种被动能力。选定后，你会以第一人称进入四幕现场；四幕结束，才进入 100 分制结案考核。</p>
        </header>
        <div class="character-grid">
          ${CHARACTERS.map((character, index) => `
            <button class="character-card" data-action="choose-character" data-id="${escapeHtml(character.id)}" style="--character-accent:${character.accent}">
              <span class="character-portrait" style="background-image:url('${escapeHtml(character.portrait)}')">
                <span class="character-index">0${index + 1}</span>
                <span class="character-tag">${escapeHtml(character.tag)}</span>
              </span>
              <span class="character-body">
                <span class="character-name-row">
                  <strong>${escapeHtml(character.name)}</strong>
                  <span>${escapeHtml(character.role)}</span>
                </span>
                <span class="character-desc">${escapeHtml(character.description)}</span>
                <span class="character-passive">
                  <span>被动能力</span>
                  <strong>${escapeHtml(character.passive)}</strong>
                  <em>${escapeHtml(character.ability)}</em>
                </span>
                <span class="character-cta">选择 ${escapeHtml(character.name)} →</span>
              </span>
            </button>
          `).join("")}
        </div>
        <p class="select-foot">必须先上传论文才能进入现场。角色只改变调查方式，不改变论文证据与最终评分。</p>
      </div>
    </div>
  `;
}

/* ---------- first-person story screen ---------- */

function storyTrackHtml(currentIndex) {
  return storyActs().map((act, index) => {
    const solved = storyActSolved(act);
    const current = index === currentIndex;
    return `
      ${index ? `<span class="story-track-line ${index <= currentIndex || solved ? "lit" : ""}"></span>` : ""}
      <span class="story-track-node ${solved ? "done" : ""} ${current ? "current" : ""}">
        <b>${solved ? "✓" : index + 1}</b>
        <em>${escapeHtml(act.short)}</em>
      </span>
    `;
  }).join("");
}

function storyClueListHtml(act) {
  return act.hotspots.map((clue, index) => {
    if (!storyClueFound(clue.id)) {
      return `
        <div class="clue-item locked">
          <span class="clue-id">0${index + 1}</span>
          <div><strong>未发现的线索</strong><small>在现场寻找微光</small></div>
          <span class="clue-state">?</span>
        </div>
      `;
    }
    return `
      <button class="clue-item found" data-action="story-clue" data-id="${escapeHtml(clue.id)}">
        <span class="clue-id">0${index + 1}</span>
        <div><strong>${escapeHtml(clue.title)}</strong><small>${escapeHtml(storyShort(clue.text, 52))}</small></div>
        <span class="clue-state">查看</span>
      </button>
    `;
  }).join("");
}

function storyDeductionHtml(act) {
  const acts = storyActs();
  const found = storyFoundCount(act);
  const total = act.hotspots.length;
  const solved = storyActSolved(act);
  const answers = state.story?.answers?.[act.id] || {};
  const wrong = Array.isArray(answers.wrong) ? answers.wrong : [];

  if (found < total) {
    return `
      <section class="story-panel deduction-panel locked">
        <div class="story-panel-head"><span>推理锁</span><small>${found}/${total}</small></div>
        <div class="deduction-locked">
          <span class="lock-glyph">⌗</span>
          <p>还差 ${total - found} 处线索。找齐之后，现场会给出一个必须回答的问题。</p>
        </div>
        <div class="story-meter"><span style="width:${Math.round((found / total) * 100)}%"></span></div>
      </section>
    `;
  }

  if (solved) {
    const last = (Number(state.story?.sceneIndex) || 0) >= acts.length - 1;
    return `
      <section class="story-panel deduction-panel solved">
        <div class="story-panel-head"><span>推理锁</span><small>已解开</small></div>
        <div class="deduction-stamp">推理成立</div>
        <p class="deduction-note">${escapeHtml(act.deduction.note)}</p>
        <button class="btn btn-accent deduction-next" data-action="next-story-act">${last ? "进入结案审讯 →" : "进入下一幕 →"}</button>
      </section>
    `;
  }

  return `
    <section class="story-panel deduction-panel ready">
      <div class="story-panel-head"><span>推理锁</span><small>已就绪</small></div>
      <p class="deduction-prompt">${escapeHtml(act.deduction.prompt)}</p>
      <div class="deduction-options">
        ${act.deduction.options.map((option, index) => `
          <button class="deduction-option ${wrong.includes(index) ? "wrong" : ""}" data-action="story-deduct" data-index="${index}" ${wrong.includes(index) ? "disabled" : ""}>
            <span>${LETTERS[index] || index + 1}</span>
            <em>${escapeHtml(option)}</em>
          </button>
        `).join("")}
      </div>
      ${wrong.length ? `<p class="deduction-hint">${escapeHtml(act.deduction.hint)}</p>` : ""}
    </section>
  `;
}

function storyHtml() {
  const acts = storyActs();
  if (!acts.length) return caseHtml();
  const index = Math.max(0, Math.min(acts.length - 1, Number(state.story?.sceneIndex) || 0));
  const act = acts[index];
  const character = activeCharacter();
  if (!character) return selectHtml();
  const found = storyFoundCount(act);
  const allFound = found >= act.hotspots.length;
  const solved = storyActSolved(act);

  return `
    <div class="story-screen">
      <div class="story-main">
        <div class="story-stage">
          <div class="story-bg" style="background-image:url('${escapeHtml(act.scene)}')"></div>
          <div class="story-shade"></div>
          <div class="story-rain" aria-hidden="true"></div>

          <div class="story-top">
            <button class="story-link" data-action="back-to-case">← 案件档案</button>
            <div class="story-title-chip">
              <span>${escapeHtml(act.roman)} · ${escapeHtml(act.time)}</span>
              <strong>${escapeHtml(act.title)}</strong>
              <em>${escapeHtml(act.en)}</em>
            </div>
            <div class="story-top-actions">
              <span class="story-counter">线索 ${found}/${act.hotspots.length}</span>
              <button class="story-link" data-action="open-source" data-scope="paper">论文原文</button>
            </div>
          </div>

          <div class="story-hotspots">
            ${act.hotspots.map((clue) => `
              <button class="story-hotspot ${storyClueFound(clue.id) ? "found" : ""} ${clue.x > 62 ? "flip" : ""}" style="left:${clue.x}%;top:${clue.y}%" data-action="story-hotspot" data-id="${escapeHtml(clue.id)}" aria-label="${escapeHtml(clue.label)}">
                <span class="hotspot-ring"></span>
                <span class="hotspot-core"></span>
                <span class="hotspot-tag">${escapeHtml(storyClueFound(clue.id) ? "已记录 · " + clue.title : clue.label)}</span>
              </button>
            `).join("")}
          </div>

          <div class="story-bottom">
            <div class="story-objective">
              <span>当前目标</span>
              <p>${escapeHtml(act.objective)}</p>
            </div>
            <div class="story-dialogue">
              <div class="story-speaker">${escapeHtml(character.name)}<span> / 第一人称</span></div>
              ${act.intro.map((line, lineIndex) => `<p class="${lineIndex === 0 ? "lead" : ""}">${escapeHtml(line)}</p>`).join("")}
              <p class="story-inner-line">${escapeHtml(character.line)}</p>
            </div>
          </div>
        </div>

        <div class="story-underbar">
          <div class="story-track">${storyTrackHtml(index)}</div>
          <span class="story-underbar-note">${solved ? "本幕推理已成立" : allFound ? "线索已齐，推理锁已就绪" : "点击现场的微光收集线索"}</span>
        </div>
      </div>

      <aside class="story-side">
        <div class="story-character-panel">
          <span class="story-avatar" style="background-image:url('${escapeHtml(character.portrait)}')"></span>
          <div class="story-character-copy">
            <strong>${escapeHtml(character.name)}</strong>
            <span>${escapeHtml(character.role)} · ${escapeHtml(character.passive)}</span>
            <small>${escapeHtml(character.passiveShort)}</small>
          </div>
        </div>

        <section class="story-panel clue-panel">
          <div class="story-panel-head"><span>线索本</span><small>${found}/${act.hotspots.length}</small></div>
          <div class="clue-list">${storyClueListHtml(act)}</div>
          <div class="story-meter"><span style="width:${Math.round((found / act.hotspots.length) * 100)}%"></span></div>
        </section>

        ${storyDeductionHtml(act)}

        <button class="story-source-btn" data-action="open-source" data-scope="paper">
          <span>原文档案</span>
          <strong>随时回看论文原文 →</strong>
        </button>
      </aside>
    </div>
  `;
}

/* ---------- story interactions ---------- */

function chooseCharacter(id) {
  const character = CHARACTERS.find((item) => item.id === id);
  if (!character) return;
  if (!state.story?.character) {
    state.story = freshStory(character.id);
  } else {
    state.story.character = character.id;
  }
  state.storyClueId = null;
  state.screen = "story";
  state.lastRenderKey = "";
  scheduleProgressSave();
  render();
  showToast(`${character.name}接手案件。${character.passive}已生效。`);
}

function continueStory() {
  if (!state.caseData) {
    goHome();
    return;
  }
  if (!state.story?.character) {
    state.screen = "select";
    render();
    return;
  }
  const acts = storyActs();
  if (state.story.finished) {
    state.story.sceneIndex = Math.max(0, acts.length - 1);
  }
  state.story.sceneIndex = Math.max(0, Math.min(acts.length - 1, Number(state.story.sceneIndex) || 0));
  state.screen = "story";
  render();
}

function renderStoryClueModal() {
  const act = storyCurrentAct();
  if (!act || !state.storyClueId) return;
  const clue = act.hotspots.find((item) => item.id === state.storyClueId);
  if (!clue) return;
  const root = document.querySelector("#modal-root");
  if (!root) return;
  const clueIndex = act.hotspots.findIndex((item) => item.id === clue.id);
  root.innerHTML = `
    <div class="modal-backdrop open story-clue-backdrop">
      <section class="modal-card story-clue-card" role="dialog" aria-modal="true" aria-labelledby="story-clue-title">
        <div class="story-clue-kicker">CLUE 0${clueIndex + 1} · ${escapeHtml(act.title)}</div>
        <h2 id="story-clue-title">${escapeHtml(clue.title)}</h2>
        <p class="story-clue-text">${escapeHtml(clue.text)}</p>
        ${clue.quote ? `
          <blockquote class="story-clue-quote">
            <p>“${escapeHtml(clue.quote)}”</p>
            <cite>${escapeHtml(sectionLabel(clue.section || "正文"))}${clue.verified === true ? " · 原文可回链" : clue.verified === false ? " · 待核验" : ""}</cite>
          </blockquote>
        ` : ""}
        <div class="story-clue-actions">
          ${clue.quote ? `<button class="btn btn-ghost" data-action="open-story-quote" data-id="${escapeHtml(clue.id)}">在原文中定位</button>` : ""}
          <button class="btn btn-accent" data-action="close-modal">记入线索本</button>
        </div>
        <p class="story-clue-note">${clue.quote ? "引文会与提取文本做逐字核验；正式引用前仍建议回到 PDF 复核。" : "这条线索来自案件档案，不是原文引文。"}</p>
      </section>
    </div>
  `;
  state.modal = "story-clue";
  lockBody();
}

function openStoryHotspot(id) {
  const act = storyCurrentAct();
  if (!act) return;
  const clue = act.hotspots.find((item) => item.id === id);
  if (!clue) return;
  if (!state.story.clues.includes(id)) {
    state.story.clues.push(id);
    scheduleProgressSave();
  }
  state.storyClueId = id;
  render();
  renderStoryClueModal();
}

function openStoryClueSource(id) {
  const act = storyCurrentAct();
  const clue = act?.hotspots.find((item) => item.id === id);
  if (!clue?.quote) {
    showToast("这条线索没有可定位的原文引文。", "warn");
    return;
  }
  closeModal(false);
  renderReader({ quote: clue.quote, section: clue.section || "正文" });
}

function submitStoryDeduction(index) {
  const act = storyCurrentAct();
  if (!act || storyFoundCount(act) < act.hotspots.length || storyActSolved(act)) return;
  const answers = state.story.answers[act.id] || { solved: false, wrong: [] };
  if (!Array.isArray(answers.wrong)) answers.wrong = [];
  if (index === act.deduction.answer_index) {
    answers.solved = true;
    state.story.answers[act.id] = answers;
    if (!state.story.solved.includes(act.id)) state.story.solved.push(act.id);
    scheduleProgressSave();
    render();
    showToast("推理成立，结案笔记已写入。");
    return;
  }
  if (!answers.wrong.includes(index)) answers.wrong.push(index);
  state.story.answers[act.id] = answers;
  scheduleProgressSave();
  render();
  showToast("这条推理与线索对不上，再看一眼线索本。", "bad");
}

async function nextStoryAct() {
  const acts = storyActs();
  if (!acts.length || !state.story) return;
  const index = Math.max(0, Math.min(acts.length - 1, Number(state.story.sceneIndex) || 0));
  const act = acts[index];
  if (!act || !storyActSolved(act)) return;
  if (index >= acts.length - 1) {
    state.story.finished = true;
    state.story.finishedAt = Date.now();
    state.story.sceneIndex = index;
    scheduleProgressSave();
    await startGame();
    return;
  }
  state.story.sceneIndex = index + 1;
  state.storyClueId = null;
  state.screen = "story";
  state.lastRenderKey = "";
  scheduleProgressSave();
  render();
  window.scrollTo(0, 0);
}
