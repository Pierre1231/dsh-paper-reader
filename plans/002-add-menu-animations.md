# 002 — 添加菜单进入/退出动画

- **Status**: TODO
- **Commit**: no-git
- **Severity**: HIGH
- **Category**: Physicality & origin
- **Estimated scope**: 1 file, ~30 lines

## Problem

`pdf-reader.css` 中的 `.pr-selection-menu` 和 `.pr-toolbar-menu` 没有进入/退出动画，导致菜单突然出现/消失，感觉生硬。

当前代码：
```css
/* pdf-reader.css:118 — current */
.pr-selection-menu { 
  position: fixed; 
  z-index: 1000; 
  display: flex; 
  width: max-content; 
  flex-wrap: wrap; 
  gap: 2px; 
  max-width: calc(100vw - 16px); 
  padding: 4px; 
  border: 1px solid var(--pr-border); 
  border-radius: 8px; 
  color: var(--pr-ink); 
  background: var(--pr-menu); 
  box-shadow: 0 4px 16px rgb(0 0 0 / 12%); 
}
```

## Target

添加平滑的进入/退出动画：

```css
/* target */
.pr-selection-menu { 
  position: fixed; 
  z-index: 1000; 
  display: flex; 
  width: max-content; 
  flex-wrap: wrap; 
  gap: 2px; 
  max-width: calc(100vw - 16px); 
  padding: 4px; 
  border: 1px solid var(--pr-border); 
  border-radius: 8px; 
  color: var(--pr-ink); 
  background: var(--pr-menu); 
  box-shadow: 0 4px 16px rgb(0 0 0 / 12%);
  animation: menu-enter 150ms cubic-bezier(0.23, 1, 0.32, 1);
  transform-origin: top center;
}

@keyframes menu-enter {
  from {
    opacity: 0;
    transform: scale(0.95) translateY(-4px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

/* 退出动画 - 使用 @starting-style 或 data-attribute */
.pr-selection-menu[data-closing] {
  animation: menu-exit 100ms cubic-bezier(0.23, 1, 0.32, 1) forwards;
}

@keyframes menu-exit {
  from {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
  to {
    opacity: 0;
    transform: scale(0.95) translateY(-4px);
  }
}

/* 减少动效模式 */
@media (prefers-reduced-motion: reduce) {
  .pr-selection-menu {
    animation: none;
  }
  .pr-selection-menu[data-closing] {
    animation: none;
    opacity: 0;
  }
}
```

同样应用于 `.pr-toolbar-menu`。

## Repo conventions to follow

- 使用现有的 CSS 变量（`--pr-border`, `--pr-ink`, `--pr-menu`）
- 遵循现有的 `@media (prefers-reduced-motion: reduce)` 模式（第 138-142 行）

## Steps

1. 在 `pdf-reader.css` 中添加 `@keyframes menu-enter` 和 `@keyframes menu-exit`
2. 为 `.pr-selection-menu` 添加 `animation` 和 `transform-origin` 属性
3. 为 `.pr-toolbar-menu` 添加相同的动画
4. 添加 `[data-closing]` 状态的退出动画
5. 在 `PdfReader.tsx` 中添加关闭菜单时设置 `data-closing` 的逻辑
6. 添加 `prefers-reduced-motion` 支持

## Boundaries

- 不要改变菜单的结构或布局
- 不要添加新的 CSS 变量
- 保持现有的阴影和边框样式

## Verification

- **Mechanical**: `npm run typecheck` 通过，CSS 无语法错误
- **Feel check**: 
  - 菜单应该平滑地从触发点弹出，带 scale 和 fade 效果
  - 关闭时应该快速淡出
  - 在 DevTools Animations 面板中设置 10% 速度，确认动画从 scale(0.95) 开始
  - 开启 `prefers-reduced-motion`，确认动画被禁用
- **Done when**: 菜单有平滑的进入/退出动画，且在减少动效模式下无动画
