
/* RED MUSIC: reliable top-right profile navigation */
(function () {
  function openProfile() {
    const buttons = document.querySelectorAll("aside nav button");
    for (const btn of buttons) {
      const label = (btn.textContent || "").trim().toLowerCase();
      if (label.includes("профиль") || label.includes("profile")) {
        if (typeof window.show === "function") window.show("profile", btn);
        else btn.click();
        return;
      }
    }
  }

  function bindTopProfile() {
    const top = document.querySelector(".user-top");
    if (!top || top.dataset.redProfileBound === "1") return;
    top.dataset.redProfileBound = "1";
    top.style.cursor = "pointer";
    top.setAttribute("role", "button");
    top.setAttribute("tabindex", "0");
    top.setAttribute("title", "Открыть профиль");

    top.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      openProfile();
    });

    top.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openProfile();
      }
    });
  }

  document.addEventListener("DOMContentLoaded", bindTopProfile, { once: true });
  window.addEventListener("load", bindTopProfile);
  setTimeout(bindTopProfile, 300);
})();
