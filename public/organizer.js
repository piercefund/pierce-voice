const refreshButton = document.querySelector("#refreshButton");
const organizerTitle = document.querySelector("#organizerTitle");
const organizerDetails = document.querySelector("#organizerDetails");
const organizerStatus = document.querySelector("#organizerStatus");
const summaryList = document.querySelector("#summaryList");
const mentorBookingSummary = document.querySelector("#mentorBookingSummary");
const mentorBookingList = document.querySelector("#mentorBookingList");
const mentorRosterForm = document.querySelector("#mentorRosterForm");
const mentorRosterList = document.querySelector("#mentorRosterList");
const addMentorButton = document.querySelector("#addMentorButton");
const saveMentorRosterButton = document.querySelector("#saveMentorRosterButton");
const mentorRosterStatus = document.querySelector("#mentorRosterStatus");
const dataInventory = document.querySelector("#dataInventory");
const exportDataButton = document.querySelector("#exportDataButton");
const deleteParticipantForm = document.querySelector("#deleteParticipantForm");
const deleteParticipantEmail = document.querySelector("#deleteParticipantEmail");
const deleteParticipantButton = document.querySelector("#deleteParticipantButton");
const dataManagementStatus = document.querySelector("#dataManagementStatus");
const hubspotPreviewButton = document.querySelector("#hubspotPreviewButton");
const hubspotPreviewSummary = document.querySelector("#hubspotPreviewSummary");
const hubspotPreviewList = document.querySelector("#hubspotPreviewList");
const hubspotBackfillActions = document.querySelector("#hubspotBackfillActions");
const hubspotBackfillButton = document.querySelector("#hubspotBackfillButton");
const hubspotBackfillStatus = document.querySelector("#hubspotBackfillStatus");
let armedBackfillSelection = "";
let mentorRoster = [];
let organizerAvailability = [];
const expertiseCategories = [
  "Product", "Engineering", "Design", "Marketing", "Fundraising", "Operations", "Growth", "Legal",
  "Other", "Artificial Intelligence", "Machine Learning", "Product Development", "Data Science", "FinTech",
  "Analytics", "Sustainability", "Environmental Policy", "Nonprofits", "Healthcare Technology",
  "Software Engineering", "Leadership", "EdTech", "Entrepreneurship", "Digital Learning", "Blockchain",
  "Cryptography", "Startups", "Media", "Content Creation", "Digital Marketing", "Cybersecurity",
  "Risk Management", "IT Governance", "Clinical Research", "Healthcare", "Biotech", "Urban Planning",
  "Architecture", "Smart Cities", "Retail", "E-commerce", "Agriculture", "AgriTech", "UX/UI",
  "Creative Direction", "Law", "Compliance", "Corporate Governance", "Social Impact", "Technology for Good"
];
const pathMatch = window.location.pathname.match(/^\/events\/([^/]+)\/organizer\/?$/);
const eventSlug = pathMatch ? decodeURIComponent(pathMatch[1]) : "san-diego-startup-week-mentoring";

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

function formatMentorTime(time) {
  const [hourText, minute] = String(time || "").split(":");
  const hour = Number(hourText);
  return `${hour % 12 || 12}:${minute} ${hour < 12 ? "AM" : "PM"}`;
}

function formatCheckInTime(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "Time unavailable";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function createMentorBookingCard(booking) {
  const article = document.createElement("article");
  article.className = "mentor-booking-card";
  const heading = document.createElement("div");
  heading.className = "mentor-booking-card-heading";
  const title = document.createElement("h3");
  title.textContent = `${formatMentorTime(booking.start_time)} · ${booking.location}`;
  const badge = document.createElement("span");
  badge.className = `booking-status ${booking.status}`;
  badge.textContent = booking.status.replaceAll("_", " ");
  heading.append(title, badge);
  const participant = document.createElement("p");
  participant.textContent = `Participant: ${booking.participant.name} · ${booking.participant.email}`;
  const mentor = document.createElement("p");
  mentor.textContent = `Mentor: ${booking.mentor_name}`;
  const challenge = document.createElement("p");
  challenge.textContent = `Biggest Challenge: ${booking.biggest_challenge || "Not provided"}`;
  const expertise = document.createElement("p");
  const expertiseText = Array.isArray(booking.mentor_expertise)
    ? booking.mentor_expertise.join(", ")
    : booking.mentor_expertise;
  expertise.textContent = `Expertise: ${expertiseText || "Not provided"}`;
  article.append(heading, participant, challenge, mentor, expertise);
  if (booking.checked_in_at) {
    const checkedIn = document.createElement("p");
    checkedIn.className = "booking-checked-in";
    checkedIn.textContent = `Participant Checked In: ${formatCheckInTime(booking.checked_in_at)}`;
    article.append(checkedIn);
  }
  if (["confirmed", "calendar_pending"].includes(booking.status)) {
    const actions = document.createElement("div");
    actions.className = "organizer-booking-actions";
    const slot = document.createElement("select");
    slot.setAttribute("aria-label", `New appointment for ${booking.participant.name}`);
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Choose a new table and time";
    slot.append(placeholder);
    for (const optionData of organizerAvailability.filter((option) => option.available)) {
      const option = document.createElement("option");
      option.value = `${optionData.mentor_id}|${optionData.start_time}`;
      option.textContent = `${formatMentorTime(optionData.start_time)} · ${optionData.location} · ${optionData.mentor_name}`;
      slot.append(option);
    }
    const reschedule = document.createElement("button");
    reschedule.type = "button";
    reschedule.className = "secondary-button";
    reschedule.textContent = "Reschedule";
    reschedule.addEventListener("click", () => organizerChangeBooking("reschedule", booking, slot, actions));
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "danger-button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => organizerChangeBooking("cancel", booking, slot, actions));
    actions.append(slot, reschedule, cancel);
    article.append(actions);
  }
  return article;
}

async function organizerChangeBooking(action, booking, slot, actions) {
  const [mentor_id, start_time] = slot.value.split("|");
  if (action === "reschedule" && (!mentor_id || !start_time)) {
    mentorBookingSummary.textContent = "Choose a new table and time first.";
    return;
  }
  if (!window.confirm(`${action === "cancel" ? "Cancel" : "Reschedule"} ${booking.participant.name}'s appointment? Calendar guests will be notified.`)) return;
  for (const control of actions.querySelectorAll("button, select")) control.disabled = true;
  mentorBookingSummary.textContent = action === "cancel" ? "Cancelling appointment..." : "Rescheduling appointment...";
  try {
    const response = await fetch(`/event/mentoring/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event_slug: eventSlug,
        booking_id: booking.booking_id,
        participant_email: booking.participant.email,
        ...(action === "reschedule" ? { mentor_id, start_time } : {})
      })
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.reason || "change_failed");
    await loadMentorBookings();
  } catch {
    mentorBookingSummary.textContent = "The appointment could not be changed. Refresh and try again.";
    for (const control of actions.querySelectorAll("button, select")) control.disabled = false;
  }
}

function createMentorRosterRow(mentor = {}) {
  const row = document.createElement("div");
  row.className = "mentor-roster-row";
  const tableLabel = document.createElement("label");
  tableLabel.textContent = "Table";
  const tableInput = document.createElement("input");
  tableInput.type = "number";
  tableInput.min = "1";
  tableInput.max = "30";
  tableInput.required = true;
  tableInput.value = mentor.table || Math.max(0, ...mentorRoster.map((item) => Number(item.table) || 0)) + 1;
  tableInput.className = "mentor-table-input";
  tableLabel.append(tableInput);
  const nameLabel = document.createElement("label");
  nameLabel.textContent = "Mentor";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.required = true;
  nameInput.maxLength = 120;
  nameInput.value = mentor.name || "";
  nameInput.className = "mentor-name-input";
  nameLabel.append(nameInput);
  const expertisePicker = document.createElement("details");
  expertisePicker.className = "mentor-expertise-picker";
  const expertiseSummary = document.createElement("summary");
  const selectedExpertise = Array.isArray(mentor.expertise)
    ? mentor.expertise
    : String(mentor.expertise || "").split(/[;,]/).map((item) => item.trim()).filter(Boolean);
  const updateExpertiseSummary = () => {
    const selected = [...expertisePicker.querySelectorAll("input:checked")].map((input) => input.value);
    expertiseSummary.textContent = selected.length ? selected.join(", ") : "Select areas of expertise";
  };
  const expertiseOptions = document.createElement("div");
  expertiseOptions.className = "mentor-expertise-options";
  for (const category of expertiseCategories) {
    const option = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = category;
    checkbox.checked = selectedExpertise.includes(category);
    checkbox.addEventListener("change", updateExpertiseSummary);
    option.append(checkbox, document.createTextNode(category));
    expertiseOptions.append(option);
  }
  expertisePicker.append(expertiseSummary, expertiseOptions);
  updateExpertiseSummary();
  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "secondary-button mentor-remove-button";
  removeButton.textContent = "Remove";
  removeButton.addEventListener("click", () => row.remove());
  const expertiseField = document.createElement("div");
  expertiseField.className = "mentor-expertise-field";
  const expertiseHeading = document.createElement("span");
  expertiseHeading.textContent = "Expertise";
  expertiseField.append(expertiseHeading, expertisePicker);
  row.append(tableLabel, nameLabel, expertiseField, removeButton);
  return row;
}

function renderMentorRoster(mentors) {
  mentorRoster = mentors.map((mentor) => ({ ...mentor }));
  mentorRosterList.replaceChildren(...mentorRoster.map(createMentorRosterRow));
}

async function loadMentorBookings() {
  try {
    const [response, availabilityResponse] = await Promise.all([
      fetch(`/event/review/bookings?slug=${encodeURIComponent(eventSlug)}`),
      fetch(`/event/mentoring/availability?slug=${encodeURIComponent(eventSlug)}`)
    ]);
    const [result, availabilityResult] = await Promise.all([response.json(), availabilityResponse.json()]);
    if (!response.ok || !result.ok) throw new Error(result.reason || "Unable to load appointments");
    organizerAvailability = availabilityResponse.ok && availabilityResult.ok ? availabilityResult.slots : [];
    renderMentorRoster(result.roster);
    mentorBookingList.replaceChildren(...result.bookings.map(createMentorBookingCard));
    const confirmed = result.bookings.filter((booking) => booking.status === "confirmed").length;
    mentorBookingSummary.textContent = result.bookings.length
      ? `${confirmed} confirmed · ${result.bookings.length} total booking records`
      : "No mentor appointments have been booked yet.";
  } catch {
    mentorBookingSummary.textContent = eventSlug === "san-diego-startup-week-mentoring"
      ? "Appointments could not be loaded."
      : "Mentor scheduling is not enabled for this event.";
    mentorBookingList.replaceChildren();
  }
}

addMentorButton.addEventListener("click", () => {
  mentorRosterList.append(createMentorRosterRow());
  mentorRosterList.lastElementChild.querySelector(".mentor-name-input").focus();
});

mentorRosterForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const mentors = [...mentorRosterList.querySelectorAll(".mentor-roster-row")].map((row) => ({
    table: Number(row.querySelector(".mentor-table-input").value),
    name: row.querySelector(".mentor-name-input").value.trim(),
    expertise: [...row.querySelectorAll(".mentor-expertise-options input:checked")].map((input) => input.value)
  }));
  const counts = mentors.reduce((result, mentor) =>
    result.set(mentor.table, (result.get(mentor.table) || 0) + 1), new Map());
  if ([...counts.values()].some((count) => count > 4)) {
    mentorRosterStatus.textContent = "A table can have no more than four mentors.";
    return;
  }
  saveMentorRosterButton.disabled = true;
  mentorRosterStatus.textContent = "Saving assignments...";
  try {
    const response = await fetch("/event/review/mentors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mentors })
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.reason || "Unable to save assignments");
    renderMentorRoster(result.roster);
    mentorRosterStatus.textContent = "Table assignments saved. Public availability is updated.";
    await loadMentorBookings();
  } catch {
    mentorRosterStatus.textContent = "Assignments could not be saved. Check every name and table number.";
  } finally {
    saveMentorRosterButton.disabled = false;
  }
});

async function loadDataInventory() {
  exportDataButton.href = `/organizer/data/export?slug=${encodeURIComponent(eventSlug)}`;
  try {
    const response = await fetch(`/organizer/data/inventory?slug=${encodeURIComponent(eventSlug)}`);
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.reason || "Unable to load data inventory");
    dataInventory.textContent = `${result.total_records} stored ${result.total_records === 1 ? "record" : "records"} for this event`;
  } catch {
    dataInventory.textContent = "Stored event data could not be counted.";
  }
}

deleteParticipantForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = deleteParticipantEmail.value.trim();
  if (!email) return;
  if (!window.confirm(`Permanently delete Pierce records for ${email} from this event?`)) return;
  deleteParticipantButton.disabled = true;
  dataManagementStatus.textContent = "Deleting participant data...";
  try {
    const response = await fetch("/organizer/data/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event_slug: eventSlug, participant_email: email, confirmation: "DELETE" })
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.reason || "Deletion failed");
    dataManagementStatus.textContent = result.total_removed
      ? `${result.total_removed} ${result.total_removed === 1 ? "record was" : "records were"} permanently deleted.`
      : "No matching records were found for that email and event.";
    deleteParticipantForm.reset();
    await Promise.all([loadDataInventory(), loadSummaries()]);
  } catch {
    dataManagementStatus.textContent = "Participant data could not be deleted. Please try again.";
  } finally {
    deleteParticipantButton.disabled = false;
  }
});

function createHubspotPreviewRow(person) {
  const article = document.createElement("article");
  article.className = "hubspot-preview-row";
  const identity = document.createElement("div");
  const selector = document.createElement("input");
  selector.type = "checkbox";
  selector.className = "hubspot-contact-selector";
  selector.value = person.email;
  selector.disabled = person.ready_records === 0;
  selector.setAttribute("aria-label", `Select ${person.name || person.email} for HubSpot backfill`);
  const name = document.createElement("strong");
  name.textContent = person.name || "Name not provided";
  const email = document.createElement("span");
  email.textContent = person.email;
  identity.append(selector, name, email);
  const status = document.createElement("div");
  status.className = "hubspot-preview-status";
  status.textContent = person.ready_records
    ? `${person.ready_records} ${person.ready_records === 1 ? "record" : "records"} ready · ${person.already_synced_records} already synced`
    : `${person.already_synced_records} already synced · no action needed`;
  const details = document.createElement("p");
  details.textContent = `Types: ${person.record_types.join(", ")}${person.events.length ? ` · Events: ${person.events.join(", ")}` : ""}`;
  article.append(identity, status, details);
  return article;
}

hubspotPreviewButton.addEventListener("click", async () => {
  hubspotPreviewButton.disabled = true;
  hubspotPreviewSummary.textContent = "Building a read-only preview...";
  hubspotPreviewList.replaceChildren();
  try {
    const response = await fetch("/organizer/data/hubspot-backfill-preview");
    const result = await response.json();
    if (!response.ok || !result.ok || result.preview_only !== true) {
      throw new Error(result.reason || "Unable to build preview");
    }
    const summary = result.summary;
    hubspotPreviewSummary.textContent = `${summary.contacts_with_records_ready} contacts have ${summary.records_ready} records ready for review. ` +
      `${summary.records_already_synced} records are already synced; ${summary.records_missing_valid_email} cannot migrate without a valid email.`;
    hubspotPreviewList.replaceChildren(...result.contacts.map(createHubspotPreviewRow));
    hubspotBackfillActions.hidden = summary.contacts_with_records_ready === 0;
  } catch {
    hubspotPreviewSummary.textContent = "The HubSpot backfill preview could not be generated. No data was sent.";
  } finally {
    hubspotPreviewButton.disabled = false;
  }
});

hubspotBackfillButton.addEventListener("click", async () => {
  const emails = [...hubspotPreviewList.querySelectorAll(".hubspot-contact-selector:checked")]
    .map((checkbox) => checkbox.value);
  if (!emails.length) {
    hubspotBackfillStatus.textContent = "Select at least one contact to backfill.";
    return;
  }
  const selection = [...emails].sort().join("\n");
  if (armedBackfillSelection !== selection) {
    armedBackfillSelection = selection;
    hubspotBackfillButton.textContent = `Confirm backfill for ${emails.length} contact${emails.length === 1 ? "" : "s"}`;
    hubspotBackfillStatus.textContent = "Review the selected contacts, then press the confirmation button to send their unsynced history to HubSpot.";
    return;
  }
  armedBackfillSelection = "";
  hubspotBackfillButton.textContent = "Backfill selected contacts";
  hubspotBackfillButton.disabled = true;
  hubspotBackfillStatus.textContent = "Queueing selected history for HubSpot...";
  try {
    const response = await fetch("/organizer/data/hubspot-backfill", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ emails, confirmation: "BACKFILL" })
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.reason || "Backfill failed");
    hubspotBackfillStatus.textContent = `${result.records_queued} ${result.records_queued === 1 ? "record was" : "records were"} queued for HubSpot.`;
    hubspotPreviewButton.click();
  } catch {
    hubspotBackfillStatus.textContent = "The selected history could not be queued. No additional records were sent.";
  } finally {
    hubspotBackfillButton.disabled = false;
  }
});

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
      organizerStatus.textContent = "Sign in through Cloudflare Access to review participant summaries.";
      summaryList.replaceChildren();
      return;
    }
    if (!response.ok || !result.ok) throw new Error(result.reason || "Unable to load summaries");
    organizerTitle.textContent = result.event.name;
    organizerDetails.textContent = `${result.event.date_label} · ${result.event.location_label}`;
    await loadMentorBookings();
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
refreshButton.addEventListener("click", loadDataInventory);
loadDataInventory();
loadSummaries();
