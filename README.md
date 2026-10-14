# 界面缩放 UI Zoom · 让 TauriTavern 像浏览器一样放大缩小

> **起因**：我原本一直用 SillyTavern（st 酒馆），后来换到 TauriTavern（tt 酒馆），
> 结果发现 tt 酒馆**没法像 st 酒馆那样缩放整个界面**——st 酒馆里 `Ctrl + 滚轮` 就能把界面放大，
> tt 酒馆里按了半天毫无反应，字又小，看得非常吃力。
> 于是我把这件事交给了**小鲸娘（DeepSeek v4.1f）**，让它写一个能给 tt 酒馆做整体缩放的插件。
> 现在 tt 酒馆也能像浏览器一样 `Ctrl + 滚轮` / `Ctrl + 加号减号` 放大缩小了，分享给有同样困扰的人。

适用于 **TauriTavern 2.3.0**（本插件在 `2.3.0 'dev' (1f42947913a6)` 上实测通过），纯前端扩展，无依赖、不联网。

---

## 它做了什么

tt 酒馆用的是 Tauri + WebView2。Tauri 出于安全考虑**默认关闭了 WebView2 自带的缩放**
（wry 里 `SetIsZoomControlEnabled(zoom_hotkeys_enabled)` 拿到的永远是 `false`），
所以 `Ctrl + 滚轮`、`Ctrl + 加号 / 减号 / 0` 全部失效——这就是"不能缩放"的根本原因。

这个扩展绕开被关掉的原生缩放，在页面里重新实现了一套浏览器语义的缩放：

- **整个界面一起缩放**：聊天区、输入框、顶栏、左右侧栏、设置面板、弹窗、浮层，比例一致；
- 快捷键与档位**与 Chrome 相同**（25% ~ 500%）；
- 放大后 `position: fixed` 的工具栏仍然贴紧窗口边缘，弹窗仍然完整落在窗口里；
- 比例**自动记住**，下次打开还是上次的大小；
- 在扩展面板里多给了两个兼容开关（见下文），一般不用动。

---

## 安装

### 1. 找到数据目录

tt 酒馆里打开 **用户设置 → TauriTavern 设置 → 数据目录**，例如本机是 `E:\AI\TauriTavern`。

### 2. 放到扩展目录

把本仓库整个文件夹放到 `<数据目录>\extensions\third-party\` 下，目录名用 `ui-zoom`：

```
E:\AI\TauriTavern\extensions\third-party\ui-zoom\
    manifest.json
    index.js
    style.css
    README.md
```

（`third-party` 下的**每个子文件夹**都会被 tt 酒馆当成一个第三方扩展自动加载，不需要在界面里"安装"。）

### 3. 完全重启 tt 酒馆

点窗口右上角的关闭按钮可能只是**最小化到托盘**，请从**托盘图标右键 → 退出**再重新打开。
启动后打开 **扩展（Extensions）面板**，能看到「界面缩放 UI Zoom」的折叠项即为加载成功。

### 更新

用新文件覆盖 `index.js`（必要时还有 `style.css`、`manifest.json`），然后完全重启即可。

---

## 使用

### 快捷键

| 操作 | 快捷键 |
| --- | --- |
| 放大 | `Ctrl` + 鼠标滚轮上、`Ctrl` + `+`（即 `Ctrl` + `Shift` + `=`）、小键盘 `+` |
| 缩小 | `Ctrl` + 鼠标滚轮下、`Ctrl` + `-`、小键盘 `-` |
| 恢复 100% | `Ctrl` + `0`、小键盘 `0` |
| 备用（上面的组合键被系统 / WebView 抢走时） | `Ctrl` + `Alt` + `+` / `-` / `0` |

档位与 Chrome 完全一致：
`25% · 33% · 50% · 67% · 75% · 80% · 90% · 100% · 110% · 125% · 150% · 175% · 200% · 250% · 300% · 400% · 500%`

### 扩展面板

**扩展（Extensions）→ 界面缩放 UI Zoom**：

- 百分比滑块（拖动即时生效）
- `−` / `+` / `恢复 100%` 按钮
- 两个开关：**坐标修正**、**页面宽度接近 100 时侧边栏铺满**（默认都开，说明见下）

缩放过程中窗口正中会显示一个短暂的百分比气泡，不会打扰操作。

---

## 两个开关

### 坐标修正（默认开启，改动后需重启界面）

CSS 缩放会让 Chromium 把 `getBoundingClientRect()`、`clientX/Y`、`elementFromPoint()`、
`innerWidth/Height` 报成"视觉像素"，而 CSS 长度、`offsetWidth`、`getComputedStyle` 仍是未缩放的
CSS 像素。两者混用会让**右键菜单、自动补全、Quick Reply 子菜单、Moving UI 拖拽**等按鼠标坐标
定位的界面出现偏移（偏移量正好等于缩放倍数）。

开启后这些 API 会被统一换算回 CSS 像素，App 的 JS 看到的数值与 100% 缩放下完全一致。
只有极少数扩展如果故意依赖"视觉像素"行为才需要关掉它。

（对应设置：`extension_settings.tauritavernUiZoomCoordinateFix`，默认 `true`。）

### 页面宽度接近 100 时侧边栏铺满（默认开启）

角色管理 / AI 配置面板平时住在聊天区**两侧的空隙**里，宽度由 App 决定：

```
面板宽度 =（窗口宽度 − 页面宽度）/ 2        最小 100px
```

所以"页面宽度"调到 **100** 时两侧空隙为 0，面板会被 App 的最小宽度兜底压成 **100px 窄条**，
文字逐字换行（"创作者的注释"竖着排）。这是 App 自身在页面宽度 100 下的表现，
**100% 缩放下也一样**，并不是缩放造成的。

打开这个开关后，只在"页面宽度 ≥ 80"这种极端情况下，把这两个面板变成**顶栏下方的整屏浮层**
（也就是 App 自己在窄窗口下的做法）；页面宽度正常时完全不做干预。
不想用它也可以：把页面宽度调小（例如 50），或直接拖面板顶部的小握把拖宽。

（对应设置：`extension_settings.tauritavernUiZoomPanelGuard`，默认 `true`。）

---

## 与真实浏览器缩放的差异

只有一条：**CSS 媒体查询（`@media (max-width: …)`）看不到 CSS `zoom`**，
所以断点驱动的布局不会随缩放切换（例如放大到 175% 不会因为"等效宽度变小"而自动变成手机布局）。
布局本身始终完整可用，其余（长度、坐标、固定定位、弹窗、拖拽）都已对齐浏览器语义。

另外，为了让"整体缩放"真的成立，以下几类 App 自身的写法都被专门处理过，不然会出现界面错位：

- 样式表里的视口单位（`vh / dvh / svh / lvh / vw / dvw / svw / lvw / vmin / vmax`）→ 运行时改写成 `calc(长度 / var(--tt-ui-zoom))`，否则 `height: 100vh` 的容器会溢出到窗口外；
- **内联**视口单位（`--sheldWidth: 50vw`、自动补全的 `--bottomOffset` 等，由 App 的 JS / jQuery 写入）→ 同样换算，否则角色列表面板会跑偏；
- 弹窗 → 长面板会被约束在窗口内并可滚动，保证底部「保存 / 关闭」永远够得到；
- 第三方扩展自己写的全屏浮层 → 直接写 `style.width = '100vw'` 的也会被换算，
  例如 **SPreset Editor** 的提示词链编辑器以前只能看到左上角一部分，现在能完整铺满窗口。

---

## 常见问题

**Q：快捷键按下没反应？**
先用鼠标点到聊天区内（确保焦点在页面上），再试；仍不行就用 `Ctrl + Alt + 加号/减号/0`，
或直接在扩展面板里拖滑块。缩放值会保存，重启后依然生效。

**Q：放大后有些界面看起来"没跟着变大"？**
请确认扩展确实加载了（扩展面板里能看到它）。如果只是某一个第三方扩展的界面不对，
把该扩展的名字和现象反馈出来，一般都能像 SPreset Editor 那样专门适配。

**Q：能像浏览器那样只缩放一部分吗？**
不能，也不打算支持——这个插件的目标就是"整个界面一起缩放"。

**Q：会修改我的聊天 / 角色数据吗？**
不会。它只做两件事：调整界面缩放、把缩放比例写进 `settings.json` 的 `extension_settings`。

---

## 卸载

1. 删除 `<数据目录>\extensions\third-party\ui-zoom` 整个目录；
2. 完全重启 tt 酒馆；
3. （可选）删掉 `settings.json → extension_settings` 里的 `tauritavernUiZoom`、
   `tauritavernUiZoomCoordinateFix`、`tauritavernUiZoomPanelGuard` 三个键。

临时关闭则把 `"third-party/ui-zoom"` 加进 `settings.json` 的 `extension_settings.disabledExtensions`。

---

## 实现原理（给好奇的人）

1. 用 CSS `zoom` 作用在 `<html>` 上做整体缩放（Chromium 会连布局一起缩放，`position: fixed` 也能正确贴边）。
2. CSS `zoom` 不会缩放"视口"本身，所以所有视口单位都要按 `/ var(--tt-ui-zoom)` 换算；
   样式表规则靠注入最后一张覆盖表（含 `@media` / `@supports` 递归展开），
   内联样式则同时覆盖三条写入路径：`setProperty()`、直接属性赋值（`el.style.width = '100vw'`）、
   以及 `cssText` / `setAttribute` / jQuery `.css()`（用 DOM 变更监听补齐）。
3. 坐标修正：挂钩 `Element.prototype.getBoundingClientRect`、`Range` 系列、鼠标 / 触摸事件坐标、
   `elementFromPoint`、`visualViewport`、`documentElement` 的 `client* / scroll*`，
   统一在"视觉像素 ↔ CSS 像素"之间换算。
4. 缩放比例写入 `localStorage.tauritavern.uiZoom`，并通过 SillyTavern 官方上下文 API
   同步到 `settings.json`。

---

## 更新记录

- **1.1.0**
  - 修复内联视口单位未换算导致"页面宽度 / 角色列表面板错位"的问题（拦截 `setProperty` 与直接属性赋值）；
  - 修复第三方扩展（如 SPreset Editor）自己写的全屏浮层只能显示一部分的问题（新增 DOM 变更监听）；
  - 新增"页面宽度接近 100 时侧边栏铺满"开关；弹窗安全约束（内容可滚动、按钮常驻可见）。

- **1.0.0** 首个版本：整体缩放、浏览器同款快捷键与档位、比例持久化、坐标修正。

---

## 许可

MIT License，见 [LICENSE](LICENSE)。随便用、随便改；能帮到你最好，用出问题欢迎提 Issue。

代码由 **小鲸娘（DeepSeek v4.1f）** 编写，需求、测试与反馈来自 [LLPNB-NEW](https://github.com/LLPNB-NEW)。
