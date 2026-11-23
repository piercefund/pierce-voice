import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const SOURCE_URL = "https://sandiegostartupweek.org/";
const OUTPUT_URL = new URL("../src/startup-week-schedule-2026.mjs", import.meta.url);

function compactText(value, limit = 720) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function normalizedEvent(event) {
  return {
    id: Number(event.id),
    title: compactText(event.title, 180),
    description: compactText(event.excerpt),
    date: compactText(event.date, 10),
    date_label: compactText(event.dateLabel, 80),
    start: compactText(event.startLabel, 20),
    end: compactText(event.endLabel, 20),
    start_minute: Number(event.startMin),
    end_minute: Number(event.endMin),
    venue: compactText(event.venue, 140),
    room: compactText(event.room, 100),
    address: compactText(event.address, 220),
    category: compactText(event.catName, 80),
    official: Boolean(event.official),
    featured: Boolean(event.featured),
    event_url: compactText(event.permalink, 500),
    registration_url: compactText(event.externalUrl || event.ticketUrl || event.permalink, 500)
  };
}

const response = await fetch(SOURCE_URL, {
  headers: { "user-agent": "Pierce Startup Week schedule refresh" }
});
if (!response.ok) {
  throw new Error(`Official schedule returned ${response.status}.`);
}

const html = await response.text();
const match = html.match(
  /<script type="application\/json" class="sdsw-schedule-data">([\s\S]*?)<\/script>/
);
if (!match) throw new Error("Official schedule data was not found.");

const raw = JSON.parse(match[1]);
if (!Array.isArray(raw.events) || raw.events.length === 0) {
  throw new Error("Official schedule did not contain events.");
}

const schedule = {
  name: "San Diego Startup Week 2026",
  source_url: SOURCE_URL,
  retrieved_at: new Date().toISOString(),
  dates: (raw.days || []).map((day) => ({
    date: compactText(day.date, 10),
    weekday: compactText(day.weekday, 20),
    label: compactText(day.monthday, 40)
  })),
  events: raw.events.map(normalizedEvent)
};

const source = [
  "// Generated from the official San Diego Startup Week schedule.",
  "// Run `npm run refresh:startup-week` to update this snapshot.",
  `export const startupWeekSchedule = Object.freeze(${JSON.stringify(schedule, null, 2)});`,
  ""
].join("\n");

await writeFile(OUTPUT_URL, source, "utf8");
console.log(
  `Saved ${schedule.events.length} events to ${fileURLToPath(OUTPUT_URL)} from ${SOURCE_URL}`
);
