# 008 — 添加成功操作视觉确认

- **Status**: TODO
- **Commit**: no-git
- **Severity**: MEDIUM
- **Category**: Missed opportunities
- **Estimated scope**: 2 files, ~35 lines

## Problem

成功操作只有文本消息在工具栏显示 2 秒，不够明显。优秀插件使用更明显的成功动画，如打勾图标 + 绿色闪光。

当前代码：
```tsx
// client.tsx:74-84 — current
const compact: Record<string, string> = {
  '图表截图和解释请求已插入草稿，请检查后发送。': '已加入草稿',
  '已插入当前会话草稿，请检查后发送。': '已加入草稿',
  // ...
}
setStatusMessage(compact[message] || message)
if (transient) statusTimer.current = setTimeout(() => { statusTimer.current = undefined; setStatusMessage('') }, 2000)
```

## Target

添加更明显的成功反馈动画：

```tsx
// target — client.tsx
{statusMessage && (
  <span className="pr-toolbar-status pr-status-success" data-kind="message" role="status">
    <ReaderIcon name="check" className="pr-status-icon" />
    <span>{statusMessage}</span>
  </span>
)}
```

```css
/* pdf-reader.css — 添加成功动画 */
.pr-status-success {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--pr-accent);
  animation: success-flash 300ms cubic-bezier(0.23, 1, 0.32, 1);
}

.pr-status-icon {
  width: 14px;
  height: 14px;
  animation: check-pop 300ms cubic-bezier(0.23, 1, 0.32, 1);
}

@keyframes success-flash {
  0% {
    background-color: color-mix(in srgb, var(--pr-accent) 20%, transparent);
  }
  100% {
    background-color: transparent;
  }
}

@keyframes check-pop {
  0% {
    transform: scale(0);
    opacity: 0;
  }
  50% {
    transform: scale(1.2);
  }
  100% {
    transform: scale(1);
    opacity: 1;
  }
}

/* 减少动效模式 */
@media (prefers-reduced-motion: reduce) {
  .pr-status-success,
  .pr-status-icon {
    animation: none;
  }
}
```

## Repo conventions to follow

- 使用现有的 `ReaderIcon` 组件（第 8 行已导入）
- 使用现有的 `--pr-accent` 变量
- 遵循现有的 `prefers-reduced-motion` 模式

## Steps

1. 修改 `client.tsx`，在成功消息中添加打勾图标
2. 在 `pdf-reader.css` 中添加 `.pr-status-success` 样式
3. 添加 `success-flash` 和 `check-pop` 动画
4. 添加 `prefers-reduced-motion` 支持

## Boundaries

- 不要改变消息的内容或逻辑
- 不要添加新的图标
- 保持现有的 2 秒显示时间

## Verification

- **Mechanical**: `npm run typecheck` 通过
- **Feel check**: 
  - 成功操作应该显示打勾图标，有脉冲动画
  - 应该有短暂的背景色闪光
  - 减少动效模式下应该显示静态打勾图标
- **Done when**: 成功操作有明显的视觉确认动画
