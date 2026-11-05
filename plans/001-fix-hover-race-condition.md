# 001 — 修复悬停菜单竞态条件

- **Status**: TODO
- **Commit**: no-git
- **Severity**: HIGH
- **Category**: Interruptibility
- **Estimated scope**: 1 file, ~20 lines

## Problem

`PdfReader.tsx` 第 663-675 行的 `schedule` 函数存在竞态条件。当用户快速在同一 key 的不同位置间移动鼠标时，计时器不会重置，导致菜单在错误的位置触发。

当前代码：
```typescript
// PdfReader.tsx:663-675 — current
const schedule = (key: string, mode: 'hover' | 'figure', activate: (ticket: number) => void) => {
  const current = menuRef.current;
  if (current?.mode === mode && current.key === key) { clearHoverTimer(); clearCloseTimer(); return; }
  if (pending?.key === key && pending.mode === mode) { pending.activate = activate; return; }
  clearHoverTimer(); clearCloseTimer();
  if (current?.mode !== 'selection') setMenu(null);
  pending = { key, mode, activate };
  const ticket = hoverTicket;
  hoverTimer = setTimeout(() => {
    const target = pending; pending = undefined; hoverTimer = undefined;
    if (ticket === hoverTicket) target?.activate(ticket);
  }, 180);
};
```

## Target

修复竞态条件，确保位置变化时重置计时器：

```typescript
// target
const schedule = (key: string, mode: 'hover' | 'figure', activate: (ticket: number) => void, position?: { x: number; y: number }) => {
  const current = menuRef.current;
  if (current?.mode === mode && current.key === key) { clearHoverTimer(); clearCloseTimer(); return; }
  
  // 如果同一个 key 但位置变化超过阈值，重置计时器
  if (pending?.key === key && pending.mode === mode) {
    const lastPos = pending.position;
    if (lastPos && position && 
        Math.abs(lastPos.x - position.x) < 5 && 
        Math.abs(lastPos.y - position.y) < 5) {
      pending.activate = activate;
      return;
    }
    // 位置变化明显，重置计时器
    clearHoverTimer();
    pending = { key, mode, activate, position };
    const ticket = hoverTicket;
    hoverTimer = setTimeout(() => {
      const target = pending; pending = undefined; hoverTimer = undefined;
      if (ticket === hoverTicket) target?.activate(ticket);
    }, 180);
    return;
  }
  
  clearHoverTimer(); clearCloseTimer();
  if (current?.mode !== 'selection') setMenu(null);
  pending = { key, mode, activate, position };
  const ticket = hoverTicket;
  hoverTimer = setTimeout(() => {
    const target = pending; pending = undefined; hoverTimer = undefined;
    if (ticket === hoverTicket) target?.activate(ticket);
  }, 180);
};
```

## Repo conventions to follow

- 使用现有的 `hoverTicket` 机制来防止竞态条件
- 保持现有的 `clearHoverTimer` 和 `clearCloseTimer` 模式

## Steps

1. 修改 `PdfReader.tsx` 第 663-675 行的 `schedule` 函数
2. 在 `pending` 对象中添加 `position` 字段
3. 在调用 `schedule` 时传入当前鼠标位置（从 `event.clientX` 和 `event.clientY` 获取）
4. 添加位置变化检测逻辑（阈值：5px）

## Boundaries

- 不要修改其他悬停相关逻辑
- 不要改变 180ms 的延迟时间
- 不要添加新的依赖

## Verification

- **Mechanical**: `npm run typecheck` 通过
- **Feel check**: 
  - 快速在同一段落的不同行间移动鼠标，菜单应该在停止移动的位置触发
  - 在 DevTools 中设置断点，验证位置变化时计时器被重置
- **Done when**: 快速移动鼠标时菜单不再在错误位置触发
