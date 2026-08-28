const refreshButton = document.querySelector("#refreshButton");
const organizerTitle = document.querySelector("#organizerTitle");
const organizerDetails = document.querySelector("#organizerDetails");
const organizerStatus = document.querySelector("#organizerStatus");
const summaryList = document.querySelector("#summaryList");
const pathMatch = window.location.pathname.match(/^\/events\/([^/]+)\/organizer\/?$/);
const eventSlug = pathMatch ? decodeURIComponent(pathMatch[1]) : "city-highlights-careers";

function labeledValue(label, value) {
  const wrapper = document.createElement("div");
  wrapper.className = "summary-field";
  const heading = document.createElement("h3");
  heading.textContent = label;
  const content = document.createElement("p");
  content.textContent = value || "Not provided";
  wrapper.append(heading, content);
  return wrapper;
}

function createSummaryCard(summary) {
  const article = document.createElement("article");
  article.className = "summary-card";

  const top = document.createElement("div");
  top.className = "summary-card-top";
  const identity = document.createElement("div");
  const name = document.createElement("h2");
  name.textContent = summary.participant.name;
  const email = document.createElement("p");
  email.textContent = summary.participant.email;
  identity.append(name, email);

  const badge = document.createElement("span");
  badge.className = summary.review ? "review-badge approved" : "review-badge";
  badge.textContent = summary.review ? "Approved" : "Needs review";
  top.append(identity, badge);

  const guidance = (summary.key_guidance || []).map((item, index) => `${index + 1}. ${item}`).join("\n");
  const grid = document.createElement("div");
  grid.className = "summary-grid";
  grid.append(
    labeledValue("Guidance", guidance),
    labeledValue("Mentor connection", summary.mentor_connection),
    labeledValue("Event", summary.recommended_event),
    labeledValue("Resource", summary.recommended_resource),
    labeledValue(
      "Confirmed next step",
      `${summary.next_step.action} by ${summary.next_step.target_date} · ${summary.next_step.owner}`
    )
  );

  const actions = document.createElement("div");
  actions.className = "summary-actions";
  const consent = document.createElement("p");
  consent.textContent = summary.email_consent
    ? "Participant approved an email follow-up."
    : "Participant did not request an email follow-up.";
  const approveButton = document.createElement("button");
  approveButton.type = "button";
  approveButton.textContent = summary.email_consent ? "Approve & Send" : "Approve & Save";
  approveButton.disabled = Boolean(summary.review);
  approveButton.addEventListener("click", async () => {
    approveButton.disabled = true;
    approveButton.textContent = "Approving...";
    try {
      const response = await fetch("/event/review/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ summary_id: summary.summary_id, approved: true })
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.reason || "Approval failed");
      await loadSummaries();
    } catch {
      approveButton.disabled = false;
      approveButton.textContent = summary.email_consent ? "Approve & Send" : "Approve & Save";
      organizerStatus.textContent = "That recap could not be approved. Please try again.";
    }
  });
  actions.append(consent, approveButton);
  article.append(top, grid, actions);
  return article;
}

async function loadSummaries() {
  refreshButton.disabled = true;
  organizerStatus.textContent = "Loading summaries...";
  try {
    const response = await fetch(`/event/review?slug=${encodeURIComponent(eventSlug)}`);
    const result = await response.json();
    if (response.status === 403) {
      organizerStatus.textContent = "Open this organizer page on the Pierce computer using localhost.";
      summaryList.replaceChildren();
      return;
    }
    if (!response.ok || !result.ok) throw new Error(result.reason || "Unable to load summaries");
    organizerTitle.textContent = result.event.name;
    organizerDetails.textContent = `${result.event.date_label} · Review participant follow-ups before delivery.`;
    summaryList.replaceChildren(...result.summaries.map(createSummaryCard));
    const pending = result.summaries.filter((summary) => !summary.review).length;
    organizerStatus.textContent = result.summaries.length
      ? `${pending} ${pending === 1 ? "summary needs" : "summaries need"} review.`
      : "No participant recaps have been submitted yet.";
  } catch {
    organizerStatus.textContent = "Participant summaries could not be loaded. Please try again.";
  } finally {
    refreshButton.disabled = false;
  }
}

refreshButton.addEventListener("click", loadSummaries);
loadSummaries();
