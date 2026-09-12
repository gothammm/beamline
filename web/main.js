// beamline landing interactions. Vanilla JS, no deps.
// ponytail: 2D canvas instead of Three.js — same beam-grid read, zero bundle.

(() => {
  "use strict";

  /* Scroll reveal: subtle, once, ease-out via CSS */
  const sections = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.12 }
    );
    sections.forEach((s) => io.observe(s));
  } else {
    sections.forEach((s) => s.classList.add("in"));
  }

  /* Copy buttons: clipboard + icon cross-fade (CSS handles the animation) */
  document.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const text = btn.getAttribute("data-copy") || "";
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.append(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      btn.classList.add("is-done");
      const label = btn.getAttribute("aria-label");
      if (label && !btn.dataset.label) btn.setAttribute("aria-label", "Copied");
      setTimeout(() => {
        btn.classList.remove("is-done");
        if (label && !btn.dataset.label) btn.setAttribute("aria-label", label);
      }, 1400);
    });
  });

  /* Install widget tabs: swap the command, keep one copy button */
  const widget = document.querySelector(".install-widget");
  if (widget) {
    const cmd = widget.querySelector(".install-cmd code");
    const copy = widget.querySelector(".copy-btn");
    const tabs = [...widget.querySelectorAll(".install-tabs button")];
    tabs.forEach((tab) =>
      tab.addEventListener("click", () => {
        tabs.forEach((t) => t.setAttribute("aria-pressed", String(t === tab)));
        if (cmd) cmd.textContent = tab.dataset.cmd || "";
        if (copy) copy.setAttribute("data-copy", tab.dataset.cmd || "");
      })
    );
  }

  /* Theme toggle: suppress transitions for the swap, force reflow, restore */
  const toggle = document.getElementById("theme-toggle");
  const root = document.documentElement;
  const stored = (() => {
    try {
      return localStorage.getItem("beamline-theme");
    } catch {
      return null;
    }
  })();
  if (stored === "light" || stored === "dark") {
    root.dataset.theme = stored;
    toggle?.setAttribute("aria-pressed", String(stored === "light"));
  }
  toggle?.addEventListener("click", () => {
    const style = document.createElement("style");
    style.append(document.createTextNode("*,*::before,*::after{transition:none !important}"));
    document.head.append(style);
    root.dataset.theme = root.dataset.theme === "light" ? "dark" : "light";
    toggle.setAttribute("aria-pressed", String(root.dataset.theme === "light"));
    try {
      localStorage.setItem("beamline-theme", root.dataset.theme);
    } catch {
      /* private mode — theme just won't persist */
    }
    void document.body.offsetHeight; // force reflow while override applies
    requestAnimationFrame(() => requestAnimationFrame(() => style.remove()));
  });

  /* Signal field: drifting particles, faint links, accent pulses traveling
     between nodes. Same visual contract as ThreeUI's signal-particles
     preset (dark field, connective pulses, pixelRatio <= 2, zero assets),
     drawn natively so the page ships no WebGL/React deps for a background. */
  const canvas = document.getElementById("beams");
  if (!canvas) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  let w = 0;
  let h = 0;
  let nodes = [];
  let pulses = [];
  let running = true;
  const DPR = Math.min(window.devicePixelRatio || 1, 2);

  const accent = () =>
    getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#5eead4";

  function spawnPulse() {
    if (nodes.length < 2) return null;
    const max = 150;
    for (let tries = 0; tries < 8; tries++) {
      const a = nodes[(Math.random() * nodes.length) | 0];
      let best = null;
      let bestD = max;
      for (const b of nodes) {
        if (b === a) continue;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d < bestD) {
          bestD = d;
          best = b;
        }
      }
      if (best) return { a, b: best, t: 0, speed: 0.008 + Math.random() * 0.012 };
    }
    return null;
  }

  function resize() {
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.floor(w * DPR);
    canvas.height = Math.floor(h * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    const count = Math.min(64, Math.floor((w * h) / 26000));
    nodes = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.22,
      vy: (Math.random() - 0.5) * 0.22,
      r: 1 + Math.random() * 1.4,
    }));
    pulses = [];
    for (let k = 0; k < 6; k++) pulses.push(spawnPulse());
  }

  function frame() {
    if (!running) return;
    ctx.clearRect(0, 0, w, h);
    const color = accent();

    // links
    const max = 150;
    ctx.lineWidth = 1;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d = Math.hypot(dx, dy);
        if (d < max) {
          ctx.strokeStyle = `rgba(127,127,140,${((1 - d / max) * 0.28).toFixed(3)})`;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }

    // nodes
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.7;
    for (const n of nodes) {
      n.x += n.vx;
      n.y += n.vy;
      if (n.x < -8) n.x = w + 8;
      if (n.x > w + 8) n.x = -8;
      if (n.y < -8) n.y = h + 8;
      if (n.y > h + 8) n.y = -8;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // signal pulses: bright dots riding random links, fading in and out
    ctx.fillStyle = color;
    for (let i = 0; i < pulses.length; i++) {
      let p = pulses[i];
      if (!p) {
        p = spawnPulse();
        pulses[i] = p;
        if (!p) continue;
      }
      p.t += p.speed;
      if (p.t >= 1) {
        pulses[i] = spawnPulse();
        continue;
      }
      const x = p.a.x + (p.b.x - p.a.x) * p.t;
      const y = p.a.y + (p.b.y - p.a.y) * p.t;
      const a = Math.sin(Math.PI * p.t) * 0.9;
      ctx.globalAlpha = a * 0.15;
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = a * 0.45;
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = a;
      ctx.beginPath();
      ctx.arc(x, y, 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // hero glow beam — one diagonal wash, cheap gradient
    const g = ctx.createLinearGradient(0, 0, w, h * 0.4);
    g.addColorStop(0, "rgba(94,234,212,0.05)");
    g.addColorStop(0.5, "rgba(94,234,212,0.0)");
    g.addColorStop(1, "rgba(94,234,212,0.04)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    requestAnimationFrame(frame);
  }

  // pause off-screen / hidden tab — no wasted frames
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      running = false;
    } else if (!running) {
      running = true;
      requestAnimationFrame(frame);
    }
  });
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !running && !document.hidden) {
        running = true;
        requestAnimationFrame(frame);
      } else if (!e.isIntersecting) {
        running = false;
      }
    }).observe(canvas);
  }

  let t;
  window.addEventListener("resize", () => {
    clearTimeout(t);
    t = setTimeout(resize, 150);
  });

  resize();
  requestAnimationFrame(frame);
})();
