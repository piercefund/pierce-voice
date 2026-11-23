const form = document.querySelector("#careerExplorerForm");
const explorer = document.querySelector("#careerExplorer");
const queryInput = document.querySelector("#careerExplorerQuery");
const status = document.querySelector("#careerExplorerStatus");
const results = document.querySelector("#careerExplorerResults");
const profile = document.querySelector("#careerExplorerProfile");

if (explorer && ["/", "/index.html"].includes(window.location.pathname)) {
  explorer.hidden = false;
}

function setStatus(message, tone = "") {
  status.textContent = message;
  status.dataset.tone = tone;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[character]);
}

function list(items) {
  return items.length ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : "";
}

async function openOccupation(code) {
  setStatus("Loading career details…");
  profile.hidden = true;
  try {
    const response = await fetch(`/api/onet/occupations/${encodeURIComponent(code)}`);
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.reason || "request_failed");
    const career = data.occupation;
    const skills = career.skills.map((skill) =>
      `<li><strong>${escapeHtml(skill.name)}</strong>${skill.examples.length ? `: ${escapeHtml(skill.examples.join("; "))}` : ""}</li>`
    ).join("");
    const related = career.related.map((item) =>
      `<button type="button" data-code="${escapeHtml(item.code)}">${escapeHtml(item.title)}</button>`
    ).join("");
    profile.innerHTML = `
      <div class="career-profile-top">
        <div>
          <p class="event-eyebrow">${escapeHtml(career.code)}${career.brightOutlook ? " · BRIGHT OUTLOOK" : ""}</p>
          <h3>${escapeHtml(career.title)}</h3>
        </div>
        <a href="${escapeHtml(career.sourceUrl)}" target="_blank" rel="noopener noreferrer">Full O*NET profile</a>
      </div>
      <p class="career-description">${escapeHtml(career.description)}</p>
      ${career.alternateTitles.length ? `<p class="career-also-called"><strong>Also called:</strong> ${escapeHtml(career.alternateTitles.join(", "))}</p>` : ""}
      <div class="career-profile-grid">
        ${career.tasks.length ? `<section><h4>What you may do</h4>${list(career.tasks)}</section>` : ""}
        ${skills ? `<section><h4>Useful skills</h4><ul>${skills}</ul></section>` : ""}
        ${career.preparation ? `<section><h4>Preparation</h4><p><strong>${escapeHtml(career.preparation.title)}</strong></p><p>${escapeHtml(career.preparation.education)}</p><p>${escapeHtml(career.preparation.experience)}</p><p>${escapeHtml(career.preparation.training)}</p></section>` : ""}
        ${career.technology.length ? `<section><h4>Technology you may use</h4>${list(career.technology)}</section>` : ""}
      </div>
      ${related ? `<section class="career-related"><h4>Related careers</h4><div>${related}</div></section>` : ""}
    `;
    profile.hidden = false;
    profile.querySelectorAll("[data-code]").forEach((button) => {
      button.addEventListener("click", () => openOccupation(button.dataset.code));
    });
    setStatus("");
    profile.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch {
    setStatus("Career details are temporarily unavailable. Please try again.", "error");
  }
}

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = queryInput.value.trim();
  if (query.length < 2) return;
  setStatus("Searching O*NET careers…");
  results.hidden = true;
  profile.hidden = true;
  try {
    const response = await fetch(`/api/onet/search?q=${encodeURIComponent(query)}`);
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.reason || "request_failed");
    if (!data.occupations.length) {
      setStatus("No careers matched. Try a broader job title, skill, or interest.");
      return;
    }
    results.innerHTML = data.occupations.map((career) => `
      <button type="button" data-code="${escapeHtml(career.code)}">
        <span>${escapeHtml(career.title)}</span>
        <small>${escapeHtml(career.code)}${career.brightOutlook ? " · Bright Outlook" : ""}</small>
      </button>
    `).join("");
    results.hidden = false;
    results.querySelectorAll("[data-code]").forEach((button) => {
      button.addEventListener("click", () => openOccupation(button.dataset.code));
    });
    setStatus(`${data.total} matching career${data.total === 1 ? "" : "s"}. Showing the closest matches.`);
  } catch {
    setStatus("Career search is temporarily unavailable. Please try again.", "error");
  }
});
