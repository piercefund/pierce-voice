const eventSlug = "san-diego-startup-week-mentoring";
const groups = document.querySelector("#boardGroups");
const status = document.querySelector("#boardStatus");
const appointmentCount = document.querySelector("#appointmentCount");
const checkedInCount = document.querySelector("#checkedInCount");
const lastUpdated = document.querySelector("#lastUpdated");
const refreshButton = document.querySelector("#refreshBoard");

function formatTime(time) {
  const [hourText, minute] = String(time || "").split(":");
  const hour = Number(hourText);
  return `${hour % 12 || 12}:${minute} ${hour < 12 ? "AM" : "PM"}`;
}

function appointmentCard(appointment) {
  const card = document.createElement("article");
  card.className = `board-card${appointment.checked_in ? " checked-in" : ""}`;

  const heading = document.createElement("div");
  heading.className = "board-card-heading";
  const table = document.createElement("h3");
  table.textContent = `Table ${appointment.table}`;
  const state = document.createElement("span");
  state.textContent = appointment.checked_in ? "Checked in" : "Expected";
  heading.append(table, state);

  const participantLabel = document.createElement("p");
  participantLabel.className = "board-label";
  participantLabel.textContent = "PARTICIPANT";
  const participant = document.createElement("p");
  participant.className = "board-participant";
  participant.textContent = appointment.participant_name;

  const mentorLabel = document.createElement("p");
  mentorLabel.className = "board-label";
  mentorLabel.textContent = "MENTOR";
  const mentor = document.createElement("p");
  mentor.className = "board-mentor";
  mentor.textContent = appointment.mentor_name;

  const expertise = document.createElement("p");
  expertise.className = "board-expertise";
  expertise.textContent = appointment.mentor_expertise?.length
    ? appointment.mentor_expertise.join(" | ")
    : "Expertise not listed";

  card.append(
    heading, participantLabel, participant, mentorLabel, mentor, expertise
  );
  return card;
}

function renderBoard(appointments) {
  const byTime = new Map();
  for (const appointment of appointments) {
    if (!byTime.has(appointment.start_time)) byTime.set(appointment.start_time, []);
    byTime.get(appointment.start_time).push(appointment);
  }

  const sections = [...byTime].map(([startTime, entries]) => {
    const section = document.createElement("section");
    section.className = "board-time-group";
    const heading = document.createElement("div");
    heading.className = "board-time-heading";
    const title = document.createElement("h2");
    title.textContent = formatTime(startTime);
    const count = document.createElement("span");
    count.textContent = `${entries.length} ${entries.length === 1 ? "participant" : "participants"}`;
    heading.append(title, count);
    const cards = document.createElement("div");
    cards.className = "board-cards";
    cards.append(...entries.map(appointmentCard));
    section.append(heading, cards);
    return section;
  });

  groups.replaceChildren(...sections);
  status.hidden = appointments.length > 0;
  status.textContent = appointments.length ? "" : "No mentor appointments are booked yet.";
}

async function loadBoard() {
  refreshButton.disabled = true;
  try {
    const response = await fetch(`/event/mentoring/board?slug=${encodeURIComponent(eventSlug)}`, {
      cache: "no-store"
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.reason || "load_failed");
    appointmentCount.textContent = result.appointments.length;
    checkedInCount.textContent = result.appointments.filter((item) => item.checked_in).length;
    renderBoard(result.appointments);
    const now = new Date();
    lastUpdated.textContent = `Updated ${now.toLocaleTimeString("en-US", {
      hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles"
    })}`;
    lastUpdated.dateTime = now.toISOString();
  } catch {
    status.hidden = false;
    status.textContent = "Appointments could not be loaded. Try refreshing.";
  } finally {
    refreshButton.disabled = false;
  }
}

refreshButton.addEventListener("click", loadBoard);
loadBoard();
window.setInterval(loadBoard, 15000);
