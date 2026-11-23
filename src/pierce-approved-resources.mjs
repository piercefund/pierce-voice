export const PIERCE_APPROVED_RESOURCES = Object.freeze({
  my_next_move: Object.freeze({
    name: "My Next Move",
    url: "https://www.mynextmove.org/",
    description: "Explore careers, interests, skills, training, and job outlook.",
    categories: ["career exploration", "interests", "skills", "training", "job outlook"],
    locations: ["online", "united states"]
  }),
  career_one_stop: Object.freeze({
    name: "CareerOneStop",
    url: "https://www.careeronestop.org/",
    description: "Explore careers, training, job searches, and local help.",
    categories: ["career exploration", "training", "job search", "local help"],
    locations: ["online", "united states"]
  }),
  onet_online: Object.freeze({
    name: "O*NET OnLine",
    url: "https://www.onetonline.org/",
    description: "Review detailed occupation tasks, skills, and requirements.",
    categories: ["occupation research", "tasks", "skills", "requirements"],
    locations: ["online", "united states"]
  }),
  sbcs: Object.freeze({
    name: "SBCS",
    url: "https://sbcssandiego.org/",
    description: "San Diego youth career pathways and wraparound community support.",
    eligibility: "Eligibility and availability vary by program.",
    categories: ["youth", "career pathways", "community support", "job readiness"],
    locations: ["san diego", "california"]
  }),
  sdsu_careers: Object.freeze({
    name: "SDSU Careers",
    url: "https://careers.sdsu.edu/",
    description: "Career exploration, preparation, internships, and employment resources.",
    eligibility: "Best fit depends on SDSU student or alumni eligibility.",
    categories: ["college", "internships", "career preparation", "employment"],
    locations: ["san diego", "california"]
  }),
  irc_san_diego: Object.freeze({
    name: "International Rescue Committee San Diego",
    url: "https://www.rescue.org/united-states/san-diego-ca",
    description: "Employment and career support in San Diego.",
    eligibility: "Services are for eligible refugees, immigrants, and other eligible community members.",
    categories: ["refugee", "immigrant", "employment", "career support"],
    locations: ["san diego", "california"]
  }),
  climb_hire_san_diego: Object.freeze({
    name: "Climb Hire San Diego",
    url: "https://climbhire.co/job-training-programs-san-diego/",
    description: "Technology and digital career training pathways in San Diego.",
    eligibility: "Eligibility, age requirements, and availability vary by program.",
    categories: ["technology", "digital careers", "job training", "career pathways"],
    locations: ["san diego", "california"]
  })
});

export function publicResource(resourceKey) {
  const resource = PIERCE_APPROVED_RESOURCES[resourceKey];
  if (!resource) return null;
  return {
    key: resourceKey,
    name: resource.name,
    url: resource.url,
    description: resource.description,
    eligibility: resource.eligibility || "",
    categories: [...resource.categories],
    locations: [...resource.locations]
  };
}
