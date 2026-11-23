export const SAN_DIEGO_WORKFORCE_UPDATES = Object.freeze({
  name: "San Diego Workforce Partnership email updates",
  url: "https://workforce.org/sign-up/",
  description: "Choose optional updates about job openings, career resources, labor-market trends, recruitment events, and training opportunities."
});

const SAN_DIEGO_COUNTY_PLACES = [
  "san diego",
  "carlsbad",
  "chula vista",
  "coronado",
  "del mar",
  "el cajon",
  "encinitas",
  "escondido",
  "imperial beach",
  "la mesa",
  "lemon grove",
  "national city",
  "oceanside",
  "poway",
  "san marcos",
  "santee",
  "solana beach",
  "vista"
];

export function isSanDiegoBased(value) {
  const location = String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!location) return false;
  return SAN_DIEGO_COUNTY_PLACES.some((place) => {
    const pattern = new RegExp(`(^|\\s)${place.replace(/ /g, "\\s+")}(\\s|$)`);
    return pattern.test(location);
  });
}

export function sanDiegoWorkforceEmailLines(value) {
  if (!isSanDiegoBased(value)) return [];
  return [
    "San Diego job and workforce updates (optional)",
    SAN_DIEGO_WORKFORCE_UPDATES.description,
    `Choose the updates you want: ${SAN_DIEGO_WORKFORCE_UPDATES.url}`,
    "Pierce will not subscribe you automatically. Your signup is managed by the San Diego Workforce Partnership.",
    ""
  ];
}
