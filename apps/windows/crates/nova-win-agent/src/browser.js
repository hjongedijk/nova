// Executed only inside NOVA's isolated CDP world. Nodes never identified by page attributes.
(() => {
  let nodes = [];
  const text = (value, max = 90) =>
    String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max);
  const describe = (el) => {
    const tag = el.tagName.toLowerCase();
    const editable =
      el.isContentEditable || ["input", "textarea", "select"].includes(tag);
    const button =
      tag === "input" && ["submit", "reset", "button"].includes(el.type);
    const label =
      el.getAttribute("aria-label") ||
      [...(el.labels || [])].map((label) => label.innerText).join(" ") ||
      el.placeholder ||
      el.title ||
      (button ? el.value : !editable ? el.innerText : "");
    return {
      label: text(label),
      tag,
      type: (el.type || "").toLowerCase(),
      href: el.href ? String(el.href) : "",
      hint: [el.name, el.id, el.autocomplete, el.placeholder].join(" "),
      editable: el.isContentEditable,
    };
  };
  globalThis.novaBrowser = (action, args) => {
    if (action === "clear") {
      nodes = [];
      return true;
    }
    if (action === "read") {
      nodes = [
        ...document.querySelectorAll(
          "a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=tab],[contenteditable=true]",
        ),
      ]
        .filter((el) => {
          const r = el.getBoundingClientRect(),
            s = getComputedStyle(el);
          return (
            r.width > 1 &&
            r.height > 1 &&
            s.visibility !== "hidden" &&
            s.display !== "none" &&
            s.opacity !== "0"
          );
        })
        .sort((a, b) => {
          const ar = a.getBoundingClientRect(),
            br = b.getBoundingClientRect();
          return (
            Number(br.bottom > 0 && br.top < innerHeight) -
              Number(ar.bottom > 0 && ar.top < innerHeight) || ar.top - br.top
          );
        })
        .slice(0, 200);
      return {
        text: (document.body?.innerText || "").slice(0, 40000),
        elements: nodes.map((el, i) => {
          const r = el.getBoundingClientRect();
          const d = describe(el);
          return {
            id: i + 1,
            tag: d.tag,
            type: d.type,
            label: d.label,
            href: el.href ? String(el.href).slice(0, 2000) : undefined,
            inView: r.bottom > 0 && r.top < innerHeight,
          };
        }),
        scroll: {
          y: Math.round(scrollY),
          height: document.documentElement.scrollHeight,
          view: innerHeight,
        },
      };
    }
    if (action === "scroll") {
      const amount = args.amount;
      if (args.direction === "top") scrollTo(0, 0);
      else if (args.direction === "bottom")
        scrollTo(0, document.documentElement.scrollHeight);
      else scrollBy(0, args.direction === "up" ? -amount : amount);
      nodes = [];
      return {
        y: Math.round(scrollY),
        height: document.documentElement.scrollHeight,
        view: innerHeight,
      };
    }
    const el = nodes[args.id - 1];
    if (!el || !el.isConnected || el.ownerDocument !== document)
      throw Error("Read the page again; element expired");
    if (action === "probe") {
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect(),
        x = r.left + r.width / 2,
        y = r.top + r.height / 2,
        hit = document.elementFromPoint(x, y);
      return {
        ...describe(el),
        x,
        y,
        clear: !!hit && (hit === el || el.contains(hit)),
      };
    }
    if (action === "focus") {
      el.focus();
      if (typeof el.select === "function") el.select();
      else if (el.isContentEditable) {
        const r = document.createRange();
        r.selectNodeContents(el);
        const s = getSelection();
        s.removeAllRanges();
        s.addRange(r);
      }
      return true;
    }
    throw Error("Unknown browser operation");
  };
})();
