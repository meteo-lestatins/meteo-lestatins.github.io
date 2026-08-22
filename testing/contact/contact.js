(() => {
  const form = document.querySelector(".contact-form");
  const submitButton = form?.querySelector('button[type="submit"]');
  const status = document.getElementById("contact-status");
  if (!form || !submitButton || !status) return;

  const runtimeConfig = window.METEO_RUNTIME_CONFIG && typeof window.METEO_RUNTIME_CONFIG === "object"
    ? window.METEO_RUNTIME_CONFIG
    : {};
  const apiBase = new URL(runtimeConfig.apiBase || "../", document.baseURI);
  const endpoint = new URL("api/contact", apiBase);
  const initialStatus = status.textContent;

  function setStatus(message, state = "") {
    status.textContent = message;
    status.dataset.state = state;
  }

  submitButton.disabled = false;
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!form.reportValidity()) return;

    submitButton.disabled = true;
    submitButton.setAttribute("aria-busy", "true");
    submitButton.textContent = "Envoi…";
    setStatus("Envoi sécurisé en cours…", "sending");

    try {
      const formData = new FormData(form);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(Object.fromEntries(formData.entries()))
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (result.field) document.querySelector(`[name="${CSS.escape(result.field)}"]`)?.focus();
        throw new Error(result.error || "Le message n’a pas pu être envoyé.");
      }
      form.reset();
      setStatus("Votre message a bien été envoyé.", "success");
    } catch (error) {
      setStatus(error.message || "Le message n’a pas pu être envoyé. Merci de réessayer.", "error");
    } finally {
      submitButton.disabled = false;
      submitButton.removeAttribute("aria-busy");
      submitButton.textContent = "Envoyer";
    }
  });

  form.addEventListener("input", () => {
    if (status.dataset.state === "error") setStatus(initialStatus);
  });
})();
