# Changelog

All notable changes to Aethon. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[SemVer](https://semver.org/).

## [0.9.0](https://github.com/utensils/aethon/compare/v0.8.1...v0.9.0) (2026-06-10)

### ⚠ BREAKING CHANGES

- **workspaces:** first-class workspaces — concurrency fixes, instant switching, terminology ([#259](https://github.com/utensils/aethon/issues/259))

### Bug Fixes

- **agent:** read pre-v5 worktree keys in the bridge startup cwd parser ([#261](https://github.com/utensils/aethon/issues/261)) ([cfae7b3](https://github.com/utensils/aethon/commit/cfae7b36cf5a0c6eea5d55520af283262702594e))
- **agent:** skip startup devshell prepare before the frontend handshake ([#262](https://github.com/utensils/aethon/issues/262)) ([d8dedfc](https://github.com/utensils/aethon/commit/d8dedfc660ccc7bf2b028a299e3819b4cfabc5e9))
- **frontend:** address Copilot review findings from [#259](https://github.com/utensils/aethon/issues/259) ([#260](https://github.com/utensils/aethon/issues/260)) ([d16c67d](https://github.com/utensils/aethon/commit/d16c67d94e4b1fab652eaf6250da838bffc9a3c2))
- preserve live agent activity until turn end ([#254](https://github.com/utensils/aethon/issues/254)) ([a2ceef8](https://github.com/utensils/aethon/commit/a2ceef86014f8fe9789798dc8110a66bec030e29))
- run project agents and shells inside devshells ([#256](https://github.com/utensils/aethon/issues/256)) ([81ef244](https://github.com/utensils/aethon/commit/81ef244528b5fcb3f9e206af0906b1053a1d406f))
- stabilize agent sessions and worktree routing ([ecf1aa6](https://github.com/utensils/aethon/commit/ecf1aa6a0278daf7e7d50df0ee0f3daf057ba725))
- **workspaces:** close hidden shell PTYs when their workspace is retired ([#264](https://github.com/utensils/aethon/issues/264)) ([0d3255e](https://github.com/utensils/aethon/commit/0d3255eddbdab2f21342f94a031f7fc718579186))
- **workspaces:** dispose Monaco buffers for editor tabs in dropped buckets ([#265](https://github.com/utensils/aethon/issues/265)) ([6ea69e7](https://github.com/utensils/aethon/commit/6ea69e74852164d70d30c72aae9a3954b3b5440c))
- **workspaces:** retire tabs and sessions when a workspace is removed or externally pruned ([#263](https://github.com/utensils/aethon/issues/263)) ([48aecec](https://github.com/utensils/aethon/commit/48aecece9f798bd76d625fb4b203090cea2b3ade))

### Refactors

- **workspaces:** first-class workspaces — concurrency fixes, instant switching, terminology ([#259](https://github.com/utensils/aethon/issues/259)) ([1e51c4c](https://github.com/utensils/aethon/commit/1e51c4cab58bd6c450cb03b3904a6a0bc373feef))

## [0.8.1](https://github.com/utensils/aethon/compare/v0.8.0...v0.8.1) (2026-06-06)

### Bug Fixes

- **agent:** isolate tab activity hydration ([37422f7](https://github.com/utensils/aethon/commit/37422f7070642a8bfbe65ecfc4b1850da86fbb1d))
- **chat:** rework sticky scroll as a single-owner follow controller ([#250](https://github.com/utensils/aethon/issues/250)) ([04927b4](https://github.com/utensils/aethon/commit/04927b42415e5b6a0461e8aee048b4c0879df08f))
- **chat:** stabilize virtual sticky follow ([579711e](https://github.com/utensils/aethon/commit/579711ec5434a6919a3c604d430c65857ba4e881))
- harden subagent output lifecycle ([ae43834](https://github.com/utensils/aethon/commit/ae4383408efea4e9e5261cc524b6ad55d15de843))
- **sidebar:** open worktree PR badges externally ([e592d89](https://github.com/utensils/aethon/commit/e592d89aac6d95f3ed9ea7d0a1afd699a1e95f73)), closes [#242](https://github.com/utensils/aethon/issues/242)
- **workspaces:** clear stale landing on tab restore ([#249](https://github.com/utensils/aethon/issues/249)) ([7dc0676](https://github.com/utensils/aethon/commit/7dc067677830acb2ef3d1d4e6b0e259e64561366)), closes [#248](https://github.com/utensils/aethon/issues/248)

## [0.8.0](https://github.com/utensils/aethon/compare/v0.7.0...v0.8.0) (2026-06-05)

### Features

- surface worktree PR status and ordering ([#235](https://github.com/utensils/aethon/issues/235)) ([706db32](https://github.com/utensils/aethon/commit/706db3227ca717d5807b17ed871e134ba3092306))
- **tabs:** support drag reorder for sessions and shells ([#224](https://github.com/utensils/aethon/issues/224)) ([f0fb74f](https://github.com/utensils/aethon/commit/f0fb74fc9e13e0a6276d9578ddd790e5c447a435))

### Bug Fixes

- **agent:** expose A2UI runtime tools ([b98d3ca](https://github.com/utensils/aethon/commit/b98d3ca4d212cdec526794ea5b1b3b9e360b80bf))
- **agent:** keep sidebar activity running for live tool cards ([#225](https://github.com/utensils/aethon/issues/225)) ([2644efd](https://github.com/utensils/aethon/commit/2644efd8b2aba2fe434752e18730eacc7adf26df))
- **chat:** keep normal submits queued during running tool calls ([#227](https://github.com/utensils/aethon/issues/227)) ([0c1d9c5](https://github.com/utensils/aethon/commit/0c1d9c5d5844092ad58107a64f0a8cdbf2316708))
- **context:** distinguish live estimates in context meter ([cf6affd](https://github.com/utensils/aethon/commit/cf6affd86e3724600ee6c22f51d8c905b6165c59))
- keep host sessions scoped and closed ([#240](https://github.com/utensils/aethon/issues/240)) ([164a419](https://github.com/utensils/aethon/commit/164a4196f869229dae42e98462c0cf773b91b1f5))
- **settings:** open config.toml in host editor tab ([#237](https://github.com/utensils/aethon/issues/237)) ([1e4d5c8](https://github.com/utensils/aethon/commit/1e4d5c875c66e450416ff7595de4f0eab7292c2c))
- **ui:** refresh worktree PR badges ([43438be](https://github.com/utensils/aethon/commit/43438be511328b79f773759fc1a48a6b20592cc7))
- **update-banner:** honor accent foreground fallbacks ([31c62ff](https://github.com/utensils/aethon/commit/31c62ff1597127259789a446fbaa3717ee109566)), closes [#230](https://github.com/utensils/aethon/issues/230)
- use pointer-driven tab reordering ([4216d6e](https://github.com/utensils/aethon/commit/4216d6efd0ba3962fa02e7224b6cfc7e5d656e2d))
- **worktrees:** remove worktrees optimistically ([cec4037](https://github.com/utensils/aethon/commit/cec40371f74049188b6a4d8a5f6575ccb0e2ecdd))

## [0.7.0](https://github.com/utensils/aethon/compare/v0.6.0...v0.7.0) (2026-06-03)

### Features

- **agent:** support [@file](https://github.com/file) prompt references ([#219](https://github.com/utensils/aethon/issues/219)) ([a636304](https://github.com/utensils/aethon/commit/a636304c5809128e70c38d06565ab4c996a14a78))

## [0.6.0](https://github.com/utensils/aethon/compare/v0.5.0...v0.6.0) (2026-06-03)

### Features

- **dashboard:** support issue prompt templates ([#217](https://github.com/utensils/aethon/issues/217)) ([956cfaf](https://github.com/utensils/aethon/commit/956cfaf709edff74c627223cf271a69446f76406))
- make agent timeouts configurable ([36ec943](https://github.com/utensils/aethon/commit/36ec94305529cdee2059d75093a3b5e0e9fbda70))

### Bug Fixes

- **auth:** refresh Codex auth profile state without restart ([#218](https://github.com/utensils/aethon/issues/218)) ([52b1560](https://github.com/utensils/aethon/commit/52b156091c676aa29fdb711cd36b7c578d49809e))
- **tabs:** show Aethon menu for overview tab ([#216](https://github.com/utensils/aethon/issues/216)) ([fa501cf](https://github.com/utensils/aethon/commit/fa501cf20b8c861a23cd1145585e3bb6724a42fb))

## [0.5.0](https://github.com/utensils/aethon/compare/v0.4.0...v0.5.0) (2026-06-03)

### Features

- configurable subagents + session rollback & fork ([#208](https://github.com/utensils/aethon/issues/208)) ([1c2af35](https://github.com/utensils/aethon/commit/1c2af35855aa39fa40ed1fb230103620aead48dd))
- **context:** self-correct Ollama context window + surface saturated state ([dc0ab6d](https://github.com/utensils/aethon/commit/dc0ab6defe7d14862a73293ace484acd86439a21))
- **git:** periodically fetch project remotes ([9dc03be](https://github.com/utensils/aethon/commit/9dc03be3e12a8d6f2987e42c09d5a02a6032f4b3)), closes [#196](https://github.com/utensils/aethon/issues/196)
- improve markdown preview parity ([83c67d8](https://github.com/utensils/aethon/commit/83c67d8d96363bafddc0d0b6c5dfe26b47404f70))
- **model:** make the header picker the default model for new sessions ([b921987](https://github.com/utensils/aethon/commit/b9219871e529090081b0374a3244d1453250bb45))
- **model:** restore pi-default + custom-id options in the header picker ([#178](https://github.com/utensils/aethon/issues/178)) ([68dde64](https://github.com/utensils/aethon/commit/68dde640808735b6cbab680c6883e7be8074442d))
- **packaging:** add Arch AUR package verification ([#185](https://github.com/utensils/aethon/issues/185)) ([539e606](https://github.com/utensils/aethon/commit/539e60643fa972b4bdc208fc8400e56d6f95d4bd))
- **transcript:** cycle tool-call grouping (turn/run/block) + fix visibility-scope popover ([#205](https://github.com/utensils/aethon/issues/205)) ([40b8c7f](https://github.com/utensils/aethon/commit/40b8c7fa30a83fe86f5734deac5ec4b8fdee6932))
- **ui:** agent-activity indicators + completion alerts + per-workspace tab restore ([#191](https://github.com/utensils/aethon/issues/191)) ([88ac453](https://github.com/utensils/aethon/commit/88ac453cb8976621da254abb6b3ced6a6a4bcfd0))
- working-context injection, tri-state transcript controls, project-root guardrail ([#204](https://github.com/utensils/aethon/issues/204)) ([d40c8cc](https://github.com/utensils/aethon/commit/d40c8cc45b78510c90c19b8ba41cb19f25024d8b))

### Bug Fixes

- **agent:** guard retry-active tabs from bare prompts ([#188](https://github.com/utensils/aethon/issues/188)) ([fb1f016](https://github.com/utensils/aethon/commit/fb1f016d7af14a68bd7e9df4fb721494289dde37)), closes [#186](https://github.com/utensils/aethon/issues/186)
- forget stale worktree leftovers ([305240f](https://github.com/utensils/aethon/commit/305240f891bff92ab13e6a17b55a3997cdbd63c0))
- harden refs and worktree prompts ([be25e68](https://github.com/utensils/aethon/commit/be25e689586e8b92071c61ff52ab99e44e27d9eb))
- **markdown:** polish code blocks and editor links ([cf6df74](https://github.com/utensils/aethon/commit/cf6df74263784dd4838c84cc07e787258f511dfd))
- **markdown:** prevent preview badge flicker ([#202](https://github.com/utensils/aethon/issues/202)) ([0de46bc](https://github.com/utensils/aethon/commit/0de46bcd967af7e222d2a95bbc67d7a288edea20))
- **markdown:** render README HTML in editor preview ([#197](https://github.com/utensils/aethon/issues/197)) ([8e53d61](https://github.com/utensils/aethon/commit/8e53d616e4a93cb95d5dd6543a13aef393c8b9e1))
- preserve agent stop after frontend reload ([#201](https://github.com/utensils/aethon/issues/201)) ([2eee9ca](https://github.com/utensils/aethon/commit/2eee9ca78bd472e159e2e43d5def364a2dff25ed))
- restore stderr messages inline and retry transient failures ([efa5d59](https://github.com/utensils/aethon/commit/efa5d59bb6913ef1518a94b7ca50db7d0e922868))
- **session:** restored live turns stay visible when chat falls behind pi transcript ([#194](https://github.com/utensils/aethon/issues/194)) ([6f40932](https://github.com/utensils/aethon/commit/6f409326edad9834e6493eb009233cdee95de454))
- **sidebar:** replace worktree rename prompt with inline edit ([#192](https://github.com/utensils/aethon/issues/192)) ([e80967e](https://github.com/utensils/aethon/commit/e80967edda833aac0d783fcde1876d2fd510ad56))
- **transcript:** address Copilot review on tool-call grouping ([#206](https://github.com/utensils/aethon/issues/206)) ([aae55af](https://github.com/utensils/aethon/commit/aae55afb9bdf6cd489d7e333068a085fad9c7dca))
- **vcs:** merge PR badges should use purple, not neutral gray ([#193](https://github.com/utensils/aethon/issues/193)) ([15972f1](https://github.com/utensils/aethon/commit/15972f1590e84f677336eff508ef5edcb6eff5a8))

## [0.4.0](https://github.com/utensils/aethon/compare/v0.3.3...v0.4.0) (2026-05-31)

### Features

- **a2ui:** complete Phase 2 renderer with data binding and event dispatch ([feb2c8b](https://github.com/utensils/aethon/commit/feb2c8ba51a6d506b893f36f5ec0f16a233a41c2))
- **a2ui:** default-layout skill with sidebar, canvas, terminal ([9e10bfe](https://github.com/utensils/aethon/commit/9e10bfe43a7ff06d8e94f992a5412113ae239875))
- **a2ui:** implement A2UI renderer with built-in components ([924da0c](https://github.com/utensils/aethon/commit/924da0c8a02abfafaa256fbdbe380696258c5572))
- **a2ui:** toggleable terminal panel and replaceable layout ([8e47aad](https://github.com/utensils/aethon/commit/8e47aad6257f85e06818d535c66c33e072c6b4dc))
- add auth profile login support ([9de881a](https://github.com/utensils/aethon/commit/9de881a74127c1a9792b458041c30d0a0e2a2501))
- add overview pseudo-tab and stabilize terminal panel ([491a36f](https://github.com/utensils/aethon/commit/491a36f5f950226371db74b03c9c3e391bfe4c73))
- add voice-to-text input ([6f051e4](https://github.com/utensils/aethon/commit/6f051e46220912d712255609a1ed780a688302b9))
- **agent:** idle worker retirement + orphan reconcile ([#159](https://github.com/utensils/aethon/issues/159)) ([#165](https://github.com/utensils/aethon/issues/165)) ([41d4e3d](https://github.com/utensils/aethon/commit/41d4e3da634df4af26b57b95226acabe4f23eefa))
- **agent:** inject Aethon-awareness system prompt ([130db30](https://github.com/utensils/aethon/commit/130db30a699703768404648454178b873d9a3472))
- **agent:** release-safe worker telemetry + agent_diagnostics IPC ([#159](https://github.com/utensils/aethon/issues/159)) ([#164](https://github.com/utensils/aethon/issues/164)) ([8c1aaa5](https://github.com/utensils/aethon/commit/8c1aaa5cc713a85a53c5c2dcf794c07136256ad5))
- **agent:** runtime snapshot, bundled docs, persistent sessions ([b02e85a](https://github.com/utensils/aethon/commit/b02e85a6a4fe4d67e31e996702b331333454312d))
- **agent:** tool execution surfaces as A2UI cards + filtered model picker ([446b301](https://github.com/utensils/aethon/commit/446b301b5d7af5df908ae5912f60655aff06237d))
- **brand:** add light/dark hero banner for README ([af2384f](https://github.com/utensils/aethon/commit/af2384fe1360fd086d5088d644adef0d0581d242))
- **brand:** replace app logo with Aethon Æπ mark ([28aed31](https://github.com/utensils/aethon/commit/28aed31e67f2916e19984fd2d38cb2e9775e7903))
- **bundle:** populate macOS About metadata ([2a0dcc6](https://github.com/utensils/aethon/commit/2a0dcc6350f20518f075dc8667ed9e3ed965da5e))
- **canvas:** programmatic canvas push API ([#5](https://github.com/utensils/aethon/issues/5)) ([7e8a71b](https://github.com/utensils/aethon/commit/7e8a71b312226515c5c74777e084b681dcdbd427))
- **chat:** client-side slash commands ([b842858](https://github.com/utensils/aethon/commit/b84285872b6d805438d1fbabd9050a300198a5bc))
- **chat:** compact modern chat redesign ([#67](https://github.com/utensils/aethon/issues/67)) ([9413301](https://github.com/utensils/aethon/commit/94133011ab31df5e8ce2a30e9d4ab852bdf40153))
- **chat:** persist messages across reloads + Clear Chat sidebar item ([55884b7](https://github.com/utensils/aethon/commit/55884b749e42fe090ea3d0087127fec7701f80aa))
- **chat:** Stop button cancels the in-flight prompt ([bc7ec48](https://github.com/utensils/aethon/commit/bc7ec48cc04ac36a47a7762ea7ba8c13d5f87f37))
- **chrome:** searchable model picker, layout+theme menu, per-project tabs ([304ad41](https://github.com/utensils/aethon/commit/304ad4112b2dc2c4f6602c6cedaf553092467ca2))
- **ci:** release-please + nightly signed macOS builds ([#127](https://github.com/utensils/aethon/issues/127)) ([65143db](https://github.com/utensils/aethon/commit/65143db916653c245c1ca52b695c82c7be2ccd32))
- **config:** read ~/.aethon/config.toml for ui/agent defaults ([6a0285d](https://github.com/utensils/aethon/commit/6a0285d7358a7a54988de662ac0e0ef90441038a))
- **config:** wire dead [ui]font_size and [agent]model options ([95dec49](https://github.com/utensils/aethon/commit/95dec49afcc0ad922e3b78398e6735191d271c96))
- **default-layout:** syntax highlighting, model picker filter, slash arg autocomplete ([608aa87](https://github.com/utensils/aethon/commit/608aa87acccac795ff046e1a1001f9a8aa1d491f))
- **design:** full prototype fidelity pass — 12 themed shells, UAT-verified ([90583ec](https://github.com/utensils/aethon/commit/90583ecc3862494660cd3ed15dbe27acf75fed70))
- **devshell:** first-class Nix devshell support for shells + agent bash ([#133](https://github.com/utensils/aethon/issues/133)) ([a7bc7d1](https://github.com/utensils/aethon/commit/a7bc7d1610d0434be0e0e47e54357f4305d0996e))
- **dev:** vite-style port auto-increment + skill follows via dev-info.json ([77b781e](https://github.com/utensils/aethon/commit/77b781ef3f2ecab2a9def89c91700cfbf9179c5a))
- **editor:** Monaco editor + file tree + viewer extensions ([#71](https://github.com/utensils/aethon/issues/71)) ([55f2029](https://github.com/utensils/aethon/commit/55f20299532df217c9d88a74f8abfb3062f766be))
- **extensions:** A2UI-controls-the-whole-UI surface ([a9f2421](https://github.com/utensils/aethon/commit/a9f2421d6bcac4723eb247cae519edd88796b942))
- **extensions:** aethon.onEvent for interactive extension UI ([0dd7218](https://github.com/utensils/aethon/commit/0dd7218e2c21d6a1fea1354dc80c10a688e09757))
- **extensions:** ctx.pi namespace for A2UI event handlers ([968097a](https://github.com/utensils/aethon/commit/968097a30fdbd6fcf1e0229c30b7d57d3f29a6d2))
- **extensions:** expose Aethon API to pi extensions via globalThis ([89d0606](https://github.com/utensils/aethon/commit/89d0606382a443ae72a2c01c173636d74a1ddb2c))
- **extensions:** pi extensions can register A2UI components + push state ([9913020](https://github.com/utensils/aethon/commit/9913020fb0fc746d13f03ac1b04dc16e2750ff84))
- **extensions:** registerTheme API for skill-shipped color schemes ([8aa0c52](https://github.com/utensils/aethon/commit/8aa0c52c6119fb8e4545192971cfa97d43d683b0))
- **file-tree:** show Git status decorations ([45d2c2d](https://github.com/utensils/aethon/commit/45d2c2d8405047315d9574a6cd7bf4e680793ae5)), closes [#93](https://github.com/utensils/aethon/issues/93)
- **git:** watch .git for realtime file-tree + VCS refresh ([#161](https://github.com/utensils/aethon/issues/161)) ([924ad6a](https://github.com/utensils/aethon/commit/924ad6ad2804a243fad55fd26c12b3f8f852b566))
- host-rooted UI + mDNS server scaffold + project icons + widen layout ([#74](https://github.com/utensils/aethon/issues/74)) ([db04c5b](https://github.com/utensils/aethon/commit/db04c5b0a61adbbb17b1a9525408717d230f951a))
- **hot-reload:** watch user extension dirs in dev AND release ([ca09bed](https://github.com/utensils/aethon/commit/ca09bedaf98d2b1094fb3db44dfca3f64509e96f))
- **icon:** bold Greek alpha cresting a sun disc ([0d4b2af](https://github.com/utensils/aethon/commit/0d4b2af01b0b2c73643228f3932f5563b9f32757))
- **layout:** drop static FILES section, add aethon-files demo ([80ddd41](https://github.com/utensils/aethon/commit/80ddd4127d981f98647f7b87257775307f1c9d60))
- **layouts:** four ship-ready layouts on Æther signature palette ([71d1739](https://github.com/utensils/aethon/commit/71d17390e97b2446dfa33c796d54a0d70ae5cc29))
- **m2:** a2ui primitive coverage — heading/paragraph/divider/checkbox/select/slider/list/table ([833c3c1](https://github.com/utensils/aethon/commit/833c3c1c70a2d543572574b0219f6e3365d4cce1))
- **m5:** bridge-readable frontend state — getFrontendState + uiState snapshot ([7195ac5](https://github.com/utensils/aethon/commit/7195ac5ad4bbc943589b1a4ca8f1097635ed46a8))
- **m5:** chrome props + theme directory + layout structure snapshot ([e76ff24](https://github.com/utensils/aethon/commit/e76ff24e33cbbcb4a6714c99d9b42c52145db785))
- **m5:** compositional sidebar items via componentType per row ([36f94e4](https://github.com/utensils/aethon/commit/36f94e4dc2d27b852fce70a37af8b7fdb1ccf5be))
- **m5:** default-layout slot contract — canonical area names + slotMap ([161e62a](https://github.com/utensils/aethon/commit/161e62adcb638d180b635ec80dedad40151f3be8))
- **m5:** empty-state composite when last tab closes (a2ui, not hardcoded) ([da486c1](https://github.com/utensils/aethon/commit/da486c15e8d0d69aded6fae6887d079b9e4e4a08))
- **m5:** extension_lifecycle feedback channel ([7d8df9e](https://github.com/utensils/aethon/commit/7d8df9e8f1e7b567d35322d90cd9e5134b0496aa))
- **m5:** for-each template primitive — array iteration with $item / $index / $parent ([11ca681](https://github.com/utensils/aethon/commit/11ca6811b209098af588104052809e4ed6cbafb9))
- **m5:** layout catalogue + sidebar opt-in (single-pane / focus-mode) ([786fb91](https://github.com/utensils/aethon/commit/786fb91846159f641ce0bec8147c9d3bfff92489))
- **m5:** multi-tab restore via empty-state recent sessions ([92836cd](https://github.com/utensils/aethon/commit/92836cdaa6d6655db63f627c7f86b730cdc949cc))
- **m5:** mutation feedback channel — promise-based ack from frontend ([08cef8d](https://github.com/utensils/aethon/commit/08cef8d43fedefc78442c8a663c3a0262988477f))
- **m5:** phase 1 quick wins — button click, sidebar descendantId, snapshot handlers ([1477460](https://github.com/utensils/aethon/commit/147746012e1ce16dfd1853961e5ade53c4077248))
- **m5:** pluggable onEvent routing — extensions can intercept built-in handlers ([d1ae18c](https://github.com/utensils/aethon/commit/d1ae18c31593cf99bc006370c3e15ffb6a5142f8))
- **m5:** registerable keyboard shortcuts — aethon.registerKeybinding ([764e67a](https://github.com/utensils/aethon/commit/764e67aa7b1fece50cd844fbad7cbbcf5c176e95))
- **m5:** registerable menu items — aethon.registerMenuItem / unregisterMenuItem ([9eb7665](https://github.com/utensils/aethon/commit/9eb766550b650405592facdbf48e5de33a0f6fa0))
- **m5:** registerable slash commands — aethon.registerSlashCommand ([fbfbdc7](https://github.com/utensils/aethon/commit/fbfbdc7e3ebf55d539492dfe8501bd351cf233e5))
- **menu:** Help submenu with Documentation + Report Issue links ([df9a57b](https://github.com/utensils/aethon/commit/df9a57b740f093489ce438596187ec64bf30ead3))
- **menu:** native macOS menu bar with app-specific items ([e47412c](https://github.com/utensils/aethon/commit/e47412c5a5b2d2022474abf780d3bc60c0a7f933))
- **p2.3:** register aethon.shells.{list,read,write} as pi tools ([#23](https://github.com/utensils/aethon/issues/23)) ([1124663](https://github.com/utensils/aethon/commit/112466360d06295d250a17b5550f7717effa54c9))
- **p3:** Settings UI — Cmd+, opens form panel + write_config ([#25](https://github.com/utensils/aethon/issues/25)) ([4c2d8eb](https://github.com/utensils/aethon/commit/4c2d8ebf5e032bc3e5fa946b1a3979bea94e31e7))
- **p4:** tool-card elapsed-time + OS notifications + drag-drop ([#19](https://github.com/utensils/aethon/issues/19)) ([6e5f854](https://github.com/utensils/aethon/commit/6e5f8542bf3ea2a240a42b95672c5fb439f49fa3))
- **p5:** bridge crash recovery — auto-restart + frontend notice ([#22](https://github.com/utensils/aethon/issues/22)) ([dbdd8c4](https://github.com/utensils/aethon/commit/dbdd8c4ced6e60ed2f3e1b6a5c9cfcc6d7d6ea2b))
- **p5:** history-replay for reopened agent tabs ([#24](https://github.com/utensils/aethon/issues/24)) ([c017dbd](https://github.com/utensils/aethon/commit/c017dbd21400987ad0f945c00b7c457687db444a))
- **p6:** cross-session search overlay ([#26](https://github.com/utensils/aethon/issues/26)) ([f2ee41e](https://github.com/utensils/aethon/commit/f2ee41e336d22b5cbcc88c5f21e0a1a6302fa873))
- **palette:** ⌘P/⌘⇧P command palette + notification stack ([fdb115d](https://github.com/utensils/aethon/commit/fdb115d697971aecfd0205476ede79a7e0ddbd71))
- **persist:** chat history + theme stored in ~/.aethon/ ([e28a210](https://github.com/utensils/aethon/commit/e28a210b58918a7b61ebd986726aa9870c3bbde8))
- **pi:** support native slash commands ([#65](https://github.com/utensils/aethon/issues/65)) ([fa07ac4](https://github.com/utensils/aethon/commit/fa07ac4d471954c2bfcca597c1e3589b066ea7ad))
- **projects:** add project (working directory) concept + drop mock data ([857d7c2](https://github.com/utensils/aethon/commit/857d7c2b2d86ad179c73d19510dab0d8ebb94e5e))
- queued-messages popover + inline extension toggle + 0.3.3 ([#88](https://github.com/utensils/aethon/issues/88)) ([f04d743](https://github.com/utensils/aethon/commit/f04d7438e75398717103c96d7321429a1826ae8f))
- **release:** compiled aethon-agent sidecar for release bundles ([57c93d5](https://github.com/utensils/aethon/commit/57c93d56f554aef5ec90d90488afcc5d812d3db9))
- scaffold Tauri 2 + React + TypeScript app ([3aba2f1](https://github.com/utensils/aethon/commit/3aba2f1c40127b14414d93b31bba4ce7c6e8c6fd))
- **shell:** M6 P1 — interactive PTY-backed shell tabs ([#8](https://github.com/utensils/aethon/issues/8)) ([d9eeb1b](https://github.com/utensils/aethon/commit/d9eeb1b0f9620dccba4ba26b9e9eacf2fe713954))
- **shell:** M6 P2.1 — agent ↔ shell sharing (read-only) ([#13](https://github.com/utensils/aethon/issues/13)) ([c4c861e](https://github.com/utensils/aethon/commit/c4c861eeac761b1d99714263d412844b43cbe936))
- **shell:** M6 P2.2 — shells.write + per-write user confirmation ([#14](https://github.com/utensils/aethon/issues/14)) ([3073c21](https://github.com/utensils/aethon/commit/3073c21fa3bd629add520a1f65ab511ceb192b4c))
- **sidebar:** resizable sidebar with persisted width; fix optimistic-update revert ([2dafbd2](https://github.com/utensils/aethon/commit/2dafbd209eeab64ac6e5d3f61881dc590192aa2c))
- **sidebar:** support left-edge resizing ([#66](https://github.com/utensils/aethon/issues/66)) ([9bd330f](https://github.com/utensils/aethon/commit/9bd330f0443cea6ad8dc118c5d2d456b71abdf2f))
- **skills:** default-layout as registerable skill bundle ([975bbc5](https://github.com/utensils/aethon/commit/975bbc535ef24bf7161cb7dfcc5e87170969a622))
- **skills:** npm package manifest discovery via package.json#aethon ([74e530e](https://github.com/utensils/aethon/commit/74e530ea049f7f828ca1b0a544ca19a873c7e405))
- **tabs:** per-tab pi sessions with Cmd+T / Cmd+[ / Cmd+] / Cmd+W ([c52b175](https://github.com/utensils/aethon/commit/c52b17532a3107bdaa7406f71e14da046579ce94))
- **tabs:** per-tab terminal buffer + model inheritance on new tab ([80d0c9a](https://github.com/utensils/aethon/commit/80d0c9a36929553ea287c08851ed72c3025e5ded))
- **terminal:** stream bash tool output into the visible terminal panel ([1068854](https://github.com/utensils/aethon/commit/10688547c3aae299cedc2324d579f6c455136747))
- **terminal:** stream partial bash output via tool_execution_update ([532095d](https://github.com/utensils/aethon/commit/532095da2b652a72daba7d73af1983252694ae40))
- test coverage, ESLint, extension cleanup, brand polish ([45ee313](https://github.com/utensils/aethon/commit/45ee313099be1a58297f3837cf2e5671533047b8))
- test coverage, ESLint, extension cleanup, brand polish ([61f110f](https://github.com/utensils/aethon/commit/61f110f2cbe2a84dfea2bc47ed50233b02788b3b))
- **theme:** add Brink palette ([#68](https://github.com/utensils/aethon/issues/68)) ([6c16528](https://github.com/utensils/aethon/commit/6c16528a4c3610601ab473a021cf053aba57f143))
- **theme:** light + dark themes with sidebar switcher ([0b39ad3](https://github.com/utensils/aethon/commit/0b39ad351b861b3aac269f755d28950039804a6e))
- **themes:** expand token surface and add three new themes ([#149](https://github.com/utensils/aethon/issues/149)) ([d907307](https://github.com/utensils/aethon/commit/d907307ab692be08a25b4c8ddc169da13c9bfa56))
- **themes:** three-palette ship — ember + paper + aether ([d7e3a96](https://github.com/utensils/aethon/commit/d7e3a9673acd97667c9721be4da2a41005e41084))
- **tray:** macOS status-bar icon with Show / New Tab / Quit ([9eee759](https://github.com/utensils/aethon/commit/9eee759bb526450aa931a6732e0e1da8b35a1af0))
- **ui:** basic chat scaffold with dark theme ([31491a6](https://github.com/utensils/aethon/commit/31491a61ec4aedbd650ae2636fcab793ac232b15))
- **ui:** cmd+\` toggles terminal, message queue, brand-aligned theme ([fcc9ba9](https://github.com/utensils/aethon/commit/fcc9ba9cc529a5871f884e956f4f35bf02372c14))
- **ui:** layout & design overhaul — bold themes, always-on VCS surface, header symmetry ([#153](https://github.com/utensils/aethon/issues/153)) ([2a29ff0](https://github.com/utensils/aethon/commit/2a29ff02d80cd1c4af03cb63366467aaf8e9856b))
- **ui:** markdown rendering, active-model marker, dock icon, status report on reload ([b1d7150](https://github.com/utensils/aethon/commit/b1d7150c581901ec52739f170f48c9f4aae5a393))
- **ui:** render image content from tool results in cards ([e688212](https://github.com/utensils/aethon/commit/e6882122c68a96369e87130920735e478e337992))
- **ui:** session history alignment, model fix, sticky scroll, UI polish ([#32](https://github.com/utensils/aethon/issues/32)) ([76de588](https://github.com/utensils/aethon/commit/76de58863991e1bcf743505fad76a21675ee4d15))
- **updater:** channel-aware auto-updates + boot-probation rollback ([#129](https://github.com/utensils/aethon/issues/129)) ([f29fb07](https://github.com/utensils/aethon/commit/f29fb0735f238db68eb421aa512b7cfdf3ec60a5))
- **updater:** tauri-plugin-updater wired with manual check + relaunch ([1fbcc4f](https://github.com/utensils/aethon/commit/1fbcc4f58c7d39126aeec970ed4701a867732a4f))
- **ux:** hotkey expansion + dual-terminal mental model ([#17](https://github.com/utensils/aethon/issues/17)) ([dc52f2e](https://github.com/utensils/aethon/commit/dc52f2e7bdd6220952e808c21e347c8124d8ec50))
- **ux:** shells render in bottom panel as sub-tabs; Cmd+T focus-aware ([#20](https://github.com/utensils/aethon/issues/20)) ([b730fe7](https://github.com/utensils/aethon/commit/b730fe722cfc4861ccfeee41729bf3b79435cb06))
- **window:** persist position, size, maximized + multi-monitor restore ([#69](https://github.com/utensils/aethon/issues/69)) ([8582649](https://github.com/utensils/aethon/commit/85826490477c7aafd48f58a04a5139a4d9fdbcb8))
- wire pi agent bridge with Tauri subprocess and React chat ([057af94](https://github.com/utensils/aethon/commit/057af9482eb39db2a9969a3d5d67d57b6f27ffc1))
- working agent chat with streaming, model picker, hot reload + aethon-debug skill ([bbcae59](https://github.com/utensils/aethon/commit/bbcae59331116a39995e6ee0a599586d0dc28dca))
- **workstation:** full redesign — tokens, worktrees, file explorer, dashboards ([#73](https://github.com/utensils/aethon/issues/73)) ([0955059](https://github.com/utensils/aethon/commit/095505931deccb612dbc44faabb5916fd465c4cc))

### Bug Fixes

- **a2ui:** remove unused showLineNumbers variable in Code component ([fe972b0](https://github.com/utensils/aethon/commit/fe972b0f1efbeb05db4a394e4ecf9548cc44d7e5))
- **agent-build:** respect cargo target triple + handle Windows .exe ([d8da038](https://github.com/utensils/aethon/commit/d8da0384e7485fe73d669fb7169490f8210f82db))
- **agent-prompt:** preserve user APPEND_SYSTEM.md + honor PI_CODING_AGENT_DIR ([56ce2dc](https://github.com/utensils/aethon/commit/56ce2dc3abafe18c01ec6858e977247f56926e93))
- **agent:** address dispatcher review findings ([#111](https://github.com/utensils/aethon/issues/111)) ([a24dd6f](https://github.com/utensils/aethon/commit/a24dd6f6c029655492abaf9eef7a238a53990845))
- **agent:** extract readable text from tool result content array ([2454920](https://github.com/utensils/aethon/commit/2454920d8fcdeba9ca3b1c8ab582643a4cfb5c99))
- **agent:** getLayout() returns boot tree + codex audit findings ([1d4d2ff](https://github.com/utensils/aethon/commit/1d4d2ff2a3587010ddab7d447bc278e419fc63b2))
- **agent:** isolate tab-scoped worker processes ([82a19d2](https://github.com/utensils/aethon/commit/82a19d22a6b8fd0050f170ed2ed72518757cfa46))
- **agent:** retry transient transport failures ([#143](https://github.com/utensils/aethon/issues/143)) ([b1f3f71](https://github.com/utensils/aethon/commit/b1f3f717214a217a1ec99b90c03e2af87c2eabe9))
- **app:** polish agent sessions and realtime files ([#80](https://github.com/utensils/aethon/issues/80)) ([9bd7f7a](https://github.com/utensils/aethon/commit/9bd7f7a63f787074f98993ad2b9490ccb656292f))
- **app:** restore sessions with worktree context ([30c148b](https://github.com/utensils/aethon/commit/30c148bf95d832c155f2feca28b5e4f067649d38))
- autosave settings edits live ([#146](https://github.com/utensils/aethon/issues/146)) ([2ad891d](https://github.com/utensils/aethon/commit/2ad891db14af850537617582d5f4d8567edd5b77))
- **brand:** drop background fill from hero variants ([e6fa70d](https://github.com/utensils/aethon/commit/e6fa70d0cad70a0b16c325c49abac644f9a4098e))
- **bridge:** clear in-flight + emit response_end when prompt resolves without agent run ([c4da8c0](https://github.com/utensils/aethon/commit/c4da8c01c383f6fefce237c6051eb7e8ab683caa))
- **bridge:** gate concurrent chat messages while a prompt is in flight ([9e96b90](https://github.com/utensils/aethon/commit/9e96b90d24c2010dd7fc1a4692ddc48935cce412))
- **bridge:** gate set_model while a prompt is in flight ([6c22724](https://github.com/utensils/aethon/commit/6c22724a554e326a56df22fcb1872fe32d70a86a))
- **build:** always rebuild sidecar when agent sources change ([50be76b](https://github.com/utensils/aethon/commit/50be76b5e113e32613e95f9e40a4ade733bc4b4c))
- **build:** auto-bootstrap aethon-agent sidecar from build.rs ([fde7fdf](https://github.com/utensils/aethon/commit/fde7fdfef763235a4a81926a90e72b2aefa4b520))
- **build:** drop beforeBuildCommand bash hook (Windows compat) ([c26c8d2](https://github.com/utensils/aethon/commit/c26c8d2ec55b4896ae3cbaf0220753cc2470583c))
- **build:** pin cargo linker to /usr/bin/cc to stop Nix-store libiconv leak ([#130](https://github.com/utensils/aethon/issues/130)) ([cb7f0a0](https://github.com/utensils/aethon/commit/cb7f0a05da47c9f92318f3cd973b2ba272bc53e1))
- **build:** port sidecar build to Rust + mtime gating ([cc1b9b7](https://github.com/utensils/aethon/commit/cc1b9b7f54a9caeb288b7bacba9c824cc177076c))
- **canvas:** codex review follow-ups (8 P2s) ([#6](https://github.com/utensils/aethon/issues/6)) ([09e42f3](https://github.com/utensils/aethon/commit/09e42f32667ec49177606f9cc0a895f5f9e96073))
- **chat:** contain horizontal overflow in chat window ([#170](https://github.com/utensils/aethon/issues/170)) ([8ea0169](https://github.com/utensils/aethon/commit/8ea016982767e3b3b162da26d6ae2430160b9eb0))
- **chat:** keep streamed thinking blocks ordered ([#168](https://github.com/utensils/aethon/issues/168)) ([e981b9e](https://github.com/utensils/aethon/commit/e981b9edccfda4064d3f0ab806ff10667e9817e2))
- **chat:** keep streaming text in one bubble across tool calls ([322db8d](https://github.com/utensils/aethon/commit/322db8d83a6a31faaf2728cb13729a2262c0421a))
- **chat:** open message links externally ([#98](https://github.com/utensils/aethon/issues/98)) ([8886788](https://github.com/utensils/aethon/commit/88867882860ddcdd67214d7b12f240cf6f4fd9e6))
- **chat:** steer latest queued message from empty composer ([#104](https://github.com/utensils/aethon/issues/104)) ([6e8e0b2](https://github.com/utensils/aethon/commit/6e8e0b27c7f4d903266806d5e6af4c8005c4b738))
- **chat:** support steering and scoped cwd sessions ([44a380a](https://github.com/utensils/aethon/commit/44a380ae60a953e1214952717da1f1f96b3a7329))
- **chrome:** use fixed positioning so dropdowns escape layout-cell clip; drop sidebar models section ([99f8931](https://github.com/utensils/aethon/commit/99f8931b43ab81ae7c302358104089878f0efe06))
- **ci:** accept Aethon_aarch64.app.tar.gz updater bundle name ([5155be9](https://github.com/utensils/aethon/commit/5155be94fc61dcc7f775ade6e3c78b389678a19b))
- **ci:** serialize release-please runs ([#174](https://github.com/utensils/aethon/issues/174)) ([e1186f2](https://github.com/utensils/aethon/commit/e1186f2dc3509f93516fba5721c4691ce10bac79))
- **cleanup:** track live setState writes for next-ready prune ([f03bdb6](https://github.com/utensils/aethon/commit/f03bdb626f48acbb931538c6bac4783261982a05))
- clear updater banner from mac controls ([8759859](https://github.com/utensils/aethon/commit/8759859af5c147d57e0434394092d2cfcc73be74))
- **ctx-pi:** await session.prompt + open maximized ([15bcd41](https://github.com/utensils/aethon/commit/15bcd41e72b2f53c48407b3257169b96c077478c))
- **ctx-pi:** don't block stdin loop on handler awaits ([846f332](https://github.com/utensils/aethon/commit/846f3320c34d0a2c0579414b3d1c2b3778c7aed1))
- **ctx-pi:** emit prompt_started + use session.agent.signal ([43975d4](https://github.com/utensils/aethon/commit/43975d4f315aadc530c947ea37eaebcd04b301f7))
- **dashboard:** shorten issue worktree branches ([2711fb9](https://github.com/utensils/aethon/commit/2711fb92f6a5477191bda7ffbea8fe3cd1fb2655)), closes [#89](https://github.com/utensils/aethon/issues/89)
- **default-layout:** codex review follow-ups ([7e5e51e](https://github.com/utensils/aethon/commit/7e5e51ebce4ebca5c7de35423779b0738e67c7df))
- derive project dashboard icon live ([01d5f34](https://github.com/utensils/aethon/commit/01d5f340867b80ade8dfff8b4e05d36c543e3a3f))
- **devshell:** inject report handshake into worker bridges on spawn ([#134](https://github.com/utensils/aethon/issues/134)) ([4342d4f](https://github.com/utensils/aethon/commit/4342d4f65eebbfc581bf740f551e3c50ac93c7c6))
- **devshell:** resolve tools from launch-safe PATH ([dfd4700](https://github.com/utensils/aethon/commit/dfd47007f32f173ff8f218fab5bae8ad0724a54a))
- **extensions:** apply ready-owned fields LAST in hydration ordering ([8f35da0](https://github.com/utensils/aethon/commit/8f35da077994b7ae89202231204f7d8c38dfb014))
- **extensions:** deep-merge ext state hydration; rewrite all template ids per host ([d47141b](https://github.com/utensils/aethon/commit/d47141b0e261fe04186485bd748977db988dea77))
- **extensions:** hydrate extLayout.state on ready replay ([98020c4](https://github.com/utensils/aethon/commit/98020c449ec874520f4683b29b9484d2cad8b764))
- **extensions:** live layout_set treats payload state as defaults, not overrides ([8d4a5ed](https://github.com/utensils/aethon/commit/8d4a5ed92badb383086c7614a6dffa796ca84237))
- **extensions:** prune stale disabled project records ([#147](https://github.com/utensils/aethon/issues/147)) ([769a392](https://github.com/utensils/aethon/commit/769a39210349abbcb707f890bc624f055f12b88d))
- **extensions:** ready replay treats extension layout state as defaults too ([0a44faf](https://github.com/utensils/aethon/commit/0a44faff21aada2e61b5416e8da036a845158966))
- **extensions:** replay layout state before extension patches to match live order ([2092af6](https://github.com/utensils/aethon/commit/2092af6a28495fd1ef3268b25ba16650b06f4343))
- **extensions:** reset to BOOT_LAYOUT when ready reports no extension layout ([bbbd89d](https://github.com/utensils/aethon/commit/bbbd89dcc7ba19ca1a3129229c435f8d31c21fca))
- **extensions:** retain ext state for ready replay; resync observer overlays on payload swap ([d71b693](https://github.com/utensils/aethon/commit/d71b693d96c210c43e1f9abd98c24a07ef50f5d1))
- **extensions:** retain extension layout for ready/report replay ([a40caad](https://github.com/utensils/aethon/commit/a40caad1801ade1c2cb3805ce0866c9da329f14d))
- **extensions:** retain layout_patch ops without setLayout, replay on ready ([e7aca4d](https://github.com/utensils/aethon/commit/e7aca4d9b9ac9e7ab6824157dfc01aa4659eb25c))
- **extensions:** store extension state as tree, not ordered patch list ([bbe8276](https://github.com/utensils/aethon/commit/bbe82765bac8b2a2e177cee03aba52b54e5f51aa))
- **hot-reload:** create ~/.aethon/extensions on boot so first-install reloads ([fb6bcc4](https://github.com/utensils/aethon/commit/fb6bcc40ac858856df71b87d0729840e666ac089))
- **hot-reload:** single debounce worker thread instead of per-event spawn ([258bea1](https://github.com/utensils/aethon/commit/258bea189303da10e6434bb853a1fc50f328b589))
- **hot-reload:** trailing-edge debounce so npm install bursts settle ([b0386ef](https://github.com/utensils/aethon/commit/b0386ef89d263195eef9a5e30de4f6622ead9bdf))
- **image:** skip &lt;img&gt; when src is empty (placeholder restored from history) ([3418cc0](https://github.com/utensils/aethon/commit/3418cc07f720cb870bf103c3f0c89aa5e97268a0))
- keep session rename focused while agent runs ([#90](https://github.com/utensils/aethon/issues/90)) ([084bdf4](https://github.com/utensils/aethon/commit/084bdf4b2b79bdc4601e456a0edd73528b684bd5))
- **layout:** array-preserving patch + null-safe sidebar items ([be60b6e](https://github.com/utensils/aethon/commit/be60b6e2fcfa7e652937bea775b29d533019c009))
- **layout:** keep command-deck command-bar at 540px instead of collapsing ([eb832ca](https://github.com/utensils/aethon/commit/eb832ca17642d670fd08588ef59f927db5d0bf28))
- **layout:** restore workstation tabs and file tree expansion ([2ab023a](https://github.com/utensils/aethon/commit/2ab023a09b2bf16cb45472f4deaea2352ab654fe))
- **layout:** smooth workbench toggle without breaking resize ([7c7aedc](https://github.com/utensils/aethon/commit/7c7aedc1d9207eef9eeebfdbf4d369b1361c30b6))
- **lint:** drop --max-warnings=0 from npm lint script ([3cbda87](https://github.com/utensils/aethon/commit/3cbda8779eaf12e3448941d9586fddb48ee7adff))
- **m5:** handler setState attribution + compositional terminal subscription ([3c33d49](https://github.com/utensils/aethon/commit/3c33d499d2a92ab9d8f1c3c665803823c8086f1d))
- **menu:** drop close_window so Cmd+W stays bound to close_tab ([82604fc](https://github.com/utensils/aethon/commit/82604fca5ec37b0d7292942d6e194875edf758a2))
- **palette:** collapse sections globally + fix arrow nav + clearer active row ([#11](https://github.com/utensils/aethon/issues/11)) ([6f113ef](https://github.com/utensils/aethon/commit/6f113ef9b4f2f70852feafc27ec136231d729195))
- **palette:** keep selection aligned with rendered order + drop stale-closure ([#12](https://github.com/utensils/aethon/issues/12)) ([6f6221e](https://github.com/utensils/aethon/commit/6f6221e5794786d881624b077ea1a5618c4c5be7))
- **perf:** speed up long chat sessions ([5f16483](https://github.com/utensils/aethon/commit/5f16483219905ef89973fdb1288ed77fab02aa82))
- **persist:** merge restored history with messages already in state ([ae378f3](https://github.com/utensils/aethon/commit/ae378f3b6fc8e00af6a0c8c8d950d21b26523a98))
- **persist:** only drop legacy localStorage after confirmed disk write ([ace912d](https://github.com/utensils/aethon/commit/ace912d38f9e52efd8eaf3ea4d7966c4b41bdc72))
- **persist:** strip image data URLs from localStorage history ([94f4886](https://github.com/utensils/aethon/commit/94f4886596242347a7aeb25a3009b7e85cda0902))
- **persist:** trigger write effect once restore completes (state, not ref) ([aa7475c](https://github.com/utensils/aethon/commit/aa7475c84cfcf747a74dd18e3b01f68acdbc00b5))
- **persist:** use Tauri path API for cross-platform home_dir resolution ([1103996](https://github.com/utensils/aethon/commit/1103996da29d5a09c55cbbdc96031c9f70a47bb7))
- reconcile terminal cards and queued controls ([96ab316](https://github.com/utensils/aethon/commit/96ab31696754abee594c64050557eb306dc8beea))
- **release:** inject login-shell PATH so pi can find npm ([02a1a2b](https://github.com/utensils/aethon/commit/02a1a2b368d67e9e1492301f05968b67af3c4a32))
- **release:** make version check cross-platform ([4aeed3e](https://github.com/utensils/aethon/commit/4aeed3e899171c62ea1848df9f27c047dcab6166))
- **renderer:** merge payload-local state with external state so embedded A2UI keeps own refs ([cbc61bf](https://github.com/utensils/aethon/commit/cbc61bf8a0d22d56a0614fd0b8ecc334ac7c74d6))
- **renderer:** observer diff-only writes; always derive expanded template id from host ([a45b816](https://github.com/utensils/aethon/commit/a45b816d89c0ca52c1f5e6e86d5ab8a34101fd6f))
- **renderer:** three explicit modes (controlled/observer/self) for state semantics ([47be704](https://github.com/utensils/aethon/commit/47be704ec167825b0ec912666ef9a40961509c2d))
- **renderer:** write overlay for nested A2UI when external state has no onStateChange ([a67e403](https://github.com/utensils/aethon/commit/a67e403900d1f13b96574d5a9bcdcb7c368a2c37))
- **safety:** extension runtime safety — size guard, hang escape, menu/scroll/delete fixes ([#34](https://github.com/utensils/aethon/issues/34)) ([b30107c](https://github.com/utensils/aethon/commit/b30107c4b7a33d02ff6404fa9a80f878a41c5662))
- **session:** clear stale restored waiting state ([#102](https://github.com/utensils/aethon/issues/102)) ([23ac98a](https://github.com/utensils/aethon/commit/23ac98aef03e2a010864bbc5511b3332c43d1048))
- **session:** prevent release reload loops ([fd1b8d2](https://github.com/utensils/aethon/commit/fd1b8d2f4f2b4e58d3af36c3bcbd5ed98285d097))
- **sessions:** keep worktree sessions resumable ([6eacd69](https://github.com/utensils/aethon/commit/6eacd693ef082e2bee6e1ef0adef1e7a4122c935))
- **sessions:** route worktree landing restores ([c35672a](https://github.com/utensils/aethon/commit/c35672a5dbb0463270957557300e83b8db350060))
- **shell:** address codex P1+P2 follow-ups on M6 P2.2 ([#15](https://github.com/utensils/aethon/issues/15)) ([b33f7f3](https://github.com/utensils/aethon/commit/b33f7f378c20a0d4133e7185ccfcd58160e3fafe))
- **shell:** preserve UTF-8 boundaries when streaming PTY output ([#9](https://github.com/utensils/aethon/issues/9)) ([610610c](https://github.com/utensils/aethon/commit/610610c7f3c1ce808a69ac2c4f1658452c51359c))
- **shell:** resolve evicted prompts + reserve consent routing ([#16](https://github.com/utensils/aethon/issues/16)) ([b1a9860](https://github.com/utensils/aethon/commit/b1a98605a1dce7cf3b8b0cf142e10ecb1f84a9bb))
- **shell:** use Utf8Error::error_len() to distinguish truncation from invalid ([#10](https://github.com/utensils/aethon/issues/10)) ([99dcc6d](https://github.com/utensils/aethon/commit/99dcc6da09a856c55ebe2df7ae09a6cbfe14d7a5))
- **shortcuts:** cmd+\` shouldn't double-fire or leak into xterm ([f5efda9](https://github.com/utensils/aethon/commit/f5efda9b016b0e3836fe11e468f769e93ec41759))
- **slash:** forward unknown slash commands to the agent instead of blocking ([b199f9f](https://github.com/utensils/aethon/commit/b199f9f5922813b0bba84b4264dbb76474e437bd))
- **slash:** preserve draft on Escape; add notice event for non-terminal busy ([7820037](https://github.com/utensils/aethon/commit/78200376b4983b266abc6b8d87d2e9d9ed59e6ee))
- **slash:** submit on Enter when draft already matches a command exactly ([b7960a8](https://github.com/utensils/aethon/commit/b7960a89b4652095a0cc36edb7ca4480b249fef2))
- stop updater auto-check loop ([f63d9b3](https://github.com/utensils/aethon/commit/f63d9b3cf75afe56a30ef561a501df2e23ccbccf))
- **tabs,release:** tighten three more codex findings ([7f3ad3b](https://github.com/utensils/aethon/commit/7f3ad3b16909ae4fa32af831028e72093467c6d8))
- **tabs:** add session rename context menu ([#82](https://github.com/utensils/aethon/issues/82)) ([50b1d8d](https://github.com/utensils/aethon/commit/50b1d8d9022b42f96b1ef954761fd74d03df8fa5))
- **tabs:** attribute agent setStates + handler errors to source tab ([4d78877](https://github.com/utensils/aethon/commit/4d7887786c70f9c6c2739a60966c3b94089c5bf4))
- **tabs:** clear queue on Stop + re-mirror active tab on ready ([97497b6](https://github.com/utensils/aethon/commit/97497b60f180df35865ed3018a11722edf51b5f9))
- **tabs:** clear xterm on new tab + keep per-tab patches off global tree ([11aa310](https://github.com/utensils/aethon/commit/11aa31034a74ecd6ba952d4d217a0986bc486bf8))
- **tabs:** close two race windows in queue + new-tab flows ([b48f6f6](https://github.com/utensils/aethon/commit/b48f6f637dc7f85926ac2a33259cf38ddd0d3e28))
- **tabs:** dedup extension onEvent handlers across sessions ([bb78363](https://github.com/utensils/aethon/commit/bb7836398078e7d0bffb6527f7c51757eaa95889))
- **tabs:** emit queue_reset so frontend clears stuck Stop on abort ([1d5d69c](https://github.com/utensils/aethon/commit/1d5d69cf1abb625cee30190f961c10dd778bc575))
- **tabs:** forward tabId to nested cards + sync model picker on switch ([e1d348f](https://github.com/utensils/aethon/commit/e1d348f87c3133e68b86b76f7321040ce3db1c60))
- **tabs:** hoist currentAgentTabId to avoid TDZ during extension load ([08e1735](https://github.com/utensils/aethon/commit/08e173564cd78e6a30be77426be81553938a7344))
- **tabs:** hydrate bridge tabs on ready + track replay opens ([f140d46](https://github.com/utensils/aethon/commit/f140d460de204e29e230cc4852b57731f6ead971))
- **tabs:** mirror active tab's model on ready, not always default's ([3eeda54](https://github.com/utensils/aethon/commit/3eeda5423252ab58f4670ec0d8d02fe6d871f76e))
- **tabs:** pass initial model to tab_open to close the new-tab race ([2c042b5](https://github.com/utensils/aethon/commit/2c042b51fb524c8e0516c9976fd824376b7370ff))
- **tabs:** per-tab replay store for mirrored extension state ([02d3c9e](https://github.com/utensils/aethon/commit/02d3c9e6163da62a76485a7c82ab89c580d70fce))
- **tabs:** per-turn AsyncLocalStorage for setState attribution ([161369a](https://github.com/utensils/aethon/commit/161369a10d23637478c709f1b9407c0e65355ac0))
- **tabs:** route a2ui events by tab + scope clear/draft per tab ([a868bb9](https://github.com/utensils/aethon/commit/a868bb95629470af83304eba546fcf67c27ed19b))
- **tabs:** scope mirrored state, replay terminal on close, restore models on reload ([431bf58](https://github.com/utensils/aethon/commit/431bf58785b9943ba0908417c18133ef6c55b8af))
- **tabs:** unstick slash commands + scope state_patch by source tab ([3421632](https://github.com/utensils/aethon/commit/3421632c3c81f2d28581e01f25a860186866c09d))
- **tasks:** launch issue agents in created worktree ([#87](https://github.com/utensils/aethon/issues/87)) ([8edda56](https://github.com/utensils/aethon/commit/8edda56addad2c2a311e21fd010d586abe032884)), closes [#86](https://github.com/utensils/aethon/issues/86)
- **terminal:** cap+chunk bash output, echo verbatim multi-line command ([3aa8b1e](https://github.com/utensils/aethon/commit/3aa8b1e61e73fbca9f07c0c96c55639a41787c9e))
- **terminal:** default panel to read-only display mode ([5c0222b](https://github.com/utensils/aethon/commit/5c0222ba51f1781d5a82d3f5b2528afed4c8844d))
- **terminal:** length-monotonic tracking with rollback gap warning ([7df6723](https://github.com/utensils/aethon/commit/7df6723b1aac52f2d602ded0ffc50590d3d3d2e8))
- **terminal:** match by trailing tail to handle rolling bash partials ([b04700f](https://github.com/utensils/aethon/commit/b04700fa22a033153e3dc545d96aff77a9f5b85e))
- **terminal:** opt-in subscribeToBash so independent terminals stay clean ([7b2e5b7](https://github.com/utensils/aethon/commit/7b2e5b77668c143791ab347e137a03323fe731ce))
- **terminal:** restore prop-based output path for skills using output $ref ([1200b6e](https://github.com/utensils/aethon/commit/1200b6e6ce0378740b5d9f81ab7d9ba1de4f54d1))
- **terminal:** track ORIGINAL bytes sent so truncation banner fires once ([fa5fb7f](https://github.com/utensils/aethon/commit/fa5fb7fb72ae8f621251adff47627c4ecd87af1b))
- **themes:** reserve dark/light theme ids for built-ins ([4925dbf](https://github.com/utensils/aethon/commit/4925dbf84b4139b5a0badd44f793475f57892dbd))
- **themes:** use CSSOM setProperty + clean stale style tags ([dc4dc94](https://github.com/utensils/aethon/commit/dc4dc94b8a3f9d6eca3c9c1e33a1bd44d9311b3f))
- **tool-card:** cancel running bash cards on stop ([87a840f](https://github.com/utensils/aethon/commit/87a840fe97e692ac434d33653e6f2a2b6dec7991))
- **tray:** show full-color Aethon logo, not a monochrome template ([a5e4965](https://github.com/utensils/aethon/commit/a5e4965751feca7e9dd297473abf3f1df7516926))
- **tray:** unhide the app before showing the window on macOS ([66b9e86](https://github.com/utensils/aethon/commit/66b9e86e93d8284f4e9580ab6e9205689fa47872))
- **ui:** chat-input visibility + per-project session scoping ([#58](https://github.com/utensils/aethon/issues/58)) ([d9fbab4](https://github.com/utensils/aethon/commit/d9fbab454e55cd4dbde13d356473f1987fedaa15))
- **updater:** expose Check for Updates in non-macOS menus too ([7355b37](https://github.com/utensils/aethon/commit/7355b3700d3336ee5ab7511060a99b670012b77d))
- **updater:** foreground app after update relaunch ([13df577](https://github.com/utensils/aethon/commit/13df5774dcbd9c13325365df402bcf14651b3825))
- **updater:** gate plugin on configured pubkey, surface clear hint when not ([fa7b82d](https://github.com/utensils/aethon/commit/fa7b82d8f7f39f541fb5c2622c9db53ecbe4f564))
- **updater:** stop UpdateBanner floating over the title bar + tab strip ([#131](https://github.com/utensils/aethon/issues/131)) ([fd6899c](https://github.com/utensils/aethon/commit/fd6899c9ca1f45e1a05c20d8e0bd8da129fcd73a))
- use default vite port with strictPort false ([ba8669a](https://github.com/utensils/aethon/commit/ba8669a61f7dd5508541573961cc486b90b392a7))
- use port 1420 with strictPort true, clean up dev script ([663fe45](https://github.com/utensils/aethon/commit/663fe45a6361d6121a4de92378c385ba542ee248))
- use project icons on overview surfaces ([01c707f](https://github.com/utensils/aethon/commit/01c707f776dccbb11e38ef32cfb0efee52b23110))
- **ux:** codex P1+P2 followups + Cmd+` focus + Cmd+0 focus toggle ([#21](https://github.com/utensils/aethon/issues/21)) ([bd15ede](https://github.com/utensils/aethon/commit/bd15ede4af0c38d074daef18f27b548541d83bda))
- **ux:** stop button cancels in-flight prompts; add slash command picker ([02b2150](https://github.com/utensils/aethon/commit/02b215062fbba818543d7b50643b38141094fa97))
- **window:** multi-monitor restore with logical units + v1 migration ([#70](https://github.com/utensils/aethon/issues/70)) ([7319935](https://github.com/utensils/aethon/commit/73199356678c90489e43857cac4e83457a3777fe))
- **worktree:** recover dangling git worktrees from the UI ([#103](https://github.com/utensils/aethon/issues/103)) ([33d86ca](https://github.com/utensils/aethon/commit/33d86cafad6bb6d531897241ce8ac47d0bbf203e))

### Performance Improvements

- **chat:** stop A2UI rows reconciling on every streamed token ([#162](https://github.com/utensils/aethon/issues/162)) ([f510e51](https://github.com/utensils/aethon/commit/f510e51e9e5fe2ee147991f41786123b6e27d265)), closes [#159](https://github.com/utensils/aethon/issues/159)
- **chat:** virtualize the message list with react-virtuoso ([#163](https://github.com/utensils/aethon/issues/163)) ([eea1361](https://github.com/utensils/aethon/commit/eea13610ca8c8a57d933b0b3d30501da32857fc6)), closes [#159](https://github.com/utensils/aethon/issues/159)
- **noise:** gate mDNS advertiser + throttle updater 403s + visibility-gate polls ([#159](https://github.com/utensils/aethon/issues/159)) ([#166](https://github.com/utensils/aethon/issues/166)) ([cf6de66](https://github.com/utensils/aethon/commit/cf6de665845514896891ed91a69670d69906a3ea))
- **projects:** externalize project icons out of projects.json ([#159](https://github.com/utensils/aethon/issues/159)) ([#167](https://github.com/utensils/aethon/issues/167)) ([4227e50](https://github.com/utensils/aethon/commit/4227e5015f4365a58b33be32039a1b883af63dad))

### Refactors

- **agent-process:** split agent_process.rs into submodules ([#123](https://github.com/utensils/aethon/issues/123)) ([51b7664](https://github.com/utensils/aethon/commit/51b7664e4c679cfc4de567185cf73881fe10fcac))
- **agent:** split agent/main.ts into 12 focused modules ([#39](https://github.com/utensils/aethon/issues/39)) ([#54](https://github.com/utensils/aethon/issues/54)) ([60f61af](https://github.com/utensils/aethon/commit/60f61afe796ce8d75a2ce538e51386c73d12bbb3))
- **agent:** split dispatcher command handlers ([e307e4a](https://github.com/utensils/aethon/commit/e307e4a03655685ee3f0bbe64c70069768dace33))
- **app:** collapse App.tsx to thin shell ([#38](https://github.com/utensils/aethon/issues/38)) ([#55](https://github.com/utensils/aethon/issues/55)) ([495fc37](https://github.com/utensils/aethon/commit/495fc374118197a7b4a89c011621f6aed6a1420f))
- **app:** extract App.tsx hooks (Phase 1 progress) ([#35](https://github.com/utensils/aethon/issues/35)) ([bd90c2f](https://github.com/utensils/aethon/commit/bd90c2f444e5ffedfb9f0732bd9dbc5395faa6a6))
- **app:** split frontend orchestration hooks ([#112](https://github.com/utensils/aethon/issues/112)) ([9827319](https://github.com/utensils/aethon/commit/9827319e33ecfb179ac9386a957446b1f94d7e81))
- **app:** split handleAgentMessage into typed handler registry ([#36](https://github.com/utensils/aethon/issues/36)) ([#50](https://github.com/utensils/aethon/issues/50)) ([7fc8871](https://github.com/utensils/aethon/commit/7fc8871afb082bc0d87206d6fa65be0a18853e4d))
- **app:** split onEvent into per-prefix route table ([#37](https://github.com/utensils/aethon/issues/37)) ([#53](https://github.com/utensils/aethon/issues/53)) ([581372a](https://github.com/utensils/aethon/commit/581372a4c34e4462f685b32e5a53616eaa12c286))
- **components:** extract control primitives (Phase 6 [#4](https://github.com/utensils/aethon/issues/4)) ([#47](https://github.com/utensils/aethon/issues/47)) ([7c678f9](https://github.com/utensils/aethon/commit/7c678f9d8ae79895630d0ec277bdb0a88b326c95))
- **components:** extract form primitives + collapse barrel (Phase 6 [#5](https://github.com/utensils/aethon/issues/5)) ([#48](https://github.com/utensils/aethon/issues/48)) ([429f73d](https://github.com/utensils/aethon/commit/429f73dfb2b1afe808d27b2929f2d7d682adaa0f))
- **components:** extract layout primitives (Phase 6 [#3](https://github.com/utensils/aethon/issues/3)) ([#46](https://github.com/utensils/aethon/issues/46)) ([d9ff67f](https://github.com/utensils/aethon/commit/d9ff67f1d7cbc44ab6f0388335ba4961227e7a68))
- **components:** extract media primitives + shared module (Phase 6 [#1](https://github.com/utensils/aethon/issues/1)) ([#44](https://github.com/utensils/aethon/issues/44)) ([14f86c6](https://github.com/utensils/aethon/commit/14f86c66152296591989e73c0d69814b5ec1c783))
- **components:** extract text primitives (Phase 6 [#2](https://github.com/utensils/aethon/issues/2)) ([#45](https://github.com/utensils/aethon/issues/45)) ([e591506](https://github.com/utensils/aethon/commit/e591506c1939a808866a2b9a8e0fe37595cca566))
- **extensions-hydration:** split useExtensionsHydration into per-concern submodules ([#121](https://github.com/utensils/aethon/issues/121)) ([9da3884](https://github.com/utensils/aethon/commit/9da3884189ba75e1af38dc154a124e5cd48cba41))
- **extensions:** rename skill surfaces ([#141](https://github.com/utensils/aethon/issues/141)) ([793f1bc](https://github.com/utensils/aethon/commit/793f1bcd4291e69476a15b73a6efdd179ea056bc))
- **extensions:** rename skill→extension frontend; right-click delete session ([#33](https://github.com/utensils/aethon/issues/33)) ([99e78e4](https://github.com/utensils/aethon/commit/99e78e4351d287e079ece8d7bc708d916c77e979))
- **extensions:** split commands/extensions.rs into seven submodules ([#115](https://github.com/utensils/aethon/issues/115)) ([e5ce3c6](https://github.com/utensils/aethon/commit/e5ce3c6adffb6a460373171c930ea094db5df80b))
- **fs:** split commands/fs.rs into security/listing/watch/io/trash/open ([#114](https://github.com/utensils/aethon/issues/114)) ([9002851](https://github.com/utensils/aethon/commit/9002851d8c268e5618cc76e00bc086939a8f8f98))
- **git:** split command families ([1336a3a](https://github.com/utensils/aethon/commit/1336a3ac0bd7a0d2dc17fe2a49b016e258cd7940))
- **osedges:** split useOsEdges into per-edge subscribers ([#118](https://github.com/utensils/aethon/issues/118)) ([08ab797](https://github.com/utensils/aethon/commit/08ab79796fb12f9ddfff1652a1cf6463fbf5f796))
- **projects:** split project ops hook ([#108](https://github.com/utensils/aethon/issues/108)) ([edd23b1](https://github.com/utensils/aethon/commit/edd23b1012801105f77a83906fc6299fae262ddb))
- **shell:** split lifecycle.rs into registry/open/io/reader/sharing ([#116](https://github.com/utensils/aethon/issues/116)) ([4476e7a](https://github.com/utensils/aethon/commit/4476e7a1b396126baf4a39356b5e51ba9afbf5ec))
- **sidebar:** split file tree panel ([#109](https://github.com/utensils/aethon/issues/109)) ([ed08137](https://github.com/utensils/aethon/commit/ed081374e33bc8da7dfd61162ee623426f9dcd3e))
- **sidebar:** split sidebar root into menu/resize/sections submodules ([#119](https://github.com/utensils/aethon/issues/119)) ([1271522](https://github.com/utensils/aethon/commit/12715224a817ca28af9d128bacef937cfca372b0))
- **skills:** split default-layout/components.tsx per family ([#40](https://github.com/utensils/aethon/issues/40)) ([#51](https://github.com/utensils/aethon/issues/51)) ([608e260](https://github.com/utensils/aethon/commit/608e2606fab82a20dc56ae83d6f914961d2f69b3))
- **tabs:** split useTabs into tabOps/ submodules ([#117](https://github.com/utensils/aethon/issues/117)) ([0760e17](https://github.com/utensils/aethon/commit/0760e17ad1f5564e6e461ced705945ea5862edfa))
- **tauri:** split lib.rs into commands/ submodule (Phase 4) ([#52](https://github.com/utensils/aethon/issues/52)) ([22206ef](https://github.com/utensils/aethon/commit/22206eff27fa48d5444d858915056331207f2842))
- **tauri:** split shell bootstrap modules ([#113](https://github.com/utensils/aethon/issues/113)) ([1658b1e](https://github.com/utensils/aethon/commit/1658b1e72599df67f44caa583b834888a59bdd88))
- **tauri:** split shell.rs into shell/ submodule (Phase 5) ([#49](https://github.com/utensils/aethon/issues/49)) ([63dd66a](https://github.com/utensils/aethon/commit/63dd66a9bf2da8e9dcab37829615ba75beab497c))
- **terminal:** stream bash output via window event, not React state ([626602d](https://github.com/utensils/aethon/commit/626602dec3fb4036b3fa8f01cb07e23af8691dee))
- **ui:** split overlay and prompt boundaries ([e7300ed](https://github.com/utensils/aethon/commit/e7300ed22d76b6e41101b43d2f5738952e562850))
- **voice:** split audio capture pipeline ([#140](https://github.com/utensils/aethon/issues/140)) ([0afa9d4](https://github.com/utensils/aethon/commit/0afa9d40e2ff3b89c8979195c7b65b0fb58ac7aa))
- **wiring-shed-week:** split nine god files into per-concern submodules ([#125](https://github.com/utensils/aethon/issues/125)) ([b70bddb](https://github.com/utensils/aethon/commit/b70bddb66844bb46121116c0be69dc726190487b))
- **worktree-ops:** split worktreeOperations into focused submodules ([#120](https://github.com/utensils/aethon/issues/120)) ([ebde2d4](https://github.com/utensils/aethon/commit/ebde2d421030d7b111405b6ebb163e030dc5e7e8))

## [Unreleased]

### Added

- **First-class Nix devshell support.** Project roots containing
  `flake.nix`, `.envrc` (with `use_flake`/`use_nix` + the `direnv`
  binary), or `shell.nix` now have their devshell environment
  automatically detected, resolved, cached, and applied to every
  interactive PTY shell tab AND the agent's pi `bash` tool — without
  the user having to manually wrap `nix develop`. Same source of
  truth feeds both spawn paths via a single in-memory + on-disk
  cache (`~/.aethon/devshell-cache/<short-hash>/`) keyed on
  `flake.lock` content hash + marker-file mtimes. Cache invalidates
  automatically when the lockfile changes; manual "Refresh now"
  button in Settings. Detection precedence: direnv > flake > shell.nix
  (direnv wins when `.envrc` + the `direnv` binary are present because
  it matches the cached env users already see at the CLI). Configurable
  via a new `[devshell]` section in `config.toml` (`enabled = auto |
always | never`, `mode = auto | direnv | nix | nix-shell`,
  `cache_ttl_hours`, `refresh_on_lockfile_change`) and a per-project
  override at `<project>/.aethon/devshell.toml`. Status badge `⬡ <kind>`
  in the status bar shows resolving/ready/failed/off state. Agent-side
  is wired via a `customTools` `bash` entry that shadows pi's built-in
  through pi's tool-registry later-wins-by-name rule and attaches a
  synchronous `BashSpawnHook` that consults a process-local cache
  (warmed via a new `devshell_query` bridge IPC; invalidated by
  `devshell-ready`/`devshell-failed` push events forwarded from
  the frontend). The resolver runs in a `tokio::task::spawn_blocking`
  task with shared notify so concurrent shell opens collapse onto the
  same in-flight `nix print-dev-env --json`. New IPC: `devshell_status`
  (non-blocking snapshot for the badge), `devshell_env_for_path`
  (non-blocking env lookup for the spawnHook), `devshell_refresh`
  (invalidate + re-resolve). 49 unit tests cover detection, resolver
  parsing, cache fingerprint, env merging, and the bridge handler;
  live UAT confirms non-interactive `/bin/sh -c` shells pick up
  `CARGO=/nix/store/.../cargo`, `IN_NIX_SHELL=impure`,
  `DEVSHELL_DIR=/nix/store/...`, and the resolved 168-var PATH.
- **`aethon-debug` skill gained user-gesture automation primitives.**
  New scripts under `.claude/skills/aethon-debug/scripts/` —
  `debug-invoke.sh` (generic Tauri-command runner),
  `debug-shell-{spawn,write,read,close}.sh` (open / write to / read
  / close a PTY tab the way a user would, bypassing share-mode for
  read/write so private-mode policy doesn't have to be relaxed for
  UAT), `debug-devshell.sh` (status/env/refresh against the active
  project), `debug-agent-new-tab.sh` (create an agent tab pinned to
  a cwd), `debug-chat-{send,wait}.sh` (drive the agent and block
  until the response lands). Two new `cfg(debug_assertions)` Tauri
  commands back the PTY scripts: `debug_shell_snapshot` (dump
  cwd/command/share/scrollback regardless of share-mode) and
  `debug_shell_write_raw` (push input regardless of share-mode).
  Skill `SKILL.md` updated with a UI-automation-primitives section.

### Changed

- **Vite dev server no longer crashes the webview's Tauri IPC on
  `.direnv` writes.** `vite.config.ts` now excludes `.direnv/`,
  `target/`, `src-tauri/target/`, and `node_modules/` from its file
  watcher. Previously the Nix `flake-inputs` mirror under `.direnv/`
  contained stray `tsconfig.json` files that Vite's tsconfig probe
  picked up, triggering a "changed tsconfig file detected — full
  reload" cascade that dropped the Tauri IPC custom protocol mid-call
  ("IPC custom protocol failed, Tauri will now use the postMessage
  interface instead"). UAT and live debugging now stay hermetic.
- **Internal architecture docs updated.** Repository and bundled docs now
  reflect the split overlay modules (`src/hooks/uiOverlays/*`), the
  extracted system-prompt template/types (`agent/system-prompt/*`), and
  the current extension-package naming for `~/.aethon/extensions/node_modules/`.

### Fixed

- **Dangling worktrees are recoverable from the UI.** When a git worktree
  was pruned externally (manual `git worktree remove`, crashed `add`),
  Aethon's projects.json kept the row but every git invocation in the
  dir failed — the landing card mislabeled it as "No GitHub remote
  detected" and the delete button bounced with "worktree not tracked".
  The `gh_branch_status` IPC now carries an explicit `worktreeBroken`
  flag (set via a hermetic `.git`-marker check before any git/gh
  shell-out), the landing renders a "no longer tracked by git" message
  instead, and `removeWorktreeById` falls through to a new
  `git_worktree_remove_orphan` Rust command that validates the path
  points into this project's `.git/worktrees/` before trashing the
  leftover folder. `migrateProjects` also clears a dangling
  `activeWorktreeId` at load so a freshly-restarted app doesn't land
  on a dead worktree.
- **Extension watcher follows cross-project worktree activation (peer-review P2).**
  `activateWorktree` previously changed `activeId` directly when the
  selected worktree belonged to a different project, bypassing the
  unwatch/watch swap that `setActiveProjectById` does. The previous
  project's `.aethon/extensions/` watcher kept firing while the new
  project's never installed, so hot-reload silently broke until a
  later full project switch. The swap is now mirrored in
  `activateWorktree` whenever the active project id changes.
- **Restored sessions preserve in-flight messages chronologically (peer-review P2).**
  `handleSessionHistory`'s merge prepended pending local user prompts
  ABOVE the restored transcript and dropped any in-flight assistant
  streaming deltas entirely (the role filter only kept user messages).
  Restored transcript now lands first, with pending local messages —
  user prompts AND streaming assistant bubbles — appended after, so
  ordering stays chronological and live output isn't wiped mid-stream.
- **Session tab rename focus.** Tab context-menu rename inputs now keep focus
  while an agent is running and streaming state updates, so session names can
  be edited without interruption.

## [0.3.3] - 2026-05-25

### Added

- **Queued messages popover + steering (Claudette-style).** Messages typed
  into the composer while the agent is busy now go to a client-held queue
  rendered as a popover above the textarea instead of straight to pi's
  `followUp`. Each queued row carries Edit / Steer / Delete affordances,
  the header offers `Clear queue`, and a new `useQueuedDispatch` hook
  drains the head on every idle transition. Cmd/Ctrl+Enter on the composer
  still ships the current draft as a mid-turn steer.
- **Inline extension toggle.** Each row in the sidebar's `extensions`
  section now renders a pill-shaped toggle switch — flip an extension
  on or off in one click without diving into the right-click menu or
  the settings panel. The same toggle replaces the Enable/Disable text
  button inside the settings panel's Extensions list for visual
  consistency. Failed-to-load extensions render the switch in a muted
  disabled state.
- **Extension origin always visible + grouped.** The sidebar's
  extensions list now splits into two per-origin sub-sections
  (`project extensions`, `user extensions`) that act as visible
  dividers; empty buckets hide. Project-scoped npm packages
  (`@<project>/<ext>` where the scope matches the active project's
  basename) fold INTO the project bucket, while unrelated-scope or
  bare-name packages stay in the user bucket — so `@mold/image-
gallery-ui` reads as a project extension under `mold`, but
  `@brink/current-context-widget` stays user-level. Rows are sorted
  alphabetically within each group, and each row's hint (`project ·
disabled`, `user · disabled`) preserves origin even when toggled
  off. The group title is always qualified — single-bucket states
  still read `user extensions` rather than a bare `extensions`, so
  scope is never ambiguous. Auto-injection skips when an extensions
  section is declared explicitly in layout JSON, preserving the
  override path for skills that ship custom rendering.

### Changed

- **`response_end` no longer preserves `waiting` for queued sends.** Pi's
  `followUp` queue is unused on the new client-held queue path; clearing
  `waiting` on every turn end is what lets `useQueuedDispatch` see the
  idle moment and pop the next message.

### Fixed

- **Queue auto-drain reaches the bridge (peer-review P1).** The
  optimistic `waiting=true` write inside `useQueuedDispatch` was
  synchronously visible to `sendChat`, which treated the freshly
  popped message as a new busy-state submit and re-queued it with a
  new id, never invoking `send_message`. The drain now pops the head
  only and lets `sendChat`'s normal-dispatch path flip `waiting` —
  pop + dispatch setStates batch into one commit so there's still no
  Send-button flash. Regression test added.
- **Stop clears the client queue (peer-review P2).** `stopPrompt`
  now empties the per-tab `queuedMessages` array before sending the
  bridge `stop` command, so a user who hits the composer's
  "Stop + clear" button actually clears the queue instead of letting
  the next queued message drain on the following idle.
- **Issue worktree task launches.** GitHub issue send-to-agent now targets
  the newly-created task tab explicitly when forwarding the issue prompt,
  so the first agent session starts in the fresh worktree and the sent
  prompt appears in that tab's transcript instead of leaking to the main
  project context.

## [0.3.2] - 2026-05-25

### Fixed — Patch release

- **Release reload loop fixed.** Bridge `ready` payloads now include the
  current project cwd, and frontend hydration only re-announces the active
  cwd when it differs. This prevents a release-session loop where
  `ready` handling could repeatedly reload project resources, lag the app,
  and leave the webview blank until a manual reload.
- **Tab restore made idempotent.** Ready hydration no longer replays
  `tab_open` for non-default tabs that the bridge already reported, avoiding
  duplicate session restore churn after respawns and reloads.
- **Reload snapshots bounded.** Session UI snapshots now sanitize terminal
  buffers on load and save, keeping only the latest bounded entries so an
  oversized saved shell transcript cannot make release recovery sluggish.

## [0.3.1] - 2026-05-25

### Fixed — Patch release

- **Top tab strip restored.** The workstation layout now gives tabs a
  dedicated grid row below the header controls, matching the Claudette-style
  chrome shape and preventing model / appearance controls from covering
  session tabs.
- **Stale layout snapshots repaired on ready.** Bridge `ready` hydration now
  normalizes the default workstation grid back to the canonical
  header / tabs / canvas / terminal / composer / status rows, so older
  persisted layout state cannot auto-place tabs at the bottom or hide them.
- **File tree expansion is stable across refreshes.** Directory refreshes
  now merge fresh filesystem listings with the existing tree by path, keeping
  expanded descendants loaded and visible instead of collapsing immediately
  after expansion.
- **Files sidebar resize restored.** The right files sidebar now keeps the
  canonical workstation areas through resize, terminal toggles, layout prefs,
  and session restore, preventing Monaco/editor tabs from shifting or growing
  the sidebar unexpectedly.

## [0.3.0] - 2026-05-24

### Added — Workstation layout redesign

- **Design tokens.** New `src/styles/tokens.css` introduces shape vocabulary
  (`--space-*`, `--radius-*`, `--shadow-*`, `--z-*`, `--opacity-*`,
  `--ease-*`) on top of the existing typography + motion scale. Each
  theme block (ember, paper, aether/signature, brink) gains interaction
  colors (`--bg-hover`, `--bg-active`, `--bg-selected`, `--border-hover`,
  `--border-strong`, `--text-on-accent`) and per-theme shadow tokens.
  `src/styles.css` was split into `tokens.css` + `themes.css` + `chrome.css`
  - `index.css`.
- **Shared `ContextMenu` primitive.** `src/components/primitives/context-menu.tsx`
  replaces the two ad-hoc inline portal menus (sidebar, file tree) with a
  keyboard-navigable, viewport-clamped, focus-trapped menu. Separator /
  header / note item kinds + danger styling. The old
  `.a2ui-sidebar-context-menu` and `.ae-file-tree-context-menu` selectors
  stay aliased so extensions that styled them keep working.
- **Text-selection policy.** `docs/aethon-agent/text-selection.md` codifies
  chrome=none, content=text, with an opt-in `data-selectable` attribute
  for path-like strings inside chrome surfaces.
- **Project + worktree backend.** Rust commands `git_worktrees`,
  `git_worktree_add`, `git_worktree_remove`, `git_branch_list` (in
  `src-tauri/src/commands/git.rs`) with cargo tests covering the
  porcelain parser and an end-to-end add/remove round trip in a
  temporary repo. Frontend model `src/worktrees.ts` owns the
  `Worktree` shape + pending-state machine.
- **Worktree-aware sidebar.** Projects expand to show their worktrees
  inline. Pending worktrees render with live `queued → starting →
succeeded | failed` UI + cancel / retry / dismiss inline actions.
  Right-click on a project opens Switch / Create worktree / Open in
  Finder / Copy path / Rename / Remove; right-click on a worktree opens
  Switch / Open in Finder / Copy path / Rename / Remove (main worktree
  removal is guarded).
- **Material Icon Theme file icons.** ~50 SVGs vendored under
  `src/file-icons/icons/` (PKief/vscode-material-icon-theme, MIT). The
  file tree's ASCII triangles are replaced with real per-language icons
  (TypeScript blue, Rust orange, Python yellow, …) via `<FileIcon>`.
  Folder icons get open/closed variants.
- **Reveal / Open shell integration.** Rust commands
  `fs_reveal_in_file_manager`, `fs_open_in_file_manager`,
  `fs_open_in_default_app` hook the file-tree context menu's "Reveal in
  File Manager" and "Open with default app" actions on macOS / Linux /
  Windows.
- **Empty state hero.** EmptyState renders a 64px AeMark monogram above
  the welcome card with a `--shadow-2` elevation, putting more visual
  weight on the first-launch surface.
- **Status bar project / worktree chip.** A new chip between the status
  pill and connection text surfaces the active project label, the active
  worktree's branch (or the parent project's git branch when no worktree
  is selected), and a dirty-state warn dot.
- **Version sync guard.** `package.json` is the app-version source of
  truth. `bun run version:sync` updates the npm lockfile, Tauri config,
  Cargo manifest, and Cargo lockfile, while `bun run version:check` is
  wired into CI/release checks so the sidebar chip, app metadata, and
  Rust crate version stay aligned.

### Changed — Workstation layout redesign

- **Sidebar sections trimmed.** `themes` section dropped from the
  default sidebar payload — themes remain accessible via the header
  AppearanceMenu. Custom layouts can re-add the section by listing it
  in the sidebar's `sections` array.
- **Projects state.** `~/.aethon/projects.json` upgraded to
  schemaVersion 2 with `activeWorktreeId` + `worktreesByProject` fields.
  Pending-in-flight worktrees are filtered out at save time;
  failed pending entries persist so the user can Dismiss them next
  session. Migration is idempotent and survives malformed files.
- **Worktree creation defaults.** New worktrees now fork from
  `origin/main` by default, with a per-project "Set worktree base..."
  override. The task launcher also respects the project default unless
  the user chooses an explicit base branch.
- **Issue branch naming.** Sending a GitHub issue to the agent now
  chooses the branch prefix from the issue title or labels: conventional
  titles such as `feat(admin): ...` win, labels such as `bug`, `docs`,
  `performance`, or `dependencies` provide fallback signals, and unknown
  issue work still falls back to `fix/`.

### Fixed — Worktrees, issues, and hot reload

- **New worktree navigation.** Creating a worktree now activates and
  navigates to the newly-created worktree instead of leaving the user on
  the project root.
- **Issue send-to-agent isolation.** "Send to agent" always creates a
  fresh worktree before opening the task tab, so issue work no longer
  lands in the project root by accident.
- **Project worktree-base menu.** The sidebar's "Set worktree base..."
  action now uses an inline menu input instead of a native prompt, so it
  works reliably in the Tauri webview.
- **Task-launcher menu dismissal.** Worktree/base-branch chip menus now
  close on outside focus changes and Escape.
- **Frontend hot reload state.** JS/TS HMR updates now persist the
  session snapshot and reload the app shell, preventing stale global
  hotkey/event-route listeners from surviving Fast Refresh. CSS-only
  updates still hot-swap normally.

### Compatibility notes

- New token vars (`--bg-hover`, `--space-*`, etc.) give extensions a
  richer per-theme override surface.
- Extensions that registered themselves against the `themes` sidebar
  section ID are unaffected (the data path `/sidebar/themes` still
  populates).
- Chrome composite type strings are unchanged — registering an override
  via `aethon.registerComponent(type, fn)` continues to work.

## [0.2.0] - 2026-04-28

### Changed

- Promoted the first public release line from the placeholder `0.1.0`
  tag to `0.2.0`.
- Release CI now publishes signed macOS updater artifacts, Linux `.deb`
  and `.rpm` installers, Windows x64 NSIS setup executables, and the Rust
  crate to crates.io. The workflow yanks placeholder crate version `0.1.0`
  after `0.2.0` publishes.

## [0.1.0] - 2026-04-28

### Added

- **Test coverage scaffolding.** Cargo unit tests under
  `src-tauri/src/helpers.rs` cover `validate_state_name`,
  `parse_config_toml`, and `clamp_font_size` (14 cases). Vitest covers
  `utils/jsonPointer`, `utils/dataBinding`, `slashCommands`, and the
  layout-slot catalogue / inspector (53 cases, ~95% coverage on those
  modules). Both wired into the new `test` and `coverage` devshell
  commands.
- **ESLint with type-aware rules + react-hooks plugin.** Frontend +
  agent linted via `bunx eslint .` with 0 errors and a small set of
  tracked warnings (`react-hooks/set-state-in-effect`, `react-hooks/refs`,
  `react-refresh/only-export-components`) flagging known anti-patterns
  in `App.tsx` / `ChatInput` / `registry.tsx` to address in a follow-up.
- **`check` devshell command runs the full CI gate** — clippy + tsc +
  eslint + cargo test + vitest, in order, fail-fast.
- **GitHub Actions CI** (`.github/workflows/ci.yml`) — runs the same
  gate on push / PR across `ubuntu-24.04` + `macos-15`. TS job needs
  Bun only; Rust job pins toolchain `1.92.0`, installs the GTK/WebKit
  closure on Linux, and reuses `Swatinem/rust-cache`.
- **Extension-deletion UI cleanup.** Bridge tracks
  `extensionStateKeys: Set<string>` of every JSON Pointer path written
  via extension `setState`, reports the list in `ready`. Frontend keeps
  a ref of the previous ready's set; on each new ready, paths in
  (previous − new) are deleted from live state via a new
  `deletePointer` helper. So uninstalling an extension wipes its
  sidebar section / canvas card / state slice without a page reload.
- **Cargo helpers extracted for testability.** `validate_state_name` +
  `parse_config_toml` + `clamp_font_size` moved out of `lib.rs` into
  `src-tauri/src/helpers.rs` so they can be unit-tested without a
  Tauri `AppHandle`. `read_config` now also clamps `[ui] font_size` to
  [10, 24] and warns on out-of-range values.
- **`globalThis.aethon.getLayoutSlots()`** documented in `api.md` —
  the bridge-side accessor for the canonical slot catalogue (matching
  the existing `window.aethon.layoutSlots` on the frontend).

### Changed

- **README.md beautified.** Categorized feature list (Workspace /
  Agent-controlled UI / Extensibility), expanded devshell command table
  with `lint` / `test` / `coverage`, larger architecture diagram with
  layer responsibility table, link out to `docs/aethon-agent/`.
- **Hero SVGs redesigned.** `assets/brand/aethon-hero-{dark,light}.svg`
  now render the wordmark as a single text element (robust kerning
  across font fallbacks), with a properly-anchored π badge over the
  upper-right serif of the Æ. Larger viewBox (960×240) for clean
  rendering at typical README widths.
- **CLAUDE.md status section** updated to reflect M1–M5 completion +
  test/lint stack.

- **Extension lifecycle feedback.** Bridge now emits a generic
  `extension_lifecycle` event for every extension load (`{name, source,
status: "loaded"|"failed"|"skipped", error?, path}`) from
  `loadAethonExtensions` and `loadAethonExtensionPackages`. The frontend
  dispatches a cancellable `aethon:extension-lifecycle` CustomEvent on
  `window`, then (if not preventDefault'd) appends a system-notice chat
  bubble — so the user gets confirmation even when the agent's chat
  reply was eaten by a hot-reload respawn it triggered itself. Channel
  is decoupled: any layout / extension can listen on the window event
  and call `e.preventDefault()` to swap the default chat bubble for a
  toast / sidebar pulse / status pill / etc., no source patches needed.

- **Layout-slot contract.** `src/extensions/default-layout/slots.json` now
  declares the canonical slot catalogue any layout can adhere to:
  `header`, `sidebar`, `tabs`, `canvas` (required), `terminal`,
  `composer` (required), `status`, `empty-state`. Each entry carries a
  description, a `defaultComposite` type, and a `required` flag.
  Composites slot via their existing `area` prop; the `Layout` component
  honors an optional `slotMap` on the root `<layout>` so a non-canonical
  layout can still host the standard composites (e.g. `slotMap:
{ composer: "bottom-bar" }`). All three built-in layouts (default,
  single-pane, focus-mode) updated to use the canonical slot names —
  `chat-input` area was renamed to `composer`. Catalogue exposed on
  `window.aethon.layoutSlots` (with `inspectLayoutSlotCoverage(payload?)`
  helper for tooling) and on the bridge as
  `globalThis.aethon.getLayoutSlots()`. Bridge reads it synchronously at
  boot from `$AETHON_LAYOUT_SLOTS_FILE` (set by the Tauri shell, bundled
  as a release resource) and surfaces it in `RuntimeSnapshot.layoutSlots`
  so the system prompt prints the canonical slot list. Documented under
  "Layout-slot contract" in `docs/aethon-agent/components.md` with a
  `slotMap` example.

- **Config file dead options wired up.** `~/.aethon/config.toml` `[ui]
font_size` now writes the `--app-font-size` CSS custom property
  (clamped 10–24 px) consumed by `body { font-size: var(--app-font-size,
14px); }`. `[agent] model` seeds the picker default when no per-session
  model is saved (bridge's session model still wins on `ready`
  hydration).
- **Pluggable `onEvent` routing — intercept built-in handlers.**
  New `aethon.registerEventRoute({componentId?, eventType?})` and
  `aethon.unregisterEventRoute(...)`. When the renderer fires an event
  matching a registered route, App's onEvent callback skips the built-in
  switch (chat-input submit, sidebar select, tab actions, etc.) and
  forwards the event through `a2ui_event` so a paired
  `aethon.onEvent({componentType, descendantId})` handler can intercept.
  Wildcard form: omit `componentId` (matches any component for that
  eventType) or `eventType` (matches all events from a component).
  `aethon.listEventRoutes()` returns the registered intercepts.
  Replayed on `ready`. Surfaced in `RuntimeSnapshot.eventRoutes`.
- **Registerable menu items.** New `aethon.registerMenuItem({label,
action, location?, id?, parent?})` and `unregisterMenuItem(id)`.
  Bridge ships `extension_menu_items` events; the frontend forwards to
  a `set_extension_menu_items` Tauri command which rebuilds the native
  App menu (extension entries appear under an "Extensions" submenu)
  AND the tray menu. Click events emit `menu` events with id
  `ext:<action>` which the frontend dispatcher routes via `a2ui_event`
  so a paired `aethon.onEvent({componentType: "menu-item",
descendantId: "<action>"})` matcher fires. Replayed on `ready`.
- **Vite-style port auto-increment for `dev`.** New `scripts/dev.sh`
  wrapper finds a free Vite port (starting 1420) and a free debug
  port (starting 19433), writes them to `~/.aethon/dev-info.json`,
  exports `VITE_PORT` + `AETHON_DEBUG_PORT`, and overrides Tauri's
  `devUrl` via `$TAURI_CONFIG`. The `flake.nix` `dev` command now
  exec's the wrapper. The aethon-debug skill reads `dev-info.json` so
  it follows the chosen ports automatically. A leaked 1420 from a
  prior run no longer breaks the next session.
- **Compositional terminal subscription.** Bash output now lands in
  three places: `/terminal/buffer/<tabId>` state path (bindable via
  `$ref`), the existing `aethon:terminal` window event (active tab,
  feeds xterm), and the new `aethon:terminal-tap` window event
  (every tab, multi-subscriber, `detail = {tabId, content}`).
  Logging extensions / alternative renderers no longer have to
  monkey-patch a single-subscriber listener.

### Fixed

- **Handler setState attribution under concurrent prompts.**
  `dispatch_a2ui_event` now wraps handler dispatch in
  `tabContext.run(handlerTabId, …)` so any setState a handler fires
  (or any microtask continuation it kicks off) inherits the
  originating tab via AsyncLocalStorage — even when another tab's
  prompt is concurrently in flight.

### Added

- **Layout catalogue.** `default-layout` skill now ships three built-in
  layouts:
  - `default` — sidebar / header / canvas / terminal / chat / status
  - `single-pane` — no sidebar, header + canvas + chat across full width
  - `focus-mode` — just canvas + chat + status bar
    New `window.aethon.listLayouts()`, `window.aethon.activateLayout(id)`,
    and `window.aethon.registerLayout({id, name, payload})` form the
    catalogue API. New `/layout <id>` slash command swaps to a registered
    layout (`/layout` with no args lists available ids).
- **Sidebar opt-in via `/layout/sidebarVisible`.** The default layout
  binds the sidebar's `visible` flag plus `/layout/columns` and
  `/layout/areas` to state so the grid template-areas adapts when the
  sidebar hides — no dead 240px column. New `/sidebar` slash command +
  `toggleSidebar` slash context method flip all three keys atomically.
- **Multi-tab restore via empty-state recent sessions.** Bridge walks
  `~/.aethon/sessions/` at boot, returns `[{tabId, lastModifiedMs}]`
  sorted by last-modified, ships as `discoveredTabs` in the `ready`
  payload. Frontend filters out currently-open tabs, formats relative
  timestamps ("2m ago", "yesterday"), and pushes the list into
  `/recentSessions`. The empty-state composite (visible when all tabs
  are closed) renders the list as clickable rows. Clicking restores
  the persisted session by reusing the same `tabId` so
  `SessionManager.continueRecent` resumes the LLM history. Auto-restore
  on launch (without clicking) tracked as a follow-up.
- **A2UI primitives expanded.** New built-in components the renderer
  always understands: `heading` (level 1-6), `paragraph`, `divider`
  (horizontal/vertical), `checkbox`, `select` (`options` accepts
  inline arrays or `$ref`), `slider` (numeric range), `list`
  (ordered/unordered, per-item template with `/$item` scope), `table`
  (header + columns with optional per-cell templates seeing `/$row`).
  Brings the renderer to 15 standard primitives. Bundled docs
  (`components.md`) ship the schemas; system prompt's primitive list
  updated.
- **Compositional sidebar items.** Each `SidebarItem` can carry
  `componentType`. When set, the sidebar resolves it through the
  ExtensionRegistry and renders the registered template per row with
  `/$item` (the full item object), `/$index` (position), and
  `/$parent` (surrounding state) available to nested `$ref`s — same
  scope keys as the `for-each` primitive. New
  `BuiltinComponentProps.renderChildWithState(child, overlay)` exposes
  the renderer's scoped expansion to composites. Click semantics
  unchanged (`select` event with `{sectionId, itemId}` + descendantId).
- **Registerable keyboard shortcuts.** New
  `aethon.registerKeybinding({combo, action?, description?})` and
  `aethon.unregisterKeybinding(combo)`. Combos accept any human-readable
  form (`Cmd+Shift+P`, `Ctrl+]`, `Alt+M`, `Meta+M`); frontend normalizes
  to a canonical lowercased "+"-joined key (`meta+shift+p`) for matching.
  Pair with `aethon.onEvent({componentType: "keybinding", descendantId:
"<canonical-combo>"}, handler)` to wire the action — the dispatched
  event carries `data.action` and `data.combo`. Built-ins (Cmd+T /
  Cmd+] / Cmd+[ / Cmd+W / Cmd+\`) win on collision; extensions can ADD
  shortcuts but cannot override built-ins yet. Replayed on `ready` so
  reload restores the bindings; surfaced in
  `RuntimeSnapshot.keybindings` and the system-prompt runtime section.
- **Registerable slash commands.** New
  `aethon.registerSlashCommand({name, description, usage?})` records
  command metadata; pair with `aethon.onEvent({componentType:
"slash-command", descendantId: "<name>"}, handler)` to wire the
  action (handler receives `event.data.args`). Names must match
  `/^[A-Za-z][\w-]*$/` and may not collide with built-ins
  (`clear`, `help`, `theme`, `model`, `reset`, `terminal`, `skills`).
  Frontend merges extension commands with built-ins for the chat-input
  picker; invocations dispatch through the existing `a2ui_event` route
  so per-tab attribution + handler dedup work uniformly. Replayed on
  `ready` so reload restores the picker. Surfaced in
  `RuntimeSnapshot.slashCommands` and the system-prompt runtime section.
- **Loose-file theme directory.** `~/.aethon/themes/*.json` files are now
  loaded at boot via the same `normalizeTheme` validation path as
  extension-supplied themes. Each file is `{ id, label?, vars: { "--bg":
"...", ... } }`. Watcher pre-creates the directory and watches it for
  hot reload — drop a JSON file and it appears in the sidebar Themes
  section without restarting. Lowest-friction way for end users to ship
  a theme.
- **`RuntimeSnapshot.layoutStructure`.** Structural summary of the active
  layout — root id/type, grid columns/rows/areas, flat child list with
  ids/types/areas. Saves the agent a `getLayout()` round-trip for basic
  introspection. Rendered as a one-liner in the system-prompt runtime
  section.

### Changed

- **`chat-input` chrome lifted to props.** New `sendLabel`, `stopLabel`,
  `stopTitle`, `queueBadgeFormat` (with `{n}` placeholder for queue
  count). All accept `$ref`s. Defaults preserve existing UX.
- **`main-canvas` empty hint lifted to `emptyHint` prop** (StringValue).
- **`terminal` chrome lifted to props.** New `headerLabel` (default
  "Aethon Terminal") and `bootGreeting` (default "Aethon Terminal\r\n$ ",
  re-applied on tab-switch replay). Extensions changing brand voice no
  longer need to fork the composite.

### Added

- **`for-each` template primitive.** Renders one copy of `children` per
  element of `props.items` (resolved through `$ref` against the surrounding
  state). Optional `props.key` selects a field on each item to use as
  the React reconciliation key. Three special keys are injected into the
  per-iteration state for nested `$ref`s: `/$item` (current element),
  `/$index` (position), `/$parent` (surrounding state). Child ids are
  suffixed with `__$idx<n>` so React keys stay stable across N
  iterations. Replaces the "regenerate the subtree on every mutation
  via patchLayout" pattern for dynamic lists (model picker filters,
  search results, log tails). Documented in bundled docs
  (`components.md`) and the system prompt.
- **Empty-state composite when the last tab closes.** `closeTab` no
  longer guards against closing the only/default tab — every tab is
  closable. When the tab list reaches zero the layout swaps to an
  `empty-state` composite (welcome card, "New Tab" button, quick-start
  tips, recent-sessions slot) registered by the `default-layout` skill
  (NOT hardcoded React in `App.tsx`). Extensions can override it by
  re-registering the `empty-state` component type. Layout JSON owns
  the visibility wiring via `/empty` and `/hasTabs` `$ref` flags. Bridge
  `tab_close` now accepts the default tab and gracefully handles an
  empty `tabs` map; `currentAgentTabId` is cleared and `ensureTab`
  lazily recreates whatever tab the next inbound message references.
- **Bridge-readable frontend state.** Frontend pushes
  `frontend_state_patch { path, value }` whenever an allowlisted slice
  changes — `/sidebar/models`, `/sidebar/themes`, `/connection`, `/status`,
  `/tabs`, `/draft`, `/messagesCount`. Bridge stores in `frontendState`
  Map. New introspection method `aethon.getFrontendState(path?)` returns
  the live value (or full map). `getRuntimeSnapshot().uiState` exposes
  the full mirror so the system prompt + `~/.aethon/state.json` reflect
  what's actually on screen, not just what extensions wrote via setState.
  Diff-on-frontend keeps IPC chatter low (one patch per slice per change).
- **Mutation feedback channel.** Every mutating outbound bridge → frontend
  message (`state_patch`, `layout_set`, `layout_patch`,
  `extension_components`, `extension_themes`) now carries a `mutationId`.
  The frontend acks via `mutation_ack { mutationId, success, error? }`,
  and the bridge resolves a per-mutation Promise so the public API
  (`aethon.setState`, `aethon.setLayout`, `aethon.patchLayout`,
  `aethon.registerComponent`, `aethon.registerTheme`,
  `aethon.registerSidebarSection`) returns `Promise<{ok: boolean,
error?: string}>`. Backwards compatible: sync callers ignore the
  Promise and behave exactly as before. Failure modes: `timeout` (5 s
  no ack), `frontend_rejected: <detail>`, bridge-side validation. Calls
  made before the frontend has reported `ready` resolve immediately
  with `{ok: true}` so register-time awaits don't block on the cold-start
  webview. System prompt + bundled docs (`docs/aethon-agent/api.md`)
  document the contract.
- **`eventHandlers` in `RuntimeSnapshot` and `~/.aethon/state.json`.**
  Match-shape only (templateRootType / componentType / descendantId /
  eventType) — no function bodies, so the snapshot stays small and
  serializable. Surfaced in the system prompt's runtime section so the
  agent can answer "what onEvent handlers are wired?" without invoking
  JS or scraping the registry.
- **`BuiltinComponentProps.onEvent` 3rd-arg `descendantId`.** Composites
  that render their own per-row controls (sidebar items, list rows) can
  emit events tagged with a stable child id. The renderer rewrites the
  outbound componentId to `<host>__tpl__<descendantId>` so the bridge's
  existing `__tpl__` parser populates `match.descendantId` exactly as it
  does for template-expanded children. Fixes the documented sidebar
  matcher recipe (`{componentType:"sidebar", descendantId:"open-readme"}`)
  that previously never matched.
- **System-prompt section: "A2UI templates do not iterate arrays."**
  Until the `for-each` primitive lands, the prompt explicitly tells the
  agent that dynamic lists require regenerating the subtree on each
  mutation via `patchLayout`, with a worked example. Saves a debugging
  round-trip when the agent tries to bind a `$ref` to an array of
  children.

### Changed

- **`button` fires `click` unconditionally** (no longer gated on the
  `props.onClick` flag, which has been removed from the schema). Disabled
  buttons remain inert. Agent-authored buttons that follow the bundled
  docs now actually emit events on click.
- **Handler `ctx.pi.prompt` errors emit `notice`, not `error`.** Sending
  `error` from a failed handler-prompt was clearing the frontend's
  `waiting` flag and hiding the Stop button on whatever turn the user
  actually had running. Notice is non-terminal so the surrounding turn's
  UI stays intact; the error still rethrows so the calling handler sees
  it.
- **`registerComponent` accepts both bare and wrapper template shapes.**
  Bridge auto-unwraps `{components:[<single component>]}` to the single
  component the renderer expects. Docs (`api.md`) updated to show the
  bare-component form as canonical; wrapper form remains for back-compat
  with existing extensions.

### Added

- **`getLayout()` returns the active rendered layout.** Bridge now
  preloads the canonical boot layout synchronously from
  `$AETHON_BOOT_LAYOUT_FILE` (set by the Tauri shell, pointing at the
  default-layout JSON in dev or the bundled resource in release) BEFORE
  any extension's `register(api)` runs. `_getLayout()` returns
  `extensionLayout ?? (bootLayout + pendingLayoutPatches folded)` so
  extensions inspecting at register-time see the real tree, not `null`.
  Closes the release-mode bug where `right-sidebar-model-picker` bailed
  out on its first line because `api.getLayout()` returned null. Boot
  layout is now also a Tauri bundle resource so release builds get it.
- **`AETHON_BOOT_LAYOUT_FILE` env var** added to the bridge contract
  alongside `AETHON_DOCS_DIR` etc.
- **`boot_layout` inbound bridge message** lets the frontend refresh
  the bridge's view of the boot layout when the active layout skill
  changes (skill swap → new boot tree).

### Changed

- **`~/.aethon/state.json` now updates on `onEvent` registration** so
  the snapshot reflects newly-wired handlers, not just registered
  components/themes/layouts.
- **`~/.pi/agent/extensions/` is pre-created on boot** so a first-time
  pi extension drop fires Create events and hot-reloads without a
  manual app restart (parity with `~/.aethon/extensions/`).

- **Persistent per-tab pi sessions.** Each tab uses
  `SessionManager.continueRecent($AETHON_SESSIONS_DIR/<tabId>)` instead
  of `inMemory()`, so the model's conversation history survives bun
  restarts (file-watcher in dev, app relaunch in release). Closes the
  "I have no context from a previous session" gap that surfaced when
  the bridge respawned mid-conversation.
- **Live runtime snapshot in the agent's system prompt.** Bootstrap
  reordered so extensions load **before** the default tab — pi's
  `appendSystemPromptOverride` callback then sees a fresh
  `getRuntimeSnapshot()` (loaded extensions, themes, custom A2UI
  components, layout summary, open tabs) and bakes it into the first
  session's prompt. The agent can answer "what extensions are loaded?"
  on its first turn without scraping the filesystem.
- **Bundled reference docs.** `docs/aethon-agent/{api,components,extensions}.md`
  ship inside the binary via `tauri.conf.json` `bundle.resources`, and
  the spawn env exports `AETHON_DOCS_DIR` so the system prompt and
  agent `read` calls reach them in any build mode.
- **`~/.aethon/state.json` live snapshot.** Bridge writes the full
  runtime registry (extensions, themes, components, layout summary,
  tabs) to disk debounced 200 ms on every register\* call. The system
  prompt instructs the agent to `cat $AETHON_STATE_FILE` for an
  always-fresh view.
- **Introspection methods on `globalThis.aethon`.** `listExtensions`,
  `listComponents`, `listThemes`, `getLayout`, `getRuntimeSnapshot`
  give the agent in-process queries over the same data the state file
  exposes.
- **Pi extension discovery.** `discoverPiAethonExtensions` greps
  `~/.pi/agent/extensions/*.{ts,js,mjs}` for `globalThis.aethon` /
  `aethon.register` references and lists the matches in the runtime
  snapshot tagged `pi-extension`. Pi loads them itself; we just record
  their existence so the agent's "what's loaded?" answer covers all
  UI-driving sources.
- **Bridge env-var contract.** Tauri shell sets `AETHON_DOCS_DIR`,
  `AETHON_USER_DIR`, `AETHON_STATE_FILE`, `AETHON_SESSIONS_DIR`,
  `AETHON_RELEASE_MODE`, and `AETHON_PROJECT_ROOT` (dev only) when
  spawning the agent. System prompt branches on these so release
  builds don't tell the model to read source files that aren't there.
- **Multi-tab sessions.** Per-tab pi `AgentSession` records sharing one
  `auth/registry/resourceLoader`. Each tab owns its own message history,
  draft, canvas, queue counter, terminal buffer, and model. `Cmd+T` new
  tab, `Cmd+] / Cmd+[` next/prev, `Cmd+W` close, plus a tab strip in
  the layout. New tabs inherit the active tab's model so the picker
  stays consistent. AsyncLocalStorage carries the active turn's tabId
  through the agent's async chain so concurrent prompts don't smear
  state across tabs.
- **Per-tab terminal buffer.** Bash output routes by tabId; switching
  tabs replays the right buffer into the shared xterm panel via a new
  `aethon:terminal-replay` event.
- **Native macOS menu bar.** `tauri::menu::MenuBuilder` replaces
  Tauri's auto-default. Standard NS items (Quit, Hide, Cut, Copy,
  Minimize, …) come from `PredefinedMenuItem` for free native
  behavior; app-specific items emit a `menu` Tauri event that converges
  with the existing keyboard shortcuts. Aethon / File / Edit / View /
  Tabs / Window submenus.
- **System tray icon.** Status-bar entry on macOS shows Aethon's brand
  mark in full color; left-click focuses the main window (re-surfacing
  Cmd+H'd apps); menu offers Show / New Tab / Quit.
- **Skill manifest discovery from `package.json#aethon`.** Bridge walks
  `~/.aethon/extensions/node_modules/*` (and `@scope/*`) on boot and
  loads every package whose `package.json` declares an `aethon.entry`.
  Lets users `npm install --prefix ~/.aethon/extensions <pkg>` to install
  third-party skills (see `examples/skill-package/`).
- **Extension hot-reload.** Bridge file watcher runs in dev AND
  release; watches `~/.aethon/extensions/`,
  `~/.aethon/extensions/node_modules/`, `~/.pi/agent/extensions/`, and
  `<project>/agent/` (dev only). Trailing-edge debounce via a single
  worker thread (mpsc channel, `recv_timeout`) collapses npm-install
  bursts into one settle-then-fire kill. `~/.aethon/extensions` is
  pre-created on boot so first-install Create events fire.
- **Auto-updater wiring.** `tauri-plugin-updater` registered (gated on
  a non-empty `pubkey` so unconfigured builds boot safely),
  `updater_available()` Tauri command, "Check for Updates…" menu item,
  download-with-progress UI, and a `RELEASING.md` walkthrough for
  generating signing keys + GitHub Actions secrets. Activation
  requires the user to generate a keypair and paste the public key
  into `tauri.conf.json`.

### Fixed

- **Release `.app` no longer crashes on `npm root -g`.** macOS GUI apps
  inherit launchd's minimal PATH which doesn't include
  `~/.npm-global/bin`. Source the user's login shell once via
  `<shell> -ilc env` (POSIX, so it works for fish too) and inject the
  recovered PATH into the sidecar's environment.
- **Terminal panel no longer closes when you type into it.** Disabled
  xterm's stdin and onData wiring by default — there's no PTY backend,
  so accepting keystrokes only confused users into thinking the panel
  was broken.
- **Slash commands no longer leave their text "stuck" in the input.**
  The slash-command path now clears via `updateActiveTab` so the next
  mirror doesn't write the stale draft back into root.
- **Agent in release mode no longer tries to edit Aethon source.**
  `AETHON_RELEASE_MODE=1` flips a system-prompt branch instructing the
  model to use `$AETHON_USER_DIR/extensions/` (or skill packages)
  rather than touching source files that aren't shipped with the
  bundle.
- **Agent now knows what extensions are loaded.** Static system prompt
  - per-session runtime snapshot + on-disk state file + introspection
    API combine so "list loaded extensions" / "what themes are
    registered?" answers correctly on the first turn instead of
    filesystem-scraping or hallucinating.

### Changed

- **Tray icon shows the full-color brand mark** instead of a
  monochrome template (the template treatment was stripping the orange
  and losing the identity).
- **Terminal panel header** simplified to "Aethon Terminal" (was
  "Terminal" + "xterm.js · WebGL" badge).
- **`SPEC.md` checklist** reconciled with what's actually shipped.

[Unreleased]: https://github.com/utensils/aethon/compare/v0.3.2...HEAD
[0.3.2]: https://github.com/utensils/aethon/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/utensils/aethon/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/utensils/aethon/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/utensils/aethon/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/utensils/aethon/releases/tag/v0.1.0
