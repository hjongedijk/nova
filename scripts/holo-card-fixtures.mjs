/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
// Mock (non-personal) data for the holographic cards. Shaped exactly like the scenes the API's
// inline-card mapper produces; used by scripts/check-holo.mjs to screenshot and check every card.
const view = () => ({
  highlights: [],
  annotations: [],
  hiddenLayers: [],
  rotations: [],
});
const base = (id, title, kind, extra) => ({
  schema: 1,
  id,
  title,
  kind,
  providerId: "inline",
  typeId: "mock",
  revision: 1,
  updatedAt: "2026-10-16T12:32:00.000Z",
  layers: [],
  modes: ["holographic"],
  defaultMode: "holographic",
  notes: [],
  actions: [],
  view: view(),
  ...extra,
});

export const NOW = "2026-10-16T12:32:00.000Z"; // 14:32 in Amsterdam (CEST)

export const weather = () => {
  const hours = [
    ["14:00", 15, 10, "half bewolkt", "partly"],
    ["15:00", 15.5, 20, "bewolkt", "cloud"],
    ["16:00", 15, 45, "lichte regen", "drizzle"],
    ["17:00", 14, 70, "regen", "rain"],
    ["18:00", 13, 80, "regen", "rain"],
    ["19:00", 12, 55, "lichte regen", "drizzle"],
    ["20:00", 11, 30, "bewolkt", "cloud"],
    ["21:00", 10.5, 15, "half bewolkt", "night-cloud"],
    ["22:00", 10, 5, "helder", "night"],
    ["23:00", 9, 0, "helder", "night"],
    ["00:00", 8.5, 0, "helder", "night"],
    ["01:00", 8, 0, "helder", "night"],
  ].map(([label, temperature, rainPercent, condition, glyph]) => ({
    label,
    temperature,
    rainPercent,
    condition,
    glyph,
  }));
  const days = [
    ["vandaag", 8, 16, 4.2, 80, "regen", "rain"],
    ["morgen", 7, 14, 0.4, 25, "half bewolkt", "partly"],
    ["zaterdag", 6, 12, 0, 5, "helder", "clear"],
    ["zondag", 5, 11, 1.8, 40, "lichte regen", "drizzle"],
    ["maandag", 7, 13, 9.5, 90, "zware regen", "rain"],
    ["dinsdag", 9, 15, 0, 10, "bewolkt", "cloud"],
  ].map(([label, min, max, rainMm, rainPercent, condition, glyph]) => ({
    label,
    min,
    max,
    rainMm,
    rainPercent,
    condition,
    glyph,
  }));
  return base("inline-weather01", "Weer in Utrecht", "weather", {
    weather: {
      place: "Utrecht",
      now: {
        temperature: 15,
        feelsLike: 13,
        condition: "half bewolkt",
        glyph: "partly",
        windKmh: 18,
        humidityPercent: 72,
      },
      hours,
      days,
    },
    summary:
      "Weer in Utrecht: nu 15° en half bewolkt. Vandaag 8° tot 16°, 80% kans op regen. 6 dagen vooruit.",
    notes: ["Bron: Open-Meteo."],
  });
};

export const gauges = () => {
  const g = (id, label, value, detail, extra = {}) => ({
    id,
    label,
    value,
    unit: "%",
    min: 0,
    max: 100,
    warnAt: 75,
    critAt: 90,
    status:
      value === null
        ? "unknown"
        : value >= 90
          ? "critical"
          : value >= 75
            ? "warning"
            : "ok",
    ...(detail ? { detail } : {}),
    ...extra,
  });
  return base("inline-gauges001", "Proxmox-nodes", "gauges", {
    gauges: [
      g("cpu:pve1", "pve1 CPU", 34, "16 kernen"),
      g("mem:pve1", "pve1 geheugen", 78.4, "50,2 van 64 GB"),
      g("cpu:pve2", "pve2 CPU", 96.5, "8 kernen"),
      g("mem:pve2", "pve2 geheugen", 61, "19,5 van 32 GB"),
      g("disk:local", "local (pve1)", 91, "910 van 1000 GB", {
        warnAt: 80,
      }),
      g("temp", "Buitensensor", null, "Sensor geeft geen waarde"),
    ],
    summary:
      "Proxmox-nodes: pve1 CPU 34%, pve1 RAM 78,4%, pve2 CPU 96,5%, buitensensor onbekend. Let op: pve1 geheugen, pve2 CPU.",
    notes: ["Een onbekende waarde is niet gemeten; ze is nooit groen."],
  });
};

export const timeline = () =>
  base("inline-timeline01", "Agenda vandaag", "timeline", {
    timeline: {
      start: "2026-10-15T22:00:00.000Z",
      end: "2026-10-16T22:00:00.000Z",
      now: NOW,
      timeZone: "Europe/Amsterdam",
      items: [
        {
          id: "e0",
          label: "Schoolvakantie",
          start: "2026-10-15T22:00:00.000Z",
          end: "2026-10-16T22:00:00.000Z",
          kind: "event",
          allDay: true,
        },
        {
          id: "e1",
          label: "Stand-up",
          start: "2026-10-16T07:30:00.000Z",
          end: "2026-10-16T07:45:00.000Z",
          kind: "event",
        },
        {
          id: "e2",
          label: "Lunch met Sanne",
          start: "2026-10-16T10:30:00.000Z",
          end: "2026-10-16T11:30:00.000Z",
          kind: "event",
        },
        {
          id: "e3",
          label: "Tandarts",
          start: "2026-10-16T12:00:00.000Z",
          end: "2026-10-16T13:00:00.000Z",
          kind: "event",
        },
        {
          id: "e4",
          label: "Review ontwerp",
          start: "2026-10-16T13:30:00.000Z",
          end: "2026-10-16T14:30:00.000Z",
          kind: "event",
        },
        {
          id: "e5",
          label: "Sporten",
          start: "2026-10-16T16:00:00.000Z",
          end: "2026-10-16T17:30:00.000Z",
          kind: "event",
        },
        {
          id: "t1",
          label: "Pasta",
          start: NOW,
          end: "2026-10-16T12:41:00.000Z",
          kind: "timer",
        },
      ],
    },
    summary:
      "Agenda vandaag: 5 afspraken, eerstvolgende om 15:30: Review ontwerp.",
  });

export const timers = () =>
  base("inline-timers0001", "Timers", "timeline", {
    timeline: {
      start: NOW,
      end: "2026-10-16T13:20:00.000Z",
      now: NOW,
      timeZone: "Europe/Amsterdam",
      items: [
        {
          id: "t1",
          label: "Pasta",
          start: NOW,
          end: "2026-10-16T12:41:00.000Z",
          kind: "timer",
        },
        {
          id: "t2",
          label: "Was uit de droger",
          start: NOW,
          end: "2026-10-16T13:02:00.000Z",
          kind: "timer",
        },
        {
          id: "t3",
          label: "Bel de huisarts",
          start: NOW,
          end: "2026-10-16T13:20:00.000Z",
          kind: "timer",
        },
      ],
    },
    summary: "3 timers: Pasta nog 9 min, Was uit de droger nog 30 min.",
  });

export const tiles = () => {
  const t = (id, label, state, status, group, detail) => ({
    id,
    label,
    state,
    status,
    group,
    ...(detail ? { detail } : {}),
  });
  return base("inline-tiles00001", "Apparaten in huis", "tiles", {
    tileGroups: [
      { id: "area:woonkamer", label: "Woonkamer" },
      { id: "area:keuken", label: "Keuken" },
      { id: "area:overig", label: "Overig" },
    ],
    tiles: [
      t("light.bank", "Bankverlichting", "Aan", "active", "area:woonkamer"),
      t("light.tafel", "Tafellamp", "Uit", "off", "area:woonkamer"),
      t(
        "climate.woon",
        "Thermostaat",
        "21,5 °C",
        "ok",
        "area:woonkamer",
        "doel 20 °C",
      ),
      t("media.tv", "Televisie", "Speelt", "active", "area:woonkamer"),
      t("light.keuken", "Keukenlamp", "Aan", "active", "area:keuken"),
      t(
        "sensor.koelkast",
        "Koelkast",
        "7,8 °C",
        "warning",
        "area:keuken",
        "boven de 7 °C",
      ),
      t(
        "sensor.vaat",
        "Vaatwasser",
        "Niet beschikbaar",
        "unknown",
        "area:keuken",
      ),
      t("lock.voor", "Voordeur", "Op slot", "ok", "area:overig"),
      t(
        "sensor.batt",
        "Rookmelder zolder",
        "4%",
        "critical",
        "area:overig",
        "batterij bijna leeg",
      ),
    ],
    summary:
      "Apparaten in huis: 9 onderdelen, 5 in orde of actief, 1 let op, 1 probleem, 1 uit, 1 onbekend.",
  });
};

export const rack = () => {
  const guest = (n, name, state, status, node, detail) => ({
    id: `guest:${n}`,
    label: name,
    state,
    status,
    group: `node:${node}`,
    ...(detail ? { detail } : {}),
  });
  return base("inline-rack000001", "Proxmox: VM's en containers", "tiles", {
    tileGroups: [
      { id: "node:pve1", label: "pve1", summary: "4 van 5 draaien" },
      { id: "node:pve2", label: "pve2", summary: "2 van 3 draaien" },
    ],
    tiles: [
      guest(100, "homeassistant", "Draait", "ok", "pve1", "CPU 4% · RAM 41%"),
      guest(101, "nova", "Draait", "ok", "pve1", "CPU 12% · RAM 63%"),
      guest(102, "dns", "Draait", "ok", "pve1", "CPU 1% · RAM 22%"),
      guest(103, "media", "Draait", "ok", "pve1", "CPU 38% · RAM 70%"),
      guest(104, "testbak", "Gestopt", "off", "pve1"),
      guest(200, "backup", "Draait", "ok", "pve2", "CPU 2% · RAM 18%"),
      guest(201, "gitea", "Draait", "ok", "pve2", "CPU 6% · RAM 44%"),
      guest(202, "oude-vm", "Onbekend", "unknown", "pve2"),
    ],
    summary: "Proxmox: 8 gasten, 6 draaien, 1 gestopt, 1 onbekend.",
  });
};

export const series = () => {
  const labels = Array.from(
    { length: 24 },
    (_, i) => `${String(i).padStart(2, "0")}:00`,
  );
  const kw = [
    0.3, 0.3, 0.28, 0.27, 0.3, 0.45, 0.9, 1.4, 0.8, 0.6, 0.5, 0.55, 0.9, 0.7,
    0.6, 0.65, 0.9, 1.8, 2.4, 2.1, 1.5, 1.1, 0.7, 0.4,
  ];
  return base("inline-series0001", "Stroomverbruik vandaag", "series", {
    chart: {
      type: "bar",
      unit: "kW",
      series: [
        {
          label: "Verbruik",
          points: labels.map((label, i) => ({
            label,
            value: i === 14 ? null : kw[i],
          })),
        },
      ],
    },
    summary: "Stroomverbruik vandaag: gemiddeld 0,9 kW, piek 2,4 kW om 18:00.",
  });
};

export const area = () => {
  const labels = ["ma", "di", "wo", "do", "vr", "za", "zo"];
  const a = [12.1, 11.4, 13.8, 10.2, 14.9, 18.6, 16.2];
  const b = [4.2, 3.9, 4.8, 3.5, 5.1, 6.9, 6.0];
  return base("inline-area000001", "Energie deze week", "series", {
    chart: {
      type: "area",
      unit: "kWh",
      series: [
        {
          label: "Verbruik",
          points: labels.map((label, i) => ({ label, value: a[i] })),
        },
        {
          label: "Opwek",
          points: labels.map((label, i) => ({ label, value: b[i] })),
        },
      ],
    },
    summary: "Energie deze week: verbruik 97 kWh, opwek 34 kWh.",
  });
};

export const ALL = {
  weather,
  gauges,
  timeline,
  timers,
  tiles,
  rack,
  series,
  area,
};
