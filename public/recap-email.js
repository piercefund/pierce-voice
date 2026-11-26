const form = document.querySelector("#recap-delivery");
const button = form.querySelector("button");
const status = document.querySelector("#recap-status");
const deliveryId = location.hash.slice(1);
history.replaceState(null, "", location.pathname);

if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(deliveryId)) {
  form.hidden = true;
  status.textContent = "Open the recap link from your Pierce session.";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  button.disabled = true;
  status.textContent = "Sending your recap…";
  try {
    const response = await fetch("/guest-takeaway/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        delivery_id: deliveryId,
        guest_email: document.querySelector("#recap-email").value,
        email_consent: document.querySelector("#recap-consent").checked
      })
    });
    const result = await response.json();
    if (response.ok && result.email_status === "sent") {
      status.textContent = result.duplicate ? "This recap was already sent." : "Your recap was sent.";
      form.hidden = true;
    } else {
      status.textContent = response.status === 404 ? "This recap link has expired." : "Pierce couldn’t send your recap. Check the address and try again.";
    }
  } catch {
    status.textContent = "Pierce couldn’t confirm delivery. Please try again.";
  } finally {
    button.disabled = false;
  }
});
