# 006 — 添加页面过渡动画

- **Status**: TODO
- **Commit**: no-git
- **Severity**: MEDIUM
- **Category**: Missed opportunities
- **Estimated scope**: 2 files, ~30 lines

## Problem

页面切换时没有过渡动画，感觉生硬。优秀插件（如 PDF.js Viewer）在页面切换时有平滑的滚动或淡化效果。

当前代码：
```typescript
// PdfReader.tsx:605-614 — current
const goToPage = useCallback((requested: number) => {
  if (!pdf || !scrollRoot) return;
  const number = Math.max(1, Math.min(pdf.numPages, Math.round(requested) || 1));
  const target = scrollRoot.querySelector<HTMLElement>(`[data-pdf-page="${number}"]`);
  if (target) scrollRoot.scrollTo({ top: scrollRoot.scrollTop + target.getBoundingClientRect().top - scrollRoot.getBoundingClientRect().top - 16, behavior: "auto" });
  updateView({ page: number });
  setPageNumber(number);
  setPageInput(String(number));
  setMenu(null);
}, [pdf, scrollRoot, updateView]);
```

## Target

添加平滑的页面过渡：

```typescript
// target
const goToPage = useCallback((requested: number) => {
  if (!pdf || !scrollRoot) return;
  const number = Math.max(1, Math.min(pdf.numPages, Math.round(requested) || 1));
  const target = scrollRoot.querySelector<HTMLElement>(`[data-pdf-page="${number}"]`);
  if (target) {
    // 使用平滑滚动
    scrollRoot.scrollTo({ 
      top: scrollRoot.scrollTop + target.getBoundingClientRect().top - scrollRoot.getBoundingClientRect().top - 16, 
      behavior: "smooth"  // 从 "auto" 改为 "smooth"
    });
  }
  updateView({ page: number });
  setPageNumber(number);
  setPageInput(String(number));
  setMenu(null);
}, [pdf, scrollRoot, updateView]);
```

添加 CSS 过渡：

```css
/* pdf-reader.css — 添加页面过渡 */
.pr-page {
  transition: opacity 200ms cubic-bezier(0.23, 1, 0.32, 1);
}

.pr-page[data-render-status="loading"] {
  opacity: 0.6;
}

.pr-page[data-render-status="ready"] {
  opacity: 1;
}

/* 减少动效模式 */
@media (prefers-reduced-motion: reduce) {
  .pr-page {
    transition: none;
  }
}
```

## Repo conventions to follow

- 使用现有的 `cubic-bezier(0.23, 1, 0.32, 1)` 曲线
- 遵循现有的 `prefers-reduced-motion` 模式

## Steps

1. 修改 `PdfReader.tsx` 第 609 行，将 `behavior: "auto"` 改为 `behavior: "smooth"`
2. 在 `pdf-reader.css` 中为 `.pr-page` 添加过渡效果
3. 添加加载状态的透明度变化
4. 添加 `prefers-reduced-motion` 支持

## Boundaries

- 不要改变页面渲染逻辑
- 不要添加新的动画库
- 保持现有的滚动行为

## Verification

- **Mechanical**: `npm run typecheck` 通过
- **Feel check**: 
  - 页面切换时应该有平滑的滚动效果
  - 加载中的页面应该有轻微的透明度变化
  - 在 DevTools 中检查 `scroll-behavior` 属性
- **Done when**: 页面切换有平滑过渡，加载状态有视觉反馈
