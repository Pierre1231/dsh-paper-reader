/**
 * Builds the notes summarization prompt.
 *
 * The plugin inserts this prompt into the conversation draft. The AI —
 * which has the full discussion context (the user's questions AND its
 * own answers) — then produces a Markdown notes document AND saves it
 * with its own file tools into a workspace-root folder named after the
 * paper title. This replaces plugin-side answer capture entirely.
 *
 * Requirements encoded here come from the user's decisions:
 * - organize by paper chapters, not conversation timeline
 * - per item: 疑问 + 解答 + 重要性
 * - answers keep the derivation, the numbers and the limits of validity,
 *   not just the conclusion
 * - keep corrected understandings, drop the wrong guesses themselves
 * - keep "是不是这样理解" confirmations and "为什么" follow-ups
 * - ignore tool actions (translate/copy) and chit-chat
 * - open with a short paper overview for quick recall
 * - embed the paper's key figures/tables: crop them next to the notes under
 *   `figures/`, reference them with relative paths, add a figure index
 * - save to {workspace root}/{paper title}/论文笔记.md
 */

const DEFAULT_FOLDER = '论文阅读笔记';
const MAX_FOLDER_LENGTH = 60;

/**
 * Derives a clean, readable workspace folder name from a paper file name.
 * Rules: strip .pdf, replace illegal filesystem chars with '-', collapse
 * whitespace, cap at 60 chars on a word/dash boundary, never end with a
 * space, dot or dash. Empty input falls back to a default name.
 *
 * @param {string} [fileName]
 * @returns {string}
 */
export function buildNotesFolderName(fileName) {
  let name = String(fileName || '');
  name = name.replace(/\.pdf$/i, '');
  name = name.replace(/[/\\?%*:|"<>…]+/g, '-');
  name = name.replace(/\s+/g, ' ').trim();
  name = name.replace(/\s+-\s*|\s*-\s+/g, ' - '); // spaced dashes normalize to " - "; "whole-body" untouched
  if (name.length > MAX_FOLDER_LENGTH) {
    name = name.slice(0, MAX_FOLDER_LENGTH);
    const boundary = Math.max(name.lastIndexOf(' - '), name.lastIndexOf(' '));
    if (boundary > MAX_FOLDER_LENGTH / 2) name = name.slice(0, boundary);
  }
  name = name.replace(/[\s.\-]+$/g, '');
  return name || DEFAULT_FOLDER;
}

/**
 * @param {string} [fileName] - The paper file name; omit for a generic prompt
 * @returns {string} The prompt text
 */
export function buildNotesPrompt(fileName) {
  const hasName = typeof fileName === 'string' && fileName.trim().length > 0;
  const subject = hasName ? `论文《${fileName}》` : '我们讨论的这篇论文';
  const saveInstruction = hasName
    ? `- 在工作区根目录下新建文件夹「${buildNotesFolderName(fileName)}」，将笔记保存为该文件夹下的「论文笔记.md」`
    : `- 在工作区根目录下，根据论文标题新建文件夹（命名规范：去掉扩展名、非法字符替换为 -、合并多余空格、最长 60 字符、不以空格/点/短横结尾），将笔记保存为该文件夹下的「论文笔记.md」`;
  return `请回顾我们关于${subject}的整个对话，帮我整理一份阅读笔记。

## 笔记格式

Markdown 格式（.md 文件）。

## 整体结构

1. 开头用 3–5 句话概述这篇论文：研究什么问题、用了什么方法、得到什么结论。方便我以后快速回忆起这篇论文讲什么。
2. 之后按论文的章节结构组织（如 Introduction、Related Work、Methodology、Experiments、Conclusion），不要按对话的时间顺序排列。

## 每个章节下，整理我在阅读中暴露出的疑问点，每条包含：

- **疑问**：我当时的问题或困惑（保留我自己的问法）
- **解答**：经过讨论后确认下来的正确理解；把推导过程、具体数字和适用边界一并留下，不要只写结论
- **重要性**：一句话说明为什么值得记住——它支撑了论文的哪个关键逻辑

## 特别保留这些材料（它们是我理解这篇论文的真实轨迹，非常宝贵）：

- 我理解错、后来被纠正的地方：只写纠正后的正确理解，不要展开我当时的错误猜测
- 我向你确认"是不是这样理解"的点，以及最终确认下来的理解
- 我追问"为什么"的地方——那里往往是我知识结构的盲区

## 请忽略：

- 翻译、复制等工具性请求，这些不是学习内容
- 与论文无关的闲聊

## 配图

原文里与正文讨论对应的关键图、表要真的放进笔记，不要只写一句"见 Figure 3"。

- 从论文 PDF 里裁出该图/表（连原文图注一起），存到笔记**同目录**的 \`figures/\` 下；文件名用 \`fig01_xxx.png\`、\`tab01_xxx.png\` 的形式，不要用哈希名。
- 在讨论它的那一节用**相对路径**插入：\`![一句话说明](figures/fig03_main_results.png)\`；图下紧跟一行斜体，写清"这张图该看什么"，不要只贴图不说话。相对路径可保证整个文件夹能被整体移动或归档。
- 优先收这几类：方法/训练流程总览、主结果曲线、关键消融、真机或仿真截图、方法对比表。装饰性的 teaser 可选，纯排版元素不收。
- 笔记开头加一个「图目录」表：文件名 → 原文编号（Figure 3 / Table 1）→ 用在哪一节 → 一句话内容。
- 用足够清晰的分辨率渲染（约 200 dpi）再裁切，保证图里的字读得清；一张图只表达一个要点时可拆成多张。
- 环境里若没有可用的 PDF 渲染/裁图工具，就退化为在正文里写明「原文 Figure 3」并描述它画了什么；**不要编造图片、不要用网络图片代替原文图**。

## 保存方式

请使用你的文件工具直接保存（不要只输出在对话里）：
${saveInstruction}
- 保存成功后，在对话里简要回复：文件完整路径 + 各章节收录的要点数量，不要把整篇笔记重复贴在对话里。`;
}
