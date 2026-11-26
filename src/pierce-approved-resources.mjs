const SAN_DIEGO = ["san diego", "san diego county", "chula vista", "national city", "el cajon", "la mesa", "escondido", "oceanside", "carlsbad", "logan heights"];

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
    email: "info@careeronestop.org",
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
    email: "youthemploymentandeducation@csbcs.org",
    phone: "+1 619-210-9382",
    contactUrl: "https://sbcssandiego.org/career-technical-education-programs/",
    description: "San Diego youth career pathways and wraparound community support.",
    eligibility: "Eligibility and availability vary by program.",
    categories: ["youth", "career pathways", "community support", "job readiness"],
    programs: [
      { name: "Work Readiness Program",
        url: "https://sbcssandiego.org/career-technical-education-programs/",
        note: "Career coaching and work readiness for youth and young adults ages 16–24. Confirm current enrollment with SBCS.",
        keywords: ["youth", "teen", "young adult", "first job", "work readiness", "job readiness", "career coach", "career coaching"] }
    ],
    serviceArea: SAN_DIEGO,
    locations: ["san diego", "california"]
  }),
  sdsu_careers: Object.freeze({
    name: "SDSU Careers",
    url: "https://career.sdsu.edu/",
    email: "careerservices@sdsu.edu",
    phone: "+1 619-594-6851",
    contactUrl: "https://career.sdsu.edu/about-us/location-hours-and-appointments",
    description: "Career exploration, preparation, internships, and employment resources.",
    eligibility: "Best fit depends on SDSU student or alumni eligibility.",
    categories: ["college", "internships", "career preparation", "employment"],
    programs: [
      { name: "SDSU Career Services",
        url: "https://career.sdsu.edu/",
        note: "Career advising, internships, and job search support. Ask about access for students and alumni.",
        keywords: ["sdsu", "san diego state", "aztec", "handshake", "campus internship", "student internship", "alumni"] }
    ],
    serviceArea: SAN_DIEGO,
    locations: ["san diego", "california"]
  }),
  sdsu_global_campus: Object.freeze({
    name: "SDSU Global Campus",
    url: "https://globalcampus.sdsu.edu/",
    phone: "+1 619-594-7700",
    description: "Online continuing education and workforce training from San Diego State University.",
    eligibility: "Confirm program requirements and current registration with SDSU Global Campus.",
    categories: ["AI training", "AI literacy", "AI credential"],
    serviceArea: SAN_DIEGO,
    statewideCalifornia: true,
    locations: ["san diego", "california", "online"],
    programs: [
      {
        name: "AI Certificate",
        url: "https://careertraining.sdsu.edu/training-programs/ai-certificate-prerequisites/",
        note: "Paid online workplace AI training for nontechnical professionals, including a practical capstone. Check current tuition and requirements on the program page.",
        keywords: ["paid ai certificate", "paid ai training", "advanced ai certificate", "workplace ai certificate", "ai capstone"]
      },
      {
        name: "AI-Ready California",
        url: "https://globalcampus.sdsu.edu/program/science-computers-technology/ai-ready-california/",
        note: "Free, self-paced beginner AI literacy microcredential for Californians. Takes about two to four hours. No coding background required.",
        keywords: ["ai", "artificial intelligence", "chatgpt", "generative ai", "microcredential"]
      }
    ]
  }),
  irc_san_diego: Object.freeze({
    name: "International Rescue Committee San Diego",
    url: "https://www.rescue.org/united-states/san-diego-ca",
    email: "sandiego@rescue.org",
    phone: "+1 619-641-7510",
    contactUrl: "https://welcome.rescue.org/us/en/san-diego-ca/services",
    description: "Employment and career support in San Diego.",
    eligibility: "Services are for eligible refugees, immigrants, and other eligible community members.",
    categories: ["refugee", "immigrant", "employment", "career support"],
    programs: [
      { name: "Find Work in San Diego",
        url: "https://welcome.rescue.org/us/en/san-diego-ca/services",
        note: "Employment support for eligible newcomers. Check program eligibility and current availability with IRC.",
        keywords: ["refugee", "asylee", "newcomer", "immigrant employment", "immigrant", "resettlement", "english for work"] }
    ],
    serviceArea: SAN_DIEGO,
    locations: ["san diego", "california"]
  }),
  climb_hire_san_diego: Object.freeze({
    name: "Climb Hire San Diego",
    aliases: ["Climb Hire"],
    email: "admissions@climbhire.co",
    contactUrl: "https://climbhire.co/job-search-accelerator-ca/",
    url: "https://climbhire.co/job-training-programs-san-diego/",
    description: "Technology and digital career training pathways in San Diego.",
    eligibility: "Eligibility, age requirements, and availability vary by program.",
    categories: ["technology", "digital careers", "job training", "career pathways"],
    programs: [
      { name: "IT Apprenticeship",
        url: "https://info.climbhire.co/it-apprenticeship",
        note: "IT training and a paid apprenticeship pathway. The published cohort lists ages 18–24 in San Diego or Los Angeles County. Ask admissions about upcoming cohorts.",
        keywords: ["apprenticeship", "paid apprenticeship", "it apprenticeship"] },
      { name: "IT Support training",
        url: "https://climbhire.co/job-training-programs-san-diego/",
        note: "Explore IT support training. Ask admissions about cost, eligibility, and the next cohort.",
        keywords: ["it", "it support", "information technology", "help desk", "comptia", "tech training", "technology", "digital careers"] },
      { name: "Job Search Accelerator",
        url: "https://climbhire.co/job-search-accelerator-ca/",
        note: "Explore job search guidance for resumes, interviews, LinkedIn, and networking. Ask admissions about current no-cost options, eligibility, and intake.",
        keywords: ["free guidance", "free career guidance", "free career help", "free job search help", "job search accelerator", "resume", "interview prep", "linkedin", "networking"] }
    ],
    serviceArea: SAN_DIEGO,
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
