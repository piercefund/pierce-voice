import { SAN_DIEGO } from "./pierce-approved-resources.mjs";

const events = [
  {
    id: "sdwp-career-interests-2026-12-03",
    name: "Connecting Interests with Careers Workshop",
    organizer: "San Diego Workforce Partnership",
    format: "Online",
    startsAt: "2026-12-03T21:30:00Z",
    when: "December 3, 2026, 1:30–3:30 PM Pacific",
    location: "Zoom",
    url: "https://www.workforce.org/venue/zoom-virtual-447/",
    description: "Explore how your interests and skills connect to possible careers.",
    topics: ["career exploration", "career change", "career options", "career interests", "career planning"]
  },
  {
    id: "sandag-bikeway-2026-12-05",
    name: "Border to Bayshore Bikeway Group Bike Ride",
    organizer: "SANDAG",
    format: "In person",
    startsAt: "2026-12-05T17:00:00Z",
    registrationClosesAt: "2026-12-04T20:00:00Z",
    when: "December 5, 2026, 9:00 AM Pacific",
    location: "Bikeway Village, Imperial Beach, CA",
    url: "https://sandag.org/events-calendar/group-bike-ride-2026-12-05",
    description: "See a regional bikeway project firsthand on a guided ride. The organizer requires a bike, helmet, and advance registration.",
    topics: ["urban planning", "transportation planning", "active transportation", "bikeway", "regional planning"]
  }
];

export function findRecommendedEvent(id, now = Date.now()) {
  const event = events.find((entry) => entry.id === id);
  return event && Date.parse(event.registrationClosesAt || event.startsAt) > now ? event : null;
}

export function lookupRecommendedEvent(query, location, now = Date.now()) {
  const city = location.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
    .replace(/ (?:ca|california)$/, "");
  const isSanDiego = SAN_DIEGO.includes(city) || city === "imperial beach";
  const topic = ` ${query.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  const onlineOnly = /\b(?:online|virtual|remote)\b/.test(topic);
  const inPersonOnly = /\bin person\b/.test(topic) && !onlineOnly;
  const event = events.find((entry) => findRecommendedEvent(entry.id, now) &&
    (entry.format === "Online" ? !inPersonOnly : isSanDiego && !onlineOnly) &&
    entry.topics.some((keyword) => topic.includes(` ${keyword} `)));
  if (!event) return null;
  const { topics, ...details } = event;
  return details;
}
