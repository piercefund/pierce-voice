const agentId = "agent_0601m7e1tm5nfejs58m7f26ffmhe";

if (location.pathname === "/") {
  const original = document.querySelector("main.shell");
  const home = document.createElement("main");
  home.className = "pierce-home";
  home.innerHTML = `
    <header><a href="https://pierce.fund"><img src="/pierce-logo-horizontal.svg" alt="Pierce"></a></header>
    <div class="pierce-home-stage">
      <div class="pierce-home-orb" aria-hidden="true"></div>
      <h1>Find your next career move</h1>
      <p>Start a career session in Voice Mode, or type below for Quiet Mode.</p>
      <button type="button" data-call>Start Voice Mode</button>
    </div>
    <p class="pierce-home-status" role="status"></p>
    <div class="pierce-home-transcript" role="log" aria-label="Conversation"></div>
    <form>
      <textarea aria-label="Message Pierce in Quiet Mode" placeholder="Start in Quiet Mode. What would you like to explore?" rows="2" maxlength="1500" required></textarea>
      <button type="submit">Send</button>
    </form>`;
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

  function showMessage(source, message) {
    if (!message) return;
    const line = document.createElement("p");
    line.textContent = `${source === "user" ? "You" : "Pierce"}: ${message}`;
    const recapLink = source === "ai" && message.match(
      /https:\/\/voice\.pierce\.fund\/recap-email\.html#[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\b/i
    );
    if (recapLink) {
      const link = document.createElement("a");
      link.href = recapLink[0];
      link.textContent = "Email my recap";
      line.textContent = "Pierce: Your recap is ready. ";
      line.append(link);
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
    status.textContent = "Connecting to Pierce…";
    const { Conversation } = await import("https://esm.sh/@elevenlabs/client@1.38.0");
    session = await Conversation.startSession({
      agentId,
      textOnly,
      onMessage: ({ source, message }) => showMessage(source, message),
      onDisconnect: () => {
        session = undefined;
        call.textContent = "Start Voice Mode";
        status.textContent = "Session ended.";
      },
      onError: () => { status.textContent = "Pierce ran into a connection problem."; }
    });
    session.sendContextualUpdate(textOnly
      ? "The guest is using Quiet Mode on the Pierce website."
      : "The guest is using Voice Mode on the Pierce website.");
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

  call.addEventListener("click", () => run(() => session ? session.endSession() : start(false)));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const message = input.value.trim();
    if (!message) return;
    void run(async () => {
      if (!session) await start(true);
      session.sendUserMessage(message);
      input.value = "";
    });
  });
}
