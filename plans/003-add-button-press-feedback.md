# 003 — 添加按钮按压反馈

- **Status**: TODO
- **Commit**: no-git
- **Severity**: HIGH
- **Category**: Physicality & origin
- **Estimated scope**: 1 file, ~20 lines

## Problem

`pdf-reader.css` 中的按钮只有颜色变化，没有按压反馈（scale 效果），感觉不够生动。

当前代码：
```css
/* pdf-reader.css:47-51 — current */
.pr-shell button, .pr-local button, .pr-open-local button, .pr-more > summary {
  display: inline-flex; 
  flex: none; 
  align-items: center; 
  justify-content: center; 
  gap: 6px; 
  min-height: 32px; 
  padding: 5px 8px;
  border: 0; 
  border-radius: 6px; 
  color: var(--pr-ink); 
  background: transparent; 
  font: inherit; 
  cursor: pointer;
  transition: background-color 100ms ease, color 100ms ease, transform 100ms cubic-bezier(.23, 1, .32, 1);
}
```

## Target

添加按压反馈效果：

```css
/* target */
.pr-shell button, .pr-local button, .pr-open-local button, .pr-more > summary {
  display: inline-flex; 
  flex: none; 
  align-items: center; 
  justify-content: center; 
  gap: 6px; 
  min-height: 32px; 
  padding: 5px 8px;
  border: 0; 
  border-radius: 6px; 
  color: var(--pr-ink); 
  background: transparent; 
  font: inherit; 
  cursor: pointer;
  transition: background-color 100ms ease, color 100ms ease, transform 100ms cubic-bezier(0.23, 1, 0.32, 1);
}

/* 按压反馈 */
.pr-shell button:active:not(:disabled), 
.pr-local button:active:not(:disabled), 
.pr-open-local button:active:not(:disabled), 
.pr-more > summary:active {
  transform: scale(0.97);
  background-color: var(--pr-pressed);
}

/* 键盘导航时不应用按压效果 */
[data-input-method="keyboard"] .pr-shell button:active,
[data-input-method="keyboard"] .pr-local button:active,
[data-input-method="keyboard"] .pr-open-local button:active {
  transform: none;
}

/* 减少动效模式 */
@media (prefers-reduced-motion: reduce) {
  .pr-shell button:active, 
  .pr-local button:active, 
  .pr-open-local button:active, 
  .pr-more > summary:active {
    transform: none;
  }
}
```

## Repo conventions to follow

- 使用现有的 `--pr-pressed` 变量（第 20 行已定义）
- 遵循现有的 `[data-input-method]` 模式（第 58-63 行）
- 使用相同的 `cubic-bezier(0.23, 1, 0.32, 1)` 曲线

## Steps

1. 在 `pdf-reader.css` 中为按钮添加 `:active` 状态的 `transform: scale(0.97)`
2. 添加 `[data-input-method="keyboard"]` 排除规则
3. 添加 `prefers-reduced-motion` 支持
4. 确保所有按钮类型都包含（`.pr-shell button`, `.pr-local button`, `.pr-open-local button`, `.pr-more > summary`）

## Boundaries

- 不要改变按钮的布局或尺寸
- 不要添加新的颜色变量
- 保持现有的过渡时间

## Verification

- **Mechanical**: `npm run typecheck` 通过，CSS 无语法错误
- **Feel check**: 
  - 点击按钮时应该有轻微的缩小效果（0.97）
  - 使用键盘导航时不应该有 scale 效果
  - 在 DevTools 中检查 `transform` 属性是否正确应用
- **Done when**: 按钮有按压反馈，键盘导航时无动画
