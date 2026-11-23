const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const loadingState = document.querySelector("#loadingState");
const emailForm = document.querySelector("#emailForm");
const guestEmail = document.querySelector("#guestEmail");
const emailConfirmed = document.querySelector("#emailConfirmed");
const emailError = document.querySelector("#emailError");
const submitButton = document.querySelector("#submitButton");
const resultState = document.querySelector("#resultState");

let token = "";
try {
  token = decodeURIComponent(window.location.hash.slice(1));
} catch {
  token = "";
}
window.history.replaceState({}, "", "/email");

function showResult(message, type = "error") {
  loadingState.hidden = true;
  emailForm.hidden = true;
  resultState.hidden = false;
  resultState.className = `result ${type}`;
  resultState.textContent = message;
}

function showEmailError(message) {
  emailError.hidden = !message;
  emailError.textContent = message;
  guestEmail.setAttribute("aria-invalid", message ? "true" : "false");
}

async function postJson(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    credentials: "same-origin"
  });
  let result = {};
  try {
    result = await response.json();
  } catch {
    result = {};
  }
  return { response, result };
}

async function initialize() {
  if (!TOKEN_PATTERN.test(token)) {
    showResult("This secure link is invalid or has expired. Request a new link during a Pierce call.");
    return;
  }
  try {
    const { response } = await postJson("/email-link/status", { token });
    if (!response.ok) {
      showResult("This secure link is invalid, expired, or has already been used. Request a new link during a Pierce call.");
      return;
    }
    loadingState.hidden = true;
    emailForm.hidden = false;
    guestEmail.focus();
  } catch {
    showResult("Pierce could not check this link right now. Please try again in a moment.");
  }
}

emailForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showEmailError("");
  const email = guestEmail.value.trim().toLowerCase();
  if (!guestEmail.validity.valid) {
    showEmailError("Enter a complete email address.");
    guestEmail.focus();
    return;
  }
  if (!emailConfirmed.checked) {
    showEmailError("Check the confirmation box after reviewing your email.");
    emailConfirmed.focus();
    return;
  }

  submitButton.disabled = true;
  submitButton.textContent = "Sending...";
  try {
    const { response, result } = await postJson("/email-link/complete", {
      token,
      guest_email: email,
      email_confirmed: true
    });
    if (!response.ok) {
      if (result.reason === "email_not_confirmed") {
        showEmailError("Enter a complete email address and confirm it is correct.");
        return;
      }
      showResult("This secure link is invalid, expired, or has already been used. Request a new link during a Pierce call.");
      return;
    }
    token = "";
    showResult(result.message || "Your email is confirmed and your recap is on its way.", "success");
  } catch {
    showEmailError("Pierce could not save your email right now. Please try again.");
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Send my recap";
  }
});

initialize();
