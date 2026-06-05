/**
 * Graph Theory 2026 Scoreboard - Core Client Script
 */

const RAW_URL = "https://raw.githubusercontent.com/NQBH/advanced_STEM_beyond/main/teach/student/NQBH_student.tex";
const DEFAULT_TARGET_KEYWORDS = ["1892", "Combinatorics"];
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes cache

// Application State
let appState = {
  rawTex: "",
  sections: [], // { title, body }
  activeSectionTitle: "",
  grades: [],   // GradeRow[]
  searchQuery: "",
  expandedStudent: null,
  lastUpdated: null,
  refreshTimer: 60,
  countdownIntervalId: null,
  refreshIntervalId: null,
  loading: false
};

// --- LaTeX Parser Mechanics ---

function latexToPlain(s) {
  return s
    .replace(/\{\\tt\/\}/g, "/")
    .replace(/\\&/g, "&")
    .replace(/\\[a-zA-Z]+\s*/g, "")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanName(name) {
  return latexToPlain(name)
    .replace(/\s*[\[\{(][^\]\})]+[\]\})]\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseBalancedBrace(text, openBraceIndex) {
  let depth = 0;

  for (let i = openBraceIndex; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        return {
          content: text.slice(openBraceIndex + 1, i),
          endIndex: i + 1,
        };
      }
    }
  }
  throw new Error("Cannot parse LaTeX braces.");
}

function findSections(tex) {
  const sections = [];
  const marker = "\\section{";
  let pos = 0;

  while (true) {
    const start = tex.indexOf(marker, pos);
    if (start === -1) break;

    const titleOpen = start + "\\section".length;
    const parsedTitle = parseBalancedBrace(tex, titleOpen);

    const bodyStart = parsedTitle.endIndex;
    const nextStart = tex.indexOf(marker, bodyStart);
    const bodyEnd = nextStart === -1 ? tex.length : nextStart;

    sections.push({
      title: latexToPlain(parsedTitle.content),
      body: tex.slice(bodyStart, bodyEnd),
    });

    pos = bodyEnd;
  }

  return sections;
}

function fixMalformedNumbers(expr) {
  let out = expr;
  let prev;

  do {
    prev = out;
    out = out.replace(/(\d+\.\d+)\.(\d+\.\d+)/g, "$1 + $2");
  } while (out !== prev);

  return out;
}

function safeEvaluateExpression(rawExpr) {
  let expr = rawExpr
    .replace(/\u00a0/g, " ")
    .replace(/\$[^$]*\$/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^)]*[a-zA-Z\s'][^)]*\)/g, " ") // Remove comments that have letters
    .replace(/\\[a-zA-Z]+\s*/g, " ")
    .replace(/[{}]/g, " ");

  expr = fixMalformedNumbers(expr);

  // Remove periods not followed by a digit (punctuation periods at the end of LaTeX items)
  expr = expr.replace(/\.(?!\d)/g, " ");

  // Extract signed numbers directly (e.g. "0.5", "+1.2", "-2")
  const tokens = expr.match(/[-+]?\s*\d*\.?\d+/g);
  if (!tokens) return 0;

  let total = 0;
  for (const token of tokens) {
    const cleanToken = token.replace(/\s+/g, "");
    const val = parseFloat(cleanToken);
    if (Number.isFinite(val)) {
      total += val;
    }
  }

  return total;
}

function parseStudentsFromSection(section) {
  const students = [];

  // Match all enumerate blocks in section body
  const enumRegex = /\\begin\{enumerate\}([\s\S]*?)\\end\{enumerate\}/g;
  let enumMatch;

  while ((enumMatch = enumRegex.exec(section.body)) !== null) {
    const enumBody = enumMatch[1];
    const studentRegex = /\\item\s+\{\\sc\s+([\s\S]*?)\.\}/g;
    const studentMatches = [];
    let match;

    while ((match = studentRegex.exec(enumBody)) !== null) {
      studentMatches.push({
        name: cleanName(match[1]),
        index: match.index,
        matchLength: match[0].length
      });
    }

    for (let i = 0; i < studentMatches.length; i++) {
      const current = studentMatches[i];
      const nextIndex =
        i + 1 < studentMatches.length ? studentMatches[i + 1].index : enumBody.length;

      const afterName = enumBody.slice(current.index + current.matchLength, nextIndex).trim();

      const itemizeMatch = afterName.match(
        /\\begin\{itemize\}([\s\S]*?)\\end\{itemize\}/
      );

      if (!itemizeMatch) {
        // Inline format (directly written expression like "1 + 1 + 1 - 1.")
        const score = safeEvaluateExpression(afterName);
        students.push({
          name: current.name,
          section: section.title,
          score: score,
          parts: [
            {
              category: "Điểm tích lũy",
              expression: afterName,
              score: Number(score.toFixed(4)),
            }
          ]
        });
        continue;
      }

      const itemizeBody = itemizeMatch[1];
      const itemRegex = /\\item\s+([a-zA-Z\s]+):\s*([\s\S]*?)(?=\\item|\s*$)/g;
      let itemMatch;
      const parts = [];
      let totalScore = 0;

      while ((itemMatch = itemRegex.exec(itemizeBody)) !== null) {
        const category = itemMatch[1].trim();
        const rawExpr = itemMatch[2].trim();

        const lowercaseCategory = category.toLowerCase();
        const isScoring =
          lowercaseCategory.includes("absence") ||
          lowercaseCategory.includes("early attendance") ||
          lowercaseCategory.includes("bonus") ||
          lowercaseCategory.includes("attendance");

        if (isScoring) {
          const score = safeEvaluateExpression(rawExpr);
          totalScore += score;
          parts.push({
            category,
            expression: rawExpr,
            score: Number(score.toFixed(4)),
          });
        } else {
          parts.push({
            category,
            expression: rawExpr,
            score: 0,
          });
        }
      }

      students.push({
        name: current.name,
        section: section.title,
        score: totalScore,
        parts,
      });
    }
  }

  return students;
}

function groupScores(rows) {
  const map = new Map();

  for (const row of rows) {
    const key = row.name.toLowerCase().trim();

    if (!map.has(key)) {
      map.set(key, {
        name: row.name,
        currentScore: 0,
        maxScore: 0,
        finalScore: 0,
        parts: [],
      });
    }

    const item = map.get(key);
    item.currentScore += row.score;
    item.parts.push(...row.parts);
  }

  const grouped = [...map.values()];
  const maxScore = Math.max(...grouped.map((x) => x.currentScore), 1);

  return grouped
    .map((x) => {
      // Vietnamese scale: final = 3 + 7 * (current / max)
      const calculatedFinal = 3 + 7 * (x.currentScore / maxScore);
      return {
        ...x,
        currentScore: Number(x.currentScore.toFixed(4)),
        maxScore: Number(maxScore.toFixed(4)),
        finalScore: Number(calculatedFinal.toFixed(4)),
      };
    })
    .sort((a, b) => b.currentScore - a.currentScore);
}

// --- UI Management ---

const elements = {
  selectSection: document.getElementById("select-section"),
  btnRefresh: document.getElementById("btn-refresh"),
  lblLastUpdated: document.getElementById("lbl-last-updated"),
  lblCacheTime: document.getElementById("lbl-cache-time"),
  statStudents: document.getElementById("stat-students"),
  statMaxScore: document.getElementById("stat-max-score"),
  statClassAverage: document.getElementById("stat-class-average"),
  statPassRate: document.getElementById("stat-pass-rate"),
  inputSearch: document.getElementById("input-search"),
  btnClearSearch: document.getElementById("btn-clear-search"),
  rosterInfo: document.getElementById("roster-info"),
  scoreboardBody: document.getElementById("scoreboard-body"),
  errorBanner: document.getElementById("error-banner"),
  errorText: document.getElementById("error-text"),
  syncText: document.getElementById("sync-text")
};

function showLoading() {
  appState.loading = true;
  elements.syncText.innerText = "Đang đồng bộ...";
  elements.btnRefresh.querySelector("svg").classList.add("animate-spin");
  elements.btnRefresh.disabled = true;
}

function hideLoading() {
  appState.loading = false;
  elements.btnRefresh.querySelector("svg").classList.remove("animate-spin");
  elements.btnRefresh.disabled = false;
}

function showError(msg) {
  elements.errorText.innerText = msg;
  elements.errorBanner.classList.remove("hidden");
}

function hideError() {
  elements.errorBanner.classList.add("hidden");
}

function formatDateTime(iso) {
  try {
    return new Intl.DateTimeFormat("vi-VN", {
      dateStyle: "medium",
      timeStyle: "medium",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

// Render selector options
function updateSelectorOptions() {
  elements.selectSection.innerHTML = "";
  appState.sections.forEach((sec) => {
    const opt = document.createElement("option");
    opt.value = sec.title;
    opt.innerText = sec.title;
    elements.selectSection.appendChild(opt);
  });

  if (appState.activeSectionTitle) {
    elements.selectSection.value = appState.activeSectionTitle;
  }
}

// Render core indicators card
function renderStats() {
  const total = appState.grades.length;
  if (total === 0) {
    elements.statStudents.innerText = "0";
    elements.statMaxScore.innerText = "0.00";
    elements.statClassAverage.innerText = "0.00";
    elements.statPassRate.innerText = "0.0%";
    return;
  }

  const max = appState.grades[0].currentScore;
  const avgGrade = appState.grades.reduce((acc, curr) => acc + curr.finalScore, 0) / total;
  const passRate = (appState.grades.filter((s) => s.finalScore >= 5.0).length / total) * 100;

  elements.statStudents.innerText = total.toString();
  elements.statMaxScore.innerText = max.toFixed(2);
  elements.statClassAverage.innerText = avgGrade.toFixed(2);
  elements.statPassRate.innerText = `${passRate.toFixed(1)}%`;
}

// Render dynamic table scoreboard
function renderScoreboard() {
  const body = elements.scoreboardBody;
  body.innerHTML = "";

  const query = appState.searchQuery
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const filtered = appState.grades.filter((s) =>
    s.name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .includes(query)
  );

  elements.rosterInfo.innerText = `Hiển thị ${filtered.length} trên ${appState.grades.length} sinh viên`;

  if (filtered.length === 0) {
    body.innerHTML = `
      <tr>
        <td colspan="6" class="placeholder-cell">
          <div style="color: #6b7280; padding: 20px 0;">Không tìm thấy sinh viên nào khớp với từ khóa tìm kiếm.</div>
        </td>
      </tr>
    `;
    return;
  }

  filtered.forEach((student) => {
    const originalIdx = appState.grades.findIndex((x) => x.name === student.name);
    const rank = originalIdx + 1;
    const isExpanded = appState.expandedStudent === student.name;

    // Medal style badge
    let medalHtml = `<span class="rank-badge">#${rank}</span>`;
    if (rank === 1) medalHtml = `<span class="medal medal-gold">🥇</span>`;
    else if (rank === 2) medalHtml = `<span class="medal medal-silver">🥈</span>`;
    else if (rank === 3) medalHtml = `<span class="medal medal-bronze">🥉</span>`;

    // Honored or failing tags
    let badgeHtml = "";
    if (student.finalScore >= 9.0) {
      badgeHtml = `<span class="label-badge badge-honors">Xuất Sắc</span>`;
    } else if (student.finalScore < 5.0) {
      badgeHtml = `<span class="label-badge badge-failing">Không Đạt</span>`;
    }

    // Normalized progress bar fill percentage
    const fillPercent = Math.min(((student.finalScore - 3) / 7) * 100, 100);

    // Calculate points needed to pass (final >= 5.0 => currentScore >= 2/7 * maxScore)
    const neededScore = Math.max(0, (2 / 7) * student.maxScore - student.currentScore);
    const neededHtml = student.finalScore >= 5.0
      ? `<span class="text-emerald" style="color: var(--emerald); font-weight: 600;">✓ Đạt</span>`
      : `<span class="text-amber" style="color: var(--amber); font-weight: 700; font-family: var(--font-mono);">+${neededScore.toFixed(2)}</span>`;

    // Main student row
    const tr = document.createElement("tr");
    tr.className = `row-student ${isExpanded ? "active" : ""}`;
    tr.innerHTML = `
      <td class="col-rank">${medalHtml}</td>
      <td class="col-name">
        <div class="student-name-box">
          <span>${student.name}</span>
          ${badgeHtml}
        </div>
      </td>
      <td class="col-raw">${student.currentScore.toFixed(2)} <span class="raw-gray">/ ${student.maxScore.toFixed(2)}</span></td>
      <td class="col-final">${student.finalScore.toFixed(2)}</td>
      <td class="col-needed">${neededHtml}</td>
      <td class="col-progress">
        <div class="progress-bar-container">
          <div class="progress-bar-fill" style="width: ${fillPercent}%"></div>
        </div>
      </td>
    `;

    tr.addEventListener("click", () => {
      toggleStudentExpand(student.name);
    });

    body.appendChild(tr);

    // Detail Expanded Row
    if (isExpanded) {
      const detailTr = document.createElement("tr");
      detailTr.className = "row-detail";
      
      // Breakdown logs
      let breakdownHtml = "";
      if (student.parts.length === 0) {
        breakdownHtml = `<div class="breakdown-item"><span class="breakdown-expr" style="color: #6b7280;">Không tìm thấy lịch sử cộng điểm.</span></div>`;
      } else {
        student.parts.forEach((part) => {
          const isAbsence = part.category.toLowerCase().includes("absence");
          const isBonus = part.category.toLowerCase().includes("bonus");
          const isAttendance = part.category.toLowerCase().includes("attendance") || part.category.toLowerCase().includes("early");

          let valClass = "text-gray-300";
          if (isAbsence && part.score < 0) valClass = "val-absence";
          else if (isBonus && part.score > 0) valClass = "val-bonus";
          else if (isAttendance && part.score > 0) valClass = "val-attendance";

          const prefix = part.score > 0 ? "+" : "";

          breakdownHtml += `
            <div class="breakdown-item">
              <div class="breakdown-meta">
                <span class="breakdown-cat">${part.category}</span>
                <span class="breakdown-expr">${part.expression || "Không có mô tả"}</span>
              </div>
              <span class="breakdown-val ${valClass}">${prefix}${part.score}</span>
            </div>
          `;
        });
      }

      detailTr.innerHTML = `
        <td colspan="6">
          <div class="detail-container">
            <div class="detail-header">
              <h4>Nhật ký tính điểm chi tiết</h4>
              <span>Thông tin thô được giải mã từ cấu trúc itemize của LaTeX</span>
            </div>
            
            <div class="detail-body">
              <div class="breakdown-list">
                ${breakdownHtml}
              </div>
              
              <div class="detail-summary-card">
                <span class="summary-title">Đánh giá trọng số tổng hợp</span>
                <div class="summary-rows">
                  <div class="summary-row">
                    <span>Điểm tích lũy thô</span>
                    <span class="text-white">${student.currentScore} / ${student.maxScore}</span>
                  </div>
                  <div class="summary-row">
                    <span>Tỷ lệ hoàn thành</span>
                    <span class="text-white">${((student.currentScore / student.maxScore) * 100).toFixed(2)}%</span>
                  </div>
                  <div class="summary-row total-row">
                    <span>Điểm học phần tổng kết</span>
                    <span>${student.finalScore.toFixed(4)}</span>
                  </div>
                </div>
                
                <div class="summary-progress-box">
                  <div class="progress-header">
                    <span>Độ đầy quy chuẩn (3.0 - 10.0)</span>
                    <span>${fillPercent.toFixed(0)}%</span>
                  </div>
                  <div class="summary-bar">
                    <div class="summary-bar-fill" style="width: ${fillPercent}%"></div>
                  </div>
                  <p class="progress-footer-text">Quy chế đạt chuẩn học phần đại học yêu cầu điểm số từ 4.0 (D) hoặc 5.0 (C) trở lên.</p>
                </div>
              </div>
            </div>
          </div>
        </td>
      `;
      body.appendChild(detailTr);
    }
  });
}

function toggleStudentExpand(name) {
  appState.expandedStudent = appState.expandedStudent === name ? null : name;
  renderScoreboard();
}

// Process data calculation on active section change
function handleActiveSectionChange(sectionTitle) {
  const sec = appState.sections.find((s) => s.title === sectionTitle);
  if (!sec) return;

  appState.activeSectionTitle = sectionTitle;
  appState.expandedStudent = null;

  const rows = parseStudentsFromSection(sec);
  appState.grades = groupScores(rows);

  renderStats();
  renderScoreboard();
  
  // Save active section setting in localStorage
  localStorage.setItem("active_section_preference", sectionTitle);
}

// Load LaTeX data (supports LocalStorage cache)
async function loadData(forceReload = false) {
  showLoading();
  hideError();

  const cachedTex = localStorage.getItem("latex_content");
  const cachedTime = localStorage.getItem("latex_cache_timestamp");
  const now = Date.now();

  const isCacheValid = cachedTex && cachedTime && (now - parseInt(cachedTime, 10) < CACHE_TTL_MS);

  try {
    let tex = "";
    let updatedTimeStr = "";

    if (isCacheValid && !forceReload) {
      tex = cachedTex;
      updatedTimeStr = localStorage.getItem("latex_cache_updated_time") || new Date().toISOString();
      elements.lblCacheTime.innerText = "15 phút (Đã lưu cache)";
    } else {
      // Fetch fresh raw from GitHub
      const res = await fetch(RAW_URL, { cache: "no-store" });
      if (!res.ok) {
        throw new Error(`Không thể kết nối đến GitHub Raw: HTTP ${res.status}`);
      }
      tex = await res.text();
      updatedTimeStr = new Date().toISOString();

      // Update storage
      localStorage.setItem("latex_content", tex);
      localStorage.setItem("latex_cache_timestamp", now.toString());
      localStorage.setItem("latex_cache_updated_time", updatedTimeStr);
      
      elements.lblCacheTime.innerText = "15 phút (Mới đồng bộ)";
    }

    appState.rawTex = tex;
    appState.lastUpdated = updatedTimeStr;
    elements.lblLastUpdated.innerText = formatDateTime(updatedTimeStr);

    // Extract sections
    appState.sections = findSections(tex);
    if (appState.sections.length === 0) {
      throw new Error("Không tìm thấy đề mục \\section{} nào hợp lệ trong tệp LaTeX.");
    }

    // Add virtual section for Graph 2026 grouping
    const graphMatches = appState.sections.filter(sec => 
      DEFAULT_TARGET_KEYWORDS.every(kw => sec.title.toLowerCase().includes(kw.toLowerCase()))
    );
    if (graphMatches.length > 0) {
      const virtualBody = graphMatches.map(sec => sec.body).join("\n");
      const virtualSection = {
        title: "Tổng hợp Graph 2026 (Lý thuyết + LAB)",
        body: virtualBody
      };
      // Insert at the beginning of the list
      appState.sections.unshift(virtualSection);
    }

    updateSelectorOptions();

    // Determine initial active section
    let activeSec = appState.sections[0].title;
    
    // 1. Check user storage preference
    const storedPref = localStorage.getItem("active_section_preference");
    if (storedPref && appState.sections.some((s) => s.title === storedPref)) {
      activeSec = storedPref;
    } else {
      // 2. Try default Graph keywords
      const matches = appState.sections.filter((section) =>
        DEFAULT_TARGET_KEYWORDS.every((keyword) => section.title.toLowerCase().includes(keyword.toLowerCase()))
      );
      if (matches.length > 0) {
        activeSec = matches[0].title;
      }
    }

    handleActiveSectionChange(activeSec);

  } catch (err) {
    console.error(err);
    showError(err.message || String(err));
  } finally {
    hideLoading();
  }
}

// --- Controller Timers & Listeners ---

function startCountdown() {
  if (appState.countdownIntervalId) clearInterval(appState.countdownIntervalId);

  appState.refreshTimer = 60;
  elements.syncText.innerText = `Làm mới sau ${appState.refreshTimer}s`;

  appState.countdownIntervalId = setInterval(() => {
    if (appState.loading) return;

    appState.refreshTimer -= 1;
    if (appState.refreshTimer <= 0) {
      appState.refreshTimer = 60;
      // Triggers auto re-check data (loadData handles TTL cache validation automatically)
      loadData(false);
    }
    elements.syncText.innerText = `Làm mới sau ${appState.refreshTimer}s`;
  }, 1000);
}

// Initialize listeners
function initListeners() {
  // Section select change
  elements.selectSection.addEventListener("change", (e) => {
    handleActiveSectionChange(e.target.value);
  });

  // Manual refresh
  elements.btnRefresh.addEventListener("click", () => {
    loadData(true).then(() => {
      startCountdown();
    });
  });

  // Search input
  elements.inputSearch.addEventListener("input", (e) => {
    appState.searchQuery = e.target.value;
    if (appState.searchQuery.trim() !== "") {
      elements.btnClearSearch.classList.remove("hidden");
    } else {
      elements.btnClearSearch.classList.add("hidden");
    }
    renderScoreboard();
  });

  // Clear search
  elements.btnClearSearch.addEventListener("click", () => {
    elements.inputSearch.value = "";
    appState.searchQuery = "";
    elements.btnClearSearch.classList.add("hidden");
    renderScoreboard();
  });
}

// App Bootloader
window.addEventListener("DOMContentLoaded", () => {
  initListeners();
  loadData(false).then(() => {
    startCountdown();
  });
});
