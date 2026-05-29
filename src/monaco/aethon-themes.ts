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
    fg: "#e7e1d2",
    bg: "#121113",
    line: "#1a181b",
    selection: "#ff7a292a",
    selectionHighlight: "#ff7a291a",
    cursor: "#ff7a29",
    whitespace: "#2c2930",
    guide: "#2c2930",
    guideActive: "#5a5651",
    widget: "#1a181b",
    widgetBorder: "#2c2930",
    input: "#211e22",
    scrollbar: "#312d34cc",
    scrollbarHover: "#5a565180",
    scrollbarActive: "#5a5651",
    syntax: {
      text: "#e7e1d2",
      comment: "#7c7669",
      punctuation: "#b8b1a1",
      keyword: "#ff7a29",
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
    fg: "#1c1b19",
    bg: "#ffffff",
    line: "#f7f6f3",
    selection: "#b8400a2e",
    selectionHighlight: "#b8400a1a",
    cursor: "#b8400a",
    whitespace: "#e2dfd8",
    guide: "#e2dfd8",
    guideActive: "#a39e93",
    widget: "#ffffff",
    widgetBorder: "#e2dfd8",
    input: "#f0eeea",
    scrollbar: "#d4d0c8cc",
    scrollbarHover: "#b4afa380",
    scrollbarActive: "#b4afa3",
    syntax: {
      text: "#1c1b19",
      comment: "#8a877e",
      punctuation: "#54514a",
      keyword: "#b8400a",
      string: "#2f7d4f",
      number: "#8a5a00",
      symbol: "#2f5793",
      operator: "#6c6960",
      function: "#6b4e8a",
      variable: "#b0432a",
    },
  },
  aether: {
    id: "aether",
    type: "dark",
    fg: "#d8dde9",
    bg: "#0b0e16",
    line: "#131825",
    selection: "#6fb0ff2a",
    selectionHighlight: "#6fb0ff1a",
    cursor: "#6fb0ff",
    whitespace: "#232b3d",
    guide: "#232b3d",
    guideActive: "#4e5670",
    widget: "#131825",
    widgetBorder: "#232b3d",
    input: "#181e2e",
    scrollbar: "#232b3dcc",
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
    fg: "#f1e5e7",
    bg: "#181313",
    line: "#332a2a",
    selection: "#ffd47933",
    selectionHighlight: "#ffd4791a",
    cursor: "#ffd479",
    whitespace: "#4b3f3f",
    guide: "#4b3f3f",
    guideActive: "#7a6c61",
    widget: "#3f3434",
    widgetBorder: "#4b3f3f",
    input: "#332a2a",
    scrollbar: "#4b3f3fcc",
    scrollbarHover: "#7a6c6180",
    scrollbarActive: "#7a6c61",
    syntax: {
      text: "#f1e5e7",
      comment: "#907e80",
      punctuation: "#b0a4a6",
      keyword: "#ffd479",
      string: "#b3e07d",
      number: "#f38d70",
      symbol: "#b3b4f0",
      operator: "#d0c4c6",
      function: "#8fe0d2",
      variable: "#fd6883",
    },
  },
  daylight: {
    id: "daylight",
    type: "light",
    fg: "#3a2c14",
    bg: "#fff6e1",
    line: "#fdeed1",
    selection: "#bf541033",
    selectionHighlight: "#bf54101a",
    cursor: "#bf5410",
    whitespace: "#e6cd9e",
    guide: "#e6cd9e",
    guideActive: "#9a8460",
    widget: "#fff6e1",
    widgetBorder: "#e6cd9e",
    input: "#f6ddb4",
    scrollbar: "#ddc596cc",
    scrollbarHover: "#bda06a80",
    scrollbarActive: "#bda06a",
    syntax: {
      text: "#3a2c14",
      comment: "#927c52",
      punctuation: "#5b5040",
      keyword: "#b34a0a",
      string: "#4e6b1f",
      number: "#8a5800",
      symbol: "#7a5210",
      operator: "#6c5e48",
      function: "#9a5a00",
      variable: "#a8431a",
    },
  },
  mist: {
    id: "mist",
    type: "light",
    fg: "#16202b",
    bg: "#fafcfe",
    line: "#f1f5f9",
    selection: "#0f766e33",
    selectionHighlight: "#0f766e1a",
    cursor: "#0f766e",
    whitespace: "#ccd6e1",
    guide: "#ccd6e1",
    guideActive: "#8390a8",
    widget: "#fafcfe",
    widgetBorder: "#ccd6e1",
    input: "#e0e8f0",
    scrollbar: "#c2cedbcc",
    scrollbarHover: "#93a3b680",
    scrollbarActive: "#93a3b6",
    syntax: {
      text: "#16202b",
      comment: "#7a8696",
      punctuation: "#4b5366",
      keyword: "#0f6d6a",
      string: "#2a7c5a",
      number: "#8c5810",
      symbol: "#2c5694",
      operator: "#4c5a6e",
      function: "#1f6a86",
      variable: "#a8423e",
    },
  },
  nocturne: {
    id: "nocturne",
    type: "dark",
    fg: "#eef1fc",
    bg: "#070a12",
    line: "#0f1320",
    selection: "#2ef2f233",
    selectionHighlight: "#2ef2f21a",
    cursor: "#2ef2f2",
    whitespace: "#202842",
    guide: "#202842",
    guideActive: "#45527a",
    widget: "#161b2b",
    widgetBorder: "#202842",
    input: "#11162a",
    scrollbar: "#202842cc",
    scrollbarHover: "#2e385880",
    scrollbarActive: "#2e3858",
    syntax: {
      text: "#eef1fc",
      comment: "#727890",
      punctuation: "#95a0bd",
      keyword: "#2ef2f2",
      string: "#d4ff5e",
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
