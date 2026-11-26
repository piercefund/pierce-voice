import { PIERCE_APPROVED_RESOURCES } from "./pierce-approved-resources.mjs";

const PIERCE_URL = "https://voice.pierce.fund";
const MISSION = "Pierce helps people explore career options, recognize their strengths, and take a practical next step with resources they can use.";

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function formatCareerRecap(fields) {
  // Match only resources named in the guidance or next step, where recommendations appear.
  const recommendation = fields.filter(([label]) => label === "Guidance" || label === "Next step")
    .map(([, value]) => value).join(" ").toLowerCase();
  const words = (value) => ` ${value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  const normalized = words(recommendation);
  const resource = Object.values(PIERCE_APPROVED_RESOURCES).find(({ name, aliases = [], url }) =>
    [name, ...aliases].some((label) => normalized.includes(words(label))) || recommendation.includes(url.toLowerCase())
  );
  const program = resource?.programs?.find(({ name }) => normalized.includes(words(name)));
  const contact = resource ? [
    ["Website", resource.url, resource.url],
    ...(program ? [["Program", program.name, program.url]] : []),
    ...(resource.email ? [["Email", resource.email, `mailto:${resource.email}`]] : []),
    ...(resource.phone ? [["Phone", resource.phone, `tel:${resource.phone.replace(/[^+\d]/g, "")}`]] : []),
    ...(resource.contactUrl ? [["Contact information", resource.contactUrl, resource.contactUrl]] : [])
  ] : [];
  const body = [
    "Your Pierce career session recap",
    ...fields.map(([label, value]) => `${label}: ${value}`),
    ...(resource ? [
      ["Recommended resource", resource.name, resource.description, program?.note || resource.eligibility,
        ...contact.map(([label, value]) => `${label}: ${label === "Program" ? `${value} (${program.url})` : value}`)].filter(Boolean).join("\n")
    ] : []),
    MISSION,
    `Start another career session: ${PIERCE_URL}`
  ].join("\n\n");
  const sections = fields.map(([label, value]) =>
    `<h2 style="font-size:18px;margin:20px 0 6px">${escapeHtml(label)}</h2><p style="margin:0">${escapeHtml(value)}</p>`
  ).join("");
  const resourceCard = resource ? `<div style="background:#ecf7fa;padding:20px;margin-top:24px;border:1px solid #ccdbe1;border-radius:16px">
    <h2 style="font-size:18px;margin:0 0 8px">Recommended resource</h2>
    <p style="margin:0"><strong>${escapeHtml(resource.name)}</strong><br>${escapeHtml(resource.description)}</p>
    ${(program?.note || resource.eligibility) ? `<p>${escapeHtml(program?.note || resource.eligibility)}</p>` : ""}
    <p style="margin-bottom:0">${contact.map(([label, value, href]) =>
      `<a style="color:#155a6c" href="${escapeHtml(href)}">${escapeHtml(label === "Website" ? "Visit the website" : label === "Contact information" ? label : value)}</a>`
    ).join("<br>")}</p>
  </div>` : "";
  const html = `<!doctype html><html lang="en"><body style="margin:0;background:#ecf7fa;color:#133744;font:16px/1.55 Arial,sans-serif">
    <div style="max-width:580px;margin:20px auto;padding:24px;background:white;border:1px solid #ccdbe1;border-radius:24px">
      <div style="padding:18px;background:#ecf7fa;border-radius:16px"><strong style="font-size:24px;color:#184f60">Pierce</strong>
      <h1 style="font-size:25px;line-height:1.2;margin:8px 0 0">Your career session recap</h1></div>
      ${sections}
      ${resourceCard}
      <div style="border-top:1px solid #ccdbe1;margin-top:24px;padding-top:18px">
        <p style="margin-top:0">${MISSION}</p>
        <a style="display:inline-block;background:#184f60;color:white;padding:10px 16px;border-radius:12px;text-decoration:none" href="${PIERCE_URL}">Start another career session</a>
      </div>
    </div>
  </body></html>`;
  return { body, html };
}
