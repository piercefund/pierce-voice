const button = document.querySelector("#copy-number");
const status = document.querySelector("#copy-status");
button.hidden = false;
button.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText("1-866-967-2844");
    status.textContent = "Number copied.";
  } catch {
    status.textContent = "Couldn’t copy automatically. You can select and copy the phone number above.";
  }
});
