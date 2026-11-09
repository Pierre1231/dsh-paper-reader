# 手动构建指南

由于沙盒限制，我无法直接运行构建。请按照以下步骤手动构建插件：

## 步骤 1: 打开 PowerShell

```powershell
cd "C:\Users\工业科学1号\Documents\deepseek-harness\default-workspace\paper-reader-plugin"
```

## 步骤 2: 运行构建

```powershell
npm run build
```

## 步骤 3: 验证构建

构建成功后，检查 `lib/client.js` 是否已更新：

```powershell
Get-Item lib/client.js | Select-Object LastWriteTime
```

## 步骤 4: 在 DSH 中测试

1. 重启 DSH 或重新加载插件
2. 打开一个 PDF 文件
3. 悬停在文字上，查看菜单是否完全不透明

## 预期结果

- ✅ 菜单背景应该是纯白色（亮色模式）或深灰色（暗色模式）
- ✅ 菜单不应该半透明
- ✅ 菜单应该有清晰的阴影
- ✅ 文字应该清晰可读

## 如果仍然半透明

如果菜单仍然半透明，请检查：

1. 浏览器是否缓存了旧的 CSS（按 Ctrl+F5 强制刷新）
2. DSH 是否加载了最新的插件构建
3. 检查 `--dsw-specific-menu` 变量是否覆盖了我们的设置

---

*最后更新：2026-11-05*
