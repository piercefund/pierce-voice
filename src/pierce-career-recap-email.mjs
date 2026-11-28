import { PIERCE_APPROVED_RESOURCES } from "./pierce-approved-resources.mjs";
import { findRecommendedEvent } from "./pierce-recommended-events.mjs";

const PIERCE_URL = "https://voice.pierce.fund";
const MISSION = "Pierce helps people explore career options, recognize their strengths, and take a practical next step with resources they can use.";
const NO_VERIFIED_RESOURCE = "This recap has no verified resource link. See your next step above.";
const pacificSessionTime = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short"
});

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function matchRecommendation(value) {
  const recommendation = value.toLowerCase();
  const words = (value) => ` ${value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  const normalized = words(recommendation);
  const programMatches = ({ name, url }) =>
    normalized.includes(words(name)) || recommendation.includes(url.toLowerCase());
  const resources = Object.values(PIERCE_APPROVED_RESOURCES);
  const resource = resources.find(({ name, aliases = [], url }) =>
    [name, ...aliases].some((label) => normalized.includes(words(label))) || recommendation.includes(url.toLowerCase())
  ) ?? resources.find(({ programs }) => programs?.some(programMatches));
  if (!resource) return null;
  const program = resource.programs?.find(programMatches);
  const contact = [
    ["Website", resource.url, resource.url],
    ...(program ? [["Program", program.name, program.url]] : []),
    ...(resource.email ? [["Email", resource.email, `mailto:${resource.email}`]] : []),
    ...(resource.phone ? [["Phone", resource.phone, `tel:${resource.phone.replace(/[^+\d]/g, "")}`]] : []),
    ...(resource.contactUrl ? [["Contact information", resource.contactUrl, resource.contactUrl]] : [])
  ];
  return { resource, program, contact };
}

export function formatCareerRecap(fields, { preparedAt = new Date(), recommendedResources = [], recommendedEventId } = {}) {
  const recapTime = pacificSessionTime.format(preparedAt);
  const event = findRecommendedEvent(recommendedEventId, preparedAt.getTime());
  const eventDetails = event ? [event.name, event.organizer, event.format, event.when, event.location, event.description] : [];
  const candidates = recommendedResources.length ? recommendedResources : [fields
    .filter(([label]) => label === "Guidance" || label === "Next step")
    .map(([, value]) => value).join(" ")];
  let recommendation;
  for (const candidate of candidates) {
    recommendation = matchRecommendation(candidate);
    if (recommendation) break;
  }
  const recommendations = recommendation ? [recommendation] : [];
  const body = [
    "Your Pierce career session recap",
    `Session recap prepared: ${recapTime}`,
    ...fields.map(([label, value]) => `${label}: ${value}`),
    ["Recommended resource", ...(recommendations.length
      ? recommendations.flatMap(({ resource, program, contact }) => [resource.name, resource.description, program?.note || resource.eligibility,
        ...contact.map(([label, value, href]) => `${label}: ${label === "Program" ? `${value} (${href})` : value}`)])
      : [NO_VERIFIED_RESOURCE])].filter(Boolean).join("\n"),
    ...(event ? [["Recommended Event", ...eventDetails, event.url].join("\n")] : []),
    MISSION,
    `Start another career session: ${PIERCE_URL}`
  ].join("\n\n");
  const sections = fields.map(([label, value]) =>
    `<h2 style="font-size:18px;margin:20px 0 6px">${escapeHtml(label)}</h2><p style="margin:0;white-space:pre-wrap">${escapeHtml(value)}</p>`
  ).join("");
  const resourceCard = `<div style="background:#e8f6fa;padding:20px;margin-top:24px;border:1px solid #d8e4e7;border-radius:16px">
    <h2 style="font-size:18px;margin:0 0 8px">Recommended resource</h2>
    ${recommendations.length ? recommendations.map(({ resource, program, contact }) => `<p style="margin:12px 0 0"><strong>${escapeHtml(resource.name)}</strong><br>${escapeHtml(resource.description)}</p>
    ${(program?.note || resource.eligibility) ? `<p>${escapeHtml(program?.note || resource.eligibility)}</p>` : ""}
    <p style="margin-bottom:0">${contact.map(([label, value, href]) =>
      `<a style="color:#275465" href="${escapeHtml(href)}">${escapeHtml(label === "Website" ? "Visit the website" : label === "Contact information" ? label : value)}</a>`
    ).join("<br>")}</p>`).join("") : `<p style="margin:0">${NO_VERIFIED_RESOURCE}</p>`}
  </div>`;
  const html = `<!doctype html><html lang="en"><body style="margin:0;background:#e8f6fa;color:#121827;font:16px/1.55 Arial,sans-serif">
    <div style="max-width:580px;margin:20px auto;padding:24px;background:white;border:1px solid #d8e4e7;border-radius:24px">
      <div style="padding:18px;background:#e8f6fa;border-radius:16px">
      <img src="${PIERCE_URL}/pierce-email-logo.png" alt="Pierce" width="132" style="display:block;width:132px;height:auto;color:#121827;font-size:24px;font-weight:bold">
      <h1 style="font-size:25px;line-height:1.2;margin:12px 0 4px;color:#121827">Your career session recap</h1>
      <p style="margin:0;color:#275465">Session recap prepared <time datetime="${preparedAt.toISOString()}">${escapeHtml(recapTime)}</time></p></div>
      ${sections}
      ${resourceCard}
      ${event ? `<div style="background:#e8f6fa;padding:20px;margin-top:24px;border:1px solid #d8e4e7;border-radius:16px">
        <h2 style="font-size:18px;margin:0 0 8px">Recommended Event</h2>
        <p style="margin:0"><strong>${escapeHtml(event.name)}</strong><br>${eventDetails.slice(1).map(escapeHtml).join("<br>")}</p>
        <p style="margin-bottom:0"><a style="color:#275465" href="${escapeHtml(event.url)}">Check event details and registration</a></p>
      </div>` : ""}
      <div style="border-top:1px solid #d8e4e7;margin-top:24px;padding-top:18px">
        <p style="margin-top:0">${MISSION}</p>
        <a style="display:inline-block;background:#121827;color:white;padding:10px 16px;border-radius:12px;text-decoration:none" href="${PIERCE_URL}">Start another career session</a>
      </div>
    </div>
  </body></html>`;
  return { body, html };
}
