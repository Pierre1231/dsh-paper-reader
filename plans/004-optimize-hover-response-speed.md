# 004 — 优化悬停响应速度

- **Status**: TODO
- **Commit**: no-git
- **Severity**: HIGH
- **Category**: Purpose & frequency
- **Estimated scope**: 2 files, ~40 lines

## Problem

`PdfReader.tsx` 中的悬停延迟为 180ms，对于高频操作（段落悬停）感觉过长。优秀插件（如 Apple Books）的响应时间通常在 100-150ms。

当前代码：
```typescript
// PdfReader.tsx:671-674 — current
hoverTimer = setTimeout(() => {
  const target = pending; pending = undefined; hoverTimer = undefined;
  if (ticket === hoverTicket) target?.activate(ticket);
}, 180);
```

## Target

将悬停延迟优化为 120ms，并添加即时视觉反馈：

```typescript
// target — PdfReader.tsx
const HOVER_DELAY = 120; // 从 180ms 降低到 120ms

// 在 schedule 函数中使用
hoverTimer = setTimeout(() => {
  const target = pending; pending = undefined; hoverTimer = undefined;
  if (ticket === hoverTicket) target?.activate(ticket);
}, HOVER_DELAY);
```

添加即时视觉反馈（在悬停时立即显示微妙的背景色变化）：

```css
/* pdf-reader.css — 添加即时反馈 */
.pr-text-layer span {
  transition: background-color 100ms ease;
}

.pr-text-layer span:hover {
  background-color: color-mix(in srgb, var(--pr-accent) 4%, transparent);
}
```

## Repo conventions to follow

- 使用现有的 `hoverTicket` 机制
- 遵循现有的 CSS 变量模式
- 使用相同的 `color-mix` 语法（第 19-20 行已有示例）

## Steps

1. 在 `PdfReader.tsx` 中将 `180` 改为 `120`
2. 添加 `HOVER_DELAY` 常量以提高可维护性
3. 在 `pdf-reader.css` 中为 `.pr-text-layer span` 添加悬停背景色过渡
4. 确保减少动效模式下禁用此效果

## Boundaries

- 不要改变悬停检测的逻辑
- 不要添加新的依赖
- 保持现有的高亮机制

## Verification

- **Mechanical**: `npm run typecheck` 通过
- **Feel check**: 
  - 悬停响应应该更快（120ms vs 180ms）
  - 应该有微妙的即时背景色反馈
  - 在 DevTools Network 面板中模拟慢速网络，确认延迟仍然合理
- **Done when**: 悬停响应更快，有即时视觉反馈
