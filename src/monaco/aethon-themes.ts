import type { ThemeRegistrationResolved } from "shiki";

export const AETHON_THEME_IDS = [
  "ember",
  "paper",
  "aether",
  "brink",
  "daylight",
  "mist",
  "nocturne",
] as const;

export type AethonThemeId = (typeof AETHON_THEME_IDS)[number];

interface AethonThemePalette {
  id: AethonThemeId;
  type: "dark" | "light";
  fg: string;
  bg: string;
  line: string;
  selection: string;
  selectionHighlight: string;
  cursor: string;
  whitespace: string;
  guide: string;
  guideActive: string;
  widget: string;
  widgetBorder: string;
  input: string;
  scrollbar: string;
  scrollbarHover: string;
  scrollbarActive: string;
  syntax: {
    text: string;
    comment: string;
    punctuation: string;
    keyword: string;
    string: string;
    number: string;
    symbol: string;
    operator: string;
    function: string;
    variable: string;
  };
}

const PALETTES: Record<AethonThemeId, AethonThemePalette> = {
  ember: {
    id: "ember",
    type: "dark",
    fg: "#e7e5e2",
    bg: "#161618",
    line: "#1f1e21",
    selection: "#ff6a182a",
    selectionHighlight: "#ff6a181a",
    cursor: "#ff6a18",
    whitespace: "#2c2a2d",
    guide: "#2c2a2d",
    guideActive: "#5a5651",
    widget: "#1f1e21",
    widgetBorder: "#2c2a2d",
    input: "#1f1e21",
    scrollbar: "#2c2a2dcc",
    scrollbarHover: "#5a565180",
    scrollbarActive: "#5a5651",
    syntax: {
      text: "#e7e1d2",
      comment: "#7c7669",
      punctuation: "#b8b1a1",
      keyword: "#ff6a18",
      string: "#c8d96a",
      number: "#ffb968",
      symbol: "#ffd28a",
      operator: "#c8c1ad",
      function: "#f5cf7d",
      variable: "#ff9b6a",
    },
  },
  paper: {
    id: "paper",
    type: "light",
    fg: "#1f1f23",
    bg: "#fef3e2",
    line: "#fffaee",
    selection: "#b9400033",
    selectionHighlight: "#b940001a",
    cursor: "#b94000",
    whitespace: "#e3d8be",
    guide: "#e3d8be",
    guideActive: "#a39a87",
    widget: "#fffaee",
    widgetBorder: "#e3d8be",
    input: "#f5e8d0",
    scrollbar: "#d8cdb3cc",
    scrollbarHover: "#b8ad9480",
    scrollbarActive: "#b8ad94",
    syntax: {
      text: "#2b261f",
      comment: "#8a8170",
      punctuation: "#5b5446",
      keyword: "#b94000",
      string: "#2f6b1f",
      number: "#875000",
      symbol: "#5a3b00",
      operator: "#6c6353",
      function: "#7c4a00",
      variable: "#9a3b1f",
    },
  },
  aether: {
    id: "aether",
    type: "dark",
    fg: "#d6dceb",
    bg: "#0e1118",
    line: "#161a25",
    selection: "#7aa2f72a",
    selectionHighlight: "#7aa2f71a",
    cursor: "#7aa2f7",
    whitespace: "#252b3a",
    guide: "#252b3a",
    guideActive: "#4e5670",
    widget: "#161a25",
    widgetBorder: "#252b3a",
    input: "#161a25",
    scrollbar: "#252b3acc",
    scrollbarHover: "#4e567080",
    scrollbarActive: "#4e5670",
    syntax: {
      text: "#d8dde9",
      comment: "#71788c",
      punctuation: "#97a0b4",
      keyword: "#ff8a3d",
      string: "#7ad6a3",
      number: "#ffc079",
      symbol: "#ffd9a8",
      operator: "#aab2c4",
      function: "#f0c87b",
      variable: "#ff9d6a",
    },
  },
  brink: {
    id: "brink",
    type: "dark",
    fg: "#d9c8b4",
    bg: "#2c2525",
    line: "#3a3030",
    selection: "#f9cc6c33",
    selectionHighlight: "#f9cc6c1a",
    cursor: "#f9cc6c",
    whitespace: "#504646",
    guide: "#504646",
    guideActive: "#7a6c61",
    widget: "#3a3030",
    widgetBorder: "#504646",
    input: "#3a3030",
    scrollbar: "#504646cc",
    scrollbarHover: "#7a6c6180",
    scrollbarActive: "#7a6c61",
    syntax: {
      text: "#f1e5e7",
      comment: "#907e80",
      punctuation: "#b0a4a6",
      keyword: "#f9cc6c",
      string: "#adda78",
      number: "#f38d70",
      symbol: "#a8a9eb",
      operator: "#d0c4c6",
      function: "#85dacc",
      variable: "#fd6883",
    },
  },
  daylight: {
    id: "daylight",
    type: "light",
    fg: "#2a2218",
    bg: "#f9e9c8",
    line: "#fff8e8",
    selection: "#b54a1f33",
    selectionHighlight: "#b54a1f1a",
    cursor: "#b54a1f",
    whitespace: "#d9c19a",
    guide: "#d9c19a",
    guideActive: "#9a8460",
    widget: "#fff8e8",
    widgetBorder: "#d9c19a",
    input: "#f4dfb6",
    scrollbar: "#d1bb8fcc",
    scrollbarHover: "#b0997180",
    scrollbarActive: "#b09971",
    syntax: {
      text: "#2a2218",
      comment: "#8a7d62",
      punctuation: "#5b5040",
      keyword: "#a83c0a",
      string: "#2f6b1f",
      number: "#875000",
      symbol: "#5a3b00",
      operator: "#6c5e48",
      function: "#7c4a00",
      variable: "#9a3b1f",
    },
  },
  mist: {
    id: "mist",
    type: "light",
    fg: "#1c2530",
    bg: "#eef2f6",
    line: "#fbfcfe",
    selection: "#1f7d5e33",
    selectionHighlight: "#1f7d5e1a",
    cursor: "#1f7d5e",
    whitespace: "#d0d8e2",
    guide: "#d0d8e2",
    guideActive: "#8390a8",
    widget: "#fbfcfe",
    widgetBorder: "#d0d8e2",
    input: "#e3e9f0",
    scrollbar: "#c5cedbcc",
    scrollbarHover: "#9aa4b880",
    scrollbarActive: "#9aa4b8",
    syntax: {
      text: "#1c2530",
      comment: "#7a8294",
      punctuation: "#4b5366",
      keyword: "#1a6488",
      string: "#2a7c5a",
      number: "#8c5810",
      symbol: "#6646a8",
      operator: "#4c5a6e",
      function: "#1f5a8e",
      variable: "#a8423e",
    },
  },
  nocturne: {
    id: "nocturne",
    type: "dark",
    fg: "#eaeefa",
    bg: "#0a0d14",
    line: "#11151f",
    selection: "#28e0e033",
    selectionHighlight: "#28e0e01a",
    cursor: "#28e0e0",
    whitespace: "#232a3c",
    guide: "#232a3c",
    guideActive: "#4a5475",
    widget: "#181c28",
    widgetBorder: "#232a3c",
    input: "#14182b",
    scrollbar: "#232a3ccc",
    scrollbarHover: "#31395280",
    scrollbarActive: "#313952",
    syntax: {
      text: "#eaeefa",
      comment: "#727890",
      punctuation: "#95a0bd",
      keyword: "#28e0e0",
      string: "#c8ff5a",
      number: "#ffce4e",
      symbol: "#ff5cb6",
      operator: "#b0b8d0",
      function: "#7afff0",
      variable: "#ff8acf",
    },
  },
};

function rawTheme(p: AethonThemePalette): ThemeRegistrationResolved {
  const s = p.syntax;
  return {
    name: `aethon-${p.id}`,
    type: p.type,
    fg: p.fg,
    bg: p.bg,
    colors: {
      "editor.background": p.bg,
      "editor.foreground": p.fg,
      "editorLineNumber.foreground": p.guideActive,
      "editorLineNumber.activeForeground": p.fg,
      "editor.lineHighlightBackground": p.line,
      "editor.selectionBackground": p.selection,
      "editor.inactiveSelectionBackground": p.selectionHighlight,
      "editor.selectionHighlightBackground": p.selectionHighlight,
      "editorCursor.foreground": p.cursor,
      "editorWhitespace.foreground": p.whitespace,
      "editorIndentGuide.background1": p.guide,
      "editorIndentGuide.activeBackground1": p.guideActive,
      "editorGutter.background": p.bg,
      "editorWidget.background": p.widget,
      "editorWidget.border": p.widgetBorder,
      "editorWidget.foreground": p.fg,
      "editorSuggestWidget.background": p.widget,
      "editorSuggestWidget.border": p.widgetBorder,
      "editorSuggestWidget.foreground": p.fg,
      "editorSuggestWidget.selectedBackground": p.selectionHighlight,
      "input.background": p.input,
      "input.foreground": p.fg,
      "input.border": p.widgetBorder,
      "focusBorder": p.cursor,
      "scrollbarSlider.background": p.scrollbar,
      "scrollbarSlider.hoverBackground": p.scrollbarHover,
      "scrollbarSlider.activeBackground": p.scrollbarActive,
    },
    settings: [
      { settings: { foreground: s.text, background: p.bg } },
      {
        scope: ["comment", "punctuation.definition.comment"],
        settings: { foreground: s.comment, fontStyle: "italic" },
      },
      {
        scope: [
          "punctuation",
          "meta.brace",
          "meta.delimiter",
          "punctuation.definition",
        ],
        settings: { foreground: s.punctuation },
      },
      {
        scope: [
          "keyword",
          "storage",
          "storage.type",
          "storage.modifier",
          "support.type.property-name",
        ],
        settings: { foreground: s.keyword },
      },
      {
        scope: [
          "string",
          "markup.inline.raw.string",
          "punctuation.definition.string",
        ],
        settings: { foreground: s.string },
      },
      {
        scope: [
          "constant.numeric",
          "constant.language",
          "constant.character",
          "constant.other",
        ],
        settings: { foreground: s.number },
      },
      {
        scope: [
          "entity.name.type",
          "entity.name.class",
          "entity.name.namespace",
          "support.class",
          "support.type",
        ],
        settings: { foreground: s.symbol },
      },
      {
        scope: [
          "keyword.operator",
          "punctuation.separator",
          "punctuation.accessor",
        ],
        settings: { foreground: s.operator },
      },
      {
        scope: [
          "entity.name.function",
          "support.function",
          "meta.function-call",
          "variable.function",
        ],
        settings: { foreground: s.function },
      },
      {
        scope: [
          "variable",
          "variable.parameter",
          "support.variable",
          "entity.name.variable",
        ],
        settings: { foreground: s.variable },
      },
      {
        scope: ["markup.heading", "entity.name.section"],
        settings: { foreground: s.keyword, fontStyle: "bold" },
      },
      {
        scope: ["markup.bold"],
        settings: { foreground: s.text, fontStyle: "bold" },
      },
      {
        scope: ["markup.italic"],
        settings: { foreground: s.text, fontStyle: "italic" },
      },
      {
        scope: ["markup.deleted", "diff.deleted"],
        settings: { foreground: s.variable },
      },
      {
        scope: ["markup.inserted", "diff.inserted"],
        settings: { foreground: s.string },
      },
    ],
  };
}

export const AETHON_SHIKI_THEMES = AETHON_THEME_IDS.map((id) =>
  rawTheme(PALETTES[id]),
);
