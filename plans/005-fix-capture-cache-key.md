# 005 — 修复图表截图缓存键不完整

- **Status**: TODO
- **Commit**: no-git
- **Severity**: HIGH
- **Category**: Cohesion & tokens
- **Estimated scope**: 1 file, ~15 lines

## Problem

`PdfReader.tsx` 第 430-461 行的 `getCapture` 函数中，缓存键不包含文档实例标识。如果用户在同一页面快速切换多个文档，缓存可能返回错误的截图。

当前代码：
```typescript
// PdfReader.tsx:436 — current
const key = `${figure.pageNumber}:${figure.key}:${scale}:${generation}:${crop}`;
```

## Target

在缓存键中添加文档实例标识：

```typescript
// target
const getCapture = useCallback((element: HTMLElement, figure: PdfFigure): CaptureJob | undefined => {
  if (!pdf) return undefined;
  const generation = element.querySelector<HTMLElement>('.pr-text-layer')?.dataset.renderGeneration || '0';
  const bounds = element.querySelector('canvas')?.getBoundingClientRect();
  const crop = [figure.rect.left - (bounds?.left || 0), figure.rect.top - (bounds?.top || 0), figure.rect.width, figure.rect.height]
    .map(value => Math.round(value * 10) / 10).join(':');
  // 添加文档实例标识，防止跨文档缓存冲突
  const docId = instance; // 使用 PdfReader 组件的 instance 值
  const key = `${docId}:${figure.pageNumber}:${figure.key}:${scale}:${generation}:${crop}`;
  // ... rest of the function
}, [pdf, scale, instance]);
```

## Repo conventions to follow

- 使用现有的 `instance` 变量（第 387 行已定义）
- 保持现有的缓存清理逻辑

## Steps

1. 修改 `PdfReader.tsx` 第 436 行，在 `key` 中添加 `instance`
2. 更新 `getCapture` 的依赖数组，添加 `instance`
3. 确保 `instance` 在组件作用域内可用

## Boundaries

- 不要改变缓存清理逻辑
- 不要添加新的缓存机制
- 保持现有的缓存大小限制

## Verification

- **Mechanical**: `npm run typecheck` 通过
- **Feel check**: 
  - 快速切换多个文档，确认每个文档的图表截图正确
  - 在 DevTools Application 面板中检查缓存键是否包含文档标识
- **Done when**: 快速切换文档时，图表截图不再混淆
