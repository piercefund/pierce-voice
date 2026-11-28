const agentId = "agent_0601m7e1tm5nfejs58m7f26ffmhe";

if (location.pathname === "/") {
  const original = document.querySelector("main.shell");
  const home = document.createElement("main");
  home.className = "pierce-home";
  home.innerHTML = `
    <header class="pierce-voice-header">
      <div class="pierce-voice-wrap">
        <a class="pierce-voice-brand" href="https://pierce.fund" aria-label="Pierce home">
          <img src="/pierce-favicon-32.png" width="32" height="32" alt="">Pierce
        </a>
        <a class="pierce-voice-back" href="https://pierce.fund">pierce.fund →</a>
      </div>
    </header>
    <div class="pierce-home-stage">
      <div class="pierce-home-orb" aria-hidden="true"></div>
      <h1>Find your next career move</h1>
      <p>Start a career session in Voice Mode, or type below for Quiet Mode.</p>
      <button type="button" data-call>Start Voice Mode</button>
    </div>
    <p class="pierce-home-status" role="status"></p>
    <div class="pierce-home-transcript" role="log" aria-label="Conversation"></div>
    <form>
      <textarea aria-label="Message Pierce in Quiet Mode" placeholder="What would you like to explore?&#10;For example: I’m thinking about changing careers and want help choosing a first step." rows="3" maxlength="1500" required></textarea>
      <button type="submit">Send</button>
    </form>
    <footer class="pierce-voice-footer">
      <div class="pierce-voice-wrap">
        <strong>One resource, one event, one human connection</strong>
        <a href="https://pierce.fund">Pierce · pierce.fund</a>
      </div>
    </footer>`;
  original.hidden = true;
  original.before(home);

  const call = home.querySelector("[data-call]");
  const form = home.querySelector("form");
  const input = home.querySelector("textarea");
  const send = form.querySelector("button");
  const status = home.querySelector("[role=status]");
  const transcript = home.querySelector("[role=log]");
  let session;
  let busy = false;
  let recapDeliveryId;
  const openingPlaceholder = input.placeholder;
  const emailAddress = document.createElement("input");
  emailAddress.type = "email";
  emailAddress.required = true;
  const voiceGoodbye = /(?:^|\s)Thanks for talking with me\. Take care\.[”"]?$/i;

  function setRecapDelivery(id) {
    recapDeliveryId = id;
    input.value = "";
    input.placeholder = id ? "Enter your email address" : openingPlaceholder;
    input.setAttribute("aria-label", id ? "Email address for your Pierce recap" : "Message Pierce in Quiet Mode");
    input.inputMode = id ? "email" : "text";
    send.textContent = id ? "Email my recap" : "Send";
  }

  async function emailRecap(address) {
    emailAddress.value = address;
    if (!emailAddress.checkValidity()) {
      status.textContent = "Enter a valid email address to send your recap.";
      return;
    }
    status.textContent = "Sending your recap…";
    const response = await fetch("/guest-takeaway/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ delivery_id: recapDeliveryId, guest_email: address, email_consent: true })
    });
    const result = await response.json();
    if (response.ok && result.email_status === "sent") {
      setRecapDelivery(undefined);
      status.textContent = result.duplicate ? "This recap was already sent." : "Your recap was sent.";
    } else if (response.status === 404 || response.status === 410) {
      setRecapDelivery(undefined);
      status.textContent = "This recap has expired.";
    } else {
      status.textContent = "Pierce couldn’t send your recap. Check your address and try again.";
    }
  }

  function showMessage(source, message, textOnly) {
    if (!message) return;
    const line = document.createElement("p");
    line.textContent = `${source === "user" ? "You" : "Pierce"}: ${message}`;
    const recapLink = source === "ai" && message.match(
      /https:\/\/voice\.pierce\.fund\/recap-email\.html#([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})\b/i
    );
    if (recapLink) {
      if (!textOnly) return;
      if (recapDeliveryId === recapLink[1]) return;
      setRecapDelivery(recapLink[1]);
      line.textContent = "Pierce: Your recap is ready. Type your email below, check the address, and select Email my recap to send it.";
    }
    transcript.append(line);
    transcript.scrollTop = transcript.scrollHeight;
  }

  function setBusy(value) {
    busy = value;
    call.disabled = value;
    send.disabled = value;
  }

  async function start(textOnly) {
    let openingMessage;
    let guestHasReplied = false;
    let closeAfterSpeech = false;
    let conversation;
    status.textContent = "Connecting to Pierce…";
    const { Conversation } = await import("https://esm.sh/@elevenlabs/client@1.38.0");
    conversation = await Conversation.startSession({
      agentId,
      textOnly,
      onMessage: ({ source, message }) => {
        if (source === "user") guestHasReplied = true;
        if (source === "ai" && !guestHasReplied && message) {
          const normalized = message.trim().replace(/\s+/g, " ");
          if (normalized === openingMessage) return;
          openingMessage = normalized;
        }
        showMessage(source, message, textOnly);
        if (!textOnly && source === "ai" && voiceGoodbye.test(message?.trim() || "")) {
          closeAfterSpeech = true;
        }
      },
      onModeChange: ({ mode }) => {
        if (!closeAfterSpeech || mode !== "listening" || !conversation || session !== conversation) return;
        closeAfterSpeech = false;
        void conversation.endSession().catch(() => {
          status.textContent = "Couldn’t close the session automatically.";
        });
      },
      onDisconnect: () => {
        session = undefined;
        call.textContent = "Start Voice Mode";
        if (!recapDeliveryId) status.textContent = "Session ended.";
      },
      onError: () => { status.textContent = "Pierce ran into a connection problem."; }
    });
    session = conversation;
    session.sendContextualUpdate(textOnly
      ? "Pierce website session mode: Quiet Mode (text only). After the guest accepts, return the exact recap delivery URL so the website can collect their email in the same message box."
      : "Pierce website session mode: Voice Mode (microphone and spoken responses). Use the phone recap flow: offer email aloud, ask for the address by voice, confirm it, and send directly. Do not offer or read a recap link.");
    call.textContent = "End session";
    status.textContent = textOnly ? "Text session connected." : "Voice session connected.";
  }

  async function run(action) {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } catch {
      status.textContent = "Couldn’t complete that action. Please try again.";
    } finally {
      setBusy(false);
    }
  }

  call.addEventListener("click", () => run(() => {
    if (session) return session.endSession();
    if (recapDeliveryId) setRecapDelivery(undefined);
    return start(false);
  }));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const message = input.value.trim();
    if (!message) return;
    void run(async () => {
      if (recapDeliveryId) {
        await emailRecap(message);
        return;
      }
      if (!session) await start(true);
      session.sendUserMessage(message);
      input.value = "";
    });
  });
}
