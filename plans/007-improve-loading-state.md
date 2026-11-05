# 007 — 优化加载状态

- **Status**: TODO
- **Commit**: no-git
- **Severity**: MEDIUM
- **Category**: Missed opportunities
- **Estimated scope**: 2 files, ~40 lines

## Problem

加载状态只有简单的文本提示 "正在加载第 X 页…"，不够精致。优秀插件（如 Zotero）使用骨架屏或更精致的加载指示器。

当前代码：
```tsx
// PdfReader.tsx:249 — current
{(status === "waiting" || status === "loading") && <span className="pr-page-status">正在加载第 {number} 页…</span>}
```

## Target

添加骨架屏效果：

```tsx
// target
{(status === "waiting" || status === "loading") && (
  <>
    <div className="pr-page-skeleton" aria-hidden="true">
      <div className="pr-skeleton-line" style={{ width: '80%' }} />
      <div className="pr-skeleton-line" style={{ width: '95%' }} />
      <div className="pr-skeleton-line" style={{ width: '70%' }} />
      <div className="pr-skeleton-line" style={{ width: '85%' }} />
      <div className="pr-skeleton-line" style={{ width: '60%' }} />
    </div>
    <span className="pr-page-status">正在加载第 {number} 页…</span>
  </>
)}
```

```css
/* pdf-reader.css — 添加骨架屏 */
.pr-page-skeleton {
  position: absolute;
  inset: 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 20px;
}

.pr-skeleton-line {
  height: 12px;
  background: linear-gradient(90deg, 
    color-mix(in srgb, var(--pr-muted) 10%, transparent) 25%, 
    color-mix(in srgb, var(--pr-muted) 20%, transparent) 50%, 
    color-mix(in srgb, var(--pr-muted) 10%, transparent) 75%
  );
  background-size: 200% 100%;
  animation: skeleton-pulse 1.5s ease-in-out infinite;
  border-radius: 4px;
}

@keyframes skeleton-pulse {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

/* 减少动效模式 */
@media (prefers-reduced-motion: reduce) {
  .pr-skeleton-line {
    animation: none;
    background: color-mix(in srgb, var(--pr-muted) 15%, transparent);
  }
}
```

## Repo conventions to follow

- 使用现有的 CSS 变量（`--pr-muted`）
- 遵循现有的 `prefers-reduced-motion` 模式
- 使用 `color-mix` 语法（第 19-20 行已有示例）

## Steps

1. 修改 `PdfReader.tsx` 第 249 行，添加骨架屏元素
2. 在 `pdf-reader.css` 中添加 `.pr-page-skeleton` 和 `.pr-skeleton-line` 样式
3. 添加 `skeleton-pulse` 动画
4. 添加 `prefers-reduced-motion` 支持

## Boundaries

- 不要改变页面渲染逻辑
- 不要添加新的依赖
- 保持现有的加载文本提示

## Verification

- **Mechanical**: `npm run typecheck` 通过
- **Feel check**: 
  - 加载时应该显示骨架屏，有脉冲动画
  - 减少动效模式下应该显示静态骨架
  - 在 DevTools 中检查动画是否正确应用
- **Done when**: 加载状态有骨架屏效果，减少动效模式下有静态骨架
